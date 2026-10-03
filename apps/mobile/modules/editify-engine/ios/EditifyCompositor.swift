import AVFoundation
import CoreImage
import Metal

/// Everything one built plan needs at draw time, shared by all of its
/// instructions: the plan, the media cache GIF frames decode through, the
/// caption renderer and the render size. Immutable after PlanBuilder makes it,
/// apart from the caches (shared with the player across rebuilds).
final class PlanRenderState: @unchecked Sendable {
  let plan: RenderPlan
  /// Output pixels per plan pixel (1 for export; view.w / plan.w for a preview at another size).
  let scale: CGFloat
  let renderSize: CGSize
  let media: PlanMediaCache
  let captions: CaptionRenderer
  let background: CIImage

  init(plan: RenderPlan, scale: CGFloat, renderSize: CGSize, media: PlanMediaCache, captions: CaptionRenderer) {
    self.plan = plan
    self.scale = scale
    self.renderSize = renderSize
    self.media = media
    self.captions = captions
    let rect = CGRect(origin: .zero, size: renderSize)
    let color = plan.background
    self.background = CIImage(color: CIColor(red: color.red, green: color.green, blue: color.blue, alpha: 1, colorSpace: PlanColorPipeline.sRGB)!)
      .cropped(to: rect)
  }

  /// Timeline seconds for a composition time, snapped onto the frame grid when
  /// it is within a millisecond-of-a-frame of it (CMTime arithmetic can land a
  /// hair off k / fps; plan times are exact).
  func timelineSeconds(_ time: CMTime) -> Double {
    let seconds = time.seconds
    let fps = Double(plan.fps)
    let frame = (seconds * fps).rounded()
    return abs(seconds * fps - frame) < 1e-3 ? frame / fps : seconds
  }
}

/// A plan video layer resolved for drawing: its picture source and its key
/// arrays unpacked once (a per-frame zoom can carry thousands of keys).
struct ResolvedLayer {
  enum Source {
    /// A composition video track and the EXIF orientation that turns its stored frames upright.
    case track(CMPersistentTrackID, CGImagePropertyOrientation)
    /// Decoded at draw time through the plan's media cache, longest side at most `longSide`.
    case still(URL, longSide: Int)
  }

  let source: Source
  let z: Int
  let cropTimes: [Double]
  let cropScale: [Double]
  let cropX: [Double]
  let cropY: [Double]
  let opacityTimes: [Double]
  let opacityValues: [Double]
  let dimTimes: [Double]
  let dimValues: [Double]

  init(layer: RenderPlan.Layer, source: Source) {
    self.source = source
    self.z = layer.z
    cropTimes = layer.cropKeys.map(\.t)
    cropScale = layer.cropKeys.map(\.scale)
    cropX = layer.cropKeys.map(\.x)
    cropY = layer.cropKeys.map(\.y)
    opacityTimes = layer.opacityKeys.map(\.t)
    opacityValues = layer.opacityKeys.map(\.value)
    dimTimes = layer.dimKeys.map(\.t)
    dimValues = layer.dimKeys.map(\.value)
  }
}

struct ResolvedOverlay {
  enum Content {
    /// Decoded at draw time through the plan's media cache, longest side at most `longSide`.
    case still(URL, longSide: Int)
    /// Frames decode lazily, their longest side at most `longSide`.
    case gif(PlanGif, longSide: Int)
    case broll(CMPersistentTrackID, CGImagePropertyOrientation)
    case drawn(OverlayGraphics.Drawn)
  }

  let overlay: RenderPlan.Overlay
  let content: Content
}

