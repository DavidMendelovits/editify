import Foundation

/// How the SFSpeech adapter splits a recording (decision D18, C4): SFSpeechRecognizer works
/// best on short requests, so it always runs 50 s chunks that overlap by 2 s, and the chunks'
/// words are joined back into one timeline here. Pure: the adapter feeds it, the adapters
/// harness tests it.
///
///   recording  0 ───────────────────────────────────────────────────────── duration
///   chunk 0    [0 ─────────── 50]
///   chunk 1                [48 ─────────── 98]
///   chunk 2                            [96 ──── end]
///                          └ 2 s ┘ overlap: each side keeps the words whose middle falls on
///                                  its half; a word heard by both at the seam (same text,
///                                  starts within 0.5 s) is kept once
///
///   each chunk ─▶ ChunkRunner: gate ─▶ attempt (timeout) ─▶ ok
///                                         └ error ─▶ backoff 1 s, 2 s ─▶ retry (2x)
///                                                     └ still failing ─▶ ChunkFailure(index): the whole
///                                                       part is `failed`, never a partial `ready` (C4)
public struct SpeechChunk: Equatable, Sendable {
  public let index: Int
  /// Seconds in the recording.
  public let start: Double
  public let end: Double

  public init(index: Int, start: Double, end: Double) {
    self.index = index
    self.start = start
    self.end = end
  }
}

/// A chunk's recognized words. `origin` is where in the recording the first sample fed to the
/// recognizer sits (the decoder's presentation time, D19); the words are relative to it.
public struct ChunkWords: Sendable {
  public let chunk: SpeechChunk
  public let origin: Double
  public let words: [TimedWord]

  public init(chunk: SpeechChunk, origin: Double, words: [TimedWord]) {
    self.chunk = chunk
    self.origin = origin
    self.words = words
  }
}

public enum SpeechChunks {
  public static let length = 50.0
  public static let overlap = 2.0
  /// Two words at a seam are the same word when their texts match and their starts are this close.
  public static let seamTolerance = 0.5

  /// Chunks covering [start, start + duration): `length` long, each starting `length - overlap`
  /// after the previous one; the last ends at the end. Empty for a non-positive duration.
  public static func plan(duration: Double, start: Double = 0, length: Double = length, overlap: Double = overlap) -> [SpeechChunk] {
    guard duration.isFinite, duration > 0, length > overlap, overlap >= 0 else { return [] }
    let end = start + duration
    var chunks: [SpeechChunk] = []
    var at = start
    while true {
      let chunkEnd = min(at + length, end)
      chunks.append(SpeechChunk(index: chunks.count, start: at, end: chunkEnd))
      if chunkEnd >= end { break }
      at += length - overlap
    }
    return chunks
  }

  /// One timeline from every chunk's words: rebased by each chunk's origin, the overlaps cut at
  /// their middle, and a word both chunks heard at the seam kept once (dedupe by time + text).
  /// `chunks` in index order.
  public static func merge(_ chunks: [ChunkWords]) -> [TimedWord] {
    let rebased = chunks.map { chunk in
      chunk.words.map { TimedWord(text: $0.text, start: $0.start + chunk.origin, end: $0.end + chunk.origin) }
    }
    var merged: [TimedWord] = []
    for (position, words) in rebased.enumerated() {
      let chunk = chunks[position].chunk
      // The seam with the previous chunk is the middle of the overlap; same for the next.
      let lower = position > 0 ? (chunk.start + chunks[position - 1].chunk.end) / 2 : -Double.infinity
      let upper = position + 1 < chunks.count ? (chunks[position + 1].chunk.start + chunk.end) / 2 : Double.infinity
      var kept = words.filter { word in
        let middle = (word.start + word.end) / 2
        return middle >= lower && middle < upper
      }
      // A word straddling the seam can land on both sides with slightly different times.
      while let first = kept.first, let last = merged.last, sameWord(last, first) {
        kept.removeFirst()
      }
      merged.append(contentsOf: kept)
    }
    return merged
  }

