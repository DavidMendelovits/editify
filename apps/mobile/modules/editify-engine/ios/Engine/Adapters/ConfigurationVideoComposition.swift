import AVFoundation

/// VideoComposition adapter: AVVideoComposition.Configuration (iOS 26), drawn by EditifyCompositor.
/// Lives apart from PlanBuilder so the macOS harnesses compile it next to the builder.
@available(iOS 26.0, macOS 26.0, *)
struct ConfigurationVideoComposition: VideoComposition {
  var name: String { "configuration" }

  func make(renderSize: CGSize, frameDuration: CMTime, colorPrimaries: String, colorTransferFunction: String,
            colorYCbCrMatrix: String, instructions: [EditifyInstruction]) -> AVVideoComposition {
    AVVideoComposition(configuration: AVVideoComposition.Configuration(
      colorPrimaries: colorPrimaries,
      colorTransferFunction: colorTransferFunction,
      colorYCbCrMatrix: colorYCbCrMatrix,
      customVideoCompositorClass: EditifyCompositor.self,
      frameDuration: frameDuration,
      instructions: instructions,
      renderSize: renderSize))
  }
}

/// The port as PlanBuilder holds it.
typealias PlanVideoComposition = any VideoComposition<EditifyInstruction, AVVideoComposition>

/// Builds the VideoComposition adapter AdapterSelection names, behind `#available`: a
/// `.configuration` choice the runtime can't honour gets the Mutable adapter. EngineAdapters
/// calls it once; the macOS harnesses call it with AdapterSelection.current.
enum PlanVideoCompositions {
  static func make(_ kind: AdapterSelection.Composition) -> PlanVideoComposition {
    if kind == .configuration, #available(iOS 26.0, macOS 26.0, *) { return ConfigurationVideoComposition() }
    return MutableVideoComposition()
  }
}
