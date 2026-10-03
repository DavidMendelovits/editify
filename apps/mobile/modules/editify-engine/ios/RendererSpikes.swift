import AVFoundation
import CoreImage

/// P7 (decision 5B): S4 and S5 measure the finished renderer, not lab-only code. The
/// plan is the lab's stand-up cut (src/lab/standup-plan.ts), built in JS by the same
/// buildRenderPlan the export screen uses, and sent with its media map:
///   params.plan   RenderPlan v1 JSON
///   params.media  {assetId: ref} (a PHAsset localIdentifier or an app file:// URI)
///   params.via    "photos" | "app-copy": which of the two the lab sent (reported as `source`)
enum LabPlan {
  static func decode(_ params: [String: Any], spike: String) throws -> (RenderPlan, [String: String]) {
    guard let json = params["plan"] as? String else { throw SpikeError(message: "\(spike) needs params.plan (the lab builds it from the picked clip)") }
    guard let media = params["media"] as? [String: String] else { throw SpikeError(message: "\(spike) needs params.media") }
    return (try RenderPlan.decode(Data(json.utf8)), media)
  }

  /// The export screen's resolver (ExportCenter.run): only the refs JS sent.
  static func resolver(_ media: [String: String]) -> PlanAssetResolver {
    PlanAssetResolver(
      asset: { ref in try await ExportCenter.loadAsset(media[ref.id], id: ref.id) },
      imageFile: { ref in try await ExportCenter.imageFile(media[ref.id], id: ref.id, prefix: TempFiles.previewPrefix) })
  }

  static func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }

  /// A percentile of compositor times, or null when no frame was timed (never `percentile`'s -1,
  /// which would read as a fast compositor).
  static func ms(_ values: [Double], _ p: Double) -> Any {
    values.isEmpty ? NSNull() : round2(percentile(values, p))
  }
}

/// The lab's progress to JS at ExportCenter's rate (ExportThrottle: every phase change, else at
/// most per 1% and 10 times a second), so a lab export adds no bridge load production doesn't.
final class LabProgressThrottle: @unchecked Sendable {
  private let lock = NSLock()
  private var lastState: String?
  private var lastProgress = -1.0
  private var lastSent = Date.distantPast

  func shouldSend(state: String, progress: Double) -> Bool {
    lock.withLock {
      guard ExportThrottle.shouldSend(state: state, progress: progress, lastState: lastState, lastProgress: lastProgress,
                                      sinceLast: Date().timeIntervalSince(lastSent)) else { return false }
      lastState = state
      lastProgress = progress
      lastSent = Date()
      return true
    }
  }
}

/// S4: export the plan with PlanExporter (what exportProject runs, minus the Photos save).
/// variant: writer-60s-4k30 | writer-60s-1080 (JS picks the plan's size and colour).
///
/// tagsCorrect: the file's codec, profile and colour tags are what the plan's colour asks
/// for: SDR = H.264 High (avcC profile 100), BT.709 primaries / transfer / matrix; HLG =
/// HEVC Main10 (hvcC general_profile_idc 2), BT.2020 primaries and matrix, HLG transfer.
/// fpsKept: the video track runs at the plan's fps and the writer wrote every plan frame.
struct WriterSpike: Spike {
  func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    let (plan, media) = try LabPlan.decode(params, spike: "S4")
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("\(TempFiles.exportPrefix)lab-\(UUID().uuidString).mp4")
    defer { try? FileManager.default.removeItem(at: output) }

    CompositorTiming.begin()
    // However the run ends (a throw, a cancel), timing is off again afterwards.
    defer { _ = CompositorTiming.end() }
    let throttle = LabProgressThrottle()
    let stats = try await PlanExporter.export(plan, resolver: LabPlan.resolver(media), to: output, progress: { phase, value in
      guard throttle.shouldSend(state: phase.rawValue, progress: value) else { return }
      // resolving 0-2%, measuring 2-10%, writing 10-100%.
      switch phase {
      case .resolving: progress(value * 0.02)
      case .measuring: progress(0.02 + value * 0.08)
      case .writing: progress(0.1 + value * 0.9)
      }
      sampler.sample()
    })
    let compositor = CompositorTiming.end()
    sampler.note(memMB: stats.peakMemMB)

