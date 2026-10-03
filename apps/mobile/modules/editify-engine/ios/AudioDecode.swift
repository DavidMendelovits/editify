import AVFoundation
import CoreMedia
import Foundation

// What the analyzers, the media fingerprint and the proxy writer share: progress and gate
// callbacks, the error types they report, the analysis queue, and the pull-based
// audio reader. Kept free of Speech/Vision/Photos so the macOS harnesses under
// parity/ can compile it next to the files they test.

/// `gate` is awaited between chunks/frames: the scheduler (8A) uses it to hold a
/// heavy analyzer while the user plays or scrubs, or the phone runs hot. It
/// answers false when the analyzer should stop (its part was cancelled).
typealias AnalyzerGate = @Sendable () async -> Bool
typealias AnalyzerProgress = @Sendable (Double) -> Void

struct NoAudio: Error, LocalizedError {
  var errorDescription: String? { "The recording has no audio track" }
}

struct NoVideo: Error, LocalizedError {
  var errorDescription: String? { "The recording has no video track" }
}

struct InvalidArgument: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// Bounds on what JS may pass in. A sample rate AVAssetReader can't use raises an
/// uncaught NSException inside AVAssetReaderTrackOutput, so it is rejected up front.
enum AnalyzerLimits {
  static let sampleRates = 8_000.0...48_000.0

  static func sampleRate(_ rate: Double) throws -> Double {
    guard rate.isFinite, sampleRates.contains(rate) else {
      throw InvalidArgument(message: "sampleRate must be a number from 8000 to 48000 Hz, got \(rate)")
    }
    return rate
  }

  /// Face samples per second, kept in (0, 30]; a non-number or non-positive value means the default 2.
  static func facesFps(_ fps: Double) -> Double { fps.isFinite && fps > 0 ? min(30, max(0.05, fps)) : 2 }

  /// Proxy height in [144, 1080]; a non-number means the default 360.
  static func proxyHeight(_ height: Double) -> Double { height.isFinite ? min(1080, max(144, height)) : 360 }
}

/// Where the analyzers' blocking calls run (AVAssetReader pulls, SoundAnalysis, Vision),
/// so they never hold a thread of Swift's cooperative pool. Concurrent: the light lane,
/// the heavy lane and a sync can each have a call in flight. No QoS of its own: work
/// inherits the caller's, so the scheduler's lanes run at utility while a direct call
/// from JS (or a lab run) keeps its higher priority (utility measured ~1.4x slower).
enum AnalysisQueue {
  private static let queue = DispatchQueue(label: "editify.analysis", attributes: .concurrent)

  static func run<T>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { continuation.resume(with: Result { try body() }) }
    }
  }
}

/// Set once from a cancellation handler, read from analyzer loops on other threads.
final class CancelFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  var isSet: Bool { lock.withLock { value } }
  func set() { lock.withLock { value = true } }
}

/// Pull-based audio reader: AVAssetReader resamples the first audio track to
/// mono Float32 at `rate`, one sample buffer per `next()`. The picture is never
/// decoded. Pull-based so a slow consumer (SpeechAnalyzer) applies backpressure
/// instead of the whole recording piling up in memory. `next()` blocks: call it
/// through `AnalysisQueue`.
///
/// TODO(P2 follow-up 10): positions count from the first decoded sample; offset them by
/// the first buffer's presentation time for tracks that don't start at zero.
final class PCMChunks: @unchecked Sendable {
  let rate: Double
  let durationSeconds: Double
  private let reader: AVAssetReader
  private let output: AVAssetReaderTrackOutput
  private var position = 0

  /// `limitSeconds` reads only the start (the media fingerprint's first 20 s).
  init(asset: AVAsset, rate: Double, limitSeconds: Double? = nil) async throws {
    self.rate = try AnalyzerLimits.sampleRate(rate)
    guard let track = try await firstEnabledTrack(asset, .audio) else { throw NoAudio() }
    let total = try await asset.load(.duration).seconds
    durationSeconds = limitSeconds.map { min($0, total) } ?? total
    reader = try AVAssetReader(asset: asset)
    if let limitSeconds {
      reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: limitSeconds, preferredTimescale: 48_000))
    }
    output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
      AVLinearPCMIsBigEndianKey: false,
    ])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? EngineError(message: "could not start reading audio") }
  }

  /// The next chunk and its first frame's index, or nil at the end.
  func next() throws -> (samples: [Float], position: Int)? {
    while let buffer = output.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      guard length >= 4 else { continue }
      var chunk = [Float](repeating: 0, count: length / 4)
      _ = chunk.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
      let start = position
      position += chunk.count
      return (chunk, start)
    }
    if reader.status == .failed { throw reader.error ?? EngineError(message: "audio decode failed") }
    return nil
  }

  func fraction(at position: Int) -> Double {
    durationSeconds > 0 ? min(1, Double(position) / rate / durationSeconds) : 0
  }

  func cancel() { reader.cancelReading() }

  static func buffer(_ samples: [Float], format: AVAudioFormat) -> AVAudioPCMBuffer? {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count)
    }
    return buffer
  }
}

/// A failure with only a message to give (an AVFoundation call that returned no error).
struct EngineError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

/// The first track of `type` that is enabled: a file can carry a disabled alternate
/// (a commentary, a muted original) ahead of the one that plays. Falls back to the
/// first track when none is marked enabled.
func firstEnabledTrack(_ asset: AVAsset, _ type: AVMediaType) async throws -> AVAssetTrack? {
  let tracks = try await asset.loadTracks(withMediaType: type)
  for track in tracks where try await track.load(.isEnabled) { return track }
  return tracks.first
}
