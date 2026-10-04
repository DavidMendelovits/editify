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
///
/// Video assets must be opened with precise timing
/// (`AVURLAsset(url:options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])`):
/// holds snap to real frame timestamps, and an imprecise duration or sample
/// table would place them on estimates.
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
  /// A player passes its own renderer and media cache so caption bitmaps and
  /// decoded images survive rebuilds; export gets fresh ones.
  var captions: CaptionRenderer?
  var media = PlanMediaCache()
  var captionCacheBytes = 64 << 20
  /// A player's emoji and callout bitmaps, reused across updates (nil: drawn for this build).
  var graphics: OverlayBitmapCache?
  /// The VideoComposition port's adapter (EngineAdapters hands it to export and playback).
  var videoComposition: PlanVideoComposition = ConfigurationVideoComposition()
}

/// Sources a plan uses, loaded once. `PlanBuilder.prepare(_:resolver:reusing:)`
/// keeps every source a previous preparation already loaded, so a rebuild
/// after an edit only loads what is new.
final class PreparedMedia: @unchecked Sendable {
  struct Video {
    /// Held so the track stays usable: an AVAssetTrack does not keep its asset alive.
    let asset: AVAsset
    let track: AVAssetTrack
    let range: CMTimeRange
    let frameDuration: CMTime
    let orientation: CGImagePropertyOrientation
    let canProvideSampleCursors: Bool
    /// The track's edit list: sample cursors work in media time, compositions in track time.
    let segments: [AVAssetTrackSegment]

    var lastFrameStart: CMTime { max(range.start, range.end - frameDuration) }
  }

  struct Audio {
    let asset: AVAsset
    /// nil: the asset has no sound (an entry for it plays silence).
    let track: AVAssetTrack?
    let range: CMTimeRange
  }

  fileprivate(set) var videos: [String: Video] = [:]
  fileprivate(set) var audios: [String: Audio] = [:]
  fileprivate(set) var images: [String: URL] = [:]
  fileprivate(set) var carrier: Audio?

  var assets: [AVAsset] { videos.values.map(\.asset) + audios.values.map(\.asset) + (carrier.map { [$0.asset] } ?? []) }
}

/// Where each plan element landed in the composition. A plan whose
/// `structureKey` matches can reuse the composition and rebuild only the
/// video composition and audio mix (a parameter-only edit: zoom keys,
/// opacity, overlays, captions, gains).
struct CompositionLayout {
  let structureKey: String
  /// Per segment, per layer: the composition track (nil for a still).
  let layerTracks: [[CMPersistentTrackID?]]
  let brollTracks: [String: CMPersistentTrackID]
  /// Audio entry id to its composition track.
  let audioTracks: [String: CMPersistentTrackID]
  let carrierTrack: CMPersistentTrackID?
  /// The asset each video and audio id was inserted from: an update with a
  /// reloaded asset under the same id must rebuild the composition.
  let sources: [String: ObjectIdentifier]
}

/// A plan as AVFoundation objects. AVPlayerItem (EditifyPlayerView) and
/// AVAssetReader (exportProject) both take these three unchanged.
struct BuiltPlan {
  let plan: RenderPlan
  let composition: AVMutableComposition
  let videoComposition: AVVideoComposition
  let audioMix: AVMutableAudioMix
  let state: PlanRenderState
  let layout: CompositionLayout
  let media: PreparedMedia
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
/// tracks of their own. Speed is the source range scaled to the timeline span
/// (speed 1 inserts exactly, unscaled). Sampling follows the schema: the
/// source range starts at srcStart + 1e-6, so a timeline frame shows the
/// latest source frame with PTS <= s + 1e-6. A hold inserts a sliver that
/// starts on the held frame's own PTS and ends before the next frame, stretched
/// over the segment; a source that runs out holds its last frame.
///
/// Audio, on the 48 kHz sample grid: entries share tracks when they do not
/// overlap; each plays source [in, out) from `at`. Speed 1 is inserted
/// unscaled (no time-pitch processing at all); other speeds are scaled to
/// their span with spectral time-pitch. Volume ramps carry
/// gainKeys x fadeIn x fadeOut. Silence fills every track from the last
/// sound to `duration`, so the mix and the composition last exactly the plan.
enum PlanBuilder {
  static let audioRate = 48_000.0

