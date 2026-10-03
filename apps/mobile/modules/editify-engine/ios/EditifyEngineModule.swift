import AVFoundation
import ExpoModulesCore

/// The on-device engine. Two surfaces:
///   - capability lab: each `runSpike` call is one run: Sampler begin → spike → one
///     JSONL row, which is also returned to JS for display.
///   - analyzers (plan P2): direct calls that return a part result
///     `{status, analyzerVersion, data?, error?}`, and the 8A scheduler that runs
///     them per asset and reports through `analysisStatus` events.
public class EditifyEngineModule: Module {
  /// This instance's JS context (see EngineContext): set before any JS call can arrive.
  private var contextEpoch = 0
  /// 0 means OnCreate hasn't run: send no epoch rather than one older than every context.
  private var epochForCalls: Int? { contextEpoch == 0 ? nil : contextEpoch }

  public func definition() -> ModuleDefinition {
    Name("EditifyEngine")
    Events("progress", "analysisStatus", "analysisState")

    OnCreate {
      LabStore.recoverKilledRun()
      TempFiles.sweep()
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

    AsyncFunction("setPlaybackActive") { (active: Bool) async in
      await AnalysisScheduler.shared.setPlaybackActive(active, epoch: self.epochForCalls)
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
