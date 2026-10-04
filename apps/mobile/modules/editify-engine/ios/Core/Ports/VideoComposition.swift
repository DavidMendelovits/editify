import CoreGraphics
import CoreMedia

/// Makes the video composition a built plan plays and exports: the plan compositor drawing
/// `instructions` at `renderSize`, one frame per `frameDuration`, tagged with the plan's
/// output colour. `Instruction` and `Output` are the adapter set's types (EditifyInstruction
/// and AVVideoComposition today).
public protocol VideoComposition<Instruction, Output>: PortAdapter {
  associatedtype Instruction
  associatedtype Output
  func make(renderSize: CGSize, frameDuration: CMTime, colorPrimaries: String, colorTransferFunction: String,
            colorYCbCrMatrix: String, instructions: [Instruction]) -> Output
}
