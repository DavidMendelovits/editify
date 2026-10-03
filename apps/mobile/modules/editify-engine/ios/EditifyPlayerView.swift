import AVFoundation
import ExpoModulesCore
import UIKit

/// The native preview (plan P5, 6A): one AVPlayerLayer showing PlanPlayer's
/// item, so this view draws every pixel (video, overlays, captions) with the
/// export's renderer. React Native lays only selection boxes and handles over it.
///
/// JS drives it through the view's ref (EditifyEngineModule's View functions):
/// setPlan(planJson, media), play, pause, seek(t, exact), setMuted. It reports
/// onTime (the native clock: ~30 Hz while playing, and when a seek lands),
/// onReady, onStall, onEnded ({reason: 'end' | 'interrupted'}), onError and
/// onPlan (how each accepted plan was applied, with its latency).
///
/// The render is the view's pixel size, capped at 1080 x 1920 (PlanPlayer.renderScale);
/// the layer aspect-fits it, with the plan's background behind.
final class EditifyPlayerView: ExpoView {
  let onTime = EventDispatcher()
  let onReady = EventDispatcher()
  let onStall = EventDispatcher()
  let onEnded = EventDispatcher()
  let onError = EventDispatcher()
  let onPlan = EventDispatcher()

  private let playerLayer = AVPlayerLayer()
  private let core: PlanPlayer
  private var observers: [NSObjectProtocol] = []

  required init(appContext: AppContext? = nil) {
    core = PlanPlayer(resolver: PreviewMedia.resolver)
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    playerLayer.player = core.player
    playerLayer.videoGravity = .resizeAspect
    layer.addSublayer(playerLayer)
    core.onEvent = { [weak self] event in self?.dispatch(event) }
    // The compositor renders on the GPU, which iOS refuses to a backgrounded app: stop first.
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.core.interrupt() }
    })
    observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
      MainActor.assumeIsolated { if began { self?.core.interrupt() } }
    })
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    let core = self.core
    Task { @MainActor in core.teardown() }
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
    if window == nil { core.interrupt() }
  }

  // MARK: Commands (from the module's View functions, on the main actor)

  /// False when the plan is not newer than the last one this view accepted.
  func setPlan(_ plan: RenderPlan, media: [String: String]) -> Bool {
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
    case .stall: onStall([:])
    case .ended(let reason): onEnded(["reason": reason])
    case .error(let message): onError(["message": message])
    case .plan(let applied): onPlan(applied.dictionary)
    }
  }
}

/// Where the preview's media comes from: the map JS built with resolveMedia (purpose
/// 'preview'), validated before a plan reaches the player. A value is a PHAsset local id,
/// a file:// URI inside the app (an app copy or a 1080p proxy), or an http(s) URL of the
/// user's own server copy (the server proxy for a clip that isn't on this iPhone). Ids
/// resolve only within the map, never as paths (PlanAssetResolver's contract).
enum PreviewMedia {
  struct Rejected: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  /// Server stills are small (stickers): a bigger download is refused.
  static let maxImageBytes: Int64 = 64 << 20

  static func validate(_ raw: [String: Any], for plan: RenderPlan) throws -> [String: String] {
    guard raw.count <= PlanLimits.audio + PlanLimits.overlays + PlanLimits.segments else { throw Rejected(message: "media map is too large") }
    var media: [String: String] = [:]
    for (id, value) in raw {
      guard let ref = value as? String, !id.isEmpty, id.count <= PlanLimits.idChars, !ref.isEmpty, ref.count <= 4096 else {
        throw Rejected(message: "media map has an invalid entry")
      }
      if ref.hasPrefix("file://") {
        guard ExportCenter.containedFileURL(ref) != nil else { throw Rejected(message: "media map has a file outside the app") }
      } else if ref.contains("://") {
        guard let scheme = URL(string: ref)?.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
          throw Rejected(message: "media map has an unsupported URL")
        }
      }
      media[id] = ref
    }
    let missing = ExportCenter.assetIds(plan).subtracting(media.keys)
    guard missing.isEmpty else { throw Rejected(message: "No preview media for \(missing.count) asset(s)") }
    return media
  }

  static func resolver(_ media: [String: String]) -> PlanAssetResolver {
    PlanAssetResolver(
      asset: { ref in
        guard let value = media[ref.id] else { throw AssetSource.NotFound(ref: ref.id) }
        if isRemote(value), let url = URL(string: value) { return AVURLAsset(url: url) }
        return try await ExportCenter.loadAsset(value, id: ref.id)
      },
      imageFile: { ref in
        guard let value = media[ref.id] else { throw AssetSource.NotFound(ref: ref.id) }
        if isRemote(value), let url = URL(string: value) { return try await download(url) }
        return try await ExportCenter.imageFile(value, id: ref.id, prefix: TempFiles.previewPrefix)
      })
  }

  static func isRemote(_ ref: String) -> Bool {
    ref.lowercased().hasPrefix("https://") || ref.lowercased().hasPrefix("http://")
  }

  private static func download(_ url: URL) async throws -> URL {
    let (file, response) = try await URLSession.shared.download(from: url)
    defer { try? FileManager.default.removeItem(at: file) }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw Rejected(message: "the server copy of a still is unavailable") }
    let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
    guard size <= maxImageBytes else { throw Rejected(message: "a still is over \(maxImageBytes >> 20) MB") }
    let ext = url.pathExtension.isEmpty ? "img" : url.pathExtension
    let target = FileManager.default.temporaryDirectory.appendingPathComponent("\(TempFiles.previewPrefix)\(UUID().uuidString).\(ext)")
    try FileManager.default.moveItem(at: file, to: target)
    return target
  }
}
