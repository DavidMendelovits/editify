import AVFoundation
import Foundation

/// The device analysis scheduler (decision 8A).
///
///   analyze(asset) ─▶ parts queued as `pending` ─┬─ light lane: decode ▶ laughter ▶ energy   (one at a time)
///                                                └─ heavy lane: words ▶ proxy ▶ faces      (one at a time, gated)
///   syncPair ─▶ runs at once, never queued (shares the cached or in-flight 8 kHz decode)
///
/// Picking order inside a lane: the asset on screen first (`setFocus`), then
/// part rank (decode, words, proxy, laughter, energy, faces), then arrival. The heavy
/// gate holds words/faces between chunks while playback or scrubbing is active
/// (`setPlaybackActive`), an export is running (`setExportActive`), or the thermal
/// state is `.serious` or worse; light parts keep going.
///
/// `proxy` (decision 10B + OV9, the 1080p preview proxy) is only queued on request
/// (`ensureProxy`, or `parts: ["proxy"]`), never by a default `analyze`. An AVAssetWriter
/// can't pause, so playback or an export *cancels* a running proxy (its partial file is
/// deleted) and puts it back in the queue; it isn't picked again until both have
/// stopped and stayed stopped for `proxyResumeDelay` (so play/pause taps don't restart an
/// encode from zero each time), and then starts from scratch. Thermal pressure parks it
/// like the others. A proxy already on disk is reused only when its key (proxy version +
/// the source's fingerprint) still matches.
/// A finished proxy can push the store over its byte budget: the least recently opened
/// proxies are deleted, each reported as a `removed` proxy part.
///
/// Events: `analysisStatus` {assetId, part, revision, status, analyzerVersion, error?} on
/// every change, carrying no data (on `ready`, read it with `analysis(assetId:)`), or
/// {assetId, part, revision, removed: true} when `cancel` drops a pending part.
/// `revision` counts changes per asset; `analysis(assetId:)` reports the one it reflects,
/// so JS can drop a snapshot older than events it already applied.
///
/// JS contexts: playback and focus belong to the JS context that set them. Each module
/// instance takes a new epoch (`EngineContext.begin()`, synchronously in OnCreate) and
/// passes it with its playback/focus calls; the first call or `reset` from a newer epoch
/// clears what an older context left (a reload mid-scrub would otherwise hold the heavy
/// lane forever), and calls from an older epoch are ignored.
///
/// Ports and adapters: the decisions (part ranks, lane order, the heavy and proxy gates, the
/// proxy key, the audio cache budget) are AnalysisPolicy in Core; the media goes through
/// the ports EngineAdapters.current picked (MediaSource, AudioDecoder, Transcriber,
/// SoundClassifier, FaceDetector, Proxy, DeviceProfile). This actor owns the state.
actor AnalysisScheduler {
  static let shared = AnalysisScheduler()

  typealias Part = AnalysisPart
  typealias Job = AnalysisJob
  typealias Options = AnalysisOptions

  typealias Emit = @Sendable (_ event: String, _ body: [String: Any]) -> Void

  private var queue: [Job] = []
  private var running: [Bool: (job: Job, task: Task<Void, Never>)] = [:]
  // TODO(P2 follow-up 13): results grow with every asset analyzed this session; bound them
  // (or move them to disk) once the app analyzes whole libraries.
  private var results: [String: [Part: PartResult]] = [:]
  private var pcm: [String: [Float]] = [:]
  private var pcmOrder: [String] = []
  private var decoding: [String: Task<[Float], Error>] = [:]
  private var seq = 0
  private var generations: [String: Int] = [:]
  private var focus: String?
  private var playbackActive = false
  private var exportActive = false
  /// The newest JS toggle sequence applied, per control: JS fires these without awaiting,
  /// and two calls can reach the actor out of order, so an older one is dropped.
  private var playbackSeq = 0
  private var exportSeq = 0
  /// Seqs of proxy jobs cancelled by playback/export: `finish` re-queues them instead of recording.
  private var preempted: Set<Int> = []
  /// Proxies wait until then after playback/export stop (idle debounce).
  private var proxyResumeAt: ContinuousClock.Instant?
  static let proxyResumeDelay = AnalysisPolicy.proxyResumeDelay
  private(set) var heavyFraction = 0.0
  /// The largest single progress step of the running heavy part (its granularity).
  private(set) var heavyStep = 0.0
  private var lastProgress: [String: Double] = [:]
  private var revisions: [String: Int] = [:]
  private var epoch = 0
  private var emitterEpoch = 0
  private var emit: Emit?
  private var thermalObserver: AnyObject?
  private let adapters: EngineAdapters

  init(adapters: EngineAdapters = .current) {
    self.adapters = adapters
  }

  /// `epoch`: the module instance's context; an older instance can't replace a newer one's emitter.
  func setEmitter(_ emit: Emit?, epoch caller: Int) {
    guard caller >= emitterEpoch else { return }
    emitterEpoch = caller
    self.emit = emit
    if thermalObserver == nil {
      thermalObserver = adapters.deviceProfile.observeThermalState {
        Task { await AnalysisScheduler.shared.emitState() }
      }
    }
  }

  /// A fresh JS context (reload, new module instance) knows nothing of the old one's
  /// playback or focus; left as they were, a stale `playbackActive` would hold the heavy
  /// lane forever. Idempotent per epoch, so it can't undo the new context's own calls.
  func reset(epoch: Int) {
    if adopt(epoch) { emitState() }
  }

  /// True when `epoch` is newer than the current one (its state was just cleared).
  @discardableResult
  private func adopt(_ incoming: Int) -> Bool {
    guard incoming > epoch else { return false }
    epoch = incoming
    playbackActive = false
    exportActive = false
    playbackSeq = 0
    exportSeq = 0
    focus = nil
    pump()
    return true
  }

  // MARK: - Commands from JS

  /// Queue `parts` (all by default) for an asset. Parts already ready from the
  /// current analyzer version are skipped unless `force`.
  func analyze(assetId: String, ref: String, parts requested: [String]?, options: Options, force: Bool) {
    let parts = requested?.compactMap(Part.init(rawValue:)) ?? Part.analysisDefaults
    let generation = generations[assetId, default: 0]
    for part in parts {
      if !force, AnalysisPolicy.isFresh(results[assetId]?[part], part: part,
                                        proxyOnDisk: part == .proxy && ProxyStore.shared.existing(assetId) != nil) { continue }
      if queue.contains(where: { $0.assetId == assetId && $0.part == part }) { continue }
      if running.values.contains(where: { $0.job.assetId == assetId && $0.job.part == part && $0.job.generation == generation }) { continue }
      seq += 1
      queue.append(Job(assetId: assetId, ref: ref, part: part, seq: seq, generation: generation, options: options))
      record(assetId, part, PartResult(status: "pending", analyzerVersion: part.version))
    }
    pump()
  }

  /// `epoch`: the calling JS context's (nil for native callers such as lab spikes).
  /// `seq`: the JS toggle's sequence number; a call older than one already applied is dropped.
  func setPlaybackActive(_ active: Bool, epoch caller: Int? = nil, seq: Int? = nil) {
    if let caller {
      if adopt(caller) { emitState() }
      guard caller == epoch else { return }
    }
    if let seq {
      guard seq > playbackSeq else { return }
      playbackSeq = seq
    }
    guard playbackActive != active else { return }
    playbackActive = active
    proxyGateChanged()
    emitState()
  }

  /// True while an export renders: proxy generation is cancelled and held, words/faces pause.
  func setExportActive(_ active: Bool, epoch caller: Int? = nil, seq: Int? = nil) {
    if let caller {
      if adopt(caller) { emitState() }
      guard caller == epoch else { return }
    }
    if let seq {
      guard seq > exportSeq else { return }
      exportSeq = seq
    }
    guard exportActive != active else { return }
    exportActive = active
    proxyGateChanged()
    emitState()
  }

  /// Playback and export can't share the media engines with a proxy writer: cancel a
  /// running proxy when either starts (it re-queues in `finish`), pump when both stop.
  private var proxyBlocked: Bool { playbackActive || exportActive }

  private func proxyGateChanged() {
    if proxyBlocked {
      if let (job, task) = running[true], job.part == .proxy, !preempted.contains(job.seq) {
        preempted.insert(job.seq)
        task.cancel()
      }
    } else {
      let resumeAt = ContinuousClock.now + Self.proxyResumeDelay
      proxyResumeAt = resumeAt
      // Words/faces resume at once (their gate opens); a proxy waits out the idle window.
      pump()
      Task { [weak self] in
        try? await Task.sleep(until: resumeAt, clock: .continuous)
        await self?.pump()
      }
    }
  }

  private var proxyMayStart: Bool {
    AnalysisPolicy.proxyMayStart(blocked: proxyBlocked, resumeAt: proxyResumeAt)
  }

  /// The asset on screen jumps the queue in both lanes (it does not preempt a running part).
  func setFocus(_ assetId: String?, epoch caller: Int? = nil) {
    if let caller {
      if adopt(caller) { emitState() }
      guard caller == epoch else { return }
    }
    focus = assetId
  }

  /// Drop an asset's queued parts and stop its running ones. Their pending entries go
  /// away (each with a `removed` event); parts already ready stay.
  func cancel(assetId: String) {
    generations[assetId, default: 0] += 1
    queue.removeAll { $0.assetId == assetId }
    for (_, entry) in running where entry.job.assetId == assetId { entry.task.cancel() }
    for (part, result) in results[assetId] ?? [:] where result.status == "pending" {
      results[assetId]?[part] = nil
      emit?("analysisStatus", ["assetId": assetId, "part": part.rawValue, "revision": bump(assetId), "removed": true])
    }
    decoding[assetId]?.cancel()
    decoding[assetId] = nil
    pcm[assetId] = nil
    pcmOrder.removeAll { $0 == assetId }
  }

  /// Every part known for an asset, with data when ready.
  func analysis(assetId: String) -> [String: Any] {
    var parts: [String: Any] = [:]
    for (part, result) in results[assetId] ?? [:] { parts[part.rawValue] = result.dictionary }
    return ["assetId": assetId, "parts": parts, "revision": revisions[assetId, default: 0]]
  }

  func state() -> [String: Any] {
    [
      "playbackActive": playbackActive,
      "exportActive": exportActive,
      "thermal": adapters.deviceProfile.thermalName,
      "heavyPaused": heavyPaused,
      "queued": queue.map { ["assetId": $0.assetId, "part": $0.part.rawValue] },
      "running": running.values.map { ["assetId": $0.job.assetId, "part": $0.job.part.rawValue] },
      "focus": focus ?? NSNull(),
    ]
  }

  /// Sync for one memo/video pair, outside the queue (8A: sync is never queued).
  func syncPair(videoRef: String, memoRef: String, videoAssetId: String?, memoAssetId: String?) async -> PartResult {
    do {
      let pair: ([Float], [Float])
      do {
        pair = try await decodePair(videoRef: videoRef, memoRef: memoRef, videoAssetId: videoAssetId, memoAssetId: memoAssetId)
      } catch is CancellationError where !Task.isCancelled {
        // `cancel(assetId:)` stopped a shared decode this sync was waiting on, not the sync itself.
        pair = try await decodePair(videoRef: videoRef, memoRef: memoRef, videoAssetId: videoAssetId, memoAssetId: memoAssetId)
      }
      return Analyzers.sync(video: pair.0, memo: pair.1)
    } catch is NoAudio {
      return .unavailable(AnalyzerVersion.sync, NoAudio().localizedDescription)
    } catch where adapters.mediaSource.isUnavailable(error) {
      return .unavailable(AnalyzerVersion.sync, error.localizedDescription)
    } catch {
      return .failed(AnalyzerVersion.sync, error)
    }
  }

  private func decodePair(videoRef: String, memoRef: String, videoAssetId: String?, memoAssetId: String?) async throws -> ([Float], [Float]) {
    async let video = cachedPCM(assetId: videoAssetId, ref: videoRef)
    async let memo = cachedPCM(assetId: memoAssetId, ref: memoRef)
    return try await (video, memo)
  }

  // MARK: - Gate

  var heavyPaused: Bool {
    AnalysisPolicy.heavyPaused(proxyBlocked: proxyBlocked, thermal: adapters.deviceProfile.thermalState)
  }

  /// Awaited by heavy analyzers between chunks: holds while paused, and
  /// answers false once the part was cancelled so the analyzer stops.
  func waitWhileHeavyPaused(_ stop: CancelFlag) async -> Bool {
    while heavyPaused && !stop.isSet {
      try? await Task.sleep(for: .milliseconds(250))
    }
    return !stop.isSet
  }

  // MARK: - Lanes

  private func pump() {
    for heavy in [false, true] where running[heavy] == nil {
      let candidates = queue.filter { $0.part.heavy == heavy && ($0.part != .proxy || proxyMayStart) }
      guard let next = candidates.min(by: { order($0) < order($1) }) else { continue }
      queue.removeAll { $0.assetId == next.assetId && $0.part == next.part }
      // Background work: utility priority, and the blocking calls inside run on AnalysisQueue.
      let task = Task(priority: .utility) { [weak self] in
        guard let self else { return }
        let result = await self.run(next)
        await self.finish(next, result)
      }
      running[heavy] = (next, task)
    }
  }

  private func order(_ job: Job) -> (Int, Int, Int) {
    AnalysisPolicy.order(job, focus: focus)
  }

  private func isCurrent(_ job: Job) -> Bool {
    job.generation == generations[job.assetId, default: 0]
  }

  private func finish(_ job: Job, _ result: PartResult) {
    running[job.part.heavy] = nil
    if job.part.heavy { heavyFraction = 0; heavyStep = 0 }
    lastProgress[progressKey(job, nil)] = nil
    lastProgress[progressKey(job, "download")] = nil
    if preempted.remove(job.seq) != nil, isCurrent(job), result.status != "ready" {
      // Cancelled by playback/export: still pending, back in line with its original seq.
      queue.append(job)
      pump()
      return
    }
    // A cancelled job's result is dropped: `cancel` already removed its pending entry,
    // and a newer request for the same part may be queued under the new generation.
    if isCurrent(job) { record(job.assetId, job.part, result) }
    if job.part == .proxy, result.status == "ready" { evictProxies(protecting: job.assetId) }
    pump()
  }

  /// Keeps the proxy store within its budget; every evicted proxy is reported as removed.
  private func evictProxies(protecting assetId: String?) {
    for evicted in ProxyStore.shared.evictOverBudget(protecting: assetId) {
      results[evicted]?[.proxy] = nil
      emit?("analysisStatus", ["assetId": evicted, "part": Part.proxy.rawValue, "revision": bump(evicted), "removed": true])
    }
  }

  /// A new byte budget for the proxy store, clamped to `ProxyStore.budgetRange` and applied
  /// at once. A non-number is ignored (false).
  @discardableResult
  func setProxyBudget(_ bytes: Double) -> Bool {
    guard ProxyStore.shared.setBudget(bytes) else { return false }
    evictProxies(protecting: nil)
    return true
  }

  private func run(_ job: Job) async -> PartResult {
    let progress: AnalyzerProgress = { [weak self] fraction in
      Task { await self?.progress(job, fraction) }
    }
    let download: @Sendable (Double) -> Void = { [weak self] fraction in
      Task { await self?.progress(job, fraction, phase: "download") }
    }
    let stop = CancelFlag()
    let gate: AnalyzerGate = { [weak self] in await self?.waitWhileHeavyPaused(stop) ?? false }
    return await withTaskCancellationHandler {
      await analyze(job, progress: progress, download: download, gate: gate)
    } onCancel: {
      stop.set()
    }
  }

  private func analyze(_ job: Job, progress: @escaping AnalyzerProgress, download: @escaping @Sendable (Double) -> Void, gate: @escaping AnalyzerGate) async -> PartResult {
    let version = job.part.version
    do {
      switch job.part {
      case .decode:
        let samples = try await cachedPCM(assetId: job.assetId, ref: job.ref, progress: progress, download: download)
        return .ready(version, [
          "sampleRate": AudioSync.sampleRate, "sampleCount": samples.count,
          "seconds": Double(samples.count) / Double(AudioSync.sampleRate),
        ])
      case .energy:
        let samples = try await cachedPCM(assetId: job.assetId, ref: job.ref, progress: progress, download: download)
        return Analyzers.energy(samples: samples)
      case .laughter:
        return await adapters.soundClassifier.laughter(try await adapters.mediaSource.load(job.ref, allowNetwork: true, onDownload: download),
                                                       minConfidence: 0.5, progress: progress)
      case .words:
        let locale = job.options.locale.map(Locale.init(identifier:)) ?? .current
        let asset = try await adapters.mediaSource.load(job.ref, allowNetwork: true, onDownload: download)
        return await adapters.transcriber.words(asset, locale: locale, allowModelDownload: job.options.allowModelDownload, progress: progress, gate: gate)
      case .faces:
        let asset = try await adapters.mediaSource.load(job.ref, allowNetwork: true, onDownload: download)
        return await adapters.faceDetector.faces(asset, fps: job.options.facesFps, progress: progress, gate: gate)
      case .proxy:
        return try await makeProxy(job, progress: progress, download: download)
      }
    } catch is NoAudio {
      return .unavailable(version, NoAudio().localizedDescription)
    } catch is NoVideo {
      return .unavailable(version, NoVideo().localizedDescription)
    } catch where adapters.mediaSource.isUnavailable(error) {
      // Offline iCloud originals, deleted clips: retry later, not a broken analyzer.
      return .unavailable(version, error.localizedDescription)
    } catch {
      return .failed(version, error)
    }
  }

  /// The 1080p preview proxy, or the one already on disk when it was made by this proxy
  /// version from this same source (it survives relaunches; the results here don't).
  /// `path` is relative to the media root, as the registry stores it. The source is opened
  /// without network first: an original that went back to iCloud keeps its proxy rather
  /// than being downloaded in full just to confirm the key.
  private func makeProxy(_ job: Job, progress: @escaping AnalyzerProgress, download: @escaping @Sendable (Double) -> Void) async throws -> PartResult {
    let store = ProxyStore.shared
    let path = try ProxyStore.relativePath(job.assetId)
    let existing = store.existing(job.assetId)
    let asset: AVAsset
    do {
      asset = try await adapters.mediaSource.load(job.ref, allowNetwork: false, onDownload: nil)
    } catch where adapters.mediaSource.isInCloud(error) {
      if let existing, existing.key?.hasPrefix("\(AnalyzerVersion.proxy)|") == true {
        return .ready(AnalyzerVersion.proxy, ["path": path, "bytes": existing.bytes, "reused": true, "keyChecked": false])
      }
      asset = try await adapters.mediaSource.load(job.ref, allowNetwork: true, onDownload: download)
    }
    let key = Self.proxyKey(try await adapters.mediaSource.fingerprint(asset))
    if let existing, existing.key == key {
      return .ready(AnalyzerVersion.proxy, ["path": path, "bytes": existing.bytes, "reused": true])
    }
    let partial = try store.partialURL(job.assetId)
    do {
      var data = try await adapters.proxy.make(asset, to: partial, progress: progress)
      _ = try store.commit(job.assetId, key: key)
      data["path"] = path
      return .ready(AnalyzerVersion.proxy, data)
    } catch {
      store.removePartial(job.assetId)
      throw error
    }
  }

  /// What a stored proxy must match to be reused (AnalysisPolicy.proxyKey).
  static func proxyKey(_ fingerprint: [String: Any]) -> String { AnalysisPolicy.proxyKey(fingerprint) }

  private func progress(_ job: Job, _ fraction: Double, phase: String? = nil) {
    // Progress hops here on its own task: a late tick from a finished or cancelled part is ignored.
    guard isCurrent(job), let current = running[job.part.heavy]?.job, current.seq == job.seq else { return }
    if job.part.heavy, phase == nil {
      // Ticks hop here on separate tasks and can arrive out of order; never step backwards.
      guard fraction >= heavyFraction else { return }
      heavyStep = max(heavyStep, fraction - heavyFraction)
      heavyFraction = fraction
    }
    // Whole percents only: words reports every audio chunk.
    let key = progressKey(job, phase)
    guard fraction >= 1 || fraction - (lastProgress[key] ?? -1) >= 0.01 else { return }
    lastProgress[key] = fraction >= 1 ? nil : fraction
    var body: [String: Any] = ["assetId": job.assetId, "part": job.part.rawValue, "fraction": fraction]
    if let phase { body["phase"] = phase }
    emit?("progress", body)
  }

  private func progressKey(_ job: Job, _ phase: String?) -> String {
    "\(job.seq)\(phase.map { "/\($0)" } ?? "")"
  }

  private func bump(_ assetId: String) -> Int {
    revisions[assetId, default: 0] += 1
    return revisions[assetId]!
  }

  private func record(_ assetId: String, _ part: Part, _ result: PartResult) {
    results[assetId, default: [:]][part] = result
    var body: [String: Any] = [
      "assetId": assetId, "part": part.rawValue, "revision": bump(assetId),
      "status": result.status, "analyzerVersion": result.analyzerVersion,
    ]
    if let error = result.error { body["error"] = error }
    emit?("analysisStatus", body)
  }

  fileprivate func emitState() {
    emit?("analysisState", ["playbackActive": playbackActive, "exportActive": exportActive, "thermal": adapters.deviceProfile.thermalName, "heavyPaused": heavyPaused])
  }

  // MARK: - Decoded audio cache

  /// The 8 kHz decode for `assetId` (or `ref`), shared: a second caller while the
  /// first decode is running waits for it instead of opening another reader.
  private func cachedPCM(assetId: String?, ref: String, progress: AnalyzerProgress? = nil, download: (@Sendable (Double) -> Void)? = nil) async throws -> [Float] {
    let key = assetId ?? ref
    if let hit = pcm[key] { return hit }
    if let inFlight = decoding[key] { return try await inFlight.value }
    // Inherits the caller's priority: utility from a scheduler lane, the JS caller's for a direct syncPair.
    let task = Task {
      try await adapters.audioDecoder.decodeMono(try await adapters.mediaSource.load(ref, allowNetwork: true, onDownload: download),
                                                 rate: Double(AudioSync.sampleRate), progress: progress)
    }
    decoding[key] = task
    let samples: [Float]
    do {
      samples = try await task.value
    } catch {
      if decoding[key] == task { decoding[key] = nil }
      throw error
    }
    // A cancel while decoding removed the entry; don't cache what it dropped.
    guard decoding[key] == task else { return samples }
    decoding[key] = nil
    pcm[key] = samples
    pcmOrder.removeAll { $0 == key }
    pcmOrder.append(key)
    for evicted in AnalysisPolicy.pcmEvictions(order: pcmOrder, counts: pcm.mapValues(\.count)) {
      pcmOrder.removeFirst()
      pcm[evicted] = nil
    }
    return samples
  }
}
