// Native preview harness (plan P5, OV10): drives PlanPlayer, the AVPlayer behind
// EditifyPlayerView, on macOS with an AVPlayerItemVideoOutput standing in for the
// AVPlayerLayer, and reports what the phone's preview would show.
//
//   preview-harness <render-golden manifest> <repo root> <work dir> <out dir>
//
// 1. Synthesizes the media the preview plans name (HarnessMedia.swift), plus a
//    half-size "proxy" of asset-talk with the same pattern.
// 2. Goldens: each plan plays at its own size (render scale 1); paused, exact seeks
//    to the golden frames; the frames are compared with parity/goldens like the
//    render-golden harness (same PNG encoding, same metrics).
// 3. OV10: a parameter-only update (an overlay box moved, a caption restyled)
//    swaps the video composition on the same item and composition, and the paused
//    frame redraws; a structural update (a trimmed clip) rebuilds the item and
//    keeps the time, paused and playing; a stale (revision, buildSeq) is dropped;
//    60 Hz box updates for 2 s while playing (latencies, frame intervals, stalls,
//    an audio tap's continuity, sticker bitmaps from the cache); a burst of
//    audio-parameter edits while playing (one deferred mix swap); a proxy replaced
//    by its original reloads only that asset.
// 4. Lifecycle: suspended (backgrounded) plans and seeks wait for resume; a failed
//    item is rebuilt once, a second failure reported; park drops the item and
//    trims caches, unpark restores the time; unparked while still backgrounded,
//    nothing runs until resume; teardown mid-build installs nothing.
// 5. Server copies (refs on https://media.test, which the harness resolver maps to
//    the local files): a token-only ref change rebuilds at once when paused, and
//    while playing keeps the item and source until a pause, a rebuild, or a failure
//    (rebuilt on the new URL); a failure with no newer URL asks for media
//    (mediaExpired) instead of retrying; an untagged plan meanwhile doesn't end the
//    wait, the tagged retry rebuilds with the remote source reloaded, and a failure
//    after that is an error; a server copy failing to load asks the same way.
//    Over HTTP (MediaServer.swift, checking each token's exp): the player acts before
//    a token expires mid-play, and plays real frames from the fresh URL; with the
//    server's clock 20 s ahead, the clock offset keeps every read accepted; a silent
//    drop (transfers cut, 500s) is caught from the compositor falling behind the clock
//    and reconnected natively, or handed to JS (mediaExpired) if the server stays down;
//    the error-log matcher classifies CoreMedia and CFNetwork entries. A sticker added
//    while paused at the frame on screen is drawn at once.
// 6. Preview files: a download cancelled around its start never touches an
//    invalidated session; a still added after teardown is deleted.
// Prints one JSON report on stdout; server/test/native-preview.test.ts asserts on it.
//
// Never hangs: every wait is bounded and labelled, and a watchdog thread (which needs
// nothing from the main thread) ends the process with the step it was stuck in when a
// step runs past its limit or the whole run past its budget. One progress line per step
// goes to stderr. The run drives the main RunLoop itself (not dispatch_main), so
// AVFoundation's run-loop sources and timers fire as they do in an app. On a machine with
// no audio output device (CI VMs) the players are muted and no audio tap is attached: the
// report says so and the audio checks skip.

import AVFoundation
import CoreAudio
import CoreImage
import Foundation
import MediaToolbox

// MARK: Watchdog

/// Steps, their timings, and the deadline a background thread enforces with exit(3).
final class Watchdog: @unchecked Sendable {
  private let lock = NSLock()
  private let started = CFAbsoluteTimeGetCurrent()
  private var label = "start"
  private var stepStarted = CFAbsoluteTimeGetCurrent()
  private var deadline = CFAbsoluteTimeGetCurrent() + 120
  private var timings: [[String: Any]] = []
  let budget: Double

  init(budget: Double) {
    self.budget = budget
    let thread = Thread { [self] in
      while true {
        Thread.sleep(forTimeInterval: 0.5)
        check()
      }
    }
    thread.stackSize = 1 << 20
    thread.start()
  }

  static func log(_ line: String) {
    FileHandle.standardError.write("[preview] \(line)\n".data(using: .utf8)!)
  }

  /// Ends the previous step and starts `name`, which must finish within `limit` seconds.
  func step(_ name: String, limit: Double = 60) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.withLock {
      if label != "start" { timings.append(["step": label, "ms": ((now - stepStarted) * 1000).rounded()]) }
      label = name
      stepStarted = now
      deadline = now + limit
    }
    Self.log(String(format: "+%.1fs %@", now - started, name))
  }

  func finish() -> [[String: Any]] {
    step("done", limit: 60)
    return lock.withLock { timings }
  }

  private func check() {
    let now = CFAbsoluteTimeGetCurrent()
    let (name, ran, over) = lock.withLock { (label, now - stepStarted, now > deadline || now - started > budget) }
    guard over else { return }
    Self.log(String(format: "TIMEOUT in step '%@' after %.1fs (step limit or the %.0fs budget): the main thread is blocked or a wait never ended", name, ran, budget))
    exit(3)
  }
}

/// Well under the test's hook timeout (600 s), including a slow CI VM. PREVIEW_HARNESS_BUDGET
/// (seconds) overrides it, to check the watchdog itself.
let watchdog = Watchdog(budget: ProcessInfo.processInfo.environment["PREVIEW_HARNESS_BUDGET"].flatMap(Double.init) ?? 300)
watchdog.step("media", limit: 150)

/// Whether this machine has an audio output device. Without one (CI VMs) AVPlayer has no
/// audio clock to render against: the players are muted and the tap stays off.
func hasAudioOutput() -> Bool {
  if let forced = ProcessInfo.processInfo.environment["PREVIEW_HARNESS_AUDIO"] { return forced == "1" }
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
                                           mElement: kAudioObjectPropertyElementMain)
  let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
  return status == noErr && device != kAudioObjectUnknown
}
let audioDevice = hasAudioOutput()

let arguments = CommandLine.arguments
guard arguments.count >= 5 else {
  FileHandle.standardError.write("usage: preview-harness <golden manifest> <repo> <work> <out>\n".data(using: .utf8)!)
  exit(2)
}
let manifestURL = URL(fileURLWithPath: arguments[1])
let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
let repo = URL(fileURLWithPath: arguments[2])
let work = URL(fileURLWithPath: arguments[3])
let outDir = URL(fileURLWithPath: arguments[4])
try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let goldens = repo.appendingPathComponent(manifest.goldens)
let fontsDir = repo.appendingPathComponent(manifest.fonts)
let fonts = PlanFonts { fontsDir.appendingPathComponent("\($0.rawValue).ttf") }

/// The golden renders this harness replays through the player.
let goldenRenders = ["overlays", "caption-karaoke", "crossfade", "zoom"]

func fixture(_ name: String) throws -> [String: Any] {
  let wrapper = try JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("packages/shared/fixtures/render-plans/\(name).json"))) as! [String: Any]
  return wrapper["plan"] as! [String: Any]
}

/// Sets a value at a key path of nested dictionaries and arrays.
func edit(_ plan: inout [String: Any], _ path: [Any], _ value: Any) {
  func set(_ node: Any, _ path: ArraySlice<Any>) -> Any {
    guard let head = path.first else { return value }
    if let key = head as? String, var dict = node as? [String: Any] { dict[key] = set(dict[key] as Any, path.dropFirst()); return dict }
    if let index = head as? Int, var list = node as? [Any] { list[index] = set(list[index], path.dropFirst()); return list }
    return node
  }
  plan = set(plan, path[...]) as! [String: Any]
}

/// The module's path: JSON in, RenderPlan.decode (the caps), with the ordering fields set.
func decode(_ plan: [String: Any], revision: Int, buildSeq: Int) throws -> RenderPlan {
  var plan = plan
  plan["revision"] = revision
  plan["buildSeq"] = buildSeq
  return try RenderPlan.decode(JSONSerialization.data(withJSONObject: plan))
}

// MARK: Media

var mediaReport: [String: Any] = [:]
var mediaRefs: [String: String] = [:]
var wanted = Set<String>()
for name in goldenRenders {
  let plan = try decode(try fixture(name), revision: 0, buildSeq: 0)
  for segment in plan.video.segments { for layer in segment.layers { wanted.insert(layer.assetRef.id) } }
  for overlay in plan.overlays { if let id = overlay.media?.assetRef.id { wanted.insert(id) } }
  for entry in plan.audio { wanted.insert(entry.assetRef.id) }
}
let rawManifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as! [String: Any]
let rawMedia = rawManifest["media"] as! [String: Any]
for id in wanted.sorted() {
  guard let media = manifest.media[id] else { throw HarnessError("no media \(id)") }
  let (url, codec) = try synthesized(id, media, work: work)
  if let codec { mediaReport[id] = ["codec": codec] }
  mediaRefs[id] = url.absoluteString
}
// The "proxy": asset-talk's pattern at half size, as the 1080p proxy of a 4K original would be.
var proxySpec = rawMedia["asset-talk"] as! [String: Any]
proxySpec["w"] = (proxySpec["w"] as! Int) / 2
proxySpec["h"] = (proxySpec["h"] as! Int) / 2
let proxyMedia = try JSONDecoder().decode(Manifest.Media.self, from: JSONSerialization.data(withJSONObject: proxySpec))
let proxyURL = try synthesized("asset-talk-proxy", proxyMedia, work: work).url

/// What the module does with the media map: ids resolve only within it (here, the synthesized files).
/// A server copy (`https://media.test/<id>/...?k=<token>`) stands for that id's local file.
func resolver(_ refs: [String: String]) -> PlanAssetResolver {
  func local(_ value: String) -> URL? {
    // The local media server is reached for real; media.test stands for the files.
    guard let url = URL(string: value), url.host == "media.test" else { return URL(string: value) }
    // A token that "expired" before the source loaded: the load fails, as the server's 401 would.
    if value.hasSuffix("k=expired") { return nil }
    guard let id = url.pathComponents.dropFirst().first, let file = mediaRefs[id] else { return nil }
    return URL(string: file)
  }
  return PlanAssetResolver(
    asset: { ref in
      guard ref.kind != .image, let value = refs[ref.id], let url = local(value) else { throw HarnessError("no \(ref.kind.rawValue) asset \(ref.id)") }
      return AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    },
    imageFile: { ref in
      guard ref.kind == .image, let value = refs[ref.id], let url = local(value) else { throw HarnessError("no image asset \(ref.id)") }
      return url
    })
}

