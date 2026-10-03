// Checks for the device preview proxy (ProxyPipeline.swift, ProxyStore) and the media
// fingerprint (MediaFingerprint.swift) on macOS (plan P1: 10B + OV9, 3A + OV2). Not part
// of the app. Built and run by server/test/media-pipeline.test.ts, which makes the clips
// with ffmpeg first:
//   swiftc ../../ios/{AnalysisMath,AudioDecode,AudioSync,MediaFingerprint,MediaStore,ProxyPipeline}.swift main.swift
//   usage: media-pipeline <clip dir> <scratch dir>
//     hdr.mov        3840x2160 HEVC Main10, HLG / BT.2020 tags, 50 fps, PCM audio
//     sdr-big.mp4    2560x1440 H.264 BT.709, 25 fps, AAC audio
//     sdr-small.mov  640x360 H.264, 30 fps, AAC audio
//     audio.m4a      12 s of AAC with a moving envelope; audio-remux.mov the same stream
//                    re-wrapped; audio-trim.m4a the same audio from 1.5 s, re-encoded
// Prints "ok" and exits 0, or lists every failed check and exits 1.
import AVFoundation
import CoreMedia
import Foundation

var failures: [String] = []

func check(_ name: String, _ condition: Bool) {
  if !condition { failures.append(name) }
}

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: media-pipeline <clip dir> <scratch dir>\n".data(using: .utf8)!)
  exit(2)
}
let clips = URL(fileURLWithPath: args[1])
let scratch = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)

struct Written {
  let width: Int
  let height: Int
  let fps: Float
  let subtype: FourCharCode
  let primaries: String?
  let transfer: String?
  let matrix: String?
  let bits: Int?
  let audio: AudioFormatID?
  let duration: Double
}

func inspect(_ url: URL) async throws -> Written {
  let asset = AVURLAsset(url: url)
  let track = try await asset.loadTracks(withMediaType: .video).first!
  let (size, fps, formats) = try await track.load(.naturalSize, .nominalFrameRate, .formatDescriptions)
  let format = formats.first!
  let tags = ColorTags(format)
  let bits = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_BitsPerComponent) as? Int
  var audio: AudioFormatID?
  if let audioTrack = try await asset.loadTracks(withMediaType: .audio).first,
     let audioFormat = try await audioTrack.load(.formatDescriptions).first {
    audio = CMAudioFormatDescriptionGetStreamBasicDescription(audioFormat)?.pointee.mFormatID
  }
  return Written(
    width: Int(size.width), height: Int(size.height), fps: fps, subtype: CMFormatDescriptionGetMediaSubType(format),
    primaries: tags.primaries, transfer: tags.transfer, matrix: tags.matrix, bits: bits, audio: audio,
    duration: try await asset.load(.duration).seconds
  )
}

func fourCC(_ code: FourCharCode) -> String {
  String(bytes: [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }, encoding: .ascii) ?? "\(code)"
}

// MARK: - Proxy: HDR source

do {
  let output = scratch.appendingPathComponent("hdr-proxy.mov")
  let data = try await ProxyPipeline.make(AVURLAsset(url: clips.appendingPathComponent("hdr.mov")), to: output)
  let written = try await inspect(output)
  check("hdr: short side scaled to 1080 (\(written.width)x\(written.height))", written.width == 1920 && written.height == 1080)
  check("hdr: 50 fps kept (\(written.fps))", abs(written.fps - 50) < 0.5)
  check("hdr: HEVC (\(fourCC(written.subtype)))", written.subtype == kCMVideoCodecType_HEVC)
  check("hdr: 10-bit (\(written.bits.map(String.init) ?? "untagged"))", written.bits == nil || written.bits == 10)
  check("hdr: HLG transfer (\(written.transfer ?? "none"))", written.transfer == (kCVImageBufferTransferFunction_ITU_R_2100_HLG as String))
  check("hdr: BT.2020 primaries (\(written.primaries ?? "none"))", written.primaries == (kCVImageBufferColorPrimaries_ITU_R_2020 as String))
  check("hdr: BT.2020 matrix (\(written.matrix ?? "none"))", written.matrix == (kCVImageBufferYCbCrMatrix_ITU_R_2020 as String))
  check("hdr: PCM audio encoded to AAC", written.audio == kAudioFormatMPEG4AAC && data["audio"] as? String == "aac")
  check("hdr: duration kept (\(written.duration))", abs(written.duration - 2) < 0.1)
  check("hdr: reports its color", data["color"] as? String == "hlg" && data["codec"] as? String == "hevc-main10")
} catch {
  failures.append("hdr proxy threw: \(error)")
}

