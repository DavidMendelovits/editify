import AVFoundation
import CoreMedia
import SoundAnalysis
import Speech
import Vision

/// The on-device analyzers (plan P2), promoted from server/scripts/native/standup-native.swift.
/// Each returns a `PartResult`: the 6A status, the analyzer version, and data
/// shaped like packages/shared/src/analysis.ts. Expected conditions (no audio,
/// speech model missing, silent recording) come back as `unavailable` or
/// `failed`, never as a crash or a thrown error.
///
///   ref ──AssetSource──▶ AVAsset ─┬─ PCMChunks (audio only, resampled) ─┬─ decodeMono 8 kHz ─▶ sync, energy, onsetPeaks
///                                 │                                     ├─ laughter (SoundAnalysis, 16 kHz stream)
///                                 │                                     └─ words (SpeechAnalyzer, its preferred format)
///                                 └─ AVAssetImageGenerator 2 fps ─▶ Vision ─▶ faces
///
/// The shared pieces (PCMChunks, the gate and progress types, AnalysisQueue) live in AudioDecode.swift.

/// Bumped whenever an analyzer's output can change, so a stored part from an
/// older analyzer reads as stale (decision 6A).
enum AnalyzerVersion {
  // -2: PCMChunks reads the first *enabled* audio track (it read the first track), which
  // can change the input of every audio analyzer on files with a disabled first track.
  static let decode = "avassetreader-8k-2"
  static let sync = "audiosync-vdsp-2"
  static let words = "speechanalyzer-ios26-2"
  static let laughter = "soundanalysis-v1-2"
  static let energy = "energy-rms-50ms-2"
  static let faces = "vision-facerect-1"
  /// Not an analyzer: the 1080p preview proxy (ProxyPipeline), versioned the same way.
  static let proxy = "writer-1080-1"

  static let all: [String: String] = [
    "decode": decode, "sync": sync, "words": words, "laughter": laughter, "energy": energy, "faces": faces, "proxy": proxy,
  ]
}

struct PartResult {
  let status: String
  let analyzerVersion: String
  var data: [String: Any]?
  var error: String?

  static func ready(_ version: String, _ data: [String: Any]) -> PartResult { PartResult(status: "ready", analyzerVersion: version, data: data) }
  static func failed(_ version: String, _ error: Error) -> PartResult { PartResult(status: "failed", analyzerVersion: version, error: error.localizedDescription) }
  static func failed(_ version: String, _ message: String) -> PartResult { PartResult(status: "failed", analyzerVersion: version, error: message) }
  static func unavailable(_ version: String, _ reason: String) -> PartResult { PartResult(status: "unavailable", analyzerVersion: version, error: reason) }

  var dictionary: [String: Any] {
    var out: [String: Any] = ["status": status, "analyzerVersion": analyzerVersion]
    if let data { out["data"] = data }
    if let error { out["error"] = error }
    return out
  }
}


enum Analyzers {
  // MARK: - Decode, sync, energy

  /// Whole recording as mono Float32 at `rate` (8 kHz for sync and energy).
  static func decodeMono(_ asset: AVAsset, rate: Double = Double(AudioSync.sampleRate), progress: AnalyzerProgress? = nil) async throws -> [Float] {
    let chunks = try await PCMChunks(asset: asset, rate: rate)
    let stop = CancelFlag()
    return try await withTaskCancellationHandler {
      try await AnalysisQueue.run {
        var samples: [Float] = []
        samples.reserveCapacity(max(0, Int(chunks.durationSeconds * chunks.rate)) + Int(chunks.rate))
        var ticks = 0
        while let (chunk, position) = try chunks.next() {
          samples.append(contentsOf: chunk)
          ticks += 1
          if ticks % 64 == 0 { progress?(chunks.fraction(at: position)) }
          if stop.isSet { chunks.cancel(); throw CancellationError() }
        }
        progress?(1)
        return samples
      }
    } onCancel: {
      stop.set()
    }
  }

