import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

/// Encoder knobs only (render-plan-schema.ts, WHAT THE PLAN OWNS): the plan's size,
/// fps, colour and loudness always win.
struct PlanExportOptions: Sendable {
  /// Video bits per second; nil picks `PlanExporter.defaultBitrate`.
  var videoBitrate: Int?
  /// Longest gap between keyframes, seconds.
  var keyframeInterval: Double = 2

  static let bitrateRange = 500_000...200_000_000
  static let audioBitrate = 192_000
}

/// What an export reports for the profiling pages (P4) and the done screen.
struct PlanExportStats: Sendable {
  var seconds = 0.0
  var xRealtime = 0.0
  var peakMemMB = 0.0
  /// Pass 1: the mix's integrated loudness (nil: silent, or loudness off).
  var lufsIn: Double?
  /// Measured on the processed PCM handed to the AAC encoder (after gain and limiter),
  /// not on the encoded file: AAC can add a few tenths of a dB of true peak.
  var lufsOut: Double?
  var truePeakPreEncode: Double?
  var gainDb = 0.0
  var limiterOn = false
  var limiterMaxReductionDb = 0.0
  var limiterLatencyFrames = 0
  var frames = 0
  var audioFrames = 0
  var bytes = 0
  var videoBitrate = 0
  var codec = ""
  var measureSeconds = 0.0
  var writeSeconds = 0.0

  var dictionary: [String: Any] {
    var out: [String: Any] = [
      "seconds": round3(seconds), "xRealtime": round3(xRealtime), "peakMemMB": round3(peakMemMB), "gainDb": gainDb,
      "limiterOn": limiterOn, "limiterMaxReductionDb": round3(limiterMaxReductionDb), "limiterLatencyFrames": limiterLatencyFrames,
      "frames": frames, "audioFrames": audioFrames, "bytes": bytes, "videoBitrate": videoBitrate, "codec": codec,
      "measureSeconds": round3(measureSeconds), "writeSeconds": round3(writeSeconds),
    ]
    out["lufsIn"] = lufsIn.map(round2) ?? NSNull()
    out["lufsOut"] = lufsOut.map(round2) ?? NSNull()
    out["truePeakPreEncode"] = truePeakPreEncode.map(round2) ?? NSNull()
    return out
  }

  private func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
  private func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }
}

enum PlanExportPhase: String, Sendable {
  case resolving, measuring, writing
}

enum PlanExportError: Error, LocalizedError, Equatable {
  /// Duration 0: executors refuse to export it (render-plan-schema.ts TIME AND FRAMES).
  case emptyPlan
  case notEnoughSpace(needed: Int64, available: Int64)
  case cancelled
  case tooHot
  case read(String)
  case write(String)

  var errorDescription: String? {
    switch self {
    case .emptyPlan: return "There is nothing to export yet"
    case .notEnoughSpace: return "Not enough space"
    case .cancelled: return "Export cancelled"
    case .tooHot: return "The phone is too hot to keep exporting"
    case .read(let what): return "Could not read the edit: \(what)"
    case .write(let what): return "Could not write the video: \(what)"
    }
  }
}

/// Cancels an export from any thread. Also stops it from outside (the BG task expired).
final class PlanExportControl: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var onCancel: [() -> Void] = []

  var isCancelled: Bool { lock.withLock { cancelled } }

  func cancel() {
    let handlers = lock.withLock { () -> [() -> Void] in
      guard !cancelled else { return [] }
      cancelled = true
      defer { onCancel = [] }
      return onCancel
    }
    for handler in handlers { handler() }
  }

  /// Runs now when already cancelled.
  func whenCancelled(_ handler: @escaping () -> Void) {
    let runNow = lock.withLock { () -> Bool in
      if cancelled { return true }
      onCancel.append(handler)
      return false
    }
    if runNow { handler() }
  }
}

/// The writer-based export (decision 8A + OV8):
///
///   PlanBuilder (composition + EditifyCompositor video composition + audio mix)
///   pass 1, measure (only when the plan normalizes): AVAssetReaderAudioMixOutput alone,
///        so no frame is decoded ─▶ LoudnessMeter ─▶ LoudnessRules.gainDb
///   pass 2, write: AVAssetReader [0, duration]
///        ├─ AVAssetReaderVideoCompositionOutput (8-bit 4:2:0 for SDR, 10-bit for HLG)
///        │     ─▶ H.264 High (SDR, BT.709 tags) | HEVC Main10 (HLG, BT.2020 / HLG tags)
///        └─ AVAssetReaderAudioMixOutput, Float32 stereo 48 kHz ─▶ PlanMixTrim ─▶ × gain
///              ─▶ TruePeakLimiter (latency compensated: output k is input k) ─▶ AAC 192k
///   ─▶ AVAssetWriter .mp4, moov first (shouldOptimizeForNetworkUse), no fragments.
///
/// Both writer inputs pull through requestMediaDataWhenReady on one serial queue, so the
/// writer's own readiness interleaves them. Progress is the presented video time over the
/// plan's duration. Cancel or any failure removes the output file.
enum PlanExporter {
  static let audioRate = 48_000.0

