// Export harness (plan P4, 8A + OV8): runs PlanExporter, the phone's on-device export,
// on macOS and inspects the files it writes with AVFoundation alone.
//
//   export-harness <render-golden manifest> <export manifest> <repo root> <work dir> <out dir>
//
// 1. Synthesizes the media the export plans name (HarnessMedia.swift, the render-golden
//    media plus parity/export/manifest.json's own: a clap clip, tones for the loudness rules).
// 2. Writes loudness reference signals to <out>/loudness/*.wav and meters them with
//    LoudnessMeter; server/test/export.test.ts holds them to ffmpeg's ebur128.
// 3. Exports every plan to <out>/<name>.mp4 and reports, from the file: duration and frame
//    count, codec, profile, bit depth and colour tags, audio format and length, the decoded
//    mix's loudness and true peak, golden-frame comparisons, moov placement, and for the
//    clap plan the time of the white frame and of the click.
// 4. Checks cancel (temp file removed), a full disk (refused before writing) and the empty plan.
// Prints one JSON report on stdout.

import AVFoundation
import CoreImage
import Foundation

struct ExportManifest: Decodable {
  struct Export: Decodable {
    let name: String
    let plan: String
    /// Seconds of the clap in the plan's timeline (A/V sync check).
    let clapAt: Double?
  }
  let media: [String: Manifest.Media]
  let exports: [Export]
}

let arguments = CommandLine.arguments
guard arguments.count >= 6 else {
  FileHandle.standardError.write("usage: export-harness <golden manifest> <export manifest> <repo> <work> <out>\n".data(using: .utf8)!)
  exit(2)
}
let goldenManifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
let exportManifest = try JSONDecoder().decode(ExportManifest.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[2])))
let repo = URL(fileURLWithPath: arguments[3])
let work = URL(fileURLWithPath: arguments[4])
let outDir = URL(fileURLWithPath: arguments[5])
try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let goldens = repo.appendingPathComponent(goldenManifest.goldens)
let fontsDir = repo.appendingPathComponent(goldenManifest.fonts)
let fonts = PlanFonts { fontsDir.appendingPathComponent("\($0.rawValue).ttf") }

func planJSON(_ path: String) throws -> Data {
  let wrapper = try JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent(path))) as! [String: Any]
  return try JSONSerialization.data(withJSONObject: wrapper["plan"]!)
}

// MARK: Media (only what the export plans name)

var allMedia = goldenManifest.media
for (id, media) in exportManifest.media { allMedia[id] = media }
var wanted = Set<String>()
for item in exportManifest.exports {
  let plan = try RenderPlan.decode(try planJSON(item.plan))
  for segment in plan.video.segments { for layer in segment.layers { wanted.insert(layer.assetRef.id) } }
  for entry in plan.audio { wanted.insert(entry.assetRef.id) }
  for overlay in plan.overlays { if let id = overlay.media?.assetRef.id { wanted.insert(id) } }
}
var mediaFiles: [String: URL] = [:]
for id in wanted.sorted() {
  guard let media = allMedia[id] else { throw HarnessError("no media \(id) in either manifest") }
  switch media.kind {
  case "video":
    let url = work.appendingPathComponent("\(id).mov")
    _ = try writeVideo(media, to: url)
    mediaFiles[id] = url
  case "audio":
    let url = work.appendingPathComponent("\(id).m4a")
    try writeAudio(media, to: url)
    mediaFiles[id] = url
  case "png":
    let url = work.appendingPathComponent("\(id).png")
    try writeLogo(media, to: url)
    mediaFiles[id] = url
  case "gif":
    let url = work.appendingPathComponent("\(id).gif")
    try writeGif(media, to: url)
    mediaFiles[id] = url
  default:
    throw HarnessError("unknown media kind \(media.kind)")
  }
}

