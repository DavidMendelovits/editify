import Foundation

/// The words part as a capability chain (decisions D18-D21, C4, C25): each Transcriber
/// adapter is tried in the composition root's order, the first one that can run transcribes,
/// and TranscriptAssembler shapes what it heard.
///
///   words(asset, locale)
///     │
///     ├─ SpeechAnalyzer (modern set only): eligible? available + locale supported + model
///     │    installed, or installable now (allowModelDownload) ── no ─▶ next
///     │    └─ yes ─ model download fails ─▶ next (TranscriberIneligible; no `unavailable`, no loop)
///     │           └─ ok ─▶ FinalResult[] ──────────────────────────────────────────────┐
///     ├─ SFSpeech on-device: speech permission first (SpeechAuthorization; requested only with
///     │    asksForSpeech), then eligible? recognizer for the locale + on-device support ─ no ─▶ next
///     │    └─ permission:                                                                │
///     │           ├─ notDetermined ─▶ unavailable(code speechRecognitionNotAsked): the   │
///     │           │                   app's pre-prompt sheet asks, with Editify in front │
///     │           │                   (C15), and JS re-queues the part once granted      │
///     │           ├─ denied / restricted ─▶ unavailable("Speech recognition is off      │
///     │           │                          for Editify", code speechRecognitionOff)   │
///     │           └─ authorized ─▶ 50 s chunks, 2 s overlap, 2 retries per chunk        │
///     │                 ├─ a chunk still failing ─▶ failed("... chunk i of n: ...")      │
///     │                 └─ ok ─▶ rebase, dedupe the overlaps ─▶ FinalResult[] ──────────┤
///     └─ unavailable(the reasons each adapter gave)                                     │
///                                                                                       ▼
///   TranscriptAssembler(FinalResult[]) ─▶ transcriptResultSchema data, ready under the version
///   of the adapter that ran (w-sa1 / w-sf2); every result carries the current re-run trigger
///
/// The re-run rule (C25, WordsFreshness): a result from the best adapter (the first in the
/// chain) stays fresh; one from a fallback stays fresh until the trigger moves (the OS
/// version, or a SpeechAnalyzer model installed since), and then re-runs once: the new result
/// carries the new trigger, so a re-run that falls back again doesn't loop.
public final class TranscriberChain<Asset>: @unchecked Sendable {
  public typealias Link = any Transcriber<Asset>

  public let links: [Link]
  public let authorization: any SpeechAuthorization
  /// The current re-run trigger id (TranscriberTrigger.id).
  private let trigger: @Sendable () -> String
  private let lock = NSLock()
  private var ran: String?
  private let remember: (@Sendable (String) -> Void)?
  /// False (the app): a words run never shows the speech prompt; an unanswered permission
  /// comes back `speechRecognitionNotAsked` and the C15 sheet asks with Editify in front.
  /// True only for a caller that is known to run in the foreground.
  public let asksForSpeech: Bool

  /// `lastRan`: the adapter that ran last in an earlier process, `remember` stores a new one.
  public init(_ links: [Link], authorization: any SpeechAuthorization, trigger: @escaping @Sendable () -> String,
              lastRan: String? = nil, remember: (@Sendable (String) -> Void)? = nil, asksForSpeech: Bool = false) {
    self.links = links
    self.authorization = authorization
    self.trigger = trigger
    self.ran = lastRan
    self.remember = remember
    self.asksForSpeech = asksForSpeech
  }

  /// The adapters by name, in the order they are tried.
  public var order: [String] { links.map(\.name) }
  /// The version a result from the best adapter carries.
  public var bestVersion: String { links.first?.wordsVersion ?? AnalyzerVersion.wordsSFSpeech }
  /// Every adapter's version, by adapter name.
  public var versions: [String: String] { Dictionary(links.map { ($0.name, $0.wordsVersion) }, uniquingKeysWith: { first, _ in first }) }
  /// The adapter whose result was last ready (nil before any).
  public var lastRan: String? { lock.withLock { ran } }
  public var currentTrigger: String { trigger() }

  /// The freshness rule for the scheduler (and JS's mirror of it).
  public var freshness: WordsFreshness {
    WordsFreshness(best: bestVersion, versions: Set(links.map(\.wordsVersion)), trigger: currentTrigger)
  }

