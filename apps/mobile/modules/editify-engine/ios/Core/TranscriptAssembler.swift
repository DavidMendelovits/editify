import Foundation

/// transcriptResultSchema data (packages/shared/src/analysis.ts) from a Transcriber's final
/// results (decision D10). The rules are the ones the SpeechAnalyzer path always had, so every
/// adapter produces the same shape:
///   - a word: its text trimmed, skipped when empty; start clamped at 0, end at least start;
///     times rounded to the millisecond
///   - a segment per result whose trimmed text is not empty, from its first word's start to its
///     last word's end, falling back to the result's own range when it has no timed word
public enum TranscriptAssembler {
  public static func data(_ transcription: Transcription) -> [String: Any] {
    var words: [[String: Any]] = []
    var segments: [[String: Any]] = []
    for result in transcription.results {
      var first: Double?
      var last: Double?
      for word in result.words {
        let text = word.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { continue }
        let start = max(0, word.start), end = max(start, word.end)
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
    return [
      "language": transcription.language,
      "durationProcessedSeconds": max(0, transcription.durationProcessedSeconds),
      "words": words,
      "segments": segments,
    ]
  }
}