let resolver = PlanAssetResolver(
  asset: { ref in
    guard ref.kind != .image, let url = mediaFiles[ref.id] else { throw HarnessError("no \(ref.kind.rawValue) asset \(ref.id)") }
    return AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
  },
  imageFile: { ref in
    guard ref.kind == .image, let url = mediaFiles[ref.id] else { throw HarnessError("no image asset \(ref.id)") }
    return url
  })

var report: [String: Any] = [:]

func orNull(_ value: Double?) -> Any { value.map { $0 as Any } ?? NSNull() }

// MARK: Loudness reference signals

/// Deterministic xorshift noise in -1...1.
struct Noise {
  var state: UInt64
  mutating func next() -> Double {
    state ^= state << 13; state ^= state >> 7; state ^= state << 17
    return Double(state % 2_000_001) / 1_000_000 - 1
  }
}

func writeWav(_ interleaved: [Float], to url: URL) throws {
  var data = Data()
  func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  let bytes = UInt32(interleaved.count * 4)
  data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + bytes))
  data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(3)); append(UInt16(2))
  append(UInt32(48_000)); append(UInt32(48_000 * 8)); append(UInt16(8)); append(UInt16(32))
  data.append(contentsOf: Array("data".utf8)); append(bytes)
  interleaved.withUnsafeBytes { data.append(contentsOf: $0) }
  try data.write(to: url)
}

func pinkNoise(seconds: Double) -> [Float] {
  let count = Int(seconds * 48_000)
  var out = [Float](repeating: 0, count: count * 2)
  for channel in 0..<2 {
    var noise = Noise(state: channel == 0 ? 0x9E37_79B9_7F4A_7C15 : 0xD1B5_4A32_D192_ED03)
    // Paul Kellet's refined pink filter.
    var b = [Double](repeating: 0, count: 7)
    for i in 0..<count {
      let white = noise.next()
      b[0] = 0.99886 * b[0] + white * 0.0555179
      b[1] = 0.99332 * b[1] + white * 0.0750759
      b[2] = 0.96900 * b[2] + white * 0.1538520
      b[3] = 0.86650 * b[3] + white * 0.3104856
      b[4] = 0.55000 * b[4] + white * 0.5329522
      b[5] = -0.7616 * b[5] - white * 0.0168980
      let pink = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362
      b[6] = white * 0.115926
      out[i * 2 + channel] = Float(pink * 0.11)
    }
  }
  return out
}

/// Voiced syllables: a gliding 110-210 Hz pitch with falling harmonics, 4-5 syllables a
/// second shaped by a raised sine, and pauses of 0.3 to 0.6 s between phrases.
func speechLike(seconds: Double) -> [Float] {
  let count = Int(seconds * 48_000)
  var out = [Float](repeating: 0, count: count * 2)
  var phase = 0.0
  for i in 0..<count {
    let t = Double(i) / 48_000
    let f0 = 160 + 50 * sin(2 * .pi * 0.7 * t) + 15 * sin(2 * .pi * 3.1 * t)
    phase += 2 * .pi * f0 / 48_000
    var voice = 0.0
    for harmonic in 1...12 { voice += sin(Double(harmonic) * phase) / Double(harmonic * harmonic).squareRoot() }
    let phrase = t.truncatingRemainder(dividingBy: 2.4)
    let syllable = max(0, sin(2 * .pi * 4.5 * t))
    let envelope = phrase < 1.9 ? syllable * syllable : 0
    let value = Float(0.12 * voice * envelope)
    out[i * 2] = value
    out[i * 2 + 1] = value * 0.9
  }
  return out
}

func scaled(_ samples: [Float], toLufs target: Double) -> [Float] {
  let meter = LoudnessMeter()
  meter.add(samples)
  guard let measured = meter.integrated else { return samples }
  let gain = Float(pow(10, (target - measured) / 20))
  return samples.map { $0 * gain }
}

