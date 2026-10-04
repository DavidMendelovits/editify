// Transcriber score harness (release 1.1, T10): runs the real Transcriber adapters on one
// recording on macOS 26+ and prints what each heard, for server/scripts/score-transcribers.ts
// to score against a reference transcript.
//
//   transcriber-score <media> [engines]     engines: comma list, default all three
//
//   speech-analyzer   SpeechAnalyzerTranscriber.transcribe (the iOS 26 path)
//   sfspeech          SFSpeechTranscriber.transcribe (the iOS 18 path: 50 s chunks, 2 s overlap,
//                     merge, phrases)
//   sfspeech-single   one on-device SFSpeech request over the whole recording (no chunking),
//                     through the same recognize + phrases code, for comparison
//
// Output (stdout): {"engines": [{"engine", "ok", "seconds", "error"?, "transcript"?,
// "chunks"?}], "authorization"}. Each transcript is TranscriptAssembler data, the exact shape
// the app stores. SFSpeech needs speech-recognition permission: the binary embeds an
// Info.plist (see the script) and asks once.

import AVFoundation
import Foundation
import Speech

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func log(_ message: String) {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  log("usage: transcriber-score <media> [speech-analyzer,sfspeech,sfspeech-single]")
  exit(2)
}
let url = URL(fileURLWithPath: args[1])
let wanted = Set((args.count >= 3 ? args[2] : "speech-analyzer,sfspeech,sfspeech-single").split(separator: ",").map(String.init))
let locale = Locale(identifier: "en-US")
let asset = AVURLAsset(url: url)

func timed(_ engine: String, _ body: () async throws -> [String: Any]) async -> [String: Any] {
  log("running \(engine)")
  let started = Date()
  do {
    var entry = try await body()
    entry["engine"] = engine
    entry["ok"] = true
    entry["seconds"] = Date().timeIntervalSince(started)
    return entry
  } catch {
    return ["engine": engine, "ok": false, "seconds": Date().timeIntervalSince(started), "error": "\(error)"]
  }
}

let authorization = SFSpeechAuthorization()
var status = authorization.status
let ask = ProcessInfo.processInfo.environment["TRANSCRIBER_SCORE_NO_ASK"] == nil
if ask, status == .notDetermined, wanted.contains("sfspeech") || wanted.contains("sfspeech-single") {
  // The prompt can go unanswered (no one at the Mac, or a host app TCC won't prompt for):
  // give it 30 s, then run anyway and let the engine report what it gets.
  log("asking for speech recognition permission (30 s)")
  status = await withTaskGroup(of: SpeechAuthorizationStatus.self) { group in
    group.addTask { await authorization.request() }
    group.addTask {
      try? await Task.sleep(for: .seconds(30))
      return .notDetermined
    }
    let first = await group.next() ?? .notDetermined
    group.cancelAll()
    return first
  }
  log("speech recognition permission: \(status.rawValue)")
}

var engines: [[String: Any]] = []

if wanted.contains("speech-analyzer") {
  engines.append(await timed("speech-analyzer") {
    let transcriber = SpeechAnalyzerTranscriber()
    guard case .eligible = await transcriber.eligibility(locale: locale, allowModelDownload: true) else {
      throw EngineError(message: "SpeechAnalyzer is not eligible for \(locale.identifier)")
    }
    let transcription = try await transcriber.transcribe(asset, locale: locale, allowModelDownload: true, progress: nil, gate: nil)
    return ["transcript": TranscriptAssembler.data(transcription)]
  })
}

if wanted.contains("sfspeech") {
  engines.append(await timed("sfspeech") {
    let transcriber = SFSpeechTranscriber()
    if case .ineligible(let reason) = await transcriber.eligibility(locale: locale, allowModelDownload: false) {
      throw EngineError(message: reason)
    }
    let transcription = try await transcriber.transcribe(asset, locale: locale, allowModelDownload: false, progress: nil, gate: nil)
    let duration = try await asset.load(.duration).seconds
    let chunks = SpeechChunks.plan(duration: duration).map { ["index": $0.index, "start": $0.start, "end": $0.end] }
    return ["transcript": TranscriptAssembler.data(transcription), "chunks": chunks]
  })
}

if wanted.contains("sfspeech-single") {
  engines.append(await timed("sfspeech-single") {
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
      throw EngineError(message: "no on-device recognizer for \(locale.identifier)")
    }
    let duration = try await asset.load(.duration).seconds
    let heard = try await SFSpeechTranscriber.recognize(asset, chunk: SpeechChunk(index: 0, start: 0, end: duration), recognizer: recognizer)
    let words = heard.words.map { TimedWord(text: $0.text, start: $0.start + heard.origin, end: $0.end + heard.origin) }
    let transcription = Transcription(results: SpeechChunks.phrases(words), language: "en", durationProcessedSeconds: duration)
    return ["transcript": TranscriptAssembler.data(transcription)]
  })
}

emit(["authorization": status.rawValue, "engines": engines])