    let file = try await FileTags.read(output)
    let expected = PlanColorPipeline.tags(plan.color)
    let hlg = plan.color == .hlg
    let tagsCorrect = file.codec == (hlg ? "hvc1" : "avc1")
      && file.profile == (hlg ? 2 : 100)
      && file.primaries == expected.primaries && file.transfer == expected.transfer && file.matrix == expected.matrix
    let fpsKept = abs(file.fps - Double(plan.fps)) < 0.01 && stats.frames == plan.frameCount

    var metrics: [String: Any] = [
      "exportSeconds": LabPlan.round2(stats.seconds),
      "xRealtime": LabPlan.round2(stats.xRealtime),
      "planSeconds": plan.duration,
      "width": plan.size.w, "height": plan.size.h, "fps": plan.fps, "color": plan.color.rawValue,
      "tagsCorrect": tagsCorrect,
      "fpsKept": fpsKept,
      "codec": file.codec, "profile": file.profile,
      "primaries": file.primaries ?? "none", "transfer": file.transfer ?? "none", "matrix": file.matrix ?? "none",
      "fileFps": LabPlan.round2(file.fps),
      "frames": stats.frames, "planFrames": plan.frameCount,
      "exporterPeakMemMB": LabPlan.round2(stats.peakMemMB),
      "measureSeconds": LabPlan.round2(stats.measureSeconds),
      "writeSeconds": LabPlan.round2(stats.writeSeconds),
      "videoMbps": LabPlan.round2(Double(stats.videoBitrate) / 1e6),
      "outputMB": LabPlan.round2(Double(stats.bytes) / 1_048_576),
      "compositedFrames": compositor.count,
      "compositorMsP50": LabPlan.ms(compositor, 0.5),
      "compositorMsP95": LabPlan.ms(compositor, 0.95),
      "hlg": hlg,
      "source": params["via"] as? String ?? "photos",
      "limiterOn": stats.limiterOn,
      "gainDb": LabPlan.round2(stats.gainDb),
    ]
    metrics["lufsIn"] = stats.lufsIn.map(LabPlan.round2) ?? NSNull()
    metrics["lufsOut"] = stats.lufsOut.map(LabPlan.round2) ?? NSNull()
    metrics["truePeakPreEncode"] = stats.truePeakPreEncode.map(LabPlan.round2) ?? NSNull()
    return metrics
  }
}

/// The video track's codec, profile, colour tags and frame rate, as a player reads them.
struct FileTags {
  var codec = ""
  /// avcC AVCProfileIndication (100 = High) or hvcC general_profile_idc (2 = Main10); -1 unknown.
  var profile = -1
  var primaries: String?
  var transfer: String?
  var matrix: String?
  var fps = 0.0

  static func read(_ url: URL) async throws -> FileTags {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw SpikeError(message: "the export has no video track") }
    let (descriptions, fps) = try await track.load(.formatDescriptions, .nominalFrameRate)
    guard let description = descriptions.first else { throw SpikeError(message: "the export's video has no format description") }
    var tags = FileTags()
    tags.fps = Double(fps)
    let fourCC = CMFormatDescriptionGetMediaSubType(description)
    tags.codec = String(bytes: [24, 16, 8, 0].map { UInt8((fourCC >> $0) & 0xFF) }, encoding: .ascii) ?? "?"
    let extensions = CMFormatDescriptionGetExtensions(description) as? [String: Any] ?? [:]
    tags.primaries = extensions[kCMFormatDescriptionExtension_ColorPrimaries as String] as? String
    tags.transfer = extensions[kCMFormatDescriptionExtension_TransferFunction as String] as? String
    tags.matrix = extensions[kCMFormatDescriptionExtension_YCbCrMatrix as String] as? String
    let atoms = extensions[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] as? [String: Any] ?? [:]
    if let avcC = atoms["avcC"] as? Data, avcC.count > 1 {
      tags.profile = Int(avcC[avcC.startIndex + 1])
    } else if let hvcC = atoms["hvcC"] as? Data, hvcC.count > 1 {
      tags.profile = Int(hvcC[hvcC.startIndex + 1] & 0x1F)
    }
    return tags
  }
}

