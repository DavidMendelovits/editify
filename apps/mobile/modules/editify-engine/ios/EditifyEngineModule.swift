import AVFoundation
import ExpoModulesCore

/// The on-device engine. Two surfaces:
///   - capability lab: each `runSpike` call is one run: Sampler begin → spike → one
///     JSONL row, which is also returned to JS for display.
///   - analyzers (plan P2): direct calls that return a part result
///     `{status, analyzerVersion, data?, error?}`, and the 8A scheduler that runs
///     them per asset and reports through `analysisStatus` events.
public class EditifyEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EditifyEngine")
    Events("progress", "analysisStatus", "analysisState")

    OnCreate {
      LabStore.recoverKilledRun()
      let emit: AnalysisScheduler.Emit = { [weak self] event, body in self?.sendEvent(event, body) }
      Task { await AnalysisScheduler.shared.setEmitter(emit) }
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

    /// Decodes the audio to mono Float32 LE at `sampleRate` (default 8000) into a
    /// temp file; the samples stay native-side, JS gets the file and its length.
    AsyncFunction("decodeMono") { (ref: String, sampleRate: Double?) async throws -> [String: Any] in
      let rate = sampleRate ?? Double(AudioSync.sampleRate)
      let samples = try await Analyzers.decodeMono(try await AssetSource.load(ref), rate: rate, progress: self.progress(part: "decode", ref: ref))
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("pcm-\(UUID().uuidString).f32")
      try samples.withUnsafeBufferPointer { try Data(buffer: $0).write(to: url) }
      return ["uri": url.absoluteString, "sampleRate": rate, "sampleCount": samples.count, "seconds": Double(samples.count) / rate]
    }

    /// SyncMeasurement for one video/memo pair (OV6). Asset ids, when given, let it reuse the scheduler's decode.
    AsyncFunction("syncPair") { (videoRef: String, memoRef: String, videoAssetId: String?, memoAssetId: String?) async -> [String: Any] in
      await AnalysisScheduler.shared.syncPair(videoRef: videoRef, memoRef: memoRef, videoAssetId: videoAssetId, memoAssetId: memoAssetId).dictionary
    }

    AsyncFunction("words") { (ref: String, locale: String?, allowModelDownload: Bool?) async -> [String: Any] in
      let progress = self.progress(part: "words", ref: ref)
      return await EditifyEngineModule.part(ref, AnalyzerVersion.words) { asset in
        await Analyzers.words(asset, locale: locale.map(Locale.init(identifier:)) ?? .current, allowModelDownload: allowModelDownload ?? true, progress: progress)
      }
    }

    AsyncFunction("laughter") { (ref: String, minConfidence: Double?) async -> [String: Any] in
      let progress = self.progress(part: "laughter", ref: ref)
      return await EditifyEngineModule.part(ref, AnalyzerVersion.laughter) { asset in
        await Analyzers.laughter(asset, minConfidence: minConfidence ?? 0.5, progress: progress)
      }
    }

    /// energyAnalysisSchema data (50 ms RMS dBFS cells) plus `onsetPeaks` seconds.
    AsyncFunction("energy") { (ref: String) async -> [String: Any] in
      let progress = self.progress(part: "energy", ref: ref)
      return await EditifyEngineModule.part(ref, AnalyzerVersion.energy) { asset in
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
      return await EditifyEngineModule.part(ref, AnalyzerVersion.faces) { asset in
        await Analyzers.faces(asset, fps: fps ?? 2, progress: progress)
      }
    }

    /// An H.264 copy at most `maxHeight` (default 360) tall for Gemini style analysis:
    /// {uri, width, height, seconds, bytes, exportMs}. Uploading it is the caller's job.
    AsyncFunction("makeProxy") { (ref: String, maxHeight: Double?) async throws -> [String: Any] in
      try await Analyzers.makeProxy(try await AssetSource.load(ref), maxHeight: maxHeight ?? 360)
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
      await AnalysisScheduler.shared.setPlaybackActive(active)
    }

    AsyncFunction("setFocusAsset") { (assetId: String?) async in
      await AnalysisScheduler.shared.setFocus(assetId)
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

  private func progress(part: String, ref: String) -> AnalyzerProgress {
    { [weak self] fraction in self?.sendEvent("progress", ["part": part, "ref": ref, "fraction": fraction]) }
  }

  /// Loads the asset, mapping a missing or iCloud-only source to `unavailable`, then runs `body`.
  private static func part(_ ref: String, _ version: String, _ body: (AVAsset) async -> PartResult) async -> [String: Any] {
    do {
      return await body(try await AssetSource.load(ref)).dictionary
    } catch {
      return PartResult.unavailable(version, error.localizedDescription).dictionary
    }
  }
}
