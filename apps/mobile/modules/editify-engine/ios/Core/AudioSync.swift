import Accelerate
import Foundation

/// On-device audio sync: a line-for-line port of packages/shared/src/sync.ts
/// (plan decision 1A), with the FFTs on vDSP. The TypeScript file is the
/// spec; server/test/sync-parity.test.ts feeds both the same PCM and fails
/// when they disagree, so change the two together.
///
///   onset envelopes (10 ms cells) ──▶ coarse lag over every offset (FFT xcorr)
///        └─▶ GCC-PHAT on raw samples ±50 ms, early + late windows ──▶ lag, drift → rate
public enum AudioSync {
  public static let sampleRate = 8000
  public static let hop = 80
  public static let envelopeRate = sampleRate / hop
  public static let fineSearchSamples = 400
  public static let maxFineWindow = 1 << 17
  public static let minFineWindow = 1 << 12
  public static let strongCoarseRatio = 2.0
  public static let minCoarseOverlapSeconds = 5
  public static let minCoarseRatio = 1.1
  public static let minFineScore = 8.0
  public static let fineLockScore = 4.0
  public static let fineLockDistance = 0.02
  public static let maxDriftRate = 500e-6

  public struct FineMatch { public let at: Double; public let lag: Double; public let score: Double }

  public struct Measurement {
    /// Video seconds at which memo second 0 plays (at `anchor` when drift is corrected).
    public let lag: Double
    public let anchor: Double
    /// Memo seconds per video second.
    public let rate: Double
    public let coarseRatio: Double
    public let fineScore: Double
    public let confident: Bool
    public let driftSec: Double?
    public let overlapSec: Double
    public let windows: [FineMatch]
    /// Whether the fine stage replaced the 10 ms coarse lag (not in sync.ts's result; the
    /// lab uses it to know how close two measurements of the same pair should agree).
    public let fineLocked: Bool
  }

  public struct Silent: Error, LocalizedError {
    public var errorDescription: String? { "One of the recordings is silent, so there is nothing to line up" }
  }

  /// Align `memo` against `video`, both mono PCM at `sampleRate`.
  public static func measure(video: [Float], memo: [Float]) throws -> Measurement {
    guard let videoEnvelope = onsetEnvelope(video), let memoEnvelope = onsetEnvelope(memo) else { throw Silent() }
    let coarse = coarseLag(video: videoEnvelope, memo: memoEnvelope)
    let coarseLagSamples = coarse.lagCells * hop
    let overlapStart = max(0, coarseLagSamples)
    let overlapEnd = min(video.count, coarseLagSamples + memo.count)
    let overlap = overlapEnd - overlapStart

    let usable = overlap - 2 * fineSearchSamples
    let window = min(maxFineWindow, floorPowerOfTwo(max(0, usable)))
    var windows: [FineMatch] = []
    if window >= minFineWindow {
      let centres: [Double] = usable >= 3 * window ? [0.2, 0.8] : [0.5]
      for fraction in centres {
        let centre = overlapStart + fineSearchSamples + Int((fraction * Double(usable)).rounded(.toNearestOrAwayFromZero))
        let start = min(max(centre - window / 2, overlapStart + fineSearchSamples), overlapEnd - fineSearchSamples - window)
        windows.append(fineLag(video: video, memo: memo, start: start, window: window, coarseLagSamples: coarseLagSamples))
      }
    }

    let coarseLagSec = Double(coarseLagSamples) / Double(sampleRate)
    let fineScore = windows.map(\.score).min() ?? 0
    let confident = (coarse.ratio >= strongCoarseRatio && overlap >= minCoarseOverlapSeconds * sampleRate)
      || (coarse.ratio >= minCoarseRatio && !windows.isEmpty && fineScore >= minFineScore)
    let locked = { (match: FineMatch) -> Bool in
      match.score >= minFineScore || (match.score >= fineLockScore && abs(match.lag - coarseLagSec) <= fineLockDistance)
    }
    let fineLocked = !windows.isEmpty && windows.allSatisfy(locked)
    var rate = 1.0
    var driftSec: Double?
    if fineLocked, let first = windows.first, let last = windows.last, windows.count > 1,
       first.score >= minFineScore, last.score >= minFineScore {
      let slope = (last.lag - first.lag) / (last.at - first.at)
      driftSec = slope * (Double(overlap) / Double(sampleRate))
      if abs(driftSec!) > 1.0 / 60 && abs(slope) <= maxDriftRate { rate = 1 - slope }
    }
    let first = windows.first
    return Measurement(
      lag: first != nil && fineLocked ? first!.lag : coarseLagSec,
      anchor: first != nil && fineLocked ? first!.at : max(0, coarseLagSec),
      rate: rate, coarseRatio: coarse.ratio, fineScore: fineScore, confident: confident,
      driftSec: driftSec, overlapSec: Double(overlap) / Double(sampleRate), windows: windows, fineLocked: fineLocked)
  }

  /// Half-wave-rectified change in log energy per 10 ms cell, z-normalised.
  public static func onsetEnvelope(_ samples: [Float]) -> [Double]? {
    let cells = samples.count / hop
    guard cells >= 2 else { return nil }
    var envelope = [Double](repeating: 0, count: cells)
    var previous = 0.0
    for cell in 0..<cells {
      var energy = 0.0
      for offset in (cell * hop)..<((cell + 1) * hop) {
        let sample = Double(samples[offset])
        energy += sample * sample
      }
      let level = log10(energy / Double(hop) + 1e-10)
      envelope[cell] = cell == 0 ? 0 : max(0, level - previous)
      previous = level
    }
    let mean = envelope.reduce(0, +) / Double(cells)
    let variance = envelope.reduce(0) { $0 + ($1 - mean) * ($1 - mean) }
    let deviation = (variance / Double(cells)).squareRoot()
    guard deviation >= 1e-6 else { return nil }
    return envelope.map { ($0 - mean) / deviation }
  }

