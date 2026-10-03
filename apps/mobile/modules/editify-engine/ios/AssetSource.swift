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
  /// The clip is in iCloud and could not be fetched (offline, or the download failed).
  struct Unreachable: Error, LocalizedError {
    let ref: String
    let reason: String
    var errorDescription: String? { "\(ref) is in iCloud and could not be downloaded: \(reason)" }
  }

  /// True for the source errors an analyzer part reports as `unavailable` (retry later), not `failed`.
  static func isUnavailable(_ error: Error) -> Bool {
    error is NotFound || error is InCloud || error is Unreachable
  }

  /// `onDownload` gets iCloud download progress (0…1) when the original has to be fetched.
  /// Cancelling the calling task cancels the Photos request.
  static func load(_ ref: String, allowNetwork: Bool = true, onDownload: (@Sendable (Double) -> Void)? = nil) async throws -> AVAsset {
    if ref.hasPrefix("file://"), let url = URL(string: ref) { return AVURLAsset(url: url) }
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else { throw NotFound(ref: ref) }
    let options = PHVideoRequestOptions()
    options.isNetworkAccessAllowed = allowNetwork
    options.deliveryMode = .highQualityFormat
    options.version = .current
    if let onDownload {
      options.progressHandler = { value, _, _, _ in onDownload(value) }
    }
    let request = PhotosRequest()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let id = PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, info in
          if let avAsset { return continuation.resume(returning: avAsset) }
          if (info?[PHImageCancelledKey] as? Bool) == true { return continuation.resume(throwing: CancellationError()) }
          let error = info?[PHImageErrorKey] as? Error
          if (info?[PHImageResultIsInCloudKey] as? Bool) == true {
            continuation.resume(throwing: allowNetwork ? Unreachable(ref: ref, reason: error?.localizedDescription ?? "no data") : InCloud(ref: ref))
          } else if let error, isNetworkError(error) {
            continuation.resume(throwing: Unreachable(ref: ref, reason: error.localizedDescription))
          } else {
            continuation.resume(throwing: error ?? NotFound(ref: ref))
          }
        }
        request.set(id)
      }
    } onCancel: {
      request.cancel()
    }
  }

  private static func isNetworkError(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain == NSURLErrorDomain || ns.domain == "CKErrorDomain" { return true }
    if ns.domain == PHPhotosErrorDomain {
      return ns.code == PHPhotosError.Code.networkAccessRequired.rawValue || ns.code == PHPhotosError.Code.networkError.rawValue
    }
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? Error { return isNetworkError(underlying) }
    return false
  }
}

/// The Photos request id, set after the request starts and read by a cancellation
/// handler on another thread; a cancel that lands first is applied when the id arrives.
private final class PhotosRequest: @unchecked Sendable {
  private let lock = NSLock()
  private var id: PHImageRequestID?
  private var cancelled = false

  func set(_ id: PHImageRequestID) {
    let cancelNow = lock.withLock { () -> Bool in
      self.id = id
      return cancelled
    }
    if cancelNow { PHImageManager.default().cancelImageRequest(id) }
  }

  func cancel() {
    let id = lock.withLock { () -> PHImageRequestID? in
      cancelled = true
      return self.id
    }
    if let id { PHImageManager.default().cancelImageRequest(id) }
  }
}