/// One plan segment: exactly one AVVideoCompositionInstruction (2A).
final class EditifyInstruction: NSObject, AVVideoCompositionInstructionProtocol, @unchecked Sendable {
  let timeRange: CMTimeRange
  let enablePostProcessing = false
  let containsTweening = true
  let requiredSourceTrackIDs: [NSValue]?
  let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
  let segmentIndex: Int
  /// Bottom to top by z.
  let layers: [ResolvedLayer]
  /// Overlays that intersect the segment, bottom to top by z.
  let overlays: [ResolvedOverlay]
  /// Captions that intersect the segment, in ascending lane order.
  let captions: [RenderPlan.Caption]
  let state: PlanRenderState

  init(timeRange: CMTimeRange, segmentIndex: Int, layers: [ResolvedLayer], overlays: [ResolvedOverlay],
       captions: [RenderPlan.Caption], state: PlanRenderState) {
    self.timeRange = timeRange
    self.segmentIndex = segmentIndex
    self.layers = layers.sorted { $0.z < $1.z }
    self.overlays = overlays.sorted { $0.overlay.z < $1.overlay.z }
    self.captions = captions.sorted { ($0.lane, $0.start) < ($1.lane, $1.start) }
    self.state = state
    var tracks: [CMPersistentTrackID] = []
    for layer in layers { if case .track(let id, _) = layer.source, !tracks.contains(id) { tracks.append(id) } }
    for item in overlays { if case .broll(let id, _) = item.content, !tracks.contains(id) { tracks.append(id) } }
    self.requiredSourceTrackIDs = tracks.map { NSNumber(value: $0) }
  }
}

/// The colour pipeline (4A + OV6).
///
/// Working space: Core Image's extended linear BT.2020 (RGBA half float).
/// Core Image converts every input into it from the input's own tags, and on
/// iOS 18+ / macOS 15+ its scale is already BT.2408's: linear 1.0 is the
/// 203-nit reference white. Measured (parity harness): HLG signal 0.75 decodes
/// to 1.0, PQ 203 cd/m2 to 1.0, HLG peak to 4.926 (1000 / 203); sRGB and
/// BT.709 white to 1.0. So SDR video, graphics (sRGB) and HDR video all meet
/// at reference white with no extra gain, and opacity, crossfades and dims
/// (CIColorMatrix, source-over) happen in linear light.
///
/// Encode: `hlg` renders into ITU-R BT.2100 HLG (1.0 encodes to signal 0.75;
/// values above the HLG peak clip). `sdr` renders into ITU-R BT.709; HDR
/// sources (HLG or PQ transfer on the decoded frame) are first tone mapped
/// per channel by `sdrToneMap`, before blending, so SDR clips and graphics
/// are untouched and reference white stays near SDR white.
enum PlanColorPipeline {
  static let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
  static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
  static let pq = CGColorSpace(name: CGColorSpace.itur_2100_PQ)!
  /// The space Core Image (and every Apple player) decodes a buffer with these
  /// tags in. Encoding with exactly that space keeps encode and decode
  /// symmetric: CGColorSpace.itur_709 uses the camera OETF, while 709-tagged
  /// video decodes with Core Media's display curve, so rendering through
  /// itur_709 would lift every SDR mid-tone (0.18 came back as 0.25).
  static let hlg = taggedSpace(.hlg)
  static let bt709 = taggedSpace(.sdr)

  static func outputSpace(_ color: RenderPlan.OutputColor) -> CGColorSpace { color == .hlg ? hlg : bt709 }

  private static func taggedSpace(_ color: RenderPlan.OutputColor) -> CGColorSpace {
    let tags = tags(color)
    let attachments = [
      kCVImageBufferColorPrimariesKey: tags.primaries, kCVImageBufferTransferFunctionKey: tags.transfer, kCVImageBufferYCbCrMatrixKey: tags.matrix,
    ] as CFDictionary
    if let space = CVImageBufferCreateColorSpaceFromAttachments(attachments)?.takeRetainedValue() { return space }
    return CGColorSpace(name: color == .hlg ? CGColorSpace.itur_2100_HLG : CGColorSpace.itur_709)!
  }

