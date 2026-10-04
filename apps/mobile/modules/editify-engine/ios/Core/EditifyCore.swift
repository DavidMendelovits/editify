import Foundation

// EditifyCore: the engine's domain and its ports (decisions D1, D4).
//
//            driving                         EditifyCore (this pod)                        driven ports
//  ┌───────────────────────┐   ┌──────────────────────────────────────────────┐
//  │ EditifyEngineModule   │──▶│ domain: RenderPlan, caption layout, overlay  │──▶ MediaSource      AudioDecoder
//  │ EditifyPlayerView     │   │   graphics, loudness + sync DSP,             │──▶ Transcriber      SoundClassifier
//  │ lab spikes            │   │   AnalysisMath, AnalysisPolicy, export       │──▶ FaceDetector     Proxy
//  │ (EditifyEngine pod)   │   │   types, media store, preview files          │──▶ VideoComposition VideoExport
//  └───────────────────────┘   │ ports: the protocols in Ports/               │──▶ Playback         PhotoLibrary
//                              └──────────────────────────────────────────────┘──▶ BackgroundExecution DeviceProfile
//                                                    ▲
//            EditifyEngine pod: the adapters (AVFoundation, Speech, SoundAnalysis, Vision, Photos,
//            BackgroundTasks, UIKit, Metal, VideoToolbox) and EngineAdapters, the composition root
//            that picks one adapter per port.
//
// Core imports only Foundation, CoreMedia, CoreGraphics, CoreText, CoreImage, ImageIO,
// Accelerate, CryptoKit and Darwin (scripts/check-core-imports.mjs enforces it in CI). A port
// whose operation needs a platform object (an AVAsset, an AVVideoComposition) names it as an
// associated type, so the protocol stays here and the type stays in the adapter.

/// Every adapter says which implementation it is (what `capabilities()` will report, D5).
public protocol PortAdapter: Sendable {
  var name: String { get }
}
