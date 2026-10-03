import AVFoundation
import Photos

/// Resolves a lab asset ref to an AVAsset: `file://…` (Files/share imports) or a
/// PHAsset localIdentifier (decision D5: Photos clips are referenced, never copied).
///
/// Photos loads ask for `.original` (decision 3A + OV2): an edit made in Photos after
/// import never changes what the project was cut against. The registry fingerprints
/// the uploaded file and compares it with this original, so a clip that was already
/// edited when it was picked shows up as "changed in Photos" instead of shifting cuts.
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
    // Without access, PhotoKit isn't touched at all (fetching would only fail, and some
    // calls log or prompt); the ref is simply not reachable from here.
    guard hasPhotosAccess() else { throw NotFound(ref: ref) }
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else { throw NotFound(ref: ref) }
    let options = PHVideoRequestOptions()
    options.isNetworkAccessAllowed = allowNetwork
    options.deliveryMode = .highQualityFormat
    options.version = .original
    if let onDownload {
      options.progressHandler = { value, _, _, _ in onDownload(value) }
    }
    let request = PhotosRequest()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        // Already cancelled: resumed with CancellationError, no request issued.
        guard request.begin(continuation) else { return }
        let id = PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, info in
          if let avAsset { return request.finish(.success(avAsset)) }
          if (info?[PHImageCancelledKey] as? Bool) == true { return request.finish(.failure(CancellationError())) }
          let error = info?[PHImageErrorKey] as? Error
          if (info?[PHImageResultIsInCloudKey] as? Bool) == true {
            request.finish(.failure(allowNetwork ? Unreachable(ref: ref, reason: error?.localizedDescription ?? "no data") : InCloud(ref: ref)))
          } else if let error, isNetworkError(error) {
            request.finish(.failure(Unreachable(ref: ref, reason: error.localizedDescription)))
          } else {
            request.finish(.failure(error ?? NotFound(ref: ref)))
          }
        }
        request.started(id)
      }
    } onCancel: {
      request.cancel()
    }
  }

  /// MediaGeometry for a ref (file:// URI or PHAsset id), never downloading: an image file
  /// by its header, a Photos still by its PHAsset size (already upright, so rotation 0), a
  /// video by its track. nil when there is no picture or the source can't be read.
  static func geometry(_ ref: String) async -> [String: Any]? {
    if ref.hasPrefix("file://") {
      guard let url = URL(string: ref) else { return nil }
      if let image = MediaGeometry.ofImage(url) { return image }
      return try? await MediaGeometry.of(AVURLAsset(url: url))
    }
    guard hasPhotosAccess(), let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else { return nil }
    if asset.mediaType == .image {
      // The ORIGINAL's header, the bytes the export draws (PHAsset.pixelWidth/Height describe
      // the edited version when the photo was edited in Photos).
      guard let original = try? await originalImageData(ref) else { return nil }
      return MediaGeometry.ofImage(data: original.0)
    }
    guard let loaded = try? await load(ref, allowNetwork: false) else { return nil }
    return try? await MediaGeometry.of(loaded)
  }

  /// A Photos still's original bytes (`.original`, never downloading) and its UTI.
  static func originalImageData(_ ref: String) async throws -> (Data, String?) {
    guard hasPhotosAccess(), let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else { throw NotFound(ref: ref) }
    let options = PHImageRequestOptions()
    options.version = .original
    options.isNetworkAccessAllowed = false
    options.deliveryMode = .highQualityFormat
    return try await withCheckedThrowingContinuation { continuation in
      PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, type, _, info in
        if let data { continuation.resume(returning: (data, type)) } else {
          continuation.resume(throwing: (info?[PHImageErrorKey] as? Error) ?? NotFound(ref: ref))
        }
      }
    }
  }

  /// Photos library access as the registry names it, read without prompting:
  /// 'all' | 'limited' | 'denied' | 'undetermined'. Only 'all' can load an arbitrary
  /// picked PHAsset later; the app never asks (the system picker needs no permission).
  static func photosAccess() -> String {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .authorized: return "all"
    case .limited: return "limited"
    case .notDetermined: return "undetermined"
    default: return "denied"
    }
  }

  /// Full or limited access: the only states in which PhotoKit may be asked for an asset.
  static func hasPhotosAccess() -> Bool {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    return status == .authorized || status == .limited
  }

  /// Shows the system Photos prompt when access was never asked for, and answers the
  /// resulting `photosAccess()`. Once asked, iOS never shows it again; this then just reads.
  static func requestPhotosAccess() async -> String {
    if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
      _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }
    return photosAccess()
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

