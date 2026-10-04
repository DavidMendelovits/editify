import AVFoundation
import Speech

/// Transcriber adapter for iOS 18 (decision D6): SFSpeechRecognizer with on-device recognition
/// only (`requiresOnDeviceRecognition`), so audio never leaves the phone. Always chunked (D18):
///
///   asset ─ SpeechChunks.plan (50 s, 2 s overlap) ─▶ ChunkRunner (gate, timeout, 2 retries)
///     each chunk: PCMChunks over its time range (16 kHz mono) ─▶ SFSpeechAudioBufferRecognitionRequest
///                 ─▶ final result's segments (times relative to the chunk's first sample)
///   ─▶ SpeechChunks.merge (rebase by each chunk's decoded origin, cut overlaps, dedupe the seam)
///   ─▶ SpeechChunks.phrases ─▶ FinalResult[] ─▶ TranscriptAssembler (in the chain)
///
/// A chunk with no speech is an empty chunk, not a failure. A chunk that still fails after its
/// retries fails the whole part with its index (C4).
struct SFSpeechTranscriber: Transcriber {
  var name: String { "sfspeech" }
  var wordsVersion: String { AnalyzerVersion.wordsSFSpeech }
  var requiresSpeechAuthorization: Bool { true }
  /// The C4 policy; tests shorten it.
  var runner = ChunkRunner()
  static let sampleRate = 16_000.0

  func eligibility(locale: Locale, allowModelDownload: Bool) async -> TranscriberEligibility {
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
      return .ineligible("No speech recognizer for \(locale.identifier)")
    }
    guard recognizer.supportsOnDeviceRecognition else {
      return .ineligible("On-device speech recognition is not available for \(locale.identifier)")
    }
    return .eligible
  }

  func transcribe(_ asset: AVAsset, locale: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?,
                  gate: AnalyzerGate?) async throws -> Transcription {
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
      throw TranscriberIneligible("On-device speech recognition is not available for \(locale.identifier)")
    }
    guard try await firstEnabledTrack(asset, .audio) != nil else { throw NoAudio() }
    let duration = try await asset.load(.duration).seconds
    let chunks = SpeechChunks.plan(duration: duration)
    let total = Double(max(1, chunks.count))
    let heard = try await runner.run(chunks, gate: gate) { chunk, _ in
      let words = try await Self.recognize(asset, chunk: chunk, recognizer: recognizer)
      progress?(min(0.99, Double(chunk.index + 1) / total))
      return words
    }
    let merged = SpeechChunks.merge(heard)
    progress?(1)
    return Transcription(results: SpeechChunks.phrases(merged),
                         language: locale.language.languageCode?.identifier ?? locale.identifier,
                         durationProcessedSeconds: max(0, duration))
  }

  /// One chunk through one on-device request. Cancelling the calling task cancels the request.
  static func recognize(_ asset: AVAsset, chunk: SpeechChunk, recognizer: SFSpeechRecognizer) async throws -> ChunkWords {
    let pcm = try await PCMChunks(asset: asset, rate: sampleRate, range: chunk.start..<chunk.end)
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false) else {
      throw EngineError(message: "no 16 kHz float format")
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.addsPunctuation = true
    request.taskHint = .dictation
    // Feed the whole chunk first (it is at most 50 s, ~3 MB): the decoded origin is known
    // before the request runs, and a decode error never leaves a half-fed task behind.
    var origin: Double?
    while let (samples, position) = try await AnalysisQueue.run({ try pcm.next() }) {
      try Task.checkCancellation()
      if origin == nil { origin = Double(position) / sampleRate }
      guard let buffer = PCMChunks.buffer(samples, format: format) else { continue }
      request.append(buffer)
    }
    request.endAudio()
    guard let origin else {
      // Nothing decoded in this range (the track ends early): no words, not a failure.
      return ChunkWords(chunk: chunk, origin: chunk.start, words: [])
    }
    let box = RecognitionBox()
    let words: [TimedWord] = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        box.start(recognizer.recognitionTask(with: request) { result, error in
          if let result, result.isFinal {
            let words = result.bestTranscription.segments.map {
              TimedWord(text: $0.substring, start: $0.timestamp, end: $0.timestamp + $0.duration)
            }
            box.finish { continuation.resume(returning: words) }
          } else if let error {
            box.finish {
              if Self.isNoSpeech(error) { continuation.resume(returning: []) } else { continuation.resume(throwing: error) }
            }
          }
        })
      }
    } onCancel: {
      box.cancel()
    }
    return ChunkWords(chunk: chunk, origin: origin, words: words)
  }

  /// "No speech detected" (kAFAssistantErrorDomain 1110): a silent chunk.
  static func isNoSpeech(_ error: Error) -> Bool {
    let ns = error as NSError
    return ns.code == 1110 && ns.domain.contains("AFAssistant") || ns.localizedDescription.localizedCaseInsensitiveContains("no speech detected")
  }
}

/// The recognition task of one request, finished once (its handler can fire more than once)
/// and cancellable from another thread.
private final class RecognitionBox: @unchecked Sendable {
  private let lock = NSLock()
  private var task: SFSpeechRecognitionTask?
  private var done = false
  private var cancelled = false

  func start(_ task: SFSpeechRecognitionTask) {
    let cancelNow = lock.withLock { () -> Bool in
      self.task = task
      return cancelled
    }
    if cancelNow { task.cancel() }
  }

  func finish(_ body: () -> Void) {
    let first = lock.withLock { () -> Bool in
      if done { return false }
      done = true
      return true
    }
    if first { body() }
  }

  func cancel() {
    let task = lock.withLock { () -> SFSpeechRecognitionTask? in
      cancelled = true
      return self.task
    }
    // The handler then reports an error, which resumes the continuation; the runner sees
    // the task cancelled and throws CancellationError.
    task?.cancel()
  }
}

/// SpeechAuthorization adapter: SFSpeechRecognizer's permission.
struct SFSpeechAuthorization: SpeechAuthorization {
  var name: String { "sfspeech" }

  var status: SpeechAuthorizationStatus { Self.map(SFSpeechRecognizer.authorizationStatus()) }

  func request() async -> SpeechAuthorizationStatus {
    guard SFSpeechRecognizer.authorizationStatus() == .notDetermined else { return status }
    return await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: Self.map($0)) }
    }
  }

  static func map(_ status: SFSpeechRecognizerAuthorizationStatus) -> SpeechAuthorizationStatus {
    switch status {
    case .authorized: return .authorized
    case .denied: return .denied
    case .restricted: return .restricted
    case .notDetermined: return .notDetermined
    @unknown default: return .denied
    }
  }
}
