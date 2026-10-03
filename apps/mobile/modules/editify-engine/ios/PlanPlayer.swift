import AVFoundation
import CoreImage

/// The native preview's player (plan P5, D1, OV10): an AVPlayer whose item is a
/// RenderPlan built by PlanBuilder and drawn by EditifyCompositor, the same
/// code exportProject runs. EditifyPlayerView hosts it in an AVPlayerLayer;
/// the macOS parity harness (parity/preview) drives it with a video output.
/// No UIKit here, so the harness compiles it as is.
///
///   setPlan(plan, media) ─▶ (revision, buildSeq) not newer than the last accepted? ─▶ dropped
///     ─▶ pending (a newer plan replaces one still waiting: 60 Hz drags coalesce)
///     ─▶ prepare (reusing loaded sources; ids whose ref changed, e.g. a proxy
///        replaced by its original, are invalidated and reloaded alone)
///        ├─ PlanBuilder.update succeeds (same structure, same sources):
///        │    swap the item's videoComposition in place; the audioMix only when
///        │    the audio parameters changed (so a sticker drag never touches sound);
///        │    paused ─▶ re-seek to the same time so the frame redraws (OV10)
///        └─ otherwise: a new AVPlayerItem; time and play state carried over
///           (paused first, re-seeked once ready, resumed after the seek lands)
///
/// Seeks coalesce (Apple QA1820's chase): one seek in flight; a newer target
/// replaces the queued one and runs when the current lands, so a 60 Hz scrub
/// never piles seeks up. Exact seeks are zero-tolerance.
///
/// The player owns one CaptionRenderer and one PlanMediaCache for its life, so
/// caption bitmaps and decoded stills survive every rebuild.
@MainActor
final class PlanPlayer {
  enum Mode: String { case update, rebuild, empty, failed }

  struct Applied {
    let revision: Int
    let buildSeq: Int
    let mode: Mode
    /// From setPlan to the new item or composition installed (decode excluded: it runs before setPlan).
    let milliseconds: Double
    let audioSwapped: Bool
    let error: String?

    var dictionary: [String: Any] {
      var body: [String: Any] = ["revision": revision, "buildSeq": buildSeq, "mode": mode.rawValue, "ms": milliseconds, "audioSwapped": audioSwapped]
      if let error { body["error"] = error }
      return body
    }
  }

  enum Event {
    /// The native clock: ~30 Hz while playing, and once whenever a seek lands.
    case time(Double, playing: Bool)
    case ready(duration: Double)
    case stall
    /// Playback stopped on its own: "end" of the timeline, or "interrupted" (the host paused it).
    case ended(String)
    case error(String)
    case plan(Applied)
  }

  /// The output cap: a preview never renders more than 1080 x 1920 (either orientation).
  static let maxLongSide: CGFloat = 1920
  static let maxShortSide: CGFloat = 1080

  let player = AVPlayer()
  var onEvent: ((Event) -> Void)?
  /// Every new AVPlayerItem, before it is installed (the parity harness attaches its video output).
  var onItem: ((AVPlayerItem) -> Void)?
  /// Every audio mix the player installs (the parity harness attaches its tap).
  var onAudioMix: ((AVMutableAudioMix) -> Void)?
  /// The view's size in pixels (0 until laid out): renders never exceed what it shows.
  var viewPixels: CGSize = .zero

  private(set) var built: BuiltPlan?
  private(set) var appliedCount = 0
  private var ordering = PlanOrdering()
  private var pending: (plan: RenderPlan, media: [String: String], at: UInt64)?
  private var pumping = false
  /// Every id this player loaded and the ref it came from: a later plan naming the id with
  /// another ref (the proxy finished, the original came back) reloads just that source.
  private var loadedRefs: [String: String] = [:]
  private let fonts: PlanFonts
  private let captions: CaptionRenderer
  private let cache = PlanMediaCache()
  private let resolver: ([String: String]) -> PlanAssetResolver
  private var audioKey: String?
  private var wantsPlay = false

  private var chase: (time: CMTime, exact: Bool)?
  private var seeking = false
  /// The target of the seek in flight.
  private var inFlight: CMTime?
  /// Bumped per seek and per item: a completion from a seek the player moved past is ignored.
  private var seekGeneration = 0
  private var itemObservers: [NSObjectProtocol] = []
  private var statusObservation: NSKeyValueObservation?
  private var timeObserver: Any?
  private var readyItem: ObjectIdentifier?