  /// Default video bitrate: bits per pixel per frame times pixels per second.
  ///
  /// The server encodes x264 / x265 `-preset medium -crf 18`, which lands around 8 to
  /// 12 Mbit/s for 1080x1920 at 30 fps on phone footage. Apple's hardware H.264 encoder
  /// needs roughly a third more bits for the same quality, so SDR gets 0.2 bit per pixel:
  /// 12.4 Mbit/s at 1080x1920 x 30, 49.8 Mbit/s at 4K 30. HEVC is about 30% more
  /// efficient, but a 10-bit HLG master keeps more gradation, so HLG gets 0.16:
  /// 10 Mbit/s at 1080p 30, 39.8 Mbit/s at 4K 30. Clamped to 1.5...100 Mbit/s; fps
  /// counts at least 24 (a 1 fps plan still needs keyframe bits).
  static func defaultBitrate(_ plan: RenderPlan) -> Int {
    let pixelsPerSecond = Double(plan.size.w * plan.size.h) * Double(max(24, plan.fps))
    let bitsPerPixel = plan.color == .hlg ? 0.16 : 0.2
    return Int(min(100_000_000, max(1_500_000, pixelsPerSecond * bitsPerPixel)))
  }

  /// Bytes the export needs free: the file (video + audio bitrate over the duration, +5%)
  /// twice over, since moving the moov to the front rewrites the file, plus `extraCopies`
  /// more (1 when it is saved to Photos, which copies it), plus 50 MB.
  static func spaceNeeded(_ plan: RenderPlan, videoBitrate: Int, extraCopies: Int = 0) -> Int64 {
    let file = Double(videoBitrate + PlanExportOptions.audioBitrate) / 8 * plan.duration * 1.05
    return Int64(file * Double(2 + max(0, extraCopies))) + 50 << 20
  }

  static func availableBytes(at directory: URL) -> Int64? {
    let values = try? directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values?.volumeAvailableCapacityForImportantUsage
  }

