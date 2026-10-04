import Foundation

/// BackgroundExecution adapter for iOS 18, and for iOS 26 builds without the background GPU
/// entitlement: no background task at all. ExportAdmission sends every export to the
/// foreground path (ExportCenter.runInForeground: the notice, the screen kept awake, stopped
/// with a reason if Editify goes to the background).
struct ForegroundExecution: BackgroundExecution {
  struct NotSupported: Error, LocalizedError {
    var errorDescription: String? { "Background exports are not available on this iPhone" }
  }

  var name: String { "foreground" }
  var supportsBackgroundGPU: Bool { false }
  func register(_ identifier: String, launched: @escaping @Sendable (any BackgroundTask) -> Void) -> Bool { false }
  func submit(_ identifier: String, title: String, subtitle: String) throws { throw NotSupported() }
  func cancel(_ identifier: String) {}
}
