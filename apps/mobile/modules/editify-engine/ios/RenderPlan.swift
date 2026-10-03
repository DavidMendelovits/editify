import CoreGraphics
import Foundation

/// RenderPlan v1 as the native executor reads it: Codable mirrors of
/// packages/shared/src/render-plan-schema.ts (the frozen contract; its doc
/// comments are the spec). Swift executes the plan and decides nothing: if a
/// layout or timing value is missing here, the schema is missing a field.
///
/// Decoding ignores unknown keys (Codable's default), as SCHEMA EVOLUTION
/// requires. `RenderPlan.decode` refuses a wrong `version`, any `requires`
/// feature this executor does not draw, anything over PLAN_LIMITS, and the
/// structural rules the executor leans on (segment tiling, key order, spans).
struct RenderPlan: Decodable, Sendable {
  /// The schema version this executor implements (RENDER_PLAN_VERSION).
  static let version = 1
  /// Critical features beyond v1 this executor draws (RENDER_PLAN_FEATURES on the TS side). Empty for v1.
  static let supportedFeatures: [String] = []
  /// RENDER_PLAN_EPSILON: float slack for builder-computed times.
  static let epsilon = 1e-6

  let version: Int
  let requires: [String]
  let revision: Int
  let buildSeq: Int
  let size: Size
  let fps: Int
  let duration: Double
  let color: OutputColor
  let background: PlanColor
  let loudness: Loudness
  let video: Video
  let overlays: [Overlay]
  let captions: [Caption]
  let audio: [AudioEntry]

  struct Size: Decodable, Sendable { let w: Int; let h: Int }

  enum OutputColor: String, Decodable, Sendable { case sdr, hlg }

  struct Loudness: Decodable, Sendable {
    let targetLufs: Double?
    let deadbandLu: Double
    let silentBelowLufs: Double
    let limiterCeilingDb: Double
    let truePeakLimitDb: Double
  }

  struct Video: Decodable, Sendable { let segments: [Segment] }

  struct AssetRef: Decodable, Sendable, Hashable {
    enum Kind: String, Decodable, Sendable { case video, audio, image }
    let id: String
    let kind: Kind
  }

  /// One crop/zoom pose; the convention is the schema's (AnalysisMath.cropPlacement implements it).
  struct CropKey: Decodable, Sendable { let t: Double; let scale: Double; let x: Double; let y: Double }
  struct UnitKey: Decodable, Sendable { let t: Double; let value: Double }
  struct Hold: Decodable, Sendable { let frameAt: Double }

  struct Layer: Decodable, Sendable {
    let clipId: String
    let trackIndex: Int
    let z: Int
    let assetRef: AssetRef
    let srcStart: Double
    let speed: Double
    let cropKeys: [CropKey]
    let opacityKeys: [UnitKey]
    let dimKeys: [UnitKey]
    let hold: Hold?
  }

  struct Segment: Decodable, Sendable {
    let start: Double
    let end: Double
    let layers: [Layer]
  }

  struct Box: Decodable, Sendable { let x: Double; let y: Double; let w: Double; let h: Double; let rotationDeg: Double }

  struct OverlayMedia: Decodable, Sendable {
    let assetRef: AssetRef
    let srcStart: Double
    let speed: Double
    let loop: Bool?
  }

  struct Emoji: Decodable, Sendable {
    let text: String
    let sizePx: Double
    let x: Double
    let y: Double
    let width: Double
  }

  struct Callout: Decodable, Sendable {
    enum Variant: String, Decodable, Sendable { case check, x, card }
    struct Card: Decodable, Sendable { let x: Double; let y: Double; let w: Double; let h: Double; let radiusPx: Double; let color: PlanColor }
    struct Glyph: Decodable, Sendable {
      enum Shape: String, Decodable, Sendable { case check, cross }
      let shape: Shape
      let x: Double; let y: Double; let w: Double; let h: Double
      let strokePx: Double
      let color: PlanColor
    }
    struct Label: Decodable, Sendable {
      let text: String
      let font: PlanFontFace
      let sizePx: Double
      let x: Double
      let y: Double
      let width: Double
      let color: PlanColor
    }
    let variant: Variant
    let card: Card
    let glyph: Glyph?
    let label: Label
  }

