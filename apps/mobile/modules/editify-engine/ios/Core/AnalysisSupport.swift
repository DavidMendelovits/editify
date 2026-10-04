import Foundation

// What the analyzers, the media fingerprint and the proxy writer share: progress and gate
// callbacks, the error types they report and the analysis queue. Domain only (EditifyCore):
// the pull-based audio reader they read through is Engine/AudioDecode.swift.

/// `gate` is awaited between chunks/frames: the scheduler (8A) uses it to hold a
/// heavy analyzer while the user plays or scrubs, or the phone runs hot. It
/// answers false when the analyzer should stop (its part was cancelled).
public typealias AnalyzerGate = @Sendable () async -> Bool
public typealias AnalyzerProgress = @Sendable (Double) -> Void

public struct NoAudio: Error, LocalizedError {
  public init() {}
  public var errorDescription: String? { "The recording has no audio track" }
}

public struct NoVideo: Error, LocalizedError {
  public init() {}
  public var errorDescription: String? { "The recording has no video track" }
}

public struct InvalidArgument: Error, LocalizedError {
  public let message: String
  public init(message: String) { self.message = message }
  public var errorDescription: String? { message }
}

/// Bounds on what JS may pass in. A sample rate AVAssetReader can't use raises an
/// uncaught NSException inside AVAssetReaderTrackOutput, so it is rejected up front.
public enum AnalyzerLimits {
  public static let sampleRates = 8_000.0...48_000.0

  public static func sampleRate(_ rate: Double) throws -> Double {
    guard rate.isFinite, sampleRates.contains(rate) else {
      throw InvalidArgument(message: "sampleRate must be a number from 8000 to 48000 Hz, got \(rate)")
    }
    return rate
  }

  /// Face samples per second, kept in (0, 30]; a non-number or non-positive value means the default 2.
  public static func facesFps(_ fps: Double) -> Double { fps.isFinite && fps > 0 ? min(30, max(0.05, fps)) : 2 }

  /// Proxy height in [144, 1080]; a non-number means the default 360.
  public static func proxyHeight(_ height: Double) -> Double { height.isFinite ? min(1080, max(144, height)) : 360 }
}

/// Where the analyzers' blocking calls run (AVAssetReader pulls, SoundAnalysis, Vision),
/// so they never hold a thread of Swift's cooperative pool. Concurrent: the light lane,
/// the heavy lane and a sync can each have a call in flight. No QoS of its own: work
/// inherits the caller's, so the scheduler's lanes run at utility while a direct call
/// from JS (or a lab run) keeps its higher priority (utility measured ~1.4x slower).
public enum AnalysisQueue {
  private static let queue = DispatchQueue(label: "editify.analysis", attributes: .concurrent)

  public static func run<T>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { continuation.resume(with: Result { try body() }) }
    }
  }
}

/// Set once from a cancellation handler, read from analyzer loops on other threads.
public final class CancelFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  public init() {}
  public var isSet: Bool { lock.withLock { value } }
  public func set() { lock.withLock { value = true } }
}

/// A failure with only a message to give (an AVFoundation call that returned no error).
public struct EngineError: Error, LocalizedError {
  public let message: String
  public init(message: String) { self.message = message }
  public var errorDescription: String? { message }
}

public func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