var signals: [(String, [Float])] = []
signals.append(("pink-23", scaled(pinkNoise(seconds: 10), toLufs: -23)))
signals.append(("speech-18", scaled(speechLike(seconds: 12), toLufs: -18)))
// Room tone just above the -70 LUFS absolute gate (and under the -60 silence rule).
signals.append(("near-silence-65", scaled(pinkNoise(seconds: 8), toLufs: -65)))
signals.append(("intersample-12k", (0..<(48_000 * 4)).flatMap { (i: Int) -> [Float] in
  let v = Float(0.5 * sin(2 * .pi * 12_000 * Double(i) / 48_000 + .pi / 4)); return [v, v]
}))
let loudnessDir = outDir.appendingPathComponent("loudness")
try FileManager.default.createDirectory(at: loudnessDir, withIntermediateDirectories: true)
var meterReport: [String: Any] = [:]
for (name, samples) in signals {
  let url = loudnessDir.appendingPathComponent("\(name).wav")
  try writeWav(samples, to: url)
  // Odd chunk sizes: the meter must not depend on how the stream is cut.
  let meter = LoudnessMeter()
  var index = 0, chunk = 997
  while index < samples.count / 2 {
    let take = min(chunk, samples.count / 2 - index)
    meter.add(Array(samples[(index * 2)..<((index + take) * 2)]))
    index += take
    chunk = chunk == 997 ? 4096 : 997
  }
  meterReport[name] = ["file": url.path, "integrated": orNull(meter.integrated), "truePeak": orNull(meter.truePeakDb),
                       "samplePeak": orNull(meter.samplePeakDb)]
}
report["meter"] = meterReport

// The rule table, straight from LoudnessRules (render-plan-schema.ts loudness).
let rules = RenderPlan.Loudness(targetLufs: -16, deadbandLu: 0.5, silentBelowLufs: -60, limiterCeilingDb: -1.5, truePeakLimitDb: -1)
let off = RenderPlan.Loudness(targetLufs: nil, deadbandLu: 0.5, silentBelowLufs: -60, limiterCeilingDb: -1.5, truePeakLimitDb: -1)
report["rules"] = [
  "inDeadband": LoudnessRules.gainDb(measured: -16.4, rules),
  "edgeOfDeadband": LoudnessRules.gainDb(measured: -15.5, rules),
  "quiet": LoudnessRules.gainDb(measured: -26.04, rules),
  "loud": LoudnessRules.gainDb(measured: -9.96, rules),
  "silent": LoudnessRules.gainDb(measured: nil, rules),
  "belowSilentGate": LoudnessRules.gainDb(measured: -61, rules),
  "off": LoudnessRules.gainDb(measured: -30, off),
  "limiterOn": LoudnessRules.limiterOn(rules),
  "limiterOff": LoudnessRules.limiterOn(off),
]

// MARK: File inspection

func fourCC(_ code: FourCharCode) -> String {
  String(bytes: [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }, encoding: .ascii) ?? "?"
}

/// Top-level box types in file order (ftyp, moov, mdat... ; a fragmented file has moof).
func topLevelBoxes(_ url: URL) throws -> [String] {
  let handle = try FileHandle(forReadingFrom: url)
  defer { try? handle.close() }
  let size = try handle.seekToEnd()
  var offset: UInt64 = 0
  var boxes: [String] = []
  while offset + 8 <= size, boxes.count < 64 {
    try handle.seek(toOffset: offset)
    let header = try handle.read(upToCount: 16) ?? Data()
    guard header.count >= 8 else { break }
    var length = UInt64(header[0]) << 24 | UInt64(header[1]) << 16 | UInt64(header[2]) << 8 | UInt64(header[3])
    let type = String(bytes: header[4..<8], encoding: .ascii) ?? "?"
    if length == 1, header.count >= 16 { length = header[8..<16].reduce(0) { $0 << 8 | UInt64($1) } }
    if length == 0 { length = size - offset }
    guard length >= 8 else { break }
    boxes.append(type)
    offset += length
  }
  return boxes
}

