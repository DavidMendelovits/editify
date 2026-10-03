import AVFoundation
import CoreImage

enum PlanBuildError: Error, LocalizedError {
  /// Duration 0: nothing to play or export (a preview shows only the background).
  case emptyPlan
  case noVideoTrack(String)
  case composition(String)
  case compositor(String)

  var errorDescription: String? {
    switch self {
    case .emptyPlan: return "The plan has no frames"
    case .noVideoTrack(let id): return "Asset \(id) has no video track"
    case .composition(let what): return "Could not build the composition: \(what)"
    case .compositor(let what): return "Compositor error: \(what)"
    }
  }
}

/// Resolves a plan's asset refs to media. A plan is untrusted input: the
/// resolver must look ids up ONLY among the current user's own media (the
/// device registry, or the user-scoped server copy), never treat an id as a
/// path or URL. The builder never touches media any other way.
struct PlanAssetResolver {
  /// An AVAsset for a `video` or `audio` ref.
  var asset: (RenderPlan.AssetRef) async throws -> AVAsset
  /// A local file for an `image` ref (a still or a GIF).
  var imageFile: (RenderPlan.AssetRef) async throws -> URL
}

struct PlanBuildOptions {
  /// Output pixels per plan pixel: 1 for export, view.w / plan.w for a preview drawn at view size.
  var renderScale: CGFloat = 1
  var fonts: PlanFonts = .shared
  var captionCacheBytes = 64 << 20
}

/// A plan as AVFoundation objects. AVPlayerItem (EditifyPlayerView) and
/// AVAssetReader (exportProject) both take these three unchanged.
struct BuiltPlan {
  let plan: RenderPlan
  let composition: AVMutableComposition
  let videoComposition: AVVideoComposition
  let audioMix: AVMutableAudioMix
  let state: PlanRenderState
  /// The resolved source assets, kept alive for as long as the composition is used.
  let sources: [AVAsset]
  /// Set it on the AVPlayerItem / AVAssetReaderAudioMixOutput as well as the
  /// mix: time-stretched sound keeps its pitch (atempo's job on the server).
  static let audioTimePitchAlgorithm: AVAudioTimePitchAlgorithm = .spectral
}

/// Plan → composition. An executor only: every time, size and stacking order
/// comes from the plan.
///
/// Video: one composition track per concurrently needed layer. A clip that
/// continues into the next segment keeps its track (so its decoder keeps
/// running); other layers take any track idle by then. B-roll overlays get
/// tracks of their own. Source time is mapped by inserting the source range
/// and scaling it to the timeline span (speed). Sampling follows the schema:
/// the source range starts at srcStart + 1e-6, so a timeline frame shows the
/// latest source frame with PTS <= s + 1e-6; holds insert a sliver at frameAt
/// and stretch it over the segment; a source that runs out holds its last frame.
///
/// Audio: entries share tracks when they do not overlap; each is the source
/// range [in, out) scaled by 1 / speed (spectral time-pitch), with volume
/// ramps for gainKeys x fadeIn x fadeOut.
enum PlanBuilder {
  /// Seconds as a source time on a microsecond grid, rounded down after the
  /// sampling rule's +1e-6.
  static func sourceTime(_ seconds: Double) -> CMTime {
    CMTime(value: Int64(((seconds + RenderPlan.epsilon) * 1_000_000).rounded(.down)), timescale: 1_000_000)
  }

  static func microseconds(_ seconds: Double) -> CMTime {
    CMTime(value: Int64((seconds * 1_000_000).rounded()), timescale: 1_000_000)
  }

  /// Hold slivers: short enough never to reach the next source frame.
  static let holdSliver = CMTime(value: 100, timescale: 1_000_000)

  struct VideoSource {
    /// Held so the track stays usable: an AVAssetTrack does not keep its asset alive.
    let asset: AVAsset
    let track: AVAssetTrack
    let range: CMTimeRange
    let frameDuration: CMTime
    let orientation: CGImagePropertyOrientation