/// S5 (variant preview1080) and S1 (variant render1080-plan): the native preview's player,
/// PlanPlayer, playing the plan through EditifyCompositor at 1080 x 1920 (the preview cap).
/// No view: an AVPlayerItemVideoOutput polled on the display link (FrameMeter) counts the
/// composited frames, so the number is decode + compositor, not UIKit.
///
///   msPerFrame / msPerFrameP95: the compositor's time per frame, request picked up to GPU
///     render finished (CompositorTiming), p50 / p95 over every frame played; a run that
///     composited no frame throws instead of reporting a time
///   fpsSustained, fpsWorst1s, framesMissed (frames the plan's fps owed that never arrived)
///   visualMatch: the preview's frame at `matchAt` (default 12.2 s: inside a crossfade, under
///     a sticker and a karaoke caption) against the export path's frame at the same time
///     (PlanBuilder at render scale 1, AVAssetReaderVideoCompositionOutput, as PlanExporter
///     reads it), both downscaled to 270 x 480 sRGB 8-bit: mean absolute difference over RGB
///     under `matchTolerance` (default 3 of 255). Both frames go to Documents/lab as JPEGs.
/// params: plan, media, seconds (S5 default 20, S1 default 600; the plan loops), matchAt.
struct PlanPreviewSpike: Spike {
  static let comparisonSize = CGSize(width: 270, height: 480)

  @MainActor func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    let spike = variant.hasSuffix("-plan") ? "S1" : "S5"
    let (plan, media) = try LabPlan.decode(params, spike: spike)
    let seconds = (params["seconds"] as? Double).flatMap { $0 > 0 ? $0 : nil } ?? (spike == "S1" ? 600 : 20)
    let rig = PlayerRig(media: media)
    defer { rig.player.teardown() }

    let applyStarted = ContinuousClock.now
    try await rig.apply(plan)
    let applyMs = millis(since: applyStarted)
    progress(0.02)

    CompositorTiming.begin()
    // However the run ends (a throw, a cancel), timing is off and the display link stopped.
    defer { _ = CompositorTiming.end() }
    rig.meter.start()
    defer { rig.meter.stop() }
    rig.player.play()
    let started = ContinuousClock.now
    while millis(since: started) < seconds * 1000 {
      try await Task.sleep(for: .milliseconds(500))
      sampler.sample()
      progress(0.02 + 0.88 * min(1, millis(since: started) / (seconds * 1000)))
    }
    rig.player.pause()
    rig.meter.stop()
    let compositor = CompositorTiming.end()
    // Nothing timed means nothing was measured: a row, not a pass by default.
    guard !compositor.isEmpty else { throw SpikeError(message: "\(spike): the compositor drew no frames in \(Int(seconds)) s (\(rig.errors.joined(separator: "; ")))") }
    let elapsed = millis(since: started) / 1000
    let dropped = rig.item?.accessLog()?.events.reduce(0) { $0 + $1.numberOfDroppedVideoFrames } ?? -1
    let owed = Int((elapsed * Double(plan.fps)).rounded())

