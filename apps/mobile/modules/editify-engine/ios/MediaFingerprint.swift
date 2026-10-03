import AVFoundation
import CoreMedia
import Foundation
import ImageIO

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

  /// {duration, bytes, audio (envelope hash, or null without an audio track), color ('hlg' | 'pq' | 'log' | 'sdr', or null without video),
  /// geometry ({width, height, rotation} of the video track, or null without video)}.
  static func compute(_ asset: AVAsset) async throws -> [String: Any] {
    let duration = try await asset.load(.duration).seconds
    var bytes = 0
    if let url = (asset as? AVURLAsset)?.url, url.isFileURL {
      bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }
    let color = try await colorName(asset)
    let audio = try await audioHash(asset)
    let geometry = try await MediaGeometry.of(asset)
    return [
      "duration": round3(duration),
      "bytes": bytes,
      "audio": audio ?? NSNull(),
      "color": color ?? NSNull(),
      "geometry": geometry ?? NSNull(),
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

/// A source's stored pixel size and the clockwise rotation (0, 90, 180, 270) that shows it
/// upright: what buildRenderPlan's PlanAssetInfo needs (width, height, rotation). The
/// server's asset records keep the coded size with no display matrix, so a portrait phone
/// clip or a rotated photo would otherwise be laid out sideways.
///
/// Video: the first video track's naturalSize and preferredTransform. Stills: the image's
/// pixel size and EXIF orientation (a mirrored orientation counts as its rotation; the
/// renderer draws stills EXIF-upright either way, so only the box shape depends on it).
enum MediaGeometry {
  static func rotation(_ orientation: CGImagePropertyOrientation) -> Int {
    switch orientation {
    case .right, .leftMirrored: return 90
    case .down, .downMirrored: return 180
    case .left, .rightMirrored: return 270
    default: return 0
    }
  }

  static func of(_ asset: AVAsset) async throws -> [String: Any]? {
    guard let track = try await firstEnabledTrack(asset, .video) else { return nil }
    let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
    guard size.width > 0, size.height > 0 else { return nil }
    return ["width": Int(size.width.rounded()), "height": Int(size.height.rounded()),
            "rotation": rotation(AnalysisMath.orientation(of: transform))]
  }

  /// nil when `url` is not an image ImageIO can read.
  static func ofImage(_ url: URL) -> [String: Any]? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, width > 0, height > 0 else { return nil }
    let exif = (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    return ["width": width, "height": height, "rotation": rotation(CGImagePropertyOrientation(rawValue: exif) ?? .up)]
  }
}
