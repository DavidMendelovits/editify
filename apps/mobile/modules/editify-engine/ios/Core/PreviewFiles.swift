import Foundation

/// The native preview's files and downloads, Foundation only, so the macOS preview harness
/// (parity/preview) compiles and exercises them as they are.

/// Temp stills the preview wrote (Photos originals, server copies), deleted once no plan uses
/// them. `removeAll` (teardown) is final: a still that arrives after it (a download still
/// running at teardown) is deleted at once instead of being kept by no one.
public final class PreviewTempFiles: @unchecked Sendable {
  public struct Closed: Error, LocalizedError {
    public var errorDescription: String? { "the preview was closed" }
  }

  private let lock = NSLock()
  private var files = Set<URL>()
  private var closed = false

  public init() {}

  /// Takes ownership of a temp file. After `removeAll` the file is deleted and this throws.
  public func add(_ url: URL) throws {
    let kept = lock.withLock { () -> Bool in
      guard !closed else { return false }
      files.insert(url.standardizedFileURL)
      return true
    }
    guard kept else {
      try? FileManager.default.removeItem(at: url)
      throw Closed()
    }
  }

  /// Deletes every file not in `keep`.
  public func retain(only keep: Set<URL>) {
    let kept = Set(keep.map(\.standardizedFileURL))
    let gone = lock.withLock { () -> Set<URL> in
      let gone = files.subtracting(kept)
      files.subtract(gone)
      return gone
    }
    for url in gone { try? FileManager.default.removeItem(at: url) }
  }

  /// Deletes every file, and every file added from now on.
  public func removeAll() {
    lock.withLock { closed = true }
    retain(only: [])
  }

  public var count: Int { lock.withLock { files.count } }
}

/// One download on its own ephemeral session: refused when the server announces more than
/// `cap` bytes or sends more, and bounded by `timeout` for the whole transfer. The start,
/// a cancellation and every delegate callback run on the session's serial queue, so a
/// cancellation that lands before the start never creates a task on an invalidated session.
public final class CappedDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  public struct Refused: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
  }

  private let cap: Int64
  private let target: URL
  private var handle: FileHandle?
  private var written: Int64 = 0
  private var failure: Error?
  private var continuation: CheckedContinuation<Void, Error>?
  /// Set on the queue by a cancellation: the start, if it has not run, throws instead.
  private var cancelled = false

  private init(cap: Int64, target: URL) {
    self.cap = cap
    self.target = target
  }

  public static func run(_ url: URL, to target: URL, cap: Int64, timeout: TimeInterval) async throws {
    try Task.checkCancellation()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    configuration.urlCache = nil
    let delegate = CappedDownload(cap: cap, target: target)
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    defer { session.finishTasksAndInvalidate() }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        queue.addOperation {
          // Cancelled first: the session is invalidated, and a task made on it would raise.
          guard !delegate.cancelled else { return continuation.resume(throwing: CancellationError()) }
          delegate.continuation = continuation
          session.dataTask(with: url).resume()
        }
      }
    } onCancel: {
      // Serialized with the start (either order is safe): no task yet, and the start throws;
      // or the task exists, and invalidating cancels it (its completion resumes the caller).
      queue.addOperation {
        delegate.cancelled = true
        session.invalidateAndCancel()
      }
    }
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      failure = Refused(message: "the server copy of a still is unavailable")
      return completionHandler(.cancel)
    }
    guard response.expectedContentLength <= cap else {
      failure = Refused(message: "a still is over \(cap >> 20) MB")
      return completionHandler(.cancel)
    }
    guard FileManager.default.createFile(atPath: target.path, contents: nil), let handle = try? FileHandle(forWritingTo: target) else {
      failure = Refused(message: "could not write a still")
      return completionHandler(.cancel)
    }
    self.handle = handle
    completionHandler(.allow)
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    written += Int64(data.count)
    guard written <= cap else {
      failure = Refused(message: "a still is over \(cap >> 20) MB")
      dataTask.cancel()
      return
    }
    do { try handle?.write(contentsOf: data) } catch {
      failure = error
      dataTask.cancel()
    }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    try? handle?.close()
    handle = nil
    let continuation = self.continuation
    self.continuation = nil
    if let failure = failure ?? error { continuation?.resume(throwing: failure) } else { continuation?.resume() }
  }
}