// MARK: - Proxy: SDR sources

do {
  let output = scratch.appendingPathComponent("sdr-big-proxy.mov")
  let data = try await ProxyPipeline.make(AVURLAsset(url: clips.appendingPathComponent("sdr-big.mp4")), to: output)
  let written = try await inspect(output)
  check("sdr: 2560x1440 scaled to 1920x1080 (\(written.width)x\(written.height))", written.width == 1920 && written.height == 1080)
  check("sdr: 25 fps kept (\(written.fps))", abs(written.fps - 25) < 0.5)
  check("sdr: H.264 (\(fourCC(written.subtype)))", written.subtype == kCMVideoCodecType_H264)
  check("sdr: BT.709 transfer (\(written.transfer ?? "none"))", written.transfer == (kCVImageBufferTransferFunction_ITU_R_709_2 as String))
  check("sdr: AAC passed through", written.audio == kAudioFormatMPEG4AAC && data["audio"] as? String == "passthrough")
} catch {
  failures.append("sdr proxy threw: \(error)")
}

do {
  let output = scratch.appendingPathComponent("sdr-small-proxy.mov")
  _ = try await ProxyPipeline.make(AVURLAsset(url: clips.appendingPathComponent("sdr-small.mov")), to: output)
  let written = try await inspect(output)
  check("small: never upscaled (\(written.width)x\(written.height))", written.width == 640 && written.height == 360)
  check("small: 30 fps kept (\(written.fps))", abs(written.fps - 30) < 0.5)
} catch {
  failures.append("small proxy threw: \(error)")
}

// MARK: - Proxy: cancel mid-write

final class TaskBox: @unchecked Sendable {
  private let lock = NSLock()
  private var task: Task<[String: Any], Error>?
  private var fired = false
  func set(_ task: Task<[String: Any], Error>) { lock.withLock { self.task = task } }
  func cancelOnce() {
    let target = lock.withLock { () -> Task<[String: Any], Error>? in
      defer { fired = true }
      return fired ? nil : task
    }
    target?.cancel()
  }
}

do {
  let output = scratch.appendingPathComponent("cancel-proxy.mov")
  let box = TaskBox()
  let asset = AVURLAsset(url: clips.appendingPathComponent("hdr.mov"))
  let task = Task {
    try await ProxyPipeline.make(asset, to: output, progress: { fraction in
      if fraction >= 0.2 { box.cancelOnce() }
    })
  }
  box.set(task)
  do {
    _ = try await task.value
    failures.append("cancel: the proxy finished instead of cancelling")
  } catch is CancellationError {
    // expected
  } catch {
    failures.append("cancel: threw \(error), not CancellationError")
  }
  check("cancel: no partial file left", !FileManager.default.fileExists(atPath: output.path))
}

// MARK: - Proxy store: LRU eviction, commit, partial sweep

do {
  let folder = scratch.appendingPathComponent("lru", isDirectory: true)
  try? FileManager.default.removeItem(at: folder)
  let store = ProxyStore(directory: folder, budgetBytes: 250)
  let base = Date(timeIntervalSince1970: 1_700_000_000)
  for (index, id) in ["a", "b", "c"].enumerated() {
    let url = try store.finalURL(id)
    try Data(count: 100).write(to: url)
    try FileManager.default.setAttributes([.modificationDate: base.addingTimeInterval(Double(index) * 60)], ofItemAtPath: url.path)
  }
  // "a" was made first but opened last: now the most recently used.
  check("lru: touch finds a proxy", store.touch("a", at: base.addingTimeInterval(600)))
  check("lru: touch reports a missing proxy", !store.touch("zzz"))
  let first = store.evictOverBudget()
  check("lru: evicts the least recently opened first (\(first))", first == ["b"])
  store.budgetBytes = 50
  let second = store.evictOverBudget(protecting: "a")
  check("lru: never evicts the protected proxy (\(second))", second == ["c"] && store.existing("a") != nil)
  check("lru: evicted proxies are gone", store.existing("b") == nil && store.existing("c") == nil)

  try Data(count: 10).write(to: try store.partialURL("d"))
  _ = try store.commit("d")
  let partialD = try store.partialURL("d").path
  check("commit: partial renamed into place", store.existing("d")?.bytes == 10 && !FileManager.default.fileExists(atPath: partialD))
  let partialE = try store.partialURL("e")
  try Data(count: 10).write(to: partialE)
  store.sweepPartials()
  check("sweep: partial removed", !FileManager.default.fileExists(atPath: partialE.path))
  check("relative path", ProxyStore.relativePath("a1-B_2") == "proxies/a1-B_2.mov")
} catch {
  failures.append("proxy store threw: \(error)")
}

