import AVFoundation
import UIKit
import UniformTypeIdentifiers

/// The JS-facing on-device export (plan P4, OV5): one export at a time, run by
/// PlanExporter, inside a BGContinuedProcessingTask when the phone allows it.
///
///   exportProject (foreground) ─▶ validate plan + media map ─▶ ask for add-only Photos access
///     ─┬─ .gpu supported, task registered and submitted (strategy .queue, requires .gpu)
///      │     ├─ launch handler runs ─▶ resolving ─▶ measuring ─▶ writing ─▶ saving ─▶ done
///      │     ├─ not started after 1 s ─▶ queued ("waiting to start", cancellable)
///      │     ├─ not started after 10 s while Editify is in front (checked again whenever it
///      │     │   becomes active) ─▶ request withdrawn, foreground-only
///      │     └─ expiration ─▶ cancel ─▶ failed("iOS stopped the export")
///      └─ no .gpu / not permitted / submit refused ─▶ foreground-only: runs now with the
///            notice "Keep Editify open until the export finishes". Going to the background
///            stops it at once (iOS refuses Metal work from a backgrounded app) with
///            failed("Export stopped: Editify went to the background. ..."); the usual
///            background grace only covers the cleanup. Auto-lock is off while it runs
///            (it would background the app), restored on every terminal state.
///
/// Why .gpu: EditifyCompositor renders with Core Image on Metal, and iOS refuses GPU work
/// from a backgrounded app unless the continued-processing task asked for the GPU
/// resource, which needs the `com.apple.developer.background-tasks.continued-processing.gpu`
/// entitlement and a device that reports `.gpu` in `BGTaskScheduler.supportedResources`.
/// No UIBackgroundModes entry is needed for continued-processing tasks; the identifier
/// must match BGTaskSchedulerPermittedIdentifiers (`<bundle id>.export.*`, app.json).
///
/// BACKGROUND GPU ACCESS IS NOT ENABLED YET. The entitlement is a profile-gated App ID
/// capability (BACKGROUND_GPU_ACCESS) that EAS does not sync, so shipping the key in
/// app.json would fail signing on every preview and production build. Without it a submit
/// that asks for .gpu is rejected and every export runs in the foreground, which is the
/// path that works today. To turn background exports on:
///   1. In the Apple Developer portal, enable "Background GPU Access" on the App ID
///      com.editify.app (AK8836263L, team F9R8TK7W79).
///   2. Regenerate the ad hoc and App Store provisioning profiles (eas credentials, or the
///      portal), so both carry the capability.
///   3. Add `"entitlements": {"com.apple.developer.background-tasks.continued-processing.gpu": true}`
///      under expo.ios in apps/mobile/app.json.
///   4. Prove it with a manual `eas build --profile preview` before merging, since a main
///      merge starts a preview build; then check a background export on a phone that
///      reports .gpu.
///
/// Ports: the background task goes through BackgroundExecution, the render through
/// VideoExport, the save through PhotoLibrary, media through MediaSource (EngineAdapters).
///
/// Events (`exportState`): {id, state, progress, error?, reason?, notice?, mode?, fileUri?,
/// savedToPhotos?, stats?}. `reason: "backgrounded"` marks the failure above and
/// `reason: "expired"` a background run iOS stopped (JS offers "Finish on server" on both). `progress` is the current state's own 0...1 (writing:
/// presented video time / duration). Sent on every state change and otherwise at most
/// every 1% of progress and 10 times a second. Temp files are removed on cancel and
/// failure; a finished file stays for the share sheet until the next export starts or
/// the next launch's sweep.
final class ExportCenter: @unchecked Sendable {
  static let shared = ExportCenter()
  private let adapters: EngineAdapters

  init(adapters: EngineAdapters = .current) {
    self.adapters = adapters
  }

  static let filePrefix = TempFiles.exportPrefix
  typealias Emit = @Sendable ([String: Any]) -> Void

  static let backgroundedMessage = "Export stopped: Editify went to the background. Keep it open while exporting."
  static let expiredMessage = "iOS stopped the export"
  /// How long a queued background request may wait while Editify is in front.
  static let queueFallbackSeconds = 10.0

  enum Destination: String { case photos, file }

  struct Request {
    let plan: RenderPlan
    /// Asset id → a ref resolveMedia returned on this phone (PHAsset id or file:// URI).
    let media: [String: String]
    let options: PlanExportOptions
    let destination: Destination
  }