  /// Tags for the video composition and every output frame.
  static func tags(_ color: RenderPlan.OutputColor) -> (primaries: String, transfer: String, matrix: String) {
    switch color {
    case .hlg:
      return (AVVideoColorPrimaries_ITU_R_2020, AVVideoTransferFunction_ITU_R_2100_HLG, AVVideoYCbCrMatrix_ITU_R_2020)
    case .sdr:
      return (AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrix_ITU_R_709_2)
    }
  }

  /// Linear values at or under the knee pass through; above it a Reinhard
  /// shoulder approaches 1.0: y = k + (1 - k) * e / ((1 - k) + e), e = v - k.
  /// Reference white (1.0) lands at 0.9, the HLG peak (4.926) at 0.99.
  static let sdrKnee = 0.8

  static func sdrCurve(_ value: Double) -> Double {
    guard value > sdrKnee else { return value }
    let shoulder = 1 - sdrKnee
    let excess = value - sdrKnee
    return sdrKnee + shoulder * excess / (shoulder + excess)
  }

  /// `sdrCurve` as a Core Image 1D LUT (CIColorCurves) sampled uniformly in
  /// PQ, which spans 0 to 10000 cd/m2 with even perceptual steps. Core Image's
  /// own HDR-to-SDR filters (CIToneMapHeadroom, CISystemToneMap) scale the
  /// whole range so reference white lands near 0.5 linear, which would leave
  /// HDR clips visibly darker than SDR clips beside them; this curve keeps
  /// everything under the knee exact.
  static let sdrToneMapCurve: Data = {
    let m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875
    // Core Image's PQ decode puts 203 cd/m2 at 1.0 (see above).
    let decode = { (signal: Double) -> Double in
      let e = pow(signal, 1 / m2)
      return pow(max(e - c1, 0) / (c2 - c3 * e), 1 / m1) * 10000 / 203
    }
    let encode = { (value: Double) -> Double in
      let x = pow(max(value, 0) * 203 / 10000, m1)
      return pow((c1 + c2 * x) / (1 + c3 * x), m2)
    }
    let count = 4096
    var samples: [Float] = []
    samples.reserveCapacity(count * 3)
    for index in 0..<count {
      let mapped = Float(encode(sdrCurve(decode(Double(index) / Double(count - 1)))))
      samples += [mapped, mapped, mapped]
    }
    return samples.withUnsafeBufferPointer { Data(buffer: $0) }
  }()

  static func toneMapToSDR(_ image: CIImage) -> CIImage {
    image.applyingFilter("CIColorCurves", parameters: [
      "inputCurvesData": sdrToneMapCurve,
      "inputCurvesDomain": CIVector(x: 0, y: 1),
      "inputColorSpace": pq,
    ])
  }

  /// True when the frame's transfer function is HLG or PQ.
  static func isHDR(_ buffer: CVPixelBuffer) -> Bool {
    guard let transfer = CVBufferCopyAttachment(buffer, kCVImageBufferTransferFunctionKey, nil) as? String else { return false }
    return transfer == (kCVImageBufferTransferFunction_ITU_R_2100_HLG as String)
      || transfer == (kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ as String)
  }

  /// A decoded source frame in the working space, tone mapped first when the output is SDR.
  static func source(_ buffer: CVPixelBuffer, output: RenderPlan.OutputColor) -> CIImage {
    let image = CIImage(cvPixelBuffer: buffer)
    return output == .sdr && isHDR(buffer) ? toneMapToSDR(image) : image
  }

  /// The finished composite, ready to render into the output buffer. For an
  /// SDR output it is re-declared as plain working-space data: when a graph
  /// that read an HDR (HLG/PQ) pixel buffer renders into an SDR destination,
  /// Core Image tone maps the WHOLE frame on its own (measured: an untouched
  /// SDR white came out at 0.53 encoded), even after the HDR source was
  /// tone mapped here and its headroom set to 1. matchedToWorkingSpace cuts
  /// that provenance; values are unchanged (the working space maps to itself).
  static func forOutput(_ image: CIImage, _ color: RenderPlan.OutputColor) -> CIImage {
    color == .sdr ? (image.matchedToWorkingSpace(from: workingSpace) ?? image) : image
  }

