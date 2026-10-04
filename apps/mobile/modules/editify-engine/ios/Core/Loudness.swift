import Accelerate
import Foundation

/// Master loudness for exports (plan decision 8A + OV8; the rules are the
/// render plan's `loudness` block, render-plan-schema.ts):
///
///   pass 1 (audio only) ─▶ LoudnessMeter: integrated loudness I (ITU-R BS.1770-4 / EBU R128)
///                          and true peak
///   LoudnessRules.gainDb(I) ─▶ one gain, rounded to 0.1 dB, or none (deadband, silence)
///   pass 2 PCM ─▶ × gain ─▶ TruePeakLimiter (always on when targetLufs is set) ─▶ AAC
///
/// Everything here is pure DSP on interleaved stereo Float32 (the export mix is always
/// stereo 48 kHz): no AVFoundation, so the macOS parity harness runs it unchanged.

/// The plan's gain rule (render-qa.ts's, with the limiter decoupled from it).
public enum LoudnessRules {
  /// dB of master gain for a mix measured at `measured` LUFS (nil: every block gated, silence).
  public static func gainDb(measured: Double?, _ loudness: RenderPlan.Loudness) -> Double {
    guard let target = loudness.targetLufs, let measured, measured.isFinite else { return 0 }
    guard measured > loudness.silentBelowLufs else { return 0 }
    guard abs(measured - target) > loudness.deadbandLu else { return 0 }
    return ((target - measured) * 10).rounded() / 10
  }

  /// The limiter runs whenever the plan normalizes at all.
  public static func limiterOn(_ loudness: RenderPlan.Loudness) -> Bool { loudness.targetLufs != nil }
}

/// Oversampling interpolator for true peak. Windowed sinc (Kaiser, beta 8), `taps` input
/// samples per phase. Phase f (f = 1 ..< factor) gives the signal at n + f/factor from
/// x[n - taps/2 + 1 ... n + taps/2]; as a correlation kernel (vDSP_conv with a positive
/// filter stride) output i is the value at i + taps/2 - 1 + f/factor in input coordinates.
///
/// Two of them: `meter` is BS.1770-4 Annex 2's 4x (16 taps per phase), so the meter reads
/// like ffmpeg's ebur128; `limiter` is 8x with 32 taps per phase, because the limiter must
/// catch what a 4x detector misses between its points on dense, hot, broadband material
/// (a reviewer's stress test: noise driven 12 dB over full scale read -1.5 dBTP at 4x
/// but +0.4 at 32x).
public struct TruePeakFilter {
  public let factor: Int
  public let taps: Int
  public let phases: [[Float]]

  public static let meter = TruePeakFilter(factor: 4, taps: 16)
  public static let limiter = TruePeakFilter(factor: 8, taps: 32)

  public init(factor: Int, taps: Int) {
    self.factor = factor
    self.taps = taps
    phases = (1..<factor).map { TruePeakFilter.kernel(fraction: Double($0) / Double(factor), taps: taps) }
  }

  public static func kernel(fraction: Double, taps: Int) -> [Float] {
    let half = Double(taps / 2)
    let beta = 8.0
    let norm = besselI0(beta)
    var values: [Double] = []
    for p in 0..<taps {
      let j = Double(p - (taps / 2 - 1))
      let t = fraction - j  // distance from the tap to the interpolated point
      let sinc = t == 0 ? 1 : sin(Double.pi * t) / (Double.pi * t)
      let ratio = t / half
      let window = abs(ratio) >= 1 ? 0 : besselI0(beta * (1 - ratio * ratio).squareRoot()) / norm
      values.append(sinc * window)
    }
    // Unity gain at DC: a constant interpolates to itself.
    let sum = values.reduce(0, +)
    return values.map { Float($0 / sum) }
  }

  private static func besselI0(_ x: Double) -> Double {
    var sum = 1.0, term = 1.0
    for k in 1..<40 {
      term *= (x / 2) / Double(k)
      sum += term * term
    }
    return sum
  }

  /// Interval peaks: out[i] = max |x(m + f/factor)| over the phases, for the interval
  /// m → m + 1 with m = i + taps/2 - 1 in `samples` coordinates. `samples.count - taps + 1` values.
  public func intervalPeaks(_ samples: [Float]) -> [Float] {
    let count = samples.count - taps + 1
    guard count > 0 else { return [] }
    var peak = [Float](repeating: 0, count: count)
    var scratch = [Float](repeating: 0, count: count)
    samples.withUnsafeBufferPointer { input in
      for kernel in phases {
        kernel.withUnsafeBufferPointer { k in
          vDSP_conv(input.baseAddress!, 1, k.baseAddress!, 1, &scratch, 1, vDSP_Length(count), vDSP_Length(taps))
        }
        vDSP_vabs(scratch, 1, &scratch, 1, vDSP_Length(count))
        vDSP_vmax(scratch, 1, peak, 1, &peak, 1, vDSP_Length(count))
      }
    }
    return peak
  }
}

