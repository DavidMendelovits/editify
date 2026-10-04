import Foundation

/// Documents/lab/results.jsonl (one row per run, the evaluator's input) plus the
/// inflight.json start marker that lets a killed run be detected on next launch.
public enum LabStore {
  public static let directory: URL = {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("lab", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }()
  public static let resultsURL = directory.appendingPathComponent("results.jsonl")
  private static let inflightURL = directory.appendingPathComponent("inflight.json")
  private static let lock = NSLock()

  public static func append(_ row: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    lock.lock()
    defer { lock.unlock() }
    if let handle = try? FileHandle(forWritingTo: resultsURL) {
      handle.seekToEndOfFile()
      handle.write(data)
      try? handle.close()
    } else {
      try? data.write(to: resultsURL)
    }
  }

  /// The row to record if this run never finishes: already shaped as `killed`.
  public static func writeInflight(_ row: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
    try? data.write(to: inflightURL, options: .atomic)
  }

  public static func clearInflight() {
    try? FileManager.default.removeItem(at: inflightURL)
  }

  /// Called once at module start: a marker left behind means the previous run was terminated.
  public static func recoverKilledRun() {
    guard let data = try? Data(contentsOf: inflightURL),
          let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    append(row)
    clearInflight()
  }

  public static func readAll() -> String {
    (try? String(contentsOf: resultsURL, encoding: .utf8)) ?? ""
  }

  public static func clear() {
    try? FileManager.default.removeItem(at: resultsURL)
  }
}
