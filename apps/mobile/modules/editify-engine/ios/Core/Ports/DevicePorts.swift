import Foundation

// The device ports: what the phone allows and what it is.

/// A system task an export runs inside while the app may go to the background.
public protocol BackgroundTask: AnyObject, Sendable {
  func setProgress(completed: Int64, total: Int64)
  func updateTitle(_ title: String, subtitle: String)
  /// Called when the system is about to stop the task.
  func setExpirationHandler(_ handler: @escaping @Sendable () -> Void)
  func setTaskCompleted(success: Bool)
}

/// Asks the system to keep an export running in the background. Every refusal (no
/// background GPU, register or submit refused) means the caller runs it in the foreground.
public protocol BackgroundExecution: PortAdapter {
  /// Whether this phone can keep exporting with the app in the background.
  var supportsBackgroundGPU: Bool { get }
  /// Registers `identifier`'s launch handler, once per identifier. False when refused.
  func register(_ identifier: String, launched: @escaping @Sendable (any BackgroundTask) -> Void) -> Bool
  /// Queues `identifier` (it needs the GPU). Throws when the system refuses it.
  func submit(_ identifier: String, title: String, subtitle: String) throws
  /// Withdraws a request that has not started.
  func cancel(_ identifier: String)
}

/// Saves finished videos to the user's library (add-only: the app never reads it to save).
public protocol PhotoLibrary: PortAdapter {
  /// Shows the add-only prompt if it was never answered. Call while the app is in front.
  func requestAddAccessIfUndetermined() async
  /// False when access was refused or the save failed.
  func saveVideo(_ url: URL) async -> Bool
}

/// What the phone is: thermal state, memory, OS, model.
public protocol DeviceProfile: PortAdapter {
  var thermalState: ProcessInfo.ThermalState { get }
  /// "nominal" | "fair" | "serious" | "critical".
  var thermalName: String { get }
  var physicalMemoryBytes: UInt64 { get }
  var osVersion: String { get }
  /// Hardware identifier, e.g. "iPhone14,2".
  var model: String { get }
}
