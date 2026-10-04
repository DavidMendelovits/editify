// The Transcriber chain, its chunk policies, the assembler and the decoder's PTS origin
// (D10, D18-D21, C4, C25), against stub adapters. Part of the adapters harness (main.swift).

import AVFoundation
import Foundation

// MARK: - Stubs

/// A stub Transcriber link over a String "asset".
final class StubTranscriber: Transcriber, @unchecked Sendable {
  enum Outcome { case results([FinalResult]), ineligibleAtRun(String), failure(String), noAudio }
  let name: String
  let wordsVersion: String
  let requiresSpeechAuthorization: Bool
  var eligible: TranscriberEligibility
  var outcome: Outcome
  var runs = 0

  init(_ name: String, version: String, auth: Bool, eligible: TranscriberEligibility = .eligible, outcome: Outcome) {
    self.name = name
    wordsVersion = version
    requiresSpeechAuthorization = auth
    self.eligible = eligible
    self.outcome = outcome
  }

  func eligibility(locale: Locale, allowModelDownload: Bool) async -> TranscriberEligibility { eligible }

  func transcribe(_ asset: String, locale: Locale, allowModelDownload: Bool, progress: AnalyzerProgress?, gate: AnalyzerGate?) async throws -> Transcription {
    runs += 1
    switch outcome {
    case .results(let results): return Transcription(results: results, language: "en", durationProcessedSeconds: 12)
    case .ineligibleAtRun(let reason): throw TranscriberIneligible(reason)
    case .failure(let message): throw EngineError(message: message)
    case .noAudio: throw NoAudio()
    }
  }
}

final class StubAuthorization: SpeechAuthorization, @unchecked Sendable {
  var name: String { "stub" }
  var current: SpeechAuthorizationStatus
  let answer: SpeechAuthorizationStatus
  var requests = 0
  init(_ status: SpeechAuthorizationStatus, answer: SpeechAuthorizationStatus = .authorized) {
    current = status
    self.answer = answer
  }
  var status: SpeechAuthorizationStatus { current }
  func request() async -> SpeechAuthorizationStatus {
    requests += 1
    if current == .notDetermined { current = answer }
    return current
  }
}

let sample = [
  FinalResult(text: " Hello there. ", start: 0.5, end: 1.4, words: [
    TimedWord(text: "Hello", start: 0.5, end: 0.81234), TimedWord(text: " there.", start: 0.9, end: 1.4),
  ]),
  // No timed words: the segment falls back to the result's range.
  FinalResult(text: "Untimed", start: 2, end: 2.5, words: []),
  // Empty text: its words still count, no segment.
  FinalResult(text: "  ", start: 3, end: 3.2, words: [TimedWord(text: "um", start: 3, end: 3.2)]),
  // An empty word is skipped; a negative start clamps to 0; an end before its start is lifted.
  FinalResult(text: "Edge", start: -0.2, end: 0.1, words: [TimedWord(text: "  ", start: 0, end: 0.1), TimedWord(text: "Edge", start: -0.2, end: -0.3)]),
]

/// The SpeechAnalyzer path's inline assembly before D10 (Analyzers.words at 6d754df), on the same
/// inputs, so the assembler is held to the schema it always produced.
func legacyAssemble(_ results: [FinalResult], language: String, duration: Double) -> [String: Any] {
  var words: [[String: Any]] = []
  var segments: [[String: Any]] = []
  for result in results {
    var first: Double?
    var last: Double?
    for run in result.words {
      let text = run.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      let start = max(0, run.start), end = max(start, run.end)
      words.append(["w": text, "s": round3(start), "e": round3(end)])
      first = first ?? start
      last = end
    }
    let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { continue }
    let start = first ?? max(0, result.start)
    let end = last ?? max(start, result.end)
    segments.append(["text": text, "s": round3(start), "e": round3(end)])
  }
  return ["language": language, "durationProcessedSeconds": max(0, duration), "words": words, "segments": segments]
}

