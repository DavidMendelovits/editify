import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// The device preview proxy (decision 10B + OV9): a reader/writer transcode, not the
/// 640x480 `makeProxy` preset (that one stays for the Gemini upload).
///
///   AVAssetReader ─┬─ video: decoded at the source's bit depth ─▶ VTPixelTransferSession
///                  │          (short side ≤ 1080, aspect kept) ─▶ HEVC Main10 + the source's
///                  │          HLG/PQ BT.2020 tags (HDR), or H.264 High + its SDR tags
///                  └─ audio: AAC passed through, anything else encoded to AAC 128k
///   ─▶ AVAssetWriter (.mov, moov first, 1 s keyframes for scrubbing) at every source
///      timestamp, so the frame rate (variable or 60/120 fps) is kept as is.
///
/// A writer can't pause, so the scheduler cancels a proxy when playback or an export
/// starts and runs it again from the start afterwards. Cancelling (task cancellation)
/// stops both sides and deletes the output file. `hold` is polled between samples and
/// parks the pipeline without cancelling it (thermal state .serious or worse).
enum ProxyPipeline {
  static let maxShortSide: CGFloat = 1080

  /// The default `hold`: the phone is hot.
  static let thermalHold: @Sendable () -> Bool = {
    ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
  }

  /// Writes the proxy to `output` (replaced if present) and describes it:
  /// {width, height, fps, color, codec, bytes, seconds, audio ('passthrough' | 'aac' | 'none'), exportMs}.
  static func make(
    _ asset: AVAsset,
    to output: URL,
    maxShortSide: CGFloat = ProxyPipeline.maxShortSide,
    progress: AnalyzerProgress? = nil,
    hold: @escaping @Sendable () -> Bool = ProxyPipeline.thermalHold
  ) async throws -> [String: Any] {
    let start = ContinuousClock.now
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else { throw NoVideo() }
    let (natural, transform, nominalFps, formats) = try await videoTrack.load(.naturalSize, .preferredTransform, .nominalFrameRate, .formatDescriptions)
    let duration = try await asset.load(.duration)
    let audioTrack = try await asset.loadTracks(withMediaType: .audio).first
    let tags = ColorTags(formats.first)
    let hdr = tags.hdr
    // The frame is scaled as stored; the writer keeps the source's rotation in its transform.
    let size = AnalysisMath.previewProxySize(for: natural, maxShortSide: maxShortSide)
    let width = Int(size.width), height = Int(size.height)
    guard width > 0, height > 0 else { throw EngineError(message: "The video track has no size") }
    let scales = width != Int(natural.width.rounded()) || height != Int(natural.height.rounded())
    let fps = nominalFps > 0 ? Double(nominalFps) : 30
    let pixelFormat = hdr ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

    try? FileManager.default.removeItem(at: output)
    let reader = try AVAssetReader(asset: asset)
    let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
    writer.shouldOptimizeForNetworkUse = true

    let videoOut = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ])
    videoOut.alwaysCopiesSampleData = false
    guard reader.canAdd(videoOut) else { throw EngineError(message: "Can't decode this video track") }
    reader.add(videoOut)

    let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings(width: width, height: height, fps: fps, tags: tags))
    // The rotation stays; its translation is in source pixels, so it scales with the frame.
    let factor = CGFloat(width) / max(1, natural.width)
    videoIn.transform = CGAffineTransform(a: transform.a, b: transform.b, c: transform.c, d: transform.d, tx: transform.tx * factor, ty: transform.ty * factor)
    videoIn.expectsMediaDataInRealTime = false
    guard writer.canAdd(videoIn) else { throw EngineError(message: "Can't encode the proxy video") }
    writer.add(videoIn)
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ])

    var audioMode = "none"
    var audioPair: (AVAssetReaderTrackOutput, AVAssetWriterInput)?
    if let audioTrack {
      let audioFormats = try await audioTrack.load(.formatDescriptions)
      let (out, input, mode) = audioPipes(track: audioTrack, format: audioFormats.first)
      if reader.canAdd(out), writer.canAdd(input) {
        reader.add(out)
        writer.add(input)
        audioPair = (out, input)
        audioMode = mode
      }
    }

    var session: VTPixelTransferSession?
    if scales {
      VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session)
      guard session != nil else { throw EngineError(message: "Could not create a pixel transfer session") }
    }
    let transfer = session

    guard reader.startReading() else { throw reader.error ?? EngineError(message: "Could not start reading the video") }
    guard writer.startWriting() else {
      reader.cancelReading()
      throw writer.error ?? EngineError(message: "Could not start writing the proxy")
    }
    writer.startSession(atSourceTime: .zero)

    let job = WriterJob(reader: reader, writer: writer, output: output, inputs: audioPair == nil ? 1 : 2)
    let seconds = max(duration.seconds, 0.001)
    let videoPump: () -> WriterJob.Step = {
      guard let sample = videoOut.copyNextSampleBuffer() else { return .done }
      let time = CMSampleBufferGetPresentationTimeStamp(sample)
      if let transfer, let source = CMSampleBufferGetImageBuffer(sample) {
        guard let pool = adaptor.pixelBufferPool else { return .failed(EngineError(message: "The writer has no pixel buffer pool")) }
        var target: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &target)
        guard let target else { return .failed(EngineError(message: "Out of pixel buffers")) }
        // Same tags on both sides: the transfer scales and never converts color.
        CVBufferPropagateAttachments(source, target)
        let status = VTPixelTransferSessionTransferImage(transfer, from: source, to: target)
        guard status == noErr else { return .failed(EngineError(message: "Scaling a frame failed (\(status))")) }
        guard adaptor.append(target, withPresentationTime: time) else { return .writerFailed }
      } else if !videoIn.append(sample) {
        return .writerFailed
      }
      if time.isNumeric { progress?(min(0.99, max(0, time.seconds / seconds))) }
      return .more
    }
    let videoFeed = WriterJob.Feed(input: videoIn, pump: videoPump)
    var feeds = [videoFeed]
    if let (out, input) = audioPair {
      feeds.append(WriterJob.Feed(input: input) {
        guard let sample = out.copyNextSampleBuffer() else { return .done }
        return input.append(sample) ? .more : .writerFailed
      })
    }

    try await withTaskCancellationHandler {
      try await job.run(feeds, hold: hold)
    } onCancel: {
      job.cancel()
    }
    progress?(1)
    let bytes = (try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    return [
      "width": width, "height": height, "fps": round3(fps), "color": tags.name,
      "codec": hdr ? "hevc-main10" : "h264-high", "bytes": bytes, "seconds": round3(duration.seconds),
      "audio": audioMode, "exportMs": millisSince(start),
    ]
  }

  /// HEVC Main10 with the source's HDR tags, or H.264 High with its SDR tags (BT.709 when
  /// untagged or tagged with something the encoder doesn't take). ~0.1 bit per pixel (H.264),
  /// 0.07 (HEVC): plenty for a preview, a fraction of an iPhone original.
  static func videoSettings(width: Int, height: Int, fps: Double, tags: ColorTags) -> [String: Any] {
    let hdr = tags.hdr
    let pixelsPerSecond = Double(width * height) * max(24, min(fps, 120))
    let bitrate = Int(min(40_000_000, max(2_000_000, pixelsPerSecond * (hdr ? 0.07 : 0.1))))
    var compression: [String: Any] = [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
      AVVideoMaxKeyFrameIntervalDurationKey: 1.0,
      AVVideoAllowFrameReorderingKey: false,
    ]
    compression[AVVideoProfileLevelKey] = hdr ? (kVTProfileLevel_HEVC_Main10_AutoLevel as String) : AVVideoProfileLevelH264HighAutoLevel
    let color: [String: Any]
    if hdr {
      color = [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_2020,
        AVVideoTransferFunctionKey: tags.isHLG ? AVVideoTransferFunction_ITU_R_2100_HLG : AVVideoTransferFunction_SMPTE_ST_2084_PQ,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_2020,
      ]
    } else {
      let primaries = [AVVideoColorPrimaries_ITU_R_709_2, AVVideoColorPrimaries_SMPTE_C, AVVideoColorPrimaries_P3_D65]
      let matrices = [AVVideoYCbCrMatrix_ITU_R_709_2, AVVideoYCbCrMatrix_ITU_R_601_4]
      color = [
        AVVideoColorPrimariesKey: tags.primaries.flatMap { primaries.contains($0) ? $0 : nil } ?? AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: tags.matrix.flatMap { matrices.contains($0) ? $0 : nil } ?? AVVideoYCbCrMatrix_ITU_R_709_2,
      ]
    }
    return [
      AVVideoCodecKey: hdr ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: compression,
      AVVideoColorPropertiesKey: color,
    ]
  }

  /// AAC is copied as is; anything else (PCM, ALAC, AC-3) is decoded and encoded to AAC 128k.
  private static func audioPipes(track: AVAssetTrack, format: CMFormatDescription?) -> (AVAssetReaderTrackOutput, AVAssetWriterInput, String) {
    let description = format.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
    if let format, description?.mFormatID == kAudioFormatMPEG4AAC {
      let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
      return (out, AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: format), "passthrough")
    }
    let sourceRate = description?.mSampleRate ?? 48_000
    let rate = sourceRate == 44_100 ? 44_100.0 : 48_000.0
    let channels = (description?.mChannelsPerFrame ?? 2) >= 2 ? 2 : 1
    var layout = AudioChannelLayout()
    layout.mChannelLayoutTag = channels == 2 ? kAudioChannelLayoutTag_Stereo : kAudioChannelLayoutTag_Mono
    let layoutData = Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels,
      AVChannelLayoutKey: layoutData, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
    ])
    out.alwaysCopiesSampleData = false
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels,
      AVChannelLayoutKey: layoutData, AVEncoderBitRateKey: 128_000,
    ])
    input.expectsMediaDataInRealTime = false
    return (out, input, "aac")
  }

  private static func millisSince(_ start: ContinuousClock.Instant) -> Double {
    let elapsed = ContinuousClock.now - start
    return (Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15).rounded()
  }
}