  static func tag(_ buffer: CVPixelBuffer, _ color: RenderPlan.OutputColor) {
    let tags = tags(color)
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, tags.primaries as CFString, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, tags.transfer as CFString, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, tags.matrix as CFString, .shouldPropagate)
  }
}

/// Draws one output frame of a plan: background, the segment's layers by z,
/// overlays by z, captions by lane. Pure Core Image; the AVFoundation glue is EditifyCompositor.
enum FrameRenderer {
  // swiftlint:disable:next function_body_length
  static func compose(_ instruction: EditifyInstruction, at t: Double, sourceFrame: (CMPersistentTrackID) -> CVPixelBuffer?) throws -> CIImage {
    let state = instruction.state
    let plan = state.plan
    let scale = state.scale
    let rect = CGRect(origin: .zero, size: state.renderSize)
    var image = state.background

    for layer in instruction.layers {
      let upright: CIImage
      switch layer.source {
      case .track(let id, let orientation):
        guard let buffer = sourceFrame(id) else { continue }
        upright = PlanColorPipeline.source(buffer, output: plan.color).oriented(orientation)
      case .still(let url, let longSide):
        upright = try state.media.image(url, longSide: longSide)
      }
      let frame = upright.transformed(by: CGAffineTransform(translationX: -upright.extent.minX, y: -upright.extent.minY))
      let zoom = PlanKeys.value(at: t, times: layer.cropTimes, values: layer.cropScale, empty: 1)
      let panX = PlanKeys.value(at: t, times: layer.cropTimes, values: layer.cropX, empty: 0)
      let panY = PlanKeys.value(at: t, times: layer.cropTimes, values: layer.cropY, empty: 0)
      let placement = AnalysisMath.cropPlacement(source: frame.extent.size, render: rect.size,
                                                 scale: CGFloat(max(1, zoom)), x: CGFloat(panX), y: CGFloat(panY))
      // Clamp first so the cover-fit edges stay opaque after resampling.
      var placed = frame.clampedToExtent().transformed(by: placement).cropped(to: rect)
      let dim = PlanKeys.value(at: t, times: layer.dimTimes, values: layer.dimValues, empty: 0)
      if dim > 0 {
        let keep = CGFloat(1 - dim)
        placed = placed.applyingFilter("CIColorMatrix", parameters: [
          "inputRVector": CIVector(x: keep, y: 0, z: 0, w: 0),
          "inputGVector": CIVector(x: 0, y: keep, z: 0, w: 0),
          "inputBVector": CIVector(x: 0, y: 0, z: keep, w: 0),
        ])
      }
      let opacity = PlanKeys.value(at: t, times: layer.opacityTimes, values: layer.opacityValues, empty: 1)
      if opacity <= 0 { continue }
      if opacity < 1 {
        placed = placed.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(opacity))])
      }
      image = placed.composited(over: image)
    }

    for item in instruction.overlays where visible(item.overlay.start, item.overlay.end, at: t) {
      let box = item.overlay.box
      let boxWidth = CGFloat(box.w) * scale
      let boxHeight = CGFloat(box.h) * scale
      // Content in box-local Core Image space: the unrotated box spans (0, 0) to (w, h), y up.
      var content: CIImage
      switch item.content {
      case .still(let url, let longSide):
        content = stretch(try state.media.image(url, longSide: longSide), to: CGSize(width: boxWidth, height: boxHeight))
      case .gif(let gif, let longSide):
        guard let media = item.overlay.media else { continue }
        let time = media.srcStart + (t - item.overlay.start) * media.speed
        let frame = try state.media.image(gif.url, index: gif.frameIndex(at: time, loop: media.loop ?? false), longSide: longSide)
        content = stretch(frame, to: CGSize(width: boxWidth, height: boxHeight))
      case .broll(let id, let orientation):
        guard let buffer = sourceFrame(id) else { continue }
        content = stretch(PlanColorPipeline.source(buffer, output: plan.color).oriented(orientation), to: CGSize(width: boxWidth, height: boxHeight))
      case .drawn(let drawn):
        let margin = drawn.margin * scale
        let pixelHeight = CGFloat(drawn.image.height)
        content = CIImage(cgImage: drawn.image)
          .transformed(by: CGAffineTransform(translationX: -margin, y: -(pixelHeight - margin - boxHeight)))
      }
      // Turn clockwise (on screen, y down) about the box centre, then move the centre to (x, y).
      let radians = CGFloat(box.rotationDeg) * .pi / 180
      let place = CGAffineTransform(translationX: -boxWidth / 2, y: -boxHeight / 2)
        .concatenating(CGAffineTransform(rotationAngle: -radians))
        .concatenating(CGAffineTransform(translationX: CGFloat(box.x) * scale, y: rect.height - CGFloat(box.y) * scale))
      content = content.transformed(by: place)
      image = content.composited(over: image)
    }

    for caption in instruction.captions where visible(caption.start, caption.end, at: t) {
      guard let bitmap = try state.captions.bitmap(caption, at: t, scale: scale) else { continue }
      let placed = bitmap.ciImage
        .transformed(by: CGAffineTransform(translationX: bitmap.originX, y: rect.height - bitmap.originY - CGFloat(bitmap.image.height)))
      image = placed.composited(over: image)
    }

    return image.cropped(to: rect)
  }

  /// [start, end): on at start, off at end (schema: TIME AND FRAMES).
  static func visible(_ start: Double, _ end: Double, at t: Double) -> Bool {
    t >= start - RenderPlan.epsilon && t < end - RenderPlan.epsilon
  }

  /// Stretched to fill the box exactly (the builder sized the box from the media's upright aspect).
  static func stretch(_ image: CIImage, to size: CGSize) -> CIImage {
    let extent = image.extent
    guard extent.width > 0, extent.height > 0 else { return image }
    return image
      .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
      .transformed(by: CGAffineTransform(scaleX: size.width / extent.width, y: size.height / extent.height))
  }
}

