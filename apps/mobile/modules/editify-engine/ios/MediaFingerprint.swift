import AVFoundation
import CoreMedia
import Foundation

/// What identifies a source in the local media registry (decision 3A + OV2): its
/// duration, its size on disk, a short audio fingerprint and its color. Stored at
/// import from the file that was uploaded, and recomputed when a clip is resolved,
/// so local-media.ts can tell "this is still the clip the project was cut against"
/// from "this was changed in Photos".
///
///   AVAsset ─┬─ duration, color (the video track's transfer function)
///            ├─ bytes (the file behind an AVURLAsset; 0 when there is none)
///            └─ PCMChunks 8 kHz, first 20 s ─▶ AnalysisMath.energy ─▶ envelopeHash
enum MediaFingerprint {
  /// Long enough that two different takes disagree, short enough to read in well under a second.
  static let audioSeconds = 20.0

  /// {duration, bytes, audio (envelope hash, or null without an audio track), color ('hlg' | 'pq' | 'log' | 'sdr', or null without video)}.
  static func compute(_ asset: AVAsset) async throws -> [String: Any] {
    let duration = try await asset.load(.duration).seconds
    var bytes = 0
    if let url = (asset as? AVURLAsset)?.url, url.isFileURL {
      bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }
    let color = try await colorName(asset)
    let audio = try await audioHash(asset)
    return [
      "duration": round3(duration),
      "bytes": bytes,
      "audio": audio ?? NSNull(),
      "color": color ?? NSNull(),
    ]
  }

  /// The envelope hash of the first `audioSeconds`, or nil when there is no audio track.
  static func audioHash(_ asset: AVAsset) async throws -> String? {
    let chunks: PCMChunks
    do {
      chunks = try await PCMChunks(asset: asset, rate: Double(AudioSync.sampleRate), limitSeconds: audioSeconds)
    } catch is NoAudio {
      return nil
    }
    let stop = CancelFlag()
    let samples = try await withTaskCancellationHandler {
      try await AnalysisQueue.run { () -> [Float] in
        var samples: [Float] = []
        samples.reserveCapacity(Int(audioSeconds) * AudioSync.sampleRate)
        while let (chunk, _) = try chunks.next() {
          samples.append(contentsOf: chunk)
          if stop.isSet { chunks.cancel(); throw CancellationError() }
        }
        return samples
      }
    } onCancel: {
      stop.set()
    }
    let cells = Int(audioSeconds / AnalysisMath.energyCellSeconds)
    return AnalysisMath.envelopeHash(Array(AnalysisMath.energy(samples, sampleRate: AudioSync.sampleRate).prefix(cells)))
  }

  /// The first video track's transfer function as the registry names it; nil without video.
  static func colorName(_ asset: AVAsset) async throws -> String? {
    guard let track = try await firstEnabledTrack(asset, .video) else { return nil }
    let formats = try await track.load(.formatDescriptions)
    return ColorTags(formats.first).name
  }
}

/// A video track's color tags and bit depth, read from its format description.
/// `hdr` is HLG or PQ; `tenBit` also covers Apple Log and other deeper-than-8-bit sources.
struct ColorTags {
  var primaries: String?
  var transfer: String?
  var matrix: String?
  var bits: Int?
  /// Apple Log and other log curves sit in their own extension, not the transfer function.
  var log: String?

  init(_ format: CMFormatDescription?) {
    guard let format else { return }
    primaries = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_ColorPrimaries) as? String
    transfer = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String
    matrix = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_YCbCrMatrix) as? String
    bits = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_BitsPerComponent) as? Int
    log = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_LogTransferFunction) as? String
  }

  var isHLG: Bool { transfer == (kCVImageBufferTransferFunction_ITU_R_2100_HLG as String) }
  var isPQ: Bool { transfer == (kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ as String) }
  var isAppleLog: Bool { log != nil }
  var hdr: Bool { isHLG || isPQ }
  var tenBit: Bool { hdr || isAppleLog || (bits ?? 8) > 8 }
  /// Any color tag at all: the frames carry them, so the encoder can keep them.
  var tagged: Bool { primaries != nil || transfer != nil || matrix != nil || log != nil }
  var name: String { isHLG ? "hlg" : isPQ ? "pq" : isAppleLog ? "log" : "sdr" }
}