    var metrics: [String: Any] = [
      "msPerFrame": LabPlan.ms(compositor, 0.5),
      "msPerFrameP95": LabPlan.ms(compositor, 0.95),
      "msPerFrameMax": LabPlan.ms(compositor, 1),
      "compositedFrames": compositor.count,
      "fpsSustained": LabPlan.round2(Double(rig.meter.frames) / elapsed),
      "fpsWorst1s": LabPlan.round2(rig.meter.worstWindowFps.isFinite ? rig.meter.worstWindowFps : 0),
      "framesMissed": max(0, owed - rig.meter.frames),
      "droppedFrames": dropped,
      "loops": rig.ends,
      "stalls": rig.stalls,
      "applyMs": LabPlan.round2(applyMs),
      "source": params["via"] as? String ?? "photos",
      "seconds": LabPlan.round2(elapsed),
      "renderWidth": Double(plan.size.w) * Double(rig.player.renderScale(for: plan)),
    ]
    if !rig.errors.isEmpty { metrics["playerErrors"] = rig.errors.joined(separator: "; ") }
    if spike == "S1" { progress(1); return metrics }

    // visualMatch: the preview's frame against the export path's at the same frame.
    let matchAt = params["matchAt"] as? Double ?? 12.2
    let frame = min(plan.frameCount - 1, max(0, Int((matchAt * Double(plan.fps)).rounded())))
    let previewFrame = try await rig.frame(at: frame, fps: plan.fps)
    progress(0.95)
    let exportFrame = try await Self.exportFrame(plan, media: media, frame: frame)
    let tolerance = params["matchTolerance"] as? Double ?? 3
    let comparison = try Self.compare(previewFrame, exportFrame, run: sampler.run)
    metrics["visualDiff"] = LabPlan.round2(comparison.meanAbs)
    metrics["visualDiffMaxChannel"] = comparison.maxAbs
    metrics["visualMatch"] = comparison.meanAbs < tolerance
    metrics["visualTolerance"] = tolerance
    metrics["matchFrame"] = frame
    metrics["visualFiles"] = comparison.files
    progress(1)
    return metrics
  }

  /// The export path's frame `frame`: a fresh PlanBuilder build at render scale 1, read by an
  /// AVAssetReaderVideoCompositionOutput in the pixel format PlanExporter asks for.
  static func exportFrame(_ plan: RenderPlan, media: [String: String], frame: Int) async throws -> CVPixelBuffer {
    let built = try await PlanBuilder.build(plan, resolver: LabPlan.resolver(media))
    let reader = try AVAssetReader(asset: built.composition)
    let start = CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(plan.fps))
    reader.timeRange = CMTimeRange(start: start, duration: CMTime(value: 1, timescale: CMTimeScale(plan.fps)))
    let pixelFormat = plan.color == .hlg ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    let output = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video), videoSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ])
    output.videoComposition = built.videoComposition
    guard reader.canAdd(output) else { throw SpikeError(message: "the export path cannot read the plan") }
    reader.add(output)
    guard reader.startReading() else { throw SpikeError(message: reader.error?.localizedDescription ?? "the export path did not start") }
    defer { reader.cancelReading() }
    guard let sample = output.copyNextSampleBuffer(), let buffer = CMSampleBufferGetImageBuffer(sample) else {
      throw SpikeError(message: reader.error?.localizedDescription ?? "the export path rendered no frame at \(frame)")
    }
    return buffer
  }

  static let compareContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, .cacheIntermediates: false])

  /// Mean and max absolute difference (0-255) over RGB at `comparisonSize`, sRGB 8-bit.
  static func compare(_ a: CVPixelBuffer, _ b: CVPixelBuffer, run: Int?) throws -> (meanAbs: Double, maxAbs: Int, files: [String]) {
    let first = try rgba(a), second = try rgba(b)
    var sum = 0, worst = 0
    for index in stride(from: 0, to: first.count, by: 4) {
      for channel in 0..<3 {
        let delta = abs(Int(first[index + channel]) - Int(second[index + channel]))
        sum += delta
        worst = max(worst, delta)
      }
    }
    let pixels = first.count / 4
    var files: [String] = []
    let stamp = run.map { "run\($0)" } ?? ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
    for (name, buffer) in [("preview", a), ("export", b)] {
      let url = LabStore.directory.appendingPathComponent("s5-\(stamp)-\(name).jpg")
      let image = CIImage(cvPixelBuffer: buffer)
      if let space = CGColorSpace(name: CGColorSpace.sRGB),
         let data = compareContext.jpegRepresentation(of: image, colorSpace: space, options: [:]) {
        try? data.write(to: url)
        files.append(url.lastPathComponent)
      }
    }
    return (Double(sum) / Double(max(1, pixels * 3)), worst, files)
  }

  static func rgba(_ buffer: CVPixelBuffer) throws -> [UInt8] {
    let image = CIImage(cvPixelBuffer: buffer)
    let size = comparisonSize
    let scaled = image.transformed(by: CGAffineTransform(scaleX: size.width / image.extent.width, y: size.height / image.extent.height))
    var bytes = [UInt8](repeating: 0, count: Int(size.width * size.height) * 4)
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { throw SpikeError(message: "no sRGB colour space") }
    compareContext.render(scaled, toBitmap: &bytes, rowBytes: Int(size.width) * 4, bounds: CGRect(origin: .zero, size: size), format: .RGBA8, colorSpace: space)
    return bytes
  }
}

