import AVFoundation
import QuartzCore
import UIKit

/// Counts composited frames as they become available to display, which is what
/// "smooth preview" means: AVPlayerItemVideoOutput polled on the display link.
/// No layer is needed, so the number measures decode + compositor, not UIKit.
final class FrameMeter: NSObject {
  let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
  ])
  private var link: CADisplayLink?
  private(set) var frames = 0
  private(set) var maxGapMs: Double = 0
  private var lastFrame: CFTimeInterval = 0
  private var windowStart: CFTimeInterval = 0
  private var windowFrames = 0
  private(set) var worstWindowFps = Double.infinity
  var onFrame: (() -> Void)?

  @MainActor func start() {
    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  @MainActor func stop() { link?.invalidate(); link = nil }

  /// Restart gap tracking (e.g. right before an edit) without losing the frame count.
  func resetGap() { maxGapMs = 0; lastFrame = 0 }

  @objc private func tick(_ link: CADisplayLink) {
    let itemTime = output.itemTime(forHostTime: link.timestamp)
    guard output.hasNewPixelBuffer(forItemTime: itemTime),
          output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) != nil else { return }
    let now = link.timestamp
    if lastFrame > 0 { maxGapMs = max(maxGapMs, (now - lastFrame) * 1000) }
    lastFrame = now
    frames += 1
    if windowStart == 0 { windowStart = now }
    windowFrames += 1
    if now - windowStart >= 1 {
      worstWindowFps = min(worstWindowFps, Double(windowFrames) / (now - windowStart))
      windowStart = now
      windowFrames = 0
    }
    onFrame?()
  }
}

func renderSize(for variant: String, native: CGSize) -> CGSize {
  // 9:16 project; `native` keeps the source's long edge.
  if variant.contains("720") { return CGSize(width: 720, height: 1280) }
  if variant.contains("1080") { return CGSize(width: 1080, height: 1920) }
  let long = max(native.width, native.height)
  return CGSize(width: long * 9 / 16, height: long)
}

func naturalSize(of asset: AVAsset) async throws -> CGSize {
  guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw SpikeError(message: "no video track") }
  let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
  let rect = CGRect(origin: .zero, size: size).applying(transform)
  return CGSize(width: abs(rect.width), height: abs(rect.height))
}

/// S1: sustained preview fps through the compositor.
/// variant: render{720,1080,native}-{source,proxy}[-analysis]; params: asset, proxy (when the variant names it), seconds (default 600).
/// variant render1080-plan: PlanPreviewSpike on the lab plan (params: plan, media, seconds).
/// `-analysis` previews while the 8A scheduler analyzes the same clip with playback
/// active, so the light lane runs and the heavy lane is held (plan: "S1 under analysis load").
struct PreviewSpike: Spike {
  @MainActor func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    // `render1080-plan`: the finished renderer (PlanPlayer + EditifyCompositor) on the lab's stand-up cut.
    if variant.hasSuffix("-plan") { return try await PlanPreviewSpike().run(variant: variant, params: params, sampler: sampler, progress: progress) }
    let key = variant.contains("-proxy") ? "proxy" : "asset"
    guard let ref = params[key] as? String else { throw SpikeError(message: "S1 \(variant) needs params.\(key)") }
    let seconds = params["seconds"] as? Double ?? 600
    let asset = try await AssetSource.load(ref)
    var timeline = LabTimeline()
    timeline.renderSize = renderSize(for: variant, native: try await naturalSize(of: asset))
    let built = try await timeline.build(asset: asset)