  static func videoSettings(_ plan: RenderPlan, bitrate: Int, keyframeInterval: Double) -> [String: Any] {
    let hlg = plan.color == .hlg
    var compression: [String: Any] = [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoExpectedSourceFrameRateKey: plan.fps,
      AVVideoMaxKeyFrameIntervalDurationKey: max(0.1, keyframeInterval),
      AVVideoAllowFrameReorderingKey: true,
      AVVideoProfileLevelKey: hlg ? (kVTProfileLevel_HEVC_Main10_AutoLevel as String) : AVVideoProfileLevelH264HighAutoLevel,
    ]
    if !hlg { compression[AVVideoH264EntropyModeKey] = AVVideoH264EntropyModeCABAC }
    let tags = PlanColorPipeline.tags(plan.color)
    return [
      AVVideoCodecKey: hlg ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
      AVVideoWidthKey: plan.size.w,
      AVVideoHeightKey: plan.size.h,
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: tags.primaries, AVVideoTransferFunctionKey: tags.transfer, AVVideoYCbCrMatrixKey: tags.matrix,
      ],
      AVVideoCompressionPropertiesKey: compression,
    ]
  }

  static let mixSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: audioRate, AVNumberOfChannelsKey: 2,
    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
  ]

  static var aacSettings: [String: Any] {
    var layout = AudioChannelLayout()
    layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
    return [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: audioRate, AVNumberOfChannelsKey: 2,
      AVEncoderBitRateKey: PlanExportOptions.audioBitrate,
      AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
    ]
  }

  /// Exports `plan` to `output` (replaced). The plan must already have passed
  /// RenderPlan.decode (limits, version, features).
  static func export(
    _ plan: RenderPlan,
    resolver: PlanAssetResolver,
    to output: URL,
    options: PlanExportOptions = PlanExportOptions(),
    build: PlanBuildOptions = PlanBuildOptions(),
    control: PlanExportControl = PlanExportControl(),
    extraCopies: Int = 0,
    available: (URL) -> Int64? = PlanExporter.availableBytes(at:),
    thermalCritical: @escaping @Sendable () -> Bool = { ProcessInfo.processInfo.thermalState == .critical },
    progress: @escaping @Sendable (PlanExportPhase, Double) -> Void = { _, _ in }
  ) async throws -> PlanExportStats {
    guard plan.duration > 0, plan.frameCount > 0 else { throw PlanExportError.emptyPlan }
    let started = ContinuousClock.now
    let memory = PeakMemory()
    var stats = PlanExportStats()
    let bitrate = options.videoBitrate.map { min(max($0, PlanExportOptions.bitrateRange.lowerBound), PlanExportOptions.bitrateRange.upperBound) }
      ?? defaultBitrate(plan)
    stats.videoBitrate = bitrate
    stats.codec = plan.color == .hlg ? "hevc-main10" : "h264-high"

    // Space first: nothing is decoded for an export that cannot fit.
    let directory = output.deletingLastPathComponent()
    let needed = spaceNeeded(plan, videoBitrate: bitrate, extraCopies: extraCopies)
    if let free = available(directory), free < needed { throw PlanExportError.notEnoughSpace(needed: needed, available: free) }
    if control.isCancelled { throw PlanExportError.cancelled }

    progress(.resolving, 0)
    let media = try await PlanBuilder.prepare(plan, resolver: resolver)
    if control.isCancelled { throw PlanExportError.cancelled }
    let built = try PlanBuilder.assemble(plan, media: media, options: build)
    progress(.resolving, 1)
    memory.sample()

    // Pass 1: the mix only.
    let end = CMTime(value: CMTimeValue(plan.frameCount), timescale: CMTimeScale(plan.fps))
    if LoudnessRules.limiterOn(plan.loudness) {
      let measureStart = ContinuousClock.now
      let meter = try measureMix(built, end: end, control: control) { progress(.measuring, $0) }
      stats.lufsIn = meter.integrated
      stats.gainDb = LoudnessRules.gainDb(measured: meter.integrated, plan.loudness)
      stats.measureSeconds = seconds(since: measureStart)
      memory.sample()
    }
    if control.isCancelled { throw PlanExportError.cancelled }

    // Pass 2.
    let writeStart = ContinuousClock.now
    let chain = MasterChain(gainDb: stats.gainDb, limiterCeilingDb: LoudnessRules.limiterOn(plan.loudness) ? plan.loudness.limiterCeilingDb : nil,
                            totalFrames: Int((plan.duration * audioRate).rounded()))
    try? FileManager.default.removeItem(at: output)
    do {
      let written = try await write(built, to: output, bitrate: bitrate, keyframeInterval: options.keyframeInterval, end: end, chain: chain,
                                    control: control, memory: memory, thermalCritical: thermalCritical) { progress(.writing, $0) }
      stats.frames = written
      if control.isCancelled { throw PlanExportError.cancelled }
    } catch {
      try? FileManager.default.removeItem(at: output)
      throw control.isCancelled ? PlanExportError.cancelled : error
    }
    stats.writeSeconds = seconds(since: writeStart)
    stats.limiterOn = chain.limiter != nil
    stats.limiterMaxReductionDb = chain.limiter?.maxReductionDb ?? 0
    stats.limiterLatencyFrames = chain.limiter?.latency ?? 0
    stats.audioFrames = chain.emittedFrames
    stats.lufsOut = chain.meter.integrated
    stats.truePeakPreEncode = chain.meter.truePeakDb
    stats.bytes = (try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    stats.seconds = seconds(since: started)
    stats.xRealtime = stats.seconds > 0 ? plan.duration / stats.seconds : 0
    memory.sample()
    stats.peakMemMB = memory.peakMB
    return stats
  }

  static func seconds(since start: ContinuousClock.Instant) -> Double {
    let elapsed = ContinuousClock.now - start
    return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
  }

  static func mixOutput(_ built: BuiltPlan) -> AVAssetReaderAudioMixOutput {
    let output = AVAssetReaderAudioMixOutput(audioTracks: built.composition.tracks(withMediaType: .audio), audioSettings: mixSettings)
    output.audioMix = built.audioMix
    output.audioTimePitchAlgorithm = BuiltPlan.audioTimePitchAlgorithm
    output.alwaysCopiesSampleData = false
    return output
  }

  /// Interleaved Float32 samples of a mix buffer.
  static func floats(_ buffer: CMSampleBuffer) -> [Float] {
    guard let block = CMSampleBufferGetDataBuffer(buffer) else { return [] }
    let length = CMBlockBufferGetDataLength(block)
    var values = [Float](repeating: 0, count: length / 4)
    _ = values.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
    return values
  }

  /// Pass 1: integrated loudness of the mix over [0, end).
  static func measureMix(_ built: BuiltPlan, end: CMTime, control: PlanExportControl, progress: (Double) -> Void) throws -> LoudnessMeter {
    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: built.composition) } catch { throw PlanExportError.read(error.localizedDescription) }
    let output = mixOutput(built)
    guard reader.canAdd(output) else { throw PlanExportError.read("the mix cannot be read") }
    reader.add(output)
    reader.timeRange = CMTimeRange(start: .zero, end: end)
    guard reader.startReading() else { throw PlanExportError.read(reader.error?.localizedDescription ?? "the mix did not start") }
    defer { reader.cancelReading() }
    // A cancel (or the BG task's expiry) stops the read at once, from any thread.
    control.whenCancelled { reader.cancelReading() }
    let meter = LoudnessMeter()
    let total = end.seconds
    while let raw = output.copyNextSampleBuffer() {
      if control.isCancelled { throw PlanExportError.cancelled }
      guard let sample = PlanMixTrim.trim(raw, end: end) else { continue }
      meter.add(floats(sample))
      let at = (CMSampleBufferGetPresentationTimeStamp(sample) + CMSampleBufferGetDuration(sample)).seconds
      if at.isFinite, total > 0 { progress(min(1, at / total)) }
    }
    if control.isCancelled { throw PlanExportError.cancelled }
    if reader.status == .failed { throw PlanExportError.read(reader.error?.localizedDescription ?? "the mix failed") }
    return meter
  }

  // MARK: Pass 2

  // swiftlint:disable:next function_body_length function_parameter_count
  private static func write(_ built: BuiltPlan, to output: URL, bitrate: Int, keyframeInterval: Double, end: CMTime, chain: MasterChain,
                            control: PlanExportControl, memory: PeakMemory, thermalCritical: @escaping @Sendable () -> Bool,
                            progress: @escaping @Sendable (Double) -> Void) async throws -> Int {
    let plan = built.plan
    let reader: AVAssetReader
    let writer: AVAssetWriter
    do {
      reader = try AVAssetReader(asset: built.composition)
      writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    } catch {
      throw PlanExportError.write(error.localizedDescription)
    }
    reader.timeRange = CMTimeRange(start: .zero, end: end)
    writer.shouldOptimizeForNetworkUse = true

    let pixelFormat = plan.color == .hlg ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    let videoOut = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video), videoSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ])
    videoOut.videoComposition = built.videoComposition
    videoOut.alwaysCopiesSampleData = false
    let audioOut = mixOutput(built)
    guard reader.canAdd(videoOut), reader.canAdd(audioOut) else { throw PlanExportError.read("the edit cannot be read") }
    reader.add(videoOut)
    reader.add(audioOut)

    let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings(plan, bitrate: bitrate, keyframeInterval: keyframeInterval))
    videoIn.expectsMediaDataInRealTime = false
    let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: aacSettings)
    audioIn.expectsMediaDataInRealTime = false
    guard writer.canAdd(videoIn) else { throw PlanExportError.write("this phone cannot encode \(plan.color == .hlg ? "HEVC Main10" : "H.264 High")") }
    guard writer.canAdd(audioIn) else { throw PlanExportError.write("this phone cannot encode AAC") }
    writer.add(videoIn)
    writer.add(audioIn)

    guard reader.startReading() else { throw PlanExportError.read(reader.error?.localizedDescription ?? "the edit did not start") }
    guard writer.startWriting() else {
      reader.cancelReading()
      throw PlanExportError.write(writer.error?.localizedDescription ?? "the writer did not start")
    }
    writer.startSession(atSourceTime: .zero)

    let job = ExportWriterJob(reader: reader, writer: writer, control: control)
    let duration = plan.duration
    var frames = 0
    let videoFeed = ExportWriterJob.Feed(input: videoIn) {
      if thermalCritical() { return .failed(PlanExportError.tooHot) }
      guard let sample = videoOut.copyNextSampleBuffer() else { return .done }
      let time = CMSampleBufferGetPresentationTimeStamp(sample)
      guard videoIn.append(sample) else { return .writerFailed }
      frames += 1
      if frames % 15 == 0 { memory.sample() }
      if time.isNumeric { progress(min(1, max(0, (time.seconds + 1 / Double(plan.fps)) / duration))) }
      return .more
    }
    var sourceDone = false
    let audioFeed = ExportWriterJob.Feed(input: audioIn) {
      // Each call appends at most one buffer: the limiter's output, or its flushed tail.
      while true {
        if sourceDone {
          let tail = chain.finish()
          if !tail.isEmpty {
            guard let buffer = chain.sampleBuffer(tail) else { return .failed(PlanExportError.write("could not wrap the audio")) }
            return audioIn.append(buffer) ? .done : .writerFailed
          }
          return .done
        }
        guard let raw = audioOut.copyNextSampleBuffer() else {
          if reader.status == .failed { return .failed(PlanExportError.read(reader.error?.localizedDescription ?? "the mix failed")) }
          sourceDone = true
          continue
        }
        guard let sample = PlanMixTrim.trim(raw, end: end) else { continue }
        let processed = chain.process(floats(sample))
        guard !processed.isEmpty else { continue }
        guard let buffer = chain.sampleBuffer(processed) else { return .failed(PlanExportError.write("could not wrap the audio")) }
        return audioIn.append(buffer) ? .more : .writerFailed
      }
    }
    try await job.run([videoFeed, audioFeed])
    return frames
  }
}

