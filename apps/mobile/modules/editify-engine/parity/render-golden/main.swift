// Golden-frame harness (plan 9A): renders RenderPlan fixtures through the
// phone's PlanBuilder + EditifyCompositor on macOS and reports pixels.
//
//   render-golden <manifest.json> <repo root> <work dir> <out dir> [--bless]
//
// 1. Synthesizes the manifest's media deterministically in <work dir>: test
//    videos (an SDR H.264 clip, HLG and PQ 10-bit HEVC clips) with known
//    linear patches and the frame index as an 8-bit code strip, AAC tones, a
//    PNG with an EXIF orientation, a GIF with short delays.
// 2. Builds each plan with an asset resolver scoped to that media, reads the
//    listed frames with AVAssetReaderVideoCompositionOutput (the same
//    composition, video composition and compositor export uses), and the mix
//    with AVAssetReaderAudioMixOutput.
// 3. Writes PNGs of the encoded frames to <out dir>, compares them with the
//    committed goldens (or replaces them with --bless), and prints a JSON
//    report: compare metrics, probe values, decoded frame codes, colour tags,
//    tone amplitudes. server/test/render-golden.test.ts asserts on it.
//
// The manifest format, media synthesis and pixel helpers live in HarnessMedia.swift
// (shared with the export harness, parity/export).

import AVFoundation
import CoreImage
import Foundation
import ImageIO
import Metal
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count >= 5 else {
  FileHandle.standardError.write("usage: render-golden <manifest> <repo> <work> <out> [--bless]\n".data(using: .utf8)!)
  exit(2)
}
let manifestURL = URL(fileURLWithPath: arguments[1])
let repo = URL(fileURLWithPath: arguments[2])
let work = URL(fileURLWithPath: arguments[3])
let outDir = URL(fileURLWithPath: arguments[4])
let bless = arguments.contains("--bless")
let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
let goldens = repo.appendingPathComponent(manifest.goldens)
try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

