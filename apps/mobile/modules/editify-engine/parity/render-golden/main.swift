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

import AVFoundation
import CoreImage
import Foundation
import ImageIO
import Metal
import UniformTypeIdentifiers

// MARK: Manifest

struct Manifest: Decodable {
  struct Media: Decodable {
    let kind: String            // video | audio | png | gif
    let transfer: String?       // sdr | hlg | pq
    let codec: String?          // h264 | hevc
    let w: Int?
    let h: Int?
    let fps: Int?
    let seconds: Double?
    let base: [Double]?         // linear BT.2020, 1.0 = reference white
    let toneHz: Double?
    let orientation: UInt32?
    let frames: [GifFrame]?
    /// Audio: one tone per channel (6 = 5.1 in L R C LFE Ls Rs order).
    let channelTones: [Double]?
    /// Video: per-frame durations in 1/600 s, cycled (variable frame rate).
    let frameDurations600: [Int]?
  }
  struct GifFrame: Decodable { let rgb: [Double]; let delayCs: Int }
  struct Probe: Decodable { let name: String; let x: Double; let y: Double; let r: Int? }
  struct Rect: Decodable { let name: String; let x: Double; let y: Double; let w: Double; let h: Double }
  struct Frame: Decodable {
    let k: Int
    let golden: Bool?
    let code: Bool?
    let probes: [Probe]?
    let rects: [Rect]?
  }
  struct Window: Decodable { let name: String; let from: Double; let to: Double }
  struct Audio: Decodable { let windows: [Window]; let tones: [Double] }
  struct Render: Decodable {
    let name: String
    let plan: String            // repo-relative path to {description, plan}
    let downscale: Int?
    let frames: [Frame]
    let audio: Audio?
    /// Read every frame in one pass and decode its code strip.
    let sequential: Bool?
  }
  let goldens: String           // repo-relative goldens directory
  let fonts: String             // repo-relative directory holding <face>.ttf
  let media: [String: Media]
  let renders: [Render]
}

struct HarnessError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

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

let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
let ciContext: CIContext = {
  let options: [CIContextOption: Any] = [.workingColorSpace: workingSpace, .workingFormat: CIFormat.RGBAh, .cacheIntermediates: false]
  if let device = MTLCreateSystemDefaultDevice() { return CIContext(mtlDevice: device, options: options) }
  return CIContext(options: options.merging([.useSoftwareRenderer: true]) { $1 })
}()

// MARK: Media synthesis

/// Patch layout of every synthetic video, in pixels of a 360-wide frame
/// (scaled for other widths). Values are linear, 1.0 = reference white.
enum Pattern {
  static let codeBits = 8
  static let codeHeight = 40.0
  static let white = (rect: CGRect(x: 20, y: 80, width: 100, height: 100), value: [1.0, 1.0, 1.0])
  static let grey = (rect: CGRect(x: 140, y: 80, width: 100, height: 100), value: [0.18, 0.18, 0.18])
  static let colour = (rect: CGRect(x: 260, y: 80, width: 80, height: 100), value: [0.6, 0.25, 0.05])
  static let highlight = (rect: CGRect(x: 20, y: 200, width: 100, height: 100), value: [2.0, 2.0, 2.0])

  static func frame(_ index: Int, width: Int, height: Int, base: [Double]) -> CIImage {
    let s = Double(width) / 360
    let full = CGRect(x: 0, y: 0, width: width, height: height)
    func fill(_ rect: CGRect, _ rgb: [Double]) -> CIImage {
      // Top-left rect to Core Image's bottom-left space.
      let r = CGRect(x: rect.minX * s, y: Double(height) - rect.maxY * s, width: rect.width * s, height: rect.height * s)
      return CIImage(color: CIColor(red: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1, colorSpace: workingSpace)!).cropped(to: r)
    }
    var image = fill(CGRect(x: 0, y: 0, width: 360, height: Double(height) / s), base)
    // Grid in the lower area: a crop or zoom error moves it.
    var x = 60.0
    while x < 360 { image = fill(CGRect(x: x - 1, y: 320, width: 2, height: Double(height) / s - 320), [0.5, 0.5, 0.5]).composited(over: image); x += 60 }
    var y = 320.0
    while y < Double(height) / s { image = fill(CGRect(x: 0, y: y - 1, width: 360, height: 2), [0.5, 0.5, 0.5]).composited(over: image); y += 80 }
    for patch in [white, grey, colour, highlight] { image = fill(patch.rect, patch.value).composited(over: image) }
    // Frame index, most significant bit first, white = 1.
    let block = 360.0 / Double(codeBits)
    for bit in 0..<codeBits {
      let on = (index >> (codeBits - 1 - bit)) & 1 == 1
      image = fill(CGRect(x: Double(bit) * block, y: 0, width: block, height: codeHeight), on ? [1, 1, 1] : [0, 0, 0]).composited(over: image)
    }
    return image.cropped(to: full)
  }
}