func decodeFrame(_ asset: AVAsset, track: AVAssetTrack, at k: Int, fps: Int) throws -> CVPixelBuffer {
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
  ])
  reader.add(output)
  reader.timeRange = CMTimeRange(start: CMTime(value: CMTimeValue(k), timescale: CMTimeScale(fps)), duration: CMTime(value: 1, timescale: CMTimeScale(fps)))
  guard reader.startReading() else { throw HarnessError("frame reader: \(reader.error?.localizedDescription ?? "?")") }
  defer { reader.cancelReading() }
  while let sample = output.copyNextSampleBuffer() {
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    if abs(pts.seconds - Double(k) / Double(fps)) < 0.5 / Double(fps), let buffer = CMSampleBufferGetImageBuffer(sample) { return buffer }
  }
  throw HarnessError("no decoded frame \(k)")
}

// swiftlint:disable:next function_body_length
func inspect(_ url: URL, plan: RenderPlan, name: String, clapAt: Double?) async throws -> [String: Any] {
  var result: [String: Any] = [:]
  let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
  result["duration"] = try await asset.load(.duration).seconds
  result["boxes"] = try topLevelBoxes(url)
  guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw HarnessError("\(name): no video track") }
  let (videoRange, videoFormats) = try await video.load(.timeRange, .formatDescriptions)
  result["videoDuration"] = videoRange.duration.seconds
  result["videoStart"] = videoRange.start.seconds
  if let format = videoFormats.first {
    result["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    result["size"] = [Int(dimensions.width), Int(dimensions.height)]
    let ext = { (key: CFString) in CMFormatDescriptionGetExtension(format, extensionKey: key) }
    result["primaries"] = ext(kCMFormatDescriptionExtension_ColorPrimaries) as? String ?? "none"
    result["transfer"] = ext(kCMFormatDescriptionExtension_TransferFunction) as? String ?? "none"
    result["matrix"] = ext(kCMFormatDescriptionExtension_YCbCrMatrix) as? String ?? "none"
    let atoms = ext(kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any] ?? [:]
    if let avcC = atoms["avcC"] as? Data, avcC.count > 3 {
      result["profileIdc"] = Int(avcC[1])
      result["bitDepth"] = 8
    }
    if let hvcC = atoms["hvcC"] as? Data, hvcC.count > 18 {
      result["profileIdc"] = Int(hvcC[1] & 0x1F)
      result["bitDepth"] = Int(hvcC[17] & 0x07) + 8
      result["chromaBitDepth"] = Int(hvcC[18] & 0x07) + 8
    }
  }
  // Frame count and timestamps, straight from the samples.
  let countReader = try AVAssetReader(asset: asset)
  let samplesOut = AVAssetReaderTrackOutput(track: video, outputSettings: nil)
  countReader.add(samplesOut)
  countReader.startReading()
  var frames = 0, lastPTS = -1.0
  var syncFrames = 0
  while let sample = samplesOut.copyNextSampleBuffer() {
    guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
    frames += CMSampleBufferGetNumSamples(sample)
    lastPTS = max(lastPTS, CMSampleBufferGetPresentationTimeStamp(sample).seconds)
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    if attachments?.first?[kCMSampleAttachmentKey_NotSync] == nil { syncFrames += 1 }
  }
  result["frames"] = frames
  result["lastPTS"] = lastPTS
  result["keyframes"] = syncFrames

  guard let audio = try await asset.loadTracks(withMediaType: .audio).first else { throw HarnessError("\(name): no audio track") }
  let (audioRange, audioFormats) = try await audio.load(.timeRange, .formatDescriptions)
  result["audioDuration"] = audioRange.duration.seconds
  result["audioStart"] = audioRange.start.seconds
  if let format = audioFormats.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee {
    result["audioFormat"] = fourCC(asbd.mFormatID)
    result["audioChannels"] = Int(asbd.mChannelsPerFrame)
    result["audioRate"] = asbd.mSampleRate
  }
  let estimated = try await audio.load(.estimatedDataRate)
  result["audioBitrate"] = Double(estimated)
  // The decoded mix: loudness, true peak, length, the click.
  let audioReader = try AVAssetReader(asset: asset)
  let pcm = AVAssetReaderTrackOutput(track: audio, outputSettings: PlanExporter.mixSettings)
  audioReader.add(pcm)
  audioReader.startReading()
  var mix: [Float] = []
  while let sample = pcm.copyNextSampleBuffer() { mix += PlanExporter.floats(sample) }
  let meter = LoudnessMeter()
  meter.add(mix)
  result["decodedAudioFrames"] = mix.count / 2
  result["lufs"] = orNull(meter.integrated)
  result["truePeak"] = orNull(meter.truePeakDb)
  result["samplePeak"] = orNull(meter.samplePeakDb)

  // Golden frames (the render-golden manifest's frames for this plan), decoded from the file.
  if let render = goldenManifest.renders.first(where: { $0.name == name }) {
    var compares: [[String: Any]] = []
    for frame in render.frames where frame.golden == true {
      let buffer = try decodeFrame(asset, track: video, at: frame.k, fps: plan.fps)
      let encoded = pixels(buffer, space: PlanColorPipeline.outputSpace(plan.color))
      let file = "\(name)-\(String(format: "%03d", frame.k)).png"
      let rendered = outDir.appendingPathComponent("frames").appendingPathComponent(file)
      try FileManager.default.createDirectory(at: rendered.deletingLastPathComponent(), withIntermediateDirectories: true)
      try writePNG(encoded, downscale: render.downscale ?? 1, sixteenBit: plan.color == .hlg, to: rendered)
      var entry: [String: Any] = ["k": frame.k, "golden": file]
      if let mine = readPNG(rendered), let theirs = readPNG(goldens.appendingPathComponent(file)) {
        entry["compare"] = compare(mine, theirs)
      } else {
        entry["compare"] = ["missingGolden": true]
      }
      compares.append(entry)
    }
    result["goldenFrames"] = compares
  }

  if let clapAt {
    // The white frame: the first decoded frame whose centre is brighter than 0.5 linear.
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: video, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
    ])
    reader.add(output)
    reader.startReading()
    var whiteAt: Double?
    while let sample = output.copyNextSampleBuffer(), let buffer = CMSampleBufferGetImageBuffer(sample) {
      let linear = pixels(buffer, space: workingSpace)
      // Off the pattern's grid lines and patches: the base colour (0.02) until the clap.
      let probe = linear.at(linear.width * 2 / 5, linear.height * 9 / 10)
      if probe.allSatisfy({ $0 > 0.8 }) {
        whiteAt = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        break
      }
    }
    reader.cancelReading()
    // The click: the first sample above half the file's peak.
    let peak = mix.map { abs($0) }.max() ?? 0
    var clickAt: Double?
    if peak > 0, let index = mix.firstIndex(where: { abs($0) > peak / 2 }) { clickAt = Double(index / 2) / 48_000 }
    result["clap"] = ["expected": clapAt, "video": orNull(whiteAt), "audio": orNull(clickAt)]
  }
  return result
}