    var lastFrameStart: CMTime { max(range.start, range.end - frameDuration) }
  }

  private final class Slot {
    let track: AVMutableCompositionTrack
    var cursor: CMTime = .zero
    var lastKey: String?
    var lastSegment = -2
    init(track: AVMutableCompositionTrack) { self.track = track }
  }

  // swiftlint:disable:next function_body_length cyclomatic_complexity
  static func build(_ plan: RenderPlan, resolver: PlanAssetResolver, options: PlanBuildOptions = PlanBuildOptions()) async throws -> BuiltPlan {
    guard plan.duration > 0, plan.frameCount > 0, let lastSegment = plan.video.segments.last else { throw PlanBuildError.emptyPlan }
    let fps = Int32(plan.fps)
    let frameTime = { (frame: Int64) in CMTime(value: frame, timescale: fps) }
    let planEnd = frameTime(plan.gridFrame(lastSegment.end))

    // Media, each ref loaded once.
    var videoSources: [String: VideoSource] = [:]
    var stills: [String: PlanStill] = [:]
    var gifs: [String: PlanGif] = [:]
    func video(_ ref: RenderPlan.AssetRef) async throws -> VideoSource {
      if let cached = videoSources[ref.id] { return cached }
      let asset = try await resolver.asset(ref)
      guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw PlanBuildError.noVideoTrack(ref.id) }
      let (range, minFrame, rate, transform) = try await track.load(.timeRange, .minFrameDuration, .nominalFrameRate, .preferredTransform)
      let frame = minFrame.isValid && minFrame > .zero ? minFrame : CMTime(value: 1, timescale: CMTimeScale(max(1, rate.rounded())))
      let source = VideoSource(asset: asset, track: track, range: range, frameDuration: frame, orientation: AnalysisMath.orientation(of: transform))
      videoSources[ref.id] = source
      return source
    }
    for segment in plan.video.segments {
      for layer in segment.layers {
        switch layer.assetRef.kind {
        case .video: _ = try await video(layer.assetRef)
        case .image: if stills[layer.assetRef.id] == nil { stills[layer.assetRef.id] = try PlanStill.load(try await resolver.imageFile(layer.assetRef)) }
        case .audio: throw PlanBuildError.composition("a video layer cannot draw an audio asset")
        }
      }
    }
    for item in plan.overlays {
      guard let media = item.media else { continue }
      switch item.kind {
      case .gif: if gifs[media.assetRef.id] == nil { gifs[media.assetRef.id] = try PlanGif.load(try await resolver.imageFile(media.assetRef)) }
      case .image: if stills[media.assetRef.id] == nil { stills[media.assetRef.id] = try PlanStill.load(try await resolver.imageFile(media.assetRef)) }
      case .broll: _ = try await video(media.assetRef)
      case .emoji, .callout: break
      }
    }

