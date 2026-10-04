import AVFoundation
import Photos

/// A capability spike: does one measurement and returns its metrics. The runner
/// (`EditifyEngineModule.runSpike`) wraps it in a Sampler for the environment fields.
protocol Spike {
  func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any]
}

struct SpikeError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

enum Spikes {
  static func make(_ id: String) throws -> Spike {
    switch id {
    case "S1": return PreviewSpike()
    case "S2": return ScrubSpike()
    case "S3": return EditSpike()
    case "S6": return SourcesSpike()
    case "S10": return ProxySpike()
    case "S11": return AnalyzerSpike()
    default: throw SpikeError(message: "Spike \(id) is not built yet")
    }
  }
}

func millis(since start: ContinuousClock.Instant) -> Double {
  let elapsed = ContinuousClock.now - start
  return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
}

/// S6: do PHAsset refs work as durable sources?
/// params: local (id of an on-device clip), icloud (id of an offloaded clip, optional),
/// deleted (id of a deleted clip, optional; a made-up id exercises the same not-found path).
struct SourcesSpike: Spike {
  func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    var metrics: [String: Any] = [:]
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    metrics["authStatus"] = ["notDetermined", "restricted", "denied", "authorized", "limited"][min(status.rawValue, 4)]
    // ponytail: "detectable" means the API reports Limited distinctly; a Limited
    // selection that excludes a clip then fails like `deleted` (fetch returns nothing).
    metrics["limitedDetected"] = status != .notDetermined

    if let local = params["local"] as? String {
      let start = ContinuousClock.now
      let asset = try await AssetSource.load(local, allowNetwork: false)
      _ = try await asset.load(.duration)
      metrics["localMs"] = millis(since: start)
    }
    progress(0.33)

    let deleted = params["deleted"] as? String ?? "00000000-0000-0000-0000-000000000000/L0/001"
    do {
      _ = try await AssetSource.load(deleted, allowNetwork: false)
      metrics["deletedDetected"] = false
    } catch is AssetSource.NotFound {
      metrics["deletedDetected"] = true
    }
    progress(0.5)

    if let icloud = params["icloud"] as? String {
      let probe = try await probeICloud(icloud)
      metrics["icloudProgress"] = probe.sawProgress
      metrics["icloudCancellable"] = probe.cancelled
      metrics["icloudFirstProgressMs"] = probe.firstProgressMs
    }
    progress(1)
    return metrics
  }

  /// Confirms the clip reports in-cloud without network, then downloads with
  /// progress and cancels on the first progress tick (or after 20 s).
  private func probeICloud(_ ref: String) async throws -> (sawProgress: Bool, cancelled: Bool, firstProgressMs: Double) {
    do {
      _ = try await AssetSource.load(ref, allowNetwork: false)
      throw SpikeError(message: "icloud clip \(ref) is already on the device; pick an offloaded one")
    } catch is AssetSource.InCloud {}
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref], options: nil).firstObject else {
      throw AssetSource.NotFound(ref: ref)
    }
    let start = ContinuousClock.now
    let options = PHVideoRequestOptions()
    options.isNetworkAccessAllowed = true
    let state = ICloudProbeState()
    return await withCheckedContinuation { continuation in
      options.progressHandler = { value, _, _, _ in
        guard value > 0, state.markProgress(ms: millis(since: start)) else { return }
        PHImageManager.default().cancelImageRequest(state.requestId)
      }
      state.requestId = PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { _, _, info in
        let cancelled = (info?[PHImageCancelledKey] as? Bool) == true
        if state.finish() { continuation.resume(returning: (state.sawProgress, cancelled, state.firstProgressMs)) }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
        PHImageManager.default().cancelImageRequest(state.requestId)
      }
    }
  }
}

private final class ICloudProbeState: @unchecked Sendable {
  private let lock = NSLock()
  var requestId: PHImageRequestID = PHInvalidImageRequestID
  private(set) var sawProgress = false
  private(set) var firstProgressMs: Double = -1
  private var done = false

  /// True only for the first progress tick.
  func markProgress(ms: Double) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if sawProgress { return false }
    sawProgress = true
    firstProgressMs = ms
    return true
  }

  /// True only for the first completion, so the continuation resumes once.
  func finish() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}

/// S10: how fast does the phone make a 540p H.264 proxy? params: asset (ref).
struct ProxySpike: Spike {
  func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    guard let ref = params["asset"] as? String else { throw SpikeError(message: "S10 needs params.asset") }
    let asset = try await AssetSource.load(ref)
    let duration = try await asset.load(.duration).seconds
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset960x540) else {
      throw SpikeError(message: "960x540 preset unavailable for this asset")
    }
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("lab-proxy-\(UUID().uuidString).mp4")
    defer { try? FileManager.default.removeItem(at: output) }

    let progressTask = Task {
      for await state in session.states(updateInterval: 0.5) {
        if case .exporting(let p) = state { progress(p.fractionCompleted) }
        sampler.sample()
      }
    }
    let start = ContinuousClock.now
    try await session.export(to: output, as: .mp4)
    let seconds = millis(since: start) / 1000
    progressTask.cancel()

    let bytes = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
    return [
      "sourceSeconds": duration,
      "exportSeconds": seconds,
      "realtimeFactor": duration / max(seconds, 0.001),
      "outputMB": Double(bytes) / 1_048_576,
    ]
  }
}
