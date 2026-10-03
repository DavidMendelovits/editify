import Foundation

/// Where the device keeps media for good (decision 3A): Application Support, which
/// iOS never purges (Caches it does), with each directory excluded from iCloud
/// backup so multi-gigabyte clips don't fill the user's backup.
///
///   Application Support/Editify/
///     media/<uuid>-<name>      Files, share, capture and limited-access Photos imports
///     proxies/<assetId>.mov    1080p preview proxies (ProxyStore, LRU byte budget)
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
  /// changes) and returns the path relative to the root.
  static func durableCopy(from source: URL, name: String) throws -> String {
    let folder = try directory(mediaFolder)
    let fileName = "\(UUID().uuidString)-\(safeName(name))"
    try FileManager.default.copyItem(at: source, to: folder.appendingPathComponent(fileName))
    return "\(mediaFolder)/\(fileName)"
  }

  /// Removes a file the registry no longer points at; only paths inside the root.
  static func remove(relative path: String) {
    guard !path.contains(".."), !path.hasPrefix("/") else { return }
    try? FileManager.default.removeItem(at: url(forRelative: path))
  }

  /// A file name safe on any filesystem, keeping the extension (AVFoundation reads it).
  static func safeName(_ name: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    let cleaned = String(name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "."))
    return trimmed.isEmpty ? "media" : String(trimmed.suffix(120))
  }
}

/// The device preview proxies (decision 10B + OV9): one file per asset under an LRU byte
/// budget. "Recently used" is the file's modification date, bumped by `touch` whenever
/// the preview opens the proxy, so eviction drops whatever was opened longest ago.
/// A proxy is written to `<assetId>.partial.mov` and renamed into place only once it is
/// complete, so a cancel, a crash or a kill never leaves a half file that looks finished;
/// `sweepPartials` clears leftovers on launch.
final class ProxyStore: @unchecked Sendable {
  static let defaultBudgetBytes: Int64 = 4 * 1024 * 1024 * 1024
  static let shared = ProxyStore(directory: nil)

  private let lock = NSLock()
  private let fixedDirectory: URL?
  private var budget: Int64 = ProxyStore.defaultBudgetBytes

  /// nil: MediaStore's proxies folder (resolved on use, so `rootOverride` applies).
  init(directory: URL?, budgetBytes: Int64 = ProxyStore.defaultBudgetBytes) {
    fixedDirectory = directory
    budget = budgetBytes
  }

  var budgetBytes: Int64 {
    get { lock.withLock { budget } }
    set { lock.withLock { budget = max(0, newValue) } }
  }

  func directory() throws -> URL {
    if let fixedDirectory {
      try FileManager.default.createDirectory(at: fixedDirectory, withIntermediateDirectories: true)
      return fixedDirectory
    }
    return try MediaStore.directory(MediaStore.proxiesFolder)
  }

  static func fileName(_ assetId: String) -> String { "\(MediaStore.safeName(assetId)).mov" }

  /// Relative to MediaStore.root, as the registry stores it.
  static func relativePath(_ assetId: String) -> String { "\(MediaStore.proxiesFolder)/\(fileName(assetId))" }

  func finalURL(_ assetId: String) throws -> URL {
    try directory().appendingPathComponent(Self.fileName(assetId))
  }

  func partialURL(_ assetId: String) throws -> URL {
    try directory().appendingPathComponent("\(MediaStore.safeName(assetId)).partial.mov")
  }

  /// The finished proxy and its size, or nil when there is none (never made, evicted, deleted).
  func existing(_ assetId: String) -> (url: URL, bytes: Int64)? {
    guard let url = try? finalURL(assetId), let size = Self.size(of: url) else { return nil }
    return (url, size)
  }

  /// Marks the proxy as just opened. False when there is no proxy to touch.
  @discardableResult
  func touch(_ assetId: String, at date: Date = Date()) -> Bool {
    guard let url = try? finalURL(assetId), FileManager.default.fileExists(atPath: url.path) else { return false }
    return (try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)) != nil
  }

  /// Moves a finished partial file into place (replacing an older proxy) and marks it used now.
  func commit(_ assetId: String) throws -> URL {
    let partial = try partialURL(assetId)
    let final = try finalURL(assetId)
    if FileManager.default.fileExists(atPath: final.path) {
      _ = try FileManager.default.replaceItemAt(final, withItemAt: partial)
    } else {
      try FileManager.default.moveItem(at: partial, to: final)
    }
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
  /// the evicted asset ids, oldest first.
  func evictOverBudget(protecting: String? = nil) -> [String] {
    guard let folder = try? directory() else { return [] }
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
    var entries: [(id: String, url: URL, date: Date, bytes: Int64)] = []
    for url in files where url.pathExtension == "mov" && !url.lastPathComponent.hasSuffix(".partial.mov") {
      let values = try? url.resourceValues(forKeys: Set(keys))
      entries.append((url.deletingPathExtension().lastPathComponent, url, values?.contentModificationDate ?? .distantPast, Int64(values?.fileSize ?? 0)))
    }
    var total = entries.reduce(Int64(0)) { $0 + $1.bytes }
    let limit = budgetBytes
    let protectedName = protecting.map { MediaStore.safeName($0) }
    var evicted: [String] = []
    for entry in entries.sorted(by: { $0.date < $1.date }) where total > limit {
      if entry.id == protectedName { continue }
      guard (try? FileManager.default.removeItem(at: entry.url)) != nil else { continue }
      total -= entry.bytes
      evicted.append(entry.id)
    }
    return evicted
  }

  private var swept = false

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

  private static func size(of url: URL) -> Int64? {
    guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), values.isRegularFile == true else { return nil }
    return Int64(values.fileSize ?? 0)
  }
}