func json(_ value: Any) -> String {
  String(data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? ""
}

func chain(_ links: [StubTranscriber], auth: StubAuthorization = StubAuthorization(.authorized), trigger: String = "os=26.0;sa=0") -> TranscriberChain<String> {
  TranscriberChain(links, authorization: auth, trigger: { trigger })
}

func speechChecks() async {
  // MARK: TranscriptAssembler (D10)
  let assembled = TranscriptAssembler.data(Transcription(results: sample, language: "en", durationProcessedSeconds: 12))
  check("assembler: today's schema exactly (words, segments, round3, empty-text skip, first/last fallback)",
        json(assembled) == json(legacyAssemble(sample, language: "en", duration: 12)), json(assembled))
  let words = (assembled["words"] as? [[String: Any]]) ?? []
  check("assembler: rounds to the millisecond and clamps", json(words.first ?? [:]) == json(["w": "Hello", "s": 0.5, "e": 0.812])
        && json(words.last ?? [:]) == json(["w": "Edge", "s": 0, "e": 0]), json(words))

  // Both adapters' FinalResult[] through the chain give the same data, differing only in version.
  let saLink = StubTranscriber("speech-analyzer", version: AnalyzerVersion.wordsSpeechAnalyzer, auth: false, outcome: .results(sample))
  let sfLink = StubTranscriber("sfspeech", version: AnalyzerVersion.wordsSFSpeech, auth: true, outcome: .results(sample))
  let viaSA = await chain([saLink]).words("clip", locale: Locale(identifier: "en_US"), allowModelDownload: true, progress: nil, gate: nil)
  let viaSF = await chain([sfLink]).words("clip", locale: Locale(identifier: "en_US"), allowModelDownload: true, progress: nil, gate: nil)
  check("assembler parity: SpeechAnalyzer and SFSpeech results give identical transcript data",
        viaSA.status == "ready" && viaSF.status == "ready" && json(viaSA.data ?? [:]) == json(viaSF.data ?? [:]))
  check("versions: the result records the adapter that ran (w-sa1 / w-sf2)",
        viaSA.analyzerVersion == "w-sa1" && viaSF.analyzerVersion == "w-sf2", [viaSA.analyzerVersion, viaSF.analyzerVersion])

  // MARK: Chain fallthrough (D20, C25)
  do {
    let sa = StubTranscriber("speech-analyzer", version: "w-sa1", auth: false, outcome: .results(sample))
    let sf = StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .results(sample))
    let both = chain([sa, sf])
    let first = await both.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("chain: SpeechAnalyzer eligible → it runs, SFSpeech untouched", first.analyzerVersion == "w-sa1" && sa.runs == 1 && sf.runs == 0
          && both.lastRan == "speech-analyzer")
    sa.eligible = .ineligible("No speech model for xx")
    let second = await both.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("chain: SpeechAnalyzer ineligible → SFSpeech", second.status == "ready" && second.analyzerVersion == "w-sf1" && sf.runs == 1
          && both.lastRan == "sfspeech", second.dictionary)
    sa.eligible = .eligible
    sa.outcome = .ineligibleAtRun("The speech model for en_US could not be downloaded")
    let third = await both.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("chain: a failed model download falls through to SFSpeech (not unavailable)", third.status == "ready" && third.analyzerVersion == "w-sf1",
          third.dictionary)
    sf.eligible = .ineligible("On-device speech recognition is not available for xx")
    let fourth = await both.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("chain: nothing eligible → unavailable with every reason", fourth.status == "unavailable"
          && fourth.error == "The speech model for en_US could not be downloaded; On-device speech recognition is not available for xx", fourth.dictionary)
    check("chain: every result carries the trigger", [first, second, third, fourth].allSatisfy { $0.trigger == "os=26.0;sa=0" })
    let failing = chain([StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .failure("Transcription failed on chunk 3 of 7: timeout"))])
    let failed = await failing.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("chain: a failing adapter fails the part (no fallthrough, no partial ready)", failed.status == "failed"
          && failed.error == "Transcription failed on chunk 3 of 7: timeout", failed.dictionary)
    let silent = await chain([StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .noAudio)])
      .words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("chain: no audio track → unavailable", silent.status == "unavailable" && silent.error == NoAudio().localizedDescription)
  }

  // MARK: Speech authorization, four statuses (D21)
  for status in SpeechAuthorizationStatus.allCases {
    let sf = StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .results(sample))
    let auth = StubAuthorization(status, answer: .authorized)
    let result = await chain([sf], auth: auth).words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    switch status {
    case .authorized:
      check("auth authorized: transcribes without asking", result.status == "ready" && auth.requests == 0 && sf.runs == 1)
    case .notDetermined:
      // C15: the words run never prompts (it may run with Editify in the background); the
      // pre-prompt sheet asks and JS re-queues.
      check("auth notDetermined: no prompt from the words run, unavailable with the not-asked code, nothing transcribed",
            result.status == "unavailable" && result.code == "speechRecognitionNotAsked" && auth.requests == 0 && sf.runs == 0, result.dictionary)
    case .denied, .restricted:
      check("auth \(status.rawValue): unavailable, speech-off reason + Settings code, nothing transcribed",
            result.status == "unavailable" && result.error == "Speech recognition is off for Editify" && result.code == "speechRecognitionOff"
              && auth.requests == 0 && sf.runs == 0, result.dictionary)
    }
  }
  do {
    let sf = StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .results(sample))
    let declined = StubAuthorization(.notDetermined, answer: .denied)
    let words = chain([sf], auth: declined)
    let before = await words.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    _ = await declined.request() // the sheet's Continue, answered "Don't Allow"
    let result = await words.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("auth: declining the sheet's prompt → the re-run is unavailable with the Settings code",
          before.code == "speechRecognitionNotAsked" && result.status == "unavailable" && result.code == "speechRecognitionOff"
          && declined.requests == 1 && sf.runs == 0, result.dictionary)
    let granting = StubAuthorization(.notDetermined, answer: .authorized)
    let grantChain = chain([sf], auth: granting)
    let first = await grantChain.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    _ = await granting.request() // the sheet's Continue, answered "Allow"
    let requeued = await grantChain.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    let foreground = StubAuthorization(.notDetermined, answer: .authorized)
    let foregroundSF = StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .results(sample))
    let asking = TranscriberChain<String>([foregroundSF], authorization: foreground, trigger: { "os=18.0;sa=0" }, asksForSpeech: true)
    let asked = await asking.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("auth: asksForSpeech (a foreground caller) asks once, then transcribes", asked.status == "ready" && foreground.requests == 1, asked.dictionary)
    let noModel = StubTranscriber("sfspeech", version: "w-sf1", auth: true, eligible: .ineligible("On-device speech recognition is not available for en_US"),
                                  outcome: .results(sample))
    let deniedNoModel = await chain([noModel], auth: StubAuthorization(.denied)).words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("auth: denied before eligibility, so a phone without the on-device model still gets the Settings code",
          deniedNoModel.status == "unavailable" && deniedNoModel.code == "speechRecognitionOff", deniedNoModel.dictionary)
    check("auth: granted from the sheet → the re-queued run transcribes",
          first.code == "speechRecognitionNotAsked" && requeued.status == "ready" && granting.requests == 1 && sf.runs == 1, requeued.dictionary)
    // SpeechAnalyzer needs no speech permission: a denied user still gets words on 26.
    let sa = StubTranscriber("speech-analyzer", version: "w-sa1", auth: false, outcome: .results(sample))
    let saResult = await chain([sa, sf], auth: StubAuthorization(.denied)).words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    check("auth: SpeechAnalyzer runs without speech permission", saResult.status == "ready" && saResult.analyzerVersion == "w-sa1")
  }

  // MARK: C25: one re-run per trigger, no loop on a failing model install
  do {
    let sa = StubTranscriber("speech-analyzer", version: "w-sa1", auth: false, outcome: .ineligibleAtRun("could not be downloaded"))
    let sf = StubTranscriber("sfspeech", version: "w-sf1", auth: true, outcome: .results(sample))
    var trigger = "os=18.7;sa=0"
    let box = TriggerBox()
    let words = TranscriberChain<String>([sa, sf], authorization: StubAuthorization(.authorized), trigger: { box.value })
    box.value = trigger
    // Transcribed on iOS 18 by SFSpeech, then the phone updates to 26.
    var stored = PartResult.ready("w-sf1", [:])
    stored.trigger = trigger
    trigger = "os=26.0;sa=0"
    box.value = trigger
    var runs = 0
    for _ in 0..<5 where !words.freshness.isCurrent(version: stored.analyzerVersion, trigger: stored.trigger) {
      runs += 1
      stored = await words.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    }
    check("C25: after an OS update, a fallback result re-runs once; a failing model install doesn't loop",
          runs == 1 && sa.runs == 1 && sf.runs == 1 && stored.analyzerVersion == "w-sf1" && stored.trigger == "os=26.0;sa=0", [runs, sa.runs, sf.runs])
    // A model install elsewhere moves the trigger: one more re-run, now on SpeechAnalyzer.
    sa.outcome = .results(sample)
    box.value = "os=26.0;sa=1"
    runs = 0
    for _ in 0..<5 where !words.freshness.isCurrent(version: stored.analyzerVersion, trigger: stored.trigger) {
      runs += 1
      stored = await words.words("clip", locale: .current, allowModelDownload: true, progress: nil, gate: nil)
    }
    check("C25: a model install re-runs once, and the best adapter's result then stays", runs == 1 && stored.analyzerVersion == "w-sa1", runs)
    let defaults = UserDefaults(suiteName: "editify-adapters-harness-\(UUID().uuidString)")!
    let counter = TranscriberTrigger(os: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 2), defaults: defaults)
    let before = counter.id
    counter.modelInstalled()
    check("trigger: OS major.minor and model installs", before == "os=26.1;sa=0" && counter.id == "os=26.1;sa=1", [before, counter.id])
    let fresh = WordsFreshness(best: "w-sa1", versions: ["w-sa1", "w-sf1"], trigger: "t2")
    check("freshness: an analyzer version this build doesn't write is stale",
          !fresh.isCurrent(version: "speechanalyzer-ios26-2", trigger: "t2") && fresh.isCurrent(version: "w-sa1", trigger: nil)
            && fresh.isCurrent(version: "w-sf1", trigger: "t2") && !fresh.isCurrent(version: "w-sf1", trigger: "t1"))
  }

  // MARK: Chunks (D18): plan, rebase, overlap dedupe
  let plan = SpeechChunks.plan(duration: 120)
  check("chunks: 50 s with 2 s overlap", plan == [SpeechChunk(index: 0, start: 0, end: 50), SpeechChunk(index: 1, start: 48, end: 98),
                                                 SpeechChunk(index: 2, start: 96, end: 120)], plan)
  check("chunks: a short clip is one chunk, nothing is no chunk", SpeechChunks.plan(duration: 12) == [SpeechChunk(index: 0, start: 0, end: 12)]
        && SpeechChunks.plan(duration: 0).isEmpty && SpeechChunks.plan(duration: .nan).isEmpty)
  check("chunks: a nonzero start shifts every chunk", SpeechChunks.plan(duration: 60, start: 1.5).map(\.start) == [1.5, 49.5])
  do {
    let c0 = SpeechChunk(index: 0, start: 0, end: 50), c1 = SpeechChunk(index: 1, start: 48, end: 98)
    // Chunk 0 hears "seam" at 48.6-49.1 and a clipped "edge" at 49.8; chunk 1 (origin 48) hears
    // "seam" at 0.62 (48.62) and "edge" whole at 1.8-2.2 (49.8-50.2), then "after".
    let merged = SpeechChunks.merge([
      ChunkWords(chunk: c0, origin: 0, words: [TimedWord(text: "before", start: 47.0, end: 47.5), TimedWord(text: "seam", start: 48.6, end: 49.1),
                                              TimedWord(text: "ed", start: 49.8, end: 50.0)]),
      ChunkWords(chunk: c1, origin: 48, words: [TimedWord(text: "Seam,", start: 0.62, end: 1.05), TimedWord(text: "edge", start: 1.8, end: 2.2),
                                               TimedWord(text: "after", start: 3, end: 3.4)]),
    ])
    check("merge: rebased by origin, the seam word once, the clipped edge word from the next chunk",
          merged.map(\.text) == ["before", "seam", "edge", "after"] && abs(merged[2].start - 49.8) < 1e-9 && abs(merged[3].start - 51) < 1e-9,
          merged.map { "\($0.text)@\($0.start)" })
    // A word both chunks put on their own side of the cut (49 s) with slightly different times.
    let straddle = SpeechChunks.merge([
      ChunkWords(chunk: c0, origin: 0, words: [TimedWord(text: "word", start: 48.7, end: 48.95)]),
      ChunkWords(chunk: c1, origin: 48, words: [TimedWord(text: "Word.", start: 0.95, end: 1.3)]),
    ])
    check("merge: dedupe by time + text across the cut", straddle.count == 1 && straddle[0].text == "word", straddle.map(\.text))
    let repeated = SpeechChunks.merge([
      ChunkWords(chunk: c0, origin: 0, words: [TimedWord(text: "no", start: 47.0, end: 47.2)]),
      ChunkWords(chunk: c1, origin: 48, words: [TimedWord(text: "no", start: 1.5, end: 1.7)]),
    ])
    check("merge: the same word said twice, apart in time, stays twice", repeated.map(\.text) == ["no", "no"])
    // "no no" said inside the overlap, 0.4 s apart: both chunks hear both, each keeps one on its
    // side of the cut. A genuine repeat, not one word heard twice.
    let saidTwice = SpeechChunks.merge([
      ChunkWords(chunk: c0, origin: 0, words: [TimedWord(text: "no", start: 48.6, end: 48.85), TimedWord(text: "no", start: 49.0, end: 49.25)]),
      ChunkWords(chunk: c1, origin: 48, words: [TimedWord(text: "no", start: 0.62, end: 0.86), TimedWord(text: "no", start: 1.02, end: 1.26)]),
    ])
    check("merge: a repeat inside the overlap (\"no no\") stays twice", saidTwice.map(\.text) == ["no", "no"], saidTwice.map { "\($0.text)@\($0.start)" })
    let phrases = SpeechChunks.phrases([TimedWord(text: "Hi", start: 0, end: 0.2), TimedWord(text: "there.", start: 0.3, end: 0.6),
                                        TimedWord(text: "Next", start: 0.7, end: 0.9), TimedWord(text: "bit", start: 2.5, end: 2.8)])
    // T10: a request reports each utterance on its own, then a final result repeating the last.
    func ws(_ start: Double, _ texts: String...) -> [TimedWord] {
      texts.enumerated().map { TimedWord(text: $1, start: start + Double($0) * 0.3, end: start + Double($0) * 0.3 + 0.25) }
    }
    let joined = SpeechChunks.joinUtterances([ws(0, "You", "guys"), ws(6.9, "I", "had"), [], ws(46.32, "ready"), ws(46.32, "ready.")])
    check("utterances: every utterance kept, the final repeat of the last one replaces it",
          joined.map(\.text) == ["You", "guys", "I", "had", "ready."], joined.map(\.text))
    let cumulative = SpeechChunks.joinUtterances([ws(0, "one"), ws(0, "one", "two"), ws(0, "one", "two", "three")])
    check("utterances: a cumulative report keeps only its latest version", cumulative.map(\.text) == ["one", "two", "three"], cumulative.map(\.text))
    check("phrases: split after sentence punctuation and before long pauses",
          phrases.map(\.text) == ["Hi there.", "Next", "bit"] && phrases[0].start == 0 && phrases[0].end == 0.6, phrases.map(\.text))
  }

  // MARK: Retry policy (C4)
  do {
    var runner = ChunkRunner()
    runner.sleep = { _ in }
    runner.timeout = { _ in 0.2 }
    let chunks = SpeechChunks.plan(duration: 150)
    let attempts = AttemptLog()
    let ok = try? await runner.run(chunks, gate: nil) { chunk, attempt in
      attempts.add(chunk.index, attempt)
      if chunk.index == 1 && attempt < 2 { throw EngineError(message: "flaky") }
      return chunk.index
    }
    check("retry: a chunk failing twice succeeds on its third attempt", ok == [0, 1, 2, 3] && attempts.count(1) == 3 && attempts.count(0) == 1, attempts.all)
    do {
      _ = try await runner.run(chunks, gate: nil) { chunk, _ in
        if chunk.index == 2 { throw EngineError(message: "recognizer error 1101") }
        return chunk.index
      }
      check("retry: a chunk failing three times fails the whole run with its index", false)
    } catch let failure as ChunkFailure {
      check("retry: a chunk failing three times fails the whole run with its index",
            failure.index == 2 && failure.count == 4 && failure.localizedDescription == "Transcription failed on chunk 3 of 4: recognizer error 1101",
            failure.localizedDescription)
    } catch {
      check("retry: a chunk failing three times fails the whole run with its index", false, error)
    }
    let hung = AttemptLog()
    do {
      _ = try await runner.run([SpeechChunk(index: 0, start: 0, end: 50)], gate: nil) { chunk, attempt in
        hung.add(chunk.index, attempt)
        try await Task.sleep(for: .seconds(30))
        return 0
      }
      check("timeout: a hung request times out, is retried, then fails", false)
    } catch let failure as ChunkFailure {
      check("timeout: a hung request times out, is retried, then fails", hung.count(0) == 3 && failure.message.contains("did not finish"), failure.message)
    } catch {
      check("timeout: a hung request times out, is retried, then fails", false, error)
    }
    let stopped = AttemptLog()
    do {
      _ = try await runner.run(chunks, gate: { stopped.count(0) == 0 }) { chunk, attempt in
        stopped.add(chunk.index, attempt)
        return 0
      }
      check("cancel: the gate saying stop cancels before the next chunk, without retries", false)
    } catch is CancellationError {
      check("cancel: the gate saying stop cancels before the next chunk, without retries", stopped.all.count == 1, stopped.all)
    } catch {
      check("cancel: the gate saying stop cancels before the next chunk, without retries", false, error)
    }
    let task = Task { () -> String in
      do {
        _ = try await runner.run(chunks, gate: nil) { _, _ in
          try await Task.sleep(for: .seconds(30))
          return 0
        }
        return "finished"
      } catch is CancellationError { return "cancelled" } catch { return "\(error)" }
    }
    try? await Task.sleep(for: .milliseconds(50))
    task.cancel()
    let outcome = await task.value
    check("cancel: cancelling the task stops the running chunk, no retry", outcome == "cancelled", outcome)

    // The SFSpeech request itself (RecognitionRun): a recognizer that never calls back after
    // cancel() must not hang the chunk timeout. This one ignores its stop entirely.
    let deaf = AttemptLog()
    let started = ContinuousClock.now
    do {
      _ = try await runner.run([SpeechChunk(index: 0, start: 0, end: 50)], gate: nil) { chunk, attempt in
        deaf.add(chunk.index, attempt)
        return try await RecognitionRun<Int>().run { _ in { /* the recognizer never answers, even when stopped */ } }
      }
      check("recognition: a recognizer silent after cancel still times out and fails the chunk", false)
    } catch let failure as ChunkFailure {
      check("recognition: a recognizer silent after cancel still times out and fails the chunk",
            deaf.count(0) == 3 && failure.message.contains("did not finish") && ContinuousClock.now - started < .seconds(5), failure.message)
    } catch {
      check("recognition: a recognizer silent after cancel still times out and fails the chunk", false, error)
    }
    let stops = AttemptLog()
    let pending = RecognitionRun<Int>()
    let waiter = Task { () -> String in
      do { return "answered \(try await pending.run { _ in { stops.add(0, 0) } })" } catch is CancellationError { return "cancelled" } catch { return "\(error)" }
    }
    try? await Task.sleep(for: .milliseconds(50))
    waiter.cancel()
    let waited = await waiter.value
    pending.finish(.success(7)) // the recognizer's late handler: ignored
    check("recognition: cancelling stops the request once and answers CancellationError itself", waited == "cancelled" && stops.all.count == 1,
          [waited, "\(stops.all.count)"])
    let twice = try? await RecognitionRun<Int>().run { run in
      run.finish(.success(1))
      run.finish(.success(2)) // a handler that fires again
      return {}
    }
    check("recognition: only the first answer counts", twice == 1, twice as Any)
  }
}

