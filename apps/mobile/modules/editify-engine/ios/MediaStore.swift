import CryptoKit
import Darwin
import Foundation

/// Where the device keeps media (decision 3A): Application Support, which iOS never
/// purges on its own (Caches it does), with each directory excluded from iCloud backup
/// so multi-gigabyte clips don't fill the user's backup.
///
///   Application Support/Editify/
///     media/<uuid>-<name>         copies of imports the server also has (Files, share,
///                                 capture, stickers, limited-access Photos); the registry
///                                 evicts them under its own byte budget (local-media.ts)
///     proxies/<sha256(id)>.mov    1080p preview proxies (ProxyStore, LRU byte budget)
///
/// The registry stores paths relative to the root ("media/…"): the app container's
/// absolute path changes when the app is updated, so an absolute file:// URI saved
/// today would point nowhere after the next update.
enum MediaStore {
  /// Tests point this at a temp directory.
  nonisolated(unsafe) static var rootOverride: URL?

  static var root: URL {
    if let rootOverride { return rootOverride }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Editify", isDirectory: true)
  }

  static let mediaFolder = "media"
  static let proxiesFolder = "proxies"

  /// `root/name`, created on first use and excluded from backup.
  static func directory(_ name: String) throws -> URL {
    var url = root.appendingPathComponent(name, isDirectory: true)
    if !FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return url
  }

  static func url(forRelative path: String) -> URL {
    root.appendingPathComponent(path)
  }

  /// Copies `source` into media/ (a clone on APFS, so no extra space until one side
  /// changes) and returns the path relative to the root and the copy's size.
  static func durableCopy(from source: URL, name: String) throws -> (path: String, bytes: Int64) {
    let folder = try directory(mediaFolder)
    let fileName = "\(UUID().uuidString)-\(safeName(name))"
    let target = folder.appendingPathComponent(fileName)
    try FileManager.default.copyItem(at: source, to: target)
    // A copy keeps the source's dates; the orphan sweep ages files by modification date,
    // so an old clip copied for an upload in progress must not look a day old already.
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: target.path)
    return ("\(mediaFolder)/\(fileName)", fileSize(target) ?? 0)
  }

  /// Every file in media/: its relative path, size and modification time (ms since 1970),
  /// for the registry's sweep of copies no row points at.
  static func mediaFiles() -> [[String: Any]] {
    guard let folder = try? directory(mediaFolder) else { return [] }
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
    return files.compactMap { url in
      guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { return nil }
      return [
        "path": "\(mediaFolder)/\(url.lastPathComponent)",
        "bytes": values.fileSize ?? 0,
        "modified": ((values.contentModificationDate ?? .distantPast).timeIntervalSince1970 * 1000).rounded(),
      ]
    }
  }

  /// Space iOS would free up for something the user asked for (it may purge caches to get
  /// there), in bytes; 0 when unknown.
  static func availableBytes() -> Int64 {
    let values = try? root.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values?.volumeAvailableCapacityForImportantUsage ?? 0
  }

  /// Removes a file the registry no longer points at; only paths inside the root.
  static func remove(relative path: String) {
    guard !path.isEmpty, !path.contains(".."), !path.hasPrefix("/") else { return }
    try? FileManager.default.removeItem(at: url(forRelative: path))
  }

  /// A file name safe on any filesystem, keeping the extension (AVFoundation reads it).
  static func safeName(_ name: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    let cleaned = String(name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "."))
    return trimmed.isEmpty ? "media" : String(trimmed.suffix(120))
  }

  static func fileSize(_ url: URL) -> Int64? {
    guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), values.isRegularFile == true else { return nil }
    return Int64(values.fileSize ?? 0)
  }
}

/// Extended attributes on a file (they travel with renames on the same volume).
enum FileTag {
  static func read(_ url: URL, _ name: String) -> String? {
    url.withUnsafeFileSystemRepresentation { path -> String? in
      guard let path else { return nil }
      let length = getxattr(path, name, nil, 0, 0, 0)
      guard length > 0 else { return nil }
      var buffer = [UInt8](repeating: 0, count: length)
      guard getxattr(path, name, &buffer, length, 0, 0) == length else { return nil }
      return String(decoding: buffer, as: UTF8.self)
    }
  }

  @discardableResult
  static func write(_ url: URL, _ name: String, _ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return url.withUnsafeFileSystemRepresentation { path in
      guard let path else { return false }
      return setxattr(path, name, bytes, bytes.count, 0, 0) == 0
    }
  }
}

/// The device preview proxies (decision 10B + OV9): one file per asset under an LRU byte
/// budget. Files are named by a SHA-256 of the asset id (any id, any length, is a safe
/// name) and carry the id and the proxy's key (analyzer version + source fingerprint) as
/// extended attributes. "Recently used" is the file's modification date, bumped by
/// `touch` whenever the preview opens the proxy, so eviction drops whatever was opened
/// longest ago. A proxy is written to `<hash>.partial.mov` and renamed into place only
/// once complete, so a cancel, a crash or a kill never leaves a half file that looks
/// finished; `sweepPartials` clears leftovers on launch.
final class ProxyStore: @unchecked Sendable {
  static let defaultBudgetBytes: Int64 = 4 * 1024 * 1024 * 1024
  /// What `budgetBytes` accepts: below 256 MB no 1080p proxy fits; above 1 TB is a typo.
  static let budgetRange: ClosedRange<Int64> = (256 * 1024 * 1024)...(1024 * 1024 * 1024 * 1024)
  static let shared = ProxyStore(directory: nil)

  static let assetIdTag = "com.editify.asset-id"
  static let keyTag = "com.editify.proxy-key"

