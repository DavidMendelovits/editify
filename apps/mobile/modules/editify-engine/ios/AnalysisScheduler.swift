import AVFoundation
import Foundation

/// The device analysis scheduler (decision 8A).
///
///   analyze(asset) ─▶ parts queued as `pending` ─┬─ light lane: decode ▶ laughter ▶ energy   (one at a time)
///                                                └─ heavy lane: words ▶ faces              (one at a time, gated)
///   syncPair ─▶ runs at once, never queued (shares the cached or in-flight 8 kHz decode)
///
/// Picking order inside a lane: the asset on screen first (`setFocus`), then
/// part rank (decode, words, laughter, energy, faces), then arrival. The heavy
/// gate holds words/faces between chunks while playback or scrubbing is active
/// (`setPlaybackActive`) or the thermal state is `.serious` or worse; light
/// parts keep going.
///
/// Events: `analysisStatus` {assetId, part, status, analyzerVersion, error?} on every
/// change, carrying no data (on `ready`, read it with `analysis(assetId:)`), or
/// {assetId, part, removed: true} when `cancel` drops a pending part.
actor AnalysisScheduler {
  static let shared = AnalysisScheduler()

  enum Part: String, CaseIterable, Sendable {
    case decode, words, laughter, energy, faces

    var rank: Int { Part.allCases.firstIndex(of: self)! }
    var heavy: Bool { self == .words || self == .faces }
    var version: String { AnalyzerVersion.all[rawValue]! }
  }

  struct Job: Sendable {
    let assetId: String
    let ref: String
    let part: Part
    let seq: Int
    /// The asset's generation when queued; `cancel` bumps it so a late result is dropped.
    let generation: Int
    let options: Options
  }

  struct Options: Sendable {
    var facesFps = 2.0
    var locale: String?
    var allowModelDownload = true
  }

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
  private(set) var heavyFraction = 0.0
  private var lastProgress: [String: Double] = [:]
  private var emit: Emit?
  private var thermalObserver: NSObjectProtocol?

  /// Decoded 8 kHz audio kept for sync/energy; ~32 MB is about 17 minutes of audio.
  private static let pcmBudgetSamples = 8_000_000

  func setEmitter(_ emit: Emit?) {
    self.emit = emit
    if thermalObserver == nil {
      thermalObserver = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { _ in
        Task { await AnalysisScheduler.shared.emitState() }
      }
    }
  }

  /// A fresh JS context (reload, new module instance) knows nothing of the old one's
  /// playback or focus; left as they were, a stale `playbackActive` would hold the heavy lane forever.
  func reset() {
    playbackActive = false
    focus = nil
    emitState()
  }

  // MARK: - Commands from JS

  /// Queue `parts` (all by default) for an asset. Parts already ready from the
  /// current analyzer version are skipped unless `force`.
  func analyze(assetId: String, ref: String, parts requested: [String]?, options: Options, force: Bool) {
    let parts = requested?.compactMap(Part.init(rawValue:)) ?? Part.allCases
    let generation = generations[assetId, default: 0]
    for part in parts {
      if !force, let done = results[assetId]?[part], done.status == "ready", done.analyzerVersion == part.version { continue }
      if queue.contains(where: { $0.assetId == assetId && $0.part == part }) { continue }
      if running.values.contains(where: { $0.job.assetId == assetId && $0.job.part == part && $0.job.generation == generation }) { continue }
      seq += 1
      queue.append(Job(assetId: assetId, ref: ref, part: part, seq: seq, generation: generation, options: options))
      record(assetId, part, PartResult(status: "pending", analyzerVersion: part.version))
    }
    pump()
  }

  func setPlaybackActive(_ active: Bool) {
    guard playbackActive != active else { return }
    playbackActive = active
    emitState()
  }

  /// The asset on screen jumps the queue in both lanes (it does not preempt a running part).
  func setFocus(_ assetId: String?) {
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
      lastProgress["\(assetId)/\(part.rawValue)"] = nil
      emit?("analysisStatus", ["assetId": assetId, "part": part.rawValue, "removed": true])
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
    return ["assetId": assetId, "parts": parts]
  }

  func state() -> [String: Any] {
    [
      "playbackActive": playbackActive,
      "thermal": Sampler.thermalName(),
      "heavyPaused": heavyPaused,
      "queued": queue.map { ["assetId": $0.assetId, "part": $0.part.rawValue] },
      "running": running.values.map { ["assetId": $0.job.assetId, "part": $0.job.part.rawValue] },
      "focus": focus ?? NSNull(),
    ]
  }

  /// Sync for one memo/video pair, outside the queue (8A: sync is never queued).
  func syncPair(videoRef: String, memoRef: String, videoAssetId: String?, memoAssetId: String?) async -> PartResult {
    do {
      async let video = cachedPCM(assetId: videoAssetId, ref: videoRef)
      async let memo = cachedPCM(assetId: memoAssetId, ref: memoRef)
      let (v, m) = try await (video, memo)
      return Analyzers.sync(video: v, memo: m)
    } catch is NoAudio {
      return .unavailable(AnalyzerVersion.sync, NoAudio().localizedDescription)
    } catch where AssetSource.isUnavailable(error) {
      return .unavailable(AnalyzerVersion.sync, error.localizedDescription)
    } catch {
      return .failed(AnalyzerVersion.sync, error)
    }
  }

  // MARK: - Gate

  var heavyPaused: Bool {
    playbackActive || ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
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
      let candidates = queue.filter { $0.part.heavy == heavy }
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
    (job.assetId == focus ? 0 : 1, job.part.rank, job.seq)
  }

  private func isCurrent(_ job: Job) -> Bool {
    job.generation == generations[job.assetId, default: 0]
  }

  private func finish(_ job: Job, _ result: PartResult) {
    running[job.part.heavy] = nil
    if job.part.heavy { heavyFraction = 0 }
    lastProgress["\(job.assetId)/\(job.part.rawValue)"] = nil
    // A cancelled job's result is dropped: `cancel` already removed its pending entry,
    // and a newer request for the same part may be queued under the new generation.
    if isCurrent(job) { record(job.assetId, job.part, result) }
    pump()
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
        return await Analyzers.laughter(try await AssetSource.load(job.ref, onDownload: download), progress: progress)
      case .words:
        let locale = job.options.locale.map(Locale.init(identifier:)) ?? .current
        let asset = try await AssetSource.load(job.ref, onDownload: download)
        return await Analyzers.words(asset, locale: locale, allowModelDownload: job.options.allowModelDownload, progress: progress, gate: gate)
      case .faces:
        let asset = try await AssetSource.load(job.ref, onDownload: download)
        return await Analyzers.faces(asset, fps: job.options.facesFps, progress: progress, gate: gate)
      }
    } catch is NoAudio {
      return .unavailable(version, NoAudio().localizedDescription)
    } catch where AssetSource.isUnavailable(error) {
      // Offline iCloud originals, deleted clips: retry later, not a broken analyzer.
      return .unavailable(version, error.localizedDescription)
    } catch {
      return .failed(version, error)
    }
  }

  private func progress(_ job: Job, _ fraction: Double, phase: String? = nil) {
    // Progress hops here on its own task: a late tick from a finished or cancelled part is ignored.
    guard isCurrent(job), let current = running[job.part.heavy]?.job, current.seq == job.seq else { return }
    if job.part.heavy, phase == nil { heavyFraction = fraction }
    // Whole percents only: words reports every audio chunk.
    let key = "\(job.assetId)/\(job.part.rawValue)\(phase.map { "/\($0)" } ?? "")"
    guard fraction >= 1 || fraction - (lastProgress[key] ?? -1) >= 0.01 else { return }
    lastProgress[key] = fraction >= 1 ? nil : fraction
    var body: [String: Any] = ["assetId": job.assetId, "part": job.part.rawValue, "fraction": fraction]
    if let phase { body["phase"] = phase }
    emit?("progress", body)
  }

  private func record(_ assetId: String, _ part: Part, _ result: PartResult) {
    results[assetId, default: [:]][part] = result
    var body: [String: Any] = ["assetId": assetId, "part": part.rawValue, "status": result.status, "analyzerVersion": result.analyzerVersion]
    if let error = result.error { body["error"] = error }
    emit?("analysisStatus", body)
  }

  fileprivate func emitState() {
    emit?("analysisState", ["playbackActive": playbackActive, "thermal": Sampler.thermalName(), "heavyPaused": heavyPaused])
  }

  // MARK: - Decoded audio cache

  /// The 8 kHz decode for `assetId` (or `ref`), shared: a second caller while the
  /// first decode is running waits for it instead of opening another reader.
  private func cachedPCM(assetId: String?, ref: String, progress: AnalyzerProgress? = nil, download: (@Sendable (Double) -> Void)? = nil) async throws -> [Float] {
    let key = assetId ?? ref
    if let hit = pcm[key] { return hit }
    if let inFlight = decoding[key] { return try await inFlight.value }
    let task = Task(priority: .utility) {
      try await Analyzers.decodeMono(try await AssetSource.load(ref, onDownload: download), progress: progress)
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
    var total = pcm.values.reduce(0) { $0 + $1.count }
    while total > Self.pcmBudgetSamples, pcmOrder.count > 1 {
      let evicted = pcmOrder.removeFirst()
      total -= pcm[evicted]?.count ?? 0
      pcm[evicted] = nil
    }
    return samples
  }
}