final class TriggerBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored = ""
  var value: String {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}

final class AttemptLog: @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [[Int]] = []
  func add(_ index: Int, _ attempt: Int) { lock.withLock { entries.append([index, attempt]) } }
  func count(_ index: Int) -> Int { lock.withLock { entries.filter { $0[0] == index }.count } }
  var all: [[Int]] { lock.withLock { entries } }
}

// MARK: - Decoder PTS origin (D19)

/// A clip whose audio starts 1.5 s in (an edit list's empty edit, as editors and ffmpeg's
/// -itsoffset write), with 40 ms tone bursts at 2.0 and 3.25 s of the recording. Synthesized
/// here, never committed.
func writePTSFixture(to url: URL) async throws {
  try? FileManager.default.removeItem(at: url)
  let rate = 16_000.0
  let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
  let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
  ])
  input.expectsMediaDataInRealTime = false
  writer.add(input)
  guard writer.startWriting() else { throw writer.error ?? EngineError(message: "writer did not start") }
  writer.startSession(atSourceTime: .zero)
  let start = 1.5, seconds = 3.0
  let total = Int(seconds * rate)
  var samples = [Int16](repeating: 0, count: total)
  for burst in [2.0, 3.25] {
    let first = Int((burst - start) * rate)
    for i in 0..<Int(0.04 * rate) { samples[first + i] = Int16(12_000 * sin(2 * Double.pi * 1000 * Double(i) / rate)) }
  }
  var format: CMAudioFormatDescription?
  var description = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                                mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                                mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
  CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                 formatDescriptionOut: &format)
  let chunk = 4_000
  for offset in stride(from: 0, to: total, by: chunk) {
    let count = min(chunk, total - offset)
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: count * 2, blockAllocator: nil, customBlockSource: nil,
                                       offsetToData: 0, dataLength: count * 2, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
    samples[offset..<(offset + count)].withUnsafeBytes { bytes in
      _ = CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: count * 2)
    }
    var buffer: CMSampleBuffer?
    let pts = CMTime(value: CMTimeValue(Int(start * rate) + offset), timescale: CMTimeScale(rate))
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!, sampleCount: count,
                                                         presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &buffer)
    while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
    input.append(buffer!)
  }
  input.markAsFinished()
  await writer.finishWriting()
  if writer.status != .completed { throw writer.error ?? EngineError(message: "writer failed") }
}

