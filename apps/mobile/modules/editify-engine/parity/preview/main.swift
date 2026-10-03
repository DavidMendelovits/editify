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
//    trims caches, unpark restores the time; teardown mid-build installs nothing.
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
  switch media.kind {
  case "video":
    let url = work.appendingPathComponent("\(id).mov")
    mediaReport[id] = ["codec": try writeVideo(media, to: url)]
    mediaRefs[id] = url.absoluteString
  case "audio":
    let url = work.appendingPathComponent("\(id).m4a")
    try writeAudio(media, to: url)
    mediaRefs[id] = url.absoluteString
  case "png":
    let url = work.appendingPathComponent("\(id).png")
    try writeLogo(media, to: url)
    mediaRefs[id] = url.absoluteString
  case "gif":
    let url = work.appendingPathComponent("\(id).gif")
    try writeGif(media, to: url)
    mediaRefs[id] = url.absoluteString
  default:
    throw HarnessError("unknown media kind \(media.kind)")
  }
}
// The "proxy": asset-talk's pattern at half size, as the 1080p proxy of a 4K original would be.
var proxySpec = rawMedia["asset-talk"] as! [String: Any]
proxySpec["w"] = (proxySpec["w"] as! Int) / 2
proxySpec["h"] = (proxySpec["h"] as! Int) / 2
let proxyMedia = try JSONDecoder().decode(Manifest.Media.self, from: JSONSerialization.data(withJSONObject: proxySpec))
let proxyURL = work.appendingPathComponent("asset-talk-proxy.mov")
_ = try writeVideo(proxyMedia, to: proxyURL)

/// What the module does with the media map: ids resolve only within it (here, the synthesized files).
func resolver(_ refs: [String: String]) -> PlanAssetResolver {
  PlanAssetResolver(
    asset: { ref in
      guard ref.kind != .image, let value = refs[ref.id], let url = URL(string: value) else { throw HarnessError("no \(ref.kind.rawValue) asset \(ref.id)") }
      return AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    },
    imageFile: { ref in
      guard ref.kind == .image, let value = refs[ref.id], let url = URL(string: value) else { throw HarnessError("no image asset \(ref.id)") }
      return url
    })
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
  var readies = 0
  let tap = TapLog()

  init() {
    player = PlanPlayer(fonts: fonts, resolver: resolver)
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
  func apply(_ plan: RenderPlan, media: [String: String]? = nil) async throws -> PlanPlayer.Applied {
    let before = applied.count
    guard player.setPlan(plan, media: media ?? mediaRefs) else { throw HarnessError("plan (\(plan.revision), \(plan.buildSeq)) dropped") }
    try await expect("plan (\(plan.revision), \(plan.buildSeq)) applied") { applied.count > before }
    let result = applied.last!
    if result.mode == .failed { throw HarnessError("plan failed: \(result.error ?? "?")") }
    try await expect("item readyToPlay (errors: \(errors))") { player.player.currentItem?.status == .readyToPlay }
    return result
  }

  /// An exact seek, then the frame the output gets for it.
  func frame(at k: Int, fps: Int) async throws -> (buffer: CVPixelBuffer, ms: Double) {
    let time = CMTime(value: CMTimeValue(k), timescale: CMTimeScale(fps))
    let started = CFAbsoluteTimeGetCurrent()
    let landed = seeksLanded
    player.seek(to: time.seconds, exact: true)
    try await expect("seek to frame \(k) landed") { seeksLanded > landed }
    guard let buffer = await newFrame(at: time) else { throw HarnessError("timed out: the video output vended no frame at \(k)") }
    return (buffer, (CFAbsoluteTimeGetCurrent() - started) * 1000)
  }

  func newFrame(at time: CMTime, timeout: Double = 15) async -> CVPixelBuffer? {
    guard let output else { return nil }
    var found: CVPixelBuffer?
    _ = await until(timeout) {
      guard output.hasNewPixelBuffer(forItemTime: time) else { return false }
      var shown = CMTime.zero
      found = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: &shown)
      return found != nil
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

@MainActor
func run() async throws -> [String: Any] {
  var report: [String: Any] = ["media": mediaReport]
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
    rig.player.seek(to: 0.2, exact: true)
    rig.player.play()
    try await rig.expect("playing before the drag") { rig.player.player.rate > 0 && rig.player.currentTime > 0.25 }
    try? await Task.sleep(nanoseconds: 200_000_000)
    let output = rig.output!
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
    report["lifecycle"] = [
      "suspend": suspend, "failure": failure, "parked": parked,
      "unparked": ["item": rig.player.player.currentItem != nil, "timeKept": abs(rig.player.currentTime - parkedTime) < 1e-3] as [String: Any],
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
    var lastBuffer: CVPixelBuffer?
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
        lastBuffer = buffer
      }
      try? await Task.sleep(nanoseconds: 1_000_000)
    }
    try await rig.expect("the last paused drag plan applied") { rig.applied.last?.buildSeq == buildSeq }
    let final = await rig.newFrame(at: time, timeout: 0.5) ?? lastBuffer
    let intervals = zip(refreshed, refreshed.dropFirst()).map { ($1 - $0) * 1000 }
    var entry: [String: Any] = [
      "sent": sent, "applied": rig.applied.count - appliedBefore, "refreshedFrames": refreshed.count,
      "refreshIntervalMs": stats(intervals), "lastY": lastY, "stillAtTime": abs(rig.player.currentTime - Double(k) / 30) < 1e-3,
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