/// The media map with asset-talk played from its "server copy", minted with `token`.
func serverCopy(token: String) -> [String: String] {
  var refs = mediaRefs
  refs["asset-talk"] = "https://media.test/asset-talk/proxy.mp4?k=\(token)"
  return refs
}

// MARK: Audio tap (continuity across composition and mix swaps)

/// What the processing tap saw: per callback, the wall time, the source time and the frame count.
final class TapLog: @unchecked Sendable {
  private let lock = NSLock()
  private(set) var records: [(wall: Double, start: Double, frames: Int)] = []
  private(set) var sampleRate: Double = 0
  func setRate(_ rate: Double) { lock.withLock { sampleRate = rate } }
  func add(start: Double, frames: Int) { lock.withLock { records.append((CFAbsoluteTimeGetCurrent(), start, frames)) } }
  func snapshot() -> (records: [(wall: Double, start: Double, frames: Int)], rate: Double) { lock.withLock { (records, sampleRate) } }
}

func attachTap(_ mix: AVMutableAudioMix, log: TapLog) {
  guard let input = mix.inputParameters.first as? AVMutableAudioMixInputParameters else { return }
  var callbacks = MTAudioProcessingTapCallbacks(
    version: kMTAudioProcessingTapCallbacksVersion_0,
    clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(log).toOpaque()),
    init: { _, clientInfo, storageOut in storageOut.pointee = clientInfo },
    finalize: { tap in Unmanaged<TapLog>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release() },
    prepare: { tap, _, format in
      Unmanaged<TapLog>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().setRate(format.pointee.mSampleRate)
    },
    unprepare: nil,
    process: { tap, frames, _, buffers, framesOut, flagsOut in
      var range = CMTimeRange()
      guard MTAudioProcessingTapGetSourceAudio(tap, frames, buffers, flagsOut, &range, framesOut) == noErr else { return }
      Unmanaged<TapLog>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().add(start: range.start.seconds, frames: Int(framesOut.pointee))
    })
  var tap: MTAudioProcessingTap?
  guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) == noErr, let tap else { return }
  input.audioTapProcessor = tap
}

/// Gaps in what the tap processed over a wall-time window: the longest wall pause between
/// callbacks, and source-time jumps (a callback not starting where the previous one ended).
func tapContinuity(_ log: TapLog, from: Double, to: Double) -> [String: Any] {
  let (records, rate) = log.snapshot()
  let window = records.filter { $0.wall >= from && $0.wall <= to }
  var maxWallGap = 0.0
  var jumps = 0
  var maxJump = 0.0
  for (previous, record) in zip(window, window.dropFirst()) {
    maxWallGap = max(maxWallGap, record.wall - previous.wall)
    if rate > 0, previous.start.isFinite, record.start.isFinite {
      let jump = record.start - (previous.start + Double(previous.frames) / rate)
      if abs(jump) > 0.002 { jumps += 1; if abs(jump) > abs(maxJump) { maxJump = jump } }
    }
  }
  let frames = window.reduce(0) { $0 + $1.frames }
  return ["callbacks": window.count, "seconds": rate > 0 ? Double(frames) / rate : 0, "maxWallGapMs": maxWallGap * 1000,
          "sourceJumps": jumps, "largestSourceJumpMs": maxJump * 1000, "sampleRate": rate]
}

// MARK: The player under test

func percentile(_ values: [Double], _ p: Double) -> Double {
  guard !values.isEmpty else { return -1 }
  let sorted = values.sorted()
  return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
}

func stats(_ values: [Double]) -> [String: Any] {
  ["count": values.count, "p50": percentile(values, 0.5), "p95": percentile(values, 0.95), "max": values.max() ?? -1]
}

@MainActor
final class Rig {
  let player: PlanPlayer
  private(set) var output: AVPlayerItemVideoOutput?
  var applied: [PlanPlayer.Applied] = []
  var seeksLanded = 0
  var stalls = 0
  var ends = 0
  var errors: [String] = []
  var expired: [String] = []
  var readies = 0
  let tap = TapLog()

  init() {
    player = PlanPlayer(fonts: fonts, resolver: resolver, videoComposition: harnessComposition)
    player.player.volume = 0
    // No output device: muted, so playback runs on the host clock with no audio rendering.
    if !audioDevice { player.setMuted(true) }
    player.onItem = { [weak self] item in
      item.preferredForwardBufferDuration = 1
      let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
      ])
      item.add(output)
      self?.output = output
    }
    player.onAudioMix = { [weak self] mix in if let self, audioDevice { attachTap(mix, log: self.tap) } }
    player.onEvent = { [weak self] event in
      guard let self else { return }
      switch event {
      case .plan(let applied): self.applied.append(applied)
      case .time(_, let playing): if !playing { self.seeksLanded += 1 }
      case .buffering(let on): if on { self.stalls += 1 }
      case .ended: self.ends += 1
      case .error(let message): self.errors.append(message)
      case .mediaExpired(let message): self.expired.append(message)
      case .ready: self.readies += 1
      }
    }
  }

  func until(_ seconds: Double = 10, _ condition: () -> Bool) async -> Bool {
    let deadline = CFAbsoluteTimeGetCurrent() + seconds
    while CFAbsoluteTimeGetCurrent() < deadline {
      if condition() { return true }
      try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return condition()
  }

  /// `until`, failing with `label` when it doesn't happen in time.
  func expect(_ label: String, _ seconds: Double = 30, _ condition: () -> Bool) async throws {
    guard await until(seconds, condition) else { throw HarnessError("timed out after \(Int(seconds)) s: \(label)") }
  }

  /// Sets a plan and waits until it (or a later one) is applied and the item can play.
  @discardableResult
  func apply(_ plan: RenderPlan, media: [String: String]? = nil, mediaRetry: Bool = false, tokenClockOffset: Double? = nil) async throws -> PlanPlayer.Applied {
    let before = applied.count
    guard player.setPlan(plan, media: media ?? mediaRefs, mediaRetry: mediaRetry, tokenClockOffset: tokenClockOffset) else { throw HarnessError("plan (\(plan.revision), \(plan.buildSeq)) dropped") }
    try await expect("plan (\(plan.revision), \(plan.buildSeq)) applied") { applied.count > before }
    let result = applied.last!
    if result.mode == .failed { throw HarnessError("plan failed: \(result.error ?? "?")") }
    try await expect("item readyToPlay (errors: \(errors))") { player.player.currentItem?.status == .readyToPlay }
    return result
  }

  /// An exact seek, then the frame the output gets for it.
  func frame(at k: Int, fps: Int, timeout: Double = 15) async throws -> (buffer: CVPixelBuffer, ms: Double) {
    let time = CMTime(value: CMTimeValue(k), timescale: CMTimeScale(fps))
    let started = CFAbsoluteTimeGetCurrent()
    let landed = seeksLanded
    player.seek(to: time.seconds, exact: true)
    try await expect("seek to frame \(k) landed") { seeksLanded > landed }
    guard let buffer = await newFrame(at: time, timeout: timeout) else { throw HarnessError("timed out: the video output vended no frame at \(k)") }
    return (buffer, (CFAbsoluteTimeGetCurrent() - started) * 1000)
  }

  /// The next frame the output vends for `time` itself. (hasNewPixelBuffer is also true for an
  /// older frame still queued, such as the one on screen when the player paused; on a slow VM
  /// that one can still be waiting when a seek lands. Its display time tells them apart.)
  /// The output is read on every poll: a rebuild landing meanwhile (a stale source swapped at the
  /// pause, say) replaces the item, and the frame then comes from the new item's output.
  func newFrame(at time: CMTime, timeout: Double = 15) async -> CVPixelBuffer? {
    var found: CVPixelBuffer?
    _ = await until(timeout) {
      guard let output, output.hasNewPixelBuffer(forItemTime: time) else { return false }
      var shown = CMTime.invalid
      guard let buffer = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: &shown) else { return false }
      guard shown.isValid, abs(shown.seconds - time.seconds) < 1.0 / 120 else { return false }
      found = buffer
      return true
    }
    return found
  }
}

func comparePNG(_ buffer: CVPixelBuffer, plan: RenderPlan, file: String, downscale: Int) throws -> [String: Any] {
  let encoded = pixels(buffer, space: PlanColorPipeline.outputSpace(plan.color))
  let rendered = outDir.appendingPathComponent(file)
  try writePNG(encoded, downscale: downscale, sixteenBit: plan.color == .hlg, to: rendered)
  guard let mine = readPNG(rendered), let theirs = readPNG(goldens.appendingPathComponent(file)) else { return ["missingGolden": true] }
  return compare(mine, theirs)
}

func linear(_ buffer: CVPixelBuffer, _ x: Double, _ y: Double, r: Int = 2) -> [Double] {
  let image = pixels(buffer, space: workingSpace)
  var sum = [0.0, 0.0, 0.0]
  var n = 0.0
  for dy in -r...r { for dx in -r...r { let p = image.at(Int(x) + dx, Int(y) + dy); for c in 0..<3 { sum[c] += Double(p[c]) }; n += 1 } }
  return sum.map { $0 / n }
}

/// Encoded pixels in a rectangle that are white (every channel > 0.9) and red (r > 0.8, g and b < 0.35).
func whiteAndRed(_ buffer: CVPixelBuffer, x: Double, y: Double, w: Double, h: Double) -> [String: Int] {
  let image = pixels(buffer, space: PlanColorPipeline.outputSpace(.sdr))
  var white = 0, red = 0
  for yy in Int(y)..<Int(y + h) {
    for xx in Int(x)..<Int(x + w) {
      let p = image.at(xx, yy)
      if p.allSatisfy({ $0 > 0.9 }) { white += 1 }
      if p[0] > 0.8, p[1] < 0.35, p[2] < 0.35 { red += 1 }
    }
  }
  return ["white": white, "red": red]
}