  /// Seconds as a source time after the sampling rule's +1e-6, rounded down
  /// on a nanosecond grid. (On a microsecond grid the float sum can land a
  /// hair under the microsecond it means: 0.333333 + 1e-6 floors to 333333 us,
  /// before frame 10's PTS of 1/3 s, and shows frame 9.)
  static func sourceTime(_ seconds: Double) -> CMTime {
    CMTime(value: Int64(((seconds + RenderPlan.epsilon) * 1_000_000_000).rounded(.down)), timescale: 1_000_000_000)
  }

  static func microseconds(_ seconds: Double) -> CMTime {
    CMTime(value: Int64((seconds * 1_000_000).rounded()), timescale: 1_000_000)
  }

  static func sample(_ seconds: Double) -> Int64 { Int64((seconds * audioRate).rounded()) }
  static func sampleTime(_ sample: Int64) -> CMTime { CMTime(value: sample, timescale: CMTimeScale(audioRate)) }

  /// The longest a hold sliver may be.
  static let holdSliver = CMTime(value: 100, timescale: 1_000_000)

  private final class Slot {
    let track: AVMutableCompositionTrack
    var cursor: CMTime = .zero
    var lastKey: String?
    var lastSegment = -2
    init(track: AVMutableCompositionTrack) { self.track = track }

    /// Moves the cursor to `time`: an empty edit across a gap; never backwards
    /// over content (that would split the previous edit), so an overlap trims
    /// the previous edit's tail instead.
    func advance(to time: CMTime) {
      if cursor < time {
        track.insertEmptyTimeRange(CMTimeRange(start: cursor, end: time))
      } else if cursor > time {
        assertionFailure("composition track overlap: \(cursor.seconds) > \(time.seconds)")
        track.removeTimeRange(CMTimeRange(start: time, end: cursor))
      }
      cursor = time
    }
  }

  // MARK: Loading

