import AVFoundation
import CoreImage
import UniformTypeIdentifiers

/// S11: the P2 analyzers on the phone. params: asset (video ref), memo (optional ref; words
/// and laughter then run on the memo, sync aligns it against the video).
///
/// variants:
///   pipeline   decode ▶ sync ▶ words ▶ laughter ▶ energy ▶ faces, in scheduler order, each timed
///   sync | words | laughter | energy | faces   one analyzer alone (its memPeakMB is that analyzer's)
///   scheduler  the 8A scheduler end to end: playback pauses the heavy lane, then everything finishes
///   crop       renders frames through LabCompositor with an off-centre static crop into Documents/lab (OV8)
///
/// Without a memo, sync aligns the clip against a 60 s excerpt of its own audio
/// cut at 30 s, so the right answer is known (lag 30 s) and `syncLagErrorMs` is real.
struct AnalyzerSpike: Spike {
  func run(variant: String, params: [String: Any], sampler: Sampler, progress: @escaping (Double) -> Void) async throws -> [String: Any] {
    guard let ref = params["asset"] as? String else { throw SpikeError(message: "S11 needs params.asset") }
    let memoRef = params["memo"] as? String
    let asset = try await AssetSource.load(ref)
    // Words and laughter listen to the memo when there is one, as the stand-up pipeline does.
    let speech = memoRef != nil ? try await AssetSource.load(memoRef!) : asset
    let sourceSeconds = try await asset.load(.duration).seconds
    var metrics: [String: Any] = ["sourceSeconds": sourceSeconds]
    let report: AnalyzerProgress = { fraction in progress(fraction); sampler.sample() }

    func stage(_ name: String, _ body: () async throws -> Void) async rethrows {
      let start = ContinuousClock.now
      try await body()
      metrics["\(name)Ms"] = millis(since: start)
      sampler.sample()
    }

    switch variant {
    case "pipeline", "sync", "words", "laughter", "energy", "faces":
      let all = variant == "pipeline"
      var video: [Float] = []
      if all || variant == "sync" || variant == "energy" {
        try await stage("decode") { video = try await Analyzers.decodeMono(asset) }
      }
      if all || variant == "sync" { try await stage("sync") { try await syncStage(video: video, memoRef: memoRef, metrics: &metrics) } }
      if all || variant == "words" {
        // Not ready (model missing, offline) is a result, recorded as wordsReady = false.
        await stage("words") {
          let result = await Analyzers.words(speech, progress: report)
          metrics["wordsReady"] = result.status == "ready"
          metrics["wordCount"] = ((result.data?["words"] as? [Any])?.count ?? 0)
          metrics["segmentCount"] = ((result.data?["segments"] as? [Any])?.count ?? 0)
        }
      }
      if all || variant == "laughter" {
        await stage("laughter") {
          let result = await Analyzers.laughter(speech, progress: report)
          metrics["laughterReady"] = result.status == "ready"
          metrics["laughterSpans"] = ((result.data?["spans"] as? [Any])?.count ?? 0)
        }
      }
      if all || variant == "energy" {
        await stage("energy") {
          let result = Analyzers.energy(samples: video)
          metrics["energyCells"] = ((result.data?["rmsDb"] as? [Double])?.count ?? 0)
          metrics["onsetPeaks"] = ((result.data?["onsetPeaks"] as? [Double])?.count ?? 0)
        }
      }
      if all || variant == "faces" {
        await stage("faces") {
          let result = await Analyzers.faces(asset, progress: report)
          let samples = result.data?["samples"] as? [[Any]] ?? []
          metrics["facesReady"] = result.status == "ready"
          metrics["faceSamples"] = samples.count
          metrics["faceHits"] = samples.filter { !($0.last is NSNull) }.count
        }
      }
      let total = ["decode", "sync", "words", "laughter", "energy", "faces"].compactMap { metrics["\($0)Ms"] as? Double }.reduce(0, +)
      metrics["totalMs"] = total
      metrics["readyRealtimeFactor"] = sourceSeconds / max(total / 1000, 0.001)
    case "scheduler":
      try await schedulerStage(ref: ref, sampler: sampler, progress: progress, metrics: &metrics)
    case "crop":
      try await cropFrames(asset: asset, metrics: &metrics)
    default:
      throw SpikeError(message: "S11 has no variant \(variant)")
    }
    progress(1)
    return metrics
  }

