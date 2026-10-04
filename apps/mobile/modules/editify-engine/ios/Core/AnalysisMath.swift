import Accelerate
import CoreGraphics
import Foundation
import ImageIO

/// The analyzers' arithmetic, kept free of AVFoundation/Vision so the macOS
/// smoke runner (parity/analyzer-math.swift) can check it without a device.
/// Each function names the server code whose output it has to match.
public enum AnalysisMath {
  /// energyAnalysisSchema fixes the cell at 50 ms (server: ffmpeg astats, 2400 samples at 48 kHz).
  public static let energyCellSeconds = 0.05
  /// ffmpeg reports a silent cell as -inf; the server stores it as -100.
  public static let silentDb = -100.0

  /// RMS level per 50 ms cell in dBFS, like server/src/media/audio-analysis.ts.
  /// A trailing partial cell is kept (astats also emits it).
  public static func energy(_ samples: [Float], sampleRate: Int) -> [Double] {
    let cell = Int((Double(sampleRate) * energyCellSeconds).rounded())
    guard cell > 0, !samples.isEmpty else { return [] }
    var levels: [Double] = []
    levels.reserveCapacity(samples.count / cell + 1)
    samples.withUnsafeBufferPointer { pointer in
      var start = 0
      while start < samples.count {
        let length = min(cell, samples.count - start)
        var rms: Float = 0
        vDSP_rmsqv(pointer.baseAddress! + start, 1, &rms, vDSP_Length(length))
        let db = rms > 0 ? 20 * log10(Double(rms)) : silentDb
        levels.append((max(silentDb, db) * 100).rounded() / 100)
        start += cell
      }
    }
    return levels
  }

  /// `energy` over a stream (the low tier's chunked decode, D25): buffers of any size go in,
  /// the same 50 ms levels come out, holding at most one cell of samples. Each full cell is
  /// measured over the same contiguous samples as `energy` does, so the levels are identical.
  public struct EnergyStream {
    private let cell: Int
    private var pending: [Float] = []
    public private(set) var levels: [Double] = []
    public private(set) var sampleCount = 0

    public init(sampleRate: Int) {
      cell = Int((Double(sampleRate) * energyCellSeconds).rounded())
      pending.reserveCapacity(max(0, cell))
    }

    public mutating func append(_ samples: [Float]) {
      guard cell > 0 else { return }
      sampleCount += samples.count
      var start = 0
      if !pending.isEmpty {
        let take = min(cell - pending.count, samples.count)
        pending.append(contentsOf: samples[0..<take])
        start = take
        if pending.count == cell { measure(pending); pending.removeAll(keepingCapacity: true) }
      }
      while samples.count - start >= cell {
        measure(Array(samples[start..<(start + cell)]))
        start += cell
      }
      if start < samples.count { pending.append(contentsOf: samples[start...]) }
    }

    /// The levels, with the trailing partial cell (as `energy` keeps it).
    public mutating func finish() -> [Double] {
      if !pending.isEmpty { measure(pending); pending.removeAll() }
      return levels
    }

