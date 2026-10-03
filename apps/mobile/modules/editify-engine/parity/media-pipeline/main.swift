// Checks for the device preview proxy (ProxyPipeline.swift, ProxyStore) and the media
// fingerprint (MediaFingerprint.swift) on macOS (plan P1: 10B + OV9, 3A + OV2). Not part
// of the app. Built and run by server/test/media-pipeline.test.ts, which makes the clips
// with ffmpeg first:
//   swiftc -target <arch>-apple-macos15.0 ../../ios/{AnalysisMath,AudioDecode,AudioSync,MediaFingerprint,MediaStore,ProxyPipeline}.swift main.swift
//   usage: media-pipeline <clip dir> <scratch dir>
//     hdr.mov        3840x2160 HEVC Main10, HLG / BT.2020 tags, 50 fps, PCM audio
//     sdr-big.mp4    2560x1440 H.264 BT.709, 25 fps, AAC audio
//     sdr-small.mov  640x360 H.264, 30 fps, AAC audio
//     sdr-p3.mov     1280x720 H.264 tagged Display P3 (wide-gamut SDR)
//     rotated.mov    sdr-big.mp4 with a 90 degree display rotation (a portrait phone clip)
//     audio.m4a      12 s of AAC with a moving envelope; audio-remux.mov the same stream
//                    re-wrapped; audio-reenc.m4a re-encoded at 96k; audio-trim.m4a the
//                    same audio from 1.5 s, re-encoded
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

do {
  let output = scratch.appendingPathComponent("p3-proxy.mov")
  _ = try await ProxyPipeline.make(AVURLAsset(url: clips.appendingPathComponent("sdr-p3.mov")), to: output)
  let written = try await inspect(output)
  check("p3: wide-gamut SDR keeps its P3 primaries (\(written.primaries ?? "none"))", written.primaries == (kCVImageBufferColorPrimaries_P3_D65 as String))
} catch {
  failures.append("p3 proxy threw: \(error)")
}

do {
  let output = scratch.appendingPathComponent("rotated-proxy.mov")
  _ = try await ProxyPipeline.make(AVURLAsset(url: clips.appendingPathComponent("rotated.mov")), to: output)
  let track = try await AVURLAsset(url: output).loadTracks(withMediaType: .video).first!
  let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
  let upright = CGRect(origin: .zero, size: natural).applying(transform)
  check("rotated: stored frame scaled (\(natural))", natural == CGSize(width: 1920, height: 1080))
  check("rotated: upright portrait at the origin (\(upright))",
        abs(upright.minX) < 0.01 && abs(upright.minY) < 0.01 && abs(upright.width - 1080) < 0.01 && abs(upright.height - 1920) < 0.01)
} catch {
  failures.append("rotated proxy threw: \(error)")
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
  for (index, id) in ["asset/a", "asset/b", "asset/c"].enumerated() {
    try Data(count: 100).write(to: try store.partialURL(id))
    let url = try store.commit(id, key: "v1|\(id)")
    try FileManager.default.setAttributes([.modificationDate: base.addingTimeInterval(Double(index) * 60)], ofItemAtPath: url.path)
  }
  check("store: files are named by hash", try store.finalURL("asset/a").lastPathComponent.count == 64 + 4)
  check("store: keeps the proxy key", store.existing("asset/b")?.key == "v1|asset/b")
  check("store: rejects an empty id", (try? ProxyStore.hashedName("")) == nil)
  check("store: ignores a non-number budget", !store.setBudget(.nan) && !store.setBudget(.infinity) && store.budgetBytes == 250)
  check("store: clamps a tiny budget", store.setBudget(1) && store.budgetBytes == ProxyStore.budgetRange.lowerBound)
  store.budgetBytes = 250
  // "a" was made first but opened last: now the most recently used.
  check("lru: touch finds a proxy", store.touch("asset/a", at: base.addingTimeInterval(600)))
  check("lru: touch reports a missing proxy", !store.touch("zzz"))
  let first = store.evictOverBudget()
  check("lru: evicts the least recently opened first, by asset id (\(first))", first == ["asset/b"])
  store.budgetBytes = 50
  let second = store.evictOverBudget(protecting: "asset/a")
  check("lru: never evicts the protected proxy (\(second))", second == ["asset/c"] && store.existing("asset/a") != nil)
  check("lru: evicted proxies are gone", store.existing("asset/b") == nil && store.existing("asset/c") == nil)

  try Data(count: 10).write(to: try store.partialURL("d"))
  _ = try store.commit("d", key: "k")
  let partialD = try store.partialURL("d").path
  check("commit: partial renamed into place", store.existing("d")?.bytes == 10 && !FileManager.default.fileExists(atPath: partialD))
  let partialE = try store.partialURL("e")
  try Data(count: 10).write(to: partialE)
  store.sweepPartials()
  check("sweep: partial removed", !FileManager.default.fileExists(atPath: partialE.path))
  let relative = try ProxyStore.relativePath("a1-B_2")
  check("relative path (\(relative))", relative.hasPrefix("proxies/") && relative.hasSuffix(".mov") && relative.count == 8 + 64 + 4)
} catch {
  failures.append("proxy store threw: \(error)")
}

