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
///        │    swap the item's videoComposition in place (emoji and callout bitmaps come
///        │    from a cache, so only a sticker that changed is redrawn); the audioMix only
///        │    when the sound changed, and while playing only after edits pause for
///        │    `audioSwapDelay` (each swap restarts the audio chain: ~170 ms skip on a Mac),
///        │    so a sticker drag never touches sound and a gain drag costs one skip;
///        │    paused ─▶ re-seek to the same time so the frame redraws (OV10)
///        └─ otherwise: a new AVPlayerItem; time and play state carried over
///           (paused first, re-seeked once ready, resumed after the seek lands).
///           The clock stands still ~400 ms (Mac) while the new item starts; if a
///           phone measures over 250 ms (P7), ping-pong two players instead.
///
/// Seeks coalesce (Apple QA1820's chase): one seek in flight; a newer target
/// replaces the queued one and runs when the current lands, so a 60 Hz scrub
/// never piles seeks up. Exact seeks are zero-tolerance; inexact ones (a scrub in
/// progress) allow `scrubTolerance`.
///
/// Lifecycle: two separate holds, and the player runs (pump, seeks, renders) only
/// when neither is on. `suspend` (the app went to the background, where iOS refuses
/// the compositor's GPU work) holds plans and seeks until `resume`; `park` (the view
/// left the window) also drops the item and trims caches until `unpark`. Unparked
/// while still in the background, the item comes back only once the app does. A
/// plan whose sources finish loading during a hold waits for the player to run.
/// `teardown` is final.
///
/// Failures (`recover`):
///   item failed (status, failedToPlayToEnd, an HTTP 401/403 in its error log), or a loaded
///   source's media token about to expire (JWT `exp` less `expiryLead`: measured on macOS, a
///   read the server refuses fails nothing, logs nothing and stalls nothing; the composition
///   clock runs on over missing frames) ─▶ suspended? ─▶ handled once it runs
///     ├─ a remote source still reads with a token the last refresh replaced ─▶
///     │    rebuild on the URLs already held (those sources reloaded)
///     ├─ the plan plays the user's server copies ─▶ `.mediaExpired` (once): JS
///     │    re-resolves the media (fresh token) and sends a plan tagged `mediaRetry`; only
///     │    that plan rebuilds, with every remote source reloaded; a failure after it is
///     │    `.error`. Untagged plans meanwhile apply as usual and leave the wait on.
///     └─ local media only ─▶ rebuilt once at the same time; failing again is `.error`
///   a plan's server copy failed to load (prepare) ─▶ the same `.mediaExpired` and retry
///
/// Media tokens: server URLs carry the auth token (`k=`), which JS refreshes about
/// hourly. A ref that differs only in its token names the same bytes. Paused, the item is
/// rebuilt on the new URL at once (nothing moves, so nothing freezes). Playing, the source
/// stays loaded and the item is not rebuilt (no clock freeze): the new URL is kept, the
/// source is marked token-stale, and it moves to the new URL at the next pause, the end of
/// the timeline, or any rebuild before that; and, still playing, `expiryLead` before the
/// old token expires (above), so no read is ever refused. A refusal with no `exp` to see
/// coming (a session revoked on the server) is caught only if AVFoundation reports it; an
/// AVAssetResourceLoader that signs every range request itself would see every status.
/// Still to check on an iPhone 15 Pro with a short-lived token: that a phone behaves as the
/// harness's local server shows on a Mac.
///
/// Stalls: remote sources wait to minimize stalling; any stall reports buffering
/// and playback resumes once the item can keep up.
///
/// The player owns one CaptionRenderer, one PlanMediaCache and one bitmap cache for
/// its life, so caption bitmaps, decoded stills and sticker bitmaps survive rebuilds.
/// (P7: if a phone measures > 4 ms per drag tick for whole-plan JSON, add a native
/// patchOverlay call that edits one overlay of the current plan instead.)
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
    /// The sound changed while playing: the mix swaps once edits pause.
    let audioDeferred: Bool
    let error: String?

    var dictionary: [String: Any] {
      var body: [String: Any] = ["revision": revision, "buildSeq": buildSeq, "mode": mode.rawValue, "ms": milliseconds,
                                 "audioSwapped": audioSwapped, "audioDeferred": audioDeferred]
      if let error { body["error"] = error }
      return body
    }
  }

  enum Event {
    /// The native clock: ~30 Hz while playing, and once whenever a seek lands.
    case time(Double, playing: Bool)
    case ready(duration: Double)
    /// Waiting for media (true) or moving again (false).
    case buffering(Bool)
    /// Playback stopped on its own: "end" of the timeline, or "interrupted" (the host paused it).
    case ended(String)
    case error(String)
    /// The item failed while playing the user's server copies (most often an expired media token
    /// after the app was in the background, or a server copy that failed to load): resolve the
    /// media again and send a plan with `mediaRetry`. Sent once per failure; if that plan fails
    /// too, that is an `.error`.
    case mediaExpired(String)
    case plan(Applied)
  }

  /// Where a plan playing the user's server copies is in its one media retry.
  enum RemoteRetry { case none, awaiting, retried }

  /// The output cap: a preview never renders more than 1080 x 1920 (either orientation).
  static let maxLongSide: CGFloat = 1920
  static let maxShortSide: CGFloat = 1080
  /// How long the sound must stay unedited while playing before its new mix goes in.
  static let audioSwapDelay = 0.25
  /// Seconds either side an inexact (scrub) seek may land.
  static let scrubTolerance = CMTime(value: 1, timescale: 4)

  let player = AVPlayer()
  var onEvent: ((Event) -> Void)?
  /// Every new AVPlayerItem, before it is installed (the parity harness attaches its video output).
  var onItem: ((AVPlayerItem) -> Void)?
  /// Every audio mix the player installs (the parity harness attaches its tap).
  var onAudioMix: ((AVMutableAudioMix) -> Void)?
  /// After each install: the sources the player now holds (the view deletes temp stills it no longer needs).
  var onInstalled: ((PreparedMedia) -> Void)?
  /// The view's size in pixels (0 until laid out): renders never exceed what it shows.
  var viewPixels: CGSize = .zero

  private(set) var built: BuiltPlan?
  private(set) var appliedCount = 0
  /// Audio mixes installed on an item already playing or paused (not counting new items).
  private(set) var audioMixSwaps = 0
  /// The app is in the background (`suspend` until `resume`).
  private(set) var isBackgrounded = false
  /// The view is out of the window (`park` until `unpark`).
  private(set) var isParked = false
  /// Either hold: no plans applied, no seeks, nothing composited.
  var isSuspended: Bool { isBackgrounded || isParked }
  private(set) var remoteRetry = RemoteRetry.none
  private var ordering = PlanOrdering()
  /// `retry`: JS sent it (or a plan it superseded) as the answer to `.mediaExpired`.
  private var pending: (plan: RenderPlan, media: [String: String], at: UInt64, retry: Bool)?
  /// The newest plan accepted (what a failure retries: never older than one still loading).
  private var latest: (plan: RenderPlan, media: [String: String])?
  private var pumping = false
  private var torndown = false
  /// Every id this player loaded and the ref it came from: a later plan naming the id with
  /// another ref (the proxy finished, the original came back) reloads just that source.
  private var loadedRefs: [String: String] = [:]
  /// The media map of the plan on screen.
  private var currentRefs: [String: String] = [:]
  /// Remote ids whose loaded source reads with a token a newer ref replaced: reloaded at the next rebuild.
  private(set) var tokenStale: Set<String> = []
  /// The next apply rebuilds, reloading the token-stale sources (an item failed while it held some).
  private var reloadStale = false
  /// The ref each loaded remote source reads with (a token-stale source keeps its older one).
  private var sourceRefs: [String: String] = [:]
  /// Fires `expiryLead` before the earliest media token a loaded source reads with expires.
  private var expiryCheck: DispatchWorkItem?
  /// How long before a source's token expires the player acts (moves to a newer URL it holds,
  /// or asks for media): AVFoundation reports nothing when the server starts refusing reads.
  var expiryLead: TimeInterval = 5
  private let fonts: PlanFonts
  private let captions: CaptionRenderer
  private let cache = PlanMediaCache()
  let graphics = OverlayBitmapCache()
  private let resolver: ([String: String]) -> PlanAssetResolver
  private var audioKey: String?
  private var audioSwapWork: DispatchWorkItem?
  private var wantsPlay = false
  private var buffering = false
  /// The current item failed once and was rebuilt; a second failure is reported.
  private var failureRetried = false
  /// The item failed while suspended: handled once the player runs again.
  private var failedWhileSuspended: String?
  /// Parked with a plan: its item comes back once the player runs again.
  private var restoreAfterPark = false
  /// Where a parked player was.
  private var parkedAt: CMTime?

  private var chase: (time: CMTime, exact: Bool)?
  private var seeking = false
  /// The target of the seek in flight.
  private var inFlight: CMTime?
  /// Bumped per seek and per item: a completion from a seek the player moved past is ignored.
  private var seekGeneration = 0
  private var itemObservers: [NSObjectProtocol] = []
  private var itemObservations: [NSKeyValueObservation] = []
  private var playerObservation: NSKeyValueObservation?
  private var timeObserver: Any?
  private var readyItem: ObjectIdentifier?

  init(fonts: PlanFonts = .shared, resolver: @escaping ([String: String]) -> PlanAssetResolver) {
    self.fonts = fonts
    self.resolver = resolver
    captions = CaptionRenderer(fonts: fonts)
    // Local files and proxies start at once; remote sources (setPlan decides) wait to minimize stalls.
    player.automaticallyWaitsToMinimizeStalling = false
    player.actionAtItemEnd = .pause
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
      MainActor.assumeIsolated {
        guard let self, self.player.rate != 0 else { return }
        self.onEvent?(.time(time.seconds, playing: true))
      }
    }
    playerObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.playbackStatusChanged() } }
    }
  }

  /// Stops everything and lets go of the item (the view is going away). Final.
  func teardown() {
    guard !torndown else { return }
    torndown = true
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    timeObserver = nil
    playerObservation?.invalidate()
    playerObservation = nil
    audioSwapWork?.cancel()
    audioSwapWork = nil
    expiryCheck?.cancel()
    expiryCheck = nil
    detachItemObservers()
    player.pause()
    player.replaceCurrentItem(with: nil)
    built = nil
    pending = nil
    latest = nil
    chase = nil
  }

  // MARK: Plans

  /// Accepts the plan when it is newer than every plan this player accepted, and
  /// applies it (asynchronously; the result arrives as a `.plan` event). False: dropped.
  /// `mediaRetry`: JS resolved the media again after `.mediaExpired`; only such a plan (or a
  /// newer one that replaces it while it waits) is the retry. Any other plan landing while
  /// native waits for fresh media (an edit from another device, say) applies as usual and
  /// never ends the wait, so it can't spend the retry on URLs that may have expired.
  @discardableResult
  func setPlan(_ plan: RenderPlan, media: [String: String], mediaRetry: Bool = false) -> Bool {
    guard !torndown, ordering.accept(revision: plan.revision, buildSeq: plan.buildSeq) else { return false }
    pending = (plan, media, DispatchTime.now().uptimeNanoseconds, mediaRetry || (pending?.retry ?? false))
    latest = (plan, media)
    startPump()
    return true
  }

  private func startPump() {
    guard !pumping, !isSuspended, !torndown, pending != nil else { return }
    pumping = true
    Task { await pump() }
  }

  /// Applies the newest waiting plan until none waits; plans superseded while one builds are skipped.
  /// Suspended, the newest plan waits for resume.
  private func pump() async {
    while !isSuspended, !torndown, let next = pending {
      pending = nil
      await apply(next.plan, media: next.media, since: next.at, retry: next.retry)
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

  nonisolated static func isRemote(_ ref: String) -> Bool {
    let lower = ref.lowercased()
    return lower.hasPrefix("https://") || lower.hasPrefix("http://")
  }

  /// When a remote ref's media token expires: the `exp` of a JWT in its `k` query item (the
  /// server checks it on every read). nil for anything else (a shared token never expires).
  nonisolated static func tokenExpiry(_ ref: String) -> Date? {
    guard isRemote(ref), let token = URLComponents(string: ref)?.queryItems?.first(where: { $0.name == "k" })?.value else { return nil }
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while payload.count % 4 != 0 { payload += "=" }
    guard let data = Data(base64Encoded: payload), let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let exp = (claims["exp"] as? NSNumber)?.doubleValue else { return nil }
    return Date(timeIntervalSince1970: exp)
  }

  /// Arms the expiry check for the item on screen (wall clock: it counts time in the background).
  private func scheduleExpiryCheck() {
    expiryCheck?.cancel()
    expiryCheck = nil
    guard !torndown, player.currentItem != nil,
          let first = sourceRefs.compactMap({ id, ref in currentRefs[id] == nil ? nil : Self.tokenExpiry(ref) }).min() else { return }
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated { self?.tokenExpiring() }
    }
    expiryCheck = work
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + max(0, first.timeIntervalSinceNow - expiryLead), execute: work)
  }

  /// A loaded source's token is about to expire. The server will refuse its next read, and
  /// AVFoundation says nothing when that happens (the clock runs on over missing frames), so
  /// this is an item failure now: a newer URL held ─▶ rebuilt on it; none ─▶ `.mediaExpired`.
  private func tokenExpiring() {
    expiryCheck = nil
    guard !torndown, let item = player.currentItem else { return }
    itemFailed(item, "the media token expires")
  }

  /// A remote ref without its media token (the `k` query item, api.ts mediaUrl): two refs
  /// equal under it name the same bytes. Anything else is returned as is.
  nonisolated static func withoutToken(_ ref: String) -> String {
    guard isRemote(ref), var parts = URLComponents(string: ref), let items = parts.percentEncodedQueryItems else { return ref }
    let kept = items.filter { $0.name != "k" }
    parts.percentEncodedQueryItems = kept.isEmpty ? nil : kept
    return parts.string ?? ref
  }

  private func apply(_ plan: RenderPlan, media refs: [String: String], since start: UInt64, retry: Bool) async {
    // Sources whose ref changed are reloaded; a remote ref with only a new token keeps its source (token-stale).
    var changed = Set<String>()
    var tokenOnly = Set<String>()
    for (id, ref) in refs {
      guard let old = loadedRefs[id], old != ref else { continue }
      if Self.isRemote(ref), Self.withoutToken(old) == Self.withoutToken(ref) { tokenOnly.insert(id) } else { changed.insert(id) }
    }
    // The plan JS tagged as its answer to `.mediaExpired`: it rebuilds with every remote source reloaded.
    let mediaRetry = retry && remoteRetry == .awaiting
    let reloading = reloadStale
    // Token-stale sources move to their new URLs at a rebuild. Paused, that rebuild happens now
    // (nothing is moving, so nothing freezes); playing, it waits for the next pause (`pause`).
    let stale = tokenStale.union(tokenOnly)
    let rebuilding = mediaRetry || reloading || player.currentItem == nil || (!stale.isEmpty && !wantsPlay)
      || built.map { PlanBuilder.structureKey(plan) != $0.layout.structureKey } ?? true
    if rebuilding { changed.formUnion(stale) }
    if mediaRetry { changed.formUnion(refs.filter { Self.isRemote($0.value) }.map(\.key)) }
    var options = PlanBuildOptions(renderScale: renderScale(for: plan), fonts: fonts, captions: captions, media: cache)
    options.graphics = graphics
    let elapsed = { Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 }
    do {
      let media = try await PlanBuilder.prepare(plan, resolver: resolver(refs), reusing: built?.media, invalidating: changed, cache: cache)
      // Torn down while the sources loaded: nothing to install into.
      guard !torndown else { return }
      // Backgrounded or parked while the sources loaded: nothing is installed until the player
      // runs again; then this plan applies, unless a newer one is waiting.
      if isSuspended {
        if pending == nil { pending = (plan, refs, start, retry) } else if retry { pending?.retry = true }
        return
      }
      loadedRefs.merge(refs) { $1 }
      currentRefs = refs
      player.automaticallyWaitsToMinimizeStalling = refs.values.contains(where: Self.isRemote)
      if !rebuilding, let built, player.currentItem != nil, let updated = try PlanBuilder.update(built, to: plan, media: media, options: options) {
        let (swapped, deferred) = install(update: updated)
        report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .update, milliseconds: elapsed(), audioSwapped: swapped, audioDeferred: deferred, error: nil))
      } else {
        install(rebuild: try PlanBuilder.assemble(plan, media: media, options: options))
        report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .rebuild, milliseconds: elapsed(), audioSwapped: true, audioDeferred: false, error: nil))
      }
      tokenStale = stale.subtracting(changed)
      for (id, ref) in refs where Self.isRemote(ref) && (changed.contains(id) || sourceRefs[id] == nil) { sourceRefs[id] = ref }
      sourceRefs = sourceRefs.filter { refs[$0.key].map(Self.isRemote) ?? false }
      scheduleExpiryCheck()
      // Only the apply that saw the request satisfies it (one already loading may not have).
      if reloading { reloadStale = false }
      if mediaRetry {
        remoteRetry = .retried
      } else if remoteRetry == .retried, !tokenOnly.isEmpty {
        // A token refreshed since the retry: a later failure may ask for media again.
        remoteRetry = .none
      }
      failureRetried = false
      onInstalled?(media)
    } catch PlanBuildError.emptyPlan {
      // Duration 0: only the background shows (the host paints it behind the layer).
      guard !torndown else { return }
      dropItem()
      built = nil
      report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .empty, milliseconds: elapsed(), audioSwapped: false, audioDeferred: false, error: nil))
    } catch {
      guard !torndown else { return }
      // The item on screen (if any) stays: the host decides whether to fall back.
      let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
      report(Applied(revision: plan.revision, buildSeq: plan.buildSeq, mode: .failed, milliseconds: elapsed(), audioSwapped: false, audioDeferred: false, error: message))
      // A source that failed to load from the user's server (an expired URL, most often) gets
      // the same one media retry as an item failure; the retry itself failing is an error.
      if !mediaRetry, refs.values.contains(where: Self.isRemote) {
        switch remoteRetry {
        case .none:
          remoteRetry = .awaiting
          onEvent?(.mediaExpired(message))
          return
        case .awaiting:
          // Waiting for fresh media already: the tagged retry decides.
          return
        case .retried:
          break
        }
      }
      onEvent?(.error(message))
    }
  }

  private func report(_ applied: Applied) {
    appliedCount += 1
    onEvent?(.plan(applied))
  }

  /// A parameter-only edit on the item already playing: (audio mix swapped now, swap deferred).
  private func install(update: BuiltPlan) -> (Bool, Bool) {
    guard let item = player.currentItem else { return (false, false) }
    item.videoComposition = update.videoComposition
    built = update
    var swapped = false, deferred = false
    if Self.audioKey(update.plan) == audioKey {
      // Edited back to what the item plays: nothing to swap.
      audioSwapWork?.cancel()
      audioSwapWork = nil
    } else if wantsPlay {
      scheduleAudioSwap()
      deferred = true
    } else {
      swapAudioMix()
      swapped = true
    }
    // A paused frame does not redraw on its own: ask for it again (OV10). Coalesced with any scrub.
    if !wantsPlay { seek(to: targetTime.seconds, exact: true) }
    return (swapped, deferred)
  }

  /// The trailing edge of a burst of sound edits while playing: one swap, one skip.
  private func scheduleAudioSwap() {
    audioSwapWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated { self?.swapAudioMix() }
    }
    audioSwapWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.audioSwapDelay, execute: work)
  }

  private func swapAudioMix() {
    audioSwapWork?.cancel()
    audioSwapWork = nil
    guard !torndown, let built, let item = player.currentItem else { return }
    let key = Self.audioKey(built.plan)
    guard key != audioKey else { return }
    onAudioMix?(built.audioMix)
    item.audioMix = built.audioMix
    audioKey = key
    audioMixSwaps += 1
  }

  /// A structural edit (or a reinstall): a new item at the same time, playing again if it was.
  private func install(rebuild: BuiltPlan, at time: CMTime? = nil) {
    let resumeAt = time ?? (player.currentItem == nil ? CMTime.zero : targetTime)
    audioSwapWork?.cancel()
    audioSwapWork = nil
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

  private func dropItem() {
    audioSwapWork?.cancel()
    audioSwapWork = nil
    expiryCheck?.cancel()
    expiryCheck = nil
    detachItemObservers()
    player.pause()
    player.replaceCurrentItem(with: nil)
    audioKey = nil
    readyItem = nil
  }

  /// Everything about the sound the audio mix encodes: entries, gains and fades.
  static func audioKey(_ plan: RenderPlan) -> String {
    plan.audio.map { entry in
      let keys = entry.gainKeys.map { "\($0.t):\($0.gain)" }.joined(separator: ",")
      return "\(entry.id)|\(entry.at)|\(entry.in)|\(entry.out)|\(entry.speed)|\(keys)|\(entry.fadeIn.duration)\(entry.fadeIn.curve.rawValue)|\(entry.fadeOut.duration)\(entry.fadeOut.curve.rawValue)"
    }.joined(separator: "\n")
  }

  // MARK: Lifecycle

  /// The app went to the background: no GPU work until `resume` (plans and seeks wait).
  func suspend() {
    guard !torndown, !isBackgrounded else { return }
    interrupt()
    isBackgrounded = true
  }

  /// The app is back. The player runs again unless it is also parked.
  func resume() {
    guard !torndown, isBackgrounded else { return }
    isBackgrounded = false
    // Back from the background, the server copies get a fresh media retry (the token may have expired).
    if remoteRetry == .retried { remoteRetry = .none }
    run()
  }

  /// The view left the window: paused, the item and decoded caches released until `unpark`.
  func park() {
    guard !torndown, !isParked else { return }
    let at = player.currentItem == nil ? nil : targetTime
    interrupt()
    isParked = true
    restoreAfterPark = built != nil
    parkedAt = at
    // The item goes; a failure it had goes with it (the restored item is a new one).
    failedWhileSuspended = nil
    dropItem()
    chase = nil
    trimCaches()
  }

  /// The view is back. The player runs again unless the app is still in the background.
  func unpark() {
    guard !torndown, isParked else { return }
    isParked = false
    run()
  }

  /// Both holds are off: the parked item comes back, a failure from the hold is handled, held plans and seeks go.
  private func run() {
    guard !torndown, !isSuspended else { return }
    failureRetried = false
    if restoreAfterPark {
      restoreAfterPark = false
      // At a seek made since unparking (in the background), else where it was parked.
      if let built { install(rebuild: built, at: chase?.time ?? parkedAt ?? .zero) }
      parkedAt = nil
      scheduleExpiryCheck()
    }
    if let message = failedWhileSuspended {
      failedWhileSuspended = nil
      recover(from: message)
    }
    startPump()
    if chase != nil, !seeking { startSeek() }
  }

  /// Memory pressure: decoded stills, caption and sticker bitmaps are dropped (they redraw on demand).
  func trimCaches() {
    captions.cache.removeAll()
    cache.trim()
    graphics.removeAll()
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
    guard !torndown else { return }
    wantsPlay = true
    resumeIfReady()
  }

  func pause() {
    wantsPlay = false
    player.pause()
    onEvent?(.time(targetTime.seconds, playing: false))
    swapStaleSources()
  }

  /// Paused with sources still reading on a replaced token: rebuild on the new URLs now, while
  /// nothing moves, rather than waiting for the old token to fail mid-read.
  private func swapStaleSources() {
    guard !torndown, !wantsPlay, !tokenStale.isEmpty, built != nil, let latest else { return }
    reloadStale = true
    if pending == nil { pending = (latest.plan, latest.media, DispatchTime.now().uptimeNanoseconds, false) }
    startPump()
  }

  /// Host-initiated stop (the app left the foreground, the view left the window): paused, and said so.
  func interrupt() {
    guard wantsPlay else { return }
    pause()
    onEvent?(.ended("interrupted"))
  }

  func setMuted(_ muted: Bool) { player.isMuted = muted }

  /// Coalesced: a seek arriving while one is in flight replaces the queued target.
  func seek(to seconds: Double, exact: Bool) {
    guard seconds.isFinite, !torndown, !isParked else { return }
    var target = CMTime(seconds: max(0, seconds), preferredTimescale: 90_000)
    if let duration = built.map({ CMTime(value: Int64($0.plan.frameCount), timescale: CMTimeScale($0.plan.fps)) }), target > duration {
      target = duration
    }
    chase = (target, exact)
    if !seeking { startSeek() }
  }

  private func startSeek() {
    // An item that isn't ready can't take a seek with a completion handler: it waits for
    // .readyToPlay. Suspended (backgrounded), no frame may be composited: it waits for resume.
    guard !isSuspended, let target = chase, let item = player.currentItem, item.status == .readyToPlay else { return }
    chase = nil
    seeking = true
    inFlight = target.time
    seekGeneration += 1
    let generation = seekGeneration
    let tolerance = target.exact ? CMTime.zero : Self.scrubTolerance
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
    guard wantsPlay, !isSuspended, !seeking, chase == nil, let item = player.currentItem, item.status == .readyToPlay, player.rate == 0 else { return }
    player.play()
  }

  // MARK: Stalls

  private func setBuffering(_ value: Bool) {
    guard value != buffering else { return }
    buffering = value
    onEvent?(.buffering(value))
  }

  private func playbackStatusChanged() {
    switch player.timeControlStatus {
    case .waitingToPlayAtSpecifiedRate:
      if player.reasonForWaitingToPlay == .toMinimizeStalls { setBuffering(true) }
    case .playing:
      setBuffering(false)
    default:
      if !wantsPlay { setBuffering(false) }
    }
  }

  /// The item caught up after a stall: buffering over, and playing again if it should be
  /// (without waiting to minimize stalls, a stalled player stays stopped).
  private func likelyToKeepUpChanged(_ item: AVPlayerItem) {
    guard item === player.currentItem, item.isPlaybackLikelyToKeepUp else { return }
    if player.rate == 0 { setBuffering(false) }
    resumeIfReady()
  }

  // MARK: Item observation

  private func attachItemObservers(_ item: AVPlayerItem) {
    itemObservations.append(item.observe(\.status, options: [.initial, .new]) { [weak self] observed, _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.statusChanged(observed) }
      }
    })
    itemObservations.append(item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] observed, _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.likelyToKeepUpChanged(observed) }
      }
    })
    let center = NotificationCenter.default
    itemObservers.append(center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.wantsPlay = false
        self.onEvent?(.time(self.currentTime, playing: false))
        self.onEvent?(.ended("end"))
        self.swapStaleSources()
      }
    })
    itemObservers.append(center.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.setBuffering(true) }
    })
    // The server refusing a read (the media token expired under a loaded source) may never fail
    // the item: it can buffer forever instead. The error log names the HTTP status.
    itemObservers.append(center.addObserver(forName: AVPlayerItem.newErrorLogEntryNotification, object: item, queue: .main) { [weak self] _ in
      guard let status = item.errorLog()?.events.last?.errorStatusCode, Self.isTokenRefusal(status) else { return }
      MainActor.assumeIsolated { self?.tokenRefused(item, status: status) }
    })
    itemObservers.append(center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] note in
      let message = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription ?? "Playback failed"
      MainActor.assumeIsolated { self?.itemFailed(item, message) }
    })
  }

  private func detachItemObservers() {
    for observation in itemObservations { observation.invalidate() }
    itemObservations = []
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
      itemFailed(item, item.error?.localizedDescription ?? "The preview could not play")
    default:
      break
    }
  }

  /// A failed item. Suspended, it is handled once the player runs again (a retry then, not
  /// on media that may have expired in the meantime).
  private func itemFailed(_ item: AVPlayerItem, _ message: String) {
    guard !torndown, item === player.currentItem else { return }
    if isSuspended {
      failedWhileSuspended = message
      return
    }
    recover(from: message)
  }

  nonisolated static func isTokenRefusal(_ status: Int) -> Bool { status == 401 || status == 403 }

  /// The server refused a read of a remote source (its token expired): an item failure, so the
  /// policy below rebuilds on a newer URL already held or asks JS for fresh media.
  private func tokenRefused(_ item: AVPlayerItem, status: Int) {
    guard currentRefs.values.contains(where: Self.isRemote) else { return }
    itemFailed(item, "the server refused the media (HTTP \(status))")
  }

  /// The failure policy (the diagram at the top). Every branch retries at most once before `.error`.
  private func recover(from message: String) {
    guard let built, player.currentItem != nil else {
      onEvent?(.error(message))
      return
    }
    if !tokenStale.isEmpty {
      // Likely the old token expiring under a source loaded before the last refresh: rebuild
      // on the URLs already held (the token-stale sources reloaded), at the same time.
      reloadStale = true
      if pending == nil { pending = (latest?.plan ?? built.plan, latest?.media ?? currentRefs, DispatchTime.now().uptimeNanoseconds, false) }
      startPump()
      return
    }
    if currentRefs.values.contains(where: Self.isRemote) {
      switch remoteRetry {
      case .none:
        // Retrying on the same URLs would fail the same way: ask JS for fresh ones.
        remoteRetry = .awaiting
        onEvent?(.mediaExpired(message))
      case .awaiting:
        break
      case .retried:
        onEvent?(.error(message))
      }
      return
    }
    // Local media: often a compositor render the GPU refused. Rebuilt once at the same time.
    if !failureRetried {
      failureRetried = true
      let at = targetTime
      let resume = wantsPlay
      install(rebuild: built, at: at)
      if resume { resumeIfReady() }
      return
    }
    onEvent?(.error(message))
  }

  /// The parity harness's stand-in for a GPU refusal: the current item fails.
  func simulateItemFailure() {
    guard let item = player.currentItem else { return }
    itemFailed(item, "simulated failure")
  }
}