/// One reader → writer run: each input pulls from its pump when the writer asks for
/// data, all on one serial queue so cancel, failure and completion can't race.
/// The continuation resumes exactly once; any failure or cancel removes the output.
private final class WriterJob: @unchecked Sendable {
  enum Step { case more, done, writerFailed, failed(Error) }

  struct Feed: @unchecked Sendable {
    let input: AVAssetWriterInput
    let pump: () -> Step
  }

  private let reader: AVAssetReader
  private let writer: AVAssetWriter
  private let output: URL
  private let queue = DispatchQueue(label: "editify.proxy-writer")
  /// Set from any thread; read by the drain loop, which can be parked in `hold`.
  private let stop = CancelFlag()
  private var remaining: Int
  private var continuation: CheckedContinuation<Void, Error>?
  private var ended = false
  /// finishWriting is in flight: a cancel now lets it complete (cancelWriting can't interrupt it).
  private var finishing = false

  init(reader: AVAssetReader, writer: AVAssetWriter, output: URL, inputs: Int) {
    self.reader = reader
    self.writer = writer
    self.output = output
    remaining = inputs
  }

  func run(_ feeds: [Feed], hold: @escaping @Sendable () -> Bool) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async { [self] in
        self.continuation = continuation
        if stop.isSet { return end(.failure(CancellationError())) }
        for feed in feeds {
          feed.input.requestMediaDataWhenReady(on: queue) { [self] in drain(feed, hold: hold) }
        }
      }
    }
  }

  /// From the task's cancellation handler, on any thread.
  func cancel() {
    stop.set()
    queue.async { [self] in
      if continuation != nil, !finishing { end(.failure(CancellationError())) }
    }
  }

  private func drain(_ feed: Feed, hold: () -> Bool) {
    while !ended && feed.input.isReadyForMoreMediaData {
      if stop.isSet { return end(.failure(CancellationError())) }
      // Parked, not cancelled: the phone is hot. The cancel flag is read here directly,
      // since `cancel()`'s queue block can't run while this one sleeps.
      while hold() {
        Thread.sleep(forTimeInterval: 0.25)
        if stop.isSet { return end(.failure(CancellationError())) }
      }
      switch feed.pump() {
      case .more:
        continue
      case .done:
        if reader.status == .failed { return end(.failure(reader.error ?? EngineError(message: "Reading the source failed"))) }
        feed.input.markAsFinished()
        remaining -= 1
        if remaining == 0 { finishWriting() }
        return
      case .writerFailed:
        return end(.failure(writer.error ?? EngineError(message: "Writing the proxy failed")))
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
          end(.failure(writer.error ?? EngineError(message: "The proxy did not finish writing")))
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
      try? FileManager.default.removeItem(at: output)
    }
    let waiting = continuation
    continuation = nil
    waiting?.resume(with: result)
  }
}