func toneSamples(hz: Double, from start: Int, count: Int, rate: Double) -> [Float] {
  var samples = [Float](repeating: 0, count: count * 2)
  for index in 0..<count {
    let value = Float(0.25 * sin(2 * .pi * hz * Double(start + index) / rate))
    samples[index * 2] = value
    samples[index * 2 + 1] = value
  }
  return samples
}

func channelToneSamples(_ tones: [Double], from start: Int, count: Int, rate: Double) -> [Float] {
  var samples = [Float](repeating: 0, count: count * tones.count)
  for index in 0..<count {
    for (channel, hz) in tones.enumerated() {
      samples[index * tones.count + channel] = Float(0.25 * sin(2 * .pi * hz * Double(start + index) / rate))
    }
  }
  return samples
}

func audioSampleBuffer(_ samples: [Float], start: Int, rate: Double, channels: Int = 2) throws -> CMSampleBuffer {
  var description = AudioStreamBasicDescription(
    mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
    mBytesPerPacket: UInt32(4 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(4 * channels), mChannelsPerFrame: UInt32(channels),
    mBitsPerChannel: 32, mReserved: 0)
  var format: CMAudioFormatDescription?
  var layout = AudioChannelLayout()
  layout.mChannelLayoutTag = channels == 6 ? kAudioChannelLayoutTag_AAC_5_1 : kAudioChannelLayoutTag_Stereo
  CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: MemoryLayout<AudioChannelLayout>.size, layout: &layout,
                                 magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
  var block: CMBlockBuffer?
  let bytes = samples.count * 4
  CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil,
                                     offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
  samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes) }
  var buffer: CMSampleBuffer?
  let status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
    allocator: nil, dataBuffer: block!, formatDescription: format!, sampleCount: samples.count / channels,
    presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(rate)), packetDescriptions: nil, sampleBufferOut: &buffer)
  guard status == noErr, let buffer else { throw HarnessError("audio sample buffer: \(status)") }
  return buffer
}

