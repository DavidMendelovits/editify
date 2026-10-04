import AVFoundation
import CoreMedia
import Speech

/// Transcriber adapter for iOS 26: SpeechAnalyzer + SpeechTranscriber with word time ranges.
/// Eligible (C25) when SpeechTranscriber is available, the locale is supported, and its model
/// is installed or may be installed now (`allowModelDownload`). A download that then fails
/// throws TranscriberIneligible, so the chain falls through to SFSpeech instead of leaving the
/// part `unavailable`; a download that succeeds bumps the re-run trigger (TranscriberTrigger).
/// When the gate stops it (the part was cancelled) it throws CancellationError, never a
/// partial result.
@available(iOS 26.0, *)
struct SpeechAnalyzerTranscriber: Transcriber {
  var name: String { "speech-analyzer" }
  var wordsVersion: String { AnalyzerVersion.wordsSpeechAnalyzer }
  var requiresSpeechAuthorization: Bool { false }
  /// Called after a model download and install succeeded.
  var modelInstalled: @Sendable () -> Void = {}

  func eligibility(locale requested: Locale, allowModelDownload: Bool) async -> TranscriberEligibility {
    guard SpeechTranscriber.isAvailable else { return .ineligible("Speech transcription is not available on this device") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      return .ineligible("No speech model for \(requested.identifier)")
    }
    switch await AssetInventory.status(forModules: [Self.module(locale)]) {
    case .installed: return .eligible
    case .supported, .downloading:
      return allowModelDownload ? .eligible : .ineligible("The speech model for \(locale.identifier) is not installed")
    case .unsupported: return .ineligible("No speech model for \(locale.identifier)")
    @unknown default: return .ineligible("The speech model for \(locale.identifier) is unavailable")
    }
  }

  static func module(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
  }

  func transcribe(_ asset: AVAsset, locale requested: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?,
                  gate: AnalyzerGate?) async throws -> Transcription {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      throw TranscriberIneligible("No speech model for \(requested.identifier)")
    }
    let transcriber = Self.module(locale)
    do {
      if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        guard allowModelDownload else { throw TranscriberIneligible("The speech model for \(locale.identifier) is not installed") }
        do {
          try await install.downloadAndInstall()
          modelInstalled()
        } catch {
          throw TranscriberIneligible("The speech model for \(locale.identifier) could not be downloaded: \(error.localizedDescription)")
        }
      }
    } catch let ineligible as TranscriberIneligible {
      throw ineligible
    } catch {
      throw TranscriberIneligible("The speech model for \(locale.identifier) is unavailable: \(error.localizedDescription)")
    }

    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw TranscriberIneligible("SpeechAnalyzer offered no audio format")
    }
    let chunks = try await PCMChunks(asset: asset, rate: format.sampleRate)
    guard let floatFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false) else {
      throw EngineError(message: "no float format at \(format.sampleRate) Hz")
    }
    // Same rate, so only the sample format may differ (usually Int16).
    let converter = floatFormat == format ? nil : AVAudioConverter(from: floatFormat, to: format)
    let stopped = CancelFlag()
    let inputs = AsyncThrowingStream<AnalyzerInput, Error> {
      if let gate, await !gate() { stopped.set(); return nil }
      guard let (samples, position) = try await AnalysisQueue.run({ try chunks.next() }) else { return nil }
      guard var buffer = PCMChunks.buffer(samples, format: floatFormat) else { return nil }
      if let converter {
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength) else { return nil }
        try converter.convert(to: converted, from: buffer)
        buffer = converted
      }
      progress?(chunks.fraction(at: position) * 0.95)
      // `position` counts from the recording's start (the decoder keeps the PTS origin, D19).
      return AnalyzerInput(buffer: buffer, bufferStartTime: CMTime(value: CMTimeValue(position), timescale: CMTimeScale(format.sampleRate)))
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collect = Task { () -> [FinalResult] in
      var results: [FinalResult] = []
      for try await result in transcriber.results where result.isFinal {
        var words: [TimedWord] = []
        for run in result.text.runs {
          guard let range = run.audioTimeRange else { continue }
          words.append(TimedWord(text: String(result.text[run.range].characters), start: range.start.seconds, end: range.end.seconds))
        }
        results.append(FinalResult(text: String(result.text.characters), start: result.range.start.seconds,
                                   end: result.range.end.seconds, words: words))
      }
      return results
    }
    do {
      try await analyzer.start(inputSequence: inputs)
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      await analyzer.cancelAndFinishNow()
      collect.cancel()
      throw error
    }
    let results = try await collect.value
    if stopped.isSet { throw CancellationError() }
    progress?(1)
    return Transcription(results: results, language: locale.language.languageCode?.identifier ?? locale.identifier,
                         durationProcessedSeconds: max(0, chunks.durationSeconds))
  }
}