/// One Photos request: its id and its continuation, resumed exactly once. A cancel
/// resumes with CancellationError right away and then cancels the request, since
/// Photos doesn't document calling the handler after `cancelImageRequest`; any later
/// handler call is ignored. A cancel that lands before the id arrives is applied then.
private final class PhotosRequest: @unchecked Sendable {
  private let lock = NSLock()
  private var id: PHImageRequestID?
  private var continuation: CheckedContinuation<AVAsset, Error>?
  private var cancelled = false

  /// False when the task was already cancelled (the continuation is resumed here, and
  /// no request should be issued).
  func begin(_ continuation: CheckedContinuation<AVAsset, Error>) -> Bool {
    let cancelNow = lock.withLock { () -> Bool in
      if cancelled { return true }
      self.continuation = continuation
      return false
    }
    if cancelNow { continuation.resume(throwing: CancellationError()) }
    return !cancelNow
  }

  func finish(_ result: Result<AVAsset, Error>) {
    let waiting = lock.withLock { () -> CheckedContinuation<AVAsset, Error>? in
      defer { continuation = nil }
      return continuation
    }
    waiting?.resume(with: result)
  }

  func started(_ id: PHImageRequestID) {
    let cancelNow = lock.withLock { () -> Bool in
      self.id = id
      return cancelled
    }
    if cancelNow { PHImageManager.default().cancelImageRequest(id) }
  }

  func cancel() {
    let (id, waiting) = lock.withLock { () -> (PHImageRequestID?, CheckedContinuation<AVAsset, Error>?) in
      cancelled = true
      defer { continuation = nil }
      return (self.id, continuation)
    }
    waiting?.resume(throwing: CancellationError())
    if let id { PHImageManager.default().cancelImageRequest(id) }
  }
}

extension AssetSource {
  /// The native half of the media ladder (local-media.ts `resolveMedia`): loads `ref`
  /// and fingerprints what it finds. Never throws; the outcome is one of
  ///   {status: 'ok', fingerprint}            the original is on the device
  ///   {status: 'icloud'}                     offloaded, and `allowNetwork` was false
  ///   {status: 'unreachable', error}         in iCloud and the download failed (offline)
  ///   {status: 'missing', access}            deleted, outside a Limited selection, or no access
  ///   {status: 'failed', error}              anything else (an unreadable file)
  /// A cancel of the calling task cancels the Photos request and rejects with CancellationError.
  static func probe(_ ref: String, allowNetwork: Bool, onDownload: (@Sendable (Double) -> Void)? = nil) async throws -> [String: Any] {
    if ref.hasPrefix("file://") {
      guard let url = URL(string: ref), FileManager.default.fileExists(atPath: url.path) else {
        return ["status": "missing", "access": "all"]
      }
    }
    do {
      let asset = try await load(ref, allowNetwork: allowNetwork, onDownload: onDownload)
      return ["status": "ok", "fingerprint": try await MediaFingerprint.compute(asset)]
    } catch is CancellationError {
      throw CancellationError()
    } catch is NotFound {
      return ["status": "missing", "access": photosAccess()]
    } catch is InCloud {
      return ["status": "icloud"]
    } catch let error as Unreachable {
      return ["status": "unreachable", "error": error.localizedDescription]
    } catch {
      return ["status": "failed", "error": error.localizedDescription]
    }
  }
}

extension AssetSource {
  /// Writes a PHAsset's original resource (the file Photos keeps, never an edited render)
  /// to a new file under the temporary folder, never downloading, for an upload the server
  /// is missing (plan OV1, "upload clips X"). The caller removes the file afterwards.
  static func exportOriginal(_ ref: String) async throws -> (url: URL, bytes: Int64) {
    guard hasPhotosAccess(), let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else { throw NotFound(ref: ref) }
    let resources = PHAssetResource.assetResources(for: asset)
    // `.video` / `.photo` / `.audio` are the originals; the `fullSize…` types are Photos edits.
    let wanted: PHAssetResourceType = switch asset.mediaType {
    case .video: .video
    case .audio: .audio
    default: .photo
    }
    guard let resource = resources.first(where: { $0.type == wanted }) else { throw NotFound(ref: ref) }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("editify-uploads", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let ext = (resource.originalFilename as NSString).pathExtension
    let target = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext.isEmpty ? "mov" : ext)
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = false
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      PHAssetResourceManager.default().writeData(for: resource, toFile: target, options: options) { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
    let bytes = ((try? FileManager.default.attributesOfItem(atPath: target.path))?[.size] as? NSNumber)?.int64Value ?? 0
    return (target, bytes)
  }
}
