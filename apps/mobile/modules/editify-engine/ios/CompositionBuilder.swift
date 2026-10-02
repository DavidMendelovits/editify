import AVFoundation
import CoreImage

/// A lab timeline: one source cut into `clips` back-to-back pieces that
/// alternate between two video tracks (A/B), so neighbours can overlap for a
/// crossfade. This is the minimum shape that exercises two live decoders,
/// transforms, dissolves and an overlay; the real engine maps `Project` onto the same structure.
struct LabTimeline {
  var clips = 2
  var clipSeconds = 5.0
  var crossfadeSeconds = 0.5
  var punchIn: CGFloat = 1.15
  var renderSize = CGSize(width: 1080, height: 1920)
  var frameRate: Int32 = 30
  var overlay = true
}

enum CompositionBuilder {
  static func build(asset: AVAsset, timeline: LabTimeline) async throws -> (AVMutableComposition, AVMutableVideoComposition) {
    guard let sourceTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw SpikeError(message: "asset has no video track")
    }
    let sourceDuration = try await asset.load(.duration)
    let audioSource = try await asset.loadTracks(withMediaType: .audio).first
    let composition = AVMutableComposition()
    guard let trackA = composition.addMutableTrack(withMediaType: .video, preferredTrackID: 1),
          let trackB = composition.addMutableTrack(withMediaType: .video, preferredTrackID: 2) else {
      throw SpikeError(message: "could not add composition tracks")
    }
    let audioTrack = audioSource != nil ? composition.addMutableTrack(withMediaType: .audio, preferredTrackID: 3) : nil

    let clip = CMTime(seconds: timeline.clipSeconds, preferredTimescale: 600)
    let fade = CMTime(seconds: timeline.crossfadeSeconds, preferredTimescale: 600)
    let step = clip - fade
    var instructions: [LabInstruction] = []
    let overlay = timeline.overlay ? stickerImage(in: timeline.renderSize) : nil

    for index in 0..<timeline.clips {
      // Wrap around the source so any clip count works with a short fixture.
      let maxStart = max(0, sourceDuration.seconds - timeline.clipSeconds)
      let sourceStart = CMTime(seconds: maxStart > 0 ? (Double(index) * 1.7).truncatingRemainder(dividingBy: maxStart) : 0, preferredTimescale: 600)
      let range = CMTimeRange(start: sourceStart, duration: min(clip, sourceDuration - sourceStart))
      let at = CMTimeMultiply(step, multiplier: Int32(index))
      let track = index.isMultiple(of: 2) ? trackA : trackB
      try track.insertTimeRange(range, of: sourceTrack, at: at)
      if let audioSource, let audioTrack, index.isMultiple(of: 2) {
        try? audioTrack.insertTimeRange(range, of: audioSource, at: at)
      }
    }

    // Instructions: a solo segment per clip, and a two-layer dissolve where neighbours overlap.
    for index in 0..<timeline.clips {
      let trackID: CMPersistentTrackID = index.isMultiple(of: 2) ? 1 : 2
      let start = CMTimeMultiply(step, multiplier: Int32(index))
      let soloStart = index == 0 ? start : start + fade
      let soloEnd = index == timeline.clips - 1 ? start + clip : start + step
      if soloEnd > soloStart {
        instructions.append(LabInstruction(timeRange: CMTimeRange(start: soloStart, end: soloEnd), layers: [
          LabLayer(trackID: trackID, scaleFrom: 1, scaleTo: timeline.punchIn, opacityFrom: 1, opacityTo: 1),
        ], overlay: overlay))
      }
      if index < timeline.clips - 1 {
        let nextID: CMPersistentTrackID = trackID == 1 ? 2 : 1
        instructions.append(LabInstruction(timeRange: CMTimeRange(start: start + step, duration: fade), layers: [
          LabLayer(trackID: trackID, scaleFrom: timeline.punchIn, scaleTo: timeline.punchIn, opacityFrom: 1, opacityTo: 1),
          LabLayer(trackID: nextID, scaleFrom: 1, scaleTo: 1, opacityFrom: 0, opacityTo: 1),
        ], overlay: overlay))
      }
    }

    let video = AVMutableVideoComposition()
    video.customVideoCompositorClass = LabCompositor.self
    video.renderSize = timeline.renderSize
    video.frameDuration = CMTime(value: 1, timescale: timeline.frameRate)
    video.instructions = instructions
    // Carry the source's colour through (HLG stays HLG); nil lets AVFoundation pick SDR.
    if let description = try await sourceTrack.load(.formatDescriptions).first,
       let extensions = CMFormatDescriptionGetExtensions(description) as? [String: Any] {
      video.colorPrimaries = extensions[kCVImageBufferColorPrimariesKey as String] as? String
      video.colorTransferFunction = extensions[kCVImageBufferTransferFunctionKey as String] as? String
      video.colorYCbCrMatrix = extensions[kCVImageBufferYCbCrMatrixKey as String] as? String
    }
    return (composition, video)
  }

  /// A sticker-sized translucent card, the cost stand-in for a bitmap overlay.
  static func stickerImage(in size: CGSize) -> CIImage {
    let side = size.width * 0.3
    return CIImage(color: CIColor(red: 1, green: 0.8, blue: 0.1, alpha: 0.85))
      .cropped(to: CGRect(x: size.width * 0.6, y: size.height * 0.7, width: side, height: side))
  }
}