/// Streaming integrated loudness (BS.1770-4: K-weighting, 400 ms blocks with 75% overlap,
/// absolute gate -70 LUFS, relative gate -10 LU) and true peak (4x oversampled), in vDSP.
/// Feed interleaved stereo in any chunk sizes; read `integrated` / `truePeakDb` at the end.
public final class LoudnessMeter {
  public let rate: Double
  public let channels: Int
  /// 100 ms of samples per channel: blocks are 4 of these.
  private let hop: Int
  private var biquad: vDSP_biquad_SetupD
  /// Per channel: the cascade's delay state (2 sections → 6 values).
  private var delays: [[Double]]
  /// Energy (mean square after K-weighting, channel-summed) of each completed 100 ms hop.
  private var hopEnergy: [Double] = []
  private var currentSum: [Double]
  private var currentCount = 0
  /// Mean-square energy of every complete 400 ms block (gating input).
  public private(set) var blockEnergy: [Double] = []
  /// True peak (linear) across all channels; sample peak too.
  public private(set) var truePeak: Float = 0
  public private(set) var samplePeak: Float = 0
  /// The last taps - 1 samples per channel, for the interpolator's history.
  private var history: [[Float]]
  public private(set) var frames = 0

  public init(rate: Double = 48_000, channels: Int = 2) {
    self.rate = rate
    self.channels = channels
    hop = Int((rate / 10).rounded())
    let coefficients = LoudnessMeter.kWeighting(rate: rate)
    biquad = vDSP_biquad_CreateSetupD(coefficients, 2)!
    delays = Array(repeating: [Double](repeating: 0, count: 6), count: channels)
    currentSum = [Double](repeating: 0, count: channels)
    history = Array(repeating: [Float](repeating: 0, count: TruePeakFilter.meter.taps - 1), count: channels)
  }

  deinit { vDSP_biquad_DestroySetupD(biquad) }