/// Gain, limiter and the meter of what reaches the encoder, with the timeline kept exact:
/// output frame k is mix frame k, and the stream is padded or cut to exactly
/// round(duration x 48 kHz) frames, so the audio track lasts what the video does.
final class MasterChain {
  let gain: Float
  let limiter: TruePeakLimiter?
  let totalFrames: Int
  let meter = LoudnessMeter()
  private(set) var emittedFrames = 0
  private var format: CMAudioFormatDescription?

  init(gainDb: Double, limiterCeilingDb: Double?, totalFrames: Int) {
    gain = Float(pow(10, gainDb / 20))
    limiter = limiterCeilingDb.map { TruePeakLimiter(ceilingDb: $0) }
    self.totalFrames = totalFrames
  }

  /// Interleaved stereo in, what is ready out (capped at totalFrames).
  func process(_ input: [Float]) -> [Float] {
    var samples = input
    if gain != 1 { for i in samples.indices { samples[i] *= gain } }
    return cap(limiter.map { $0.process(samples) } ?? samples)
  }

  /// The limiter's tail, then silence up to totalFrames.
  func finish() -> [Float] {
    var tail = limiter.map { $0.flush() } ?? []
    tail = cap(tail)
    let missing = totalFrames - emittedFrames - tail.count / 2
    if missing > 0 { tail += [Float](repeating: 0, count: missing * 2) }
    return tail
  }