/// A stub recognizer over real decoded audio: each tone burst is a "word", timed relative to the
/// first sample of its chunk, as SFSpeech reports segment times. Rebased through the same
/// merge the SFSpeech adapter uses.
func toneWords(_ asset: AVAsset, chunk: SpeechChunk) async throws -> ChunkWords {
  let rate = 16_000.0
  let pcm = try await PCMChunks(asset: asset, rate: rate, range: chunk.start..<chunk.end)
  var origin: Double?
  var fed = 0
  var words: [TimedWord] = []
  var inTone = false
  while let (samples, position) = try pcm.next() {
    if origin == nil { origin = Double(position) / rate }
    for (i, value) in samples.enumerated() {
      let loud = abs(value) > 0.1
      if loud && !inTone { words.append(TimedWord(text: "beep", start: Double(fed + i) / rate, end: Double(fed + i) / rate + 0.04)) }
      inTone = loud || (inTone && i + 1 < samples.count && abs(samples[i + 1]) > 0.1)
    }
    fed += samples.count
  }
  return ChunkWords(chunk: chunk, origin: origin ?? chunk.start, words: words)
}

func ptsChecks(work: URL) async {
  do {
    let url = work.appendingPathComponent("pts-origin.mov")
    try await writePTSFixture(to: url)
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    // A whole-file read: AVAssetReader fills the empty edit with silence from 0, so positions
    // already start at the recording's start.
    let whole = try await PCMChunks(asset: asset, rate: 16_000)
    let wholeOrigin = Double(try whole.next()?.position ?? -1) / 16_000
    check("decoder: a whole-file read starts at 0 (the empty edit decodes as silence)", wholeOrigin == 0, wholeOrigin)
    // A read of a later span (an SFSpeech chunk) starts at that span's presentation time: before
    // D19 its first position was 0, which put every word of every chunk but the first early.
    let span = try await PCMChunks(asset: asset, rate: 16_000, range: 1.5..<4.5)
    let spanOrigin = Double(try span.next()?.position ?? -1) / 16_000
    check("decoder: a read starting 1.5 s in reports positions from 1.5 s, not 0 (D19)", abs(spanOrigin - 1.5) < 0.002, spanOrigin)
    // Two chunks (2 s long, 0.5 s overlap) so the rebase and the seam run on real decoded audio.
    let duration = try await asset.load(.duration).seconds
    let chunks = SpeechChunks.plan(duration: duration, length: 2, overlap: 0.5)
    var heard: [ChunkWords] = []
    for chunk in chunks { heard.append(try await toneWords(asset, chunk: chunk)) }
    let words = SpeechChunks.merge(heard)
    let times = words.map { ($0.start * 1000).rounded() / 1000 }
    check("decoder fixture: words at absolute times (2.0 s, 3.25 s) through chunking and rebase",
          times.count == 2 && abs(times[0] - 2.0) < 0.01 && abs(times[1] - 3.25) < 0.01, times)
  } catch {
    check("decoder fixture: words at absolute times (2.0 s, 3.25 s) through chunking and rebase", false, error)
  }
}