  struct Overlay: Decodable, Sendable {
    enum Kind: String, Decodable, Sendable { case image, gif, emoji, callout, broll }
    let id: String
    let kind: Kind
    let z: Int
    let start: Double
    let end: Double
    let box: Box
    let media: OverlayMedia?
    let emoji: Emoji?
    let callout: Callout?
    /// For executors that cannot draw the payload. This one draws it, so the raster is never resolved.
    let raster: AssetRef?
  }

  struct Word: Decodable, Sendable { let w: String; let s: Double; let e: Double; let x: Double }

  struct Line: Decodable, Sendable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let words: [Word]?
  }

  struct Shadow: Decodable, Sendable { let color: PlanColor; let opacity: Double; let offsetPx: Double }
  struct CaptionBox: Decodable, Sendable { let color: PlanColor; let opacity: Double; let padPx: Double; let radiusPx: Double }
  struct Fitted: Decodable, Sendable { let shrunk: Bool; let scale: Double }

  struct Caption: Decodable, Sendable {
    enum Align: String, Decodable, Sendable { case left, center, right }
    let id: String
    let rev: String
    let start: Double
    let end: Double
    let lane: Int
    let font: PlanFontFace
    let sizePx: Double
    let color: PlanColor
    let strokeColor: PlanColor
    let strokePx: Double
    let emphasisColor: PlanColor
    let shadow: Shadow?
    let box: CaptionBox?
    let align: Align
    let lines: [Line]
    let fitted: Fitted
  }

  struct Fade: Decodable, Sendable {
    enum Curve: String, Decodable, Sendable { case linear, halfSine }
    let duration: Double
    let curve: Curve
  }

  struct GainKey: Decodable, Sendable { let t: Double; let gain: Double }

  struct AudioEntry: Decodable, Sendable {
    let id: String
    let clipId: String
    let assetRef: AssetRef
    let at: Double
    let `in`: Double
    let out: Double
    let speed: Double
    let gainKeys: [GainKey]
    let fadeIn: Fade
    let fadeOut: Fade

    /// Timeline second the entry stops playing (audioEntryEnd).
    var end: Double { at + (out - `in`) / speed }
  }
}

/// PLAN_FONT_FACES: the PostScript names of the bundled font files.
enum PlanFontFace: String, Decodable, Sendable, CaseIterable {
  case montserratBold = "Montserrat-Bold"
}

/// A `#RRGGBB` or `#RRGGBBAA` colour, sRGB-encoded (BT.709 primaries, sRGB transfer).
struct PlanColor: Decodable, Sendable, Hashable {
  let red: CGFloat
  let green: CGFloat
  let blue: CGFloat
  let alpha: CGFloat

  init(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat = 1) {
    self.red = red; self.green = green; self.blue = blue; self.alpha = alpha
  }

  init(from decoder: Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    guard let parsed = PlanColor(hex: text) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "expected a #RRGGBB or #RRGGBBAA colour"))
    }
    self = parsed
  }

  init?(hex: String) {
    let digits = Array(hex.utf8)
    guard digits.first == UInt8(ascii: "#"), digits.count == 7 || digits.count == 9 else { return nil }
    var bytes: [CGFloat] = []
    var index = 1
    while index < digits.count {
      guard let value = UInt8(String(decoding: digits[index..<index + 2], as: UTF8.self), radix: 16) else { return nil }
      bytes.append(CGFloat(value) / 255)
      index += 2
    }
    self.init(red: bytes[0], green: bytes[1], blue: bytes[2], alpha: bytes.count == 4 ? bytes[3] : 1)
  }

  /// The colour in sRGB, for Core Graphics drawing.
  var cgColor: CGColor {
    CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [red, green, blue, alpha])!
  }
}

/// PLAN_LIMITS from render-plan-schema.ts: hard caps on hostile input.
enum PlanLimits {
  static let longSidePx = 3840
  static let shortSidePx = 2160
  static let durationSec = 4.0 * 60 * 60
  static let textChars = 500
  static let idChars = 128
  static let requires = 32
  static let segments = 20_000
  static let layersPerSegment = 32
  static let keys = 50_000
  static let overlays = 2_000
  static let captions = 10_000
  static let linesPerCaption = 12
  static let wordsPerLine = 200
  static let audio = 2_000
  /// Not in PLAN_LIMITS: a byte cap checked before JSON parsing, so a hostile
  /// payload is refused before it is materialised. A plan at every array cap
  /// is far smaller than this.
  static let planBytes = 64 << 20
}

