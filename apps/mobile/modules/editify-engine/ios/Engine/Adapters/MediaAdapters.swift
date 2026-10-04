import AVFoundation

// The analysis adapters: one per port, each today's code behind its port.

/// MediaSource adapter: PhotoKit originals and file:// URIs (AssetSource).
struct PhotoKitMediaSource: MediaSource {
  var name: String { "photokit" }

  func load(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)?) async throws -> AVAsset {
    try await AssetSource.load(ref, allowNetwork: allowNetwork, onDownload: onDownload)
  }

  func isUnavailable(_ error: Error) -> Bool { AssetSource.isUnavailable(error) }
}

/// AudioDecoder adapter: AVAssetReader through PCMChunks.
struct AssetReaderAudioDecoder: AudioDecoder {
  var name: String { "avassetreader" }

  func decodeMono(_ asset: AVAsset, rate: Double, progress: AnalyzerProgress?) async throws -> [Float] {
    try await Analyzers.decodeMono(asset, rate: rate, progress: progress)
  }
}

/// Transcriber adapter: SpeechAnalyzer + SpeechTranscriber (iOS 26).
struct SpeechAnalyzerTranscriber: Transcriber {
  var name: String { "speech-analyzer" }

  func words(_ asset: AVAsset, locale: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?, gate: AnalyzerGate?) async -> PartResult {
    await Analyzers.words(asset, locale: locale, allowModelDownload: allowModelDownload, progress: progress, gate: gate)
  }
}

/// SoundClassifier adapter: SoundAnalysis' built-in classifier.
struct SoundAnalysisClassifier: SoundClassifier {
  var name: String { "sound-analysis" }

  func laughter(_ asset: AVAsset, minConfidence: Double, progress: AnalyzerProgress?) async -> PartResult {
    await Analyzers.laughter(asset, minConfidence: minConfidence, progress: progress)
  }
}

/// FaceDetector adapter: Vision face rectangles.
struct VisionFaceDetector: FaceDetector {
  var name: String { "vision" }

  func faces(_ asset: AVAsset, fps: Double, progress: AnalyzerProgress?, gate: AnalyzerGate?) async -> PartResult {
    await Analyzers.faces(asset, fps: fps, progress: progress, gate: gate)
  }
}

/// Proxy adapter: the AVAssetWriter proxy pipeline.
struct WriterProxy: Proxy {
  var name: String { "writer" }

  func make(_ asset: AVAsset, to output: URL, progress: AnalyzerProgress?) async throws -> [String: Any] {
    try await ProxyPipeline.make(asset, to: output, progress: progress)
  }
}
