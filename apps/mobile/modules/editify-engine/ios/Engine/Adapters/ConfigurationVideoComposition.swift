import AVFoundation

/// VideoComposition adapter: AVVideoComposition.Configuration (iOS 26), drawn by EditifyCompositor.
/// Lives apart from PlanBuilder so the macOS harnesses compile it next to the builder.
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
