import Foundation

// The speech ports (decisions D18-D21): one link of the Transcriber chain, and the user's
// speech-recognition permission. The chain itself, the assembler and the chunk policies are
// Core (TranscriberChain.swift, TranscriptAssembler.swift, SpeechChunks.swift).

/// A word with its time in the recording, in seconds.
public struct TimedWord: Equatable, Sendable {
  public let text: String
  public let start: Double
  public let end: Double

  public init(text: String, start: Double, end: Double) {
    self.text = text
    self.start = start
    self.end = end
  }
}

/// What a Transcriber emits (D19): one final phrase, its time range in the recording and its
/// words. TranscriptAssembler turns a list of these into transcriptResultSchema data.
public struct FinalResult: Equatable, Sendable {
  public let text: String
  public let start: Double
  public let end: Double
  public let words: [TimedWord]

  public init(text: String, start: Double, end: Double, words: [TimedWord]) {
    self.text = text
    self.start = start
    self.end = end
    self.words = words
  }
}

/// A whole recording transcribed by one adapter.
public struct Transcription: Sendable {
  public let results: [FinalResult]
  /// The language code the transcript is in ("en").
  public let language: String
  public let durationProcessedSeconds: Double

  public init(results: [FinalResult], language: String, durationProcessedSeconds: Double) {
    self.results = results
    self.language = language
    self.durationProcessedSeconds = durationProcessedSeconds
  }
}

/// Whether a Transcriber can run for a locale right now (C25: available, locale supported, and
/// the model installed or installable now).
public enum TranscriberEligibility: Equatable, Sendable {
  case eligible
  case ineligible(String)
}

/// Thrown by `transcribe` when an adapter that looked eligible can't run after all (its model
/// download failed): the chain moves on to the next adapter instead of failing the part.
public struct TranscriberIneligible: Error, LocalizedError {
  public let reason: String
  public init(_ reason: String) { self.reason = reason }
  public var errorDescription: String? { reason }
}

/// One link of the Transcriber chain (SpeechAnalyzer on iOS 26, SFSpeech on-device).
public protocol Transcriber<Asset>: PortAdapter {
  associatedtype Asset
  /// The words analyzerVersion its results carry (D12: the adapter that actually ran).
  var wordsVersion: String { get }
  /// True when it needs the user's speech-recognition permission (SFSpeechRecognizer).
  var requiresSpeechAuthorization: Bool { get }
  func eligibility(locale: Locale, allowModelDownload: Bool) async -> TranscriberEligibility
  /// Throws TranscriberIneligible to fall through, CancellationError when the gate stopped it,
  /// NoAudio for a recording without sound, anything else for a failed part.
  func transcribe(_ asset: Asset, locale: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?,
                  gate: AnalyzerGate?) async throws -> Transcription
}

/// The user's answer to the speech-recognition prompt (SFSpeechRecognizerAuthorizationStatus).
public enum SpeechAuthorizationStatus: String, Sendable, CaseIterable {
  case notDetermined, denied, restricted, authorized
}

/// The speech-recognition permission (D21).
public protocol SpeechAuthorization: PortAdapter {
  var status: SpeechAuthorizationStatus { get }
  /// Shows the system prompt when it was never answered; answers the status after it.
  func request() async -> SpeechAuthorizationStatus
}