  private func cap(_ samples: [Float]) -> [Float] {
    let room = max(0, totalFrames - emittedFrames)
    return samples.count / 2 > room ? Array(samples.prefix(room * 2)) : samples
  }

  /// Wraps interleaved stereo at the next output position; advances it and meters it.
  func sampleBuffer(_ samples: [Float]) -> CMSampleBuffer? {
    let frames = samples.count / 2
    guard frames > 0 else { return nil }
    if format == nil {
      var description = AudioStreamBasicDescription(
        mSampleRate: PlanExporter.audioRate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
      var layout = AudioChannelLayout()
      layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
      CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: MemoryLayout<AudioChannelLayout>.size, layout: &layout,
                                     magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    }
    guard let format else { return nil }
    let bytes = samples.count * 4
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil,
                                             offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
          let block else { return nil }
    let copied = samples.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
    guard copied == noErr else { return nil }
    var buffer: CMSampleBuffer?
    let status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
      allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
      presentationTimeStamp: CMTime(value: CMTimeValue(emittedFrames), timescale: CMTimeScale(PlanExporter.audioRate)),
      packetDescriptions: nil, sampleBufferOut: &buffer)
    guard status == noErr, let buffer else { return nil }
    emittedFrames += frames
    meter.add(samples)
    return buffer
  }
}

/// How often export progress reaches JS and the system's progress UI: every state change,
/// and within a state at most once per 1% of progress and per 100 ms (10 Hz). The writer
/// reports every frame, which at 60 fps would flood the bridge.
enum ExportThrottle {
  static func shouldSend(state: String, progress: Double, lastState: String?, lastProgress: Double, sinceLast: TimeInterval) -> Bool {
    if state != lastState { return true }
    return progress - lastProgress >= 0.01 && sinceLast >= 0.1
  }
}