  struct Rejected: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  private final class Job: @unchecked Sendable {
    let id: String
    let request: Request
    let emit: Emit
    let control = PlanExportControl()
    let lock = NSLock()
    var started = false
    var finished = false
    /// Why the run was stopped from outside (expiry, the app went to the background).
    var stopReason: String?
    var task: (any BackgroundTask)?
    var taskIdentifier: String?
    var mode = "foreground"
    var notice: String?
    var queuedAt: Date?
    var backgroundGrace: UIBackgroundTaskIdentifier = .invalid
    /// Screen auto-lock off while a foreground export runs (main thread only).
    var awake: ScopedOverride<Bool>?
    var observers: [NSObjectProtocol] = []
    /// Throttle state for `send`.
    var lastState: String?
    var lastProgress = -1.0
    var lastSent = Date.distantPast

    init(id: String, request: Request, emit: @escaping Emit) {
      self.id = id
      self.request = request
      self.emit = emit
    }

    /// True once: the caller won the right to start the run.
    func claimStart() -> Bool { lock.withLock { if started { return false }; started = true; return true } }
    var isStarted: Bool { lock.withLock { started } }
    var isFinished: Bool { lock.withLock { finished } }

    func stop(_ reason: String) {
      lock.withLock { if stopReason == nil { stopReason = reason } }
      control.cancel()
    }
  }

  private let lock = NSLock()
  private var current: Job?
  private var registered = Set<String>()

  // MARK: Boundary

  /// What JS can know before it asks: background GPU support on this phone.
  static func capabilities() -> [String: Any] {
    ["backgroundGPU": EngineAdapters.current.backgroundExecution.supportsBackgroundGPU]
  }

  /// Validates everything JS sent, then starts. Throws (rejecting the JS promise) for bad
  /// input or while another export runs; every later problem arrives as a `failed` event.
  func start(planJson: String, options: [String: Any], emit: @escaping Emit) async throws -> String {
    let data = Data(planJson.utf8)
    let plan: RenderPlan
    do { plan = try RenderPlan.decode(data) } catch { throw Rejected(message: error.localizedDescription) }
    guard plan.duration > 0, plan.frameCount > 0 else { throw Rejected(message: PlanExportError.emptyPlan.localizedDescription) }

    guard let rawMedia = options["media"] as? [String: Any], rawMedia.count <= PlanLimits.audio + PlanLimits.overlays + PlanLimits.segments else {
      throw Rejected(message: "exportProject needs options.media: {assetId: ref}")
    }
    var media: [String: String] = [:]
    for (id, value) in rawMedia {
      guard let ref = value as? String, !id.isEmpty, id.count <= PlanLimits.idChars, !ref.isEmpty, ref.count <= 2048 else {
        throw Rejected(message: "options.media has an invalid entry")
      }
      if ref.hasPrefix("file://") { guard Self.containedFileURL(ref) != nil else { throw Rejected(message: "options.media has a file outside the app") } }
      media[id] = ref
    }
    let missing = Self.assetIds(plan).subtracting(media.keys)
    guard missing.isEmpty else { throw Rejected(message: "No local media for \(missing.count) asset(s)") }

    var exportOptions = PlanExportOptions()
    if let bitrate = options["videoBitrate"] {
      // Range-checked as a Double first: Int(1e19) would trap.
      guard let value = (bitrate as? NSNumber)?.doubleValue, value.isFinite,
            value >= Double(PlanExportOptions.bitrateRange.lowerBound), value <= Double(PlanExportOptions.bitrateRange.upperBound) else {
        throw Rejected(message: "videoBitrate must be 0.5 to 200 Mbit/s")
      }
      exportOptions.videoBitrate = Int(value)
    }
    if let interval = options["keyframeInterval"] {
      guard let value = (interval as? NSNumber)?.doubleValue, value.isFinite, value >= 0.1, value <= 10 else {
        throw Rejected(message: "keyframeInterval must be 0.1 to 10 seconds")
      }
      exportOptions.keyframeInterval = value
    }
    let destinationName = options["destination"] as? String ?? "photos"
    guard let destination = Destination(rawValue: destinationName) else { throw Rejected(message: "destination must be 'photos' or 'file'") }

    let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let job = Job(id: id, request: Request(plan: plan, media: media, options: exportOptions, destination: destination), emit: emit)
    try lock.withLock {
      if let current, !current.finished { throw Rejected(message: "Another export is running") }
      current = job
    }
    // The previous export's file (kept for its share sheet) and its still copies go now.
    Self.removeExportFiles()
    // Photos asks now, while the app is in front: a background task cannot show the prompt.
    if destination == .photos { await adapters.photoLibrary.requestAddAccessIfUndetermined() }
    await admit(job)
    return id
  }