/// Writes one synthetic video (and its tone) with AVAssetWriter. Returns the codec actually used.
func writeVideo(_ media: Manifest.Media, to url: URL) throws -> String {
  let width = media.w ?? 360, height = media.h ?? 640, fps = media.fps ?? 30
  let frames = Int((media.seconds ?? 8) * Double(fps))
  let transfer = media.transfer ?? "sdr"
  let hdr = transfer != "sdr"
  let colour: [String: String] = switch transfer {
  case "hlg": [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_2020, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_2100_HLG, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_2020]
  case "pq": [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_2020, AVVideoTransferFunctionKey: AVVideoTransferFunction_SMPTE_ST_2084_PQ, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_2020]
  default: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2]
  }
  // The space Core Media decodes these tags with, so the synthetic values round-trip exactly.
  let space = CVImageBufferCreateColorSpaceFromAttachments([
    kCVImageBufferColorPrimariesKey: colour[AVVideoColorPrimariesKey]!, kCVImageBufferTransferFunctionKey: colour[AVVideoTransferFunctionKey]!,
    kCVImageBufferYCbCrMatrixKey: colour[AVVideoYCbCrMatrixKey]!,
  ] as CFDictionary)!.takeRetainedValue()
  let pixelFormat = hdr ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

  func attempt(codec: String) throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    var compression: [String: Any] = [AVVideoMaxKeyFrameIntervalKey: 10, AVVideoAllowFrameReorderingKey: false]
    let codecType: AVVideoCodecType
    switch codec {
    case "h264":
      codecType = .h264
      compression[AVVideoAverageBitRateKey] = 24_000_000
      compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
    case "hevc":
      codecType = .hevc
      compression[AVVideoAverageBitRateKey] = 24_000_000
      compression[AVVideoProfileLevelKey] = "HEVC_Main10_AutoLevel"
    default:
      codecType = .proRes422HQ
      compression = [:]
    }
    var settings: [String: Any] = [AVVideoCodecKey: codecType, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoColorPropertiesKey: colour]
    if !compression.isEmpty { settings[AVVideoCompressionPropertiesKey] = compression }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ])
    guard writer.canAdd(input) else { throw HarnessError("cannot add \(codec) input") }
    writer.add(input)
    var audioInput: AVAssetWriterInput?
    if let hz = media.toneHz, hz > 0 {
      let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000,
      ])
      audio.expectsMediaDataInRealTime = false
      writer.add(audio)
      audioInput = audio
    }
    guard writer.startWriting() else { throw HarnessError("startWriting \(codec): \(writer.error?.localizedDescription ?? "?")") }
    writer.startSession(atSourceTime: .zero)
    let group = DispatchGroup()
    var failure: Error?
    group.enter()
    var frame = 0
    input.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
      while input.isReadyForMoreMediaData {
        if frame >= frames { input.markAsFinished(); group.leave(); return }
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
        guard let buffer else { failure = HarnessError("no pixel buffer"); input.markAsFinished(); group.leave(); return }
        CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, colour[AVVideoColorPrimariesKey]! as CFString, .shouldPropagate)
        CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, colour[AVVideoTransferFunctionKey]! as CFString, .shouldPropagate)
        CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, colour[AVVideoYCbCrMatrixKey]! as CFString, .shouldPropagate)
        ciContext.render(Pattern.frame(frame, width: width, height: height, base: media.base ?? [0.1, 0.1, 0.1]), to: buffer,
                         bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: space)
        let pts: CMTime
        if let pattern = media.frameDurations600, !pattern.isEmpty {
          pts = CMTime(value: CMTimeValue((0..<frame).reduce(0) { $0 + pattern[$1 % pattern.count] }), timescale: 600)
        } else {
          pts = CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps))
        }
        if !adaptor.append(buffer, withPresentationTime: pts) {
          failure = writer.error ?? HarnessError("append failed"); input.markAsFinished(); group.leave(); return
        }
        frame += 1
      }
    }
    if let audioInput, let hz = media.toneHz {
      group.enter()
      let total = Int((media.seconds ?? 8) * 48_000)
      var cursor = 0
      audioInput.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
        while audioInput.isReadyForMoreMediaData {
          if cursor >= total { audioInput.markAsFinished(); group.leave(); return }
          let count = min(1024, total - cursor)
          do {
            audioInput.append(try audioSampleBuffer(toneSamples(hz: hz, from: cursor, count: count, rate: 48_000), start: cursor, rate: 48_000))
          } catch { failure = error; audioInput.markAsFinished(); group.leave(); return }
          cursor += count
        }
      }
    }
    group.wait()
    if let failure { throw failure }
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else { throw HarnessError("\(codec) writer: \(writer.error?.localizedDescription ?? "?")") }
  }

  let codec = media.codec ?? (hdr ? "hevc" : "h264")
  do {
    try attempt(codec: codec)
    return codec
  } catch {
    // No hardware or software encoder for it here (a CI VM): ProRes is always available on macOS.
    FileHandle.standardError.write("note: \(url.lastPathComponent) fell back to ProRes 422 HQ (\(error))\n".data(using: .utf8)!)
    try attempt(codec: "prores")
    return "prores"
  }
}

