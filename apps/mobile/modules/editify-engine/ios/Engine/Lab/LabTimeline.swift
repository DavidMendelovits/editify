import AVFoundation

/// A clip's static crop, with the schema's crop-key semantics (AnalysisMath.cropPlacement):
/// `scale` ≥ 1 zooms in, `x`/`y` in -1…1 pan the crop window (-1 = left/top edge, 0 = centred).
struct LayerCrop {
  var scale = 1.0
  var x = 0.0
  var y = 0.0
}

/// A lab timeline: one source cut into `clips` back-to-back pieces that alternate
/// between two video tracks (A/B), so neighbours overlap for a crossfade, with a
/// punch-in on every clip and a sticker-sized card over everything. S1, S2, S3 and
/// the S11 crop frames run on it.
///
/// D9: it is a small RenderPlan fixture, built by PlanBuilder and drawn by
/// EditifyCompositor (the finished renderer), so the lab measures the code the app ships.
///
///   LabTimeline ─plan(sourceSeconds:)─▶ RenderPlan ─PlanBuilder.build─▶ BuiltPlan
///     solo segment per clip (crop keys 1 → punchIn)
///     dissolve segment where neighbours overlap (incoming opacity 0 → 1, on top)
///     callout card overlay for the whole plan (the cost stand-in for a bitmap sticker)
///
/// Times are whole frames (segment edges sit on the 1/fps grid), so a 0.25 s fade at
/// 30 fps is 8 frames. When the source has sound, every even clip carries its audio (an
/// audio entry over the clip's source range), as the old CompositionBuilder's composition
/// did: the spikes play muted, but the decode load of S1/S2/S3 matches the lab plan's.
struct LabTimeline {
  var clips = 2
  var clipSeconds = 5.0
  var crossfadeSeconds = 0.5
  var punchIn = 1.15
  var renderSize = CGSize(width: 1080, height: 1920)
  var frameRate = 30
  var overlay = true
  /// Static crop on every clip (OV8: framing an off-centre face).
  var crop = LayerCrop()

  static let sourceId = "lab-source"

  /// The fixture as a decoded, validated RenderPlan.
  func plan(sourceSeconds: Double, color: RenderPlan.OutputColor = .sdr, revision: Int = 1, hasAudio: Bool = false) throws -> RenderPlan {
    let fps = frameRate
    let clip = max(1, Int((clipSeconds * Double(fps)).rounded()))
    let fade = max(0, Int((crossfadeSeconds * Double(fps)).rounded()))
    let step = clip - fade
    let seconds = { (frame: Int) in Double(frame) / Double(fps) }
    let width = Self.even(renderSize.width), height = Self.even(renderSize.height)

    // Wrap around the source so any clip count works with a short fixture.
    let maxStart = max(0, sourceSeconds - clipSeconds)
    let sourceStart = { (index: Int) in maxStart > 0 ? (Double(index) * 1.7).truncatingRemainder(dividingBy: maxStart) : 0 }

    func layer(_ index: Int, z: Int, from: Int, to: Int, scale: (Double, Double), opacity: (Double, Double)?) -> [String: Any] {
      let start = index * step
      let key = { (frame: Int, s: Double) -> [String: Any] in ["t": seconds(frame), "scale": crop.scale * s, "x": crop.x, "y": crop.y] }
      return [
        "clipId": "c\(index)",
        "trackIndex": index % 2,
        "z": z,
        "assetRef": ["id": Self.sourceId, "kind": "video"],
        "srcStart": sourceStart(index) + seconds(from - start),
        "speed": 1,
        "cropKeys": [key(from, scale.0), key(to, scale.1)],
        "opacityKeys": opacity.map { [["t": seconds(from), "value": $0.0], ["t": seconds(to), "value": $0.1]] } ?? [],
        "dimKeys": [],
      ]
    }

    var segments: [[String: Any]] = []
    for index in 0..<clips {
      let start = index * step
      let soloStart = index == 0 ? start : start + fade
      let soloEnd = index == clips - 1 ? start + clip : start + step
      if soloEnd > soloStart {
        segments.append(["start": seconds(soloStart), "end": seconds(soloEnd), "layers": [
          layer(index, z: 0, from: soloStart, to: soloEnd, scale: (1, punchIn), opacity: nil),
        ]])
      }
      if index < clips - 1, fade > 0 {
        segments.append(["start": seconds(start + step), "end": seconds(start + clip), "layers": [
          layer(index, z: 0, from: start + step, to: start + clip, scale: (punchIn, punchIn), opacity: nil),
          layer(index + 1, z: 1, from: start + step, to: start + clip, scale: (1, 1), opacity: (0, 1)),
        ]])
      }
    }
    let total = (clips - 1) * step + clip

    // Even clips carry the source's sound over their whole range (CompositionBuilder's audio track).
    var audio: [[String: Any]] = []
    if hasAudio {
      for index in stride(from: 0, to: clips, by: 2) {
        let from = sourceStart(index)
        let length = min(seconds(clip), max(0, sourceSeconds - from))
        guard length > 0 else { continue }
        audio.append([
          "id": "lab-audio-\(index)", "clipId": "c\(index)", "assetRef": ["id": Self.sourceId, "kind": "video"],
          "at": seconds(index * step), "in": from, "out": from + length, "speed": 1,
          "gainKeys": [["t": 0, "gain": 1]],
          "fadeIn": ["duration": 0.008, "curve": "halfSine"], "fadeOut": ["duration": 0.008, "curve": "halfSine"],
        ])
      }
    }

    var overlays: [[String: Any]] = []
    if overlay {
      let side = (Double(width) * 0.3).rounded()
      overlays.append([
        "id": "lab-sticker", "kind": "callout", "z": 0, "start": 0, "end": seconds(total),
        // The box is centre-anchored: the old lab card's spot, 0.6 W from the left and 0.3 H up from the bottom edge.
        "box": ["x": Double(width) * 0.6 + side / 2, "y": Double(height) * 0.3 - side / 2, "w": side, "h": side, "rotationDeg": 0],
        "callout": [
          "variant": "card",
          "card": ["x": 0, "y": 0, "w": side, "h": side, "radiusPx": 0, "color": "#FFCC1AD9"],
          "label": ["text": "LAB", "font": PlanFontFace.montserratBold.rawValue, "sizePx": side * 0.2,
                    "x": side * 0.1, "y": side * 0.6, "width": side * 0.8, "color": "#000000"],
        ],
      ])
    }

    let json: [String: Any] = [
      "version": RenderPlan.version, "requires": [], "revision": revision, "buildSeq": revision,
      "size": ["w": width, "h": height], "fps": fps, "duration": seconds(total),
      "color": color.rawValue, "background": "#000000",
      "loudness": ["deadbandLu": 1, "silentBelowLufs": -70, "limiterCeilingDb": -1, "truePeakLimitDb": -1],
      "video": ["segments": segments], "overlays": overlays, "captions": [], "audio": audio,
    ]
    return try RenderPlan.decode(JSONSerialization.data(withJSONObject: json))
  }

