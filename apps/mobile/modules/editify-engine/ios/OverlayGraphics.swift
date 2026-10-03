import CoreGraphics
import CoreImage
import CoreText
import Foundation
import ImageIO

struct PlanImageUnreadable: Error, LocalizedError {
  let name: String
  var errorDescription: String? { "Image \(name) could not be read" }
}

/// An image file's upright size (EXIF orientation applied), read from its
/// properties without decoding pixels.
struct PlanImageInfo {
  let uprightWidth: Int
  let uprightHeight: Int
  let frameCount: Int

  static func read(_ source: CGImageSource, name: String) throws -> PlanImageInfo {
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, width > 0, height > 0 else {
      throw PlanImageUnreadable(name: name)
    }
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    let swapped = (5...8).contains(orientation)
    return PlanImageInfo(uprightWidth: swapped ? height : width, uprightHeight: swapped ? width : height,
                         frameCount: CGImageSourceGetCount(source))
  }

  /// The longest side to decode so a picture drawn `width` x `height` output
  /// pixels (stretched or cover-fitted) is never upscaled from a smaller decode.
  func longSide(toCover width: CGFloat, _ height: CGFloat) -> Int {
    let factor = max(width / CGFloat(uprightWidth), height / CGFloat(uprightHeight))
    return min(max(uprightWidth, uprightHeight), Int((factor * CGFloat(max(uprightWidth, uprightHeight))).rounded(.up)))
  }
}

/// A GIF's timing (frames decode lazily through PlanMediaCache). Delays under
/// 2 cs play as 10 cs, as browsers and ffmpeg do (schema: MEDIA).
struct PlanGif {
  let url: URL
  let info: PlanImageInfo
  /// Start time of each frame within one loop, and the loop length.
  let starts: [Double]
  let total: Double

  static func clampedDelay(_ seconds: Double) -> Double { seconds < 0.02 - 1e-9 ? 0.1 : seconds }

  static func read(_ url: URL) throws -> PlanGif {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw PlanImageUnreadable(name: url.lastPathComponent) }
    let info = try PlanImageInfo.read(source, name: url.lastPathComponent)
    var starts: [Double] = []
    var clock = 0.0
    for index in 0..<info.frameCount {
      let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
      let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
      // The unclamped delay is the file's own value; ImageIO's DelayTime applies its own floor.
      let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue
        ?? (gif?[kCGImagePropertyGIFDelayTime] as? NSNumber)?.doubleValue ?? 0.1
      starts.append(clock)
      clock += clampedDelay(delay)
    }
    guard !starts.isEmpty else { throw PlanImageUnreadable(name: url.lastPathComponent) }
    return PlanGif(url: url, info: info, starts: starts, total: clock)
  }

  /// The frame index showing at media time `time` (the latest frame starting at or before it).
  func frameIndex(at time: Double, loop: Bool) -> Int {
    var local = time
    if loop, total > 0 {
      local = time.truncatingRemainder(dividingBy: total)
      if local < 0 { local += total }
    }
    var low = 0, high = starts.count - 1
    if local + RenderPlan.epsilon >= starts[high] { return high }
    while high - low > 1 {
      let mid = (low + high) / 2
      if starts[mid] <= local + RenderPlan.epsilon { low = mid } else { high = mid }
    }
    return low
  }
}

/// Decoded stills and GIF frames, downsampled to the size they are drawn at
/// and kept in a byte-budgeted LRU. A player owns one across rebuilds, so a
/// 60 Hz edit never decodes an image twice.
final class PlanMediaCache: @unchecked Sendable {
  private struct Key: Hashable { let path: String; let index: Int; let longSide: Int }
  private let images: ByteLRU<Key, CIImage>
  private var gifs: [String: PlanGif] = [:]
  private var infos: [String: PlanImageInfo] = [:]
  private let lock = NSLock()

  init(budgetBytes: Int = 96 << 20) { images = ByteLRU(budget: budgetBytes) }

  var cachedImages: Int { images.count }

  func info(_ url: URL) throws -> PlanImageInfo {
    lock.lock(); defer { lock.unlock() }
    if let cached = infos[url.path] { return cached }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw PlanImageUnreadable(name: url.lastPathComponent) }
    let info = try PlanImageInfo.read(source, name: url.lastPathComponent)
    infos[url.path] = info
    return info
  }

  func gif(_ url: URL) throws -> PlanGif {
    lock.lock()
    if let cached = gifs[url.path] { lock.unlock(); return cached }
    lock.unlock()
    let gif = try PlanGif.read(url)
    lock.lock(); gifs[url.path] = gif; lock.unlock()
    return gif
  }

  /// Frame `index` of `url`, upright (EXIF applied), its longest side at most
  /// `longSide`, extent at the origin. Decoded on first use.
  func image(_ url: URL, index: Int = 0, longSide: Int) throws -> CIImage {
    let key = Key(path: url.path, index: index, longSide: longSide)
    if let cached = images.value(for: key) { return cached }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let decoded = CGImageSourceCreateThumbnailAtIndex(source, index, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, longSide),
            kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary) else {
      throw PlanImageUnreadable(name: url.lastPathComponent)
    }
    let image = CIImage(cgImage: decoded)
    images.insert(image, bytes: decoded.bytesPerRow * decoded.height, for: key)
    return image
  }
}