    let composition = AVMutableComposition()
    var videoSlots: [Slot] = []
    func newVideoSlot() throws -> Slot {
      guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw PlanBuildError.composition("could not add a video track")
      }
      let slot = Slot(track: track)
      videoSlots.append(slot)
      return slot
    }
    func advance(_ slot: Slot, to time: CMTime) throws {
      if slot.cursor < time { slot.track.insertEmptyTimeRange(CMTimeRange(start: slot.cursor, end: time)) }
      slot.cursor = time
    }

    // Video layers, segment by segment.
    var layerTracks: [[CMPersistentTrackID?]] = []
    for (index, segment) in plan.video.segments.enumerated() {
      let start = frameTime(plan.gridFrame(segment.start))
      let end = frameTime(plan.gridFrame(segment.end))
      var assigned = [Slot?](repeating: nil, count: segment.layers.count)
      var used = Set<ObjectIdentifier>()
      let key = { (layer: RenderPlan.Layer) in "\(layer.clipId)\u{1F}\(layer.assetRef.id)" }
      // Continuing clips keep their track.
      for (layerIndex, layer) in segment.layers.enumerated() where layer.assetRef.kind == .video {
        if let slot = videoSlots.first(where: { $0.lastSegment == index - 1 && $0.lastKey == key(layer) && !used.contains(ObjectIdentifier($0)) }) {
          assigned[layerIndex] = slot
          used.insert(ObjectIdentifier(slot))
        }
      }
      for (layerIndex, layer) in segment.layers.enumerated() where layer.assetRef.kind == .video && assigned[layerIndex] == nil {
        let slot = try videoSlots.first(where: { !used.contains(ObjectIdentifier($0)) && $0.cursor <= start }) ?? newVideoSlot()
        assigned[layerIndex] = slot
        used.insert(ObjectIdentifier(slot))
      }
      var ids = [CMPersistentTrackID?](repeating: nil, count: segment.layers.count)
      for (layerIndex, layer) in segment.layers.enumerated() {
        guard let slot = assigned[layerIndex], let source = videoSources[layer.assetRef.id] else { continue }
        try advance(slot, to: start)
        try insert(source, into: slot.track, at: start, duration: end - start,
                   srcStart: layer.srcStart, speed: layer.speed, hold: layer.hold?.frameAt, loop: false)
        slot.cursor = end
        slot.lastKey = key(layer)
        slot.lastSegment = index
        ids[layerIndex] = slot.track.trackID
      }
      layerTracks.append(ids)
    }

    // B-roll overlays on tracks of their own.
    var brollSlots: [Slot] = []
    var brollTracks: [String: CMPersistentTrackID] = [:]
    for item in plan.overlays.sorted(by: { $0.start < $1.start }) where item.kind == .broll {
      guard let media = item.media, let source = videoSources[media.assetRef.id] else { continue }
      let start = microseconds(item.start)
      let end = min(microseconds(item.end), planEnd)
      guard end > start else { continue }
      let slot: Slot
      if let free = brollSlots.first(where: { $0.cursor <= start }) {
        slot = free
      } else {
        slot = try newVideoSlot()
        brollSlots.append(slot)
      }
      try advance(slot, to: start)
      try insert(source, into: slot.track, at: start, duration: end - start,
                 srcStart: media.srcStart, speed: media.speed, hold: nil, loop: media.loop ?? false)
      slot.cursor = end
      brollTracks[item.id] = slot.track.trackID
    }

    // Every video track spans the whole timeline, and there is always one, so
    // the composition lasts exactly `duration` and frames are requested even
    // where nothing but the background shows.
    if videoSlots.isEmpty { _ = try newVideoSlot() }
    for slot in videoSlots { try advance(slot, to: planEnd) }

    // Audio.
    let audioMix = AVMutableAudioMix()
    var audioSlots: [(slot: Slot, end: Double, parameters: AVMutableAudioMixInputParameters)] = []
    var audioAssets: [AVAsset] = []
    for entry in plan.audio.sorted(by: { $0.at < $1.at }) {
      let asset = try await resolver.asset(entry.assetRef)
      audioAssets.append(asset)
      guard let source = try await asset.loadTracks(withMediaType: .audio).first else { continue }
      let sourceRange = try await source.load(.timeRange)
      let from = microseconds(entry.in)
      let to = min(microseconds(entry.out), sourceRange.end)
      guard to > from else { continue }
      let index: Int
      if let free = audioSlots.firstIndex(where: { $0.end <= entry.at + RenderPlan.epsilon }) {
        index = free
      } else {
        guard let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
          throw PlanBuildError.composition("could not add an audio track")
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        parameters.audioTimePitchAlgorithm = BuiltPlan.audioTimePitchAlgorithm
        audioSlots.append((Slot(track: track), 0, parameters))
        index = audioSlots.count - 1
      }
      let slot = audioSlots[index].slot
      let at = CMTime(value: Int64((entry.at * 48_000).rounded()), timescale: 48_000)
      try advance(slot, to: at)
      do {
        try slot.track.insertTimeRange(CMTimeRange(start: from, end: to), of: source, at: at)
      } catch {
        throw PlanBuildError.composition("audio \(entry.id): \(error.localizedDescription)")
      }
      let played = (to - from).seconds / entry.speed
      let span = CMTime(value: Int64((played * 48_000).rounded()), timescale: 48_000)
      if entry.speed != 1 || to - from != span {
        slot.track.scaleTimeRange(CMTimeRange(start: at, duration: to - from), toDuration: span)
      }
      slot.cursor = at + span
      audioSlots[index].end = entry.end
      for ramp in AudioRamps.ramps(entry) {
        audioSlots[index].parameters.setVolumeRamp(
          fromStartVolume: Float(ramp.from), toEndVolume: Float(ramp.to),
          timeRange: CMTimeRange(start: CMTime(seconds: ramp.start, preferredTimescale: 48_000),
                                 end: CMTime(seconds: ramp.end, preferredTimescale: 48_000)))
      }
    }
    var mixParameters = audioSlots.map(\.parameters)

    // A composition lasts until its last real media; empty edits do not
    // count. Where the plan ends on background only (a trailing empty
    // segment, captions over nothing, a stills-only plan), a silent carrier
    // track holds the composition open to `duration`.
    if composition.duration < planEnd {
      let carrier = AVURLAsset(url: try PlanCarrier.silence())
      audioAssets.append(carrier)
      guard let source = try await carrier.loadTracks(withMediaType: .audio).first,
            let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw PlanBuildError.composition("could not add the carrier track")
      }
      let range = try await source.load(.timeRange)
      try track.insertTimeRange(range, of: source, at: .zero)
      track.scaleTimeRange(CMTimeRange(start: .zero, duration: range.duration), toDuration: planEnd)
      let silent = AVMutableAudioMixInputParameters(track: track)
      silent.setVolume(0, at: .zero)
      mixParameters.append(silent)
    }
    audioMix.inputParameters = mixParameters

    // Draw-time state: pre-drawn payloads, the caption renderer.
    let scale = options.renderScale
    var drawn: [String: OverlayGraphics.Drawn] = [:]
    for item in plan.overlays {
      if let emoji = item.emoji, let bitmap = OverlayGraphics.emoji(emoji, box: item.box, scale: scale) { drawn[item.id] = bitmap }
      if let callout = item.callout, let bitmap = try OverlayGraphics.callout(callout, box: item.box, fonts: options.fonts, scale: scale) {
        drawn[item.id] = bitmap
      }
    }
    let even = { (value: Int) in max(2, Int((CGFloat(value) * scale / 2).rounded()) * 2) }
    let renderSize = CGSize(width: even(plan.size.w), height: even(plan.size.h))
    let state = PlanRenderState(plan: plan, scale: scale, renderSize: renderSize, stills: stills, gifs: gifs, drawnOverlays: drawn,
                                captions: CaptionRenderer(fonts: options.fonts, budgetBytes: options.captionCacheBytes))
    // Fail now, not mid-export, when a caption face is missing.
    for face in Set(plan.captions.map(\.font)) { _ = try options.fonts.verticalMetrics(face) }

    var instructions: [EditifyInstruction] = []
    for (index, segment) in plan.video.segments.enumerated() {
      let start = frameTime(plan.gridFrame(segment.start))
      let end = frameTime(plan.gridFrame(segment.end))
      var layers: [ResolvedLayer] = []
      for (layerIndex, layer) in segment.layers.enumerated() {
        if layer.assetRef.kind == .image, let still = stills[layer.assetRef.id] {
          layers.append(ResolvedLayer(layer: layer, source: .still(still.image)))
        } else if let id = layerTracks[index][layerIndex], let source = videoSources[layer.assetRef.id] {
          layers.append(ResolvedLayer(layer: layer, source: .track(id, source.orientation)))
        }
      }
      let overlaps = { (from: Double, to: Double) in from < segment.end - RenderPlan.epsilon && to > segment.start + RenderPlan.epsilon }
      var overlays: [ResolvedOverlay] = []
      for item in plan.overlays where overlaps(item.start, item.end) {
        switch item.kind {
        case .image:
          if let id = item.media?.assetRef.id, let still = stills[id] { overlays.append(ResolvedOverlay(overlay: item, content: .still(still.image))) }
        case .gif:
          if let id = item.media?.assetRef.id, let gif = gifs[id] { overlays.append(ResolvedOverlay(overlay: item, content: .gif(gif))) }
        case .broll:
          if let id = item.media?.assetRef.id, let track = brollTracks[item.id], let source = videoSources[id] {
            overlays.append(ResolvedOverlay(overlay: item, content: .broll(track, source.orientation)))
          }
        case .emoji, .callout:
          if let bitmap = drawn[item.id] { overlays.append(ResolvedOverlay(overlay: item, content: .drawn(bitmap))) }
        }
      }
      let captions = plan.captions.filter { overlaps($0.start, $0.end) }
      instructions.append(EditifyInstruction(timeRange: CMTimeRange(start: start, end: end), segmentIndex: index,
                                             layers: layers, overlays: overlays, captions: captions, state: state))
    }

    let tags = PlanColorPipeline.tags(plan.color)
    let videoComposition = AVVideoComposition(configuration: AVVideoComposition.Configuration(
      colorPrimaries: tags.primaries,
      colorTransferFunction: tags.transfer,
      colorYCbCrMatrix: tags.matrix,
      customVideoCompositorClass: EditifyCompositor.self,
      frameDuration: CMTime(value: 1, timescale: fps),
      instructions: instructions,
      renderSize: renderSize))

    return BuiltPlan(plan: plan, composition: composition, videoComposition: videoComposition, audioMix: audioMix, state: state,
                     sources: videoSources.values.map(\.asset) + audioAssets)
  }

  /// Places source time srcStart (+ (t - at) * speed) on `track` over [at, at + duration).
  static func insert(_ source: VideoSource, into track: AVMutableCompositionTrack, at: CMTime, duration: CMTime,
                     srcStart: Double, speed: Double, hold: Double?, loop: Bool) throws {
    func place(_ range: CMTimeRange, at time: CMTime, over span: CMTime) throws {
      do {
        try track.insertTimeRange(range, of: source.track, at: time)
      } catch {
        throw PlanBuildError.composition("video source \(range.start.seconds)+\(range.duration.seconds) s at \(time.seconds) s: \(error)")
      }
      if range.duration != span { track.scaleTimeRange(CMTimeRange(start: time, duration: range.duration), toDuration: span) }
    }
    func holdFrame(_ frameStart: CMTime, at time: CMTime, over span: CMTime) throws {
      guard span > .zero else { return }
      let start = min(max(frameStart, source.range.start), source.lastFrameStart)
      try place(CMTimeRange(start: start, duration: holdSliver), at: time, over: span)
    }

    if let hold {
      try holdFrame(sourceTime(hold), at: at, over: duration)
      return
    }
    var cursor = at
    let end = at + duration
    var from = sourceTime(srcStart)
    while cursor < end {
      let remaining = end - cursor
      let wanted = CMTime(seconds: remaining.seconds * speed, preferredTimescale: 1_000_000)
      let available = source.range.end - from
      if available >= wanted {
        try place(CMTimeRange(start: from, duration: wanted), at: cursor, over: remaining)
        return
      }
      if available > .zero {
        let span = CMTime(seconds: available.seconds / speed, preferredTimescale: 1_000_000)
        if span > .zero {
          try place(CMTimeRange(start: from, duration: available), at: cursor, over: min(span, remaining))
          cursor = cursor + min(span, remaining)
        }
      }
      if loop, source.range.duration > .zero {
        from = source.range.start
        continue
      }
      // The source ran out: hold its last frame for the rest.
      try holdFrame(source.lastFrameStart, at: cursor, over: end - cursor)
      return
    }
  }
}

