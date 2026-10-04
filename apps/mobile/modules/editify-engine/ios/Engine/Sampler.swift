import Foundation
import UIKit

/// One lab run's environment, sampled so the evaluator can trust (or reject) the numbers.
///
///   begin() ── refuse if hot / low battery / Low Power ──▶ refused row
///      │ writes inflight.json (the "start marker")
///      ▼
///   1 Hz samples: peak phys_footprint, worst thermal state
///      │
///   finish(metrics) ── deletes inflight.json, appends the row
///
/// A run that dies mid-way (jetsam, crash) leaves inflight.json behind, and
/// `LabStore.recoverKilledRun()` turns it into a `killed` row on next launch:
/// a silent termination becomes a visible failure.
final class Sampler {
  struct Refused: Error { let reason: String }

  let spike: String
  let variant: String
  let run: Int
  private let startedAt = ISO8601DateFormatter().string(from: Date())
  private var thermalStart = "nominal"
  private var batteryStart: Double = -1
  private var memPeakMB: Double = 0
  private var thermalWorst = 0
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "editify.lab.sampler")

  init(spike: String, variant: String, run: Int) {
    self.spike = spike
    self.variant = variant
    self.run = run
  }

  /// Throws `Refused` (after recording a refused row) when the phone isn't in a cool, charged, normal-power state.
  func begin() async throws {
    let battery = await Sampler.batteryPercent()
    thermalStart = Sampler.thermalName()
    batteryStart = battery
    let reason: String? =
      ProcessInfo.processInfo.thermalState != .nominal ? "thermal state is \(thermalStart); let the phone cool"
      : ProcessInfo.processInfo.isLowPowerModeEnabled ? "Low Power Mode is on"
      : (battery >= 0 && battery < 50) ? "battery is \(Int(battery))%; charge above 50%"
      : nil
    if let reason {
      LabStore.append(baseRow(status: "refused", batteryEnd: battery, metrics: [:], note: reason))
      throw Refused(reason: reason)
    }
    LabStore.writeInflight(baseRow(status: "killed", batteryEnd: battery, metrics: [:], note: "no end marker: terminated mid-run"))
    memPeakMB = Sampler.physFootprintMB()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1.0)
    timer.setEventHandler { [weak self] in self?.sample() }
    timer.resume()
    self.timer = timer
  }

  /// Also called by spikes at hot spots (mid-export) so a short peak between ticks is not missed.
  func sample() {
    queue.async { [self] in
      memPeakMB = max(memPeakMB, Sampler.physFootprintMB())
      thermalWorst = max(thermalWorst, Sampler.thermalRank())
    }
  }

  /// A peak measured elsewhere (the exporter samples every 15 frames) counts too.
  func note(memMB: Double) {
    queue.async { [self] in memPeakMB = max(memPeakMB, memMB) }
  }

  func finish(status: String, metrics: [String: Any], note: String? = nil) async -> [String: Any] {
    timer?.cancel()
    sample()
    queue.sync {}
    let row = baseRow(status: status, batteryEnd: await Sampler.batteryPercent(), metrics: metrics, note: note)
    LabStore.append(row)
    LabStore.clearInflight()
    return row
  }

  private func baseRow(status: String, batteryEnd: Double, metrics: [String: Any], note: String?) -> [String: Any] {
    var row: [String: Any] = [
      "spike": spike, "variant": variant, "run": run,
      "device": Sampler.deviceModel(), "ios": ProcessInfo.processInfo.operatingSystemVersionString,
      "config": Sampler.buildConfig, "status": status, "startedAt": startedAt,
      "thermalStart": thermalStart, "thermalEnd": Sampler.thermalNames[max(thermalWorst, Sampler.thermalRank())],
      "memPeakMB": (memPeakMB * 10).rounded() / 10,
      "batteryStart": batteryStart, "batteryEnd": batteryEnd, "metrics": metrics,
    ]
    if let note { row["note"] = note }
    return row
  }

  // MARK: - Environment probes

  #if DEBUG
  static let buildConfig = "Debug"
  #else
  static let buildConfig = "Release"
  #endif

  static let thermalNames = ["nominal", "fair", "serious", "critical"]

  static func thermalRank() -> Int {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return 0
    case .fair: return 1
    case .serious: return 2
    case .critical: return 3
    @unknown default: return 3
    }
  }

  static func thermalName() -> String { thermalNames[thermalRank()] }

  /// The number jetsam judges the app by (what Xcode's memory gauge shows), in MB.
  static func physFootprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
  }

  /// -1 when unknown (simulator).
  @MainActor static func batteryPercent() -> Double {
    UIDevice.current.isBatteryMonitoringEnabled = true
    let level = UIDevice.current.batteryLevel
    return level < 0 ? -1 : Double(level * 100).rounded()
  }

  /// Hardware identifier, e.g. "iPhone14,2" (13 Pro), stable across marketing names.
  static func deviceModel() -> String {
    var system = utsname()
    uname(&system)
    return withUnsafeBytes(of: &system.machine) { bytes in
      String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
  }
}