/// The custom compositor for preview and export alike (AVPlayerItem and
/// AVAssetReaderVideoCompositionOutput both run it): Core Image on Metal,
/// 10-bit in and out so HLG stays HDR.
final class EditifyCompositor: NSObject, AVVideoCompositing {
  /// One context for every compositor instance. Metal when there is a GPU;
  /// Core Image's CPU renderer otherwise (CI virtual machines).
  static let context: CIContext = {
    var options: [CIContextOption: Any] = [
      .workingColorSpace: PlanColorPipeline.workingSpace,
      .workingFormat: CIFormat.RGBAh,
      .cacheIntermediates: false,
      .name: "editify.compositor",
    ]
    if let device = MTLCreateSystemDefaultDevice() { return CIContext(mtlDevice: device, options: options) }
    options[.useSoftwareRenderer] = true
    return CIContext(options: options)
  }()

  private let renderQueue = DispatchQueue(label: "editify.compositor")
  /// Read and written only on renderQueue.
  nonisolated(unsafe) private var renderContext: AVVideoCompositionRenderContext?
  /// Bumped by cancelAllPendingVideoCompositionRequests: a request queued
  /// under an older generation finishes cancelled instead of rendering (a
  /// seek or a rebuild drops the backlog at once, as in Apple's AVCustomEdit).
  nonisolated(unsafe) private var generation = 0  // under generationLock
  private let generationLock = NSLock()