    let item = AVPlayerItem(asset: built.composition)
    item.videoComposition = built.videoComposition
    let meter = FrameMeter()
    item.add(meter.output)
    let player = AVPlayer(playerItem: item)
    player.isMuted = true
    player.actionAtItemEnd = .none
    let loop = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
      player.seek(to: .zero)
    }
    defer { NotificationCenter.default.removeObserver(loop) }

    let analysisId = variant.hasSuffix("-analysis") ? "lab-s1-\(UUID().uuidString)" : nil
    if let analysisId {
      await AnalysisScheduler.shared.setPlaybackActive(true)
      await AnalysisScheduler.shared.analyze(assetId: analysisId, ref: ref, parts: nil, options: .init(), force: true)
    }
    defer {
      if let analysisId {
        Task {
          await AnalysisScheduler.shared.cancel(assetId: analysisId)
          await AnalysisScheduler.shared.setPlaybackActive(false)
        }
      }
    }

    meter.start()
    player.play()
    let started = ContinuousClock.now
    while millis(since: started) < seconds * 1000 {
      try await Task.sleep(for: .seconds(1))
      sampler.sample()
      progress(millis(since: started) / (seconds * 1000))
    }
    player.pause()
    meter.stop()

    let elapsed = millis(since: started) / 1000
    let dropped = item.accessLog()?.events.reduce(0) { $0 + $1.numberOfDroppedVideoFrames } ?? -1
    return [
      "fpsSustained": Double(meter.frames) / elapsed,
      "fpsWorst1s": meter.worstWindowFps.isFinite ? meter.worstWindowFps : 0,
      "droppedFrames": dropped,
      "renderWidth": Double(timeline.renderSize.width),
      "seconds": elapsed,
    ]
  }
}

/// S2: real-frame scrubbing. Paused, zero-tolerance seeks; a simulated 60 Hz drag
/// that coalesces (one seek in flight, newest target queued); then a "release".
/// variant: hevc-source | proxy; params: asset (or proxy).
struct ScrubSpike: Spike {
  @MainActor func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    let key = variant == "proxy" ? "proxy" : "asset"
    guard let ref = params[key] as? String else { throw SpikeError(message: "S2 \(variant) needs params.\(key)") }
    let asset = try await AssetSource.load(ref)
    let built = try await LabTimeline().build(asset: asset)
    let item = AVPlayerItem(asset: built.composition)
    item.videoComposition = built.videoComposition
    let player = AVPlayer(playerItem: item)
    player.isMuted = true
    let duration = built.composition.duration.seconds

    // Drag: 3 s of finger movement across the timeline at 60 Hz.
    let scrubber = CoalescingScrubber(player: player)
    for step in 0..<180 {
      let target = duration * 0.05 + (duration * 0.9) * Double(step) / 180
      scrubber.request(CMTime(seconds: target, preferredTimescale: 600))
      try await Task.sleep(for: .milliseconds(16))
      if step % 30 == 0 { progress(Double(step) / 360); sampler.sample() }
    }
    let newest = await scrubber.drain()

    // Release: 20 exact seeks to random spots, each from a settled state.
    var exact: [Double] = []
    for index in 0..<20 {
      let target = CMTime(seconds: Double.random(in: 0..<duration), preferredTimescale: 600)
      let start = ContinuousClock.now
      _ = await player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
      exact.append(millis(since: start))
      progress(0.5 + Double(index) / 40)
    }
    return [
      "newestFrameP95Ms": percentile(newest, 0.95),
      "newestFrameP50Ms": percentile(newest, 0.5),
      "exactFrameMs": percentile(exact, 0.5),
      "exactFrameP95Ms": percentile(exact, 0.95),
      "dragSeeksCompleted": Double(newest.count),
    ]
  }
}

func percentile(_ values: [Double], _ p: Double) -> Double {
  guard !values.isEmpty else { return -1 }
  let sorted = values.sorted()
  return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
}

/// One zero-tolerance seek in flight; requests that arrive meanwhile replace the
/// pending target. Latency is measured from when a target was *requested* to when
/// the seek that served it finished, i.e. how stale the picture under the finger is.
final class CoalescingScrubber: @unchecked Sendable {
  private let player: AVPlayer
  private let lock = NSLock()
  private var inFlight = false
  private var pending: (CMTime, ContinuousClock.Instant)?
  private var latencies: [Double] = []
  private var idle: CheckedContinuation<Void, Never>?

  init(player: AVPlayer) { self.player = player }