// MARK: Exports

final class PhaseLog: @unchecked Sendable {
  private let lock = NSLock()
  private var phases: [String] = []
  private var last: [String: Double] = [:]
  private(set) var backwards = 0
  func record(_ phase: PlanExportPhase, _ value: Double) {
    lock.withLock {
      if phases.last != phase.rawValue { phases.append(phase.rawValue) }
      if let previous = last[phase.rawValue], value < previous - 1e-9 { backwards += 1 }
      last[phase.rawValue] = value
    }
  }
  var summary: [String: Any] { lock.withLock { ["phases": phases, "backwards": backwards, "final": last] } }
}

var exports: [[String: Any]] = []
for item in exportManifest.exports {
  let plan = try RenderPlan.decode(try planJSON(item.plan))
  let url = outDir.appendingPathComponent("\(item.name).mp4")
  let log = PhaseLog()
  var entry: [String: Any] = ["name": item.name, "planFrames": plan.frameCount, "planDuration": plan.duration, "color": plan.color.rawValue]
  do {
    let stats = try await PlanExporter.export(plan, resolver: resolver, to: url, build: PlanBuildOptions(fonts: fonts), progress: { log.record($0, $1) })
    entry["stats"] = stats.dictionary
    entry["progress"] = log.summary
    entry["file"] = try await inspect(url, plan: plan, name: item.name, clapAt: item.clapAt)
  } catch {
    entry["error"] = String(describing: error)
  }
  exports.append(entry)
}
report["exports"] = exports

