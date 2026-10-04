import Foundation

// The analysis ports. `Asset` is the adapter set's media handle (AVAsset today): a source
// loads it, the analyzers read it.

/// Resolves a ref (a Photos localIdentifier or a file:// URI) to media.
public protocol MediaSource<Asset>: PortAdapter {
  associatedtype Asset
  /// `onDownload` gets iCloud download progress (0...1) when the original has to be fetched.
  func load(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)?) async throws -> Asset
  /// True for the source errors an analyzer part reports as `unavailable` (retry later), not `failed`.
  func isUnavailable(_ error: Error) -> Bool
}

/// The whole recording as mono Float32 at `rate`.
public protocol AudioDecoder<Asset>: PortAdapter {
  associatedtype Asset
  func decodeMono(_ asset: Asset, rate: Double, progress: AnalyzerProgress?) async throws -> [Float]
}

/// transcriptResultSchema data with word times (the `words` part).
public protocol Transcriber<Asset>: PortAdapter {
  associatedtype Asset
  func words(_ asset: Asset, locale: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?, gate: AnalyzerGate?) async -> PartResult
}

/// Laughter spans with confidence (the `laughter` part).
public protocol SoundClassifier<Asset>: PortAdapter {
  associatedtype Asset
  func laughter(_ asset: Asset, minConfidence: Double, progress: AnalyzerProgress?) async -> PartResult
}

/// faceTrackSchema data, one sample per 1/fps (the `faces` part).
public protocol FaceDetector<Asset>: PortAdapter {
  associatedtype Asset
  func faces(_ asset: Asset, fps: Double, progress: AnalyzerProgress?, gate: AnalyzerGate?) async -> PartResult
}

/// Writes the 1080p preview proxy to `output` and describes it (the `proxy` part).
public protocol Proxy<Asset>: PortAdapter {
  associatedtype Asset
  func make(_ asset: Asset, to output: URL, progress: AnalyzerProgress?) async throws -> [String: Any]
}