  public func words(_ asset: Asset, locale: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?, gate: AnalyzerGate?) async -> PartResult {
    var reasons: [String] = []
    let trigger = currentTrigger
    for link in links {
      if link.requiresSpeechAuthorization {
        // Before eligibility: without the permission SFSpeech can't run (and the system may not
        // fetch its on-device model), and the actionable answer is the Settings link (D21).
        // No prompt by default: a words run can start with Editify in the background, where the
        // system prompt can't be answered. Not asked yet means the pre-prompt sheet asks (C15).
        var status = authorization.status
        if status == .notDetermined, asksForSpeech { status = await authorization.request() }
        guard status == .authorized else {
          // Denied, restricted, or never asked: the user decides, not a retry.
          let asked = status != .notDetermined
          var result = PartResult.unavailable(link.wordsVersion, asked ? SpeechAuthorizationMessage.off : SpeechAuthorizationMessage.notAsked)
          result.code = asked ? SpeechAuthorizationMessage.offCode : SpeechAuthorizationMessage.notAskedCode
          result.trigger = trigger
          return result
        }
      }
      if case .ineligible(let reason) = await link.eligibility(locale: locale, allowModelDownload: allowModelDownload) {
        reasons.append(reason)
        continue
      }
      var result: PartResult
      do {
        let transcription = try await link.transcribe(asset, locale: locale, allowModelDownload: allowModelDownload, progress: progress, gate: gate)
        result = .ready(link.wordsVersion, TranscriptAssembler.data(transcription))
        lock.withLock { ran = link.name }
        remember?(link.name)
      } catch let fallThrough as TranscriberIneligible {
        reasons.append(fallThrough.reason)
        continue
      } catch is NoAudio {
        result = .unavailable(link.wordsVersion, NoAudio().localizedDescription)
      } catch is CancellationError {
        result = .failed(link.wordsVersion, CancellationError())
      } catch {
        result = .failed(link.wordsVersion, error)
      }
      result.trigger = trigger
      return result
    }
    var result = PartResult.unavailable(bestVersion, reasons.isEmpty ? "No speech transcriber on this device" : reasons.joined(separator: "; "))
    result.trigger = trigger
    return result
  }
}

public enum SpeechAuthorizationMessage {
  /// D21: the reason a words part gives when the user turned speech recognition off.
  public static let off = "Speech recognition is off for Editify"
  /// `code` on that part: JS shows a Settings link for it.
  public static let offCode = "speechRecognitionOff"
  /// The reason when the user hasn't answered the speech prompt yet.
  public static let notAsked = "Editify needs permission to recognize speech"
  /// `code` when the user hasn't answered yet: JS's pre-prompt sheet asks with
  /// requestSpeechAuthorization and re-queues the part on `authorized`.
  public static let notAskedCode = "speechRecognitionNotAsked"
}

/// When a stored words result is still current (C25, refining D12).
public struct WordsFreshness: Equatable, Sendable {
  /// The version the best adapter in this process's chain writes.
  public let best: String
  /// Every adapter version in the chain.
  public let versions: Set<String>
  /// The current re-run trigger.
  public let trigger: String

  public init(best: String, versions: Set<String>, trigger: String) {
    self.best = best
    self.versions = versions
    self.trigger = trigger
  }

  /// A result from an adapter version this build no longer writes is stale; one from the best
  /// adapter is current; one from a fallback is current until the trigger moves.
  public func isCurrent(version: String, trigger stored: String?) -> Bool {
    guard versions.contains(version) else { return false }
    return version == best || stored == trigger
  }
}

/// The C25 trigger: what has to change before a fallback result re-runs. The OS version
/// (major.minor: a point release doesn't bring new speech models) and the number of
/// SpeechAnalyzer model installs that succeeded, kept across launches.
public final class TranscriberTrigger: @unchecked Sendable {
  private let os: OperatingSystemVersion
  private let defaults: UserDefaults
  private let key: String
  private let lock = NSLock()

  public init(os: OperatingSystemVersion, defaults: UserDefaults = .standard, key: String = "editify.transcriber.modelInstalls") {
    self.os = os
    self.defaults = defaults
    self.key = key
  }

  public var id: String { "os=\(os.majorVersion).\(os.minorVersion);sa=\(lock.withLock { defaults.integer(forKey: key) })" }

  /// A SpeechAnalyzer model install succeeded: every fallback result re-runs once.
  public func modelInstalled() {
    lock.withLock { defaults.set(defaults.integer(forKey: key) + 1, forKey: key) }
  }
}
