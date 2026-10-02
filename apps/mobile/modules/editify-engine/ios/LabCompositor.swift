import AVFoundation
import CoreImage
import Metal

/// One visible layer in a compositor instruction: which composition track to
/// draw, its pose at the instruction's start and end (linear in between, like
/// `transform → transformEnd` in the shared schema), and an opacity ramp for dissolves.
struct LabLayer {
  let trackID: CMPersistentTrackID
  let scaleFrom: CGFloat
  let scaleTo: CGFloat
  let opacityFrom: CGFloat
  let opacityTo: CGFloat
}

final class LabInstruction: NSObject, AVVideoCompositionInstructionProtocol {
  let timeRange: CMTimeRange
  let enablePostProcessing = false
  let containsTweening = true
  let requiredSourceTrackIDs: [NSValue]?
  let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
  let layers: [LabLayer]
  /// Stand-in for a sticker/caption bitmap: composited on top of every frame.
  let overlay: CIImage?

  init(timeRange: CMTimeRange, layers: [LabLayer], overlay: CIImage?) {
    self.timeRange = timeRange
    self.layers = layers
    self.overlay = overlay
    self.requiredSourceTrackIDs = layers.map { NSNumber(value: $0.trackID) }
  }
}

/// The custom compositor every lab spike shares (and the shape the real engine
/// would keep): Core Image on a Metal-backed context, so all layer math runs on
/// the GPU and the same code serves AVPlayer preview and export.
final class LabCompositor: NSObject, AVVideoCompositing {
  private static let context: CIContext = {
    let device = MTLCreateSystemDefaultDevice()!
    return CIContext(mtlDevice: device, options: [.cacheIntermediates: false, .name: "editify.lab"])
  }()
  private let renderQueue = DispatchQueue(label: "editify.lab.compositor")
  private var renderContext: AVVideoCompositionRenderContext?

  // 10-bit in and out so HLG footage stays HDR (S1/S4 check the tags).
  let supportsHDRSourceFrames = true
  let supportsWideColorSourceFrames = true
  let sourcePixelBufferAttributes: [String: any Sendable]? = [
    kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_32BGRA],
    kCVPixelBufferMetalCompatibilityKey as String: true,
  ]
  let requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [
    kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_32BGRA],
    kCVPixelBufferMetalCompatibilityKey as String: true,
  ]

  func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {
    renderQueue.sync { renderContext = newRenderContext }
  }

  func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
    renderQueue.async { [self] in
      guard let instruction = request.videoCompositionInstruction as? LabInstruction,
            let output = renderContext?.newPixelBuffer() else {
        request.finish(with: SpikeError(message: "compositor has no instruction or output buffer"))
        return
      }
      let size = CGSize(width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
      let range = instruction.timeRange
      let t = range.duration.seconds > 0
        ? CGFloat((request.compositionTime - range.start).seconds / range.duration.seconds) : 0
      var image = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
      for layer in instruction.layers {
        guard let source = request.sourceFrame(byTrackID: layer.trackID) else { continue }
        let frame = CIImage(cvPixelBuffer: source)
        // Scale-to-cover around the centre, then the animated punch-in on top.
        let cover = max(size.width / frame.extent.width, size.height / frame.extent.height)
        let scale = cover * (layer.scaleFrom + (layer.scaleTo - layer.scaleFrom) * t)
        let scaled = frame.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let placed = scaled.transformed(by: CGAffineTransform(
          translationX: (size.width - scaled.extent.width) / 2 - scaled.extent.minX,
          y: (size.height - scaled.extent.height) / 2 - scaled.extent.minY))
        let opacity = layer.opacityFrom + (layer.opacityTo - layer.opacityFrom) * t
        let layerImage = opacity >= 1 ? placed : placed.applyingFilter("CIColorMatrix", parameters: [
          "inputAVector": CIVector(x: 0, y: 0, z: 0, w: opacity),
        ])
        image = layerImage.composited(over: image)
      }
      if let overlay = instruction.overlay { image = overlay.composited(over: image) }
      LabCompositor.context.render(image.cropped(to: CGRect(origin: .zero, size: size)), to: output)
      request.finish(withComposedVideoFrame: output)
    }
  }

  func cancelAllPendingVideoCompositionRequests() {
    renderQueue.sync {}
  }
}
