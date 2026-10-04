import AVFoundation
import CoreMedia
import Foundation

// The pull-based audio reader the analyzers, the media fingerprint and the proxy writer
// share (the AudioDecoder adapter decodes through it). Kept free of Speech/Vision/Photos so
// the macOS harnesses under parity/ can compile it next to the files they test.

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

/// The first track of `type` that is enabled: a file can carry a disabled alternate
/// (a commentary, a muted original) ahead of the one that plays. Falls back to the
/// first track when none is marked enabled.
func firstEnabledTrack(_ asset: AVAsset, _ type: AVMediaType) async throws -> AVAssetTrack? {
  let tracks = try await asset.loadTracks(withMediaType: type)
  for track in tracks where try await track.load(.isEnabled) { return track }
  return tracks.first
}
