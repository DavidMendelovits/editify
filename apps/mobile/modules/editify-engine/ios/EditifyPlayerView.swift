import AVFoundation
import ExpoModulesCore
import UIKit

/// The native preview (plan P5, 6A): one AVPlayerLayer showing PlanPlayer's
/// item, so this view draws every pixel (video, overlays, captions) with the
/// export's renderer. React Native lays only selection boxes and handles over it.
///
/// JS drives it through the view's ref (EditifyEngineModule's View functions):
/// setPlan(planJson, media), play, pause, seek(t, exact), setMuted; `apiOrigin`
/// (a prop) is the only server remote media may come from. It reports onTime (the
/// native clock: ~30 Hz while playing, and when a seek lands), onReady, onStall
/// ({buffering}), onEnded ({reason: 'end' | 'interrupted'}), onError and onPlan (how
/// each accepted plan was applied, with its latency).
///
/// The render is the view's pixel size, capped at 1080 x 1920 (PlanPlayer.renderScale);
/// the layer aspect-fits it, with the plan's background behind.
///
/// Lifecycle: the app in the background suspends the player (no GPU work; plans and
/// seeks wait) until it returns; leaving the window (a screen pushed over the editor)
/// parks it (item dropped, caches trimmed) until the view is back; a memory warning
/// trims caches. Temp stills it wrote are deleted once no plan uses them, and at the end.
final class EditifyPlayerView: ExpoView {
  let onTime = EventDispatcher()
  let onReady = EventDispatcher()
  let onStall = EventDispatcher()
  let onEnded = EventDispatcher()
  let onError = EventDispatcher()
  let onPlan = EventDispatcher()

  /// The app's API server (scheme, host, port): the only origin remote media may come from.
  var apiOrigin: URL?

  private let playerLayer = AVPlayerLayer()
  private let core: PlanPlayer
  private let temps: PreviewTempFiles
  private var observers: [NSObjectProtocol] = []
  private var wasInWindow = false

  required init(appContext: AppContext? = nil) {
    let temps = PreviewTempFiles()
    self.temps = temps
    core = PlanPlayer(resolver: { media in PreviewMedia.resolver(media, temps: temps) })
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    playerLayer.player = core.player
    playerLayer.videoGravity = .resizeAspect
    layer.addSublayer(playerLayer)
    core.onEvent = { [weak self] event in self?.dispatch(event) }
    core.onInstalled = { media in temps.retain(only: Set(media.images.values)) }
    let center = NotificationCenter.default
    // The compositor renders on the GPU, which iOS refuses to a backgrounded app: nothing renders until it returns.
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.core.suspend() }
    })
    observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.core.resume() }
    })
    observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.core.trimCaches() }
    })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
      MainActor.assumeIsolated { if began { self?.core.interrupt() } }
    })
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    let core = self.core
    let temps = self.temps
    Task { @MainActor in
      core.teardown()
      temps.removeAll()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    playerLayer.frame = bounds
    CATransaction.commit()
    let scale = window?.screen.scale ?? traitCollection.displayScale
    core.viewPixels = CGSize(width: bounds.width * scale, height: bounds.height * scale)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      // Covered (export pushed on top) or unmounting: let go of the item and the caches.
      if wasInWindow { core.park() }
    } else {
      if wasInWindow { core.unpark() }
      wasInWindow = true
    }
  }

  // MARK: Commands (from the module's View functions, on the main thread)

  /// Validates the media map against the plan and `apiOrigin`, then hands the plan over.
  /// False when the plan is not newer than the last one this view accepted.
  func setPlan(_ plan: RenderPlan, media raw: [String: Any]) throws -> Bool {
    let media = try PreviewMedia.validate(raw, for: plan, origin: apiOrigin)
    guard core.setPlan(plan, media: media) else { return false }
    backgroundColor = UIColor(red: plan.background.red, green: plan.background.green, blue: plan.background.blue, alpha: 1)
    return true
  }

  func play() {
    // Sound with the ringer switch off, as a video editor should (unless the app already chose a playing category).
    let session = AVAudioSession.sharedInstance()
    if session.category != .playback, session.category != .playAndRecord { try? session.setCategory(.playback, mode: .moviePlayback) }
    core.play()
  }

  func pause() { core.pause() }
  func seek(_ time: Double, exact: Bool) { core.seek(to: time, exact: exact) }
  func setMuted(_ muted: Bool) { core.setMuted(muted) }
  var currentTime: Double { core.currentTime }

  private func dispatch(_ event: PlanPlayer.Event) {
    switch event {
    case .time(let time, let playing): onTime(["time": time, "playing": playing])
    case .ready(let duration): onReady(["duration": duration])
    case .buffering(let buffering): onStall(["buffering": buffering])
    case .ended(let reason): onEnded(["reason": reason])
    case .error(let message): onError(["message": message])
    case .plan(let applied): onPlan(applied.dictionary)
    }
  }
}

/// Temp stills the preview wrote (Photos originals, server copies), deleted once no plan uses them.
final class PreviewTempFiles: @unchecked Sendable {
  private let lock = NSLock()
  private var files = Set<URL>()

  func add(_ url: URL) { lock.withLock { _ = files.insert(url.standardizedFileURL) } }

  /// Deletes every file not in `keep`.
  func retain(only keep: Set<URL>) {
    let kept = Set(keep.map(\.standardizedFileURL))
    let gone = lock.withLock { () -> Set<URL> in
      let gone = files.subtracting(kept)
      files.subtract(gone)
      return gone
    }
    for url in gone { try? FileManager.default.removeItem(at: url) }
  }

  func removeAll() { retain(only: []) }
}

