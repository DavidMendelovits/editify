import Darwin
import Foundation

/// What an export takes and reports, and the small pieces around it that need no media:
/// encoder options, stats, phases, errors, the cancel handle, the progress throttle, the
/// scoped setting override and the peak-memory probe. PlanExporter (Engine) runs the export.

/// Encoder knobs only (render-plan-schema.ts, WHAT THE PLAN OWNS): the plan's size,
/// fps, colour and loudness always win.
public struct PlanExportOptions: Sendable {
  /// Video bits per second; nil picks `PlanExporter.defaultBitrate`.
  public var videoBitrate: Int?
  /// Longest gap between keyframes, seconds.
  public var keyframeInterval: Double = 2

  public static let bitrateRange = 500_000...200_000_000
  public static let audioBitrate = 192_000

  public init() {}
}

/// What an export reports for the profiling pages (P4) and the done screen.
public struct PlanExportStats: Sendable {
  public var seconds = 0.0
  public var xRealtime = 0.0
  public var peakMemMB = 0.0
  /// Pass 1: the mix's integrated loudness (nil: silent, or loudness off).
  public var lufsIn: Double?
  /// Measured on the processed PCM handed to the AAC encoder (after gain and limiter),
  /// not on the encoded file: AAC can add a few tenths of a dB of true peak.
  public var lufsOut: Double?
  public var truePeakPreEncode: Double?
  public var gainDb = 0.0
  public var limiterOn = false
  public var limiterMaxReductionDb = 0.0
  public var limiterLatencyFrames = 0
  public var frames = 0
  public var audioFrames = 0
  public var bytes = 0
  public var videoBitrate = 0
  public var codec = ""
  public var measureSeconds = 0.0
  public var writeSeconds = 0.0

  public init() {}

  public var dictionary: [String: Any] {
    var out: [String: Any] = [
      "seconds": round3(seconds), "xRealtime": round3(xRealtime), "peakMemMB": round3(peakMemMB), "gainDb": gainDb,
      "limiterOn": limiterOn, "limiterMaxReductionDb": round3(limiterMaxReductionDb), "limiterLatencyFrames": limiterLatencyFrames,
      "frames": frames, "audioFrames": audioFrames, "bytes": bytes, "videoBitrate": videoBitrate, "codec": codec,
      "measureSeconds": round3(measureSeconds), "writeSeconds": round3(writeSeconds),
    ]
    out["lufsIn"] = lufsIn.map(round2) ?? NSNull()
    out["lufsOut"] = lufsOut.map(round2) ?? NSNull()
    out["truePeakPreEncode"] = truePeakPreEncode.map(round2) ?? NSNull()
    return out
  }

  private func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
  private func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }
}

public enum PlanExportPhase: String, Sendable {
  case resolving, measuring, writing
}

public enum PlanExportError: Error, LocalizedError, Equatable {
  /// Duration 0: executors refuse to export it (render-plan-schema.ts TIME AND FRAMES).
  case emptyPlan
  case notEnoughSpace(needed: Int64, available: Int64)
  case cancelled
  case tooHot
  case read(String)
  case write(String)

  public var errorDescription: String? {
    switch self {
    case .emptyPlan: return "There is nothing to export yet"
    case .notEnoughSpace: return "Not enough space"
    case .cancelled: return "Export cancelled"
    case .tooHot: return "The phone is too hot to keep exporting"
    case .read(let what): return "Could not read the edit: \(what)"
    case .write(let what): return "Could not write the video: \(what)"
    }
  }
}

/// Cancels an export from any thread. Also stops it from outside (the BG task expired).
public final class PlanExportControl: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var onCancel: [() -> Void] = []

  public init() {}

  public var isCancelled: Bool { lock.withLock { cancelled } }

  public func cancel() {
    let handlers = lock.withLock { () -> [() -> Void] in
      guard !cancelled else { return [] }
      cancelled = true
      defer { onCancel = [] }
      return onCancel
    }
    for handler in handlers { handler() }
  }

  /// Runs now when already cancelled.
  public func whenCancelled(_ handler: @escaping () -> Void) {
    let runNow = lock.withLock { () -> Bool in
      if cancelled { return true }
      onCancel.append(handler)
      return false
    }
    if runNow { handler() }
  }
}

/// How often export progress reaches JS and the system's progress UI: every state change,
/// and within a state at most once per 1% of progress and per 100 ms (10 Hz). The writer
/// reports every frame, which at 60 fps would flood the bridge.
public enum ExportThrottle {
  public static func shouldSend(state: String, progress: Double, lastState: String?, lastProgress: Double, sinceLast: TimeInterval) -> Bool {
    if state != lastState { return true }
    return progress - lastProgress >= 0.01 && sinceLast >= 0.1
  }
}

/// Holds a setting at a value for a while and puts back exactly what was there before,
/// once, however the hold ends (ExportCenter keeps the screen awake with it: auto-lock
/// would send the app to the background and stop a foreground export).
public final class ScopedOverride<Value>: @unchecked Sendable {
  private let read: () -> Value
  private let write: (Value) -> Void
  private var previous: Value?

  public init(read: @escaping () -> Value, write: @escaping (Value) -> Void) {
    self.read = read
    self.write = write
  }

  public var isHeld: Bool { previous != nil }

  /// A second hold while held keeps the first saved value.
  public func hold(_ value: Value) {
    if previous == nil { previous = read() }
    write(value)
  }

  /// Restores the saved value; a no-op when not held.
  public func release() {
    guard let saved = previous else { return }
    previous = nil
    write(saved)
  }
}

/// Resident memory high-water mark (phys_footprint, what jetsam counts).
public final class PeakMemory: @unchecked Sendable {
  private let lock = NSLock()
  private var peak: UInt64 = 0

  public init() {}

  public func sample() {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    guard result == KERN_SUCCESS else { return }
    lock.withLock { peak = max(peak, info.phys_footprint) }
  }

  public var peakMB: Double { lock.withLock { Double(peak) / 1_048_576 } }
}