  /// Builds the fixture over `asset` through PlanBuilder. HLG sources keep an HLG plan.
  func build(asset: AVAsset, revision: Int = 1) async throws -> BuiltPlan {
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw SpikeError(message: "asset has no video track") }
    let duration = try await asset.load(.duration).seconds
    let hasAudio = try await !asset.loadTracks(withMediaType: .audio).isEmpty
    let plan = try plan(sourceSeconds: duration, color: try await Self.color(of: track), revision: revision, hasAudio: hasAudio)
    return try await PlanBuilder.build(plan, resolver: Self.resolver(asset), options: PlanBuildOptions(videoComposition: EngineAdapters.current.videoComposition))
  }

  /// A parameter-only edit (crop keys, opacity): the same composition with a new video
  /// composition, as PlanPlayer applies one. nil when the edit changed the structure.
  func update(_ built: BuiltPlan, revision: Int) async throws -> BuiltPlan? {
    guard let asset = built.media.videos[Self.sourceId]?.asset else { return nil }
    let hasAudio = try await !asset.loadTracks(withMediaType: .audio).isEmpty
    let plan = try plan(sourceSeconds: try await asset.load(.duration).seconds, color: built.plan.color, revision: revision, hasAudio: hasAudio)
    return try PlanBuilder.update(built, to: plan, options: PlanBuildOptions(videoComposition: EngineAdapters.current.videoComposition))
  }

  static func resolver(_ asset: AVAsset) -> PlanAssetResolver {
    PlanAssetResolver(
      asset: { ref in
        guard ref.id == sourceId else { throw SpikeError(message: "the lab plan names only \(sourceId), not \(ref.id)") }
        return asset
      },
      imageFile: { ref in throw SpikeError(message: "the lab plan has no image \(ref.id)") })
  }

  /// HLG in, HLG out (the old lab compositor carried the source's tags through); else SDR.
  static func color(of track: AVAssetTrack) async throws -> RenderPlan.OutputColor {
    guard let description = try await track.load(.formatDescriptions).first,
          let extensions = CMFormatDescriptionGetExtensions(description) as? [String: Any] else { return .sdr }
    let transfer = extensions[kCVImageBufferTransferFunctionKey as String] as? String
    return transfer == (kCVImageBufferTransferFunction_ITU_R_2100_HLG as String) ? .hlg : .sdr
  }

  static func even(_ value: CGFloat) -> Int { max(2, Int((value / 2).rounded()) * 2) }
}
