// Shared by the parity harnesses that render plans (render-golden, export): the
// manifest format, deterministic media synthesis (test videos with known linear
// patches and a frame-index code strip, AAC tones, oriented PNGs, GIFs), and
// pixel / PNG / tone helpers. Compiled next to each harness's main.swift.

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
    /// Video: the writer session starts here, so the track's edit list maps
    /// track time 0 to this media time (a non-zero edit start).
    let editStart: Double?
    /// PNG: a solid sRGB colour (instead of the oriented logo pattern).
    let solid: [Double]?
    /// Tone amplitude (default 0.25); 0 writes digital silence.
    let amplitude: Double?
    /// Video: a clap at this second. The frame shown then is all white, and the
    /// sound gets a click (a 4 ms Hann-windowed 1 kHz burst at 0.9) starting exactly then.
    let clapAt: Double?
    /// Video: the clockwise display rotation (90 or 270) of a phone clip. `w`/`h` are the
    /// UPRIGHT size; the frames are stored turned the other way, with the track's
    /// preferredTransform rotating them back (as an iPhone writes a portrait clip).
    let rotation: Int?
    /// Audio: 3 ms Hann-windowed 1 kHz bursts at `burstAmplitude`, every `burstEvery`
    /// seconds from 0.25 s, over the tone (a hot, peaky mix).
    let burstEvery: Double?
    let burstAmplitude: Double?
    /// Audio: a named generated signal instead of tones. "dense": a music-like stereo mix
    /// (kick, snare, hats, a bass line and a bright saw chord over pink noise) with peaks
    /// near full scale and a high crest factor, for the limiter's true-peak check.
    let signal: String?
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

