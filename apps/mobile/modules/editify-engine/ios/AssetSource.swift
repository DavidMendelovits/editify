import AVFoundation
import Photos

/// Resolves a lab asset ref to an AVAsset: `file://…` (Files/share imports) or a
/// PHAsset localIdentifier (decision D5: Photos clips are referenced, never copied).
enum AssetSource {
  struct NotFound: Error, LocalizedError {
    let ref: String
    var errorDescription: String? { "No asset for \(ref) (deleted, or outside a Limited Library selection)" }
  }
  struct InCloud: Error, LocalizedError {
    let ref: String
    var errorDescription: String? { "\(ref) is offloaded to iCloud and network access was not allowed" }
  }

  static func load(_ ref: String, allowNetwork: Bool = true) async throws -> AVAsset {
    if ref.hasPrefix("file://"), let url = URL(string: ref) { return AVURLAsset(url: url) }
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else { throw NotFound(ref: ref) }
    let options = PHVideoRequestOptions()
    options.isNetworkAccessAllowed = allowNetwork
    options.deliveryMode = .highQualityFormat
    options.version = .current
    return try await withCheckedThrowingContinuation { continuation in
      PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, info in
        if let avAsset { continuation.resume(returning: avAsset) }
        else if (info?[PHImageResultIsInCloudKey] as? Bool) == true { continuation.resume(throwing: InCloud(ref: ref)) }
        else { continuation.resume(throwing: (info?[PHImageErrorKey] as? Error) ?? NotFound(ref: ref)) }
      }
    }
  }
}