    private mutating func measure(_ cellSamples: [Float]) {
      var rms: Float = 0
      cellSamples.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress!, 1, &rms, vDSP_Length(cellSamples.count)) }
      let db = rms > 0 ? 20 * log10(Double(rms)) : silentDb
      levels.append((max(silentDb, db) * 100).rounded() / 100)
    }
  }

  /// Local maxima of linear energy above the 85th percentile, at least 0.25 s
  /// apart: a port of `onsetPeaks` in server/src/services/dissect-service.ts
  /// (the beats cut_to_beats lands on).
  public static func onsetPeaks(_ rmsDb: [Double], cellSeconds: Double) -> [Double] {
    let linear = rmsDb.map { pow(10, $0 / 20) }
    let sorted = linear.sorted()
    let floor = sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int((Double(sorted.count) * 0.85).rounded(.down)))]
    let minGapCells = Int((0.25 / cellSeconds).rounded(.up))
    var peaks: [Double] = []
    var lastPeak = -minGapCells
    var index = 1
    while index + 1 < linear.count {
      let value = linear[index]
      if value >= floor, value >= linear[index - 1], value > linear[index + 1], index - lastPeak >= minGapCells {
        peaks.append((Double(index) * cellSeconds * 100).rounded() / 100)
        lastPeak = index
      }
      index += 1
    }
    return peaks
  }

  /// One classifier window that heard laughter.
  public struct LaughWindow {
    public let start: Double
    public let end: Double
    public let confidence: Double

    public init(start: Double, end: Double, confidence: Double) {
      self.start = start
      self.end = end
      self.confidence = confidence
    }
  }

  /// A laughter span with its classifier confidence (OV10): the peak window's
  /// and the mean over the windows it was merged from.
  public struct LaughSpan { public var start: Double; public var end: Double; public var confidence: Double; public var confidenceSum: Double; public var windows: Int }

  /// Overlapping (or nearly touching, within `gap`) windows merge into one span.
  public static func laughterSpans(_ windows: [LaughWindow], gap: Double = 0.25) -> [LaughSpan] {
    var spans: [LaughSpan] = []
    for window in windows.sorted(by: { $0.start < $1.start }) {
      if let last = spans.last, window.start <= last.end + gap {
        spans[spans.count - 1].end = max(last.end, window.end)
        spans[spans.count - 1].confidence = max(last.confidence, window.confidence)
        spans[spans.count - 1].confidenceSum += window.confidence
        spans[spans.count - 1].windows += 1
      } else {
        spans.append(LaughSpan(start: window.start, end: window.end, confidence: window.confidence, confidenceSum: window.confidence, windows: 1))
      }
    }
    return spans
  }

  /// A detector box (normalized, top-left origin) grown to cover hair and chin,
  /// clamped to the frame, rounded like server/scripts/face_track.py:
  /// `[top, bottom, left, right]`.
  public static func paddedFaceBox(x: Double, y: Double, width: Double, height: Double) -> [Double] {
    let round4 = { (value: Double) in (value * 10_000).rounded() / 10_000 }
    return [
      round4(max(0, y - 0.35 * height)),
      round4(min(1, y + 1.12 * height)),
      round4(max(0, x - 0.08 * width)),
      round4(min(1, x + 1.08 * width)),
    ]
  }

  /// Vision boxes are normalized with a bottom-left origin; face_track.py's are top-left.
  public static func topLeftBox(fromVision box: CGRect) -> (x: Double, y: Double, width: Double, height: Double) {
    (Double(box.minX), Double(1 - box.maxY), Double(box.width), Double(box.height))
  }

  /// The EXIF orientation that turns a track's stored frames upright, from its
  /// `preferredTransform` (rotation in 90° steps, optionally mirrored).
  public static func orientation(of transform: CGAffineTransform) -> CGImagePropertyOrientation {
    let a = transform.a.rounded(), b = transform.b.rounded(), c = transform.c.rounded(), d = transform.d.rounded()
    switch (a, b, c, d) {
    case (0, 1, -1, 0): return .right
    case (0, -1, 1, 0): return .left
    case (-1, 0, 0, -1): return .down
    case (-1, 0, 0, 1): return .upMirrored
    case (1, 0, 0, -1): return .downMirrored
    case (0, 1, 1, 0): return .leftMirrored
    case (0, -1, -1, 0): return .rightMirrored
    default: return .up
    }
  }

  /// Placement of a cover-scaled, cropped source in a render frame, with
  /// render.ts's static-crop semantics: scale the source to cover
  /// `render × max(1, scale)`, then crop `render` with its top-left at
  /// `((sw - W) / 2 · (1 + x), (sh - H) / 2 · (1 + y))`. x = -1 shows the left
  /// edge, y = -1 the top. Returned in Core Image space (bottom-left origin):
  /// apply it to an upright source whose extent starts at the origin.
  public static func cropPlacement(source: CGSize, render: CGSize, scale: CGFloat, x: CGFloat, y: CGFloat) -> CGAffineTransform {
    let cover = max(render.width / source.width, render.height / source.height) * scale
    let scaledWidth = source.width * cover
    let scaledHeight = source.height * cover
    let offsetX = (scaledWidth - render.width) / 2 * (1 + x)
    // Top-left offset `(sh - H) / 2 · (1 + y)` measured from the bottom instead.
    let offsetY = (scaledHeight - render.height) / 2 * (1 - y)
    return CGAffineTransform(scaleX: cover, y: cover).concatenating(CGAffineTransform(translationX: -offsetX, y: -offsetY))
  }

  /// Even-sided size that fits `size` under `maxHeight` (no upscaling); H.264 wants even dimensions.
  public static func proxySize(for size: CGSize, maxHeight: CGFloat) -> CGSize {
    let factor = min(1, maxHeight / size.height)
    let even = { (value: CGFloat) in max(2, (value * factor / 2).rounded() * 2) }
    return CGSize(width: even(size.width), height: even(size.height))
  }

  /// The device preview proxy's frame (decision 10B): scaled so the short side is at most
  /// `maxShortSide`, aspect kept, never upscaled, both sides even (4:2:0 chroma).
  public static func previewProxySize(for size: CGSize, maxShortSide: CGFloat = 1080) -> CGSize {
    let short = min(abs(size.width), abs(size.height))
    guard short > 0 else { return .zero }
    let factor = min(1, maxShortSide / short)
    let even = { (value: CGFloat) in max(2, (abs(value) * factor / 2).rounded() * 2) }
    return CGSize(width: even(size.width), height: even(size.height))
  }

  /// A track transform for a frame of `size`: the source's rotation/flip, translated so
  /// the upright frame starts at the origin. Rebuilt rather than scaled, so a frame whose
  /// sides were rounded independently still lands exactly in the positive quadrant.
  public static func uprightTransform(_ transform: CGAffineTransform, size: CGSize) -> CGAffineTransform {
    let rotation = CGAffineTransform(a: transform.a, b: transform.b, c: transform.c, d: transform.d, tx: 0, ty: 0)
    let rect = CGRect(origin: .zero, size: size).applying(rotation)
    return rotation.concatenating(CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
  }

  /// Version tag of `envelopeHash`; packages/shared-side matching (local-media.ts) refuses
  /// to compare hashes with different tags.
  public static let envelopeHashVersion = "e1"
  /// Rises smaller than this (dB) count as flat, so a re-encode's rounding noise on a
  /// steady passage doesn't flip bits.
  public static let envelopeDeadbandDb = 0.5

  /// A coarse fingerprint of an energy curve (50 ms RMS cells, `energy`): one bit per
  /// cell, set when the level rose by more than the deadband since the previous cell,
  /// as hex after a version tag ("e1:9f3c…"). The same audio decodes to the same
  /// string; a copy trimmed at the front shifts every cell and scrambles about half
  /// the bits. local-media.ts compares two of these by Hamming distance.
  public static func envelopeHash(_ rmsDb: [Double]) -> String {
    guard rmsDb.count > 1 else { return "\(envelopeHashVersion):" }
    var hex = ""
    var nibble = 0
    var filled = 0
    for index in 1..<rmsDb.count {
      nibble = (nibble << 1) | (rmsDb[index] - rmsDb[index - 1] > envelopeDeadbandDb ? 1 : 0)
      filled += 1
      if filled == 4 {
        hex.append(String(nibble, radix: 16))
        nibble = 0
        filled = 0
      }
    }
    if filled > 0 { hex.append(String(nibble << (4 - filled), radix: 16)) }
    return "\(envelopeHashVersion):\(hex)"
  }
}
