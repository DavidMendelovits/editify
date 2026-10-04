import Foundation

/// The analyzers' domain half (EditifyCore): versions, the part result every analyzer
/// returns, and the pure analyzers (sync, energy) that only read decoded samples. The
/// halves that touch media (decode, Speech, SoundAnalysis, Vision) extend `Analyzers`
/// in Engine/Analyzers.swift.

/// Bumped whenever an analyzer's output can change, so a stored part from an
/// older analyzer reads as stale (decision 6A).
public enum AnalyzerVersion {
  // -2: PCMChunks reads the first *enabled* audio track (it read the first track), which
  // can change the input of every audio analyzer on files with a disabled first track.
  public static let decode = "avassetreader-8k-2"
  public static let sync = "audiosync-vdsp-2"
  // The words part's version names the Transcriber adapter that ran (D12): SpeechAnalyzer
  // (iOS 26) or SFSpeech on-device (iOS 18). Both start after the decoder's PTS fix (D19),
  // which moved word times on recordings whose audio doesn't start at zero; that is the bump
  // from "speechanalyzer-ios26-2". Which one a part needs: TranscriberChain / WordsFreshness.
  public static let wordsSpeechAnalyzer = "w-sa1"
  public static let wordsSFSpeech = "w-sf1"
  // -3: laughter windows are timed from the audio's start in the recording (D19 PTS fix).
  public static let laughter = "soundanalysis-v1-3"
  public static let energy = "energy-rms-50ms-2"
  public static let faces = "vision-facerect-1"
  /// Not an analyzer: the 1080p preview proxy (ProxyPipeline), versioned the same way.
  public static let proxy = "writer-1080-1"

  /// Every part's version but `words`, which depends on the adapter set (TranscriberChain.bestVersion).
  public static let all: [String: String] = [
    "decode": decode, "sync": sync, "laughter": laughter, "energy": energy, "faces": faces, "proxy": proxy,
  ]
}

public struct PartResult {
  public let status: String
  public let analyzerVersion: String
  public var data: [String: Any]?
  public var error: String?
  /// A machine-readable reason JS acts on (`speechRecognitionOff`: show a Settings link).
  public var code: String?
  /// Words only: the Transcriber chain's re-run trigger when it ran (C25).
  public var trigger: String?

  public init(status: String, analyzerVersion: String, data: [String: Any]? = nil, error: String? = nil) {
    self.status = status
    self.analyzerVersion = analyzerVersion
    self.data = data
    self.error = error
  }

  public static func ready(_ version: String, _ data: [String: Any]) -> PartResult { PartResult(status: "ready", analyzerVersion: version, data: data) }
  public static func failed(_ version: String, _ error: Error) -> PartResult { PartResult(status: "failed", analyzerVersion: version, error: error.localizedDescription) }
  public static func failed(_ version: String, _ message: String) -> PartResult { PartResult(status: "failed", analyzerVersion: version, error: message) }
  public static func unavailable(_ version: String, _ reason: String) -> PartResult { PartResult(status: "unavailable", analyzerVersion: version, error: reason) }

  public var dictionary: [String: Any] {
    var out: [String: Any] = ["status": status, "analyzerVersion": analyzerVersion]
    if let data { out["data"] = data }
    if let error { out["error"] = error }
    if let code { out["code"] = code }
    if let trigger { out["trigger"] = trigger }
    return out
  }
}

public enum Analyzers {
  // MARK: - Sync, energy (decoded samples in, no media access)

  /// One pair's sync (OV6: a property of the pair). Both sides decoded at 8 kHz.
  public static func sync(video: [Float], memo: [Float]) -> PartResult {
    do {
      let m = try AudioSync.measure(video: video, memo: memo)
      var measurement: [String: Any] = [
        "lag": m.lag, "anchor": m.anchor, "rate": m.rate,
        // Infinity (no runner-up peak) has no JSON form; the parity runner uses the same stand-in.
        "coarseRatio": m.coarseRatio.isFinite ? m.coarseRatio : 1e308,
        "fineScore": m.fineScore, "confident": m.confident, "overlapSec": m.overlapSec, "fineLocked": m.fineLocked,
        "windows": m.windows.map { ["at": $0.at, "lag": $0.lag, "score": $0.score] },
      ]
      if let drift = m.driftSec { measurement["driftSec"] = drift }
      return .ready(AnalyzerVersion.sync, measurement)
    } catch {
      return .failed(AnalyzerVersion.sync, error)
    }
  }

  /// energyAnalysisSchema data plus the onset peaks cut_to_beats lands on.
  public static func energy(samples: [Float], rate: Int = AudioSync.sampleRate) -> PartResult {
    energy(levels: AnalysisMath.energy(samples, sampleRate: rate))
  }

  /// The same part from levels already measured (AnalysisMath.EnergyStream, the low tier).
  public static func energy(levels rmsDb: [Double]) -> PartResult {
    .ready(AnalyzerVersion.energy, [
      "cellSeconds": AnalysisMath.energyCellSeconds,
      "rmsDb": rmsDb,
      "onsetPeaks": AnalysisMath.onsetPeaks(rmsDb, cellSeconds: AnalysisMath.energyCellSeconds),
    ])
  }
}

/// Temp files the analyzers hand to JS (decoded PCM, Gemini proxies). They live until
/// JS deletes them or the next launch sweeps them (`sweep()` from the module's OnCreate).
public enum TempFiles {
  public static let pcmPrefix = "pcm-"
  public static let proxyPrefix = "gemini-proxy-"
  /// On-device exports (ExportCenter): a finished file stays for the share sheet until next launch.
  public static let exportPrefix = "editify-export-"
  /// The native preview's stills (Photos originals, server copies): swept on next launch.
  public static let previewPrefix = "editify-preview-"

  public static func url(prefix: String, extension ext: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)\(UUID().uuidString).\(ext)")
  }

  public static func sweep() {
    let directory = FileManager.default.temporaryDirectory
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    for name in names where name.hasPrefix(pcmPrefix) || name.hasPrefix(proxyPrefix) || name.hasPrefix(exportPrefix)
      || name.hasPrefix(previewPrefix) {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
  }
}
