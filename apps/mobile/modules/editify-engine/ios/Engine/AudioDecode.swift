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
/// Positions are frames from the start of the recording (D19): the first buffer's
/// presentation time sets the origin, so a track that starts 1.5 s in (an edit list's empty
/// edit) or a read of `range` starting at 48 s reports positions from there, not from 0.
/// Word and laughter times follow them (the words and laughter versions moved with this).
final class PCMChunks: @unchecked Sendable {
  let rate: Double
  let durationSeconds: Double
  /// Where the read starts in the recording (`range`'s lower bound, else 0).
  let startSeconds: Double
  private let reader: AVAssetReader
  private let output: AVAssetReaderTrackOutput
  /// The next sample's frame in the recording; set from the first buffer's presentation time.
  private var position: Int?

  /// `limitSeconds` reads only the start (the media fingerprint's first 20 s); `range` only that
  /// span of the recording, in seconds (the SFSpeech adapter's chunks).
  init(asset: AVAsset, rate: Double, limitSeconds: Double? = nil, range: Range<Double>? = nil) async throws {
    self.rate = try AnalyzerLimits.sampleRate(rate)
    guard let track = try await firstEnabledTrack(asset, .audio) else { throw NoAudio() }
    let total = try await asset.load(.duration).seconds
    reader = try AVAssetReader(asset: asset)
    if let range {
      let start = max(0, range.lowerBound), end = min(total, range.upperBound)
      startSeconds = start
      durationSeconds = max(0, end - start)
      reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 48_000), end: CMTime(seconds: end, preferredTimescale: 48_000))
    } else {
      startSeconds = 0
      durationSeconds = limitSeconds.map { min($0, total) } ?? total
      if let limitSeconds {
        reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: limitSeconds, preferredTimescale: 48_000))
      }
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
      let start = position ?? Self.origin(CMSampleBufferGetPresentationTimeStamp(buffer), rate: rate)
      position = start + chunk.count
      return (chunk, start)
    }
    if reader.status == .failed { throw reader.error ?? EngineError(message: "audio decode failed") }
    return nil
  }

  /// The first buffer's frame in the recording (0 for a missing or negative time).
  static func origin(_ time: CMTime, rate: Double) -> Int {
    guard time.isNumeric, time.seconds.isFinite else { return 0 }
    return max(0, Int((time.seconds * rate).rounded()))
  }

  func fraction(at position: Int) -> Double {
    durationSeconds > 0 ? min(1, max(0, Double(position) / rate - startSeconds) / durationSeconds) : 0
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