// MARK: - Durable copies

do {
  MediaStore.rootOverride = scratch.appendingPathComponent("root", isDirectory: true)
  let source = scratch.appendingPathComponent("old-clip.mov")
  try Data(count: 64).write(to: source)
  try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_000_000)], ofItemAtPath: source.path)
  let copy = try MediaStore.durableCopy(from: source, name: "old clip.mov")
  let copied = MediaStore.url(forRelative: copy.path)
  let modified = (try copied.resourceValues(forKeys: [.contentModificationDateKey])).contentModificationDate ?? .distantPast
  check("copy: lands in media/ under a safe name (\(copy.path))", copy.path.hasPrefix("media/") && copy.path.hasSuffix("-old_clip.mov") && copy.bytes == 64)
  check("copy: dated now, not like its source (orphan sweep)", abs(modified.timeIntervalSinceNow) < 60)
  check("copy: excluded from backup", (try MediaStore.directory(MediaStore.mediaFolder).resourceValues(forKeys: [.isExcludedFromBackupKey])).isExcludedFromBackup == true)
  check("copy: listed for the sweep", MediaStore.mediaFiles().contains { $0["path"] as? String == copy.path })
  MediaStore.rootOverride = nil
} catch {
  failures.append("durable copy threw: \(error)")
}

// MARK: - Fingerprint

/// Same rule as local-media.ts `envelopeDistance`: over the common prefix only.
func distance(_ a: String, _ b: String) -> Double {
  let x = Array(a.split(separator: ":").last ?? ""), y = Array(b.split(separator: ":").last ?? "")
  let length = min(x.count, y.count)
  guard length > 0 else { return 0 }
  var differing = 0
  for index in 0..<length {
    differing += ((Int(String(x[index]), radix: 16) ?? 0) ^ (Int(String(y[index]), radix: 16) ?? 0)).nonzeroBitCount
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
  let reencoded = try await MediaFingerprint.compute(AVURLAsset(url: clips.appendingPathComponent("audio-reenc.m4a")))
  let reencDistance = distance(hash, reencoded["audio"] as? String ?? "")
  check("fingerprint: the same audio re-encoded at 96k still matches (\(reencDistance))",
        reencDistance <= 0.1 && abs((reencoded["duration"] as? Double ?? 0) - (once["duration"] as? Double ?? 0)) <= 0.1)
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
// A portrait source whose scaled sides were rounded independently (3000x1690 → 1918x1080).
let quarterTurn = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 1690, ty: 0)
let placed = CGRect(x: 0, y: 0, width: 1918, height: 1080).applying(AnalysisMath.uprightTransform(quarterTurn, size: CGSize(width: 1918, height: 1080)))
check("uprightTransform lands at the origin (\(placed))", abs(placed.minX) < 1e-6 && abs(placed.minY) < 1e-6 && abs(placed.width - 1080) < 1e-6 && abs(placed.height - 1918) < 1e-6)
let upsideDown = CGRect(x: 0, y: 0, width: 1920, height: 1080).applying(AnalysisMath.uprightTransform(CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 3840, ty: 2160), size: CGSize(width: 1920, height: 1080)))
check("uprightTransform upside down (\(upsideDown))", abs(upsideDown.minX) < 1e-6 && abs(upsideDown.minY) < 1e-6 && abs(upsideDown.width - 1920) < 1e-6)

if failures.isEmpty {
  print("ok")
  exit(0)
}
print(failures.joined(separator: "\n"))
exit(1)
