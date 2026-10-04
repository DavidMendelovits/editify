import AVFoundation

// The analysis adapters: one per port, each today's code behind its port.

/// MediaSource adapter: PhotoKit originals and file:// URIs (AssetSource), fingerprinted by
/// MediaFingerprint.
struct PhotoKitMediaSource: MediaSource {
  var name: String { "photokit" }

  func load(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)?) async throws -> AVAsset {
    try await AssetSource.load(ref, allowNetwork: allowNetwork, onDownload: onDownload)
  }

  func isUnavailable(_ error: Error) -> Bool { AssetSource.isUnavailable(error) }
  func isInCloud(_ error: Error) -> Bool { error is AssetSource.InCloud }
  func fingerprint(_ asset: AVAsset) async throws -> [String: Any] { try await MediaFingerprint.compute(asset) }

  func probe(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)?) async throws -> [String: Any] {
    try await AssetSource.probe(ref, allowNetwork: allowNetwork, onDownload: onDownload)
  }

  func geometry(_ ref: String) async -> [String: Any]? { await AssetSource.geometry(ref) }

  func originalImageData(_ ref: String) async throws -> (data: Data, type: String?) {
    let (data, type) = try await AssetSource.originalImageData(ref)
    return (data, type)
  }

  func exportOriginal(_ ref: String) async throws -> (url: URL, bytes: Int64, name: String) { try await AssetSource.exportOriginal(ref) }
  var photosAccess: String { AssetSource.photosAccess() }
  func requestPhotosAccess() async -> String { await AssetSource.requestPhotosAccess() }
}

/// AudioDecoder adapter: AVAssetReader through PCMChunks.
struct AssetReaderAudioDecoder: AudioDecoder {
  var name: String { "avassetreader" }

  func decodeMono(_ asset: AVAsset, rate: Double, progress: AnalyzerProgress?) async throws -> [Float] {
    try await Analyzers.decodeMono(asset, rate: rate, progress: progress)
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

  func makeStyleProxy(_ asset: AVAsset, maxHeight: Double) async throws -> [String: Any] {
    try await Analyzers.makeProxy(asset, maxHeight: maxHeight)
  }
}