// MARK: - Fingerprint

func distance(_ a: String, _ b: String) -> Double {
  let x = Array(a.split(separator: ":").last ?? ""), y = Array(b.split(separator: ":").last ?? "")
  let length = max(x.count, y.count)
  guard length > 0 else { return 0 }
  var differing = 0
  for index in 0..<length {
    guard index < x.count, index < y.count, let p = Int(String(x[index]), radix: 16), let q = Int(String(y[index]), radix: 16) else {
      differing += 4
      continue
    }
    differing += (p ^ q).nonzeroBitCount
  }
  return Double(differing) / Double(length * 4)
}

do {
  let audio = clips.appendingPathComponent("audio.m4a")
  let once = try await MediaFingerprint.compute(AVURLAsset(url: audio))
  let twice = try await MediaFingerprint.compute(AVURLAsset(url: audio))
  let remux = try await MediaFingerprint.compute(AVURLAsset(url: clips.appendingPathComponent("audio-remux.mov")))
  let trim = try await MediaFingerprint.compute(AVURLAsset(url: clips.appendingPathComponent("audio-trim.m4a")))
  let hash = once["audio"] as? String ?? ""
  check("fingerprint: has an e1 audio hash (\(hash.prefix(12))…)", hash.hasPrefix("e1:") && hash.count == 3 + 60)  // 240 cells, 239 bits
  check("fingerprint: same file twice is identical", NSDictionary(dictionary: once).isEqual(to: twice))
  check("fingerprint: bytes and duration", (once["bytes"] as? Int ?? 0) > 0 && abs((once["duration"] as? Double ?? 0) - 12) < 0.1)
  check("fingerprint: a re-wrapped copy has the same audio hash", remux["audio"] as? String == hash)
  let trimmed = trim["audio"] as? String ?? ""
  let trimDistance = distance(hash, trimmed)
  check("fingerprint: a trimmed copy differs in duration", abs((trim["duration"] as? Double ?? 0) - (once["duration"] as? Double ?? 0)) > 1)
  check("fingerprint: a trimmed copy differs in its audio hash (\(trimDistance))", trimDistance > 0.1)
  check("fingerprint: audio has no color", once["color"] is NSNull)
  let hdr = try await MediaFingerprint.compute(AVURLAsset(url: clips.appendingPathComponent("hdr.mov")))
  let sdr = try await MediaFingerprint.compute(AVURLAsset(url: clips.appendingPathComponent("sdr-big.mp4")))
  check("fingerprint: color of an HLG clip", hdr["color"] as? String == "hlg")
  check("fingerprint: color of an SDR clip", sdr["color"] as? String == "sdr")
} catch {
  failures.append("fingerprint threw: \(error)")
}

// MARK: - Math

check("previewProxySize landscape 4K", AnalysisMath.previewProxySize(for: CGSize(width: 3840, height: 2160)) == CGSize(width: 1920, height: 1080))
check("previewProxySize portrait 4K", AnalysisMath.previewProxySize(for: CGSize(width: 2160, height: 3840)) == CGSize(width: 1080, height: 1920))
check("previewProxySize keeps small", AnalysisMath.previewProxySize(for: CGSize(width: 720, height: 1280)) == CGSize(width: 720, height: 1280))
check("previewProxySize evens odd sides", AnalysisMath.previewProxySize(for: CGSize(width: 4000, height: 3000)) == CGSize(width: 1440, height: 1080))
check("envelopeHash bits", AnalysisMath.envelopeHash([-20, -10, -10.2, -30, -29, -28]) == "e1:98")
check("envelopeHash deadband", AnalysisMath.envelopeHash([-20, -19.8, -19.6]) == "e1:0")

if failures.isEmpty {
  print("ok")
  exit(0)
}
print(failures.joined(separator: "\n"))
exit(1)