// MARK: Failure paths

var failures: [String: Any] = [:]
do {
  let plan = try RenderPlan.decode(try planJSON("packages/shared/fixtures/render-plans/caption-karaoke.json"))
  let url = outDir.appendingPathComponent("cancelled.mp4")
  let control = PlanExportControl()
  var outcome = "finished"
  let sawWriting = PhaseLog()
  do {
    _ = try await PlanExporter.export(plan, resolver: resolver, to: url, build: PlanBuildOptions(fonts: fonts), control: control, progress: { phase, value in
      sawWriting.record(phase, value)
      if phase == .writing, value > 0.3 { control.cancel() }
    })
  } catch PlanExportError.cancelled {
    outcome = "cancelled"
  } catch {
    outcome = "error: \(error)"
  }
  failures["cancel"] = ["outcome": outcome, "fileRemoved": !FileManager.default.fileExists(atPath: url.path), "progress": sawWriting.summary]
}
do {
  let plan = try RenderPlan.decode(try planJSON("packages/shared/fixtures/render-plans/crossfade.json"))
  let url = outDir.appendingPathComponent("no-space.mp4")
  var outcome = "finished"
  var needed: Int64 = 0
  do {
    _ = try await PlanExporter.export(plan, resolver: resolver, to: url, build: PlanBuildOptions(fonts: fonts), available: { _ in 1_000_000 })
  } catch PlanExportError.notEnoughSpace(let need, _) {
    outcome = "notEnoughSpace"
    needed = need
  } catch {
    outcome = "error: \(error)"
  }
  failures["noSpace"] = ["outcome": outcome, "needed": needed, "fileAbsent": !FileManager.default.fileExists(atPath: url.path),
                         "message": PlanExportError.notEnoughSpace(needed: 1, available: 0).localizedDescription]
}
do {
  let plan = try RenderPlan.decode(try planJSON("packages/shared/fixtures/render-plans/empty-project.json"))
  var outcome = "finished"
  do {
    _ = try await PlanExporter.export(plan, resolver: resolver, to: outDir.appendingPathComponent("empty.mp4"))
  } catch PlanExportError.emptyPlan {
    outcome = "emptyPlan"
  } catch {
    outcome = "error: \(error)"
  }
  failures["empty"] = outcome
}
do {
  let plan = try RenderPlan.decode(try planJSON("packages/shared/fixtures/render-plans/crossfade.json"))
  let url = outDir.appendingPathComponent("hot.mp4")
  var outcome = "finished"
  do {
    _ = try await PlanExporter.export(plan, resolver: resolver, to: url, build: PlanBuildOptions(fonts: fonts), thermalCritical: { true })
  } catch PlanExportError.tooHot {
    outcome = "tooHot"
  } catch {
    outcome = "error: \(error)"
  }
  failures["thermal"] = ["outcome": outcome, "fileRemoved": !FileManager.default.fileExists(atPath: url.path)]
}
report["failures"] = failures
report["defaults"] = [
  "bitrate1080pSdr": PlanExporter.defaultBitrate(try RenderPlan.decode(try planJSON("packages/shared/fixtures/render-plans/caption-karaoke.json"))),
]

let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(json)