func writeAudio(_ media: Manifest.Media, to url: URL) throws {
  try? FileManager.default.removeItem(at: url)
  let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
  // Manifest order L R C LFE Ls Rs; AAC 5.1 stores C L R Ls Rs LFE.
  let named = media.channelTones ?? [media.toneHz ?? 440, media.toneHz ?? 440]
  let tones = named.count == 6 ? [2, 0, 1, 4, 5, 3].map { named[$0] } : named
  var layout = AudioChannelLayout()
  layout.mChannelLayoutTag = tones.count == 6 ? kAudioChannelLayoutTag_AAC_5_1 : kAudioChannelLayoutTag_Stereo
  let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: tones.count,
    AVEncoderBitRateKey: tones.count == 6 ? 384_000 : 192_000,
    AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
  ])
  input.expectsMediaDataInRealTime = false
  writer.add(input)
  writer.startWriting()
  writer.startSession(atSourceTime: .zero)
  let total = Int((media.seconds ?? 8) * 48_000)
  var cursor = 0
  while cursor < total {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.001) }
    let count = min(1024, total - cursor)
    input.append(try audioSampleBuffer(channelToneSamples(tones, from: cursor, count: count, rate: 48_000), start: cursor, rate: 48_000, channels: tones.count))
    cursor += count
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  guard writer.status == .completed else { throw HarnessError("audio writer: \(writer.error?.localizedDescription ?? "?")") }
}

func cgImage(_ image: CIImage, width: Int, height: Int) -> CGImage {
  ciContext.createCGImage(image, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8,
                          colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)!
}

/// The logo, upright: 100 x 160, top half red, bottom half blue, a white square
/// top-left. Stored rotated with EXIF orientation 6 (rotate 90 clockwise to view).
func writeLogo(_ media: Manifest.Media, to url: URL) throws {
  let w = 100.0, h = 160.0
  let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
  func fill(_ r: CGRect, _ c: [CGFloat]) -> CIImage { CIImage(color: CIColor(red: c[0], green: c[1], blue: c[2], alpha: 1, colorSpace: srgb)!).cropped(to: r) }
  var upright = fill(CGRect(x: 0, y: 0, width: w, height: h / 2), [0, 0.2, 1])
    .composited(over: fill(CGRect(x: 0, y: h / 2, width: w, height: h / 2), [1, 0.1, 0.1]))
  upright = fill(CGRect(x: 0, y: h - 40, width: 40, height: 40), [1, 1, 1]).composited(over: upright)
  let orientation = CGImagePropertyOrientation(rawValue: media.orientation ?? 1) ?? .up
  // Stored pixels are the upright image turned back by the inverse of `orientation`.
  let inverse: CGImagePropertyOrientation = switch orientation {
  case .right: .left
  case .left: .right
  default: orientation
  }
  let stored = upright.oriented(inverse)
  let moved = stored.transformed(by: CGAffineTransform(translationX: -stored.extent.minX, y: -stored.extent.minY))
  let image = cgImage(moved, width: Int(moved.extent.width), height: Int(moved.extent.height))
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw HarnessError("png destination") }
  CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation.rawValue] as CFDictionary)
  guard CGImageDestinationFinalize(destination) else { throw HarnessError("png write") }
}

func writeGif(_ media: Manifest.Media, to url: URL) throws {
  let frames = media.frames ?? []
  let w = media.w ?? 120, h = media.h ?? 90
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, frames.count, nil) else { throw HarnessError("gif destination") }
  CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
  let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
  for frame in frames {
    let image = CIImage(color: CIColor(red: frame.rgb[0], green: frame.rgb[1], blue: frame.rgb[2], alpha: 1, colorSpace: srgb)!)
      .cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
    let delay = Double(frame.delayCs) / 100
    CGImageDestinationAddImage(destination, cgImage(image, width: w, height: h), [kCGImagePropertyGIFDictionary: [
      kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay,
    ]] as CFDictionary)
  }
  guard CGImageDestinationFinalize(destination) else { throw HarnessError("gif write") }
}

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
    return AVURLAsset(url: url)
  },
  imageFile: { ref in
    guard ref.kind == .image, let url = mediaFiles[ref.id] else { throw HarnessError("no image asset \(ref.id)") }
    return url
  })
let fontsDir = repo.appendingPathComponent(manifest.fonts)
let fonts = PlanFonts { fontsDir.appendingPathComponent("\($0.rawValue).ttf") }

// MARK: Frames