  /// Loads every source the plan names that `previous` does not already hold.
  /// `invalidating` names asset ids whose media changed under the same id (a
  /// proxy swapped for the original, a re-linked Photos asset): they are
  /// resolved again, and their decoded images dropped from `cache`.
  static func prepare(_ plan: RenderPlan, resolver: PlanAssetResolver, reusing previous: PreparedMedia? = nil,
                      invalidating changed: Set<String> = [], cache: PlanMediaCache? = nil) async throws -> PreparedMedia {
    let media = PreparedMedia()
    if let previous {
      media.videos = previous.videos.filter { !changed.contains($0.key) }
      media.audios = previous.audios.filter { !changed.contains($0.key) }
      media.images = previous.images.filter { !changed.contains($0.key) }
      media.carrier = previous.carrier
      for id in changed { if let url = previous.images[id] { cache?.forget(url) } }
    }
    func video(_ ref: RenderPlan.AssetRef) async throws {
      if media.videos[ref.id] != nil { return }
      let asset = try await resolver.asset(ref)
      guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw PlanBuildError.noVideoTrack(ref.id) }
      let (range, minFrame, rate, transform, cursors) = try await track.load(
        .timeRange, .minFrameDuration, .nominalFrameRate, .preferredTransform, .canProvideSampleCursors)
      let segments = try await track.load(.segments)
      let frame = minFrame.isValid && minFrame > .zero ? minFrame : CMTime(value: 1, timescale: CMTimeScale(max(1, rate.rounded())))
      media.videos[ref.id] = PreparedMedia.Video(asset: asset, track: track, range: range, frameDuration: frame,
                                                 orientation: AnalysisMath.orientation(of: transform), canProvideSampleCursors: cursors,
                                                 segments: segments)
    }
    func image(_ ref: RenderPlan.AssetRef) async throws {
      if media.images[ref.id] == nil { media.images[ref.id] = try await resolver.imageFile(ref) }
    }
    for segment in plan.video.segments {
      for layer in segment.layers {
        switch layer.assetRef.kind {
        case .video: try await video(layer.assetRef)
        case .image: try await image(layer.assetRef)
        case .audio: throw PlanBuildError.composition("a video layer cannot draw an audio asset")
        }
      }
    }
    for item in plan.overlays {
      guard let media = item.media else { continue }
      switch item.kind {
      case .gif, .image: try await image(media.assetRef)
      case .broll: try await video(media.assetRef)
      case .emoji, .callout: break
      }
    }
    for entry in plan.audio where media.audios[entry.assetRef.id] == nil {
      let asset = try await resolver.asset(entry.assetRef)
      let track = try await asset.loadTracks(withMediaType: .audio).first
      let range = try await track?.load(.timeRange) ?? .zero
      media.audios[entry.assetRef.id] = PreparedMedia.Audio(asset: asset, track: track, range: range)
    }
    if media.carrier == nil {
      let asset = AVURLAsset(url: try PlanCarrier.silence())
      guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw PlanBuildError.composition("no carrier track") }
      media.carrier = PreparedMedia.Audio(asset: asset, track: track, range: try await track.load(.timeRange))
    }
    return media
  }

  /// Load and assemble in one go (export).
  static func build(_ plan: RenderPlan, resolver: PlanAssetResolver, options: PlanBuildOptions = PlanBuildOptions()) async throws -> BuiltPlan {
    try assemble(plan, media: try await prepare(plan, resolver: resolver), options: options)
  }

  /// A parameter-only edit: the same composition with a new video composition
  /// and audio mix. Pass the media prepared for the new plan (prepare
  /// reusing built.media), so new stills and GIFs resolve. nil when the
  /// plan's structure changed, when `media` lacks a source the plan names, or
  /// when a source the composition was cut from was reloaded: assemble instead.
  static func update(_ built: BuiltPlan, to plan: RenderPlan, media: PreparedMedia? = nil, options: PlanBuildOptions) throws -> BuiltPlan? {
    let media = media ?? built.media
    guard structureKey(plan) == built.layout.structureKey, covers(plan, media) else { return nil }
    for (key, identity) in built.layout.sources {
      let id = String(key.dropFirst(2))
      let current = key.hasPrefix("v:") ? media.videos[id].map { ObjectIdentifier($0.asset) } : media.audios[id].map { ObjectIdentifier($0.asset) }
      if let current, current != identity { return nil }
    }
    return try finish(plan, composition: built.composition, layout: built.layout, media: media, options: options)
  }

  /// True when `media` holds every source the plan names.
  static func covers(_ plan: RenderPlan, _ media: PreparedMedia) -> Bool {
    for segment in plan.video.segments {
      for layer in segment.layers {
        if layer.assetRef.kind == .image ? media.images[layer.assetRef.id] == nil : media.videos[layer.assetRef.id] == nil { return false }
      }
    }
    for item in plan.overlays {
      guard let ref = item.media?.assetRef else { continue }
      if ref.kind == .image ? media.images[ref.id] == nil : media.videos[ref.id] == nil { return false }
    }
    return plan.audio.allSatisfy { media.audios[$0.assetRef.id] != nil }
  }

  /// Everything that decides the composition's edits. Keys, opacity, dims,
  /// overlay boxes, captions and gains are not in it.
  static func structureKey(_ plan: RenderPlan) -> String {
    var parts: [String] = ["\(plan.fps)|\(plan.duration)"]
    for segment in plan.video.segments {
      parts.append("s\(segment.start)-\(segment.end)")
      for layer in segment.layers {
        parts.append("l\(layer.clipId)|\(layer.assetRef.id)|\(layer.assetRef.kind)|\(layer.srcStart)|\(layer.speed)|\(layer.hold?.frameAt ?? -1)")
      }
    }
    for item in plan.overlays where item.kind == .broll {
      let media = item.media
      parts.append("b\(item.id)|\(item.start)|\(item.end)|\(media?.assetRef.id ?? "")|\(media?.srcStart ?? 0)|\(media?.speed ?? 1)|\(media?.loop ?? false)")
    }
    for entry in plan.audio { parts.append("a\(entry.id)|\(entry.assetRef.id)|\(entry.at)|\(entry.in)|\(entry.out)|\(entry.speed)") }
    return parts.joined(separator: "\n")
  }

  // MARK: Composition

  // swiftlint:disable:next function_body_length cyclomatic_complexity
  static func assemble(_ plan: RenderPlan, media: PreparedMedia, options: PlanBuildOptions = PlanBuildOptions()) throws -> BuiltPlan {
    guard plan.duration > 0, plan.frameCount > 0, let lastSegment = plan.video.segments.last else { throw PlanBuildError.emptyPlan }
    let fps = Int32(plan.fps)
    let frameTime = { (frame: Int64) in CMTime(value: frame, timescale: fps) }
    let planEnd = frameTime(plan.gridFrame(lastSegment.end))

    let composition = AVMutableComposition()
    var videoSlots: [Slot] = []
    func newSlot(_ type: AVMediaType) throws -> Slot {
      guard let track = composition.addMutableTrack(withMediaType: type, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw PlanBuildError.composition("could not add a \(type.rawValue) track")
      }
      return Slot(track: track)
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
        let slot: Slot
        if let free = videoSlots.first(where: { !used.contains(ObjectIdentifier($0)) && $0.cursor <= start }) {
          slot = free
        } else {
          slot = try newSlot(.video)
          videoSlots.append(slot)
        }
        assigned[layerIndex] = slot
        used.insert(ObjectIdentifier(slot))
      }
      var ids = [CMPersistentTrackID?](repeating: nil, count: segment.layers.count)
      for (layerIndex, layer) in segment.layers.enumerated() {
        guard let slot = assigned[layerIndex], let source = media.videos[layer.assetRef.id] else { continue }
        slot.advance(to: start)
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
      guard let itemMedia = item.media, let source = media.videos[itemMedia.assetRef.id] else { continue }
      let start = microseconds(item.start)
      let end = min(microseconds(item.end), planEnd)
      guard end > start else { continue }
      let slot: Slot
      if let free = brollSlots.first(where: { $0.cursor <= start }) {
        slot = free
      } else {
        slot = try newSlot(.video)
        brollSlots.append(slot)
        videoSlots.append(slot)
      }
      slot.advance(to: start)
      try insert(source, into: slot.track, at: start, duration: end - start,
                 srcStart: itemMedia.srcStart, speed: itemMedia.speed, hold: nil, loop: itemMedia.loop ?? false)
      slot.cursor = end
      brollTracks[item.id] = slot.track.trackID
    }

    // Every video track spans the whole timeline, and there is always one, so
    // frames are requested even where nothing but the background shows.
    if videoSlots.isEmpty { videoSlots.append(try newSlot(.video)) }
    for slot in videoSlots { slot.advance(to: planEnd) }

    // Audio on the 48 kHz grid.
    var audioSlots: [Slot] = []
    var audioTracks: [String: CMPersistentTrackID] = [:]
    for entry in plan.audio.sorted(by: { ($0.at, $0.id) < ($1.at, $1.id) }) {
      guard let source = media.audios[entry.assetRef.id], let sourceTrack = source.track else { continue }
      let atSample = sample(entry.at)
      let endSample = sample(entry.end)
      let fromSample = sample(entry.in)
      // The source's last whole sample.
      let sourceEnd = Int64((source.range.end.seconds * audioRate).rounded(.down))
      guard endSample > atSample, sourceEnd > fromSample else { continue }
      // Speed 1 plays exactly the span; other speeds play [in, out) scaled into it.
      let wanted = entry.speed == 1 ? endSample - atSample : sample(entry.out) - fromSample
      let length = min(wanted, sourceEnd - fromSample)
      guard length > 0 else { continue }
      let at = sampleTime(atSample)
      let slot: Slot
      if let free = audioSlots.first(where: { $0.cursor <= at }) {
        slot = free
      } else {
        slot = try newSlot(.audio)
        audioSlots.append(slot)
      }
      slot.advance(to: at)
      do {
        try slot.track.insertTimeRange(CMTimeRange(start: sampleTime(fromSample), duration: sampleTime(length)), of: sourceTrack, at: at)
      } catch {
        throw PlanBuildError.composition("audio \(entry.id): \(error.localizedDescription)")
      }
      var span = sampleTime(length)
      if entry.speed != 1 {
        // A source that runs short keeps the speed and ends early.
        let spanSamples = length == wanted ? endSample - atSample : Int64((Double(length) / entry.speed).rounded())
        span = sampleTime(max(1, spanSamples))
        slot.track.scaleTimeRange(CMTimeRange(start: at, duration: sampleTime(length)), toDuration: span)
      }
      slot.cursor = at + span
      audioTracks[entry.id] = slot.track.trackID
    }

    // A composition, and the audio mix read from it, last only until their
    // last real media; empty edits do not count. Unscaled copies of a short
    // silent WAV fill from the end of all sound to `duration`.
    var carrierTrack: CMPersistentTrackID?
    let soundEnd = audioSlots.map(\.cursor).max() ?? .zero
    if soundEnd < planEnd, let carrier = media.carrier, let carrierSource = carrier.track {
      let slot = try newSlot(.audio)
      slot.advance(to: soundEnd)
      while slot.cursor < planEnd {
        let piece = min(carrier.range.duration, planEnd - slot.cursor)
        try slot.track.insertTimeRange(CMTimeRange(start: carrier.range.start, duration: piece), of: carrierSource, at: slot.cursor)
        slot.cursor = slot.cursor + piece
      }
      carrierTrack = slot.track.trackID
    }

    var sources: [String: ObjectIdentifier] = [:]
    for (id, video) in media.videos { sources["v:" + id] = ObjectIdentifier(video.asset) }
    for (id, audio) in media.audios { sources["a:" + id] = ObjectIdentifier(audio.asset) }
    let layout = CompositionLayout(structureKey: structureKey(plan), layerTracks: layerTracks, brollTracks: brollTracks,
                                   audioTracks: audioTracks, carrierTrack: carrierTrack, sources: sources)
    return try finish(plan, composition: composition, layout: layout, media: media, options: options)
  }

  // MARK: Video composition and audio mix

  // swiftlint:disable:next function_body_length
  private static func finish(_ plan: RenderPlan, composition: AVMutableComposition, layout: CompositionLayout,
                             media: PreparedMedia, options: PlanBuildOptions) throws -> BuiltPlan {
    let fps = Int32(plan.fps)
    let frameTime = { (frame: Int64) in CMTime(value: frame, timescale: fps) }
    let scale = options.renderScale
    let even = { (value: Int) in max(2, Int((CGFloat(value) * scale / 2).rounded()) * 2) }
    let renderSize = CGSize(width: even(plan.size.w), height: even(plan.size.h))

    // Fail now, not mid-export, when a caption face is missing.
    for face in Set(plan.captions.map(\.font)) { _ = try options.fonts.verticalMetrics(face) }
    var drawn: [String: OverlayGraphics.Drawn] = [:]
    for item in plan.overlays {
      if let emoji = item.emoji,
         let bitmap = options.graphics.map({ $0.emoji(emoji, box: item.box, scale: scale) }) ?? OverlayGraphics.emoji(emoji, box: item.box, scale: scale) {
        drawn[item.id] = bitmap
      }
      if let callout = item.callout,
         let bitmap = try options.graphics.map({ try $0.callout(callout, box: item.box, fonts: options.fonts, scale: scale) })
           ?? OverlayGraphics.callout(callout, box: item.box, fonts: options.fonts, scale: scale) {
        drawn[item.id] = bitmap
      }
    }
    let state = PlanRenderState(plan: plan, scale: scale, renderSize: renderSize, media: options.media,
                                captions: options.captions ?? CaptionRenderer(fonts: options.fonts, budgetBytes: options.captionCacheBytes))

    var instructions: [EditifyInstruction] = []
    for (index, segment) in plan.video.segments.enumerated() {
      var layers: [ResolvedLayer] = []
      for (layerIndex, layer) in segment.layers.enumerated() {
        if layer.assetRef.kind == .image, let url = media.images[layer.assetRef.id] {
          // Decoded no larger than the most zoomed cover-fit needs.
          let info = try options.media.info(url)
          let zoom = CGFloat(layer.cropKeys.map(\.scale).max() ?? 1)
          let side = info.longSide(toCover: renderSize.width * zoom, renderSize.height * zoom)
          layers.append(ResolvedLayer(layer: layer, source: .still(url, longSide: side)))
        } else if let id = layout.layerTracks[index][layerIndex], let source = media.videos[layer.assetRef.id] {
          layers.append(ResolvedLayer(layer: layer, source: .track(id, source.orientation)))
        }
      }
      let overlaps = { (from: Double, to: Double) in from < segment.end - RenderPlan.epsilon && to > segment.start + RenderPlan.epsilon }
      var overlays: [ResolvedOverlay] = []
      for item in plan.overlays where overlaps(item.start, item.end) {
        let boxWidth = CGFloat(item.box.w) * scale, boxHeight = CGFloat(item.box.h) * scale
        switch item.kind {
        case .image:
          if let id = item.media?.assetRef.id, let url = media.images[id] {
            let side = try options.media.info(url).longSide(toCover: boxWidth, boxHeight)
            overlays.append(ResolvedOverlay(overlay: item, content: .still(url, longSide: side)))
          }
        case .gif:
          if let id = item.media?.assetRef.id, let url = media.images[id] {
            let gif = try options.media.gif(url)
            overlays.append(ResolvedOverlay(overlay: item, content: .gif(gif, longSide: gif.info.longSide(toCover: boxWidth, boxHeight))))
          }
        case .broll:
          if let id = item.media?.assetRef.id, let track = layout.brollTracks[item.id], let source = media.videos[id] {
            overlays.append(ResolvedOverlay(overlay: item, content: .broll(track, source.orientation)))
          }
        case .emoji, .callout:
          if let bitmap = drawn[item.id] { overlays.append(ResolvedOverlay(overlay: item, content: .drawn(bitmap))) }
        }
      }
      let captions = plan.captions.filter { overlaps($0.start, $0.end) }
      let range = CMTimeRange(start: frameTime(plan.gridFrame(segment.start)), end: frameTime(plan.gridFrame(segment.end)))
      instructions.append(EditifyInstruction(timeRange: range, segmentIndex: index, layers: layers, overlays: overlays, captions: captions, state: state))
    }

    let tags = PlanColorPipeline.tags(plan.color)
    let videoComposition = options.videoComposition.make(
      renderSize: renderSize, frameDuration: CMTime(value: 1, timescale: fps),
      colorPrimaries: tags.primaries, colorTransferFunction: tags.transfer, colorYCbCrMatrix: tags.matrix,
      instructions: instructions)

    // One input per audio track: the ramps of every entry on it.
    var inputs: [CMPersistentTrackID: AVMutableAudioMixInputParameters] = [:]
    for entry in plan.audio {
      guard let id = layout.audioTracks[entry.id], let track = composition.track(withTrackID: id) else { continue }
      let parameters = inputs[id] ?? {
        let made = AVMutableAudioMixInputParameters(track: track)
        made.audioTimePitchAlgorithm = BuiltPlan.audioTimePitchAlgorithm
        inputs[id] = made
        return made
      }()
      for ramp in AudioRamps.ramps(entry) {
        let start = sampleTime(sample(ramp.start)), end = sampleTime(sample(ramp.end))
        guard end > start else { continue }
        parameters.setVolumeRamp(fromStartVolume: Float(ramp.from), toEndVolume: Float(ramp.to), timeRange: CMTimeRange(start: start, end: end))
      }
    }
    if let id = layout.carrierTrack, let track = composition.track(withTrackID: id) {
      let silent = AVMutableAudioMixInputParameters(track: track)
      silent.setVolume(0, at: .zero)
      inputs[id] = silent
    }
    let audioMix = AVMutableAudioMix()
    audioMix.inputParameters = inputs.keys.sorted().compactMap { inputs[$0] }

    return BuiltPlan(plan: plan, composition: composition, videoComposition: videoComposition, audioMix: audioMix,
                     state: state, layout: layout, media: media)
  }

  // MARK: Video edits

  /// The held frame's own PTS, and a sliver short enough never to reach the next frame.
  static func heldFrame(_ source: PreparedMedia.Video, at time: CMTime) -> (start: CMTime, sliver: CMTime) {
    let clamped = min(max(time, source.range.start), source.lastFrameStart)
    // Sample cursors work in MEDIA time; the composition inserts TRACK time.
    // Map through the edit-list segment that shows `clamped`.
    if source.canProvideSampleCursors,
       let segment = source.segments.first(where: { !$0.isEmpty && $0.timeMapping.target.containsTime(clamped) })
        ?? source.segments.last(where: { !$0.isEmpty && $0.timeMapping.target.start <= clamped }) {
      let mapping = segment.timeMapping
      let rate = mapping.target.duration.seconds > 0 ? mapping.source.duration.seconds / mapping.target.duration.seconds : 1
      let toMedia = { (track: CMTime) -> CMTime in
        rate == 1 ? mapping.source.start + (track - mapping.target.start)
          : mapping.source.start + CMTime(seconds: (track - mapping.target.start).seconds * rate, preferredTimescale: 1_000_000_000)
      }
      let toTrack = { (media: CMTime) -> CMTime in
        rate == 1 ? mapping.target.start + (media - mapping.source.start)
          : mapping.target.start + CMTime(seconds: (media - mapping.source.start).seconds / rate, preferredTimescale: 1_000_000_000)
      }
      let mediaTime = toMedia(clamped)
      if let cursor = source.track.makeSampleCursor(presentationTimeStamp: mediaTime) {
        if cursor.presentationTimeStamp > mediaTime { _ = cursor.stepInPresentationOrder(byCount: -1) }
        let pts = cursor.presentationTimeStamp
        let next = cursor.copy() as! AVSampleCursor
        let nextPTS = next.stepInPresentationOrder(byCount: 1) == 1 && next.presentationTimeStamp > pts ? next.presentationTimeStamp : nil
        // The frame may have started before this edit: it shows from the edit's start.
        let start = max(toTrack(pts), mapping.target.start)
        let gap = nextPTS.map { toTrack($0) - start } ?? source.frameDuration
        if gap > .zero { return sliver(after: start, gap: gap) }
      }
    }
    return sliver(after: clamped, gap: source.frameDuration)
  }

  /// A sliver inside [pts, pts + gap): it starts a microsecond (at most a
  /// quarter of the gap) after the PTS, the sampling rule's bias, because a
  /// stretched edit that starts exactly on a frame boundary can map back a
  /// hair before it and show the previous frame; it ends by half the gap.
  private static func sliver(after pts: CMTime, gap: CMTime) -> (start: CMTime, sliver: CMTime) {
    let bias = min(CMTime(value: 1, timescale: 1_000_000), CMTimeMultiplyByRatio(gap, multiplier: 1, divisor: 4))
    let length = min(holdSliver, CMTimeMultiplyByRatio(gap, multiplier: 1, divisor: 2) - bias)
    return (pts + bias, length)
  }

  /// Places source time srcStart (+ (t - at) * speed) on `track` over [at, at + duration).
  static func insert(_ source: PreparedMedia.Video, into track: AVMutableCompositionTrack, at: CMTime, duration: CMTime,
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
      let held = heldFrame(source, at: frameStart)
      try place(CMTimeRange(start: held.start, duration: held.sliver), at: time, over: span)
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
      // Speed 1 takes exactly the span (no scaling); others on the microsecond grid.
      let wanted = speed == 1 ? remaining : CMTime(seconds: remaining.seconds * speed, preferredTimescale: 1_000_000)
      let available = source.range.end - from
      if available >= wanted {
        try place(CMTimeRange(start: from, duration: wanted), at: cursor, over: remaining)
        return
      }
      if available > .zero {
        let span = speed == 1 ? available : CMTime(seconds: available.seconds / speed, preferredTimescale: 1_000_000)
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
/// Gains are 0...1 (the schema caps gainKeys at 1, matching AVAudioMix).
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

/// A short silent WAV, written once per process: the carrier copied (never
/// stretched) after the last sound. PCM in a WAV needs no encoder.
enum PlanCarrier {
  private static let lock = NSLock()
  static let seconds: UInt32 = 2

  static func silence() throws -> URL {
    lock.lock(); defer { lock.unlock() }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("editify-carrier-silence-v2.wav")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let rate: UInt32 = 48_000, frames: UInt32 = 48_000 * seconds
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

/// The mix ends where the plan ends. AVPlayerItem stops at the composition's
/// duration on its own, but an AVAssetReaderAudioMixOutput does not: spectral
/// time-pitch emits a block past the end of a sped-up entry (2048 samples at
/// 2x), and setting the reader's timeRange does not stop it. Every reader of
/// the mix (export, the parity harness) passes its buffers through `trim`.
enum PlanMixTrim {
  /// The part of `buffer` before `end`; nil when it starts at or after it.
  static func trim(_ buffer: CMSampleBuffer, end: CMTime) -> CMSampleBuffer? {
    let start = CMSampleBufferGetPresentationTimeStamp(buffer)
    guard start < end else { return nil }
    let count = CMSampleBufferGetNumSamples(buffer)
    guard let format = CMSampleBufferGetFormatDescription(buffer),
          let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee, description.mSampleRate > 0 else { return buffer }
    let keep = Int(((end - start).seconds * description.mSampleRate).rounded())
    guard keep < count else { return buffer }
    guard keep > 0 else { return nil }
    var trimmed: CMSampleBuffer?
    CMSampleBufferCopySampleBufferForRange(allocator: nil, sampleBuffer: buffer, sampleRange: CFRange(location: 0, length: keep), sampleBufferOut: &trimmed)
    return trimmed
  }
}
