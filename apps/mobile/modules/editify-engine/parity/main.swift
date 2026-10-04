// Parity runner for AudioSync.swift (decision 1A). Not part of the app: the
// podspec compiles ios/ only. server/test/sync-parity.test.ts builds this with
//   swiftc -O ../ios/Core/AudioSync.swift main.swift
// and compares its JSON with measureSync from packages/shared/src/sync.ts.
//
//   usage: sync-parity <video.f32> <memo.f32>   (mono float32 LE at 8 kHz)
import Foundation

func readPCM(_ path: String) throws -> [Float] {
  let data = try Data(contentsOf: URL(fileURLWithPath: path))
  return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
}

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: sync-parity <video.f32> <memo.f32>\n".data(using: .utf8)!)
  exit(2)
}
var output: [String: Any]
do {
  let m = try AudioSync.measure(video: try readPCM(args[1]), memo: try readPCM(args[2]))
  output = [
    "lag": m.lag, "anchor": m.anchor, "rate": m.rate, "coarseRatio": m.coarseRatio.isFinite ? m.coarseRatio : 1e308,
    "fineScore": m.fineScore, "confident": m.confident, "overlapSec": m.overlapSec,
    "windows": m.windows.map { ["at": $0.at, "lag": $0.lag, "score": $0.score] },
  ]
  if let drift = m.driftSec { output["driftSec"] = drift }
} catch is AudioSync.Silent {
  output = ["error": "silent"]
}
print(String(data: try JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
