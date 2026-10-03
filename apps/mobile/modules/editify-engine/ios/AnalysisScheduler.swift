import AVFoundation
import Foundation

/// The device analysis scheduler (decision 8A).
///
///   analyze(asset) ─▶ parts queued as `pending` ─┬─ light lane: decode ▶ laughter ▶ energy   (one at a time)
///                                                └─ heavy lane: words ▶ faces              (one at a time, gated)
///   syncPair ─▶ runs at once, never queued (reuses a cached 8 kHz decode when there is one)
///
/// Picking order inside a lane: the asset on screen first (`setFocus`), then
/// part rank (decode, words, laughter, energy, faces), then arrival. The heavy
/// gate holds words/faces between chunks while playback or scrubbing is active
/// (`setPlaybackActive`) or the thermal state is `.serious` or worse; light
/// parts keep going. Every status change is emitted as an `analysisStatus` event.
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
  private var results: [String: [Part: PartResult]] = [:]
  private var pcm: [String: [Float]] = [:]
  private var pcmOrder: [String] = []
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

  // MARK: - Commands from JS

  /// Queue `parts` (all by default) for an asset. Parts already ready from the
  /// current analyzer version are skipped unless `force`.
  func analyze(assetId: String, ref: String, parts requested: [String]?, options: Options, force: Bool) {
    let parts = requested?.compactMap(Part.init(rawValue:)) ?? Part.allCases
    for part in parts {
      if !force, let done = results[assetId]?[part], done.status == "ready", done.analyzerVersion == part.version { continue }
      if queue.contains(where: { $0.assetId == assetId && $0.part == part }) { continue }
      let current = generations[assetId, default: 0]
      if running.values.contains(where: { $0.job.assetId == assetId && $0.job.part == part && $0.job.generation == current }) { continue }
      seq += 1
      queue.append(Job(assetId: assetId, ref: ref, part: part, seq: seq, generation: generations[assetId, default: 0], options: options))
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

  /// Drop an asset's queued parts and stop its running ones.
  func cancel(assetId: String) {
    generations[assetId, default: 0] += 1
    for job in queue where job.assetId == assetId { results[assetId]?[job.part] = nil }
    queue.removeAll { $0.assetId == assetId }
    for (_, entry) in running where entry.job.assetId == assetId { entry.task.cancel() }
    pcm[assetId] = nil
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
      let task = Task { [weak self] in
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

  private func finish(_ job: Job, _ result: PartResult) {
    running[job.part.heavy] = nil
    if job.part.heavy { heavyFraction = 0 }
    // A cancelled asset's part leaves no trace rather than a misleading `failed`.
    if job.generation == generations[job.assetId, default: 0] {
      record(job.assetId, job.part, result)
    } else if results[job.assetId]?[job.part]?.status == "pending", !queue.contains(where: { $0.assetId == job.assetId && $0.part == job.part }) {
      results[job.assetId]?[job.part] = nil
    }
    pump()
  }

  private func run(_ job: Job) async -> PartResult {
    let progress: AnalyzerProgress = { [weak self] fraction in
      Task { await self?.progress(job, fraction) }
    }
    let stop = CancelFlag()
    let gate: AnalyzerGate = { [weak self] in await self?.waitWhileHeavyPaused(stop) ?? false }
    return await withTaskCancellationHandler {
      await analyze(job, progress: progress, gate: gate)
    } onCancel: {
      stop.set()
    }
  }

  private func analyze(_ job: Job, progress: @escaping AnalyzerProgress, gate: @escaping AnalyzerGate) async -> PartResult {
    let version = job.part.version
    do {
      switch job.part {
      case .decode:
        let samples = try await cachedPCM(assetId: job.assetId, ref: job.ref, progress: progress)
        return .ready(version, [
          "sampleRate": AudioSync.sampleRate, "sampleCount": samples.count,
          "seconds": Double(samples.count) / Double(AudioSync.sampleRate),
        ])
      case .energy:
        let samples = try await cachedPCM(assetId: job.assetId, ref: job.ref, progress: progress)
        return Analyzers.energy(samples: samples)
      case .laughter:
        return await Analyzers.laughter(try await AssetSource.load(job.ref), progress: progress)
      case .words:
        let locale = job.options.locale.map(Locale.init(identifier:)) ?? .current
        return await Analyzers.words(try await AssetSource.load(job.ref), locale: locale, allowModelDownload: job.options.allowModelDownload, progress: progress, gate: gate)
      case .faces:
        return await Analyzers.faces(try await AssetSource.load(job.ref), fps: job.options.facesFps, progress: progress, gate: gate)
      }
    } catch is NoAudio {
      return .unavailable(version, NoAudio().localizedDescription)
    } catch let error as AssetSource.InCloud {
      return .unavailable(version, error.localizedDescription)
    } catch let error as AssetSource.NotFound {
      return .unavailable(version, error.localizedDescription)
    } catch {
      return .failed(version, error)
    }
  }

  private func progress(_ job: Job, _ fraction: Double) {
    // Progress hops here on its own task, so a late tick from a finished part is ignored.
    guard let current = running[job.part.heavy]?.job, current.seq == job.seq else { return }
    if job.part.heavy { heavyFraction = fraction }
    // Whole percents only: words reports every audio chunk.
    let key = "\(job.assetId)/\(job.part.rawValue)"
    guard fraction >= 1 || fraction - (lastProgress[key] ?? -1) >= 0.01 else { return }
    lastProgress[key] = fraction >= 1 ? nil : fraction
    emit?("progress", ["assetId": job.assetId, "part": job.part.rawValue, "fraction": fraction])
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

  private func cachedPCM(assetId: String?, ref: String, progress: AnalyzerProgress? = nil) async throws -> [Float] {
    let key = assetId ?? ref
    if let hit = pcm[key] { return hit }
    let samples = try await Analyzers.decodeMono(try await AssetSource.load(ref), progress: progress)
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

/// Set once from a cancellation handler, read from analyzer loops on other tasks.
final class CancelFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  var isSet: Bool { lock.withLock { value } }
  func set() { lock.withLock { value = true } }
}
