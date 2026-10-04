// Smoke checks for AnalysisMath.swift (plan 7A: the macOS job runs the analyzer
// smoke tests next to sync parity). Not part of the app. Built and run by
// server/test/analyzer-math.test.ts:
//   swiftc ../../ios/Core/AnalysisMath.swift main.swift
// Prints "ok" and exits 0, or lists every failed check and exits 1.
import CoreGraphics
import Foundation
import ImageIO

var failures: [String] = []

func check(_ name: String, _ condition: Bool) {
  if !condition { failures.append(name) }
}

func near(_ a: Double, _ b: Double, _ tolerance: Double = 1e-3) -> Bool { abs(a - b) <= tolerance }

// Energy: 50 ms cells at 8 kHz, RMS in dBFS, silence floored at -100, a short tail kept.
let sine = (0..<800).map { Float(0.5 * sin(Double($0) * 2 * Double.pi * 440 / 8000)) }
let energy = AnalysisMath.energy(sine + [Float](repeating: 0, count: 400) + [Float](repeating: 0.25, count: 100), sampleRate: 8000)
check("energy cell count (2 full + 1 silent + 1 partial)", energy.count == 4)
check("energy sine cell is -9.03 dBFS", near(energy[0], 20 * log10(0.5 / 2.0.squareRoot()), 0.02))
check("energy silent cell is -100", energy[2] == -100)
check("energy partial cell is -12.04 dBFS", near(energy[3], 20 * log10(0.25), 0.01))

// Onset peaks: local maxima above the 85th percentile, at least 0.25 s apart.
var curve = [Double](repeating: -40, count: 100)
curve[10] = -5; curve[12] = -4   // 0.1 s apart: the first peak wins, the second is inside the 0.25 s gap
curve[50] = -6
curve[80] = -3; curve[81] = -3   // a plateau peaks on its last cell (value > next)
let peaks = AnalysisMath.onsetPeaks(curve, cellSeconds: 0.05)
check("onset peaks \(peaks)", peaks == [0.5, 2.5, 4.05])
check("onset peaks of a flat curve are empty", AnalysisMath.onsetPeaks([Double](repeating: -20, count: 50), cellSeconds: 0.05).isEmpty)

// Laughter: windows overlapping or within 0.25 s merge; confidence keeps the peak and the mean.
let spans = AnalysisMath.laughterSpans([
  .init(start: 10, end: 11.5, confidence: 0.6), .init(start: 11, end: 12.5, confidence: 0.9),
  .init(start: 12.7, end: 14.2, confidence: 0.6), .init(start: 20, end: 21.5, confidence: 0.7),
])
check("laughter span count", spans.count == 2)
check("laughter span bounds", spans.first.map { $0.start == 10 && $0.end == 14.2 } ?? false)
check("laughter peak confidence", spans.first.map { $0.confidence == 0.9 } ?? false)
check("laughter mean confidence", spans.first.map { near($0.confidenceSum / Double($0.windows), 0.7) } ?? false)

// Faces: Vision's bottom-left box to face_track.py's padded top-left box.
let topLeft = AnalysisMath.topLeftBox(fromVision: CGRect(x: 0.4, y: 0.45, width: 0.2, height: 0.25))
check("vision box flips to a top-left origin", near(topLeft.y, 0.3, 1e-9) && near(topLeft.x, 0.4, 1e-9))
let box = AnalysisMath.paddedFaceBox(x: topLeft.x, y: topLeft.y, width: topLeft.width, height: topLeft.height)
check("face box padding \(box)", box == [0.2125, 0.58, 0.384, 0.616])
check("face box clamps to the frame", AnalysisMath.paddedFaceBox(x: 0.0, y: 0.05, width: 0.5, height: 0.9) == [0, 1, 0, 0.54])

// Orientation from preferredTransform.
check("portrait phone clip is .right", AnalysisMath.orientation(of: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 1080, ty: 0)) == .right)
check("upside-down clip is .down", AnalysisMath.orientation(of: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 1920, ty: 1080)) == .down)
check("identity is .up", AnalysisMath.orientation(of: .identity) == .up)

// Crop placement, render.ts semantics, in Core Image space (bottom-left origin).
let landscape = CGSize(width: 1920, height: 1080), portraitRender = CGSize(width: 1080, height: 1920)
let rightEdge = AnalysisMath.cropPlacement(source: landscape, render: portraitRender, scale: 1, x: 1, y: 0)
check("x = 1 puts the source's right edge on the frame's right edge", near(Double(CGPoint(x: 1920, y: 0).applying(rightEdge).x), 1080, 0.01))
let leftEdge = AnalysisMath.cropPlacement(source: landscape, render: portraitRender, scale: 1, x: -1, y: 0)
check("x = -1 puts the source's left edge on the frame's left edge", near(Double(CGPoint.zero.applying(leftEdge).x), 0, 0.01))
let centred = AnalysisMath.cropPlacement(source: landscape, render: portraitRender, scale: 1, x: 0, y: 0)
check("x = 0 centres", near(Double(CGPoint(x: 960, y: 540).applying(centred).x), 540, 0.01))
let tall = CGSize(width: 1080, height: 1920), square = CGSize(width: 1080, height: 1080)
let top = AnalysisMath.cropPlacement(source: tall, render: square, scale: 1, x: 0, y: -1)
check("y = -1 shows the top (CI's max y)", near(Double(CGPoint(x: 0, y: 1920).applying(top).y), 1080, 0.01))
let zoomed = AnalysisMath.cropPlacement(source: square, render: square, scale: 2, x: 1, y: 1)
check("scale 2, x = 1, y = 1 shows the bottom-right quarter", near(Double(CGPoint(x: 1080, y: 0).applying(zoomed).x), 1080, 0.01)
  && near(Double(CGPoint(x: 1080, y: 0).applying(zoomed).y), 0, 0.01) && near(Double(CGPoint(x: 540, y: 540).applying(zoomed).x), 0, 0.01))

// Proxy size: fits under maxHeight, even sides, never upscales.
check("4K landscape proxy is 640x360", AnalysisMath.proxySize(for: CGSize(width: 3840, height: 2160), maxHeight: 360) == CGSize(width: 640, height: 360))
check("4K portrait proxy is 202x360", AnalysisMath.proxySize(for: CGSize(width: 2160, height: 3840), maxHeight: 360) == CGSize(width: 202, height: 360))
check("small source is not upscaled", AnalysisMath.proxySize(for: CGSize(width: 320, height: 240), maxHeight: 360) == CGSize(width: 320, height: 240))

if failures.isEmpty {
  print("ok")
} else {
  FileHandle.standardError.write((failures.joined(separator: "\n") + "\n").data(using: .utf8)!)
  exit(1)
}
