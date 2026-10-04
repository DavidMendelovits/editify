import AVFoundation

/// VideoComposition adapter for iOS 18 (decision D22): an AVMutableVideoComposition carrying
/// exactly what ConfigurationVideoComposition passes to AVVideoComposition.Configuration (the
/// compositor class, frame duration, instructions, render size and all three colour tags), then
/// frozen into an immutable copy. Golden parity with the Configuration adapter is held by
/// server/test/render-golden.test.ts (both sets rendered, frames compared byte for byte).
struct MutableVideoComposition: VideoComposition {
  var name: String { "mutable" }

  func make(renderSize: CGSize, frameDuration: CMTime, colorPrimaries: String, colorTransferFunction: String,
            colorYCbCrMatrix: String, instructions: [EditifyInstruction]) -> AVVideoComposition {
    let composition = AVMutableVideoComposition()
    composition.customVideoCompositorClass = EditifyCompositor.self
    composition.frameDuration = frameDuration
    composition.renderSize = renderSize
    composition.instructions = instructions
    composition.colorPrimaries = colorPrimaries
    composition.colorTransferFunction = colorTransferFunction
    composition.colorYCbCrMatrix = colorYCbCrMatrix
    return composition.copy() as! AVVideoComposition
  }
}
