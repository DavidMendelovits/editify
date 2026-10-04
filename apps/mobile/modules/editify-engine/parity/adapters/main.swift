// Adapters harness (decision D24): the composition root's choice and the policies behind the
// ports, run on macOS against stubs: export admission, the RAM tier (TierPolicy, its caps, the
// EDITIFY_TIER override, the chunked energy stream), the Transcriber chain (fallthrough,
// speech permission with no prompt from the words run, the C25 re-run trigger), the SFSpeech chunk plan, merge and retry
// policy, TranscriptAssembler parity, and the decoder's PTS origin on a synthesized clip. server/test/engine-adapters.test.ts builds it twice (with
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

// MARK: - RAM tier (D13, D25)

do {
  let gib: UInt64 = 1 << 30
  let policy = TierPolicy.provisional
  // Exact sizes, then what iPhones actually report (a little under the marketing size).
  let exact: [(UInt64, DeviceTier)] = [(3 * gib, .low), (4 * gib, .standard), (6 * gib, .full), (8 * gib, .full)]
  for (bytes, expected) in exact {
    let tier = policy.tier(physicalMemory: bytes)
    check("tier: \(bytes / gib) GB → \(expected.rawValue)", tier == expected, tier)
  }
  let reported: [(String, UInt64, DeviceTier)] = [
    ("XR 3 GB reports 2.79 GiB", 2_994_733_056, .low),
    ("iPhone 11 4 GB reports 3.70 GiB", 3_971_710_976, .standard),
    ("12 Pro 6 GB reports 5.65 GiB", 6_069_059_584, .full),
    ("15 Pro 8 GB reports 7.47 GiB", 8_022_294_528, .full),
  ]
  for (label, bytes, expected) in reported {
    let tier = policy.tier(physicalMemory: bytes)
    check("tier: \(label) → \(expected.rawValue)", tier == expected, tier)
  }
  check("tier: provisional thresholds are full ≥ 6, standard ≥ 4", policy == TierPolicy(fullMinGB: 6, standardMinGB: 4))
  let low = TierCaps.of(.low), full = TierCaps.of(.full)
  check("tier caps: low exports on the server, proxy 540, preview 720 x 1280, no PCM cache, streamed decode",
        !low.exportsOnDevice && low.proxyMaxShortSide == 540 && low.previewMaxShortSide == 720 && low.previewMaxLongSide == 1280
          && low.pcmCacheSamples == 0 && low.streamsAnalysisDecode, low)
  check("tier caps: full and standard keep today's limits", full == TierCaps.of(.standard) && full.exportsOnDevice && full.proxyMaxShortSide == 1080
        && full.previewMaxShortSide == 1080 && full.previewMaxLongSide == 1920 && full.pcmCacheSamples == 8_000_000 && !full.streamsAnalysisDecode, full)

  // The test-build override (EDITIFY_TIER), compiled out like EDITIFY_ADAPTERS.
  let fromEnv = AdapterSelection.tierOverride(environment: ["EDITIFY_TIER": "low"], arguments: [])
  let fromSimctl = AdapterSelection.tierOverride(environment: [:], arguments: ["app", "-EDITIFY_TIER", "low"])
  let unknown = AdapterSelection.tierOverride(environment: ["EDITIFY_TIER": "tiny"], arguments: [])
  if AdapterSelection.overrideCompiled {
    check("tier override: read from the environment and simctl's -KEY value form", fromEnv == .low && fromSimctl == .low, [fromEnv as Any, fromSimctl as Any])
  } else {
    check("tier override: absent without -D EDITIFY_TEST_ADAPTERS", fromEnv == nil && fromSimctl == nil, [fromEnv as Any, fromSimctl as Any])
  }
  check("tier override: an unknown value is no override", unknown == nil, unknown as Any)

  // The low tier's chunked energy equals the whole-recording energy, level for level.
  var signal: [Float] = []
  for index in 0..<(8000 * 3 + 123) { signal.append(Float(sin(Double(index) * 0.05)) * Float(index % 977) / 977) }
  let whole = AnalysisMath.energy(signal, sampleRate: 8000)
  var stream = AnalysisMath.EnergyStream(sampleRate: 8000)
  var offset = 0
  var size = 1
  while offset < signal.count {
    let end = min(signal.count, offset + size)
    stream.append(Array(signal[offset..<end]))
    offset = end
    size = size * 3 % 1031 + 7 // uneven buffers, smaller and larger than a cell
  }
  let streamed = stream.finish()
  check("energy stream: chunked levels equal the whole-file levels (with the trailing partial cell)",
        streamed == whole && stream.sampleCount == signal.count && whole.count == 61, [streamed.count, whole.count])
  var empty = AnalysisMath.EnergyStream(sampleRate: 8000)
  check("energy stream: no audio, no levels", empty.finish().isEmpty)
  check("pcm cache: a zero budget keeps only the newest decode", AnalysisPolicy.pcmEvictions(order: ["a", "b"], counts: ["a": 10, "b": 10], budget: 0) == ["a"])
}

// MARK: - The Transcriber chain and the decoder (SpeechChecks.swift)

await speechChecks()
let work = FileManager.default.temporaryDirectory.appendingPathComponent("editify-adapters-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
await ptsChecks(work: work)
try? FileManager.default.removeItem(at: work)

let report: [String: Any] = ["compiled": ["overrideCompiled": AdapterSelection.overrideCompiled], "checks": checks]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]))