  static func sameWord(_ a: TimedWord, _ b: TimedWord) -> Bool {
    normalized(a.text) == normalized(b.text) && abs(a.start - b.start) <= seamTolerance
  }

  static func normalized(_ text: String) -> String {
    text.lowercased().filter { $0.isLetter || $0.isNumber }
  }

  /// Phrases from a word timeline, so SFSpeech's transcript gets segments like SpeechAnalyzer's
  /// (one per spoken phrase, not one per 50 s chunk): a phrase ends after a word ending a
  /// sentence or clause (. ? ! , ; :), before a pause of at least `pause` seconds, or once it
  /// is `maxSeconds` long.
  public static func phrases(_ words: [TimedWord], pause: Double = 0.8, maxSeconds: Double = 12) -> [FinalResult] {
    var results: [FinalResult] = []
    var current: [TimedWord] = []
    func close() {
      guard let first = current.first, let last = current.last else { return }
      results.append(FinalResult(text: current.map(\.text).joined(separator: " "), start: first.start, end: last.end, words: current))
      current = []
    }
    for word in words {
      if let previous = current.last, let first = current.first,
         word.start - previous.end >= pause || word.end - first.start > maxSeconds {
        close()
      }
      current.append(word)
      if let mark = word.text.trimmingCharacters(in: .whitespaces).last, ".?!,;:".contains(mark) { close() }
    }
    close()
    return results
  }
}

/// A chunk that still failed after its retries (C4). The whole words part fails with it.
public struct ChunkFailure: Error, LocalizedError {
  public let index: Int
  public let count: Int
  public let message: String

  public init(index: Int, count: Int, message: String) {
    self.index = index
    self.count = count
    self.message = message
  }

  public var errorDescription: String? { "Transcription failed on chunk \(index + 1) of \(count): \(message)" }
}

/// A chunk attempt that ran past its timeout.
public struct ChunkTimeout: Error, LocalizedError {
  public let seconds: Double
  public init(seconds: Double) { self.seconds = seconds }
  public var errorDescription: String? { "Speech recognition did not finish within \(Int(seconds.rounded())) s" }
}

/// Runs a recording's chunks in order with the C4 retry policy: each attempt bounded by
/// `timeout`, a failure retried `retries` times after `backoff`, cancellation (the gate saying
/// stop, or the task cancelled) passed straight through without a retry.
public struct ChunkRunner: Sendable {
  public var retries = 2
  /// Waits before retry 1, 2, ... (the last one repeats).
  public var backoff: [Double] = [1, 2]
  /// Seconds an attempt may take for a chunk.
  public var timeout: @Sendable (SpeechChunk) -> Double = { chunk in max(60, 3 * (chunk.end - chunk.start)) }
  /// How backoff waits (a test passes a no-op).
  public var sleep: @Sendable (Double) async throws -> Void = { seconds in try await Task.sleep(for: .seconds(seconds)) }

  public init() {}

  public func run<T: Sendable>(_ chunks: [SpeechChunk], gate: AnalyzerGate?,
                               attempt body: @escaping @Sendable (SpeechChunk, Int) async throws -> T) async throws -> [T] {
    var out: [T] = []
    out.reserveCapacity(chunks.count)
    for chunk in chunks {
      var attempt = 0
      while true {
        if let gate, await !gate() { throw CancellationError() }
        try Task.checkCancellation()
        do {
          let current = attempt
          out.append(try await withTimeout(timeout(chunk)) { try await body(chunk, current) })
          break
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          if Task.isCancelled { throw CancellationError() }
          guard attempt < retries else {
            throw ChunkFailure(index: chunk.index, count: chunks.count, message: error.localizedDescription)
          }
          try await sleep(backoff.isEmpty ? 0 : backoff[min(attempt, backoff.count - 1)])
          attempt += 1
        }
      }
    }
    return out
  }

  private func withTimeout<T: Sendable>(_ seconds: Double, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await body() }
      group.addTask {
        try await Task.sleep(for: .seconds(seconds))
        throw ChunkTimeout(seconds: seconds)
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else { throw CancellationError() }
      return first
    }
  }
}
