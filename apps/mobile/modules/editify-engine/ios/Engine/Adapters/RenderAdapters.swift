import AVFoundation

/// VideoExport adapter: PlanExporter (AVAssetReader + AVAssetWriter), building with the
/// composition root's VideoComposition adapter.
struct WriterVideoExport: VideoExport {
  let composition: PlanVideoComposition
  var name: String { "writer" }

  func export(_ plan: RenderPlan, resolver: PlanAssetResolver, to output: URL, options: PlanExportOptions, control: PlanExportControl,
              extraCopies: Int, progress: @escaping @Sendable (PlanExportPhase, Double) -> Void) async throws -> PlanExportStats {
    let build = PlanBuildOptions(videoComposition: composition)
    return try await PlanExporter.export(plan, resolver: resolver, to: output, options: options, build: build, control: control,
                                         extraCopies: extraCopies, progress: progress)
  }
}

/// Playback adapter: PlanPlayer (AVPlayer + EditifyCompositor), building with the composition
/// root's VideoComposition adapter.
struct PlanPlayerPlayback: Playback {
  let composition: PlanVideoComposition
  var name: String { "avplayer" }

  @MainActor func makePlayer(resolver: @escaping ([String: String]) -> PlanAssetResolver) -> PlanPlayer {
    PlanPlayer(resolver: resolver, videoComposition: composition)
  }
}