/// A PlanPlayer with a FrameMeter on every item it installs (as the preview parity harness drives it).
@MainActor
final class PlayerRig {
  let player: PlanPlayer
  let meter = FrameMeter()
  private(set) var item: AVPlayerItem?
  private(set) var applied: [PlanPlayer.Applied] = []
  private(set) var seeksLanded = 0
  private(set) var stalls = 0
  private(set) var ends = 0
  private(set) var errors: [String] = []
  private let media: [String: String]

  init(media: [String: String]) {
    self.media = media
    player = PlanPlayer(resolver: { refs in LabPlan.resolver(refs) })
    player.setMuted(true)
    // No view: 1080 x 1920 is what the preview renders at most.
    player.viewPixels = CGSize(width: PlanPlayer.maxShortSide, height: PlanPlayer.maxLongSide)
    player.onItem = { [weak self] item in
      guard let self else { return }
      self.item?.remove(self.meter.output)
      item.add(self.meter.output)
      self.item = item
    }
    player.onEvent = { [weak self] event in
      guard let self else { return }
      switch event {
      case .plan(let applied): self.applied.append(applied)
      case .time(_, let playing): if !playing { self.seeksLanded += 1 }
      case .buffering(let on): if on { self.stalls += 1 }
      case .ended:
        // Loop: a sustained run outlasts the plan.
        self.ends += 1
        self.player.seek(to: 0, exact: true)
        self.player.play()
      case .error(let message), .mediaExpired(let message): self.errors.append(message)
      case .ready: break
      }
    }
  }

  func until(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
    let deadline = CFAbsoluteTimeGetCurrent() + seconds
    while CFAbsoluteTimeGetCurrent() < deadline {
      if condition() { return true }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
  }

  func apply(_ plan: RenderPlan) async throws {
    let before = applied.count
    guard player.setPlan(plan, media: media) else { throw SpikeError(message: "the player dropped the plan") }
    guard await until(120, { applied.count > before }) else { throw SpikeError(message: "the plan was not applied in 120 s") }
    if let last = applied.last, last.mode == .failed { throw SpikeError(message: "the plan failed: \(last.error ?? "?")") }
    guard await until(60, { player.player.currentItem?.status == .readyToPlay }) else {
      throw SpikeError(message: "the item never became ready (\(errors.joined(separator: "; ")))")
    }
  }

  /// An exact seek to frame `k`, then the frame the output vends for it.
  func frame(at k: Int, fps: Int) async throws -> CVPixelBuffer {
    let time = CMTime(value: CMTimeValue(k), timescale: CMTimeScale(fps))
    let landed = seeksLanded
    player.seek(to: time.seconds, exact: true)
    guard await until(30, { seeksLanded > landed }) else { throw SpikeError(message: "the seek to frame \(k) never landed") }
    var found: CVPixelBuffer?
    _ = await until(15) {
      guard meter.output.hasNewPixelBuffer(forItemTime: time) else { return false }
      found = meter.output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil)
      return found != nil
    }
    guard let found else { throw SpikeError(message: "the preview vended no frame at \(k)") }
    return found
  }
}
