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
/// root's VideoComposition adapter, at most the RAM tier's preview size (TierCaps, D25).
struct PlanPlayerPlayback: Playback {
  let composition: PlanVideoComposition
  var caps = TierCaps.of(.full)
  var name: String { "avplayer" }

  @MainActor func makePlayer(resolver: @escaping ([String: String]) -> PlanAssetResolver) -> PlanPlayer {
    let player = PlanPlayer(resolver: resolver, videoComposition: composition)
    player.renderCap = (short: CGFloat(caps.previewMaxShortSide), long: CGFloat(caps.previewMaxLongSide))
    return player
  }
}