/// gainKeys x fadeIn x fadeOut as linear volume ramps. AVAudioMix ramps are
/// linear, so stretches where two factors move at once (a product of lines)
/// or a half-sine fade moves are split into pieces of at most 4 ms.
/// AVAudioMix volume is 0...1: gains above 1 are clamped here (see report).
enum AudioRamps {
  struct Ramp: Equatable { let start: Double; let end: Double; let from: Double; let to: Double }

  static func gain(_ entry: RenderPlan.AudioEntry, at t: Double) -> Double {
    let keys = PlanKeys.value(at: t, times: entry.gainKeys.map(\.t), values: entry.gainKeys.map(\.gain), empty: 1)
    let end = entry.end
    var gain = keys
    if entry.fadeIn.duration > 0 { gain *= curve(entry.fadeIn.curve, (t - entry.at) / entry.fadeIn.duration) }
    if entry.fadeOut.duration > 0 { gain *= curve(entry.fadeOut.curve, (end - t) / entry.fadeOut.duration) }
    return gain
  }

  /// linear = ffmpeg `tri`; halfSine = `hsin`, (1 - cos(pi p)) / 2.
  static func curve(_ curve: RenderPlan.Fade.Curve, _ progress: Double) -> Double {
    let p = min(1, max(0, progress))
    switch curve {
    case .linear: return p
    case .halfSine: return (1 - cos(.pi * p)) / 2
    }
  }