/// Emoji and callout payloads drawn into box-local bitmaps (box-local pixels:
/// origin top-left of the unrotated box, y down). The bitmap carries a margin
/// so ink past the box edge is not clipped; `margin` is in plan pixels.
enum OverlayGraphics {
  struct Drawn {
    let image: CGImage
    let margin: CGFloat
  }

  /// Apple Color Emoji at sizePx, pen at (x, y) with y the baseline. The
  /// builder already fitted size and pen to the box; nothing is re-fitted here.
  static func emoji(_ emoji: RenderPlan.Emoji, box: RenderPlan.Box, scale: CGFloat) -> Drawn? {
    let font = CTFontCreateWithName("AppleColorEmoji" as CFString, CGFloat(emoji.sizePx) * scale, nil)
    // Emoji sequences are ligatures in the font: they stay on.
    let line = TextPainter.line(emoji.text, font: font, ligatures: true)
    let margin = CGFloat(max(box.w, box.h)) * 0.25
    return draw(box: box, margin: margin, scale: scale) { context, point in
      context.textPosition = point(emoji.x, emoji.y)
      CTLineDraw(line, context)
    }
  }

  /// A callout card: rounded card, vector glyph (round caps and joins), one-line label.
  static func callout(_ callout: RenderPlan.Callout, box: RenderPlan.Box, fonts: PlanFonts, scale: CGFloat) throws -> Drawn? {
    let font = try fonts.font(callout.label.font, size: CGFloat(callout.label.sizePx) * scale)
    let label = TextPainter.line(callout.label.text, font: font)
    return draw(box: box, margin: 2, scale: scale) { context, point in
      let card = callout.card
      let topLeft = point(card.x, card.y)
      let bottomRight = point(card.x + card.w, card.y + card.h)
      let rect = CGRect(x: topLeft.x, y: bottomRight.y, width: bottomRight.x - topLeft.x, height: topLeft.y - bottomRight.y)
      let corner = min(CGFloat(card.radiusPx) * scale, rect.width / 2, rect.height / 2)
      context.addPath(CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil))
      context.setFillColor(card.color.cgColor)
      context.fillPath()

      if let glyph = callout.glyph {
        let at = { (fx: Double, fy: Double) in point(glyph.x + fx * glyph.w, glyph.y + fy * glyph.h) }
        let path = CGMutablePath()
        switch glyph.shape {
        case .check:
          path.move(to: at(0.05, 0.55))
          path.addLine(to: at(0.38, 0.88))
          path.addLine(to: at(0.95, 0.12))
        case .cross:
          path.move(to: at(0.12, 0.12))
          path.addLine(to: at(0.88, 0.88))
          path.move(to: at(0.88, 0.12))
          path.addLine(to: at(0.12, 0.88))
        }
        context.addPath(path)
        context.setLineWidth(CGFloat(glyph.strokePx) * scale)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.setStrokeColor(glyph.color.cgColor)
        context.strokePath()
      }

      let outline = TextPainter.outline([TextPainter.Piece(line: label, pen: point(callout.label.x, callout.label.y))])
      context.addPath(outline.path)
      context.setFillColor(callout.label.color.cgColor)
      context.fillPath(using: .winding)
      TextPainter.drawRuns(outline.bitmapRuns, in: context)
    }
  }

  private static func draw(box: RenderPlan.Box, margin: CGFloat, scale: CGFloat,
                           _ body: (CGContext, @escaping (Double, Double) -> CGPoint) -> Void) -> Drawn? {
    let width = Int(((CGFloat(box.w) + 2 * margin) * scale).rounded(.up))
    let height = Int(((CGFloat(box.h) + 2 * margin) * scale).rounded(.up))
    guard let context = TextPainter.canvas(width: width, height: height) else { return nil }
    let canvasHeight = CGFloat(height)
    let point = { (x: Double, y: Double) in
      CGPoint(x: (CGFloat(x) + margin) * scale, y: canvasHeight - (CGFloat(y) + margin) * scale)
    }
    body(context, point)
    guard let image = context.makeImage() else { return nil }
    return Drawn(image: image, margin: margin)
  }
}