  /// One pair's sync (OV6: a property of the pair). Both sides decoded at 8 kHz.
  static func sync(video: [Float], memo: [Float]) -> PartResult {
    do {
      let m = try AudioSync.measure(video: video, memo: memo)
      var measurement: [String: Any] = [
        "lag": m.lag, "anchor": m.anchor, "rate": m.rate,
        // Infinity (no runner-up peak) has no JSON form; the parity runner uses the same stand-in.
        "coarseRatio": m.coarseRatio.isFinite ? m.coarseRatio : 1e308,
        "fineScore": m.fineScore, "confident": m.confident, "overlapSec": m.overlapSec, "fineLocked": m.fineLocked,
        "windows": m.windows.map { ["at": $0.at, "lag": $0.lag, "score": $0.score] },
      ]
      if let drift = m.driftSec { measurement["driftSec"] = drift }
      return .ready(AnalyzerVersion.sync, measurement)
    } catch {
      return .failed(AnalyzerVersion.sync, error)
    }
  }

  /// energyAnalysisSchema data plus the onset peaks cut_to_beats lands on.
  static func energy(samples: [Float], rate: Int = AudioSync.sampleRate) -> PartResult {
    let rmsDb = AnalysisMath.energy(samples, sampleRate: rate)
    return .ready(AnalyzerVersion.energy, [
      "cellSeconds": AnalysisMath.energyCellSeconds,
      "rmsDb": rmsDb,
      "onsetPeaks": AnalysisMath.onsetPeaks(rmsDb, cellSeconds: AnalysisMath.energyCellSeconds),
    ])
  }

  // MARK: - Laughter (SoundAnalysis)

