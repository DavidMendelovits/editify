import CoreGraphics
import CoreImage
import CoreText
import Foundation

/// The bundled typography (OV7). Faces come from the font files the app ships
/// (`Fonts/*.ttf` in this pod's EditifyEngineFonts bundle, byte-identical to
/// server/fonts so libass and Core Text read the same tables). Each face is
/// created straight from its file data, never looked up by name, so a missing
/// file fails instead of silently drawing a system font.
public final class PlanFonts: @unchecked Sendable {
  public struct Missing: Error, LocalizedError {
    public let face: String
    public let reason: String
    public var errorDescription: String? { "Font \(face) is not available: \(reason)" }
  }

  /// In em: the `hhea` ascender and descender (descender as a positive
  /// distance), and the OS/2 winAscent / winDescent cell, which is how far
  /// glyphs actually reach (Montserrat's accents go to 1.109 em, above hhea's 0.968).
  public struct VerticalMetrics: Equatable {
    public let ascender: CGFloat
    public let descender: CGFloat
    public let winAscent: CGFloat
    public let winDescent: CGFloat
  }

  private let locate: (PlanFontFace) -> URL?
  private var descriptors: [PlanFontFace: CTFontDescriptor] = [:]
  private var metrics: [PlanFontFace: VerticalMetrics] = [:]
  private let lock = NSLock()

  /// `locate` maps a face to its font file; the default looks in the pod's resource bundle.
  public init(locate: @escaping (PlanFontFace) -> URL? = PlanFonts.bundledFile) {
    self.locate = locate
  }

  public static let shared = PlanFonts()

  /// `<face>.ttf` in the EditifyEngineFonts resource bundle (CocoaPods copies it
  /// next to the app's main bundle for a static framework), or in a bundle root.
  public static func bundledFile(_ face: PlanFontFace) -> URL? {
    let candidates = [Bundle.main, Bundle(for: PlanFonts.self)]
    for bundle in candidates {
      if let fonts = bundle.url(forResource: "EditifyEngineFonts", withExtension: "bundle"),
         let url = Bundle(url: fonts)?.url(forResource: face.rawValue, withExtension: "ttf") {
        return url
      }
      if let url = bundle.url(forResource: face.rawValue, withExtension: "ttf") { return url }
    }
    return nil
  }

  public func font(_ face: PlanFontFace, size: CGFloat) throws -> CTFont {
    CTFontCreateWithFontDescriptor(try descriptor(face), size, nil)
  }

  public func verticalMetrics(_ face: PlanFontFace) throws -> VerticalMetrics {
    _ = try descriptor(face)
    lock.lock(); defer { lock.unlock() }
    return metrics[face]!
  }

  private func descriptor(_ face: PlanFontFace) throws -> CTFontDescriptor {
    lock.lock(); defer { lock.unlock() }
    if let cached = descriptors[face] { return cached }
    guard let url = locate(face) else { throw Missing(face: face.rawValue, reason: "the font file is not bundled") }
    guard let data = try? Data(contentsOf: url) as CFData,
          let descriptor = CTFontManagerCreateFontDescriptorFromData(data) else {
      throw Missing(face: face.rawValue, reason: "\(url.lastPathComponent) is not a font")
    }
    let probe = CTFontCreateWithFontDescriptor(descriptor, 100, nil)
    let name = CTFontCopyPostScriptName(probe) as String
    guard name == face.rawValue else { throw Missing(face: face.rawValue, reason: "\(url.lastPathComponent) is \(name)") }
    guard let hhea = CTFontCopyTable(probe, CTFontTableTag(kCTFontTableHhea), []) as Data?, hhea.count >= 8 else {
      throw Missing(face: face.rawValue, reason: "no hhea table")
    }
    let unitsPerEm = CGFloat(CTFontGetUnitsPerEm(probe))
    let int16 = { (offset: Int) in CGFloat(Int16(bitPattern: UInt16(hhea[offset]) << 8 | UInt16(hhea[offset + 1]))) }
    guard let os2 = CTFontCopyTable(probe, CTFontTableTag(kCTFontTableOS2), []) as Data?, os2.count >= 78 else {
      throw Missing(face: face.rawValue, reason: "no OS/2 table")
    }
    let uint16 = { (offset: Int) in CGFloat(UInt16(os2[offset]) << 8 | UInt16(os2[offset + 1])) }
    metrics[face] = VerticalMetrics(ascender: int16(4) / unitsPerEm, descender: -int16(6) / unitsPerEm,
                                    winAscent: uint16(74) / unitsPerEm, winDescent: uint16(76) / unitsPerEm)
    descriptors[face] = descriptor
    return descriptor
  }
}