/// Holds a setting at a value for a while and puts back exactly what was there before,
/// once, however the hold ends (ExportCenter keeps the screen awake with it: auto-lock
/// would send the app to the background and stop a foreground export).
final class ScopedOverride<Value>: @unchecked Sendable {
  private let read: () -> Value
  private let write: (Value) -> Void
  private var previous: Value?

  init(read: @escaping () -> Value, write: @escaping (Value) -> Void) {
    self.read = read
    self.write = write
  }

  var isHeld: Bool { previous != nil }

  /// A second hold while held keeps the first saved value.
  func hold(_ value: Value) {
    if previous == nil { previous = read() }
    write(value)
  }

  /// Restores the saved value; a no-op when not held.
  func release() {
    guard let saved = previous else { return }
    previous = nil
    write(saved)
  }
}

/// Resident memory high-water mark (phys_footprint, what jetsam counts).
final class PeakMemory: @unchecked Sendable {
  private let lock = NSLock()
  private var peak: UInt64 = 0

  func sample() {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    guard result == KERN_SUCCESS else { return }
    lock.withLock { peak = max(peak, info.phys_footprint) }
  }

  var peakMB: Double { lock.withLock { Double(peak) / 1_048_576 } }
}

/// One reader → writer run (the shape of ProxyPipeline's WriterJob): each input pulls from
/// its pump when the writer asks, all on one serial queue so cancel, failure and
/// completion cannot race. The continuation resumes exactly once.
private final class ExportWriterJob: @unchecked Sendable {
  enum Step { case more, done, writerFailed, failed(Error) }

  struct Feed: @unchecked Sendable {
    let input: AVAssetWriterInput
    let pump: () -> Step
  }

  private let reader: AVAssetReader
  private let writer: AVAssetWriter
  private let control: PlanExportControl
  private let queue = DispatchQueue(label: "editify.export-writer")
  private var remaining = 0
  private var continuation: CheckedContinuation<Void, Error>?
  private var ended = false
  private var finishing = false

  init(reader: AVAssetReader, writer: AVAssetWriter, control: PlanExportControl) {
    self.reader = reader
    self.writer = writer
    self.control = control
  }

  func run(_ feeds: [Feed]) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async { [self] in
        self.continuation = continuation
        remaining = feeds.count
        control.whenCancelled { [weak self] in self?.cancel() }
        if control.isCancelled { return end(.failure(PlanExportError.cancelled)) }
        for feed in feeds {
          feed.input.requestMediaDataWhenReady(on: queue) { [self] in drain(feed) }
        }
      }
    }
  }

  /// From any thread. The reader is cancelled right here, not on the writer queue: a pump
  /// blocked in copyNextSampleBuffer (a frame rendering) returns at once, so an expiring BG
  /// task gets its cleanup done in time.
  private func cancel() {
    reader.cancelReading()
    queue.async { [self] in
      if continuation != nil, !finishing { end(.failure(PlanExportError.cancelled)) }
    }
  }

  private func drain(_ feed: Feed) {
    while !ended && feed.input.isReadyForMoreMediaData {
      if control.isCancelled { return end(.failure(PlanExportError.cancelled)) }
      switch feed.pump() {
      case .more:
        continue
      case .done:
        // A cancelled reader ends its outputs early: that is a cancel, never a short file.
        if control.isCancelled || reader.status == .cancelled { return end(.failure(PlanExportError.cancelled)) }
        if reader.status == .failed { return end(.failure(PlanExportError.read(reader.error?.localizedDescription ?? "reading failed"))) }
        feed.input.markAsFinished()
        remaining -= 1
        if remaining == 0 { finishWriting() }
        return
      case .writerFailed:
        return end(.failure(PlanExportError.write(writer.error?.localizedDescription ?? "the writer failed")))
      case .failed(let error):
        return end(.failure(error))
      }
    }
  }

  private func finishWriting() {
    finishing = true
    writer.finishWriting { [self] in
      queue.async { [self] in
        if writer.status == .completed {
          end(.success(()))
        } else {
          end(.failure(PlanExportError.write(writer.error?.localizedDescription ?? "the video did not finish writing")))
        }
      }
    }
  }

  private func end(_ result: Result<Void, Error>) {
    guard !ended else { return }
    ended = true
    if case .failure = result {
      reader.cancelReading()
      if writer.status == .writing { writer.cancelWriting() }
    }
    let waiting = continuation
    continuation = nil
    waiting?.resume(with: result)
  }
}