  /// Laughter spans with confidence (OV10), from the built-in classifier over
  /// a 16 kHz stream (8 kHz would cut the band laughs are recognised in).
  static func laughter(_ asset: AVAsset, minConfidence: Double = 0.5, progress: AnalyzerProgress? = nil) async -> PartResult {
    let version = AnalyzerVersion.laughter
    do {
      let chunks = try await PCMChunks(asset: asset, rate: 16_000)
      guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
        return .failed(version, "no 16 kHz float format")
      }
      let observer = LaughterObserver(minConfidence: minConfidence)
      let stop = CancelFlag()
      // analyze() blocks for backpressure; the whole stream runs on the analysis queue.
      try await withTaskCancellationHandler {
        try await AnalysisQueue.run {
          let analyzer = SNAudioStreamAnalyzer(format: format)
          try analyzer.add(SNClassifySoundRequest(classifierIdentifier: .version1), withObserver: observer)
          var ticks = 0
          while let (chunk, position) = try chunks.next() {
            guard let buffer = PCMChunks.buffer(chunk, format: format) else { continue }
            analyzer.analyze(buffer, atAudioFramePosition: AVAudioFramePosition(position))
            ticks += 1
            if ticks % 32 == 0 { progress?(chunks.fraction(at: position)) }
            if stop.isSet { chunks.cancel(); throw CancellationError() }
          }
          analyzer.completeAnalysis()
        }
      } onCancel: {
        stop.set()
      }
      if let failure = observer.failure { return .failed(version, failure) }
      let round2 = { (value: Double) in (value * 100).rounded() / 100 }
      let spans = AnalysisMath.laughterSpans(observer.windows).map { span -> [String: Any] in
        ["s": round2(span.start), "e": round2(span.end), "confidence": round2(span.confidence),
         "meanConfidence": round2(span.confidenceSum / Double(span.windows)), "windows": span.windows]
      }
      progress?(1)
      return .ready(version, ["minConfidence": minConfidence, "spans": spans])
    } catch is NoAudio {
      return .unavailable(version, NoAudio().localizedDescription)
    } catch {
      return .failed(version, error)
    }
  }

  // MARK: - Words (SpeechAnalyzer)

  /// transcriptResultSchema data from SpeechTranscriber with word time ranges.
  /// A missing speech model is downloaded when `allowModelDownload`; when that
  /// isn't allowed or fails (offline), the part is `unavailable`, and the caller
  /// re-queues it (`analyze` with `force`) once the phone is back online. When the
  /// gate stops it (the part was cancelled) the result is `failed` with a
  /// cancellation, never a partial `ready`.
  static func words(_ asset: AVAsset, locale requested: Locale = .current, allowModelDownload: Bool = true, progress: AnalyzerProgress? = nil, gate: AnalyzerGate? = nil) async -> PartResult {
    let version = AnalyzerVersion.words
    guard SpeechTranscriber.isAvailable else { return .unavailable(version, "Speech transcription is not available on this device") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      return .unavailable(version, "No speech model for \(requested.identifier)")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    do {
      if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        guard allowModelDownload else { return .unavailable(version, "The speech model for \(locale.identifier) is not installed") }
        do {
          try await install.downloadAndInstall()
        } catch {
          return .unavailable(version, "The speech model for \(locale.identifier) could not be downloaded: \(error.localizedDescription)")
        }
      }
    } catch {
      return .unavailable(version, "The speech model for \(locale.identifier) is unavailable: \(error.localizedDescription)")
    }

    do {
      guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        return .unavailable(version, "SpeechAnalyzer offered no audio format")
      }
      let chunks = try await PCMChunks(asset: asset, rate: format.sampleRate)
      guard let floatFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false) else {
        return .failed(version, "no float format at \(format.sampleRate) Hz")
      }
      // Same rate, so only the sample format may differ (usually Int16).
      let converter = floatFormat == format ? nil : AVAudioConverter(from: floatFormat, to: format)
      let stopped = CancelFlag()
      let inputs = AsyncThrowingStream<AnalyzerInput, Error> {
        if let gate, await !gate() { stopped.set(); return nil }
        guard let (samples, position) = try await AnalysisQueue.run({ try chunks.next() }) else { return nil }
        guard var buffer = PCMChunks.buffer(samples, format: floatFormat) else { return nil }
        if let converter {
          guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength) else { return nil }
          try converter.convert(to: converted, from: buffer)
          buffer = converted
        }
        progress?(chunks.fraction(at: position) * 0.95)
        return AnalyzerInput(buffer: buffer, bufferStartTime: CMTime(value: CMTimeValue(position), timescale: CMTimeScale(format.sampleRate)))
      }

      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let collect = Task { () -> (words: [[String: Any]], segments: [[String: Any]]) in
        var words: [[String: Any]] = []
        var segments: [[String: Any]] = []
        for try await result in transcriber.results where result.isFinal {
          var first: Double?
          var last: Double?
          for run in result.text.runs {
            guard let range = run.audioTimeRange else { continue }
            let text = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let start = max(0, range.start.seconds), end = max(start, range.end.seconds)
            words.append(["w": text, "s": round3(start), "e": round3(end)])
            first = first ?? start
            last = end
          }
          let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { continue }
          let start = first ?? max(0, result.range.start.seconds)
          let end = last ?? max(start, result.range.end.seconds)
          segments.append(["text": text, "s": round3(start), "e": round3(end)])
        }
        return (words, segments)
      }
      do {
        try await analyzer.start(inputSequence: inputs)
        try await analyzer.finalizeAndFinishThroughEndOfInput()
      } catch {
        await analyzer.cancelAndFinishNow()
        collect.cancel()
        throw error
      }
      let (words, segments) = try await collect.value
      if stopped.isSet { throw CancellationError() }
      progress?(1)
      return .ready(version, [
        "language": locale.language.languageCode?.identifier ?? locale.identifier,
        "durationProcessedSeconds": max(0, chunks.durationSeconds),
        "words": words,
        "segments": segments,
      ])
    } catch is NoAudio {
      return .unavailable(version, NoAudio().localizedDescription)
    } catch {
      return .failed(version, error)
    }
  }

  // MARK: - Faces (Vision)

  /// faceTrackSchema data: one sample per 1/fps, at the timestamp of the frame
  /// actually decoded (OV8), the box normalized to the upright frame (the
  /// track's preferredTransform applied) and padded like face_track.py.
  static func faces(_ asset: AVAsset, fps requestedFps: Double = 2, progress: AnalyzerProgress? = nil, gate: AnalyzerGate? = nil) async -> PartResult {
    let version = AnalyzerVersion.faces
    let fps = AnalyzerLimits.facesFps(requestedFps)
    do {
      guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw NoVideo() }
      let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
      let upright = CGRect(origin: .zero, size: natural).applying(transform)
      let duration = try await asset.load(.duration).seconds
      let generator = AVAssetImageGenerator(asset: asset)
      generator.maximumSize = CGSize(width: 640, height: 640)
      generator.appliesPreferredTrackTransform = true
      // The nearest decodable frame is plenty for framing; its real time is what gets recorded.
      let tolerance = CMTime(seconds: 0.5 / fps, preferredTimescale: 600)
      generator.requestedTimeToleranceBefore = tolerance
      generator.requestedTimeToleranceAfter = tolerance
      let times = stride(from: 0.0, to: duration, by: 1 / fps).map { CMTime(seconds: $0, preferredTimescale: 600) }

      var samples: [[Any]] = []
      samples.reserveCapacity(times.count)
      var done = 0
      var decoded = 0
      var visionFailures = 0
      var lastVisionError: Error?
      // Batches so the gate can hold between them without the generator running ahead.
      for batchStart in stride(from: 0, to: times.count, by: 16) {
        if let gate, await !gate() { throw CancellationError() }
        if Task.isCancelled { throw CancellationError() }
        let batch = Array(times[batchStart..<min(times.count, batchStart + 16)])
        for await result in generator.images(for: batch) {
          let at = (try? result.actualTime) ?? result.requestedTime
          let t = (max(0, at.seconds) * 1000).rounded() / 1000
          let image = try? result.image
          // Per frame, so the generator decodes the next frame while Vision reads this one.
          let (sample, visionError) = try await AnalysisQueue.run { detectFace(t: t, in: image) }
          samples.append(sample)
          if image != nil { decoded += 1 }
          if let visionError { visionFailures += 1; lastVisionError = visionError }
        }
        done += batch.count
        progress?(Double(done) / Double(max(1, times.count)))
      }
      // No frame decoded, or Vision failing on every frame, is a broken source or detector,
      // not a clip without faces.
      if !times.isEmpty, decoded == 0 {
        return .failed(version, "Could not decode any frame of the video")
      }
      if !times.isEmpty, visionFailures == decoded {
        let message = "Vision could not read any frame: \(lastVisionError?.localizedDescription ?? "unknown error")"
        // No inference context (seen on the simulator's GPU path) means this device can't
        // run the detector: retry elsewhere or later, not a fault in the clip.
        if let lastVisionError, isMissingInferenceContext(lastVisionError) { return .unavailable(version, message) }
        return .failed(version, message)
      }
      // The generator may hand frames back out of request order.
      samples.sort { ($0[0] as? Double ?? 0) < ($1[0] as? Double ?? 0) }
      return .ready(version, [
        "fps": fps,
        "width": Int(abs(upright.width).rounded()),
        "height": Int(abs(upright.height).rounded()),
        "samples": samples,
      ])
    } catch is NoVideo {
      return .unavailable(version, NoVideo().localizedDescription)
    } catch {
      return .failed(version, error)
    }
  }

  private static func isMissingInferenceContext(_ error: Error) -> Bool {
    let ns = error as NSError
    return ns.domain == VNErrorDomain && ns.code == VNErrorCode.internalError.rawValue
      && ns.localizedDescription.localizedCaseInsensitiveContains("inference context")
  }

  /// One face sample from one frame (blocking: runs on the analysis queue), plus
  /// Vision's error when it couldn't read the frame. Several faces: the largest wins,
  /// like face_track.py. One unreadable frame is a miss; `faces` fails the part only
  /// when every frame is.
  private static func detectFace(t: Double, in image: CGImage?) -> (sample: [Any], error: Error?) {
    autoreleasepool {
      guard let image else { return ([t, NSNull()], nil) }
      let request = VNDetectFaceRectanglesRequest()
      // Pinned so an OS update can't silently change the boxes under one analyzerVersion.
      request.revision = VNDetectFaceRectanglesRequestRevision3
      #if targetEnvironment(simulator)
      // The simulator's GPU path fails every frame ("Could not create inference context"); the CPU works.
      if let stages = try? request.supportedComputeStageDevices {
        for (stage, devices) in stages {
          if let cpu = devices.first(where: { if case .cpu = $0 { return true } else { return false } }) {
            request.setComputeDevice(cpu, for: stage)
          }
        }
      }
      #endif
      do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
      } catch {
        return ([t, NSNull()], error)
      }
      guard let face = (request.results ?? []).max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) else {
        return ([t, NSNull()], nil)
      }
      let box = AnalysisMath.topLeftBox(fromVision: face.boundingBox)
      return ([t] + AnalysisMath.paddedFaceBox(x: box.x, y: box.y, width: box.width, height: box.height), nil)
    }
  }

  // MARK: - Gemini proxy

  /// A small H.264 copy for style analysis (plan P2.4), so Gemini never gets the
  /// original: upright, at most `maxHeight` tall, SDR. Returns the local file;
  /// uploading it is the caller's job.
  static func makeProxy(_ asset: AVAsset, maxHeight requestedHeight: Double = 360) async throws -> [String: Any] {
    let maxHeight = AnalyzerLimits.proxyHeight(requestedHeight)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw NoVideo() }
    let (natural, transform, frameRate) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
    let duration = try await asset.load(.duration)
    let upright = CGRect(origin: .zero, size: natural).applying(transform)
    let size = AnalysisMath.proxySize(for: CGSize(width: abs(upright.width), height: abs(upright.height)), maxHeight: maxHeight)
    let factor = size.height / abs(upright.height)

    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
    // Not every writer puts the rotated frame back in the positive quadrant (iPhone does,
    // ffmpeg doesn't), so translate it there before scaling.
    let placed = transform.concatenating(CGAffineTransform(translationX: -upright.minX, y: -upright.minY))
    layer.setTransform(placed.concatenating(CGAffineTransform(scaleX: factor, y: factor)), at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
    instruction.layerInstructions = [layer]
    let video = AVMutableVideoComposition()
    video.instructions = [instruction]
    video.renderSize = size
    video.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, min(30, frameRate.rounded()))))
    video.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    video.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    video.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

    // The 640x480 preset honours the composition's smaller render size (a 9:16 clip comes out 202x360).
    // ponytail: the session picks ~2.2 Mbps video (88 MB for the 295 s stand-up set). If the
    // upload is too heavy on cellular, an AVAssetWriter with an explicit bitrate cuts it ~4x.
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset640x480) else {
      throw SpikeError(message: "export session unavailable for this asset")
    }
    session.videoComposition = video
    let output = TempFiles.url(prefix: TempFiles.proxyPrefix, extension: "mp4")
    let start = ContinuousClock.now
    do {
      try await session.export(to: output, as: .mp4)
    } catch {
      try? FileManager.default.removeItem(at: output)
      throw error
    }
    let bytes = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
    // Report what was written: the preset caps the frame at 640x480, so a tall maxHeight comes out smaller.
    var written = size
    if let track = try? await AVURLAsset(url: output).loadTracks(withMediaType: .video).first,
       let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) {
      let rect = CGRect(origin: .zero, size: natural).applying(transform)
      written = CGSize(width: abs(rect.width), height: abs(rect.height))
    }
    return [
      "uri": output.absoluteString, "width": Int(written.width.rounded()), "height": Int(written.height.rounded()),
      "seconds": duration.seconds, "bytes": bytes, "exportMs": millis(since: start),
    ]
  }
}

