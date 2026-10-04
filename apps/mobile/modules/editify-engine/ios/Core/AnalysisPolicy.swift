import Foundation

/// The analysis scheduler's policy (decision 8A): the half of AnalysisScheduler that decides
/// and never touches media. Which parts exist and how they rank, what a queued job carries,
/// which job a lane runs next, when the heavy lane holds, when a held proxy may start again,
/// a stored proxy's key, and the decoded-audio cache budget. The actor that owns the lanes,
/// the state and the media (Engine/AnalysisScheduler.swift) asks these.
public enum AnalysisPart: String, CaseIterable, Sendable {
  case decode, words, proxy, laughter, energy, faces

  public var rank: Int { AnalysisPart.allCases.firstIndex(of: self)! }
  public var heavy: Bool { self == .words || self == .proxy || self == .faces }
  public var version: String { AnalyzerVersion.all[rawValue]! }
  /// What `analyze` queues when no parts are named: every analyzer, not the proxy.
  public static let analysisDefaults = allCases.filter { $0 != .proxy }
}

public struct AnalysisOptions: Sendable {
  public var facesFps = 2.0
  public var locale: String?
  public var allowModelDownload = true

  public init() {}
}

public struct AnalysisJob: Sendable {
  public let assetId: String
  public let ref: String
  public let part: AnalysisPart
  public let seq: Int
  /// The asset's generation when queued; `cancel` bumps it so a late result is dropped.
  public let generation: Int
  public let options: AnalysisOptions

  public init(assetId: String, ref: String, part: AnalysisPart, seq: Int, generation: Int, options: AnalysisOptions) {
    self.assetId = assetId
    self.ref = ref
    self.part = part
    self.seq = seq
    self.generation = generation
    self.options = options
  }
}

public enum AnalysisPolicy {
  /// Proxies wait this long after playback and export stop (idle debounce), so play/pause
  /// taps don't restart an encode from zero each time.
  public static let proxyResumeDelay: Duration = .seconds(4)

  /// Decoded 8 kHz audio kept for sync/energy; ~32 MB is about 17 minutes of audio.
  public static let pcmBudgetSamples = 8_000_000

  /// A part already `ready` from the current analyzer version is skipped (unless forced);
  /// a proxy only while its file is still on disk.
  public static func isFresh(_ done: PartResult?, part: AnalysisPart, proxyOnDisk: Bool) -> Bool {
    guard let done, done.status == "ready", done.analyzerVersion == part.version else { return false }
    return part != .proxy || proxyOnDisk
  }

  /// Picking order inside a lane: the asset on screen first, then part rank, then arrival.
  public static func order(_ job: AnalysisJob, focus: String?) -> (Int, Int, Int) {
    (job.assetId == focus ? 0 : 1, job.part.rank, job.seq)
  }

  /// The heavy gate: held while playback or an export blocks the media engines, or the
  /// phone is at `.serious` thermal state or worse.
  public static func heavyPaused(proxyBlocked: Bool, thermal: ProcessInfo.ThermalState) -> Bool {
    proxyBlocked || thermal.rawValue >= ProcessInfo.ThermalState.serious.rawValue
  }

  /// A proxy may start once nothing blocks it and the idle debounce has passed.
  public static func proxyMayStart(blocked: Bool, resumeAt: ContinuousClock.Instant?, now: ContinuousClock.Instant = .now) -> Bool {
    !blocked && (resumeAt.map { now >= $0 } ?? true)
  }

  /// What a stored proxy must match to be reused: the proxy version and the source's fingerprint.
  public static func proxyKey(_ fingerprint: [String: Any]) -> String {
    let audio = fingerprint["audio"] as? String ?? "none"
    return "\(AnalyzerVersion.proxy)|\(fingerprint["duration"] ?? 0)|\(fingerprint["bytes"] ?? 0)|\(audio)"
  }

  /// The cached decodes to drop, oldest first, until the cache fits its budget (the newest always stays).
  public static func pcmEvictions(order: [String], counts: [String: Int]) -> [String] {
    var total = counts.values.reduce(0, +)
    var remaining = order[...]
    var evicted: [String] = []
    while total > pcmBudgetSamples, remaining.count > 1 {
      let key = remaining.removeFirst()
      total -= counts[key] ?? 0
      evicted.append(key)
    }
    return evicted
  }
}

/// JS context epochs: each module instance takes one synchronously in OnCreate and sends
/// it with its calls, so which context is newest never depends on actor-hop ordering.
public enum EngineContext {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var value = 0

  public static func begin() -> Int { lock.withLock { value += 1; return value } }
}