/// Where the preview's media comes from: the map JS built with resolveMedia (purpose
/// 'preview'), validated before a plan reaches the player. A value is a PHAsset local id,
/// a file:// URI inside the app (an app copy or a 1080p proxy), or a URL on the app's own
/// API server (the user's server copy of a clip that isn't on this iPhone): https only in
/// release builds, and only `apiOrigin`. Ids resolve only within the map, never as paths
/// (PlanAssetResolver's contract).
enum PreviewMedia {
  struct Rejected: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  /// Server stills are small (stickers): a bigger download is refused, before and while it runs.
  static let maxImageBytes: Int64 = 64 << 20
  static let downloadTimeout: TimeInterval = 20

  static func validate(_ raw: [String: Any], for plan: RenderPlan, origin: URL?) throws -> [String: String] {
    guard raw.count <= PlanLimits.audio + PlanLimits.overlays + PlanLimits.segments else { throw Rejected(message: "media map is too large") }
    var media: [String: String] = [:]
    for (id, value) in raw {
      guard let ref = value as? String, !id.isEmpty, id.count <= PlanLimits.idChars, !ref.isEmpty, ref.count <= 4096 else {
        throw Rejected(message: "media map has an invalid entry")
      }
      if ref.hasPrefix("file://") {
        guard ExportCenter.containedFileURL(ref) != nil else { throw Rejected(message: "media map has a file outside the app") }
      } else if ref.contains("://") {
        guard let url = URL(string: ref), PlanPlayer.isRemote(ref) else { throw Rejected(message: "media map has an unsupported URL") }
        #if !DEBUG
        guard url.scheme?.lowercased() == "https" else { throw Rejected(message: "remote media must use https") }
        #endif
        guard let origin, sameOrigin(url, origin) else { throw Rejected(message: "remote media must come from the app's server") }
      }
      media[id] = ref
    }
    let missing = ExportCenter.assetIds(plan).subtracting(media.keys)
    guard missing.isEmpty else { throw Rejected(message: "No preview media for \(missing.count) asset(s)") }
    return media
  }

  static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
    let port = { (url: URL) -> Int? in url.port ?? (url.scheme?.lowercased() == "https" ? 443 : url.scheme?.lowercased() == "http" ? 80 : nil) }
    return url.scheme?.lowercased() == origin.scheme?.lowercased() && url.host?.lowercased() == origin.host?.lowercased() && port(url) == port(origin)
  }

  static func resolver(_ media: [String: String], temps: PreviewTempFiles) -> PlanAssetResolver {
    PlanAssetResolver(
      asset: { ref in
        guard let value = media[ref.id] else { throw AssetSource.NotFound(ref: ref.id) }
        if PlanPlayer.isRemote(value), let url = URL(string: value) { return AVURLAsset(url: url) }
        return try await ExportCenter.loadAsset(value, id: ref.id)
      },
      imageFile: { ref in
        guard let value = media[ref.id] else { throw AssetSource.NotFound(ref: ref.id) }
        if PlanPlayer.isRemote(value), let url = URL(string: value) {
          let file = try await download(url)
          temps.add(file)
          return file
        }
        let file = try await ExportCenter.imageFile(value, id: ref.id, prefix: TempFiles.previewPrefix)
        if file.lastPathComponent.hasPrefix(TempFiles.previewPrefix) { temps.add(file) }
        return file
      })
  }

  private static func download(_ url: URL) async throws -> URL {
    let ext = url.pathExtension.isEmpty ? "img" : url.pathExtension
    let target = FileManager.default.temporaryDirectory.appendingPathComponent("\(TempFiles.previewPrefix)\(UUID().uuidString).\(ext)")
    do {
      try await CappedDownload.run(url, to: target, cap: maxImageBytes, timeout: downloadTimeout)
      return target
    } catch {
      try? FileManager.default.removeItem(at: target)
      throw error
    }
  }
}

/// One download on its own ephemeral session: refused when the server announces more than
/// `cap` bytes or sends more, and bounded by `timeout` for the whole transfer. Delegate
/// callbacks run on the session's serial queue.
private final class CappedDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let cap: Int64
  private let target: URL
  private var handle: FileHandle?
  private var written: Int64 = 0
  private var failure: Error?
  private var continuation: CheckedContinuation<Void, Error>?

  private init(cap: Int64, target: URL) {
    self.cap = cap
    self.target = target
  }

  static func run(_ url: URL, to target: URL, cap: Int64, timeout: TimeInterval) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    configuration.urlCache = nil
    let delegate = CappedDownload(cap: cap, target: target)
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    defer { session.finishTasksAndInvalidate() }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        queue.addOperation {
          delegate.continuation = continuation
          session.dataTask(with: url).resume()
        }
      }
    } onCancel: {
      session.invalidateAndCancel()
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      failure = PreviewMedia.Rejected(message: "the server copy of a still is unavailable")
      return completionHandler(.cancel)
    }
    guard response.expectedContentLength <= cap else {
      failure = PreviewMedia.Rejected(message: "a still is over \(cap >> 20) MB")
      return completionHandler(.cancel)
    }
    guard FileManager.default.createFile(atPath: target.path, contents: nil), let handle = try? FileHandle(forWritingTo: target) else {
      failure = PreviewMedia.Rejected(message: "could not write a still")
      return completionHandler(.cancel)
    }
    self.handle = handle
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    written += Int64(data.count)
    guard written <= cap else {
      failure = PreviewMedia.Rejected(message: "a still is over \(cap >> 20) MB")
      dataTask.cancel()
      return
    }
    do { try handle?.write(contentsOf: data) } catch {
      failure = error
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    try? handle?.close()
    handle = nil
    let continuation = self.continuation
    self.continuation = nil
    if let failure = failure ?? error { continuation?.resume(throwing: failure) } else { continuation?.resume() }
  }
}