enum RenderPlanError: Error, LocalizedError, Equatable {
  case unsupportedVersion(Int)
  /// The plan requires features this executor does not draw (bounded list, names truncated).
  case unsupportedFeatures([String])
  case overLimit(String)
  case invalid(String)
  case tooLarge(Int)

  var errorDescription: String? {
    switch self {
    case .unsupportedVersion(let version): return "Render plan version \(version) is not supported (this renderer draws v\(RenderPlan.version))"
    case .unsupportedFeatures(let names): return "This renderer cannot draw a plan that requires: \(names.joined(separator: ", "))"
    case .overLimit(let what): return "Render plan over its limits: \(what)"
    case .invalid(let what): return "Invalid render plan: \(what)"
    case .tooLarge(let bytes): return "Render plan is \(bytes) bytes, over the \(PlanLimits.planBytes) byte cap"
    }
  }
}

extension RenderPlan {
  /// The executor's parse: byte cap, version, `requires`, then the full decode
  /// (unknown keys ignored) and validation.
  static func decode(_ data: Data, supported: [String] = RenderPlan.supportedFeatures) throws -> RenderPlan {
    guard data.count <= PlanLimits.planBytes else { throw RenderPlanError.tooLarge(data.count) }
    struct Head: Decodable { let version: Int?; let requires: [String]? }
    let head: Head
    do { head = try JSONDecoder().decode(Head.self, from: data) } catch { throw RenderPlanError.invalid("not a plan object: \(error)") }
    guard let version = head.version else { throw RenderPlanError.invalid("missing version") }
    guard version == RenderPlan.version else { throw RenderPlanError.unsupportedVersion(version) }
    let requires = head.requires ?? []
    guard requires.count <= PlanLimits.requires else { throw RenderPlanError.overLimit("requires has \(requires.count) entries (max \(PlanLimits.requires))") }
    let missing = requires.filter { !supported.contains($0) }
    if !missing.isEmpty {
      throw RenderPlanError.unsupportedFeatures(missing.prefix(5).map { $0.count > 64 ? String($0.prefix(64)) + "..." : $0 })
    }
    let plan: RenderPlan
    do { plan = try JSONDecoder().decode(RenderPlan.self, from: data) } catch { throw RenderPlanError.invalid(String(describing: error)) }
    try plan.validate()
    return plan
  }

  /// Output frames: ceil(duration * fps - 1e-6) (planFrameCount).
  var frameCount: Int { max(0, Int((duration * Double(fps) - RenderPlan.epsilon).rounded(.up))) }

  /// The frame index of a time already on the 1/fps grid (segment edges).
  func gridFrame(_ t: Double) -> Int64 { Int64((t * Double(fps)).rounded()) }

  // MARK: Validation

