// A local stand-in for the API's media route (GET /assets/:id/proxy.mp4?k=<token>), for the
// native preview harness: serves files with byte ranges on the loopback interface and checks
// the `k` token on every request the way server/src/auth.ts does: a token it was given, and,
// for a JWT, not past its `exp` (401 otherwise). Bodies trickle out at `bytesPerSecond`
// (a few times the clip's bitrate), so a player is still reading the clip while it plays,
// as it is with a real proxy over a phone's network. (CoreMedia refuses a 206 shorter than
// the range it asked for, so the trickle, not short responses, keeps it reading.)
// `clockShift` runs the server's clock ahead of this machine's (a phone with a skewed clock),
// and `failing` cuts every transfer and answers 500 until it is cleared (a dropped
// connection, a server error).

import Foundation
import Network

final class MediaServer: @unchecked Sendable {
  let bytesPerSecond: Int
  private let queue = DispatchQueue(label: "harness.media-server")
  private let listener: NWListener
  private let lock = NSLock()
  private var files: [String: URL] = [:]
  private var tokens = Set<String>()
  private var open: [ObjectIdentifier: NWConnection] = [:]
  private var counts = (served: 0, refused: 0, failed: 0)
  private var failingNow = false
  /// Seconds the server's clock runs ahead of this machine's: it mints and checks `exp` by it.
  let clockShift: TimeInterval
  private var log: [String] = []
  private let started = CFAbsoluteTimeGetCurrent()

  init(bytesPerSecond: Int = 64 << 10, clockShift: TimeInterval = 0) throws {
    self.bytesPerSecond = bytesPerSecond
    self.clockShift = clockShift
    let parameters = NWParameters.tcp
    parameters.requiredInterfaceType = .loopback
    parameters.allowLocalEndpointReuse = true
    listener = try NWListener(using: parameters, on: .any)
  }