  init(fonts: PlanFonts = .shared, resolver: @escaping ([String: String]) -> PlanAssetResolver) {
    self.fonts = fonts
    self.resolver = resolver
    captions = CaptionRenderer(fonts: fonts)
    // Local files and proxies: start at once rather than buffering ahead.
    player.automaticallyWaitsToMinimizeStalling = false
    player.actionAtItemEnd = .pause
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
      MainActor.assumeIsolated {
        guard let self, self.player.rate != 0 else { return }
        self.onEvent?(.time(time.seconds, playing: true))
      }
    }
  }

  /// Stops everything and lets go of the item (the view is going away).
  func teardown() {
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    timeObserver = nil
    detachItemObservers()
    player.pause()
    player.replaceCurrentItem(with: nil)
    built = nil
    pending = nil
  }

  // MARK: Plans

  /// Accepts the plan when it is newer than every plan this player accepted, and
  /// applies it (asynchronously; the result arrives as a `.plan` event). False: dropped.
  @discardableResult
  func setPlan(_ plan: RenderPlan, media: [String: String]) -> Bool {
    guard ordering.accept(revision: plan.revision, buildSeq: plan.buildSeq) else { return false }
    pending = (plan, media, DispatchTime.now().uptimeNanoseconds)
    if !pumping {
      pumping = true
      Task { await pump() }
    }
    return true
  }

  /// Applies the newest waiting plan until none waits; plans superseded while one builds are skipped.
  private func pump() async {
    while let next = pending {
      pending = nil
      await apply(next.plan, media: next.media, since: next.at)
    }
    pumping = false
  }

  /// Output pixels per plan pixel: no larger than the view shows, the 1080 x 1920 cap, or the plan itself.
  func renderScale(for plan: RenderPlan) -> CGFloat {
    let width = CGFloat(plan.size.w), height = CGFloat(plan.size.h)
    var scale: CGFloat = 1
    scale = min(scale, Self.maxLongSide / max(width, height), Self.maxShortSide / min(width, height))
    if viewPixels.width > 0, viewPixels.height > 0 {
      // The layer aspect-fits the render: it shows the plan at this scale.
      scale = min(scale, max(0.05, min(viewPixels.width / width, viewPixels.height / height)))
    }
    return scale
  }

  private func apply(_ plan: RenderPlan, media refs: [String: String], since start: UInt64) async {
    let changed = Set(refs.compactMap { id, ref in loadedRefs[id].flatMap { $0 == ref ? nil : id } })
    let options = PlanBuildOptions(renderScale: renderScale(for: plan), fonts: fonts, captions: captions, media: cache)
    let elapsed = { Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 }
    do {
      let media = try await PlanBuilder.prepare(plan, resolver: resolver(refs), reusing: built?.media, invalidating: changed, cache: cache)
      loadedRefs.merge(refs) { $1 }
      if let built, player.currentItem != nil, let updated = try PlanBuilder.update(built, to: plan, media: media, options: options) {
        let audioSwapped = install(update: updated)
        report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .update, milliseconds: elapsed(), audioSwapped: audioSwapped, error: nil))
      } else {
        install(rebuild: try PlanBuilder.assemble(plan, media: media, options: options))
        report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .rebuild, milliseconds: elapsed(), audioSwapped: true, error: nil))
      }
    } catch PlanBuildError.emptyPlan {
      // Duration 0: only the background shows (the host paints it behind the layer).
      detachItemObservers()
      player.pause()
      player.replaceCurrentItem(with: nil)
      built = nil
      audioKey = nil
      report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .empty, milliseconds: elapsed(), audioSwapped: false, error: nil))
    } catch {
      // The item on screen (if any) stays: the host decides whether to fall back.
      let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
      report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .failed, milliseconds: elapsed(), audioSwapped: false, error: message))
      onEvent?(.error(message))
    }
  }

  private func report(_ applied: Applied) {
    appliedCount += 1
    onEvent?(.plan(applied))
  }

  /// A parameter-only edit on the item already playing. True when the audio mix was replaced.
  private func install(update: BuiltPlan) -> Bool {
    guard let item = player.currentItem else { return false }
    item.videoComposition = update.videoComposition
    let key = Self.audioKey(update.plan)
    let audioSwapped = key != audioKey
    if audioSwapped {
      onAudioMix?(update.audioMix)
      item.audioMix = update.audioMix
      audioKey = key
    }
    built = update
    // A paused frame does not redraw on its own: ask for it again (OV10). Coalesced with any scrub.
    if !wantsPlay { seek(to: targetTime.seconds, exact: true) }
    return audioSwapped
  }

  /// A structural edit: a new item at the same time, playing again if it was.
  private func install(rebuild: BuiltPlan) {
    let resumeAt = player.currentItem == nil ? CMTime.zero : targetTime
    let item = AVPlayerItem(asset: rebuild.composition)
    item.videoComposition = rebuild.videoComposition
    onAudioMix?(rebuild.audioMix)
    item.audioMix = rebuild.audioMix
    item.audioTimePitchAlgorithm = BuiltPlan.audioTimePitchAlgorithm
    // A seek completes once its frame is composited: the paused refresh and the harness rely on it.
    item.seekingWaitsForVideoCompositionRendering = true
    onItem?(item)
    // Paused across the swap: a replaced item would otherwise start from 0 at the old rate.
    player.pause()
    detachItemObservers()
    attachItemObservers(item)
    player.replaceCurrentItem(with: item)
    built = rebuild
    audioKey = Self.audioKey(rebuild.plan)
    let end = CMTime(value: max(0, Int64(rebuild.plan.frameCount) - 1), timescale: CMTimeScale(rebuild.plan.fps))
    // Lands once the item is ready (startSeek waits for it); playback resumes after it.
    chase = (min(max(resumeAt, .zero), end), true)
    seeking = false
    inFlight = nil
    seekGeneration += 1
  }

  /// Everything about the sound the audio mix encodes: entries, gains and fades.
  static func audioKey(_ plan: RenderPlan) -> String {
    plan.audio.map { entry in
      let keys = entry.gainKeys.map { "\($0.t):\($0.gain)" }.joined(separator: ",")
      return "\(entry.id)|\(entry.at)|\(entry.in)|\(entry.out)|\(entry.speed)|\(keys)|\(entry.fadeIn.duration)\(entry.fadeIn.curve.rawValue)|\(entry.fadeOut.duration)\(entry.fadeOut.curve.rawValue)"
    }.joined(separator: "\n")
  }

  // MARK: Transport

  var currentTime: Double {
    let seconds = player.currentTime().seconds
    return seconds.isFinite ? seconds : 0
  }

  /// Where the player is headed: the queued seek, else the one in flight, else where it is.
  private var targetTime: CMTime {
    if let chase { return chase.time }
    if seeking, let inFlight { return inFlight }
    let now = player.currentTime()
    return now.isValid ? now : .zero
  }

  var isPlaying: Bool { wantsPlay }

  func play() {
    wantsPlay = true
    resumeIfReady()
  }

  func pause() {
    wantsPlay = false
    player.pause()
    onEvent?(.time(targetTime.seconds, playing: false))
  }

  /// Host-initiated stop (the app left the foreground): paused, and said so.
  func interrupt() {
    guard wantsPlay else { return }
    pause()
    onEvent?(.ended("interrupted"))
  }

  func setMuted(_ muted: Bool) { player.isMuted = muted }

  /// Coalesced: a seek arriving while one is in flight replaces the queued target.
  func seek(to seconds: Double, exact: Bool) {
    guard seconds.isFinite else { return }
    var target = CMTime(seconds: max(0, seconds), preferredTimescale: 90_000)
    if let duration = built.map({ CMTime(value: Int64($0.plan.frameCount), timescale: CMTimeScale($0.plan.fps)) }), target > duration {
      target = duration
    }
    chase = (target, exact)
    if !seeking { startSeek() }
  }

  private func startSeek() {
    // An item that isn't ready can't take a seek with a completion handler: it waits for .readyToPlay.
    guard let target = chase, let item = player.currentItem, item.status == .readyToPlay else { return }
    chase = nil
    seeking = true
    inFlight = target.time
    seekGeneration += 1
    let generation = seekGeneration
    let tolerance = target.exact ? CMTime.zero : CMTime(value: 1, timescale: 10)
    player.seek(to: target.time, toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, generation == self.seekGeneration else { return }
          self.seeking = false
          self.inFlight = nil
          if self.chase != nil {
            self.startSeek()
            return
          }
          self.onEvent?(.time(self.currentTime, playing: self.wantsPlay))
          self.resumeIfReady()
        }
      }
    }
  }

  private func resumeIfReady() {
    guard wantsPlay, !seeking, chase == nil, let item = player.currentItem, item.status == .readyToPlay, player.rate == 0 else { return }
    player.play()
  }

  // MARK: Item observation

  private func attachItemObservers(_ item: AVPlayerItem) {
    statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] observed, _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.statusChanged(observed) }
      }
    }
    let center = NotificationCenter.default
    itemObservers.append(center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.wantsPlay = false
        self.onEvent?(.time(self.currentTime, playing: false))
        self.onEvent?(.ended("end"))
      }
    })
    itemObservers.append(center.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.onEvent?(.stall) }
    })
    itemObservers.append(center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] note in
      let message = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription ?? "Playback failed"
      MainActor.assumeIsolated { self?.onEvent?(.error(message)) }
    })
  }

  private func detachItemObservers() {
    statusObservation?.invalidate()
    statusObservation = nil
    for observer in itemObservers { NotificationCenter.default.removeObserver(observer) }
    itemObservers = []
  }

  private func statusChanged(_ item: AVPlayerItem) {
    guard item === player.currentItem else { return }
    switch item.status {
    case .readyToPlay:
      if readyItem != ObjectIdentifier(item) {
        readyItem = ObjectIdentifier(item)
        onEvent?(.ready(duration: built.map { Double($0.plan.frameCount) / Double($0.plan.fps) } ?? item.duration.seconds))
      }
      if !seeking, chase != nil { startSeek() } else { resumeIfReady() }
    case .failed:
      onEvent?(.error(item.error?.localizedDescription ?? "The preview could not play"))
    default:
      break
    }
  }
}