var mediaFiles: [String: URL] = [:]
var mediaReport: [String: Any] = [:]
for (id, media) in manifest.media.sorted(by: { $0.key < $1.key }) {
  switch media.kind {
  case "video":
    let url = work.appendingPathComponent("\(id).mov")
    let codec = try writeVideo(media, to: url)
    mediaFiles[id] = url
    mediaReport[id] = ["codec": codec]
  case "audio":
    let url = work.appendingPathComponent("\(id).m4a")
    try writeAudio(media, to: url)
    mediaFiles[id] = url
  case "png":
    let url = work.appendingPathComponent("\(id).png")
    try writeLogo(media, to: url)
    mediaFiles[id] = url
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let cache = PlanMediaCache()
    let info = try cache.info(url)
    let full = try cache.image(url, longSide: info.longSide(toCover: 10_000, 10_000))
    let small = try cache.image(url, longSide: info.longSide(toCover: 25, 25))
    mediaReport[id] = ["orientation": (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1,
                       "uprightWidth": Int(full.extent.width), "uprightHeight": Int(full.extent.height),
                       "downsampled": [Int(small.extent.width), Int(small.extent.height)]]
  case "gif":
    let url = work.appendingPathComponent("\(id).gif")
    try writeGif(media, to: url)
    mediaFiles[id] = url
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
    var delays: [Double] = []
    for index in 0..<CGImageSourceGetCount(source) {
      let gif = (CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any])?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
      delays.append((gif?[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue ?? -1)
    }
    let loaded = try PlanGif.read(url)
    mediaReport[id] = ["unclampedDelays": delays, "starts": loaded.starts, "total": loaded.total]
  default:
    throw HarnessError("unknown media kind \(media.kind)")
  }
}

// The resolver: ids resolve only within this manifest's media, as the device's resolver does within the user's.
let resolver = PlanAssetResolver(
  asset: { ref in
    guard ref.kind != .image, let url = mediaFiles[ref.id] else { throw HarnessError("no \(ref.kind.rawValue) asset \(ref.id)") }
    // Precise timing, as the resolver contract requires (holds snap to real frame timestamps).
    return AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
  },
  imageFile: { ref in
    guard ref.kind == .image, let url = mediaFiles[ref.id] else { throw HarnessError("no image asset \(ref.id)") }
    return url
  })
let fontsDir = repo.appendingPathComponent(manifest.fonts)
let fonts = PlanFonts { fontsDir.appendingPathComponent("\($0.rawValue).ttf") }

func readFrame(_ built: BuiltPlan, frame k: Int) throws -> CVPixelBuffer {
  let reader = try AVAssetReader(asset: built.composition)
  let tracks = built.composition.tracks(withMediaType: .video)
  let output = AVAssetReaderVideoCompositionOutput(videoTracks: tracks, videoSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
  ])
  output.videoComposition = built.videoComposition
  output.alwaysCopiesSampleData = false
  reader.add(output)
  let fps = Int32(built.plan.fps)
  reader.timeRange = CMTimeRange(start: CMTime(value: CMTimeValue(k), timescale: fps), duration: CMTime(value: 1, timescale: fps))
  guard reader.startReading() else { throw HarnessError("reader: \(reader.error?.localizedDescription ?? "?")") }
  defer { reader.cancelReading() }
  guard let sample = output.copyNextSampleBuffer(), let buffer = CMSampleBufferGetImageBuffer(sample) else {
    throw HarnessError("no frame \(k): \(reader.error?.localizedDescription ?? "reader returned nothing")")
  }
  let pts = CMSampleBufferGetPresentationTimeStamp(sample)
  guard abs(pts.seconds - Double(k) / Double(fps)) < 1e-6 else { throw HarnessError("frame \(k) came back at \(pts.seconds)") }
  return buffer
}

/// Samples the last readMix dropped past the plan's end.
var lastOvershoot = 0
/// Frames padded at the end because the mix ran short (time-pitch can end a sped-up entry early).
var lastShortfall = 0

/// The stereo mix as left and right channels.
func readMix(_ built: BuiltPlan) throws -> (left: [Float], right: [Float]) {
  let reader = try AVAssetReader(asset: built.composition)
  let output = AVAssetReaderAudioMixOutput(audioTracks: built.composition.tracks(withMediaType: .audio), audioSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2,
    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
  ])
  output.audioMix = built.audioMix
  output.audioTimePitchAlgorithm = BuiltPlan.audioTimePitchAlgorithm
  reader.add(output)
  guard reader.startReading() else { throw HarnessError("audio reader: \(reader.error?.localizedDescription ?? "?")") }
  var left: [Float] = [], right: [Float] = []
  // PlanMixTrim drops what time-pitch emits past the plan's end; the rest is
  // contiguous, so samples append in order.
  let end = built.composition.duration
  var overshoot = 0
  while let raw = output.copyNextSampleBuffer() {
    overshoot += CMSampleBufferGetNumSamples(raw)
    guard let sample = PlanMixTrim.trim(raw, end: end), let block = CMSampleBufferGetDataBuffer(sample) else { continue }
    overshoot -= CMSampleBufferGetNumSamples(sample)
    let length = CMBlockBufferGetDataLength(block)
    var bytes = [Float](repeating: 0, count: length / 4)
    _ = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
    var index = 0
    while index + 1 < bytes.count { left.append(bytes[index]); right.append(bytes[index + 1]); index += 2 }
  }
  lastOvershoot = overshoot
  guard reader.status != .failed else { throw HarnessError("audio reader: \(reader.error?.localizedDescription ?? "?")") }
  // Like PlanExporter, pad a short mix with silence to exactly the plan's length.
  let expected = Int((end.seconds * 48_000).rounded())
  lastShortfall = max(0, expected - left.count)
  if lastShortfall > 0 {
    left.append(contentsOf: repeatElement(0, count: lastShortfall))
    right.append(contentsOf: repeatElement(0, count: lastShortfall))
  }
  return (left, right)
}

/// Every output frame in one pass, each frame's code strip decoded (see Pattern).
func sequentialCodes(_ built: BuiltPlan) throws -> [Int] {
  let reader = try AVAssetReader(asset: built.composition)
  let output = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video), videoSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
  ])
  output.videoComposition = built.videoComposition
  reader.add(output)
  guard reader.startReading() else { throw HarnessError("reader: \(reader.error?.localizedDescription ?? "?")") }
  var codes: [Int] = []
  while let sample = output.copyNextSampleBuffer(), let buffer = CMSampleBufferGetImageBuffer(sample) {
    codes.append(decodeCode(pixels(buffer, space: workingSpace)))
  }
  guard reader.status != .failed else { throw HarnessError("reader: \(reader.error?.localizedDescription ?? "?")") }
  return codes
}

