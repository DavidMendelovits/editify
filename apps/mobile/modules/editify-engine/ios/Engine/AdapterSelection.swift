import Foundation

/// The composition root's decision (D5): which adapter set this process runs, made once from
/// the OS version, the test override and the background GPU entitlement. Kept apart from
/// EngineAdapters (UIKit, Photos, Speech) so the macOS harnesses compile it and pick their
/// VideoComposition the same way the app does.
///
///   EngineAdapters.make(os:override:)
///      │
///      ├─ override: EDITIFY_ADAPTERS=legacy (env or launch argument). Read only in builds
///      │  with -D EDITIFY_TEST_ADAPTERS (harnesses, Debug); Release compiles it out, so
///      │  `override(environment:arguments:)` is always nil there.
///      ▼
///   override == legacy ? ── yes ──────────────────────────────────────▶ legacy set
///      │ no
///   os.major >= 26 ? ───── no ───────────────────────────────────────▶ legacy set
///      │ yes
///      ▼
///   modern set
///
///   port                 modern (iOS 26)                                   legacy (iOS 18)
///   ───────────────────  ────────────────────────────────────────────────  ───────────────────────
///   transcriber chain    speech-analyzer ▶ sfspeech ▶ unavailable          sfspeech ▶ unavailable
///   videoComposition     configuration (AVVideoComposition.Configuration)  mutable (AVMutableVideoComposition)
///   backgroundExecution  continued-processing when entitled, else          foreground
///                        foreground
///
/// The choice here is by name; EngineAdapters builds the instances behind `#available`, and
/// `capabilities()` reports the names of the instances it built, so a modern choice the
/// runtime can't honour reads as what actually runs.
/// The two adapter sets: modern (iOS 26) and legacy (iOS 18).
enum AdapterSet: String, Sendable { case modern, legacy }

struct AdapterSelection: Equatable, Sendable {
  enum Transcriber: String, Sendable { case speechAnalyzer = "speech-analyzer", sfspeech }
  enum Composition: String, Sendable { case configuration, mutable }
  enum Background: String, Sendable { case continuedProcessing = "continued-processing", foreground }

  let set: AdapterSet
  /// The Transcriber chain, tried in this order (then `.unavailable`).
  let transcribers: [Transcriber]
  let videoComposition: Composition
  let backgroundExecution: Background

  /// The first OS major version with SpeechAnalyzer, AVVideoComposition.Configuration and
  /// BGContinuedProcessingTask.
  static let modernMajor = 26

  static func choose(os: OperatingSystemVersion, override: AdapterSet?, backgroundGPUEntitled: Bool) -> AdapterSelection {
    if override == .legacy || os.majorVersion < modernMajor {
      return AdapterSelection(set: .legacy, transcribers: [.sfspeech], videoComposition: .mutable, backgroundExecution: .foreground)
    }
    return AdapterSelection(set: .modern, transcribers: [.speechAnalyzer, .sfspeech], videoComposition: .configuration,
                            backgroundExecution: backgroundGPUEntitled ? .continuedProcessing : .foreground)
  }

  /// True only in builds with -D EDITIFY_TEST_ADAPTERS (never Release).
  static var overrideCompiled: Bool {
    #if EDITIFY_TEST_ADAPTERS
    return true
    #else
    return false
    #endif
  }

  /// EDITIFY_ADAPTERS from the environment, or a launch argument (`EDITIFY_ADAPTERS=legacy`, or
  /// `-EDITIFY_ADAPTERS legacy` as `simctl launch` passes it). Nil without the test flag.
  static func override(environment: [String: String], arguments: [String]) -> AdapterSet? {
    #if EDITIFY_TEST_ADAPTERS
    if let value = environment["EDITIFY_ADAPTERS"] { return AdapterSet(rawValue: value) }
    for (index, argument) in arguments.enumerated() {
      if argument.hasPrefix("EDITIFY_ADAPTERS=") { return AdapterSet(rawValue: String(argument.dropFirst("EDITIFY_ADAPTERS=".count))) }
      if argument == "-EDITIFY_ADAPTERS", index + 1 < arguments.count { return AdapterSet(rawValue: arguments[index + 1]) }
    }
    return nil
    #else
    return nil
    #endif
  }

  /// This process's override (nil in Release).
  static var launchOverride: AdapterSet? {
    override(environment: ProcessInfo.processInfo.environment, arguments: ProcessInfo.processInfo.arguments)
  }

  /// Info.plist `EditifyBackgroundGPU` (true): set in app.json next to the
  /// continued-processing GPU entitlement, which iOS gives no API to read back. See
  /// ExportCenter's "to turn background exports on".
  static var backgroundGPUEntitled: Bool {
    (Bundle.main.object(forInfoDictionaryKey: "EditifyBackgroundGPU") as? Bool) == true
  }

  /// The selection this process runs with, made once.
  static let current = choose(os: ProcessInfo.processInfo.operatingSystemVersion, override: launchOverride,
                              backgroundGPUEntitled: backgroundGPUEntitled)

  /// "18.0.1": the OS version `capabilities()` reports.
  static func versionString(_ os: OperatingSystemVersion) -> String {
    "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
  }
}