struct Pixels {
  let width: Int
  let height: Int
  var data: [Float]   // RGBA, row 0 at the top
  func at(_ x: Int, _ y: Int) -> [Float] {
    let i = (min(max(y, 0), height - 1) * width + min(max(x, 0), width - 1)) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }
}

func pixels(_ buffer: CVPixelBuffer, space: CGColorSpace) -> Pixels {
  let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
  var data = [Float](repeating: 0, count: width * height * 4)
  // Core Image's bitmap rows run top to bottom.
  ciContext.render(CIImage(cvPixelBuffer: buffer), toBitmap: &data, rowBytes: width * 16,
                   bounds: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBAf, colorSpace: space)
  return Pixels(width: width, height: height, data: data)
}

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
  // Place every buffer by its PTS and keep [0, duration): time-pitch processing
  // emits a tail past the end, which T7's writer must drop the same way.
  let total = Int((built.composition.duration.seconds * 48_000).rounded())
  left = [Float](repeating: 0, count: total)
  right = [Float](repeating: 0, count: total)
  var written = 0
  while let sample = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(sample) {
    let length = CMBlockBufferGetDataLength(block)
    var bytes = [Float](repeating: 0, count: length / 4)
    _ = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
    let first = Int((CMSampleBufferGetPresentationTimeStamp(sample).seconds * 48_000).rounded())
    var index = 0
    while index + 1 < bytes.count {
      let at = first + index / 2
      if at >= 0, at < total { left[at] = bytes[index]; right[at] = bytes[index + 1]; written = max(written, at + 1) }
      index += 2
    }
  }
  left = Array(left.prefix(written))
  right = Array(right.prefix(written))
  guard reader.status != .failed else { throw HarnessError("audio reader: \(reader.error?.localizedDescription ?? "?")") }
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

func decodeCode(_ linear: Pixels) -> Int {
  var value = 0
  let block = Double(linear.width) / Double(Pattern.codeBits)
  for bit in 0..<Pattern.codeBits {
    let p = linear.at(Int(block * (Double(bit) + 0.5)), Int(20 * Double(linear.width) / 360))
    value = value << 1 | (p[0] > 0.5 ? 1 : 0)
  }
  return value
}

/// Amplitude of a pure tone in a Hann-windowed stretch (Goertzel), in sample units.
func toneAmplitude(_ samples: ArraySlice<Float>, hz: Double, rate: Double = 48_000) -> Double {
  let n = samples.count
  guard n > 0 else { return 0 }
  let w = 2 * Double.pi * hz / rate
  var re = 0.0, im = 0.0, windowSum = 0.0
  for (offset, value) in samples.enumerated() {
    let hann = 0.5 - 0.5 * cos(2 * Double.pi * Double(offset) / Double(n - 1))
    windowSum += hann
    re += Double(value) * hann * cos(w * Double(offset))
    im -= Double(value) * hann * sin(w * Double(offset))
  }
  return 2 * (re * re + im * im).squareRoot() / windowSum
}

/// Encoded values to PNG bytes (8-bit for SDR, 16-bit for HLG), averaging `downscale` x `downscale` blocks.
func writePNG(_ encoded: Pixels, downscale: Int, sixteenBit: Bool, to url: URL) throws {
  let width = encoded.width / downscale, height = encoded.height / downscale
  let channels = 3
  var floats = [Float](repeating: 0, count: width * height * channels)
  for y in 0..<height {
    for x in 0..<width {
      var sum: [Float] = [0, 0, 0]
      for dy in 0..<downscale { for dx in 0..<downscale { let p = encoded.at(x * downscale + dx, y * downscale + dy); for c in 0..<3 { sum[c] += p[c] } } }
      for c in 0..<3 { floats[(y * width + x) * channels + c] = sum[c] / Float(downscale * downscale) }
    }
  }
  let data: Data
  let bits = sixteenBit ? 16 : 8
  if sixteenBit {
    var words = floats.map { UInt16(min(max($0, 0), 1) * 65535 + 0.5).bigEndian }
    data = Data(bytes: &words, count: words.count * 2)
  } else {
    data = Data(floats.map { UInt8(min(max($0, 0), 1) * 255 + 0.5) })
  }
  let provider = CGDataProvider(data: data as CFData)!
  let image = CGImage(width: width, height: height, bitsPerComponent: bits, bitsPerPixel: bits * channels, bytesPerRow: width * channels * bits / 8,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw HarnessError("png") }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw HarnessError("png write \(url.lastPathComponent)") }
}