  /// BS.1770-4 pre-filter and RLB filter for any rate (the libebur128 derivation; at 48 kHz
  /// it reproduces the standard's table). vDSP order: b0 b1 b2 a1 a2 per section.
  public static func kWeighting(rate: Double) -> [Double] {
    var f0 = 1681.974450955533, q = 0.7071752369554196
    let gain = 3.999843853973347
    var k = tan(Double.pi * f0 / rate)
    let vh = pow(10, gain / 20)
    let vb = pow(vh, 0.4996667741545416)
    var a0 = 1 + k / q + k * k
    let shelf = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0,
                 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    f0 = 38.13547087602444
    q = 0.5003270373238773
    k = tan(Double.pi * f0 / rate)
    a0 = 1 + k / q + k * k
    let highPass = [1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    return shelf + highPass
  }

  public func add(interleaved samples: UnsafeBufferPointer<Float>) {
    let count = samples.count / channels
    guard count > 0, let base = samples.baseAddress else { return }
    frames += count
    var channel = [Float](repeating: 0, count: count)
    var doubles = [Double](repeating: 0, count: count)
    var weighted = [Double](repeating: 0, count: count)
    var perChannelSquares: [[Double]] = []
    for c in 0..<channels {
      for i in 0..<count { channel[i] = base[i * channels + c] }
      // Peaks: sample, and the 4x interpolated points between samples.
      var maximum: Float = 0
      vDSP_maxmgv(channel, 1, &maximum, vDSP_Length(count))
      samplePeak = max(samplePeak, maximum)
      truePeak = max(truePeak, maximum)
      let joined = history[c] + channel
      if let top = TruePeakFilter.meter.intervalPeaks(joined).max() { truePeak = max(truePeak, top) }
      history[c] = Array(joined.suffix(TruePeakFilter.meter.taps - 1))
      // K-weighting in double precision (the RLB pole sits 0.01 from the unit circle).
      vDSP_vspdp(channel, 1, &doubles, 1, vDSP_Length(count))
      delays[c].withUnsafeMutableBufferPointer { delay in
        vDSP_biquadD(biquad, delay.baseAddress!, doubles, 1, &weighted, 1, vDSP_Length(count))
      }
      var squares = [Double](repeating: 0, count: count)
      vDSP_vsqD(weighted, 1, &squares, 1, vDSP_Length(count))
      perChannelSquares.append(squares)
    }
    // Hops of 100 ms; channel weights are 1 for L and R (BS.1770: G = 1 for front channels).
    var index = 0
    while index < count {
      let take = min(hop - currentCount, count - index)
      for c in 0..<channels {
        var sum = 0.0
        perChannelSquares[c].withUnsafeBufferPointer { pointer in
          vDSP_sveD(pointer.baseAddress! + index, 1, &sum, vDSP_Length(take))
        }
        currentSum[c] += sum
      }
      currentCount += take
      index += take
      if currentCount == hop {
        hopEnergy.append(currentSum.reduce(0, +) / Double(hop))
        currentSum = [Double](repeating: 0, count: channels)
        currentCount = 0
        if hopEnergy.count >= 4 {
          let last = hopEnergy.suffix(4)
          blockEnergy.append(last.reduce(0, +) / 4)
        }
      }
    }
  }

  public func add(_ samples: [Float]) { samples.withUnsafeBufferPointer { add(interleaved: $0) } }

  public static func loudness(_ energy: Double) -> Double { -0.691 + 10 * log10(energy) }

  /// Integrated loudness in LUFS; nil when no block passes the absolute gate (silence).
  public var integrated: Double? {
    let absolute = blockEnergy.filter { $0 > 0 && LoudnessMeter.loudness($0) > -70 }
    guard !absolute.isEmpty else { return nil }
    let relativeGate = LoudnessMeter.loudness(absolute.reduce(0, +) / Double(absolute.count)) - 10
    let gated = absolute.filter { LoudnessMeter.loudness($0) > relativeGate }
    guard !gated.isEmpty else { return nil }
    return LoudnessMeter.loudness(gated.reduce(0, +) / Double(gated.count))
  }

  /// True peak in dBTP; nil for digital silence.
  public var truePeakDb: Double? { truePeak > 0 ? 20 * log10(Double(truePeak)) : nil }
  public var samplePeakDb: Double? { samplePeak > 0 ? 20 * log10(Double(samplePeak)) : nil }
}

/// Look-ahead true-peak limiter on interleaved stereo.
///
///   tp[m]  = max over channels of |x[m]| and the 8x interpolated peaks of the
///            intervals m-1 → m and m → m+1 (TruePeakFilter)
///   r[m]   = min(1, ceiling / tp[m])                 gain the sample may have at most
///   mm[j]  = min r over [j - L + 1, j]               trailing minimum, L = lookAhead
///   g[k]   = mean of mm over [k, k + L - 1]          a linear attack over L samples
///   out[k] = x[k] * s[k], s = g with a one-pole release, never above g
///
/// g[m] averages L values that are all <= r[m], so the gain at every peak is at or
/// under what the ceiling allows, and it ramps down over the L samples before it
/// (no step, no overshoot). The release only ever lowers the gain further.
///
/// Latency (decision 8A + OV8): out[k] needs x up to k + L - 1 + taps/2, so the
/// limiter holds `latency` samples. It starts pre-rolled (as if fed zeros forever, unity
/// gain), the first `latency` outputs (pre-roll) are dropped, and `flush()` feeds
/// `latency` zeros to release the tail. Output sample k is input sample k: the audio
/// keeps its timestamps, so A/V stay in sync with no video delay at all.
public final class TruePeakLimiter {
  public let ceiling: Float
  public let lookAhead: Int
  public let latency: Int
  private let filter = TruePeakFilter.limiter
  private let releaseCoefficient: Float
  private let channels = 2
  /// Input samples per channel not yet output; pending[c][0] is absolute frame `pendingStart`.
  private var pending: [[Float]] = [[], []]
  private var pendingStart = 0
  /// The last taps - 1 samples per channel (interpolator history), starting as zeros.
  private var history: [[Float]]
  /// Interval peak of the previous interval (m - 1 → m), carried across chunks.
  private var previousInterval: Float = 0
  /// The next m whose tp is computed; starts at -taps/2 (pre-roll).
  private var nextM: Int
  /// Monotonic deque for the trailing minimum: (index, value).
  private var dequeIndex: [Int] = []
  private var dequeValue: [Float] = []
  private var dequeHead = 0
  /// The box filter: the last L trailing minima (initially 1) and their sum.
  private var box: [Float]
  private var boxPosition = 0
  private var boxSum: Float
  private var smoothed: Float = 1
  private var emitted = 0
  /// Frames in minus frames out after the pre-roll: equals `latency` in steady state.
  public private(set) var framesIn = 0
  /// The lowest gain applied (1 = never engaged).
  public private(set) var minimumGain: Float = 1