/// Collects classifier windows that heard laughter. SoundAnalysis may call back
/// off the feeding thread, so the windows sit behind a lock.
final class LaughterObserver: NSObject, SNResultsObserving, @unchecked Sendable {
  private let lock = NSLock()
  private let minConfidence: Double
  private var collected: [AnalysisMath.LaughWindow] = []
  private var error: String?

  init(minConfidence: Double) { self.minConfidence = minConfidence }

  var windows: [AnalysisMath.LaughWindow] { lock.withLock { collected } }
  var failure: String? { lock.withLock { error } }

  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let result = result as? SNClassificationResult,
          let laugh = result.classification(forIdentifier: "laughter"), laugh.confidence >= minConfidence else { return }
    let window = AnalysisMath.LaughWindow(start: result.timeRange.start.seconds, end: result.timeRange.end.seconds, confidence: laugh.confidence)
    lock.withLock { collected.append(window) }
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    lock.withLock { self.error = error.localizedDescription }
  }
}

/// Temp files the analyzers hand to JS (decoded PCM, Gemini proxies). They live until
/// JS deletes them or the next launch sweeps them (`sweep()` from the module's OnCreate).
enum TempFiles {
  static let pcmPrefix = "pcm-"
  static let proxyPrefix = "gemini-proxy-"
  /// On-device exports (ExportCenter): a finished file stays for the share sheet until next launch.
  static let exportPrefix = "editify-export-"

  static func url(prefix: String, extension ext: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)\(UUID().uuidString).\(ext)")
  }

  static func sweep() {
    let directory = FileManager.default.temporaryDirectory
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    for name in names where name.hasPrefix(pcmPrefix) || name.hasPrefix(proxyPrefix) || name.hasPrefix(exportPrefix) {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
  }
}