/// A PNG's raw samples as 0...1 floats (RGB), with no colour conversion.
func readPNG(_ url: URL) -> (width: Int, height: Int, rgb: [Float])? {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
        let data = image.dataProvider?.data as Data? else { return nil }
  let bits = image.bitsPerComponent, perPixel = image.bitsPerPixel / bits
  // ImageIO may hand 16-bit samples back in host (little-endian) order.
  let little = image.bitmapInfo.rawValue & CGBitmapInfo.byteOrderMask.rawValue == CGBitmapInfo.byteOrder16Little.rawValue
  var rgb = [Float](repeating: 0, count: image.width * image.height * 3)
  data.withUnsafeBytes { raw in
    for y in 0..<image.height {
      for x in 0..<image.width {
        for c in 0..<3 {
          let offset = y * image.bytesPerRow + (x * perPixel + c) * bits / 8
          let value: Float
          if bits == 16 {
            let first = UInt16(raw[offset]), second = UInt16(raw[offset + 1])
            let word: UInt16 = little ? (second << 8 | first) : (first << 8 | second)
            value = Float(word) / 65535
          } else {
            value = Float(raw[offset]) / 255
          }
          rgb[(y * image.width + x) * 3 + c] = value
        }
      }
    }
  }
  return (image.width, image.height, rgb)
}

/// Per-channel mean absolute difference, and the max of the 5x5 box-blurred per-pixel max-channel difference.
func compare(_ a: (width: Int, height: Int, rgb: [Float]), _ b: (width: Int, height: Int, rgb: [Float])) -> [String: Any] {
  guard a.width == b.width, a.height == b.height else { return ["sizeMismatch": true] }
  let count = a.width * a.height
  var mean = [Double](repeating: 0, count: 3)
  var worst = [Float](repeating: 0, count: count)
  for i in 0..<count {
    var m: Float = 0
    for c in 0..<3 {
      let d = abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c])
      mean[c] += Double(d)
      m = max(m, d)
    }
    worst[i] = m
  }
  var blurredMax = 0.0
  let radius = 2
  for y in 0..<a.height {
    for x in 0..<a.width {
      var sum: Float = 0
      var n = 0
      for dy in -radius...radius {
        for dx in -radius...radius {
          let yy = y + dy, xx = x + dx
          guard yy >= 0, yy < a.height, xx >= 0, xx < a.width else { continue }
          sum += worst[yy * a.width + xx]; n += 1
        }
      }
      blurredMax = max(blurredMax, Double(sum) / Double(n))
    }
  }
  return ["meanAbs": mean.map { $0 / Double(count) }, "blurredMax": blurredMax, "maxAbs": Double(worst.max() ?? 0)]
}

func luma(_ p: [Float]) -> Float { 0.2627 * p[0] + 0.678 * p[1] + 0.0593 * p[2] }

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
let notUpdated = try PlanBuilder.update(first, to: moved, options: sharedOptions)
let secondMedia = try await PlanBuilder.prepare(moved, resolver: resolver, reusing: firstMedia)
_ = try PlanBuilder.assemble(moved, media: secondMedia, options: sharedOptions)
checks["rebuild"] = [
  "parameterEditUpdates": updated != nil,
  "sameComposition": updated.map { $0.composition === first.composition } ?? false,
  "newVideoComposition": updated.map { $0.videoComposition !== first.videoComposition } ?? false,
  "structuralEditRefused": notUpdated == nil,
  "assetsReused": secondMedia.videos["asset-talk"]?.asset === firstMedia.videos["asset-talk"]?.asset,
  "imagesDecodedOnce": decodedAfterFirst > 0 && sharedMedia.cachedImages == decodedAfterFirst,
]
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
    entry["audio"] = ["samples": mix.count, "windows": windows, "left": leftWindows, "right": rightWindows]
  }
  renders.append(entry)
}
report["renders"] = renders
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(json)