var report: [String: Any] = ["media": mediaReport]

// MARK: Executor checks (no media): the Swift parse, the audio ramps, the caption cache.

func decodeOutcome(_ name: String = "caption-karaoke", _ mutate: (inout [String: Any]) -> Void) -> String {
  let fixture = repo.appendingPathComponent("packages/shared/fixtures/render-plans/\(name).json")
  guard let wrapper = try? JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any],
        var plan = wrapper["plan"] as? [String: Any] else { return "fixture unreadable" }
  mutate(&plan)
  do {
    _ = try RenderPlan.decode(try JSONSerialization.data(withJSONObject: plan))
    return "ok"
  } catch let error as RenderPlanError {
    switch error {
    case .unsupportedVersion: return "unsupportedVersion"
    case .unsupportedFeatures(let names): return "unsupportedFeatures:\(names.joined(separator: ","))"
    case .overLimit: return "overLimit"
    case .invalid: return "invalid"
    case .tooLarge: return "tooLarge"
    }
  } catch {
    return "other:\(error)"
  }
}
func edit(_ plan: inout [String: Any], _ path: [Any], _ value: Any) {
  func set(_ node: Any, _ path: ArraySlice<Any>) -> Any {
    guard let head = path.first else { return value }
    if let key = head as? String, var dict = node as? [String: Any] { dict[key] = set(dict[key] as Any, path.dropFirst()); return dict }
    if let index = head as? Int, var list = node as? [Any] { list[index] = set(list[index], path.dropFirst()); return list }
    return node
  }
  plan = set(plan, path[...]) as! [String: Any]
}
var checks: [String: Any] = [:]
checks["decode"] = [
  "fixture": decodeOutcome { _ in },
  "unknownKeysIgnored": decodeOutcome { $0["futureField"] = ["x": 1]; edit(&$0, ["captions", 0, "futureStyle"], "glow") },
  "version2": decodeOutcome { $0["version"] = 2 },
  "requiresFeature": decodeOutcome { $0["requires"] = ["caption-animation"] },
  "tooManyRequires": decodeOutcome { $0["requires"] = Array(repeating: "x", count: 33) },
  "size4kSquare": decodeOutcome { $0["size"] = ["w": 3840, "h": 3840] },
  "size4kPortrait": decodeOutcome { $0["size"] = ["w": 2160, "h": 3840] },
  "oddSize": decodeOutcome { $0["size"] = ["w": 1081, "h": 1920] },
  "durationOverCap": decodeOutcome { $0["duration"] = 14_401 },
  "longCaptionLine": decodeOutcome { edit(&$0, ["captions", 0, "lines", 0, "text"], String(repeating: "A", count: 501)) },
  "longId": decodeOutcome { edit(&$0, ["captions", 0, "id"], String(repeating: "c", count: 129)) },
  "segmentGap": decodeOutcome { edit(&$0, ["video", "segments", 0, "end"], 2.9) },
  "badColour": decodeOutcome { $0["background"] = "#12345" },
  "unknownFace": decodeOutcome { edit(&$0, ["captions", 0, "font"], "Inter-Bold") },
  "overlaysFixture": decodeOutcome("overlays") { _ in },
  "zeroCalloutCard": decodeOutcome("overlays") { edit(&$0, ["overlays", 3, "callout", "card", "w"], 0) },
  "zeroCalloutGlyph": decodeOutcome("overlays") { edit(&$0, ["overlays", 3, "callout", "glyph", "h"], 0) },
]
let rampEntry = try JSONDecoder().decode(RenderPlan.AudioEntry.self, from: JSONSerialization.data(withJSONObject: [
  "id": "e", "clipId": "c", "assetRef": ["id": "a", "kind": "audio"], "at": 1.0, "in": 0.0, "out": 1.0, "speed": 1.0,
  "gainKeys": [["t": 1.0, "gain": 1.0], ["t": 1.5, "gain": 0.5]],
  "fadeIn": ["duration": 0.2, "curve": "halfSine"], "fadeOut": ["duration": 0.3, "curve": "linear"],
]))
let ramps = AudioRamps.ramps(rampEntry)
func rampGain(_ t: Double) -> Double {
  guard let ramp = ramps.first(where: { $0.start <= t && t <= $0.end }) else { return -1 }
  return ramp.from + (ramp.to - ramp.from) * (t - ramp.start) / (ramp.end - ramp.start)
}
let rampTimes = Array(stride(from: 1.0, through: 2.0, by: 0.001))
let pieceErrors: [Double] = rampTimes.map { (t: Double) -> Double in abs(rampGain(t) - AudioRamps.gain(rampEntry, at: t)) }
let contiguous = zip(ramps, ramps.dropFirst()).allSatisfy { (pair: (AudioRamps.Ramp, AudioRamps.Ramp)) -> Bool in abs(pair.0.end - pair.1.start) < 1e-12 }
var rampReport: [String: Any] = [:]
rampReport["count"] = ramps.count
rampReport["contiguous"] = contiguous
rampReport["start"] = ramps.first?.start ?? -1
rampReport["end"] = ramps.last?.end ?? -1
// Exact gains (curve x keys) at sample points, and the worst error of the linear pieces.
rampReport["gainAt1.1"] = AudioRamps.gain(rampEntry, at: 1.1)
rampReport["gainAt1.25"] = AudioRamps.gain(rampEntry, at: 1.25)
rampReport["gainAt1.85"] = AudioRamps.gain(rampEntry, at: 1.85)
rampReport["maxPieceError"] = pieceErrors.max() ?? -1
checks["ramps"] = rampReport
let karaokeWrapper = try JSONSerialization.jsonObject(
  with: Data(contentsOf: repo.appendingPathComponent("packages/shared/fixtures/render-plans/caption-karaoke.json"))) as! [String: Any]