func toneSamples(hz: Double, from start: Int, count: Int, rate: Double, amplitude: Double = 0.25,
                 clicks: [(at: Double, length: Double, amplitude: Double)] = []) -> [Float] {
  var samples = [Float](repeating: 0, count: count * 2)
  for index in 0..<count {
    let t = Double(start + index) / rate
    var value = Float(amplitude * sin(2 * .pi * hz * t))
    for click in clicks where t >= click.at && t < click.at + click.length {
      let phase = (t - click.at) / click.length
      value += Float(click.amplitude * 0.5 * (1 - cos(2 * .pi * phase)) * sin(2 * .pi * 1000 * (t - click.at)))
    }
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
  let uprightWidth = media.w ?? 360, uprightHeight = media.h ?? 640, fps = media.fps ?? 30
  let turned = media.rotation == 90 || media.rotation == 270
  let width = turned ? uprightHeight : uprightWidth, height = turned ? uprightWidth : uprightHeight
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
    if media.rotation == 90 {
      input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: CGFloat(height), ty: 0)
    } else if media.rotation == 270 {
      input.transform = CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: CGFloat(width))
    }
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ])
    guard writer.canAdd(input) else { throw HarnessError("cannot add \(codec) input") }
    writer.add(input)
    var audioInput: AVAssetWriterInput?
    if (media.toneHz ?? 0) > 0 || media.clapAt != nil {
      let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000,
      ])
      audio.expectsMediaDataInRealTime = false
      writer.add(audio)
      audioInput = audio
    }
    guard writer.startWriting() else { throw HarnessError("startWriting \(codec): \(writer.error?.localizedDescription ?? "?")") }
    writer.startSession(atSourceTime: CMTime(seconds: media.editStart ?? 0, preferredTimescale: 600_000))
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
        let clapFrame = media.clapAt.map { Int(($0 * Double(fps)).rounded()) }
        var picture = clapFrame == frame
          ? CIImage(color: CIColor(red: 1, green: 1, blue: 1, alpha: 1, colorSpace: workingSpace)!).cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
          : Pattern.frame(frame, width: uprightWidth, height: uprightHeight, base: media.base ?? [0.1, 0.1, 0.1])
        if turned {
          // Stored turned back by the inverse of the display rotation.
          let stored = picture.oriented(media.rotation == 90 ? .left : .right)
          picture = stored.transformed(by: CGAffineTransform(translationX: -stored.extent.minX, y: -stored.extent.minY))
        }
        ciContext.render(picture, to: buffer,
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
    if let audioInput {
      let hz = media.toneHz ?? 0
      let clicks = media.clapAt.map { [(at: $0, length: 0.004, amplitude: 0.9)] } ?? []
      group.enter()
      let total = Int((media.seconds ?? 8) * 48_000)
      var cursor = 0
      audioInput.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
        while audioInput.isReadyForMoreMediaData {
          if cursor >= total { audioInput.markAsFinished(); group.leave(); return }
          let count = min(1024, total - cursor)
          do {
            audioInput.append(try audioSampleBuffer(toneSamples(hz: hz, from: cursor, count: count, rate: 48_000, amplitude: media.amplitude ?? 0.25,
                                                                clicks: clicks), start: cursor, rate: 48_000))
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
  var bursts: [(at: Double, length: Double, amplitude: Double)] = []
  if let every = media.burstEvery, every > 0 {
    var at = 0.25
    while at < media.seconds ?? 8 { bursts.append((at: at, length: 0.003, amplitude: media.burstAmplitude ?? 0.9)); at += every }
  }
  let dense = media.signal == "dense" ? denseMix(seconds: media.seconds ?? 8, rate: 48_000) : nil
  // Stereo with a set amplitude or bursts: one tone in both channels.
  let shaped = tones.count == 2 && media.channelTones == nil && (media.amplitude != nil || !bursts.isEmpty)
  var cursor = 0
  while cursor < total {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.001) }
    let count = min(1024, total - cursor)
    let samples: [Float]
    if let dense {
      samples = Array(dense[(cursor * 2)..<((cursor + count) * 2)])
    } else if shaped {
      samples = toneSamples(hz: tones[0], from: cursor, count: count, rate: 48_000, amplitude: media.amplitude ?? 0.25, clicks: bursts)
    } else {
      samples = channelToneSamples(tones, from: cursor, count: count, rate: 48_000)
    }
    input.append(try audioSampleBuffer(samples, start: cursor, rate: 48_000, channels: tones.count))
    cursor += count
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  guard writer.status == .completed else { throw HarnessError("audio writer: \(writer.error?.localizedDescription ?? "?")") }
}

/// Deterministic music-like stereo (see Manifest.Media.signal), peaks scaled to 0.98.
func denseMix(seconds: Double, rate: Double) -> [Float] {
  let count = Int(seconds * rate)
  var out = [Double](repeating: 0, count: count * 2)
  var state: UInt64 = 0x2545_F491_4F6C_DD1D
  func noise() -> Double {
    state ^= state << 13; state ^= state >> 7; state ^= state << 17
    return Double(state % 2_000_001) / 1_000_000 - 1
  }
  var pink = [Double](repeating: 0, count: 3)
  let beat = 0.5
  let chord = [220.0, 277.18, 329.63, 440.0]
  for i in 0..<count {
    let t = Double(i) / rate
    let inBeat = t.truncatingRemainder(dividingBy: beat)
    let inBar = t.truncatingRemainder(dividingBy: beat * 2)
    let white = noise()
    pink[0] = 0.997 * pink[0] + 0.029591 * white
    pink[1] = 0.985 * pink[1] + 0.032534 * white
    pink[2] = 0.950 * pink[2] + 0.048056 * white
    let bed = (pink[0] + pink[1] + pink[2] + 0.1848 * white) * 0.25
    let kick = sin(2 * .pi * (50 + 120 * exp(-inBeat * 30)) * inBeat) * exp(-inBeat * 9)
    let snareTime = inBar - beat
    let snare = snareTime >= 0 ? white * exp(-snareTime * 18) : 0
    let hatTime = t.truncatingRemainder(dividingBy: beat / 2)
    let hat = (white - pink[2] * 4) * exp(-hatTime * 90) * 0.5
    let bass = sin(2 * .pi * (t.truncatingRemainder(dividingBy: 2) < 1 ? 55 : 73.42) * t) * 0.6
    var saw = 0.0
    for root in chord { for harmonic in 1...12 { saw += sin(2 * .pi * root * Double(harmonic) * t) / Double(harmonic) } }
    let left = kick + 0.8 * snare + hat * 0.7 + bass + 0.05 * saw + bed
    let right = kick + 0.7 * snare + hat + bass + 0.06 * saw + bed * 0.9
    out[i * 2] = left
    out[i * 2 + 1] = right
  }
  let peak = out.map(abs).max() ?? 1
  return out.map { Float($0 / peak * 0.98) }
}

func cgImage(_ image: CIImage, width: Int, height: Int) -> CGImage {
  ciContext.createCGImage(image, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8,
                          colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)!
}

/// The logo, upright: 100 x 160, top half red, bottom half blue, a white square
/// top-left. Stored rotated with EXIF orientation 6 (rotate 90 clockwise to view).
func writeLogo(_ media: Manifest.Media, to url: URL) throws {
  let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
  if let solid = media.solid {
    let w = media.w ?? 100, h = media.h ?? 100
    let image = CIImage(color: CIColor(red: solid[0], green: solid[1], blue: solid[2], alpha: 1, colorSpace: srgb)!)
      .cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw HarnessError("png destination") }
    CGImageDestinationAddImage(destination, cgImage(image, width: w, height: h), nil)
    guard CGImageDestinationFinalize(destination) else { throw HarnessError("png write") }
    return
  }
  let w = 100.0, h = 160.0
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

/// The adapters this harness run built with (D24): the set AdapterSelection chose (EDITIFY_ADAPTERS
/// is read only when the harness is compiled with -D EDITIFY_TEST_ADAPTERS) and the
/// VideoComposition adapter PlanBuilder and PlanPlayer default to. The tests assert on the names.
func adapterReport() -> [String: Any] {
  ["set": AdapterSelection.current.set.rawValue, "videoComposition": harnessComposition.name,
   "overrideCompiled": AdapterSelection.overrideCompiled]
}

/// The VideoComposition adapter every build in this harness uses: AdapterSelection's choice for
/// this process, as EngineAdapters makes it on a phone.
let harnessComposition = PlanVideoCompositions.make(AdapterSelection.current.videoComposition)