  func cancel(_ id: String) {
    let job = lock.withLock { current?.id == id ? current : nil }
    guard let job else { return }
    job.control.cancel()
    // Queued and never started: withdraw the request and say so.
    if !job.isStarted, job.claimStart() {
      if let identifier = job.taskIdentifier { adapters.backgroundExecution.cancel(identifier) }
      finish(job, state: "cancelled", extra: [:])
    }
  }

  /// A JS context going away (reload): nothing is listening any more.
  func cancelAll() {
    let job = lock.withLock { current }
    if let job { cancel(job.id) }
  }

  /// Every file an export left in tmp (finished videos, still copies). Only called when no
  /// export runs.
  static func removeExportFiles() {
    let directory = FileManager.default.temporaryDirectory
    for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] where name.hasPrefix(filePrefix) {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
  }

  // MARK: Admission (OV5)

  @MainActor
  private func admit(_ job: Job) {
    let bundle = Bundle.main.bundleIdentifier ?? "com.editify.app"
    let identifier = "\(bundle).export.\(job.id)"
    let background = adapters.backgroundExecution
    guard background.supportsBackgroundGPU else {
      return runInForeground(job, notice: "Keep Editify open until the export finishes.")
    }
    // Each identifier is registered once (iOS kills an app that registers one twice); export
    // ids are unique per run, so this only guards against a repeated admit.
    let fresh = lock.withLock { registered.insert(identifier).inserted }
    let didRegister = fresh && background.register(identifier) { [weak self] task in
      guard let self else {
        task.setTaskCompleted(success: false)
        return
      }
      self.launched(job, task: task)
    }
    guard didRegister else {
      return runInForeground(job, notice: "Keep Editify open until the export finishes.")
    }
    // Set before submitting: the launch handler can run before submit returns.
    job.lock.withLock {
      job.taskIdentifier = identifier
      job.mode = "background"
      job.queuedAt = Date()
    }
    do {
      try background.submit(identifier, title: "Exporting video", subtitle: "Starting")
    } catch {
      // Includes "not permitted" while the GPU entitlement is off (see the type's comment).
      job.lock.withLock { job.taskIdentifier = nil; job.mode = "foreground"; job.queuedAt = nil }
      return runInForeground(job, notice: "Keep Editify open until the export finishes.")
    }
    // Back in front after a while away: the 10 s timer may have found the app inactive.
    job.observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.fallBackIfQueuedTooLong(job, identifier: identifier) }
    })
    // Started at once in the usual case; say "queued" only when it really waits.
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(1))
      guard let self, !job.isStarted, !job.control.isCancelled else { return }
      self.send(job, state: "queued", progress: 0)
      try? await Task.sleep(for: .seconds(Self.queueFallbackSeconds - 1))
      self.fallBackIfQueuedTooLong(job, identifier: identifier)
    }
  }

  @MainActor
  private func fallBackIfQueuedTooLong(_ job: Job, identifier: String) {
    guard !job.isStarted, !job.control.isCancelled, UIApplication.shared.applicationState == .active,
          let queuedAt = job.lock.withLock({ job.queuedAt }), Date().timeIntervalSince(queuedAt) >= Self.queueFallbackSeconds - 0.05 else { return }
    adapters.backgroundExecution.cancel(identifier)
    runInForeground(job, notice: "iOS is busy, so this export runs while Editify stays open.")
  }

  @MainActor
  private func runInForeground(_ job: Job, notice: String) {
    guard job.claimStart() else { return }
    job.lock.withLock {
      job.mode = "foreground"
      job.notice = notice
      job.taskIdentifier = nil
    }
    // Auto-lock would background the app and stop the export: keep the screen on until it ends.
    let awake = ScopedOverride(read: { UIApplication.shared.isIdleTimerDisabled }, write: { UIApplication.shared.isIdleTimerDisabled = $0 })
    awake.hold(true)
    job.awake = awake
    // Metal work is refused once the app is in the background: stop at once, with a reason.
    job.observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
      job.stop(Self.backgroundedMessage)
    })
    // The background grace only gives the cancel time to clean up.
    job.backgroundGrace = UIApplication.shared.beginBackgroundTask(withName: "editify-export") { [weak self] in
      job.stop(Self.backgroundedMessage)
      MainActor.assumeIsolated { self?.endGrace(job) }
    }
    Task.detached { [weak self] in await self?.run(job) }
  }

  /// Every terminal state comes through here (finish), cancel and failure included.
  @MainActor
  private func endGrace(_ job: Job) {
    job.awake?.release()
    job.awake = nil
    for observer in job.observers { NotificationCenter.default.removeObserver(observer) }
    job.observers = []
    if job.backgroundGrace != .invalid {
      UIApplication.shared.endBackgroundTask(job.backgroundGrace)
      job.backgroundGrace = .invalid
    }
  }

  private func launched(_ job: Job, task: any BackgroundTask) {
    guard job.claimStart() else {
      // Cancelled while queued, or already running in the foreground.
      task.setTaskCompleted(success: false)
      return
    }
    job.lock.withLock { job.task = task }
    task.setProgress(completed: 0, total: 1000)
    task.setExpirationHandler { job.stop(Self.expiredMessage) }
    Task.detached { [weak self] in await self?.run(job) }
  }

  // MARK: Run

  private func run(_ job: Job) async {
    let request = job.request
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("\(Self.filePrefix)\(job.id).mp4")
    let media = request.media
    let resolver = PlanAssetResolver(
      asset: { ref in try await Self.loadAsset(media[ref.id], id: ref.id) },
      imageFile: { ref in try await Self.imageFile(media[ref.id], id: ref.id) })
    send(job, state: "resolving", progress: 0)
    do {
      // Saving to Photos copies the file: room for one more of it.
      let stats = try await adapters.videoExport.export(request.plan, resolver: resolver, to: output, options: request.options, control: job.control,
                                                        extraCopies: request.destination == .photos ? 1 : 0,
                                                        progress: { [weak self] phase, value in self?.send(job, state: phase.rawValue, progress: value) })
      var saved = false
      if request.destination == .photos {
        if job.control.isCancelled { throw PlanExportError.cancelled }
        send(job, state: "saving", progress: 0)
        saved = await adapters.photoLibrary.saveVideo(output)
      }
      finish(job, state: "done", extra: ["fileUri": output.absoluteString, "savedToPhotos": saved, "stats": stats.dictionary])
    } catch {
      try? FileManager.default.removeItem(at: output)
      // A foreground render the GPU refused because the app just left: the same plain reason,
      // even if the error beat the didEnterBackground notification here.
      let inBackground = await MainActor.run { UIApplication.shared.applicationState == .background }
      if inBackground, job.lock.withLock({ job.task == nil }) { job.lock.withLock { if job.stopReason == nil { job.stopReason = Self.backgroundedMessage } } }
      if let reason = job.lock.withLock({ job.stopReason }) {
        var extra: [String: Any] = ["error": reason]
        // A stable code for JS, which offers "Finish on server" on it (D26) without matching the text.
        if reason == Self.backgroundedMessage { extra["reason"] = "backgrounded" }
        // iOS ended the background task (BGContinuedProcessingTask expiry): the server can finish it too.
        if reason == Self.expiredMessage { extra["reason"] = "expired" }
        finish(job, state: "failed", extra: extra)
      } else if job.control.isCancelled || (error as? PlanExportError) == .cancelled || error is CancellationError {
        finish(job, state: "cancelled", extra: [:])
      } else {
        finish(job, state: "failed", extra: ["error": Self.message(error)])
      }
    }
  }

  private static func message(_ error: Error) -> String {
    switch error {
    case let error as PlanExportError: return error.localizedDescription
    case is AssetSource.NotFound: return "A clip is no longer on this iPhone"
    case is AssetSource.InCloud, is AssetSource.Unreachable: return "A clip is in iCloud and not downloaded"
    case let error as RenderPlanError: return error.localizedDescription
    case let error as PlanBuildError: return error.localizedDescription
    default: return error.localizedDescription
    }
  }

  /// Weights for the system's progress UI: resolve 5%, measure 10%, write 82%, save 3%.
  private static func overall(_ state: String, _ progress: Double) -> Double {
    switch state {
    case "resolving": return 0.05 * progress
    case "measuring": return 0.05 + 0.10 * progress
    case "writing": return 0.15 + 0.82 * progress
    case "saving": return 0.97 + 0.03 * progress
    case "done": return 1
    default: return 0
    }
  }

  private func send(_ job: Job, state: String, progress: Double) {
    let clamped = min(1, max(0, progress))
    let now = Date()
    let (go, mode, notice, task) = job.lock.withLock { () -> (Bool, String, String?, (any BackgroundTask)?) in
      guard !job.finished, ExportThrottle.shouldSend(state: state, progress: clamped, lastState: job.lastState, lastProgress: job.lastProgress,
                                           sinceLast: now.timeIntervalSince(job.lastSent)) else { return (false, job.mode, nil, nil) }
      job.lastState = state
      job.lastProgress = clamped
      job.lastSent = now
      return (true, job.mode, job.notice, job.task)
    }
    guard go else { return }
    var body: [String: Any] = ["id": job.id, "state": state, "progress": clamped, "mode": mode]
    if let notice { body["notice"] = notice }
    job.emit(body)
    if let task {
      task.setProgress(completed: Int64(Self.overall(state, clamped) * 1000), total: 1000)
      let subtitle = switch state {
      case "resolving": "Preparing clips"
      case "measuring": "Measuring loudness"
      case "writing": "Rendering \(Int((clamped * 100).rounded()))%"
      case "saving": "Saving to Photos"
      default: ""
      }
      if !subtitle.isEmpty { task.updateTitle("Exporting video", subtitle: subtitle) }
    }
  }

  private func finish(_ job: Job, state: String, extra: [String: Any]) {
    let first = job.lock.withLock { () -> Bool in
      if job.finished { return false }
      job.finished = true
      return true
    }
    guard first else { return }
    var body: [String: Any] = ["id": job.id, "state": state, "progress": state == "done" ? 1 : 0, "mode": job.mode]
    if let notice = job.notice { body["notice"] = notice }
    for (key, value) in extra { body[key] = value }
    job.emit(body)
    if let task = job.lock.withLock({ job.task }) {
      if state == "done" { task.setProgress(completed: 1000, total: 1000) }
      task.setTaskCompleted(success: state == "done")
    }
    Task { @MainActor [weak self] in self?.endGrace(job) }
  }

  // MARK: Media

  static func assetIds(_ plan: RenderPlan) -> Set<String> {
    var ids = Set<String>()
    for segment in plan.video.segments { for layer in segment.layers { ids.insert(layer.assetRef.id) } }
    for overlay in plan.overlays { if let id = overlay.media?.assetRef.id { ids.insert(id) } }
    for entry in plan.audio { ids.insert(entry.assetRef.id) }
    return ids
  }

  /// A file:// URI inside the app's own container, standardized; nil for anything else.
  static func containedFileURL(_ ref: String) -> URL? {
    guard let url = URL(string: ref), url.isFileURL else { return nil }
    let path = url.standardizedFileURL.resolvingSymlinksInPath().path
    let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath().path
    return path.hasPrefix(home + "/") ? url.standardizedFileURL : nil
  }

  /// The plan's asset, opened with precise timing (PlanAssetResolver's contract). Only refs
  /// JS resolved for this export: never an id looked up any other way.
  static func loadAsset(_ ref: String?, id: String) async throws -> AVAsset {
    guard let ref else { throw AssetSource.NotFound(ref: id) }
    let precise = [AVURLAssetPreferPreciseDurationAndTimingKey: true]
    if ref.hasPrefix("file://") {
      guard let url = containedFileURL(ref) else { throw AssetSource.NotFound(ref: id) }
      return AVURLAsset(url: url, options: precise)
    }
    let loaded = try await EngineAdapters.current.mediaSource.load(ref, allowNetwork: false, onDownload: nil)
    // Photos hands back an AVURLAsset on a file it opened for us; reopen it with precise
    // timing, keeping Photos' asset when the reopened one can't be read.
    if let urlAsset = loaded as? AVURLAsset {
      let reopened = AVURLAsset(url: urlAsset.url, options: precise)
      if (try? await reopened.load(.isReadable)) == true { return reopened }
    }
    return loaded
  }

  /// A local file for a still or a GIF: an app copy as is, a Photos original written to a temp file
  /// named with `prefix` (the native preview passes its own, so an export's cleanup leaves it alone).
  static func imageFile(_ ref: String?, id: String, prefix: String = filePrefix) async throws -> URL {
    guard let ref else { throw AssetSource.NotFound(ref: id) }
    if ref.hasPrefix("file://") {
      guard let url = containedFileURL(ref) else { throw AssetSource.NotFound(ref: id) }
      return url
    }
    let (data, type) = try await AssetSource.originalImageData(ref)
    let ext = type.flatMap { UTType($0)?.preferredFilenameExtension } ?? "img"
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)still-\(UUID().uuidString).\(ext)")
    try data.write(to: url)
    return url
  }
}
