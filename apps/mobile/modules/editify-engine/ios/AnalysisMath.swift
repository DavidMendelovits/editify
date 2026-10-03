import Accelerate
import CoreGraphics
import Foundation
import ImageIO

/// The analyzers' arithmetic, kept free of AVFoundation/Vision so the macOS
/// smoke runner (parity/analyzer-math.swift) can check it without a device.
/// Each function names the server code whose output it has to match.
enum AnalysisMath {
  /// energyAnalysisSchema fixes the cell at 50 ms (server: ffmpeg astats, 2400 samples at 48 kHz).
  static let energyCellSeconds = 0.05
  /// ffmpeg reports a silent cell as -inf; the server stores it as -100.
  static let silentDb = -100.0

  /// RMS level per 50 ms cell in dBFS, like server/src/media/audio-analysis.ts.
  /// A trailing partial cell is kept (astats also emits it).
  static func energy(_ samples: [Float], sampleRate: Int) -> [Double] {
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

  /// Local maxima of linear energy above the 85th percentile, at least 0.25 s
  /// apart: a port of `onsetPeaks` in server/src/services/dissect-service.ts
  /// (the beats cut_to_beats lands on).
  static func onsetPeaks(_ rmsDb: [Double], cellSeconds: Double) -> [Double] {
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
  struct LaughWindow { let start: Double; let end: Double; let confidence: Double }

  /// A laughter span with its classifier confidence (OV10): the peak window's
  /// and the mean over the windows it was merged from.
  struct LaughSpan { var start: Double; var end: Double; var confidence: Double; var confidenceSum: Double; var windows: Int }

  /// Overlapping (or nearly touching, within `gap`) windows merge into one span.
  static func laughterSpans(_ windows: [LaughWindow], gap: Double = 0.25) -> [LaughSpan] {
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
  static func paddedFaceBox(x: Double, y: Double, width: Double, height: Double) -> [Double] {
    let round4 = { (value: Double) in (value * 10_000).rounded() / 10_000 }
    return [
      round4(max(0, y - 0.35 * height)),
      round4(min(1, y + 1.12 * height)),
      round4(max(0, x - 0.08 * width)),
      round4(min(1, x + 1.08 * width)),
    ]
  }

  /// Vision boxes are normalized with a bottom-left origin; face_track.py's are top-left.
  static func topLeftBox(fromVision box: CGRect) -> (x: Double, y: Double, width: Double, height: Double) {
    (Double(box.minX), Double(1 - box.maxY), Double(box.width), Double(box.height))
  }

  /// The EXIF orientation that turns a track's stored frames upright, from its
  /// `preferredTransform` (rotation in 90° steps, optionally mirrored).
  static func orientation(of transform: CGAffineTransform) -> CGImagePropertyOrientation {
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
  static func cropPlacement(source: CGSize, render: CGSize, scale: CGFloat, x: CGFloat, y: CGFloat) -> CGAffineTransform {
    let cover = max(render.width / source.width, render.height / source.height) * scale
    let scaledWidth = source.width * cover
    let scaledHeight = source.height * cover
    let offsetX = (scaledWidth - render.width) / 2 * (1 + x)
    // Top-left offset `(sh - H) / 2 · (1 + y)` measured from the bottom instead.
    let offsetY = (scaledHeight - render.height) / 2 * (1 - y)
    return CGAffineTransform(scaleX: cover, y: cover).concatenating(CGAffineTransform(translationX: -offsetX, y: -offsetY))
  }

  /// Even-sided size that fits `size` under `maxHeight` (no upscaling); H.264 wants even dimensions.
  static func proxySize(for size: CGSize, maxHeight: CGFloat) -> CGSize {
    let factor = min(1, maxHeight / size.height)
    let even = { (value: CGFloat) in max(2, (value * factor / 2).rounded() * 2) }
    return CGSize(width: even(size.width), height: even(size.height))
  }
}
