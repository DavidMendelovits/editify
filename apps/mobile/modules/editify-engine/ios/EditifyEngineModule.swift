import AVFoundation
import ExpoModulesCore

/// The on-device engine. Four surfaces:
///   - capability lab: each `runSpike` call is one run: Sampler begin → spike → one
///     JSONL row, which is also returned to JS for display.
///   - analyzers (plan P2): direct calls that return a part result
///     `{status, analyzerVersion, data?, error?}`, and the 8A scheduler that runs
///     them per asset and reports through `analysisStatus` events.
///   - export (plan P4): `exportProject` renders a RenderPlan on the phone
///     (ExportCenter, PlanExporter) and reports through `exportState` events.
///   - native preview (plan P5): the EditifyPlayerView view (PlanPlayer), driven
///     through its ref.
public class EditifyEngineModule: Module {
  /// This instance's JS context (see EngineContext): set before any JS call can arrive.
  private var contextEpoch = 0
  /// 0 means OnCreate hasn't run: send no epoch rather than one older than every context.
  private var epochForCalls: Int? { contextEpoch == 0 ? nil : contextEpoch }
  /// iCloud downloads started by `downloadMedia`, by the caller's request id, for `cancelDownload`.
  private let downloads = DownloadTasks()

  public func definition() -> ModuleDefinition {
    Name("EditifyEngine")
    Events("progress", "analysisStatus", "analysisState", "exportState")

    OnCreate {
      LabStore.recoverKilledRun()
      TempFiles.sweep()
      ProxyStore.shared.sweepPartialsOnce()
      let epoch = EngineContext.begin()
      self.contextEpoch = epoch
      let emit: AnalysisScheduler.Emit = { [weak self] event, body in self?.sendEvent(event, body) }
      Task {
        await AnalysisScheduler.shared.setEmitter(emit, epoch: epoch)
        // The scheduler outlives a JS reload; the new context starts with playback stopped.
        // Idempotent per epoch, so landing after this context's own calls changes nothing.
        await AnalysisScheduler.shared.reset(epoch: epoch)
      }
    }

    OnDestroy {
      // Nobody listens to a running export once this JS context is gone.
      ExportCenter.shared.cancelAll()
    }

    Function("readResults") { LabStore.readAll() }
    Function("resultsPath") { LabStore.resultsURL.absoluteString }
    Function("clearResults") { LabStore.clear() }

    AsyncFunction("runSpike") { (spike: String, variant: String, run: Int, params: [String: Any]) async throws -> [String: Any] in
      let impl = try Spikes.make(spike)
      let sampler = Sampler(spike: spike, variant: variant, run: run)
      do {
        try await sampler.begin()
      } catch let refused as Sampler.Refused {
        return ["spike": spike, "variant": variant, "run": run, "status": "refused", "note": refused.reason]
      }
      do {
        let metrics = try await impl.run(variant: variant, params: params, sampler: sampler) { [weak self] fraction in
          self?.sendEvent("progress", ["spike": spike, "run": run, "fraction": fraction])
        }
        return await sampler.finish(status: "ok", metrics: metrics)
      } catch {
        return await sampler.finish(status: "error", metrics: [:], note: error.localizedDescription)
      }
    }

    // MARK: Analyzers, called directly (no queue)

    Function("analyzerVersions") { AnalyzerVersion.all }

    /// Decodes the audio to mono Float32 LE at `sampleRate` (8000-48000, default 8000) into
    /// a temp file (swept on next launch); JS gets the file and its length.
    AsyncFunction("decodeMono") { (ref: String, sampleRate: Double?) async throws -> [String: Any] in
      let rate = try AnalyzerLimits.sampleRate(sampleRate ?? Double(AudioSync.sampleRate))
      let asset = try await AssetSource.load(ref, onDownload: self.progress(part: "decode", ref: ref, phase: "download"))
      let samples = try await Analyzers.decodeMono(asset, rate: rate, progress: self.progress(part: "decode", ref: ref))
      let url = TempFiles.url(prefix: TempFiles.pcmPrefix, extension: "f32")
      try samples.withUnsafeBufferPointer { try Data(buffer: $0).write(to: url) }
      return ["uri": url.absoluteString, "sampleRate": rate, "sampleCount": samples.count, "seconds": Double(samples.count) / rate]
    }

    /// SyncMeasurement for one video/memo pair (OV6). Asset ids, when given, let it reuse the scheduler's decode.
    AsyncFunction("syncPair") { (videoRef: String, memoRef: String, videoAssetId: String?, memoAssetId: String?) async -> [String: Any] in
      await AnalysisScheduler.shared.syncPair(videoRef: videoRef, memoRef: memoRef, videoAssetId: videoAssetId, memoAssetId: memoAssetId).dictionary
    }

    AsyncFunction("words") { (ref: String, locale: String?, allowModelDownload: Bool?) async -> [String: Any] in
      let progress = self.progress(part: "words", ref: ref)
      return await self.part(ref, "words", AnalyzerVersion.words) { asset in
        await Analyzers.words(asset, locale: locale.map(Locale.init(identifier:)) ?? .current, allowModelDownload: allowModelDownload ?? true, progress: progress)
      }
    }

    AsyncFunction("laughter") { (ref: String, minConfidence: Double?) async -> [String: Any] in
      let progress = self.progress(part: "laughter", ref: ref)
      return await self.part(ref, "laughter", AnalyzerVersion.laughter) { asset in
        await Analyzers.laughter(asset, minConfidence: minConfidence ?? 0.5, progress: progress)
      }
    }

    /// energyAnalysisSchema data (50 ms RMS dBFS cells) plus `onsetPeaks` seconds.
    AsyncFunction("energy") { (ref: String) async -> [String: Any] in
      let progress = self.progress(part: "energy", ref: ref)
      return await self.part(ref, "energy", AnalyzerVersion.energy) { asset in
        do {
          return Analyzers.energy(samples: try await Analyzers.decodeMono(asset, progress: progress))
        } catch is NoAudio {
          return .unavailable(AnalyzerVersion.energy, NoAudio().localizedDescription)
        } catch {
          return .failed(AnalyzerVersion.energy, error)
        }
      }
    }

    /// Onset peaks (cut_to_beats) from an energy curve already on the JS side.
    Function("onsetPeaks") { (rmsDb: [Double], cellSeconds: Double) -> [Double] in
      AnalysisMath.onsetPeaks(rmsDb, cellSeconds: cellSeconds)
    }

    AsyncFunction("faces") { (ref: String, fps: Double?) async -> [String: Any] in
      let progress = self.progress(part: "faces", ref: ref)
      return await self.part(ref, "faces", AnalyzerVersion.faces) { asset in
        await Analyzers.faces(asset, fps: fps ?? 2, progress: progress)
      }
    }

    /// An H.264 copy at most `maxHeight` (clamped to 144-1080, default 360) tall for Gemini
    /// style analysis: {uri, width, height, seconds, bytes, exportMs}, the size as written.
    /// Uploading it is the caller's job; the file is swept on next launch.
    AsyncFunction("makeProxy") { (ref: String, maxHeight: Double?) async throws -> [String: Any] in
      let asset = try await AssetSource.load(ref, onDownload: self.progress(part: "proxy", ref: ref, phase: "download"))
      return try await Analyzers.makeProxy(asset, maxHeight: maxHeight ?? 360)
    }

    // MARK: Scheduler (decision 8A)

    /// Queue parts (all when `parts` is null) for an asset. options: facesFps, locale, allowModelDownload, force.
    AsyncFunction("analyze") { (assetId: String, ref: String, parts: [String]?, options: [String: Any]?) async in
      var settings = AnalysisScheduler.Options()
      if let fps = options?["facesFps"] as? Double { settings.facesFps = fps }
      if let locale = options?["locale"] as? String { settings.locale = locale }
      if let allow = options?["allowModelDownload"] as? Bool { settings.allowModelDownload = allow }
      let force = options?["force"] as? Bool ?? false
      await AnalysisScheduler.shared.analyze(assetId: assetId, ref: ref, parts: parts, options: settings, force: force)
    }

    /// `seq` (optional): the caller's toggle counter; a call older than one already applied is dropped.
    AsyncFunction("setPlaybackActive") { (active: Bool, seq: Int?) async in
      await AnalysisScheduler.shared.setPlaybackActive(active, epoch: self.epochForCalls, seq: seq)
    }

    AsyncFunction("setFocusAsset") { (assetId: String?) async in
      await AnalysisScheduler.shared.setFocus(assetId, epoch: self.epochForCalls)
    }

    AsyncFunction("cancelAnalysis") { (assetId: String) async in
      await AnalysisScheduler.shared.cancel(assetId: assetId)
    }

    AsyncFunction("getAnalysis") { (assetId: String) async -> [String: Any] in
      await AnalysisScheduler.shared.analysis(assetId: assetId)
    }

    AsyncFunction("schedulerState") { () async -> [String: Any] in
      await AnalysisScheduler.shared.state()
    }

    /// True while an export renders: proxies are cancelled and held, words/faces pause.
    AsyncFunction("setExportActive") { (active: Bool, seq: Int?) async in
      await AnalysisScheduler.shared.setExportActive(active, epoch: self.epochForCalls, seq: seq)
    }

    // MARK: On-device export (plan P4, 8A + OV8, OV5)

    /// Renders a RenderPlan v1 (JSON) to an .mp4 and answers its export id at once; the run
    /// reports `exportState` events. options: media {assetId: ref from resolveMedia} (every
    /// plan asset, required), destination 'photos' | 'file' (default photos), videoBitrate
    /// (bit/s), keyframeInterval (s). Rejects bad input or a second concurrent export.
    AsyncFunction("exportProject") { (planJson: String, options: [String: Any]?) async throws -> String in
      try await ExportCenter.shared.start(planJson: planJson, options: options ?? [:]) { [weak self] body in
        self?.sendEvent("exportState", body)
      }
    }

    /// Cancels an export (queued or running); its temp file is removed. Unknown ids are ignored.
    Function("cancelExport") { (id: String) in
      ExportCenter.shared.cancel(id)
    }

    /// {backgroundGPU}: whether this phone can keep exporting with Editify in the background.
    Function("exportCapabilities") { () -> [String: Any] in
      ExportCenter.capabilities()
    }

    // MARK: Local media registry (decision 3A) and preview proxies (10B)

    /// 'all' | 'limited' | 'denied' | 'undetermined', read without prompting.
    Function("photosAccess") { AssetSource.photosAccess() }

    /// Application Support/Editify/ as a file:// URL: registry paths are relative to it.
    Function("mediaRoot") { () -> String in
      let root = MediaStore.root
      try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      return root.absoluteString
    }

    /// Copies a picked/shared/recorded file into media/ (durable, excluded from backup).
    AsyncFunction("durableCopy") { (uri: String, name: String) throws -> [String: Any] in
      guard let source = URL(string: uri), source.isFileURL else { throw InvalidArgument(message: "durableCopy needs a file:// URI, got \(uri)") }
      let copy = try MediaStore.durableCopy(from: source, name: name)
      return ["path": copy.path, "uri": MediaStore.url(forRelative: copy.path).absoluteString, "bytes": copy.bytes]
    }

    /// A PHAsset's original written to a new temporary file {uri, bytes, name}, never downloading,
    /// for an upload the server is missing (plan OV1). The caller removes the file.
    AsyncFunction("exportOriginal") { (ref: String) async throws -> [String: Any] in
      guard !ref.isEmpty, ref.count <= 2048, !ref.hasPrefix("file://") else { throw InvalidArgument(message: "exportOriginal needs a PHAsset id") }
      let written = try await AssetSource.exportOriginal(ref)
      return ["uri": written.url.absoluteString, "bytes": written.bytes, "name": written.name]
    }

    /// Fingerprint and availability of a PHAsset id or file:// URI, without downloading from iCloud.
    AsyncFunction("probeMedia") { (ref: String) async throws -> [String: Any] in
      try await AssetSource.probe(ref, allowNetwork: false)
    }

    /// Stored size and clockwise display rotation {width, height, rotation} of a PHAsset id or
    /// file:// URI (a video's track, a still's EXIF), never downloading; null when unreadable.
    AsyncFunction("mediaGeometry") { (ref: String) async -> [String: Any]? in
      guard !ref.isEmpty, ref.count <= 2048 else { return nil }
      if ref.hasPrefix("file://"), ExportCenter.containedFileURL(ref) == nil { return nil }
      return await AssetSource.geometry(ref)
    }

    /// `probeMedia` that downloads an iCloud original first. Progress arrives as `progress`
    /// events {part: 'download', ref, requestId, fraction, phase: 'download'};
    /// `cancelDownload(requestId)` cancels the Photos request and rejects this call.
    AsyncFunction("downloadMedia") { (ref: String, requestId: String) async throws -> [String: Any] in
      let task = Task { () -> [String: Any] in
        try await AssetSource.probe(ref, allowNetwork: true) { [weak self] fraction in
          self?.sendEvent("progress", ["part": "download", "ref": ref, "requestId": requestId, "fraction": fraction, "phase": "download"])
        }
      }
      self.downloads.set(requestId, task)
      defer { self.downloads.remove(requestId, task) }
      return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    Function("cancelDownload") { (requestId: String) in
      self.downloads.cancel(requestId)
    }

    /// Queues the 1080p preview proxy (the scheduler's `proxy` part); status and progress
    /// arrive as `analysisStatus` / `progress` events with part 'proxy'.
    AsyncFunction("ensureProxy") { (assetId: String, ref: String) async throws in
      guard !assetId.isEmpty, !ref.isEmpty else { throw InvalidArgument(message: "ensureProxy needs an asset id and a ref") }
      await AnalysisScheduler.shared.analyze(assetId: assetId, ref: ref, parts: ["proxy"], options: AnalysisScheduler.Options(), force: false)
    }

    /// The preview opened this proxy: it becomes the last to be evicted. False when there is none.
    Function("touchProxy") { (assetId: String) -> Bool in
      ProxyStore.shared.touch(assetId)
    }

    /// Clamped to 256 MB...1 TB; a non-number is ignored and answers false.
    AsyncFunction("setProxyBudget") { (bytes: Double) async -> Bool in
      await AnalysisScheduler.shared.setProxyBudget(bytes)
    }

    /// Deletes an asset's proxy (the registry forgot the asset).
    Function("removeProxy") { (assetId: String) in
      ProxyStore.shared.remove(assetId)
    }

    /// Shows the system Photos prompt if it was never shown; answers the access after it.
    AsyncFunction("requestPhotosAccess") { () async -> String in
      await AssetSource.requestPhotosAccess()
    }

    /// Bytes iOS would make available for something the user asked for (0 when unknown).
    Function("availableBytes") { () -> Double in
      Double(MediaStore.availableBytes())
    }

    /// Every file under media/: {path, bytes, modified (ms)}, for the registry's orphan sweep.
    Function("mediaFiles") { () -> [[String: Any]] in
      MediaStore.mediaFiles()
    }

    /// Deletes a file under the media root by its relative path.
    Function("removeMedia") { (path: String) in
      MediaStore.remove(relative: path)
    }

    // MARK: Native preview (plan P5, 6A + OV10)

    /// True in binaries that have EditifyPlayerView: JS checks it before rendering the view, so an
    /// OTA update on an older binary keeps PreviewPlayer instead of a missing native view.
    Function("nativePreviewAvailable") { true }

    View(EditifyPlayerView.self) {
      Events("onTime", "onReady", "onStall", "onEnded", "onError", "onPlan")

      /// The app's API origin (EXPO_PUBLIC_API_URL): remote media must come from it.
      Prop("apiOrigin") { (view: EditifyPlayerView, origin: String?) in
        view.apiOrigin.url = origin.flatMap(URL.init(string:))
      }

      /// A RenderPlan v1 (JSON, built for the view's size) and its media map {assetId: ref from
      /// resolveMedia 'preview'}. Decoded and checked here, off the main thread (the check resolves
      /// file symlinks on disk); only the hand-over runs on it. {accepted: false} when its
      /// (revision, buildSeq) is not newer than the last one this view accepted. How it was
      /// applied (in place or rebuilt) arrives as onPlan. Rejects a bad plan or media map.
      AsyncFunction("setPlan") { (view: EditifyPlayerView, planJson: String, media: [String: Any]) async throws -> [String: Any] in
        let plan: RenderPlan
        do { plan = try RenderPlan.decode(Data(planJson.utf8)) } catch { throw PreviewMedia.Rejected(message: error.localizedDescription) }
        let refs = try PreviewMedia.validate(media, for: plan, origin: view.apiOrigin.url)
        let accepted = await MainActor.run { view.setPlan(plan, media: refs) }
        return ["accepted": accepted]
      }

      // The transport runs in call order on the main queue (FIFO): a pause sent after a play
      // can never land first.
      AsyncFunction("play") { (view: EditifyPlayerView) in
        MainActor.assumeIsolated { view.play() }
      }.runOnQueue(.main)

      AsyncFunction("pause") { (view: EditifyPlayerView) in
        MainActor.assumeIsolated { view.pause() }
      }.runOnQueue(.main)

      /// Seeks coalesce natively (one in flight, the newest queued): a scrub can call this per frame.
      AsyncFunction("seek") { (view: EditifyPlayerView, time: Double, exact: Bool) in
        MainActor.assumeIsolated { view.seek(time, exact: exact) }
      }.runOnQueue(.main)

      AsyncFunction("setMuted") { (view: EditifyPlayerView, muted: Bool) in
        MainActor.assumeIsolated { view.setMuted(muted) }
      }.runOnQueue(.main)

      AsyncFunction("currentTime") { (view: EditifyPlayerView) -> Double in
        MainActor.assumeIsolated { view.currentTime }
      }.runOnQueue(.main)
    }
  }

  private func progress(part: String, ref: String, phase: String? = nil) -> AnalyzerProgress {
    { [weak self] fraction in
      var body: [String: Any] = ["part": part, "ref": ref, "fraction": fraction]
      if let phase { body["phase"] = phase }
      self?.sendEvent("progress", body)
    }
  }

  /// Loads the asset (forwarding iCloud download progress), mapping a missing or
  /// unreachable source to `unavailable`, then runs `body`.
  private func part(_ ref: String, _ part: String, _ version: String, _ body: (AVAsset) async -> PartResult) async -> [String: Any] {
    do {
      let asset = try await AssetSource.load(ref, onDownload: progress(part: part, ref: ref, phase: "download"))
      return await body(asset).dictionary
    } catch where AssetSource.isUnavailable(error) {
      return PartResult.unavailable(version, error.localizedDescription).dictionary
    } catch {
      return PartResult.failed(version, error).dictionary
    }
  }
}

/// In-flight `downloadMedia` tasks by request id. A cancel can arrive before its download
/// has registered (JS fires both without waiting): the id is remembered and the task is
/// cancelled as it registers.
private final class DownloadTasks: @unchecked Sendable {
  private let lock = NSLock()
  private var tasks: [String: Task<[String: Any], Error>] = [:]
  private var cancelledEarly: Set<String> = []

  func set(_ id: String, _ task: Task<[String: Any], Error>) {
    let (previous, cancelNow) = lock.withLock { () -> (Task<[String: Any], Error>?, Bool) in
      if cancelledEarly.remove(id) != nil { return (nil, true) }
      defer { tasks[id] = task }
      return (tasks[id], false)
    }
    previous?.cancel()
    if cancelNow { task.cancel() }
  }

  /// Only if it is still this task (a newer download may have reused the id).
  func remove(_ id: String, _ task: Task<[String: Any], Error>) {
    lock.withLock { if tasks[id] == task { tasks[id] = nil } }
  }

  func cancel(_ id: String) {
    let task = lock.withLock { () -> Task<[String: Any], Error>? in
      if let task = tasks.removeValue(forKey: id) { return task }
      // Bounded: a cancel that lands after its download finished is never consumed.
      if cancelledEarly.count >= 64 { cancelledEarly.removeAll() }
      cancelledEarly.insert(id)
      return nil
    }
    task?.cancel()
  }
}