  private func syncStage(video: [Float], memoRef: String?, metrics: inout [String: Any]) async throws {
    let memo: [Float]
    var expectedLag: Double?
    if let memoRef {
      memo = try await Analyzers.decodeMono(try await AssetSource.load(memoRef))
    } else {
      let rate = AudioSync.sampleRate
      guard video.count > 90 * rate else { throw SpikeError(message: "sync self-check needs a clip over 90 s, or pick a memo") }
      memo = Array(video[(30 * rate)..<(90 * rate)])
      expectedLag = 30
    }
    let result = Analyzers.sync(video: video, memo: memo)
    guard let measurement = result.data else { throw SpikeError(message: "sync \(result.status): \(result.error ?? "")") }
    metrics["syncConfident"] = measurement["confident"] as? Bool ?? false
    metrics["syncLag"] = measurement["lag"] as? Double ?? 0
    metrics["syncCoarseRatio"] = min(1e6, measurement["coarseRatio"] as? Double ?? 0)
    if let expectedLag, let lag = measurement["lag"] as? Double { metrics["syncLagErrorMs"] = abs(lag - expectedLag) * 1000 }
  }

  /// Queues every part, holds playback for 3 s once a heavy part is running,
  /// and checks the heavy lane did not advance meanwhile.
  private func schedulerStage(ref: String, sampler: Sampler, progress: @escaping (Double) -> Void, metrics: inout [String: Any]) async throws {
    let scheduler = AnalysisScheduler.shared
    let id = "lab-s11-\(UUID().uuidString)"
    let start = ContinuousClock.now
    await scheduler.analyze(assetId: id, ref: ref, parts: nil, options: .init(), force: true)
    defer { Task { await scheduler.cancel(assetId: id) } }

    func statuses() async -> [String: String] {
      let parts = await scheduler.analysis(assetId: id)["parts"] as? [String: [String: Any]] ?? [:]
      return parts.mapValues { $0["status"] as? String ?? "?" }
    }
    // Wait for a heavy part to make some progress, then "play" for 3 s.
    while await scheduler.heavyFraction < 0.05, millis(since: start) < 120_000 {
      if (await statuses()).values.allSatisfy({ $0 != "pending" }) { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    await scheduler.setPlaybackActive(true)
    try await Task.sleep(for: .milliseconds(600))
    let before = await scheduler.heavyFraction
    try await Task.sleep(for: .seconds(3))
    let after = await scheduler.heavyFraction
    await scheduler.setPlaybackActive(false)
    metrics["heavyAdvancedWhilePaused"] = after - before
    metrics["pauseHeld"] = after - before < 0.02

    while millis(since: start) < 900_000 {
      let current = await statuses()
      let done = current.values.filter { $0 != "pending" }.count
      progress(Double(done) / Double(max(1, current.count)))
      sampler.sample()
      if done == current.count { break }
      try await Task.sleep(for: .milliseconds(250))
    }
    let final = await statuses()
    metrics["totalMs"] = millis(since: start)
    metrics["partsReady"] = final.values.filter { $0 == "ready" }.count
    metrics["partsUnavailable"] = final.values.filter { $0 == "unavailable" }.count
    metrics["partsFailed"] = final.values.filter { $0 == "failed" }.count
  }

  /// One frame centred, one framed off-centre: the second should show the
  /// source's top-right region, upright, at 1080x1920.
  private func cropFrames(asset: AVAsset, metrics: inout [String: Any]) async throws {
    var written = 0
    for (name, crop) in [("centre", LayerCrop()), ("topright", LayerCrop(scale: 1.6, x: 1, y: -1))] {
      var timeline = LabTimeline()
      timeline.overlay = false
      timeline.punchIn = 1
      timeline.crop = crop
      let (composition, video) = try await CompositionBuilder.build(asset: asset, timeline: timeline)
      let generator = AVAssetImageGenerator(asset: composition)
      generator.videoComposition = video
      let (image, _) = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600))
      let url = LabStore.directory.appendingPathComponent("crop-\(name).png")
      guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { continue }
      CGImageDestinationAddImage(destination, image, nil)
      if CGImageDestinationFinalize(destination) { written += 1 }
      metrics["\(name)Width"] = image.width
      metrics["\(name)Height"] = image.height
    }
    metrics["framesWritten"] = written
  }
}