  public static func coarseLag(video: [Double], memo: [Double]) -> (lagCells: Int, ratio: Double) {
    let correlation = crossCorrelate(video, memo, phat: false)
    let size = correlation.count
    let minOverlap = max(1, min(10 * envelopeRate, Int((0.5 * Double(min(video.count, memo.count))).rounded(.down))))
    let lowest = -(memo.count - minOverlap)
    let highest = video.count - minOverlap
    let at = { (lag: Int) -> Double in correlation[((lag % size) + size) % size] }
    var best = lowest
    if lowest <= highest { for lag in lowest...highest where at(lag) > at(best) { best = lag } }
    let exclusion = Int((0.5 * Double(envelopeRate)).rounded(.toNearestOrAwayFromZero))
    var second = -Double.infinity
    if lowest <= highest { for lag in lowest...highest where abs(lag - best) > exclusion { second = max(second, at(lag)) } }
    return (best, peakRatio(at(best), second))
  }

  public static func fineLag(video: [Float], memo: [Float], start: Int, window: Int, coarseLagSamples: Int) -> FineMatch {
    let videoWindow = video[start..<(start + window)].map(Double.init)
    let memoStart = start - coarseLagSamples
    let memoWindow = memo[memoStart..<(memoStart + window)].map(Double.init)
    let correlation = crossCorrelate(videoWindow, memoWindow, phat: true)
    let size = correlation.count
    let at = { (lag: Int) -> Double in correlation[((lag % size) + size) % size] }
    var best = -fineSearchSamples
    for lag in -fineSearchSamples...fineSearchSamples where at(lag) > at(best) { best = lag }
    let exclusion = sampleRate / 1000
    var sum = 0.0, squares = 0.0, count = 0.0
    for lag in -fineSearchSamples...fineSearchSamples where abs(lag - best) > exclusion {
      let value = at(lag)
      sum += value; squares += value * value; count += 1
    }
    let mean = sum / count
    let deviation = max(squares / count - mean * mean, 1e-24).squareRoot()
    return FineMatch(
      at: (Double(start) + Double(window) / 2) / Double(sampleRate),
      lag: Double(coarseLagSamples + best) / Double(sampleRate),
      score: (at(best) - mean) / deviation)
  }

  public static func peakRatio(_ best: Double, _ second: Double) -> Double {
    guard best > 0 else { return 0 }
    if second == -.infinity { return 0 }
    return second > 0 ? best / second : .infinity
  }

  /// Circular cross-correlation over a zero-padded FFT: index `lag` (mod size)
  /// holds Σ a[k + lag]·b[k]. With `phat`, every bin is normalised to unit
  /// magnitude first (GCC-PHAT), leaving only the timing to agree on.
  public static func crossCorrelate(_ a: [Double], _ b: [Double], phat: Bool) -> [Double] {
    let size = ceilPowerOfTwo(a.count + b.count)
    let log2n = vDSP_Length(size.trailingZeroBitCount)
    var aRe = [Double](repeating: 0, count: size), aIm = [Double](repeating: 0, count: size)
    var bRe = [Double](repeating: 0, count: size), bIm = [Double](repeating: 0, count: size)
    aRe.replaceSubrange(0..<a.count, with: a)
    bRe.replaceSubrange(0..<b.count, with: b)
    guard let setup = vDSP_create_fftsetupD(log2n, FFTRadix(kFFTRadix2)) else { return aRe }
    defer { vDSP_destroy_fftsetupD(setup) }
    fft(setup, log2n, &aRe, &aIm, FFTDirection(FFT_FORWARD))
    fft(setup, log2n, &bRe, &bIm, FFTDirection(FFT_FORWARD))
    for bin in 0..<size {
      // a · conj(b)
      let re = aRe[bin] * bRe[bin] + aIm[bin] * bIm[bin]
      let im = aIm[bin] * bRe[bin] - aRe[bin] * bIm[bin]
      let scale = phat ? 1 / ((re * re + im * im).squareRoot() + 1e-12) : 1
      aRe[bin] = re * scale
      aIm[bin] = im * scale
    }
    fft(setup, log2n, &aRe, &aIm, FFTDirection(FFT_INVERSE))
    var inverseScale = 1 / Double(size)
    vDSP_vsmulD(aRe, 1, &inverseScale, &aRe, 1, vDSP_Length(size))
    return aRe
  }

  private static func fft(_ setup: FFTSetupD, _ log2n: vDSP_Length, _ re: inout [Double], _ im: inout [Double], _ direction: FFTDirection) {
    re.withUnsafeMutableBufferPointer { rePointer in
      im.withUnsafeMutableBufferPointer { imPointer in
        var split = DSPDoubleSplitComplex(realp: rePointer.baseAddress!, imagp: imPointer.baseAddress!)
        vDSP_fft_zipD(setup, &split, 1, log2n, direction)
      }
    }
  }

  public static func ceilPowerOfTwo(_ value: Int) -> Int {
    var size = 1
    while size < value { size <<= 1 }
    return size
  }

  public static func floorPowerOfTwo(_ value: Int) -> Int {
    guard value >= 1 else { return 0 }
    var size = 1
    while size * 2 <= value { size <<= 1 }
    return size
  }
}