  let supportsHDRSourceFrames = true
  let supportsWideColorSourceFrames = true
  /// Source frames arrive in their own colour, untouched: PlanColorPipeline
  /// converts each one into the working space itself. Without this, the
  /// composition engine conforms every source to the composition's colour
  /// space first (an SDR clip in an HLG plan arrives re-tagged HLG with SDR
  /// code values, an HLG clip in an SDR plan arrives tone mapped by VideoToolbox).
  let canConformColorOfSourceFrames = true
  /// Every format the decoders hand out natively, so no source is converted
  /// (a source in an unlisted format is converted AND conformed by the engine).
  let sourcePixelBufferAttributes: [String: any Sendable]? = [
    kCVPixelBufferPixelFormatTypeKey as String: [
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr10BiPlanarFullRange,
      kCVPixelFormatType_422YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_422YpCbCr10BiPlanarFullRange,
      kCVPixelFormatType_444YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_422YpCbCr16,
      kCVPixelFormatType_4444AYpCbCr16, kCVPixelFormatType_32BGRA, kCVPixelFormatType_64RGBAHalf,
    ],
    kCVPixelBufferMetalCompatibilityKey as String: true,
  ]
  let requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [
    // 10-bit first so HLG keeps its depth; 8-bit 4:2:0 for SDR writers and players.
    kCVPixelBufferPixelFormatTypeKey as String: [
      kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, kCVPixelFormatType_32BGRA,
    ],
    kCVPixelBufferMetalCompatibilityKey as String: true,
  ]

  private var currentGeneration: Int {
    generationLock.lock(); defer { generationLock.unlock() }
    return generation
  }

  func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {
    renderQueue.sync { renderContext = newRenderContext }
  }

  func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
    let queuedAt = currentGeneration
    renderQueue.async { [self] in
      if queuedAt != currentGeneration {
        request.finishCancelledRequest()
        return
      }
      guard let instruction = request.videoCompositionInstruction as? EditifyInstruction,
            let output = renderContext?.newPixelBuffer() else {
        request.finish(with: PlanBuildError.compositor("no plan instruction or output buffer"))
        return
      }
      do {
        let timed = CompositorTiming.isOn ? DispatchTime.now().uptimeNanoseconds : 0
        let state = instruction.state
        let t = state.timelineSeconds(request.compositionTime)
        let image = try FrameRenderer.compose(instruction, at: t) { request.sourceFrame(byTrackID: $0) }
        PlanColorPipeline.tag(output, state.plan.color)
        let bounds = CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
        // A render task, waited on, so a failed render (the GPU refused, say, with the app
        // in the background) fails the request instead of handing on an unwritten buffer.
        let destination = CIRenderDestination(pixelBuffer: output)
        destination.colorSpace = PlanColorPipeline.outputSpace(state.plan.color)
        let task = try Self.context.startTask(toRender: PlanColorPipeline.forOutput(image, state.plan.color), from: bounds, to: destination, at: .zero)
        _ = try task.waitUntilCompleted()
        if timed != 0 { CompositorTiming.record(Double(DispatchTime.now().uptimeNanoseconds - timed) / 1e6) }
        request.finish(withComposedVideoFrame: output)
      } catch {
        request.finish(with: error)
      }
    }
  }

  func cancelAllPendingVideoCompositionRequests() {
    generationLock.lock()
    generation += 1
    generationLock.unlock()
  }
}

/// Lab instrumentation (capability lab S4/S5): how long the compositor takes per frame, from
/// the request picked up on its queue to the GPU render finished. Off (one lock read per
/// frame) unless a spike turns it on.
enum CompositorTiming {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var samples: [Double]?

  static var isOn: Bool { lock.withLock { samples != nil } }
  static func begin() { lock.withLock { samples = [] } }
  static func record(_ ms: Double) { lock.withLock { samples?.append(ms) } }
  /// Turns it off and returns the per-frame milliseconds since `begin`.
  static func end() -> [Double] { lock.withLock { defer { samples = nil }; return samples ?? [] } }
}
