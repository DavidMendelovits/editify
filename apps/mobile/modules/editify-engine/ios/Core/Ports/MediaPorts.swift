import Foundation

// The analysis ports. `Asset` is the adapter set's media handle (AVAsset today): a source
// loads it, the analyzers read it.

/// Resolves a ref (a Photos localIdentifier or a file:// URI) to media, and answers what the
/// local media registry asks of the user's library (read access, probes, originals).
public protocol MediaSource<Asset>: PortAdapter {
  associatedtype Asset
  /// `onDownload` gets iCloud download progress (0...1) when the original has to be fetched.
  func load(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)?) async throws -> Asset
  /// True for the source errors an analyzer part reports as `unavailable` (retry later), not `failed`.
  func isUnavailable(_ error: Error) -> Bool
  /// True when `load(allowNetwork: false)` failed only because the original is in iCloud.
  func isInCloud(_ error: Error) -> Bool
  /// What identifies the media in the registry (OV2): {duration, bytes, audio, color, geometry}.
  func fingerprint(_ asset: Asset) async throws -> [String: Any]
  /// {status: ok | icloud | unreachable | missing | failed, ...} for a ref, never throwing but on cancel.
  func probe(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)?) async throws -> [String: Any]
  /// {width, height, rotation} of a ref's picture, never downloading; nil when unreadable.
  func geometry(_ ref: String) async -> [String: Any]?
  /// A Photos still's original bytes and its UTI, never downloading.
  func originalImageData(_ ref: String) async throws -> (data: Data, type: String?)
  /// A Photos original's resource written to a new temporary file, never downloading.
  func exportOriginal(_ ref: String) async throws -> (url: URL, bytes: Int64, name: String)
  /// Library read access, without prompting: 'all' | 'limited' | 'denied' | 'undetermined'.
  var photosAccess: String { get }
  /// Shows the system prompt when access was never asked for; answers the access after it.
  func requestPhotosAccess() async -> String
}

/// The whole recording as mono Float32 at `rate`.
public protocol AudioDecoder<Asset>: PortAdapter {
  associatedtype Asset
  func decodeMono(_ asset: Asset, rate: Double, progress: AnalyzerProgress?) async throws -> [Float]
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

/// Writes the 1080p preview proxy to `output` and describes it (the `proxy` part), and the
/// small H.264 style proxy Gemini gets instead of the original.
public protocol Proxy<Asset>: PortAdapter {
  associatedtype Asset
  func make(_ asset: Asset, to output: URL, progress: AnalyzerProgress?) async throws -> [String: Any]
  /// {uri, width, height, seconds, bytes, exportMs}: at most `maxHeight` tall, in a temp file.
  func makeStyleProxy(_ asset: Asset, maxHeight: Double) async throws -> [String: Any]
}
