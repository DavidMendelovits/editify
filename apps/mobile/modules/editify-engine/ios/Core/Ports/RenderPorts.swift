import Foundation

// The render ports. `Resolver` maps a plan's asset refs to media (PlanAssetResolver today).

/// Renders a decoded plan to a file.
public protocol VideoExport<Resolver>: PortAdapter {
  associatedtype Resolver
  func export(_ plan: RenderPlan, resolver: Resolver, to output: URL, options: PlanExportOptions, control: PlanExportControl,
              extraCopies: Int, progress: @escaping @Sendable (PlanExportPhase, Double) -> Void) async throws -> PlanExportStats
}

/// Makes the native preview's player.
public protocol Playback<Player, Resolver>: PortAdapter {
  associatedtype Player: AnyObject
  associatedtype Resolver
  @MainActor func makePlayer(resolver: @escaping ([String: String]) -> Resolver) -> Player
}