/// Draws plan text runs exactly where the plan puts them. Outline glyphs (the
/// bundled face) become one CGPath so fill, round-joined stroke and shadow
/// share geometry; glyphs Core Text falls back to (colour emoji, which have no
/// outlines) are drawn as runs.
public enum TextPainter {
  /// One positioned piece of text, in bitmap coordinates (y up, origin bottom-left).
  public struct Piece {
    public let line: CTLine
    public let pen: CGPoint
  }

  /// Attributes for plan text: the given font, kerning on (Core Text's default),
  /// ligatures off (kCTLigatureAttributeName 0 keeps only required ones).
  public static func line(_ text: String, font: CTFont, ligatures: Bool = false) -> CTLine {
    var attributes: [NSAttributedString.Key: Any] = [kCTFontAttributeName as NSAttributedString.Key: font]
    if !ligatures { attributes[kCTLigatureAttributeName as NSAttributedString.Key] = 0 }
    return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
  }

  /// The outline path of every glyph whose font has outlines, and the runs that do not.
  public static func outline(_ pieces: [Piece]) -> (path: CGPath, bitmapRuns: [(CTRun, CGPoint)]) {
    let path = CGMutablePath()
    var bitmapRuns: [(CTRun, CGPoint)] = []
    for piece in pieces {
      for run in CTLineGetGlyphRuns(piece.line) as! [CTRun] {
        let attributes = CTRunGetAttributes(run) as NSDictionary
        // swiftlint:disable:next force_cast
        let runFont = attributes[kCTFontAttributeName] as! CTFont
        // Colour glyphs (emoji) have no outlines: they are drawn as runs.
        if CTFontGetSymbolicTraits(runFont).contains(.traitColorGlyphs) {
          bitmapRuns.append((run, piece.pen))
          continue
        }
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
        for index in 0..<count {
          var transform = CGAffineTransform(translationX: piece.pen.x + positions[index].x, y: piece.pen.y + positions[index].y)
          if let glyphPath = CTFontCreatePathForGlyph(runFont, glyphs[index], &transform) { path.addPath(glyphPath) }
        }
      }
    }
    return (path, bitmapRuns)
  }

  public static func drawRuns(_ runs: [(CTRun, CGPoint)], in context: CGContext) {
    for (run, pen) in runs {
      context.textPosition = pen
      CTRunDraw(run, context, CFRange(location: 0, length: 0))
    }
  }

  /// An sRGB, premultiplied RGBA8 canvas (graphics are sRGB-encoded; the
  /// compositor converts them to linear BT.2020 at reference white).
  public static func canvas(width: Int, height: Int) -> CGContext? {
    guard width > 0, height > 0 else { return nil }
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    context?.setShouldAntialias(true)
    context?.setAllowsFontSmoothing(false)
    context?.setShouldSubpixelPositionFonts(true)
    context?.setShouldSubpixelQuantizeFonts(false)
    return context
  }
}

/// A byte-budgeted LRU (caption bitmaps, overlay bitmaps).
public final class ByteLRU<Key: Hashable, Value>: @unchecked Sendable {
  private var entries: [Key: (value: Value, bytes: Int, tick: UInt64)] = [:]
  private var tick: UInt64 = 0
  public private(set) var bytes = 0
  public let budget: Int
  private let lock = NSLock()

  public init(budget: Int) { self.budget = budget }

  public var count: Int { lock.lock(); defer { lock.unlock() }; return entries.count }

  public func value(for key: Key) -> Value? {
    lock.lock(); defer { lock.unlock() }
    guard let entry = entries[key] else { return nil }
    tick += 1
    entries[key] = (entry.value, entry.bytes, tick)
    return entry.value
  }

  public func insert(_ value: Value, bytes cost: Int, for key: Key) {
    lock.lock(); defer { lock.unlock() }
    if let old = entries[key] { bytes -= old.bytes }
    tick += 1
    entries[key] = (value, cost, tick)
    bytes += cost
    // Evict least recently used until under budget, but never the entry just added.
    while bytes > budget, entries.count > 1 {
      guard let oldest = entries.filter({ $0.key != key }).min(by: { $0.value.tick < $1.value.tick }) else { break }
      bytes -= oldest.value.bytes
      entries.removeValue(forKey: oldest.key)
    }
  }

  public func removeAll(where shouldRemove: (Key) -> Bool) {
    lock.lock(); defer { lock.unlock() }
    for (key, entry) in entries where shouldRemove(key) {
      bytes -= entry.bytes
      entries.removeValue(forKey: key)
    }
  }