let karaoke = try RenderPlan.decode(JSONSerialization.data(withJSONObject: karaokeWrapper["plan"]!))
let caption = karaoke.captions[0]
let renderer = CaptionRenderer(fonts: fonts, budgetBytes: 1 << 20)
var states: [Int] = []
for k in stride(from: 15, to: 87, by: 3) { _ = try renderer.bitmap(caption, at: Double(k) / 30, scale: 1); states.append(CaptionRenderer.sungCount(caption, at: Double(k) / 30)) }
let hit = renderer.cache.count
_ = try renderer.bitmap(caption, at: 2.8, scale: 1)
checks["captionCache"] = [
  "sungStates": Array(Set(states)).sorted(), "entries": hit, "entriesAfterRepeat": renderer.cache.count,
  "bytes": renderer.cache.bytes, "budget": renderer.cache.budget,
  "sungAt0.5": CaptionRenderer.sungCount(caption, at: 0.5), "sungAt0.49": CaptionRenderer.sungCount(caption, at: 0.49),
  "sungAt2.0": CaptionRenderer.sungCount(caption, at: 2.0),
]
var ordering = PlanOrdering()
let offered = [(3, 1), (3, 1), (2, 9), (3, 2), (4, 0), (4, 0)]
checks["ordering"] = ["accepted": offered.map { ordering.accept(revision: $0.0, buildSeq: $0.1) }]
// Rebuilds: a parameter-only edit keeps the composition; media and caches carry over.
func fixturePlan(_ name: String, _ mutate: (inout [String: Any]) -> Void = { _ in }) throws -> RenderPlan {
  let wrapper = try JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("packages/shared/fixtures/render-plans/\(name).json"))) as! [String: Any]
  var plan = wrapper["plan"] as! [String: Any]
  mutate(&plan)
  return try RenderPlan.decode(JSONSerialization.data(withJSONObject: plan))
}
let sharedMedia = PlanMediaCache()
let sharedOptions = PlanBuildOptions(fonts: fonts, captions: CaptionRenderer(fonts: fonts), media: sharedMedia)
let basePlan = try fixturePlan("overlays")
let firstMedia = try await PlanBuilder.prepare(basePlan, resolver: resolver)
let first = try PlanBuilder.assemble(basePlan, media: firstMedia, options: sharedOptions)
let decodedAtBuild = sharedMedia.cachedImages
_ = try readFrame(first, frame: 40)  // stills and a GIF frame decode now, at draw time
let decodedAfterFirst = sharedMedia.cachedImages
let zoomed = try fixturePlan("overlays") {
  edit(&$0, ["video", "segments", 0, "layers", 0, "cropKeys", 0, "scale"], 1.2)
  edit(&$0, ["overlays", 2, "box", "x"], 150)
}
let moved = try fixturePlan("overlays") {
  edit(&$0, ["audio", 0, "at"], 0.5)
  edit(&$0, ["audio", 0, "out"], 3.5)
  edit(&$0, ["audio", 0, "gainKeys", 0, "t"], 0.5)
}
let updated = try PlanBuilder.update(first, to: zoomed, options: sharedOptions)
if let updated { _ = try readFrame(updated, frame: 40) }
let notUpdated = try PlanBuilder.update(first, to: moved, options: sharedOptions)
let secondMedia = try await PlanBuilder.prepare(moved, resolver: resolver, reusing: firstMedia)
_ = try PlanBuilder.assemble(moved, media: secondMedia, options: sharedOptions)
checks["rebuild"] = [
  "parameterEditUpdates": updated != nil,
  "sameComposition": updated.map { $0.composition === first.composition } ?? false,
  "newVideoComposition": updated.map { $0.videoComposition !== first.videoComposition } ?? false,
  "structuralEditRefused": notUpdated == nil,
  "assetsReused": secondMedia.videos["asset-talk"]?.asset === firstMedia.videos["asset-talk"]?.asset,
  "noDecodeAtBuild": decodedAtBuild == 0,
  "imagesDecodedOnce": decodedAfterFirst > 0 && sharedMedia.cachedImages == decodedAfterFirst,
]
// A new image overlay in a parameter-only edit draws (update takes the freshly prepared media).
let withNewSticker = try fixturePlan("overlays") { plan in
  var overlays = plan["overlays"] as! [[String: Any]]
  overlays.append(["id": "sticker-new", "kind": "image", "z": 10, "start": 0, "end": 4,
                   "box": ["x": 300, "y": 560, "w": 60, "h": 60, "rotationDeg": 0],
                   "media": ["assetRef": ["id": "asset-logo-2", "kind": "image"], "srcStart": 0, "speed": 1]])
  plan["overlays"] = overlays
}
let newStickerMedia = try await PlanBuilder.prepare(withNewSticker, resolver: resolver, reusing: firstMedia)
let staleUpdate = try PlanBuilder.update(first, to: withNewSticker, options: sharedOptions)
let freshUpdate = try PlanBuilder.update(first, to: withNewSticker, media: newStickerMedia, options: sharedOptions)
var stickerProbe: [Double] = []
if let freshUpdate {
  let sticker = pixels(try readFrame(freshUpdate, frame: 0), space: workingSpace).at(300, 560)
  stickerProbe = sticker.map(Double.init)
}
// A proxy swapped for its original under the same id reloads, and the old composition is not reused.
let swapped = try await PlanBuilder.prepare(basePlan, resolver: resolver, reusing: firstMedia, invalidating: ["asset-talk"], cache: sharedMedia)
checks["update"] = [
  "withoutNewMediaRefused": staleUpdate == nil,
  "withNewMediaUpdates": freshUpdate != nil,
  "newStickerLinear": stickerProbe,
  "invalidatedReloads": swapped.videos["asset-talk"]?.asset !== firstMedia.videos["asset-talk"]?.asset,
  "invalidatedKeepsOthers": swapped.videos["asset-city"]?.asset === firstMedia.videos["asset-city"]?.asset,
  "updateAfterSwapRefused": (try PlanBuilder.update(first, to: basePlan, media: swapped, options: sharedOptions)) == nil,
]
// Fifty stills, each drawn at its own size, under a 2 MB image budget: decodes happen at draw time and the cache stays capped.
let manyStills = try fixturePlan("overlays") { plan in
  plan["overlays"] = (0..<50).map { (index: Int) -> [String: Any] in
    let side = 40 + 4 * index
    return ["id": "still-\(index)", "kind": "image", "z": index, "start": 0, "end": 4,
            "box": ["x": 30 + (index % 10) * 33, "y": 60 + (index / 10) * 120, "w": side, "h": side, "rotationDeg": 0],
            "media": ["assetRef": ["id": "asset-big", "kind": "image"], "srcStart": 0, "speed": 1]]
  }
}
let smallCache = PlanMediaCache(budgetBytes: 2 << 20)
let manyBuilt = try PlanBuilder.assemble(manyStills, media: try await PlanBuilder.prepare(manyStills, resolver: resolver),
                                         options: PlanBuildOptions(fonts: fonts, media: smallCache))
