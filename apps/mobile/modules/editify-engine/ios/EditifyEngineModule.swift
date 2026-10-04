import ExpoModulesCore

/// Capability-lab entry point. Each `runSpike` call is one run: Sampler begin →
/// spike → one JSONL row, which is also returned to JS for display.
public class EditifyEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EditifyEngine")
    Events("progress")

    OnCreate {
      LabStore.recoverKilledRun()
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
  }
}
