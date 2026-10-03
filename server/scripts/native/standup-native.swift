// The stand-up pipeline's analysis stages on Apple's on-device frameworks:
// the same APIs exist on iOS 26, so these numbers are what the phone path is
// made of (an M4 Max is faster than an iPhone; treat them as a floor, and the
// capability lab's S8 measures the phone itself).
//
//   swiftc -O -parse-as-library scripts/native/standup-native.swift -o /tmp/standup-native
//   /tmp/standup-native "<video>" "<memo>"
//
// Stages (each timed): audio-only decode at 8 kHz → sync (onset-envelope
// cross-correlation, vDSP) → laughter (SoundAnalysis built-in classifier) →
// words (SpeechAnalyzer) → faces (Vision on 2 fps low-res frames).
import AVFoundation
import Accelerate
import Foundation
import SoundAnalysis
import Speech
import Vision

let clock = ContinuousClock()
let started = clock.now
func seconds(_ d: Duration) -> Double { Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18 }
func log(_ s: String) { print(String(format: "[%6.2fs] ", seconds(clock.now - started)) + s) }
func timed<T>(_ name: String, _ body: () async throws -> T) async rethrows -> T {
  let t = clock.now
  let value = try await body()
  log(String(format: "%@: %.2fs", name, seconds(clock.now - t)))
  return value
}

/// Audio only, resampled by AVAssetReader: the 4K picture is never decoded.
func decodeMono(_ url: URL, rate: Double = 8000) async throws -> [Float] {
  let asset = AVURLAsset(url: url)
  guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw NSError(domain: "no audio", code: 1) }
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
  ])
  reader.add(output)
  reader.startReading()
  var samples: [Float] = []
  while let buffer = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(buffer) {
    let length = CMBlockBufferGetDataLength(block)
    var chunk = [Float](repeating: 0, count: length / 4)
    _ = chunk.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
    samples.append(contentsOf: chunk)
  }
  return samples
}

/// 10 ms onset envelope: positive change in log energy, level-independent like sync.ts's coarse stage.
func onsetEnvelope(_ x: [Float], hop: Int = 80) -> [Float] {
  let cells = x.count / hop
  var energy = [Float](repeating: 0, count: cells)
  x.withUnsafeBufferPointer { p in
    for i in 0..<cells { var e: Float = 0; vDSP_svesq(p.baseAddress! + i * hop, 1, &e, vDSP_Length(hop)); energy[i] = log10(e + 1e-6) }
  }
  var onset = [Float](repeating: 0, count: cells)
  for i in 1..<cells { onset[i] = max(0, energy[i] - energy[i - 1]) }
  var mean: Float = 0, sd: Float = 0
  vDSP_normalize(onset, 1, &onset, 1, &mean, &sd, vDSP_Length(cells))
  return onset
}

/// Correlation of `memo` against `video` at every lag where the memo starts
/// inside the video (or up to half its length before), via vDSP_conv.
func bestLag(video: [Float], memo: [Float]) -> (lagCells: Int, ratio: Float) {
  let pad = memo.count / 2
  let padded = [Float](repeating: 0, count: pad) + video + [Float](repeating: 0, count: memo.count)
  let lags = video.count + pad
  var out = [Float](repeating: 0, count: lags)
  vDSP_conv(padded, 1, memo, 1, &out, 1, vDSP_Length(lags), vDSP_Length(memo.count))
  var peak: Float = 0; var at: vDSP_Length = 0
  vDSP_maxvi(out, 1, &peak, &at, vDSP_Length(lags))
  // Runner-up outside ±0.5 s of the peak, for a confidence ratio like sync.ts.
  var second: Float = 0
  for (i, v) in out.enumerated() where abs(i - Int(at)) > 50 { second = max(second, v) }
  return (Int(at) - pad, peak / max(second, 1e-6))
}

/// Fine lag: plain correlation of raw 8 kHz samples within ±50 ms, over a 16 s window mid-memo.
func refine(video: [Float], memo: [Float], coarseSamples: Int) -> Double {
  let window = min(1 << 17, memo.count / 2)
  let memoStart = memo.count / 4
  let search = 400
  let videoStart = memoStart + coarseSamples - search
  guard videoStart >= 0, videoStart + window + 2 * search <= video.count else { return Double(coarseSamples) / 8000 }
  var out = [Float](repeating: 0, count: 2 * search)
  Array(video[videoStart..<(videoStart + window + 2 * search)]).withUnsafeBufferPointer { v in
    Array(memo[memoStart..<(memoStart + window)]).withUnsafeBufferPointer { m in
      vDSP_conv(v.baseAddress!, 1, m.baseAddress!, 1, &out, 1, vDSP_Length(2 * search), vDSP_Length(window))
    }
  }
  var peak: Float = 0; var at: vDSP_Length = 0
  vDSP_maxvi(out, 1, &peak, &at, vDSP_Length(out.count))
  return Double(coarseSamples - search + Int(at)) / 8000
}