  public init(ceilingDb: Double, rate: Double = 48_000, lookAheadSeconds: Double = 0.005, releaseSeconds: Double = 0.05) {
    ceiling = Float(pow(10, ceilingDb / 20))
    lookAhead = max(1, Int((lookAheadSeconds * rate).rounded()))
    latency = lookAhead - 1 + filter.taps / 2
    releaseCoefficient = Float(1 - exp(-1 / (releaseSeconds * rate)))
    history = Array(repeating: [Float](repeating: 0, count: filter.taps - 1), count: 2)
    nextM = -filter.taps / 2
    box = [Float](repeating: 1, count: lookAhead)
    boxSum = Float(lookAhead)
  }

  public var maxReductionDb: Double { minimumGain < 1 ? -20 * log10(Double(minimumGain)) : 0 }

  /// Processes interleaved stereo; returns the interleaved output now available (the
  /// input delayed by `latency`, with the pre-roll already dropped).
  public func process(_ interleaved: [Float]) -> [Float] {
    let count = interleaved.count / channels
    guard count > 0 else { return [] }
    framesIn += count
    var split: [[Float]] = [[Float](repeating: 0, count: count), [Float](repeating: 0, count: count)]
    for i in 0..<count {
      split[0][i] = interleaved[2 * i]
      split[1][i] = interleaved[2 * i + 1]
    }
    var intervals: [[Float]] = []
    for c in 0..<channels {
      let joined = history[c] + split[c]
      intervals.append(filter.intervalPeaks(joined))
      history[c] = Array(joined.suffix(filter.taps - 1))
      pending[c].append(contentsOf: split[c])
    }
    var output: [Float] = []
    output.reserveCapacity(interleaved.count)
    // intervals[c][i] is the interval starting at m = nextM + i (see TruePeakFilter: the
    // joined buffer starts taps - 1 samples before this chunk's first frame).
    for i in 0..<intervals[0].count {
      let m = nextM + i
      let interval = max(intervals[0][i], intervals[1][i])
      if m >= 0 {
        let offset = m - pendingStart
        let sample = max(abs(pending[0][offset]), abs(pending[1][offset]))
        let peak = max(sample, interval, previousInterval)
        let allowed = peak > ceiling ? ceiling / peak : 1
        // Trailing minimum over [m - L + 1, m].
        while dequeIndex.count > dequeHead, dequeValue[dequeValue.count - 1] >= allowed {
          dequeIndex.removeLast(); dequeValue.removeLast()
        }
        dequeIndex.append(m); dequeValue.append(allowed)
        while dequeIndex[dequeHead] <= m - lookAhead { dequeHead += 1 }
        if dequeHead > 4096 {
          dequeIndex.removeFirst(dequeHead); dequeValue.removeFirst(dequeHead); dequeHead = 0
        }
        let trailingMin = dequeValue[dequeHead]
        boxSum += trailingMin - box[boxPosition]
        box[boxPosition] = trailingMin
        boxPosition = (boxPosition + 1) % lookAhead
        let k = m - lookAhead + 1
        if k >= 0 {
          let target = min(1, boxSum / Float(lookAhead))
          smoothed = target < smoothed ? target : min(target, smoothed + (target - smoothed) * releaseCoefficient)
          minimumGain = min(minimumGain, smoothed)
          let at = k - pendingStart
          output.append(pending[0][at] * smoothed)
          output.append(pending[1][at] * smoothed)
          emitted = k + 1
        }
      }
      previousInterval = interval
    }
    nextM += intervals[0].count
    // Drop input already output (keep enough for the sample-peak lookups ahead).
    let keepFrom = min(emitted, max(0, nextM))
    if keepFrom - pendingStart > 8192 {
      let drop = keepFrom - pendingStart
      pending[0].removeFirst(drop); pending[1].removeFirst(drop)
      pendingStart = keepFrom
    }
    return output
  }

  /// Releases the last `latency` frames (feeds zeros); after it, frames out == frames in.
  public func flush() -> [Float] {
    let real = framesIn
    let tail = process([Float](repeating: 0, count: latency * channels))
    framesIn = real
    return tail
  }
}