let cachedBeforeDraw = smallCache.cachedImages
_ = try readFrame(manyBuilt, frame: 0)
checks["stillBudget"] = ["cachedBeforeDraw": cachedBeforeDraw, "bytes": smallCache.cachedBytes, "budget": smallCache.budgetBytes,
                         "entries": smallCache.cachedImages]
checks["sdrCurve"] = ["0.18": PlanColorPipeline.sdrCurve(0.18), "1": PlanColorPipeline.sdrCurve(1), "2": PlanColorPipeline.sdrCurve(2)]
report["checks"] = checks
var renders: [[String: Any]] = []
for render in manifest.renders {
  var entry: [String: Any] = ["name": render.name]
  let wrapper = try JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent(render.plan))) as! [String: Any]
  let planData = try JSONSerialization.data(withJSONObject: wrapper["plan"]!)
  let plan = try RenderPlan.decode(planData)
  let built: BuiltPlan
  do {
    built = try await PlanBuilder.build(plan, resolver: resolver, options: PlanBuildOptions(fonts: fonts))
  } catch PlanBuildError.emptyPlan {
    entry["emptyPlanRefused"] = true
    renders.append(entry)
    continue
  }
  entry["videoTracks"] = built.composition.tracks(withMediaType: .video).count
  entry["audioTracks"] = built.composition.tracks(withMediaType: .audio).count
  entry["instructions"] = built.videoComposition.instructions.count
  entry["durationSeconds"] = built.composition.duration.seconds
  entry["renderSize"] = [built.videoComposition.renderSize.width, built.videoComposition.renderSize.height]
  // Audio edits: where each track ends, and how many edits are time-scaled (speed 1 must have none).
  entry["audioEdits"] = built.composition.tracks(withMediaType: .audio).map { track -> [String: Any] in
    let real = track.segments.filter { !$0.isEmpty }
    let scaled = real.filter { abs($0.timeMapping.source.duration.seconds - $0.timeMapping.target.duration.seconds) > 1e-9 }
    return ["end": track.timeRange.end.seconds, "edits": real.count, "scaled": scaled.count, "carrier": track.trackID == built.layout.carrierTrack]
  }
  if render.sequential == true { entry["sequentialCodes"] = try sequentialCodes(built) }
  let outputSpace = PlanColorPipeline.outputSpace(plan.color)
  var frames: [[String: Any]] = []
  for frame in render.frames {
    var result: [String: Any] = ["k": frame.k]
    let buffer = try readFrame(built, frame: frame.k)
    let tag = { (key: CFString) in CVBufferCopyAttachment(buffer, key, nil) as? String ?? "none" }
    let attachmentKeys = (CVBufferCopyAttachments(buffer, .shouldPropagate) as? [String: Any])?.keys.sorted() ?? []
    result["attachmentKeys"] = attachmentKeys
    result["tags"] = ["primaries": tag(kCVImageBufferColorPrimariesKey), "transfer": tag(kCVImageBufferTransferFunctionKey), "matrix": tag(kCVImageBufferYCbCrMatrixKey)]
    let encoded = pixels(buffer, space: outputSpace)
    let linear = pixels(buffer, space: workingSpace)
    let scale = Double(encoded.width) / Double(plan.size.w)
    var probes: [String: Any] = [:]
    for probe in frame.probes ?? [] {
      let r = probe.r ?? 2
      var enc: [Double] = [0, 0, 0], lin: [Double] = [0, 0, 0]
      var n = 0.0
      for dy in -r...r {
        for dx in -r...r {
          let x = Int((probe.x * scale).rounded()) + dx, y = Int((probe.y * scale).rounded()) + dy
          let e = encoded.at(x, y), l = linear.at(x, y)
          for c in 0..<3 { enc[c] += Double(e[c]); lin[c] += Double(l[c]) }
          n += 1
        }
      }
      probes[probe.name] = ["encoded": enc.map { $0 / n }, "linear": lin.map { $0 / n }]
    }
    for rect in frame.rects ?? [] {
      var best: (Float, [Float], [Float]) = (-1, [0, 0, 0], [0, 0, 0])
      for y in Int(rect.y * scale)..<Int((rect.y + rect.h) * scale) {
        for x in Int(rect.x * scale)..<Int((rect.x + rect.w) * scale) {
          let l = linear.at(x, y)
          if luma(l) > best.0 { best = (luma(l), l, encoded.at(x, y)) }
        }
      }
      probes[rect.name] = ["brightestLinear": best.1.map(Double.init), "brightestEncoded": best.2.map(Double.init)]
    }
    result["probes"] = probes
    if frame.code == true { result["code"] = decodeCode(linear) }
    if frame.golden == true {
      let file = "\(render.name)-\(String(format: "%03d", frame.k)).png"
      let rendered = outDir.appendingPathComponent(file)
      try writePNG(encoded, downscale: render.downscale ?? 1, sixteenBit: plan.color == .hlg, to: rendered)
      let golden = goldens.appendingPathComponent(file)
      if bless {
        try? FileManager.default.removeItem(at: golden)
        try FileManager.default.copyItem(at: rendered, to: golden)
        result["blessed"] = file
      }
      result["golden"] = file
      if let mine = readPNG(rendered), let theirs = readPNG(golden) {
        result["compare"] = compare(mine, theirs)
        if mine.width == theirs.width, mine.height == theirs.height, mine.rgb != theirs.rgb {
          // |rendered - golden| x 4, for inspecting a failure from CI's artifact.
          var data = [Float](repeating: 1, count: mine.width * mine.height * 4)
          for pixel in 0..<(mine.width * mine.height) {
            for channel in 0..<3 {
              let delta: Float = abs(mine.rgb[pixel * 3 + channel] - theirs.rgb[pixel * 3 + channel])
              data[pixel * 4 + channel] = min(1, delta * 4)
            }
          }
          let diff = Pixels(width: mine.width, height: mine.height, data: data)
          let diffs = outDir.appendingPathComponent("diffs")
          try FileManager.default.createDirectory(at: diffs, withIntermediateDirectories: true)
          try writePNG(diff, downscale: 1, sixteenBit: false, to: diffs.appendingPathComponent(file))
        }
      } else {
        result["compare"] = ["missingGolden": true]
      }
    }
    frames.append(result)
  }
  entry["frames"] = frames
  if let audio = render.audio {
    let (left, right) = try readMix(built)
    let mix = zip(left, right).map { ($0 + $1) / 2 }
    var windows: [String: Any] = [:], leftWindows: [String: Any] = [:], rightWindows: [String: Any] = [:]
    for window in audio.windows {
      let from = max(0, Int(window.from * 48_000)), to = min(mix.count, Int(window.to * 48_000))
      var tones: [String: Double] = [:], lefts: [String: Double] = [:], rights: [String: Double] = [:]
      for hz in audio.tones {
        let key = String(Int(hz))
        tones[key] = toneAmplitude(from < to ? mix[from..<to] : [], hz: hz)
        lefts[key] = toneAmplitude(from < to ? left[from..<to] : [], hz: hz)
        rights[key] = toneAmplitude(from < to ? right[from..<to] : [], hz: hz)
      }
      windows[window.name] = tones
      leftWindows[window.name] = lefts
      rightWindows[window.name] = rights
    }
    entry["audio"] = ["samples": mix.count, "overshootDropped": lastOvershoot, "shortfall": lastShortfall, "windows": windows, "left": leftWindows, "right": rightWindows]
  }
  renders.append(entry)
}
report["renders"] = renders
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(json)