  // swiftlint:disable:next cyclomatic_complexity function_body_length
  func validate() throws {
    func limit(_ ok: Bool, _ what: @autoclosure () -> String) throws { if !ok { throw RenderPlanError.overLimit(what()) } }
    func check(_ ok: Bool, _ what: @autoclosure () -> String) throws { if !ok { throw RenderPlanError.invalid(what()) } }
    func id(_ value: String, _ what: String) throws {
      try check(!value.isEmpty, "\(what) is empty")
      try limit(value.count <= PlanLimits.idChars, "\(what) is over \(PlanLimits.idChars) characters")
    }
    func text(_ value: String, _ what: String) throws {
      try check(!value.isEmpty, "\(what) is empty")
      try limit(value.count <= PlanLimits.textChars, "\(what) is over \(PlanLimits.textChars) characters")
    }
    func finite(_ values: Double..., what: String) throws { try check(values.allSatisfy(\.isFinite), "\(what) is not finite") }
    func seconds(_ value: Double, _ what: String) throws { try check(value.isFinite && value >= 0, "\(what) must be a time >= 0") }
    func keys(_ times: [Double], from: Double, to: Double, _ what: String) throws {
      try limit(times.count <= PlanLimits.keys, "\(what) has more than \(PlanLimits.keys) keys")
      var previous = -Double.infinity
      for time in times {
        try seconds(time, what)
        try check(time >= from - RenderPlan.epsilon && time <= to + RenderPlan.epsilon, "\(what) key at \(time) is outside [\(from), \(to)]")
        try check(time > previous, "\(what) keys must strictly increase")
        previous = time
      }
    }
    func speed(_ value: Double, _ what: String) throws { try check(value.isFinite && value >= 0.1 && value <= 8, "\(what) speed \(value) is outside 0.1...8") }
    func ref(_ value: AssetRef, _ what: String) throws { try id(value.id, "\(what) asset id") }

    for feature in requires { try id(feature, "a required feature") }
    try check(size.w > 0 && size.h > 0 && size.w % 2 == 0 && size.h % 2 == 0, "size must be positive and even")
    try limit(max(size.w, size.h) <= PlanLimits.longSidePx && min(size.w, size.h) <= PlanLimits.shortSidePx,
              "size \(size.w)x\(size.h) is over \(PlanLimits.longSidePx)x\(PlanLimits.shortSidePx)")
    try check(fps >= 1 && fps <= 120, "fps \(fps) is outside 1...120")
    try seconds(duration, "duration")
    try limit(duration <= PlanLimits.durationSec, "duration \(duration) s is over \(PlanLimits.durationSec) s")
    try finite(loudness.deadbandLu, loudness.silentBelowLufs, loudness.limiterCeilingDb, loudness.truePeakLimitDb, what: "loudness")
    if let target = loudness.targetLufs { try finite(target, what: "targetLufs") }
    try limit(video.segments.count <= PlanLimits.segments, "more than \(PlanLimits.segments) segments")
    try limit(overlays.count <= PlanLimits.overlays, "more than \(PlanLimits.overlays) overlays")
    try limit(captions.count <= PlanLimits.captions, "more than \(PlanLimits.captions) captions")
    try limit(audio.count <= PlanLimits.audio, "more than \(PlanLimits.audio) audio entries")

    // Segments tile [0, duration] on the frame grid with exact joins.
    try check(duration > 0 || video.segments.isEmpty, "a plan with duration 0 has no segments")
    try check(duration == 0 || !video.segments.isEmpty, "segments must cover [0, duration]")
    var cursor = 0.0
    let onGrid = { (time: Double) in abs(time * Double(fps) - (time * Double(fps)).rounded()) <= RenderPlan.epsilon }
    for (index, segment) in video.segments.enumerated() {
      try check(segment.start == cursor, "segment \(index) starts at \(segment.start), not at \(cursor)")
      try check(segment.end > segment.start, "segment \(index) is empty")
      try check(onGrid(segment.end), "segment \(index) ends off the 1/\(fps) s grid")
      try limit(segment.layers.count <= PlanLimits.layersPerSegment, "segment \(index) has more than \(PlanLimits.layersPerSegment) layers")
      var zs = Set<Int>()
      for layer in segment.layers {
        try id(layer.clipId, "layer clipId")
        try ref(layer.assetRef, "layer")
        try check(layer.assetRef.kind != .audio, "a video layer draws a video or image asset")
        try check(zs.insert(layer.z).inserted, "segment \(index) repeats z \(layer.z)")
        try check(layer.trackIndex >= 0, "trackIndex must be >= 0")
        try seconds(layer.srcStart, "layer srcStart")
        try speed(layer.speed, "layer")
        try check(!layer.cropKeys.isEmpty, "a layer needs at least one crop key")
        try keys(layer.cropKeys.map(\.t), from: segment.start, to: segment.end, "cropKeys")
        for key in layer.cropKeys {
          try check(key.scale.isFinite && key.scale >= 1 && key.scale <= 10, "crop scale \(key.scale) is outside 1...10")
          try check(key.x.isFinite && abs(key.x) <= 1 && key.y.isFinite && abs(key.y) <= 1, "crop pan is outside -1...1")
        }
        for (name, ramp) in [("opacityKeys", layer.opacityKeys), ("dimKeys", layer.dimKeys)] {
          try keys(ramp.map(\.t), from: segment.start, to: segment.end, name)
          try check(ramp.allSatisfy { $0.value.isFinite && $0.value >= 0 && $0.value <= 1 }, "\(name) values must be 0...1")
        }
        if let hold = layer.hold { try seconds(hold.frameAt, "hold frameAt") }
      }
      cursor = segment.end
    }
    try check(video.segments.isEmpty || cursor == duration, "the last segment ends at \(cursor), not at duration \(duration)")

    var overlayZ = Set<Int>(), overlayIds = Set<String>()
    for item in overlays {
      try id(item.id, "overlay id")
      try check(overlayIds.insert(item.id).inserted, "overlay id \(item.id) appears twice")
      try check(overlayZ.insert(item.z).inserted, "overlays share z \(item.z)")
      try seconds(item.start, "overlay start")
      try seconds(item.end, "overlay end")
      try check(item.end > item.start && item.end <= duration + RenderPlan.epsilon, "overlay \(item.id) span is empty or past the duration")
      try finite(item.box.x, item.box.y, item.box.rotationDeg, what: "overlay box")
      try check(item.box.w.isFinite && item.box.w > 0 && item.box.h.isFinite && item.box.h > 0, "overlay box size must be positive")
      try check(abs(item.box.rotationDeg) <= 180, "overlay rotation is outside -180...180")
      let mediaKind: AssetRef.Kind? = switch item.kind {
      case .image, .gif: .image
      case .broll: .video
      case .emoji, .callout: nil
      }
      if let mediaKind {
        guard let media = item.media else { throw RenderPlanError.invalid("a \(item.kind.rawValue) overlay needs media") }
        try ref(media.assetRef, "overlay")
        try check(media.assetRef.kind == mediaKind, "a \(item.kind.rawValue) overlay needs a \(mediaKind.rawValue) asset")
        try seconds(media.srcStart, "overlay srcStart")
        try speed(media.speed, "overlay")
      } else {
        try check(item.media == nil, "a \(item.kind.rawValue) overlay carries no media")
      }
      try check((item.kind == .emoji) == (item.emoji != nil), "only an emoji overlay carries an emoji payload")
      try check((item.kind == .callout) == (item.callout != nil), "only a callout overlay carries a callout payload")
      if let emoji = item.emoji {
        try text(emoji.text, "emoji text")
        try finite(emoji.x, emoji.y, emoji.width, what: "emoji")
        try check(emoji.sizePx.isFinite && emoji.sizePx > 0, "emoji size must be positive")
      }
      if let callout = item.callout {
        try text(callout.label.text, "callout label")
        try check(callout.label.sizePx.isFinite && callout.label.sizePx > 0, "callout label size must be positive")
        try finite(callout.card.x, callout.card.y, callout.label.x, callout.label.y, what: "callout")
        try check(callout.card.w.isFinite && callout.card.w > 0 && callout.card.h.isFinite && callout.card.h > 0, "callout card size must be positive")
        try check(callout.card.radiusPx.isFinite && callout.card.radiusPx >= 0, "callout radius must be >= 0")
        try check(callout.label.width.isFinite && callout.label.width >= 0, "callout label width must be >= 0")
        if let glyph = callout.glyph {
          try finite(glyph.x, glyph.y, what: "callout glyph")
          try check(glyph.w.isFinite && glyph.w > 0 && glyph.h.isFinite && glyph.h > 0, "callout glyph size must be positive")
          try check(glyph.strokePx.isFinite && glyph.strokePx > 0, "callout glyph stroke must be positive")
        }
        let want: Callout.Glyph.Shape? = callout.variant == .check ? .check : callout.variant == .x ? .cross : nil
        try check(callout.glyph?.shape == want, "a \(callout.variant.rawValue) callout's glyph does not match its variant")
      }
      if let raster = item.raster { try ref(raster, "raster") }
    }

    var captionIds = Set<String>()
    for item in captions {
      try id(item.id, "caption id")
      try id(item.rev, "caption rev")
      try check(captionIds.insert(item.id).inserted, "caption id \(item.id) appears twice")
      try seconds(item.start, "caption start")
      try seconds(item.end, "caption end")
      try check(item.end > item.start && item.end <= duration + RenderPlan.epsilon, "caption \(item.id) span is empty or past the duration")
      try check(item.lane >= 0, "caption lane must be >= 0")
      try check(item.sizePx.isFinite && item.sizePx > 0, "caption size must be positive")
      try check(item.strokePx.isFinite && item.strokePx >= 0, "caption stroke must be >= 0")
      if let shadow = item.shadow {
        try check(shadow.offsetPx.isFinite && shadow.offsetPx >= 0 && shadow.opacity.isFinite && (0...1).contains(shadow.opacity), "caption shadow is out of range")
      }
      if let box = item.box {
        try check(box.padPx.isFinite && box.padPx >= 0 && box.radiusPx.isFinite && box.radiusPx >= 0 && box.opacity.isFinite && (0...1).contains(box.opacity),
                  "caption box is out of range")
      }
      try check(item.fitted.scale.isFinite && item.fitted.scale > 0 && item.fitted.scale <= 1, "caption fitted scale is out of range")
      try check(!item.lines.isEmpty, "a caption has at least one line")
      try limit(item.lines.count <= PlanLimits.linesPerCaption, "caption \(item.id) has more than \(PlanLimits.linesPerCaption) lines")
      let karaoke = item.lines.filter { $0.words != nil }.count
      try check(karaoke == 0 || karaoke == item.lines.count, "either every line of a caption has words or none does")
      for line in item.lines {
        try text(line.text, "caption line")
        try finite(line.x, line.y, line.width, what: "caption line")
        if let words = line.words {
          try check(!words.isEmpty, "a karaoke line has words")
          try limit(words.count <= PlanLimits.wordsPerLine, "a caption line has more than \(PlanLimits.wordsPerLine) words")
          for word in words {
            try text(word.w, "karaoke word")
            try seconds(word.s, "word start")
            try seconds(word.e, "word end")
            try finite(word.x, what: "word x")
          }
        }
      }
    }

    var audioIds = Set<String>()
    for entry in audio {
      try id(entry.id, "audio id")
      try id(entry.clipId, "audio clipId")
      try ref(entry.assetRef, "audio")
      try check(audioIds.insert(entry.id).inserted, "audio id \(entry.id) appears twice")
      try check(entry.assetRef.kind != .image, "an audio entry needs a video or audio asset")
      try seconds(entry.at, "audio at")
      try seconds(entry.in, "audio in")
      try seconds(entry.out, "audio out")
      try check(entry.out > entry.in, "audio out must be after in")
      try speed(entry.speed, "audio")
      try check(entry.end <= duration + RenderPlan.epsilon, "audio entry \(entry.id) ends past the duration")
      try check(!entry.gainKeys.isEmpty, "an audio entry has at least one gain key")
      try keys(entry.gainKeys.map(\.t), from: entry.at, to: entry.end, "gainKeys")
      try check(entry.gainKeys.allSatisfy { $0.gain.isFinite && $0.gain >= 0 && $0.gain <= 1 }, "gain must be 0...1")
      for fade in [entry.fadeIn, entry.fadeOut] {
        try seconds(fade.duration, "fade duration")
        try check(fade.duration <= entry.end - entry.at + RenderPlan.epsilon, "a fade is longer than its entry")
      }
    }
  }
}