final class LaughterObserver: NSObject, SNResultsObserving {
  var windows: [(start: Double, end: Double, confidence: Double)] = []
  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let result = result as? SNClassificationResult,
          let laugh = result.classification(forIdentifier: "laughter"), laugh.confidence > 0.5 else { return }
    windows.append((result.timeRange.start.seconds, result.timeRange.end.seconds, laugh.confidence))
  }
}

/// Merge overlapping 1.5 s classifier windows into laughter spans.
func spans(_ windows: [(start: Double, end: Double, confidence: Double)]) -> [(Double, Double)] {
  var merged: [(Double, Double)] = []
  for w in windows.sorted(by: { $0.start < $1.start }) {
    if let last = merged.last, w.start <= last.1 + 0.25 { merged[merged.count - 1].1 = max(last.1, w.end) } else { merged.append((w.start, w.end)) }
  }
  return merged
}

func transcribe(_ url: URL) async throws -> [(word: String, start: Double, end: Double)] {
  let transcriber = SpeechTranscriber(locale: Locale(identifier: "en-US"), transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
  if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    log("speech model not installed; downloading (one-time, OS-shared)")
    try await install.downloadAndInstall()
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let collect = Task { () -> [(String, Double, Double)] in
    var words: [(String, Double, Double)] = []
    for try await result in transcriber.results where result.isFinal {
      for run in result.text.runs {
        guard let range = run.audioTimeRange else { continue }
        let text = String(result.text[run.range].characters).trimmingCharacters(in: .whitespaces)
        if !text.isEmpty { words.append((text, range.start.seconds, range.end.seconds)) }
      }
    }
    return words
  }
  let file = try AVAudioFile(forReading: url)
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await collect.value
}

func faces(_ url: URL, fps: Double = 2) async throws -> (samples: Int, found: Int) {
  let asset = AVURLAsset(url: url)
  let duration = try await asset.load(.duration).seconds
  let generator = AVAssetImageGenerator(asset: asset)
  generator.maximumSize = CGSize(width: 640, height: 640)
  generator.appliesPreferredTrackTransform = true
  // Nearest decodable frame is plenty for framing; exact frames cost a decode per GOP.
  generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
  generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)
  let times = stride(from: 0.0, to: duration, by: 1 / fps).map { CMTime(seconds: $0, preferredTimescale: 600) }
  var found = 0
  for await result in generator.images(for: times) {
    guard let image = try? result.image else { continue }
    let request = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(cgImage: image).perform([request])
    if !(request.results ?? []).isEmpty { found += 1 }
  }
  return (times.count, found)
}

@main
struct StandupNative {
  static func main() async throws {
    let args = CommandLine.arguments
    guard args.count == 3 else { print("usage: standup-native <video> <memo>"); return }
    let videoURL = URL(fileURLWithPath: args[1]), memoURL = URL(fileURLWithPath: args[2])

    async let videoAudio = timed("decode video audio @8k (no picture decode)") { try await decodeMono(videoURL) }
    async let memoAudio = timed("decode memo @8k") { try await decodeMono(memoURL) }
    let (v, m) = try await (videoAudio, memoAudio)
    let lag = await timed("sync (coarse envelope + fine)") { () -> Double in
      let coarse = bestLag(video: onsetEnvelope(v), memo: onsetEnvelope(m))
      let fine = refine(video: v, memo: m, coarseSamples: coarse.lagCells * 80)
      log(String(format: "  coarse lag %.2fs (peak ratio %.1f), fine lag %.3fs", Double(coarse.lagCells) / 100, coarse.ratio, fine))
      return fine
    }

    // Everything below is independent: run it concurrently, like the phone would.
    async let laughter = timed("laughter (SoundAnalysis, memo)") { () -> [(Double, Double)] in
      let analyzer = try SNAudioFileAnalyzer(url: memoURL)
      let observer = LaughterObserver()
      try analyzer.add(SNClassifySoundRequest(classifierIdentifier: .version1), withObserver: observer)
      await analyzer.analyze()
      return spans(observer.windows)
    }
    async let words = timed("words (SpeechAnalyzer, memo)") { try await transcribe(memoURL) }
    async let faceScan = timed("faces (Vision, 2 fps @640px)") { try await faces(videoURL) }

    let (l, w, f) = try await (laughter, words, faceScan)
    log("laughter spans: \(l.count) → " + l.prefix(8).map { String(format: "%.1f-%.1f", $0.0 + lag, $0.1 + lag) }.joined(separator: ", ") + " (video time)")
    log("words: \(w.count); first: " + w.prefix(12).map(\.word).joined(separator: " "))
    log("faces: \(f.found)/\(f.samples) sampled frames had a face")
    let report: [String: Any] = [
      "lagSeconds": lag, "laughterSpans": l.map { [$0.0, $0.1] },
      "words": w.map { ["w": $0.word, "s": $0.start, "e": $0.end] }, "faceFrames": [f.found, f.samples],
    ]
    let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("standup-native.json")
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]).write(to: out)
    log("total; report at \(out.path)")
  }
}