  /// Starts listening; returns the port.
  func start(timeout: Double = 10) throws -> UInt16 {
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
      if case .failed = state { ready.signal() }
    }
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.start(queue: queue)
    guard ready.wait(timeout: .now() + timeout) == .success, let port = listener.port?.rawValue else {
      throw HarnessError("the media server did not start")
    }
    return port
  }

  func stop() {
    listener.cancel()
    lock.withLock { open.values.forEach { $0.cancel() }; open = [:] }
  }

  func serve(_ path: String, file: URL) { lock.withLock { files[path] = file } }
  func accept(_ token: String) { lock.withLock { _ = tokens.insert(token) } }

  /// A JWT-shaped media token (unsigned: only its `exp` matters here) that expires in `seconds`, accepted.
  func token(expiresIn seconds: Double) -> String {
    let now = Date().timeIntervalSince1970 + clockShift
    let claims = try! JSONSerialization.data(withJSONObject: ["iat": now, "exp": now + seconds, "jti": UUID().uuidString])
    let payload = claims.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    let token = "eyJhbGciOiJub25lIn0.\(payload).sig"
    accept(token)
    return token
  }

  var served: Int { lock.withLock { counts.served } }
  var failed: Int { lock.withLock { counts.failed } }

  /// On: every transfer in flight is cut and every request answered 500. Off: back to normal.
  func setFailing(_ on: Bool) {
    let cut = lock.withLock { () -> [NWConnection] in
      failingNow = on
      guard on else { return [] }
      defer { open = [:] }
      return Array(open.values)
    }
    note(on ? "failing: cut \(cut.count) transfer(s)" : "serving again")
    cut.forEach { $0.cancel() }
  }
  /// One line per request: seconds since start, the range asked for, the answer.
  var requests: [String] { lock.withLock { log } }

  private func note(_ line: String) {
    lock.withLock { log.append(String(format: "%.2f ", CFAbsoluteTimeGetCurrent() - started) + line) }
  }
  var refused: Int { lock.withLock { counts.refused } }

  // MARK: HTTP

  private func accept(_ connection: NWConnection) {
    lock.withLock { open[ObjectIdentifier(connection)] = connection }
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .cancelled, .failed: self?.forget(connection)
      default: break
      }
    }
    connection.start(queue: queue)
    receive(connection, buffer: Data())
  }

  private func forget(_ connection: NWConnection) {
    lock.withLock { _ = open.removeValue(forKey: ObjectIdentifier(connection)) }
  }

  private func receive(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 << 10) { [weak self] data, _, complete, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        self.respond(connection, head: String(decoding: buffer[..<end.lowerBound], as: UTF8.self))
      } else if complete || error != nil {
        connection.cancel()
      } else {
        self.receive(connection, buffer: buffer)
      }
    }
  }

  private func respond(_ connection: NWConnection, head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ").map(String.init) ?? []
    guard parts.count >= 2, let url = URLComponents(string: "http://local\(parts[1])") else { return send(connection, status: "400 Bad Request") }
    let method = parts[0]
    let token = url.queryItems?.first { $0.name == "k" }?.value ?? ""
    if lock.withLock({ failingNow }) {
      note("\(method) 500")
      lock.withLock { counts.failed += 1 }
      return send(connection, status: "500 Internal Server Error")
    }
    let expired = PlanPlayer.tokenExpiry("http://local/?k=\(token)").map { $0.timeIntervalSince1970 <= Date().timeIntervalSince1970 + clockShift } ?? false
    let (file, allowed) = lock.withLock { (files[url.path], tokens.contains(token) && !expired) }
    let range = lines.dropFirst().first { $0.lowercased().hasPrefix("range:") } ?? "no range"
    guard allowed else {
      note("\(method) \(range) k=\(token.suffix(6)): 401")
      lock.withLock { counts.refused += 1 }
      return send(connection, status: "401 Unauthorized")
    }
    guard let file, let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return send(connection, status: "404 Not Found") }
    let total = data.count
    var start = 0, end = total - 1, partial = false
    for line in lines.dropFirst() where line.lowercased().hasPrefix("range:") {
      let spec = line.dropFirst("range:".count).trimmingCharacters(in: .whitespaces)
      guard spec.hasPrefix("bytes=") else { continue }
      let bounds = spec.dropFirst("bytes=".count).split(separator: "-", omittingEmptySubsequences: false)
      if bounds.count == 2 {
        if bounds[0].isEmpty, let suffix = Int(bounds[1]) {
          start = max(0, total - suffix)
        } else {
          start = Int(bounds[0]) ?? 0
          if let last = Int(bounds[1]) { end = min(last, total - 1) }
        }
        partial = true
      }
    }
    guard start < total, start <= end else { return send(connection, status: "416 Range Not Satisfiable", headers: ["Content-Range": "bytes */\(total)", "Content-Length": "0"]) }
    let body = data.subdata(in: start..<(end + 1))
    lock.withLock { counts.served += 1 }
    note("\(method) \(range) k=\(token.suffix(6)): \(body.count) bytes")
    var headers = ["Content-Type": "video/quicktime", "Accept-Ranges": "bytes", "Content-Length": "\(body.count)"]
    if partial || body.count < total { headers["Content-Range"] = "bytes \(start)-\(end)/\(total)" }
    let head = header(partial || body.count < total ? "206 Partial Content" : "200 OK", headers)
    connection.send(content: head, completion: .contentProcessed { _ in })
    if method == "HEAD" { return connection.send(content: nil, isComplete: true, completion: .contentProcessed { _ in connection.cancel() }) }
    trickle(connection, body, from: 0)
  }

  /// The body in 8 KB slices at `bytesPerSecond`, until it is sent or the connection is cut.
  private func trickle(_ connection: NWConnection, _ body: Data, from offset: Int) {
    guard connection.state == .ready else { return }
    guard offset < body.count else {
      return connection.send(content: nil, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
    }
    let slice = 8 << 10
    let next = min(body.count, offset + slice)
    connection.send(content: body.subdata(in: offset..<next), completion: .contentProcessed { [weak self] error in
      guard let self, error == nil else { return }
      let delay = Double(next - offset) / Double(self.bytesPerSecond)
      self.queue.asyncAfter(deadline: .now() + delay) { self.trickle(connection, body, from: next) }
    })
  }

  private func header(_ status: String, _ headers: [String: String]) -> Data {
    var head = "HTTP/1.1 \(status)\r\nConnection: close\r\n"
    for (name, value) in headers { head += "\(name): \(value)\r\n" }
    return Data((head + "\r\n").utf8)
  }

  private func send(_ connection: NWConnection, status: String, headers: [String: String] = ["Content-Length": "0"]) {
    connection.send(content: header(status, headers), isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
  }
}