  func request(_ time: CMTime) {
    lock.lock()
    pending = (time, .now)
    let start = !inFlight
    if start { inFlight = true }
    lock.unlock()
    if start { next() }
  }

  private func next() {
    lock.lock()
    guard let (time, requested) = pending else {
      inFlight = false
      let waiter = idle
      idle = nil
      lock.unlock()
      waiter?.resume()
      return
    }
    pending = nil
    lock.unlock()
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [self] _ in
      lock.lock()
      latencies.append(millis(since: requested))
      lock.unlock()
      next()
    }
  }

  /// Waits for the last seek to land, then returns every served-request latency.
  func drain() async -> [Double] {
    await withCheckedContinuation { continuation in
      let busy = lock.withLock { () -> Bool in
        if inFlight { idle = continuation }
        return inFlight
      }
      if !busy { continuation.resume() }
    }
    return lock.withLock { latencies }
  }
}

/// S3: edits without a stall, on a 50-clip timeline while playing.
/// Param edit = new videoComposition (changed punch-in) on the live item.
/// Structural edit = rebuilt composition + replaceCurrentItem + seek back.
/// Stall = the longest gap between delivered frames around the edit, minus one frame.
struct EditSpike: Spike {
  @MainActor func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    guard let ref = params["asset"] as? String else { throw SpikeError(message: "S3 needs params.asset") }
    let asset = try await AssetSource.load(ref)
    var timeline = LabTimeline()
    timeline.clips = Int(variant.filter(\.isNumber)) ?? 50
    timeline.clipSeconds = 2
    timeline.crossfadeSeconds = 0.25
    let built = try await timeline.build(asset: asset)
    let frame = 1000.0 / Double(timeline.frameRate)

    let meter = FrameMeter()
    let item = AVPlayerItem(asset: built.composition)
    item.videoComposition = built.videoComposition
    item.add(meter.output)
    let player = AVPlayer(playerItem: item)
    player.isMuted = true
    meter.start()
    player.play()
    try await Task.sleep(for: .seconds(2))

    var paramStalls: [Double] = []
    for index in 0..<10 {
      var edited = timeline
      edited.punchIn = 1 + Double(index % 5) * 0.05
      // A parameter-only edit, as PlanPlayer applies one: same composition, new video composition.
      guard let update = try await edited.update(built, revision: index + 2) else { throw SpikeError(message: "S3: a punch-in edit changed the plan's structure") }
      meter.resetGap()
      item.videoComposition = update.videoComposition
      try await Task.sleep(for: .milliseconds(500))
      paramStalls.append(max(0, meter.maxGapMs - frame))
      progress(Double(index) / 20)
    }

    var structuralStalls: [Double] = []
    var current = item
    for index in 0..<5 {
      var edited = timeline
      edited.clips = timeline.clips - 1 - index
      let rebuilt = try await edited.build(asset: asset)
      let resumeAt = player.currentTime()
      let newItem = AVPlayerItem(asset: rebuilt.composition)
      newItem.videoComposition = rebuilt.videoComposition
      meter.resetGap()
      let start = ContinuousClock.now
      let framesBefore = meter.frames
      // An output belongs to one item at a time: detach before attaching.
      current.remove(meter.output)
      newItem.add(meter.output)
      player.replaceCurrentItem(with: newItem)
      current = newItem
      _ = await player.seek(to: resumeAt, toleranceBefore: .zero, toleranceAfter: .zero)
      player.play()
      while meter.frames == framesBefore && millis(since: start) < 3000 { try await Task.sleep(for: .milliseconds(4)) }
      structuralStalls.append(millis(since: start))
      try await Task.sleep(for: .milliseconds(500))
      progress(0.5 + Double(index) / 10)
      sampler.sample()
    }
    player.pause()
    meter.stop()
    return [
      "paramStallMs": percentile(paramStalls, 0.5),
      "paramStallMaxMs": paramStalls.max() ?? -1,
      "structuralStallMs": percentile(structuralStalls, 0.5),
      "structuralStallMaxMs": structuralStalls.max() ?? -1,
      "clips": Double(timeline.clips),
    ]
  }
}