  struct InvalidId: Error, LocalizedError {
    var errorDescription: String? { "A proxy needs a non-empty asset id" }
  }

  private let lock = NSLock()
  private let fixedDirectory: URL?
  private var budget: Int64
  private var swept = false

  /// nil: MediaStore's proxies folder (resolved on use, so `rootOverride` applies).
  /// The budget is taken as given here (tests use tiny ones); `setBudget` clamps.
  init(directory: URL?, budgetBytes: Int64 = ProxyStore.defaultBudgetBytes) {
    fixedDirectory = directory
    budget = budgetBytes
  }

  var budgetBytes: Int64 {
    get { lock.withLock { budget } }
    set { lock.withLock { budget = max(0, newValue) } }
  }

  /// From JS: a non-number is ignored (false), anything else is clamped to `budgetRange`.
  @discardableResult
  func setBudget(_ bytes: Double) -> Bool {
    guard bytes.isFinite else { return false }
    let clamped = min(Double(Self.budgetRange.upperBound), max(Double(Self.budgetRange.lowerBound), bytes))
    budgetBytes = Int64(clamped)
    return true
  }

  func directory() throws -> URL {
    if let fixedDirectory {
      try FileManager.default.createDirectory(at: fixedDirectory, withIntermediateDirectories: true)
      return fixedDirectory
    }
    return try MediaStore.directory(MediaStore.proxiesFolder)
  }

  static func hashedName(_ assetId: String) throws -> String {
    guard !assetId.isEmpty else { throw InvalidId() }
    return SHA256.hash(data: Data(assetId.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Relative to MediaStore.root, as the registry stores it.
  static func relativePath(_ assetId: String) throws -> String { "\(MediaStore.proxiesFolder)/\(try hashedName(assetId)).mov" }

  func finalURL(_ assetId: String) throws -> URL {
    try directory().appendingPathComponent("\(try Self.hashedName(assetId)).mov")
  }

  func partialURL(_ assetId: String) throws -> URL {
    try directory().appendingPathComponent("\(try Self.hashedName(assetId)).partial.mov")
  }

  /// The finished proxy, its size and its key, or nil when there is none (never made, evicted, deleted).
  func existing(_ assetId: String) -> (url: URL, bytes: Int64, key: String?)? {
    guard let url = try? finalURL(assetId), let size = MediaStore.fileSize(url) else { return nil }
    return (url, size, FileTag.read(url, Self.keyTag))
  }

  /// Marks the proxy as just opened. False when there is no proxy to touch.
  @discardableResult
  func touch(_ assetId: String, at date: Date = Date()) -> Bool {
    guard let url = try? finalURL(assetId), FileManager.default.fileExists(atPath: url.path) else { return false }
    return (try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)) != nil
  }

  /// Moves a finished partial file into place (replacing an older proxy), tags it with its
  /// asset id and `key`, and marks it used now.
  func commit(_ assetId: String, key: String) throws -> URL {
    let partial = try partialURL(assetId)
    let final = try finalURL(assetId)
    if FileManager.default.fileExists(atPath: final.path) {
      _ = try FileManager.default.replaceItemAt(final, withItemAt: partial, options: .usingNewMetadataOnly)
    } else {
      try FileManager.default.moveItem(at: partial, to: final)
    }
    // Tagged after the move: a replace may keep the old file's attributes.
    FileTag.write(final, Self.assetIdTag, assetId)
    FileTag.write(final, Self.keyTag, key)
    touch(assetId)
    return final
  }

  func removePartial(_ assetId: String) {
    if let url = try? partialURL(assetId) { try? FileManager.default.removeItem(at: url) }
  }

  func remove(_ assetId: String) {
    if let url = try? finalURL(assetId) { try? FileManager.default.removeItem(at: url) }
  }

  /// Deletes least-recently-opened proxies until the total fits the budget, never the
  /// `protecting` one (the proxy just written may alone exceed a small budget). Returns
  /// the evicted asset ids, oldest first (a file without its id tag is deleted unreported).
  func evictOverBudget(protecting: String? = nil) -> [String] {
    guard let folder = try? directory() else { return [] }
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
    var entries: [(id: String?, url: URL, date: Date, bytes: Int64)] = []
    for url in files where url.pathExtension == "mov" && !url.lastPathComponent.hasSuffix(".partial.mov") {
      let values = try? url.resourceValues(forKeys: Set(keys))
      entries.append((FileTag.read(url, Self.assetIdTag), url, values?.contentModificationDate ?? .distantPast, Int64(values?.fileSize ?? 0)))
    }
    var total = entries.reduce(Int64(0)) { $0 + $1.bytes }
    let limit = budgetBytes
    let protectedURL = protecting.flatMap { try? finalURL($0) }
    var evicted: [String] = []
    for entry in entries.sorted(by: { $0.date < $1.date }) where total > limit {
      if entry.url.lastPathComponent == protectedURL?.lastPathComponent { continue }
      guard (try? FileManager.default.removeItem(at: entry.url)) != nil else { continue }
      total -= entry.bytes
      if let id = entry.id { evicted.append(id) }
    }
    return evicted
  }

  /// `sweepPartials` once per process: a JS reload creates a new module instance while
  /// the scheduler (and a proxy it is writing) carries on.
  func sweepPartialsOnce() {
    let first = lock.withLock { () -> Bool in
      defer { swept = true }
      return !swept
    }
    if first { sweepPartials() }
  }

  /// Partial files left by a kill mid-write.
  func sweepPartials() {
    guard let folder = try? directory() else { return }
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    for name in names where name.hasSuffix(".partial.mov") {
      try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
    }
  }
}