    public func removeAll() {
    lock.lock(); defer { lock.unlock() }
    entries.removeAll()
    bytes = 0
  }
}

/// Captions (1A): Core Text into cached bitmaps that the compositor lays over
/// the frame. Draws each plan line at its pen x and baseline y, never
/// re-wrapping or re-centring; karaoke words switch to the emphasis colour at
/// their absolute start time (an instant switch, as ASS `\k`).
public final class CaptionRenderer: @unchecked Sendable {
  public struct Key: Hashable {
    public let id: String
    public let rev: String
    public let sung: Int
    /// Render scale in thousandths (preview draws at view size).
    public let scale: Int
  }

  /// A finished caption bitmap and where its top-left sits in output pixels (at scale).
  public struct Bitmap {
    public let image: CGImage
    /// Made once per cache entry and reused every frame the state shows.
    public let ciImage: CIImage
    public let originX: CGFloat
    public let originY: CGFloat
  }

  public let fonts: PlanFonts
  public let cache: ByteLRU<Key, Bitmap>

  /// 64 MB holds a few hundred 1080p karaoke states; a 190-word caption at 4K
  /// evicts its oldest states rather than growing without bound.
  public init(fonts: PlanFonts = .shared, budgetBytes: Int = 64 << 20) {
    self.fonts = fonts
    self.cache = ByteLRU(budget: budgetBytes)
  }

  /// Words sung by time t: every word whose start is at or before t (across all lines).
  public static func sungCount(_ caption: RenderPlan.Caption, at t: Double) -> Int {
    var count = 0
    for line in caption.lines {
      for word in line.words ?? [] where word.s <= t + RenderPlan.epsilon { count += 1 }
    }
    return count
  }

  /// The caption as drawn at timeline t, placed in output pixels (top-left origin) at `scale`.
  public func bitmap(_ caption: RenderPlan.Caption, at t: Double, scale: CGFloat) throws -> Bitmap? {
    let key = Key(id: caption.id, rev: caption.rev, sung: Self.sungCount(caption, at: t), scale: Int((scale * 1000).rounded()))
    if let cached = cache.value(for: key) { return cached }
    guard let drawn = try draw(caption, sung: key.sung, scale: scale) else { return nil }
    cache.insert(drawn, bytes: drawn.image.bytesPerRow * drawn.image.height, for: key)
    return drawn
  }

  // swiftlint:disable:next function_body_length
  public func draw(_ caption: RenderPlan.Caption, sung: Int, scale: CGFloat) throws -> Bitmap? {
    let metrics = try fonts.verticalMetrics(caption.font)
    let size = CGFloat(caption.sizePx)
    let pad = CGFloat(caption.box?.padPx ?? 0)
    let stroke = CGFloat(caption.strokePx)
    let shadow = CGFloat(caption.shadow?.offsetPx ?? 0)
    // The bitmap covers each line's ink: vertically the font's win cell (plus
    // 0.1 em for fallback emoji, whose descent is deeper), horizontally the
    // advance plus 0.25 em of overhang; then stroke, shadow and box padding.
    let reach = max(metrics.winAscent, metrics.ascender) * size + size * 0.1
    let drop = max(metrics.winDescent, metrics.descender) * size + size * 0.1
    let margin = stroke + shadow + pad + 2
    // Horizontally: the plan's extent or the text's own advance, whichever
    // reaches further (a plan laid out with other widths must not clip ink).
    let measureFont = try fonts.font(caption.font, size: size)
    let advance = { (text: String) in CGFloat(CTLineGetTypographicBounds(TextPainter.line(text, font: measureFont), nil, nil, nil)) }
    var bounds = CGRect.null
    for line in caption.lines {
      var left = CGFloat(line.x), right = CGFloat(line.x + line.width)
      if let words = line.words {
        for word in words {
          left = min(left, CGFloat(word.x))
          right = max(right, CGFloat(word.x) + advance(word.w))
        }
      } else {
        right = max(right, CGFloat(line.x) + advance(line.text))
      }
      bounds = bounds.union(CGRect(x: left - margin - size * 0.25, y: CGFloat(line.y) - reach - margin,
                                   width: right - left + 2 * margin + size * 0.5, height: reach + drop + 2 * margin))
    }
    let originX = (bounds.minX * scale).rounded(.down)
    let originY = (bounds.minY * scale).rounded(.down)
    let width = Int((bounds.maxX * scale - originX).rounded(.up))
    let height = Int((bounds.maxY * scale - originY).rounded(.up))
    guard let context = TextPainter.canvas(width: width, height: height) else { return nil }
    let canvasHeight = CGFloat(height)
    // Plan point (top-left output px) to canvas point (bottom-left, at scale).
    let point = { (x: Double, y: Double) in CGPoint(x: CGFloat(x) * scale - originX, y: canvasHeight - (CGFloat(y) * scale - originY)) }
    let font = try fonts.font(caption.font, size: size * scale)

    // Pieces: whole lines, or karaoke words each at its own x, tagged sung or not.
    var plain: [TextPainter.Piece] = []
    var emphasis: [TextPainter.Piece] = []
    var wordIndex = 0
    for line in caption.lines {
      if let words = line.words {
        for word in words {
          let piece = TextPainter.Piece(line: TextPainter.line(word.w, font: font), pen: point(word.x, line.y))
          if wordIndex < sung { emphasis.append(piece) } else { plain.append(piece) }
          wordIndex += 1
        }
      } else {
        plain.append(TextPainter.Piece(line: TextPainter.line(line.text, font: font), pen: point(line.x, line.y)))
      }
    }
    let all = TextPainter.outline(plain + emphasis)
    let plainOutline = TextPainter.outline(plain)
    let emphasisOutline = TextPainter.outline(emphasis)

    // 1. Backing boxes: one fill of their union, so overlapping line boxes do not double their alpha.
    if let box = caption.box {
      let boxes = CGMutablePath()
      let radius = CGFloat(box.radiusPx) * scale
      for line in caption.lines {
        // The line's cell (OS/2 winAscent / winDescent), grown by padPx (libass BorderStyle 3).
        let top = point(line.x - box.padPx, line.y - Double(metrics.winAscent * size) - box.padPx)
        let bottom = point(line.x + line.width + box.padPx, line.y + Double(metrics.winDescent * size) + box.padPx)
        let rect = CGRect(x: top.x, y: bottom.y, width: bottom.x - top.x, height: top.y - bottom.y)
        let corner = min(radius, rect.width / 2, rect.height / 2)
        boxes.addPath(CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil))
      }
      context.saveGState()
      context.setAlpha(CGFloat(box.opacity))
      context.setFillColor(box.color.cgColor)
      context.addPath(boxes)
      context.fillPath(using: .winding)
      context.restoreGState()
    }

