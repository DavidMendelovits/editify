// Adapters harness (decision D24): the composition root's choice and the policies behind the
// ports, run on macOS against stubs. server/test/engine-adapters.test.ts builds it twice (with
// and without -D EDITIFY_TEST_ADAPTERS) and asserts on the JSON it prints:
//
//   {"compiled": {"overrideCompiled": bool}, "checks": [{"name", "ok", "detail"?}]}
//
// Every check is a named expectation; the test fails on any `ok: false`.

import Foundation

var checks: [[String: Any]] = []

func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> Any? = nil) {
  var entry: [String: Any] = ["name": name, "ok": ok]
  if !ok, let detail = detail() { entry["detail"] = "\(detail)" }
  checks.append(entry)
}

func os(_ major: Int, _ minor: Int = 0) -> OperatingSystemVersion {
  OperatingSystemVersion(majorVersion: major, minorVersion: minor, patchVersion: 0)
}

// MARK: - Composition root (D5)

do {
  let modern = AdapterSelection.choose(os: os(26, 5), override: nil, backgroundGPUEntitled: false)
  check("selection: 26 picks the modern set", modern.set == .modern, modern)
  check("selection: modern chain is speech-analyzer then sfspeech", modern.transcribers == [.speechAnalyzer, .sfspeech], modern.transcribers)
  check("selection: modern composition is configuration", modern.videoComposition == .configuration, modern.videoComposition)
  check("selection: modern without the entitlement exports in the foreground", modern.backgroundExecution == .foreground, modern.backgroundExecution)
  let entitled = AdapterSelection.choose(os: os(26, 0), override: nil, backgroundGPUEntitled: true)
  check("selection: modern with the entitlement uses continued processing", entitled.backgroundExecution == .continuedProcessing, entitled.backgroundExecution)
  let legacy = AdapterSelection.choose(os: os(18, 0), override: nil, backgroundGPUEntitled: true)
  check("selection: 18 picks the legacy set", legacy.set == .legacy && legacy.transcribers == [.sfspeech] && legacy.videoComposition == .mutable
        && legacy.backgroundExecution == .foreground, legacy)
  let forced = AdapterSelection.choose(os: os(26, 5), override: .legacy, backgroundGPUEntitled: true)
  check("selection: the legacy override on 26 picks the legacy set", forced == legacy, forced)
  let modernOverride = AdapterSelection.choose(os: os(18, 7), override: .modern, backgroundGPUEntitled: true)
  check("selection: a modern override never lifts 18 to the modern set", modernOverride.set == .legacy, modernOverride)

  // The override's sources. Without the flag every one of them is ignored.
  let fromEnv = AdapterSelection.override(environment: ["EDITIFY_ADAPTERS": "legacy"], arguments: [])
  let fromArgument = AdapterSelection.override(environment: [:], arguments: ["app", "EDITIFY_ADAPTERS=legacy"])
  let fromSimctl = AdapterSelection.override(environment: [:], arguments: ["app", "-EDITIFY_ADAPTERS", "legacy"])
  let unknown = AdapterSelection.override(environment: ["EDITIFY_ADAPTERS": "vintage"], arguments: [])
  if AdapterSelection.overrideCompiled {
    check("override: read from the environment", fromEnv == .legacy, fromEnv as Any)
    check("override: read from a launch argument", fromArgument == .legacy, fromArgument as Any)
    check("override: read from simctl's -KEY value form", fromSimctl == .legacy, fromSimctl as Any)
  } else {
    check("override: absent without -D EDITIFY_TEST_ADAPTERS", fromEnv == nil && fromArgument == nil && fromSimctl == nil,
          [fromEnv as Any, fromArgument as Any, fromSimctl as Any])
  }
  check("override: an unknown value is no override", unknown == nil, unknown as Any)
  let process = AdapterSelection.current
  let expected: AdapterSet = AdapterSelection.overrideCompiled && ProcessInfo.processInfo.environment["EDITIFY_ADAPTERS"] == "legacy" ? .legacy : .modern
  check("selection: this process (macOS 26+) runs the expected set", process.set == expected, [process.set, expected])
}

// MARK: - BackgroundExecution admission (D24: admitted when the entitlement is present)

/// A stub scheduler: the phone reports .gpu or not, the build is entitled or not. Like the real
/// adapter, it supports background GPU work only with both; an unentitled submit is refused.
final class StubScheduler: BackgroundExecution, @unchecked Sendable {
  struct Refused: Error {}
  let entitled: Bool
  let gpu: Bool
  let refuseSubmit: Bool
  var registered: [String] = []
  var submitted: [String] = []

  init(entitled: Bool, gpu: Bool, refuseSubmit: Bool = false) {
    self.entitled = entitled
    self.gpu = gpu
    self.refuseSubmit = refuseSubmit
  }

  var name: String { "stub" }
  var supportsBackgroundGPU: Bool { entitled && gpu }
  func register(_ identifier: String, launched: @escaping @Sendable (any BackgroundTask) -> Void) -> Bool {
    registered.append(identifier)
    return true
  }
  func submit(_ identifier: String, title: String, subtitle: String) throws {
    if refuseSubmit || !entitled { throw Refused() }
    submitted.append(identifier)
  }
  func cancel(_ identifier: String) {}
}

func admit(_ scheduler: any BackgroundExecution, fresh: Bool = true) -> (ExportAdmission, prepared: Bool, reverted: Bool) {
  var prepared = false
  var reverted = false
  let admission = ExportAdmission.decide(scheduler, identifier: "com.editify.app.export.x", fresh: fresh, launched: { _ in },
                                         prepare: { prepared = true }, revert: { reverted = true })
  return (admission, prepared, reverted)
}

do {
  let foreground = ExportAdmission.foreground(notice: ExportAdmission.foregroundNotice)
  let both = StubScheduler(entitled: true, gpu: true)
  let (admitted, prepared, reverted) = admit(both)
  check("admission: entitlement + gpu resource → background", admitted == .background(identifier: "com.editify.app.export.x") && prepared && !reverted
        && both.submitted == ["com.editify.app.export.x"], admitted)
  let noEntitlement = StubScheduler(entitled: false, gpu: true)
  check("admission: no entitlement → foreground, nothing registered", admit(noEntitlement).0 == foreground && noEntitlement.registered.isEmpty)
  let noGPU = StubScheduler(entitled: true, gpu: false)
  check("admission: no gpu resource → foreground, nothing registered", admit(noGPU).0 == foreground && noGPU.registered.isEmpty)
  let refused = admit(StubScheduler(entitled: true, gpu: true, refuseSubmit: true))
  check("admission: a refused submit → foreground, the job's state reverted", refused.0 == foreground && refused.prepared && refused.reverted)
  check("admission: an identifier registered before → foreground", admit(StubScheduler(entitled: true, gpu: true), fresh: false).0 == foreground)
  // The legacy set's adapter (and the modern set's without the entitlement).
  let legacy = admit(ForegroundExecution())
  check("admission: ForegroundExecution → foreground with the keep-open notice",
        legacy.0 == .foreground(notice: "Keep Editify open until the export finishes.") && !legacy.prepared, legacy.0)
}

let report: [String: Any] = ["compiled": ["overrideCompiled": AdapterSelection.overrideCompiled], "checks": checks]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]))