  static func ramps(_ entry: RenderPlan.AudioEntry) -> [Ramp] {
    let start = entry.at, end = entry.end
    guard end > start else { return [] }
    let fadeInEnd = start + entry.fadeIn.duration
    let fadeOutStart = end - entry.fadeOut.duration
    var points = Set([start, end, fadeInEnd, fadeOutStart])
    for key in entry.gainKeys { points.insert(key.t) }
    let edges = points.filter { $0 >= start && $0 <= end }.sorted()
    var ramps: [Ramp] = []
    for (a, b) in zip(edges, edges.dropFirst()) where b - a > 1e-9 {
      let mid = (a + b) / 2
      let fadingIn = entry.fadeIn.duration > 0 && mid < fadeInEnd
      let fadingOut = entry.fadeOut.duration > 0 && mid > fadeOutStart
      let keysMove = abs(PlanKeys.value(at: a, times: entry.gainKeys.map(\.t), values: entry.gainKeys.map(\.gain), empty: 1)
        - PlanKeys.value(at: b, times: entry.gainKeys.map(\.t), values: entry.gainKeys.map(\.gain), empty: 1)) > 1e-12
      let moving = [fadingIn, fadingOut, keysMove].filter { $0 }.count
      let curved = (fadingIn && entry.fadeIn.curve == .halfSine) || (fadingOut && entry.fadeOut.curve == .halfSine)
      let pieces = moving >= 2 || curved ? min(256, max(4, Int(((b - a) / 0.004).rounded(.up)))) : 1
      for piece in 0..<pieces {
        let from = a + (b - a) * Double(piece) / Double(pieces)
        let to = a + (b - a) * Double(piece + 1) / Double(pieces)
        ramps.append(Ramp(start: from, end: to, from: clamp(gain(entry, at: from)), to: clamp(gain(entry, at: to))))
      }
    }
    return ramps
  }

  private static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
}

/// A short silent WAV, written once per process: the carrier that keeps a
/// composition as long as its plan. PCM in a WAV needs no encoder.
enum PlanCarrier {
  private static let lock = NSLock()

  static func silence() throws -> URL {
    lock.lock(); defer { lock.unlock() }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("editify-carrier-silence-v1.wav")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let rate: UInt32 = 48_000, frames: UInt32 = 4_800
    var data = Data()
    func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + frames * 2))
    data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
    append(rate); append(rate * 2); append(UInt16(2)); append(UInt16(16))
    data.append(contentsOf: Array("data".utf8)); append(frames * 2)
    data.append(Data(count: Int(frames) * 2))
    try data.write(to: url, options: .atomic)
    return url
  }
}