    // 2. Shadow: the outlined glyphs offset right and down, in one layer at `opacity`.
    if let spec = caption.shadow, spec.opacity > 0 {
      let offset = CGFloat(spec.offsetPx) * scale
      context.saveGState()
      context.setAlpha(CGFloat(spec.opacity))
      context.beginTransparencyLayer(auxiliaryInfo: nil)
      context.translateBy(x: offset, y: -offset)
      Self.strokeAndFill(all.path, stroke: stroke * scale, color: spec.color.cgColor, fill: spec.color.cgColor, in: context)
      TextPainter.drawRuns(all.bitmapRuns, in: context)
      // Colour emoji join the shadow as silhouettes.
      context.translateBy(x: -offset, y: offset)
      context.setBlendMode(.sourceIn)
      context.setFillColor(spec.color.cgColor)
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      context.endTransparencyLayer()
      context.restoreGState()
    }

    // 3. Outline under the fill: strokePx outward means a 2 * strokePx centred stroke, round joins.
    if stroke > 0 {
      context.saveGState()
      context.addPath(all.path)
      context.setLineWidth(2 * stroke * scale)
      context.setLineJoin(.round)
      context.setLineCap(.round)
      context.setStrokeColor(caption.strokeColor.cgColor)
      context.strokePath()
      context.restoreGState()
    }

    // 4. Fill: unsung in `color`, sung karaoke words in `emphasisColor`; colour emoji as drawn.
    for (outline, color) in [(plainOutline, caption.color), (emphasisOutline, caption.emphasisColor)] where !outline.path.isEmpty {
      context.saveGState()
      context.addPath(outline.path)
      context.setFillColor(color.cgColor)
      context.fillPath(using: .winding)
      context.restoreGState()
    }
    TextPainter.drawRuns(all.bitmapRuns, in: context)

    guard let image = context.makeImage() else { return nil }
    return Bitmap(image: image, ciImage: CIImage(cgImage: image), originX: originX, originY: originY)
  }

  private static func strokeAndFill(_ path: CGPath, stroke: CGFloat, color: CGColor, fill: CGColor, in context: CGContext) {
    if stroke > 0 {
      context.addPath(path)
      context.setLineWidth(2 * stroke)
      context.setLineJoin(.round)
      context.setLineCap(.round)
      context.setStrokeColor(color)
      context.strokePath()
    }
    context.addPath(path)
    context.setFillColor(fill)
    context.fillPath(using: .winding)
  }
}