/// The source frame (its embedded code) the player shows paused at frame k of a plan whose
/// talk clip plays from a server. Bytes may still be on their way (the server trickles them; a
/// CI VM is slow): a paused seek lands on the last frame decoded, or vends no frame within its
/// wait on a loaded runner, so it seeks again until the frame at k arrives, for up to 30 s, and
/// returns what it shows then (-1: no frame at all).
@MainActor
func serverCode(_ rig: Rig, at k: Int) async throws -> Int {
  rig.player.pause()
  let deadline = CFAbsoluteTimeGetCurrent() + 30
  var shown = -1
  repeat {
    do {
      shown = decodeCode(pixels(try await rig.frame(at: k, fps: 30, timeout: min(15, max(1, deadline - CFAbsoluteTimeGetCurrent()))).buffer, space: workingSpace))
      if shown == k { break }
    } catch let error as HarnessError where error.description.hasPrefix("timed out: the video output vended no frame") {
      // What the player was doing, should a runner ever exhaust the retries.
      let item = rig.player.player.currentItem
      Watchdog.log("no frame at \(k) yet; seeking again (time \(rig.player.currentTime), status \(item?.status.rawValue ?? -1), "
        + "keepUp \(item?.isPlaybackLikelyToKeepUp ?? false), rate \(rig.player.player.rate), landed \(rig.seeksLanded), "
        + "output \(rig.output != nil), errors \(rig.errors.count), expired \(rig.expired.count))")
    }
    try? await Task.sleep(nanoseconds: 300_000_000)
  } while CFAbsoluteTimeGetCurrent() < deadline
  return shown
}

