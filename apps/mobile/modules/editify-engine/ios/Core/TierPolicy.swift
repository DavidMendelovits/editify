import Foundation

/// The RAM tier (decisions D13, D25): what this iPhone's memory lets the engine hold at once.
///
///   ProcessInfo.physicalMemory (DeviceProfile) ─▶ nominal GB ─┬─ ≥ 6 ─▶ full
///                                                             ├─ 4-5 ─▶ standard
///                                                             └─ < 4 ─▶ low
///
///   tier       export        proxy (short side)   preview render (short x long)   analysis decode
///   ─────────  ────────────  ───────────────────  ──────────────────────────────  ─────────────────────────
///   full       on device     1080                 1080 x 1920                     8 kHz cache (32 MB budget)
///   standard   on device     1080                 1080 x 1920                     8 kHz cache (32 MB budget)
///   low        server (JS)   540                  720 x 1280                      streamed, nothing cached
///
/// iOS reports a little less than the marketing size (a 3 GB XR reports ~2.79 GiB, a 4 GB
/// iPhone 11 ~3.7 GiB, a 6 GB 12 Pro ~5.65 GiB, an 8 GB 15 Pro ~7.47 GiB), so the bytes become
/// the marketing size first: rounded up to the next whole GB once past a 0.4 GiB margin under
/// it. Comparing raw bytes against 4 GB would put every 4 GB phone in `low`, and rounding to
/// the nearest GiB reads an 8 GB phone as 7.
public enum DeviceTier: String, Sendable, CaseIterable {
  case full, standard, low
}

public struct TierPolicy: Equatable, Sendable {
  /// Nominal GB at or above which a phone is `full`.
  public let fullMinGB: Int
  /// Nominal GB at or above which a phone is `standard` (below it: `low`).
  public let standardMinGB: Int

  public init(fullMinGB: Int, standardMinGB: Int) {
    self.fullMinGB = fullMinGB
    self.standardMinGB = standardMinGB
  }

  /// PROVISIONAL: guesses, not measurements. TODOS.md "Measure RAM tier thresholds on a
  /// low-memory iPhone" replaces them with numbers from an A12 phone or 1.1 crash data by tier.
  public static let provisional = TierPolicy(fullMinGB: 6, standardMinGB: 4)

  /// How far under its marketing size a phone may report and still count as that size.
  public static let reportedMarginGiB = 0.4

  /// The size the phone is sold with: the reported GiB, less the margin, rounded up
  /// (7.47 ─▶ 8, 5.65 ─▶ 6, 3.70 ─▶ 4, 2.79 ─▶ 3, exactly 8 ─▶ 8).
  public static func nominalGB(_ physicalMemory: UInt64) -> Int {
    Int((Double(physicalMemory) / Double(1 << 30) - reportedMarginGiB).rounded(.up))
  }

  public func tier(physicalMemory: UInt64) -> DeviceTier {
    let gb = Self.nominalGB(physicalMemory)
    if gb >= fullMinGB { return .full }
    if gb >= standardMinGB { return .standard }
    return .low
  }
}

/// What a tier caps (D25).
public struct TierCaps: Equatable, Sendable {
  /// False on `low`: JS routes exports to the server (routeExport `why: 'device'`).
  public let exportsOnDevice: Bool
  /// The preview proxy's short side (ProxyPipeline).
  public let proxyMaxShortSide: Double
  /// The preview's render cap (PlanPlayer.renderScale), either orientation.
  public let previewMaxShortSide: Double
  public let previewMaxLongSide: Double
  /// Decoded 8 kHz audio the scheduler keeps for sync/energy; 0 keeps none.
  public let pcmCacheSamples: Int
  /// True on `low`: the decode and energy parts stream the audio instead of holding the whole
  /// recording (PCMChunks), so no whole-file PCM is built for them.
  public let streamsAnalysisDecode: Bool

  /// Decoded 8 kHz audio kept for sync/energy on full and standard; ~32 MB is about 17 minutes.
  public static let pcmBudgetSamples = 8_000_000

  public static func of(_ tier: DeviceTier) -> TierCaps {
    switch tier {
    case .full, .standard:
      return TierCaps(exportsOnDevice: true, proxyMaxShortSide: 1080, previewMaxShortSide: 1080, previewMaxLongSide: 1920,
                      pcmCacheSamples: pcmBudgetSamples, streamsAnalysisDecode: false)
    case .low:
      return TierCaps(exportsOnDevice: false, proxyMaxShortSide: 540, previewMaxShortSide: 720, previewMaxLongSide: 1280,
                      pcmCacheSamples: 0, streamsAnalysisDecode: true)
    }
  }
}