/// Keyframe lookup shared by the compositor and the audio mix: linear between
/// neighbours, first/last value held outside the keys (schema: Keyframes).
enum PlanKeys {
  static func value(at t: Double, times: [Double], values: [Double], empty: Double) -> Double {
    guard let first = times.first, let last = times.last else { return empty }
    if t <= first { return values[0] }
    if t >= last { return values[values.count - 1] }
    // Binary search: the last key at or before t.
    var low = 0, high = times.count - 1
    while high - low > 1 {
      let mid = (low + high) / 2
      if times[mid] <= t { low = mid } else { high = mid }
    }
    let span = times[high] - times[low]
    let p = span > 0 ? (t - times[low]) / span : 1
    return values[low] + (values[high] - values[low]) * p
  }

  static func unit(_ keys: [RenderPlan.UnitKey], at t: Double, empty: Double) -> Double {
    value(at: t, times: keys.map(\.t), values: keys.map(\.value), empty: empty)
  }

  static func crop(_ keys: [RenderPlan.CropKey], at t: Double) -> (scale: Double, x: Double, y: Double) {
    let times = keys.map(\.t)
    return (value(at: t, times: times, values: keys.map(\.scale), empty: 1),
            value(at: t, times: times, values: keys.map(\.x), empty: 0),
            value(at: t, times: times, values: keys.map(\.y), empty: 0))
  }
}

/// OV10 ordering for one receiver (a player instance or one export): plans
/// order by (revision, buildSeq), and anything not strictly newer than the
/// last accepted plan is dropped. buildSeq is per JS session, so a new
/// receiver starts fresh and accepts its first plan whatever it carries.
struct PlanOrdering {
  private(set) var latest: (revision: Int, buildSeq: Int)?

  /// True when `plan` should replace the current one (and records it).
  mutating func accept(revision: Int, buildSeq: Int) -> Bool {
    if let latest, (revision, buildSeq) <= latest { return false }
    latest = (revision, buildSeq)
    return true
  }
}