@MainActor
func run() async throws -> [String: Any] {
  var report: [String: Any] = ["media": mediaReport, "adapters": adapterReport()]
  var buildSeq = 0
  func next() -> Int { buildSeq += 1; return buildSeq }

  // MARK: Goldens through the player
  var goldenReport: [[String: Any]] = []
  var seekTimes: [Double] = []
  for name in goldenRenders {
    watchdog.step("goldens: \(name)")
    guard let render = manifest.renders.first(where: { $0.name == name }) else { throw HarnessError("no golden render \(name)") }
    let rig = Rig()
    let plan = try decode(try fixture(name), revision: 1, buildSeq: next())
    let applied = try await rig.apply(plan)
    var entry: [String: Any] = ["name": name, "mode": applied.mode.rawValue, "applyMs": applied.milliseconds]
    var frames: [[String: Any]] = []
    for frame in render.frames where frame.golden == true {
      let (buffer, ms) = try await rig.frame(at: frame.k, fps: plan.fps)
      seekTimes.append(ms)
      let file = "\(name)-\(String(format: "%03d", frame.k)).png"
      frames.append(["k": frame.k, "golden": file, "seekMs": ms, "compare": try comparePNG(buffer, plan: plan, file: file, downscale: render.downscale ?? 1),
                     "size": [CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer)]])
    }
    entry["frames"] = frames
    entry["errors"] = rig.errors
    goldenReport.append(entry)
    rig.player.teardown()
  }
  report["goldens"] = goldenReport
  report["seekToFrameMs"] = stats(seekTimes)

  // MARK: Parameter-only updates, paused (OV10)
  do {
    watchdog.step("parameter-only update (overlay box)")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    let k = 40
    let (before, _) = try await rig.frame(at: k, fps: 30)
    let composition = rig.player.built?.composition
    let item = rig.player.player.currentItem
    // The logo sticker (white top-left patch at centre -35, -40) moves from (90, 120) to (90, 560).
    var moved = base
    edit(&moved, ["overlays", 0, "box", "y"], 560)
    let started = CFAbsoluteTimeGetCurrent()
    let applied = try await rig.apply(try decode(moved, revision: 1, buildSeq: next()))
    let after = await rig.newFrame(at: CMTime(value: CMTimeValue(k), timescale: 30))
    let refreshMs = (CFAbsoluteTimeGetCurrent() - started) * 1000
    var entry: [String: Any] = [
      "mode": applied.mode.rawValue, "applyMs": applied.milliseconds, "audioSwapped": applied.audioSwapped,
      "sameComposition": rig.player.built?.composition === composition, "sameItem": rig.player.player.currentItem === item,
      "pausedFrameRefreshed": after != nil, "refreshMs": refreshMs,
      "timeKept": abs(rig.player.currentTime - Double(k) / 30) < 1e-3,
      "beforeOld": linear(before, 55, 80), "beforeNew": linear(before, 55, 520),
    ]
    if let after { entry["afterOld"] = linear(after, 55, 80); entry["afterNew"] = linear(after, 55, 520) }
    report["paramUpdate"] = entry
    rig.player.teardown()
  }
  do {
    let rig = Rig()
    watchdog.step("parameter-only update (caption style)")
    let base = try fixture("caption-karaoke")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    let k = 40
    let (before, _) = try await rig.frame(at: k, fps: 30)
    let composition = rig.player.built?.composition
    // Unsung words turn red: the look changed, so the builder would give the caption a new rev.
    var restyled = base
    edit(&restyled, ["captions", 0, "color"], "#FF2020")
    edit(&restyled, ["captions", 0, "rev"], "restyled-1")
    let started = CFAbsoluteTimeGetCurrent()
    let applied = try await rig.apply(try decode(restyled, revision: 2, buildSeq: next()))
    let after = await rig.newFrame(at: CMTime(value: CMTimeValue(k), timescale: 30))
    let doing = (x: 208.0, y: 1592.0, w: 300.0, h: 50.0)
    var entry: [String: Any] = [
      "mode": applied.mode.rawValue, "sameComposition": rig.player.built?.composition === composition,
      "refreshMs": (CFAbsoluteTimeGetCurrent() - started) * 1000,
      "doingBefore": whiteAndRed(before, x: doing.x, y: doing.y, w: doing.w, h: doing.h),
    ]
    if let after { entry["doingAfter"] = whiteAndRed(after, x: doing.x, y: doing.y, w: doing.w, h: doing.h) }
    report["captionStyle"] = entry
    rig.player.teardown()
  }

  // MARK: A sticker added while paused, starting at the playhead
  do {
    watchdog.step("sticker added while paused")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    let k = 41
    let time = CMTime(value: CMTimeValue(k), timescale: 30)
    let (before, _) = try await rig.frame(at: k, fps: 30)
    let box = (x: 290.0, y: 590.0)
    /// Pixels in the new sticker's box that changed from the frame without it.
    func changed(_ frame: CVPixelBuffer?) -> Int {
      guard let frame else { return -1 }
      let a = pixels(before, space: workingSpace), b = pixels(frame, space: workingSpace)
      var count = 0
      for y in Int(box.y - 40)..<Int(box.y + 40) {
        for x in Int(box.x - 40)..<Int(box.x + 40) where zip(a.at(x, y), b.at(x, y)).contains(where: { abs($0 - $1) > 0.1 }) { count += 1 }
      }
      return count
    }
    func adding(start: Double, revision: Int) async throws -> [String: Any] {
      var plan = base
      var overlays = plan["overlays"] as! [[String: Any]]
      var sticker = overlays.first { $0["id"] as? String == "emoji-fire" }!
      sticker["id"] = "sticker-added-\(revision)"
      sticker["z"] = overlays.count
      sticker["start"] = start
      sticker["end"] = start + 3 > 4 ? 4 : start + 3
      var stickerBox = sticker["box"] as! [String: Any]
      stickerBox["x"] = box.x
      stickerBox["y"] = box.y
      sticker["box"] = stickerBox
      overlays.append(sticker)
      plan["overlays"] = overlays
      let landed = rig.seeksLanded
      let applied = try await rig.apply(try decode(plan, revision: revision, buildSeq: next()))
      try await rig.expect("the paused frame redrawn after the add") { rig.seeksLanded > landed }
      let frame = await rig.newFrame(at: time)
      // Back to the plan without it, for the next case.
      _ = try await rig.apply(try decode(base, revision: revision + 1, buildSeq: next()))
      _ = await rig.newFrame(at: time)
      return ["mode": applied.mode.rawValue, "changed": changed(frame), "timeKept": abs(rig.player.currentTime - Double(k) / 30) < 1e-3]
    }
    // At the frame on screen (the builder keeps 6 decimals): drawn on the paused frame at once.
    let onFrame = try await adding(start: (Double(k) / 30 * 1e6).rounded() / 1e6, revision: 2)
    // At the playhead rounded UP to the millisecond (what the editor stamped): [start, end) starts
    // on the next frame, so the paused frame rightly lacks it (the app now floors to the frame).
    let roundedUp = try await adding(start: (Double(k) / 30 * 1000).rounded() / 1000, revision: 4)
    let floored = try await adding(start: (Double(k) / 30 * 1000).rounded(.down) / 1000, revision: 6)
    report["stickerAdd"] = ["onFrame": onFrame, "roundedUp": roundedUp, "floored": floored, "errors": rig.errors] as [String: Any]
    rig.player.teardown()
  }

  // MARK: Structural update (a trimmed clip): rebuild, time kept
  do {
    watchdog.step("structural update")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    let k = 40
    _ = try await rig.frame(at: k, fps: 30)
    let composition = rig.player.built?.composition
    // The talk clip now starts half a second into its source: picture and sound.
    var trimmed = base
    edit(&trimmed, ["video", "segments", 0, "layers", 0, "srcStart"], 0.5)
    edit(&trimmed, ["audio", 0, "in"], 0.5)
    edit(&trimmed, ["audio", 0, "out"], 4.5)
    let landed = rig.seeksLanded
    let applied = try await rig.apply(try decode(trimmed, revision: 2, buildSeq: next()))
    try await rig.expect("rebuilt item seeked back") { rig.seeksLanded > landed }
    let frame = await rig.newFrame(at: CMTime(value: CMTimeValue(k), timescale: 30))
    var paused: [String: Any] = [
      "mode": applied.mode.rawValue, "newComposition": rig.player.built?.composition !== composition,
      "time": rig.player.currentTime, "expectedTime": Double(k) / 30, "applyMs": applied.milliseconds,
    ]
    if let frame { paused["code"] = decodeCode(pixels(frame, space: workingSpace)); paused["expectedCode"] = k + 15 }

    // Again while playing: the rebuilt item resumes from where the old one was.
    rig.player.seek(to: 0.2, exact: true)
    rig.player.play()
    try await rig.expect("playing past 0.6 s") { rig.player.player.rate > 0 && rig.player.currentTime > 0.6 }
    let timeBefore = rig.player.currentTime
    let wallBefore = CFAbsoluteTimeGetCurrent()
    let resumed = try await rig.apply(try decode(base, revision: 3, buildSeq: next()))
    try await rig.expect("playing again after the rebuild") { rig.player.player.rate > 0 }
    let resumeMs = (CFAbsoluteTimeGetCurrent() - wallBefore) * 1000
    let timeAfter = rig.player.currentTime
    // The clock moves again once the new item's decoders and audio have started.
    try await rig.expect("the clock moving after the rebuild") { rig.player.currentTime > timeAfter + 0.01 }
    let movingMs = (CFAbsoluteTimeGetCurrent() - wallBefore) * 1000
    let movingAt = rig.player.currentTime
    try? await Task.sleep(nanoseconds: 300_000_000)
    report["structural"] = [
      "paused": paused,
      "playing": [
        "mode": resumed.mode.rawValue, "timeBefore": timeBefore, "timeAfter": timeAfter, "resumeMs": resumeMs,
        "playingAfter": rig.player.player.rate > 0, "movingMs": movingMs, "advanced300ms": rig.player.currentTime - movingAt,
      ] as [String: Any],
    ]
    rig.player.pause()
    rig.player.teardown()
  }

  // MARK: Ordering: a stale (revision, buildSeq) is dropped; a new player starts fresh
  do {
    watchdog.step("ordering")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 5, buildSeq: 10))
    let appliedBefore = rig.applied.count
    let offered: [(Int, Int)] = [(5, 10), (5, 9), (4, 99), (5, 11), (6, 0)]
    var accepted: [Bool] = []
    for (revision, seq) in offered {
      let ok = rig.player.setPlan(try decode(base, revision: revision, buildSeq: seq), media: mediaRefs)
      accepted.append(ok)
      if ok { try await rig.expect("plan (\(revision), \(seq)) applied") { rig.applied.last.map { $0.revision == revision && $0.buildSeq == seq } ?? false } }
    }
    let fresh = Rig()
    let freshAccepts = fresh.player.setPlan(try decode(base, revision: 1, buildSeq: 1), media: mediaRefs)
    try await fresh.expect("a new player applied its first plan") { !fresh.applied.isEmpty }
    report["ordering"] = ["accepted": accepted, "appliedAfter": rig.applied.count - appliedBefore, "newPlayerAcceptsOlder": freshAccepts]
    rig.player.teardown()
    fresh.player.teardown()
  }

  // MARK: 60 Hz box updates for 2 s while playing
  do {
    watchdog.step("60 Hz drag while playing")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    rig.player.play()
    try await rig.expect("playing before the drag") { rig.player.player.rate > 0 && rig.player.currentTime > 0.05 }
    let output = rig.output!
    // The frame pacing this machine achieves right now with no updates (a loaded CI VM renders on
    // the CPU at a fraction of a Mac's rate): the drag's frames are held to it, not to a constant.
    // Half a second, which also lets playback settle; the drag and the audio edits after it still
    // end before the 4 s plan does.
    var baselineFrames = 0
    let baselineStart = CFAbsoluteTimeGetCurrent()
    while CFAbsoluteTimeGetCurrent() - baselineStart < 0.5 {
      let itemTime = output.itemTime(forHostTime: CACurrentMediaTime())
      if output.hasNewPixelBuffer(forItemTime: itemTime), output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) != nil {
        baselineFrames += 1
      }
      try? await Task.sleep(nanoseconds: 1_000_000)
    }
    let baselineWall = CFAbsoluteTimeGetCurrent() - baselineStart
    var frameWalls: [Double] = []
    let stallsBefore = rig.stalls
    let drawsBefore = rig.player.graphics.draws
    let appliedBefore = rig.applied.count
    let startWall = CFAbsoluteTimeGetCurrent()
    let startTime = rig.player.currentTime
    var decodeMs: [Double] = []
    var sent = 0
    var nextSend = startWall
    let tick = 1.0 / 60
    while CFAbsoluteTimeGetCurrent() - startWall < 2 {
      let now = CFAbsoluteTimeGetCurrent()
      if now >= nextSend {
        var plan = base
        // The logo sweeps across and back, rotating: a box-only change every tick.
        let phase = Double(sent) / 120
        edit(&plan, ["overlays", 0, "box", "x"], 60 + 240 * abs(sin(phase * .pi)))
        edit(&plan, ["overlays", 0, "box", "rotationDeg"], -30 + 60 * phase.truncatingRemainder(dividingBy: 1))
        let decodeStart = CFAbsoluteTimeGetCurrent()
        let decoded = try decode(plan, revision: 1, buildSeq: next())
        decodeMs.append((CFAbsoluteTimeGetCurrent() - decodeStart) * 1000)
        rig.player.setPlan(decoded, media: mediaRefs)
        sent += 1
        nextSend += tick
      }
      let itemTime = output.itemTime(forHostTime: CACurrentMediaTime())
      if output.hasNewPixelBuffer(forItemTime: itemTime), output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) != nil {
        frameWalls.append(CFAbsoluteTimeGetCurrent())
      }
      try? await Task.sleep(nanoseconds: 1_000_000)
    }
    let endWall = CFAbsoluteTimeGetCurrent()
    try await rig.expect("the last drag plan applied") { rig.applied.last?.buildSeq == buildSeq }
    let played = rig.player.currentTime - startTime
    let updates = rig.applied.dropFirst(appliedBefore)
    let intervals = zip(frameWalls, frameWalls.dropFirst()).map { ($1 - $0) * 1000 }
    report["drag60"] = [
      "sent": sent, "applied": updates.count, "modes": Array(Set(updates.map(\.mode.rawValue))).sorted(),
      "audioSwaps": updates.filter(\.audioSwapped).count,
      "latencyMs": stats(updates.map(\.milliseconds)), "decodeMs": stats(decodeMs),
      "stalls": rig.stalls - stallsBefore, "wallSeconds": endWall - startWall, "playedSeconds": played,
      // The emoji and callout stay put while the logo moves: their bitmaps come from the cache.
      "stickerRedraws": rig.player.graphics.draws - drawsBefore, "fps": 30,
      "frames": frameWalls.count, "frameIntervalMs": stats(intervals), "playingAfter": rig.player.player.rate > 0,
      "baselineFrames": baselineFrames, "baselineWallSeconds": baselineWall,
      "audio": tapContinuity(rig.tap, from: startWall + 0.05, to: endWall),
    ] as [String: Any]

    watchdog.step("audio edits while playing")
    // A burst of audio-parameter edits while playing (a gain slider): one mix swap, after the burst.
    let swapsBefore = rig.player.audioMixSwaps
    let swapWall = CFAbsoluteTimeGetCurrent()
    var burst: [PlanPlayer.Applied] = []
    for step in 1...5 {
      var quieter = base
      edit(&quieter, ["audio", 0, "gainKeys", 0, "gain"], 1 - 0.1 * Double(step))
      burst.append(try await rig.apply(try decode(quieter, revision: 2, buildSeq: next())))
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    let swapsDuringBurst = rig.player.audioMixSwaps - swapsBefore
    try await rig.expect("the deferred mix swap") { rig.player.audioMixSwaps > swapsBefore }
    let swapLandedMs = (CFAbsoluteTimeGetCurrent() - swapWall) * 1000
    try? await Task.sleep(nanoseconds: 500_000_000)
    report["audioSwap"] = [
      "modes": Array(Set(burst.map(\.mode.rawValue))).sorted(), "deferred": burst.filter(\.audioDeferred).count, "edits": burst.count,
      "swapsDuringBurst": swapsDuringBurst, "swaps": rig.player.audioMixSwaps - swapsBefore, "swapLandedMs": swapLandedMs,
      "playingAfter": rig.player.player.rate > 0,
      "audio": tapContinuity(rig.tap, from: swapWall - 0.2, to: CFAbsoluteTimeGetCurrent()),
    ] as [String: Any]
    rig.player.pause()
    rig.player.teardown()
  }

  // MARK: Lifecycle: background suspend, item failure retried once, parked, torn down mid-build
  do {
    watchdog.step("lifecycle")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    let k = 40
    let time = CMTime(value: CMTimeValue(k), timescale: 30)
    _ = try await rig.frame(at: k, fps: 30)
    // Backgrounded: a plan and a seek wait; nothing is composited until resume.
    rig.player.suspend()
    let appliedBefore = rig.applied.count
    var moved = base
    edit(&moved, ["overlays", 0, "box", "y"], 560)
    let accepted = rig.player.setPlan(try decode(moved, revision: 1, buildSeq: next()), media: mediaRefs)
    rig.player.seek(to: 0.5, exact: true)
    try? await Task.sleep(nanoseconds: 300_000_000)
    let appliedWhileSuspended = rig.applied.count - appliedBefore
    let framesWhileSuspended = rig.output?.hasNewPixelBuffer(forItemTime: time) ?? false
    rig.player.seek(to: Double(k) / 30, exact: true)
    rig.player.resume()
    try await rig.expect("the held plan applied after resume") { rig.applied.count > appliedBefore }
    let resumedFrame = await rig.newFrame(at: time)
    var suspend: [String: Any] = ["accepted": accepted, "appliedWhileSuspended": appliedWhileSuspended, "frameWhileSuspended": framesWhileSuspended,
                                  "appliedAfterResume": rig.applied.count - appliedBefore]
    if let resumedFrame { suspend["movedAfterResume"] = linear(resumedFrame, 55, 520) }

    watchdog.step("lifecycle: item failure")
    // An item failure (the GPU refused a render) rebuilds once at the same time; a second is reported.
    let itemBefore = rig.player.player.currentItem
    rig.player.simulateItemFailure()
    try await rig.expect("the failed item rebuilt and ready") { rig.player.player.currentItem?.status == .readyToPlay && rig.player.player.currentItem !== itemBefore }
    try await rig.expect("the rebuilt item back at its time") { abs(rig.player.currentTime - Double(k) / 30) < 1e-3 }
    let rebuiltItem = rig.player.player.currentItem !== itemBefore
    let errorsAfterFirst = rig.errors.count
    let timeAfterRetry = rig.player.currentTime
    rig.player.simulateItemFailure()
    try await rig.expect("the second failure reported") { rig.errors.count > errorsAfterFirst }
    let failure: [String: Any] = ["rebuilt": rebuiltItem, "errorsAfterFirst": errorsAfterFirst, "timeAfterRetry": timeAfterRetry,
                                  "errorsAfterSecond": rig.errors.count]

    watchdog.step("lifecycle: park")
    // Parked (the view left the window): no item, caches trimmed; back at the same time.
    let parkedTime = rig.player.currentTime
    rig.player.park()
    let parked: [String: Any] = ["item": rig.player.player.currentItem != nil, "stickerBitmaps": rig.player.graphics.count]
    rig.player.unpark()
    try await rig.expect("the unparked item ready") { rig.player.player.currentItem?.status == .readyToPlay }
    try await rig.expect("the unparked item back at its time") { abs(rig.player.currentTime - parkedTime) < 1e-3 }
    let unparked: [String: Any] = ["item": rig.player.player.currentItem != nil, "timeKept": abs(rig.player.currentTime - parkedTime) < 1e-3]

    watchdog.step("lifecycle: park in the background")
    // Backgrounded, then parked, then back in the window while still backgrounded (the export
    // screen popped with the app away): nothing is installed, applied or composited until resume.
    let backgroundTime = rig.player.currentTime
    rig.player.suspend()
    rig.player.park()
    let heldBefore = rig.applied.count
    var heldPlan = base
    edit(&heldPlan, ["overlays", 0, "box", "y"], 300)
    let heldAccepted = rig.player.setPlan(try decode(heldPlan, revision: 1, buildSeq: next()), media: mediaRefs)
    rig.player.unpark()
    try? await Task.sleep(nanoseconds: 300_000_000)
    let itemWhileBackgrounded = rig.player.player.currentItem != nil
    let appliedWhileBackgrounded = rig.applied.count - heldBefore
    rig.player.resume()
    try await rig.expect("the item back after resume") { rig.player.player.currentItem?.status == .readyToPlay }
    try await rig.expect("the held plan applied after resume") { rig.applied.count > heldBefore }
    try await rig.expect("back at its time after resume") { abs(rig.player.currentTime - backgroundTime) < 1e-3 }
    let backgroundPark: [String: Any] = [
      "accepted": heldAccepted, "itemWhileBackgrounded": itemWhileBackgrounded, "appliedWhileBackgrounded": appliedWhileBackgrounded,
      "item": rig.player.player.currentItem != nil, "timeKept": abs(rig.player.currentTime - backgroundTime) < 1e-3,
      "appliedAfterResume": rig.applied.count - heldBefore,
    ]
    report["lifecycle"] = [
      "suspend": suspend, "failure": failure, "parked": parked, "unparked": unparked, "backgroundPark": backgroundPark,
    ] as [String: Any]
    rig.player.teardown()

    watchdog.step("lifecycle: teardown")
    // Torn down while a plan's sources load: nothing is installed or reported.
    let gone = Rig()
    gone.player.setPlan(try decode(base, revision: 1, buildSeq: 1), media: mediaRefs)
    gone.player.teardown()
    try? await Task.sleep(nanoseconds: 300_000_000)
    var lifecycle = report["lifecycle"] as! [String: Any]
    lifecycle["teardown"] = ["applied": gone.applied.count, "item": gone.player.player.currentItem != nil]
    report["lifecycle"] = lifecycle
  }

  // MARK: Server copies: token refreshes, a stale token, an expired one
  do {
    watchdog.step("server copies: token refresh")
    let rig = Rig()
    let base = try fixture("overlays")
    let k = 40
    let talkAsset = { rig.player.built?.media.videos["asset-talk"].map { ObjectIdentifier($0.asset) } }
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()), media: serverCopy(token: "t1"))
    _ = try await rig.frame(at: k, fps: 30)
    // Paused: a token-only refresh rebuilds on the new URL at once (nothing is moving).
    var item = rig.player.player.currentItem
    var asset = talkAsset()
    let pausedRefresh = try await rig.apply(try decode(base, revision: 1, buildSeq: next()), media: serverCopy(token: "t2"))
    try await rig.expect("back at its time after the paused refresh") { abs(rig.player.currentTime - Double(k) / 30) < 1e-3 }
    let paused: [String: Any] = [
      "mode": pausedRefresh.mode.rawValue, "newItem": rig.player.player.currentItem !== item, "reloaded": talkAsset() != asset,
      "stale": rig.player.tokenStale.sorted(), "timeKept": abs(rig.player.currentTime - Double(k) / 30) < 1e-3,
    ]

    // Playing: the item and source stay (no clock freeze); the source is token-stale.
    rig.player.seek(to: 0, exact: true)
    rig.player.play()
    try await rig.expect("playing for the refresh") { rig.player.player.rate > 0 && rig.player.currentTime > 0.1 }
    item = rig.player.player.currentItem
    asset = talkAsset()
    let playingRefresh = try await rig.apply(try decode(base, revision: 1, buildSeq: next()), media: serverCopy(token: "t3"))
    let playing: [String: Any] = [
      "mode": playingRefresh.mode.rawValue, "sameItem": rig.player.player.currentItem === item, "sameSource": talkAsset() == asset,
      "stale": rig.player.tokenStale.sorted(), "playing": rig.player.player.rate > 0,
    ]

    watchdog.step("server copies: stale token fails")
    // The old token expires under the loaded source while playing: rebuilt on the URL already held, no JS round trip.
    rig.player.simulateItemFailure()
    try await rig.expect("rebuilt on the refreshed URL") { rig.player.player.currentItem !== item && rig.player.player.currentItem?.status == .readyToPlay }
    try await rig.expect("playing again after the stale rebuild") { rig.player.player.rate > 0 }
    let staleRetry: [String: Any] = [
      "rebuilt": rig.player.player.currentItem !== item, "reloaded": talkAsset() != asset, "stale": rig.player.tokenStale.sorted(),
      "expired": rig.expired.count, "errors": rig.errors.count,
    ]

    watchdog.step("server copies: swap at the pause")
    // Another refresh while playing, then a pause: the stale source moves to the new URL then.
    _ = try await rig.apply(try decode(base, revision: 1, buildSeq: next()), media: serverCopy(token: "t4"))
    let staleWhilePlaying = rig.player.tokenStale.sorted()
    item = rig.player.player.currentItem
    asset = talkAsset()
    rig.player.pause()
    try await rig.expect("rebuilt at the pause") { rig.player.player.currentItem !== item && rig.player.player.currentItem?.status == .readyToPlay }
    try await rig.expect("the pause swap settled") { rig.player.tokenStale.isEmpty }
    let pauseSwap: [String: Any] = [
      "staleWhilePlaying": staleWhilePlaying, "rebuilt": rig.player.player.currentItem !== item, "reloaded": talkAsset() != asset,
      "stale": rig.player.tokenStale.sorted(),
    ]

    watchdog.step("server copies: expired media")
    // No newer URL held: the player asks for media instead of retrying on the same URLs.
    rig.player.seek(to: Double(k) / 30, exact: true)
    try await rig.expect("parked at frame \(k) again") { abs(rig.player.currentTime - Double(k) / 30) < 1e-3 }
    item = rig.player.player.currentItem
    asset = talkAsset()
    let appliedBefore = rig.applied.count
    rig.player.simulateItemFailure()
    try await rig.expect("mediaExpired reported") { !rig.expired.isEmpty }
    try? await Task.sleep(nanoseconds: 200_000_000)
    let asked: [String: Any] = [
      "expired": rig.expired.count, "errors": rig.errors.count, "sameItem": rig.player.player.currentItem === item,
      "applied": rig.applied.count - appliedBefore, "state": "\(rig.player.remoteRetry)",
    ]
    // While JS refreshes the token, an edit from elsewhere lands (untagged, old URLs): it applies
    // as usual, and the player keeps waiting for the tagged retry.
    var trimmed = base
    edit(&trimmed, ["video", "segments", 0, "layers", 0, "srcStart"], 0.25)
    let interleaved = try await rig.apply(try decode(trimmed, revision: 2, buildSeq: next()), media: serverCopy(token: "t4"))
    rig.player.simulateItemFailure()
    try? await Task.sleep(nanoseconds: 200_000_000)
    let interleave: [String: Any] = [
      "mode": interleaved.mode.rawValue, "reloaded": talkAsset() != asset, "state": "\(rig.player.remoteRetry)",
      "expired": rig.expired.count, "errors": rig.errors.count,
    ]
    asset = talkAsset()
    // JS re-resolved (a fresh token) and tagged the plan: it rebuilds with the remote source reloaded.
    let retry = try await rig.apply(try decode(trimmed, revision: 2, buildSeq: next()), media: serverCopy(token: "t5"), mediaRetry: true)
    let retried: [String: Any] = ["mode": retry.mode.rawValue, "reloaded": talkAsset() != asset, "state": "\(rig.player.remoteRetry)"]
    // That fails too: an error (JS falls back to PreviewPlayer), and no second request for media.
    rig.player.simulateItemFailure()
    try await rig.expect("the failure after the retry reported") { !rig.errors.isEmpty }
    let fellBack: [String: Any] = ["expired": rig.expired.count, "errors": rig.errors.count]
    rig.player.teardown()

    watchdog.step("server copies: structural edit swaps a stale source")
    // A refresh while playing, then a structural edit: the rebuild it makes anyway moves the source.
    let fresh = Rig()
    try await fresh.apply(try decode(base, revision: 1, buildSeq: 1), media: serverCopy(token: "t4"))
    fresh.player.play()
    try await fresh.expect("playing for the structural edit") { fresh.player.player.rate > 0 }
    try await fresh.apply(try decode(base, revision: 1, buildSeq: 2), media: serverCopy(token: "t5"))
    let freshAsset = fresh.player.built?.media.videos["asset-talk"].map { ObjectIdentifier($0.asset) }
    let staleBefore = fresh.player.tokenStale.sorted()
    let structural = try await fresh.apply(try decode(trimmed, revision: 2, buildSeq: 3), media: serverCopy(token: "t5"))
    let structuralSwap: [String: Any] = [
      "staleBefore": staleBefore, "mode": structural.mode.rawValue,
      "reloaded": fresh.player.built?.media.videos["asset-talk"].map { ObjectIdentifier($0.asset) } != freshAsset,
      "staleAfter": fresh.player.tokenStale.sorted(),
    ]
    fresh.player.teardown()

    watchdog.step("server copies: a source that fails to load")
    // A server copy whose URL expired before it loaded: the same request for media, not an error.
    let load = Rig()
    try await load.apply(try decode(base, revision: 1, buildSeq: 1))
    let failedLoad = load.applied.count
    load.player.setPlan(try decode(base, revision: 1, buildSeq: 2), media: serverCopy(token: "expired"))
    try await load.expect("the failed load reported") { load.applied.count > failedLoad }
    try await load.expect("mediaExpired for the failed load") { !load.expired.isEmpty }
    let loadFailure: [String: Any] = [
      "mode": load.applied.last!.mode.rawValue, "expired": load.expired.count, "errors": load.errors.count,
      "state": "\(load.player.remoteRetry)",
    ]
    let loadRetry = try await load.apply(try decode(base, revision: 1, buildSeq: 3), media: serverCopy(token: "t6"), mediaRetry: true)
    let loadRetried: [String: Any] = ["mode": loadRetry.mode.rawValue, "state": "\(load.player.remoteRetry)", "errors": load.errors.count]
    load.player.teardown()

    watchdog.step("server copies: the retry fails during a reconnect")
    // The tagged retry lands while a reconnect is due and fails too: the reconnects run out on the
    // dead URL, and that failure is reported. (The retry is spent: the player must not go on
    // waiting for fresh media, ignoring every failure after it.)
    let spent = Rig()
    spent.player.reconnectDelays = [0, 0.05]
    try await spent.apply(try decode(base, revision: 1, buildSeq: 1), media: serverCopy(token: "t7"))
    spent.player.simulateItemFailure()
    try await spent.expect("mediaExpired for the failure") { !spent.expired.isEmpty }
    let awaitingBefore = "\(spent.player.remoteRetry)"
    spent.player.simulateReconnectDue()
    let appliedBeforeRetry = spent.applied.count
    spent.player.setPlan(try decode(base, revision: 1, buildSeq: 2), media: serverCopy(token: "expired"), mediaRetry: true)
    try await spent.expect("the retry failed") { spent.applied.dropFirst(appliedBeforeRetry).contains { $0.mode == .failed } }
    let stateAfterRetry = "\(spent.player.remoteRetry)"
    let reportedAfterReconnects = await spent.until(5) { !spent.errors.isEmpty }
    let retryDuringReconnect: [String: Any] = [
      "before": awaitingBefore, "after": stateAfterRetry, "reported": reportedAfterReconnects,
      "expired": spent.expired.count, "errors": spent.errors.count, "reconnects": spent.player.reconnectCount,
    ]
    spent.player.teardown()

    report["serverCopies"] = [
      "paused": paused, "playing": playing, "staleRetry": staleRetry, "pauseSwap": pauseSwap, "asked": asked,
      "interleave": interleave, "retried": retried, "fellBack": fellBack, "structuralSwap": structuralSwap,
      "loadFailure": loadFailure, "loadRetried": loadRetried, "retryDuringReconnect": retryDuringReconnect,
    ] as [String: Any]
  }

  // MARK: A real HTTP server: media tokens that expire mid-play
  do {
    watchdog.step("http: token expires mid-play")
    let server = try MediaServer()
    let port = try server.start()
    let path = "/assets/asset-talk/proxy.mov"
    server.serve(path, file: URL(string: mediaRefs["asset-talk"]!)!)
    func refs(_ token: String) -> [String: String] {
      var refs = mediaRefs
      refs["asset-talk"] = "http://127.0.0.1:\(port)\(path)?k=\(token)"
      return refs
    }
    let base = try fixture("overlays")

    // No newer URL held: the player asks for media before the server starts refusing reads
    // (tokens live 5 s: long enough for a slow CI VM to load and start playing first),
    // and plays on from the fresh URL JS sends.
    let rig = Rig()
    rig.player.expiryLead = 1
    try await rig.apply(try decode(base, revision: 1, buildSeq: 1), media: refs(server.token(expiresIn: 5)))
    _ = try await rig.frame(at: 0, fps: 30)
    let started = CFAbsoluteTimeGetCurrent()
    rig.player.play()
    let reported = await rig.until(10) { !rig.expired.isEmpty || !rig.errors.isEmpty }
    var expiring: [String: Any] = [
      "reported": reported, "reportMs": (CFAbsoluteTimeGetCurrent() - started) * 1000, "expired": rig.expired.count, "errors": rig.errors.count,
    ]
    let retry = try await rig.apply(try decode(base, revision: 1, buildSeq: 2), media: refs(server.token(expiresIn: 600)), mediaRetry: true)
    expiring["retryMode"] = retry.mode.rawValue
    expiring["code"] = try await serverCode(rig, at: 60)
    expiring["errorsAfter"] = rig.errors.count
    expiring["refused"] = server.refused
    rig.player.teardown()

    watchdog.step("http: refreshed token while playing")
    // JS refreshed the token while playing (token-stale source): before the old token expires the
    // item moves to the URL already held, with no request for media and no read refused.
    let refusedBefore = server.refused
    let stale = Rig()
    stale.player.expiryLead = 1
    try await stale.apply(try decode(base, revision: 1, buildSeq: 1), media: refs(server.token(expiresIn: 5)))
    _ = try await stale.frame(at: 0, fps: 30)
    stale.player.play()
    try await stale.expect("playing on the short token") { stale.player.player.rate > 0 }
    let item = stale.player.player.currentItem
    let refreshed = try await stale.apply(try decode(base, revision: 1, buildSeq: 2), media: refs(server.token(expiresIn: 600)))
    let staleWhilePlaying = stale.player.tokenStale.sorted()
    let moved = await stale.until(10) { stale.player.player.currentItem !== item && stale.player.tokenStale.isEmpty }
    try await stale.expect("playing on the refreshed URL") { stale.player.player.rate > 0 || stale.ends > 0 }
    let staleSwap: [String: Any] = [
      "mode": refreshed.mode.rawValue, "staleWhilePlaying": staleWhilePlaying, "moved": moved,
      "expired": stale.expired.count, "errors": stale.errors.count, "refused": server.refused - refusedBefore,
      "code": try await serverCode(stale, at: 75),
    ]
    stale.player.teardown()

    report["http"] = ["expiring": expiring, "staleSwap": staleSwap] as [String: Any]
    server.stop()
  }

  // MARK: A paused exact seek into remote bytes still on their way
  do {
    watchdog.step("http: paused seek ahead of the bytes")
    // Slower than the clip's bitrate: the bytes for the frame sought arrive seconds after the seek.
    let server = try MediaServer(bytesPerSecond: 16 << 10)
    let port = try server.start()
    let path = "/assets/asset-talk/proxy.mov"
    server.serve(path, file: URL(string: mediaRefs["asset-talk"]!)!)
    var refs = mediaRefs
    refs["asset-talk"] = "http://127.0.0.1:\(port)\(path)?k=\(server.token(expiresIn: 600))"
    let rig = Rig()
    try await rig.apply(try decode(try fixture("overlays"), revision: 1, buildSeq: 1), media: refs)
    let k = 100
    let target = CMTime(value: CMTimeValue(k), timescale: 30)
    let landed = rig.seeksLanded
    let started = CFAbsoluteTimeGetCurrent()
    rig.player.seek(to: target.seconds, exact: true)
    try await rig.expect("the paused seek landed") { rig.seeksLanded > landed }
    var samples: [String] = []
    var rightAt: Double?
    var lastSample = 0.0
    _ = await rig.until(12) {
      let now = CFAbsoluteTimeGetCurrent() - started
      guard now - lastSample > 0.25, let output = rig.output else { return false }
      lastSample = now
      guard let buffer = output.copyPixelBuffer(forItemTime: target, itemTimeForDisplay: nil) else { return false }
      let shown = decodeCode(pixels(buffer, space: workingSpace))
      samples.append(String(format: "%.2f %d", now, shown))
      if shown == k, rightAt == nil { rightAt = now }
      return rightAt != nil
    }
    report["pausedSeekAhead"] = [
      "rightWithinMs": rightAt.map { $0 * 1000 } ?? -1, "samples": samples, "seeksLanded": rig.seeksLanded - landed,
      "time": rig.player.currentTime,
    ] as [String: Any]
    rig.player.teardown()
    server.stop()
  }

  // MARK: The paused-seek verify re-seeks only a remote frame not drawn yet
  do {
    watchdog.step("paused seek verify")
    // asset-b plays from a "server copy", asset-a from a local file (crossfade: a alone to 2 s,
    // the crossfade to 2.5 s, b alone after). Seeking paused to a frame already on screen asks
    // the compositor for nothing, so the verify must not read that as a frame not drawn.
    var refs = mediaRefs
    refs["asset-b"] = "https://media.test/asset-b/proxy.mov?k=t1"
    let rig = Rig()
    let plan = try fixture("crossfade")
    try await rig.apply(try decode(plan, revision: 1, buildSeq: 1), media: refs)
    func repeatSeek(_ k: Int) async throws -> [String: Any] {
      _ = try await rig.frame(at: k, fps: 30)
      try? await Task.sleep(nanoseconds: 300_000_000)
      let landed = rig.seeksLanded
      rig.player.seek(to: Double(k) / 30, exact: true)
      try await rig.expect("the repeat seek to frame \(k) landed") { rig.seeksLanded > landed }
      // Past three verify delays: every re-seek the verify would make has landed by then.
      try? await Task.sleep(nanoseconds: UInt64((PlanPlayer.verifyDelay * 3 + 0.8) * 1e9))
      let reseeks = rig.seeksLanded - landed - 1
      let time = rig.player.currentTime
      // And the player still draws the right frame there (a fresh exact seek, after the count).
      let shown = decodeCode(pixels(try await rig.frame(at: k, fps: 30).buffer, space: workingSpace))
      return ["reseeks": reseeks, "time": time, "shown": shown]
    }
    let decoded = try decode(plan, revision: 1, buildSeq: 1)
    report["pausedSeekVerify"] = [
      "local": try await repeatSeek(15), "remote": try await repeatSeek(100),
      // Which frames the verify watches at all: a (local) alone, the crossfade into b, b (remote) alone.
      "remoteDraws": [0.5, 2.2, 3.3, 4.0].map { PlanPlayer.remoteSourceDraws(at: $0, in: decoded, refs: refs) },
      "remoteDrawsAllLocal": PlanPlayer.remoteSourceDraws(at: 3.3, in: decoded, refs: mediaRefs),
    ] as [String: Any]
    rig.player.teardown()
  }

  // MARK: A remote clip whose picture ends before its sound, played at a quarter speed
  do {
    watchdog.step("http: short video track at 0.25x")
    // asset-talk cut to 0.85 s of picture and 1.2 s of sound: the plan plays 1 s of it over 4 s,
    // so the last 0.6 s of the timeline is past the picture (the builder holds its last frame).
    let talk = AVURLAsset(url: URL(string: mediaRefs["asset-talk"]!)!)
    let composition = AVMutableComposition()
    let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try video.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: 85, timescale: 100)), of: try await talk.loadTracks(withMediaType: .video).first!, at: .zero)
    let sound = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try sound.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: 120, timescale: 100)), of: try await talk.loadTracks(withMediaType: .audio).first!, at: .zero)
    let short = work.appendingPathComponent("asset-short.mov")
    try? FileManager.default.removeItem(at: short)
    guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else { throw HarnessError("no passthrough export") }
    try await export.export(to: short, as: .mov)
    let shortAsset = AVURLAsset(url: short)
    let pictureEnd = try await shortAsset.loadTracks(withMediaType: .video).first!.load(.timeRange).end.seconds
    let soundEnd = try await shortAsset.loadTracks(withMediaType: .audio).first!.load(.timeRange).end.seconds

    let server = try MediaServer()
    let port = try server.start()
    server.serve("/assets/asset-short/proxy.mov", file: short)
    var refs = mediaRefs
    refs["asset-short"] = "http://127.0.0.1:\(port)/assets/asset-short/proxy.mov?k=\(server.token(expiresIn: 600))"
    var plan = try fixture("overlays")
    edit(&plan, ["video", "segments", 0, "layers", 0, "assetRef", "id"], "asset-short")
    edit(&plan, ["video", "segments", 0, "layers", 0, "speed"], 0.25)
    edit(&plan, ["audio"], [] as [Any])
    let rig = Rig()
    try await rig.apply(try decode(plan, revision: 1, buildSeq: 1), media: refs)
    _ = try await rig.frame(at: 0, fps: 30)
    rig.player.play()
    let ended = await rig.until(12) { rig.ends > 0 }
    report["shortPicture"] = [
      "pictureEnd": pictureEnd, "soundEnd": soundEnd, "ended": ended, "reconnects": rig.player.reconnectCount,
      "expired": rig.expired.count, "errors": rig.errors.count,
    ] as [String: Any]
    rig.player.teardown()
    server.stop()
  }

  // MARK: A transient error-log entry AVFoundation recovers from by itself
  do {
    watchdog.step("transient error-log entry")
    let rig = Rig()
    try await rig.apply(try decode(try fixture("overlays"), revision: 1, buildSeq: 1), media: serverCopy(token: "t1"))
    _ = try await rig.frame(at: 20, fps: 30)
    // Paused: nothing at all.
    let item = rig.player.player.currentItem
    rig.player.simulateErrorLog(.transient)
    try? await Task.sleep(nanoseconds: 700_000_000)
    let paused: [String: Any] = ["sameItem": rig.player.player.currentItem === item, "reconnects": rig.player.reconnectCount, "stalls": rig.stalls]
    // Playing with frames still flowing: buffering shows, then clears; no reconnect.
    rig.player.play()
    try await rig.expect("playing") { rig.player.player.rate > 0 && rig.player.currentTime > 0.8 }
    let stallsBefore = rig.stalls
    rig.player.simulateErrorLog(.transient)
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    let playing: [String: Any] = [
      "sameItem": rig.player.player.currentItem === item, "reconnects": rig.player.reconnectCount,
      "buffered": rig.stalls > stallsBefore, "playing": rig.player.player.rate > 0 || rig.ends > 0,
    ]
    report["transientLog"] = ["paused": paused, "playing": playing] as [String: Any]
    rig.player.teardown()
  }

  // MARK: A server whose clock runs 20 s ahead (a phone's clock 20 s behind)
  do {
    watchdog.step("http: skewed clock")
    let server = try MediaServer(clockShift: 20)
    let port = try server.start()
    let path = "/assets/asset-talk/proxy.mov"
    server.serve(path, file: URL(string: mediaRefs["asset-talk"]!)!)
    let base = try fixture("overlays")
    func refs(_ token: String) -> [String: String] {
      var refs = mediaRefs
      refs["asset-talk"] = "http://127.0.0.1:\(port)\(path)?k=\(token)"
      return refs
    }
    /// Plays a token that dies 2.5 s from now (by the server's clock) for up to 4 s. Refusals are
    /// counted from the start of playback: on a loaded runner, loading and the first frame can
    /// take most of the token's life, and a read refused then says nothing about the deadline.
    func play(offset: Double?) async throws -> [String: Any] {
      let rig = Rig()
      rig.player.expiryLead = 1
      try await rig.apply(try decode(base, revision: 1, buildSeq: 1), media: refs(server.token(expiresIn: 2.5)), tokenClockOffset: offset)
      _ = try await rig.frame(at: 0, fps: 30)
      let refusedBefore = server.refused
      rig.player.play()
      let reported = await rig.until(4) { !rig.expired.isEmpty || !rig.errors.isEmpty }
      // A refusal still in flight is counted once its request lands.
      try? await Task.sleep(nanoseconds: 300_000_000)
      defer { rig.player.teardown() }
      return ["reported": reported, "expired": rig.expired.count, "refusedBeforeReport": server.refused - refusedBefore]
    }
    // Without the offset the deadline is 20 s late: reads are refused first (the silent-drop
    // watch then catches them). With it (JS measured the device 20 s behind) none is.
    let withoutOffset = try await play(offset: nil)
    let withOffset = try await play(offset: -20)
    report["skew"] = ["withoutOffset": withoutOffset, "withOffset": withOffset] as [String: Any]
    server.stop()
  }

  // MARK: Silent drops: the server cuts every transfer and answers 500, then comes back
  do {
    watchdog.step("http: silent drop")
    // Just above the clip's bitrate (~24 KB/s), so little is buffered ahead when the drop comes.
    let server = try MediaServer(bytesPerSecond: 28 << 10)
    let port = try server.start()
    let path = "/assets/asset-talk/proxy.mov"
    server.serve(path, file: URL(string: mediaRefs["asset-talk"]!)!)
    let base = try fixture("overlays")
    func refs(_ token: String) -> [String: String] {
      var refs = mediaRefs
      refs["asset-talk"] = "http://127.0.0.1:\(port)\(path)?k=\(token)"
      return refs
    }
    let token = server.token(expiresIn: 600)

    // Back within the reconnect attempts: recovered natively, nothing asked of JS.
    let rig = Rig()
    try await rig.apply(try decode(base, revision: 1, buildSeq: 1), media: refs(token))
    _ = try await rig.frame(at: 0, fps: 30)
    rig.player.play()
    try await rig.expect("playing before the drop") { rig.player.player.rate > 0 && rig.player.currentTime > 0.2 }
    let stallsBefore = rig.stalls
    server.setFailing(true)
    let cut = CFAbsoluteTimeGetCurrent()
    var starvedAt: Double?
    let detected = await rig.until(8) {
      if starvedAt == nil, rig.stalls > stallsBefore { starvedAt = CFAbsoluteTimeGetCurrent() }
      return rig.player.reconnectCount > 0
    }
    let detectedAt = CFAbsoluteTimeGetCurrent()
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    server.setFailing(false)
    let recovered = await rig.until(15) { rig.player.player.rate > 0 && rig.player.currentTime > 3 || rig.ends > 0 }
    var drop: [String: Any] = [
      "detected": detected, "cutToDetectMs": (detectedAt - cut) * 1000,
      "starveToDetectMs": starvedAt.map { (detectedAt - $0) * 1000 } ?? -1, "buffering": rig.stalls > stallsBefore,
      "reconnects": rig.player.reconnectCount, "failedRequests": server.failed, "recovered": recovered,
      "expired": rig.expired.count, "errors": rig.errors.count,
    ]
    drop["code"] = try await serverCode(rig, at: 100)
    rig.player.teardown()

    watchdog.step("http: silent drop, server stays down")
    // Down through every attempt: the failure policy (mediaExpired); back for the tagged retry.
    let down = Rig()
    down.player.reconnectDelays = [0, 0.2, 0.2]
    try await down.apply(try decode(base, revision: 1, buildSeq: 1), media: refs(token))
    _ = try await down.frame(at: 0, fps: 30)
    down.player.play()
    try await down.expect("playing before the outage") { down.player.player.rate > 0 && down.player.currentTime > 0.2 }
    // Counted from the outage on: the throttled stream can starve once before it on a loaded runner.
    let reconnectsBefore = down.player.reconnectCount
    server.setFailing(true)
    let asked = await down.until(10) { !down.expired.isEmpty || !down.errors.isEmpty }
    var outage: [String: Any] = [
      "asked": asked, "expired": down.expired.count, "errors": down.errors.count, "reconnects": down.player.reconnectCount - reconnectsBefore,
    ]
    server.setFailing(false)
    let retry = try await down.apply(try decode(base, revision: 1, buildSeq: 2), media: refs(server.token(expiresIn: 600)), mediaRetry: true)
    outage["retryMode"] = retry.mode.rawValue
    outage["code"] = try await serverCode(down, at: 100)
    outage["errorsAfter"] = down.errors.count
    down.player.teardown()
    report["silentDrop"] = ["backSoon": drop, "staysDown": outage] as [String: Any]

    // The error-log matcher on entries as CoreMedia and CFNetwork write them.
    let samples: [(Int, String, String?)] = [
      (401, "NSURLErrorDomain", nil), (403, "CoreMediaErrorDomain", nil),
      (-12660, "CoreMediaErrorDomain", "HTTP 403: Forbidden"), (-12938, "CoreMediaErrorDomain", "HTTP 401: Unauthorized"),
      (-12938, "CoreMediaErrorDomain", "HTTP 404: File Not Found"), (-12938, "CoreMediaErrorDomain", "HTTP 4013"),
      (-12660, "CoreMediaErrorDomain", "HTTP 503: Service Unavailable"), (500, "CoreMediaErrorDomain", nil),
      (NSURLErrorNotConnectedToInternet, NSURLErrorDomain, "The Internet connection appears to be offline."),
      (NSURLErrorNetworkConnectionLost, NSURLErrorDomain, nil), (-12645, "CoreMediaErrorDomain", "No matching mediaFile found"),
    ]
    report["errorLogKinds"] = samples.map { PlanPlayer.classifyErrorLog(status: $0.0, domain: $0.1, comment: $0.2).rawValue }
    server.stop()
  }

  // MARK: Preview files: downloads cancelled around their start, stills after teardown
  do {
    watchdog.step("preview files")
    let dir = work.appendingPathComponent("preview-files", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    // Cancelled before, at and just after the start (port 9 refuses at once): every run ends,
    // none creates a task on an invalidated session (that raises and kills the process).
    let unreachable = URL(string: "http://127.0.0.1:9/still.png")!
    var cancelled = 0, failed = 0, succeeded = 0
    for index in 0..<300 {
      let target = dir.appendingPathComponent("race-\(index).png")
      let task = Task.detached { try await CappedDownload.run(unreachable, to: target, cap: 1 << 20, timeout: 5) }
      if index % 3 == 1 { await Task.yield() }
      if index % 3 == 2 { try? await Task.sleep(nanoseconds: 100_000) }
      task.cancel()
      switch await task.result {
      case .success: succeeded += 1
      case .failure(let error): if error is CancellationError || (error as? URLError)?.code == .cancelled { cancelled += 1 } else { failed += 1 }
      }
    }
    let temps = PreviewTempFiles()
    let kept = dir.appendingPathComponent("kept.png")
    let late = dir.appendingPathComponent("late.png")
    FileManager.default.createFile(atPath: kept.path, contents: Data([1]))
    try temps.add(kept)
    temps.removeAll()
    // A download that finishes after teardown hands its still over: it is deleted, and the add throws.
    FileManager.default.createFile(atPath: late.path, contents: Data([1]))
    var lateThrew = false
    do { try temps.add(late) } catch { lateThrew = true }
    report["previewFiles"] = [
      "runs": 300, "ended": cancelled + failed + succeeded, "cancelled": cancelled,
      "keptDeleted": !FileManager.default.fileExists(atPath: kept.path),
      "lateDeleted": !FileManager.default.fileExists(atPath: late.path), "lateThrew": lateThrew, "held": temps.count,
    ] as [String: Any]
  }

  // MARK: 60 Hz box updates for 1 s while paused: the frame keeps redrawing (OV10)
  do {
    watchdog.step("60 Hz drag while paused")
    let rig = Rig()
    let base = try fixture("overlays")
    try await rig.apply(try decode(base, revision: 1, buildSeq: next()))
    let k = 40
    let time = CMTime(value: CMTimeValue(k), timescale: 30)
    _ = try await rig.frame(at: k, fps: 30)
    let output = rig.output!
    let appliedBefore = rig.applied.count
    var refreshed: [Double] = []
    var sent = 0
    let startWall = CFAbsoluteTimeGetCurrent()
    var nextSend = startWall
    var lastY = 120.0
    var latest: CVPixelBuffer?
    while CFAbsoluteTimeGetCurrent() - startWall < 1 {
      if CFAbsoluteTimeGetCurrent() >= nextSend {
        var plan = base
        lastY = 120 + Double(sent) * 7
        edit(&plan, ["overlays", 0, "box", "y"], lastY)
        rig.player.setPlan(try decode(plan, revision: 1, buildSeq: next()), media: mediaRefs)
        sent += 1
        nextSend += 1.0 / 60
      }
      if output.hasNewPixelBuffer(forItemTime: time), let buffer = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) {
        refreshed.append(CFAbsoluteTimeGetCurrent())
        latest = buffer
      }
      try? await Task.sleep(nanoseconds: 1_000_000)
    }
    try await rig.expect("the last paused drag plan applied") { rig.applied.last?.buildSeq == buildSeq }
    // The last coalesced update is drawn eventually, with no settling plan: the newest frame vended
    // (in the loop or after it, within a lenient 5 s for a slow VM) shows the last box.
    let lastBox = { (frame: CVPixelBuffer?) in frame.map { linear($0, 55, lastY - 40).min()! > 0.95 } ?? false }
    let drawnBy = CFAbsoluteTimeGetCurrent()
    let lastDrawn = await rig.until(5) {
      if output.hasNewPixelBuffer(forItemTime: time), let buffer = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) { latest = buffer }
      return lastBox(latest)
    }
    let final = latest
    let intervals = zip(refreshed, refreshed.dropFirst()).map { ($1 - $0) * 1000 }
    var entry: [String: Any] = [
      "sent": sent, "applied": rig.applied.count - appliedBefore, "refreshedFrames": refreshed.count,
      "refreshIntervalMs": stats(intervals), "lastY": lastY, "stillAtTime": abs(rig.player.currentTime - Double(k) / 30) < 1e-3,
      "lastDrawn": lastDrawn, "lastDrawnAfterMs": (CFAbsoluteTimeGetCurrent() - drawnBy) * 1000,
    ]
    // The logo's white patch (centre -35, -40) at the last box sent.
    if let final { entry["finalAtLast"] = linear(final, 55, lastY - 40) }
    report["pausedDrag60"] = entry
    rig.player.teardown()
  }

  // MARK: A proxy replaced by its original: only that asset reloads
  do {
    watchdog.step("proxy replaced by its original")
    let rig = Rig()
    let plan = try fixture("overlays")
    var proxied = mediaRefs
    proxied["asset-talk"] = proxyURL.absoluteString
    let first = try await rig.apply(try decode(plan, revision: 1, buildSeq: next()), media: proxied)
    let (proxyFrame, _) = try await rig.frame(at: 40, fps: 30)
    let before = rig.player.built!.media
    let second = try await rig.apply(try decode(plan, revision: 1, buildSeq: next()), media: mediaRefs)
    let after = rig.player.built!.media
    let (originalFrame, _) = try await rig.frame(at: 40, fps: 30)
    report["proxySwap"] = [
      "first": first.mode.rawValue, "second": second.mode.rawValue,
      "proxySize": [CVPixelBufferGetWidth(proxyFrame), CVPixelBufferGetHeight(proxyFrame)],
      "proxyCode": decodeCode(pixels(proxyFrame, space: workingSpace)),
      "reloaded": after.videos["asset-talk"]?.asset !== before.videos["asset-talk"]?.asset,
      "othersKept": after.videos["asset-city"]?.asset === before.videos["asset-city"]?.asset
        && after.images["asset-logo"] == before.images["asset-logo"] && after.images["asset-gif"] == before.images["asset-gif"],
      "originalCompare": try comparePNG(originalFrame, plan: try decode(plan, revision: 0, buildSeq: 0), file: "overlays-040.png", downscale: 1),
    ] as [String: Any]
    rig.player.teardown()
  }

  // MARK: The render cap: a 4K plan previews at no more than 1080 x 1920
  do {
    watchdog.step("render cap")
    let rig = Rig()
    var big = try fixture("overlays")
    edit(&big, ["size"], ["w": 2160, "h": 3840])
    let plan = try decode(big, revision: 1, buildSeq: next())
    let scale = rig.player.renderScale(for: plan)
    rig.player.viewPixels = CGSize(width: 390 * 3, height: 693 * 3)
    report["renderCap"] = ["scale4k": scale, "scale4kInView": rig.player.renderScale(for: plan)]
    rig.player.teardown()
  }
  report["audioDevice"] = audioDevice
  report["steps"] = watchdog.finish()
  return report
}

// The main RunLoop runs the whole time (it also drains the main queue, where the main
// actor's jobs run); the task ends the process.
Task { @MainActor in
  do {
    let report = try await run()
    let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(json)
    exit(0)
  } catch {
    Watchdog.log("FAILED: \(error)")
    exit(1)
  }
}
RunLoop.main.run()
