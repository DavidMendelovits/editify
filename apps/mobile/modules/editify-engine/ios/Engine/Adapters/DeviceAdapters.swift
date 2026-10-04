import AVFoundation
import BackgroundTasks
import Photos

/// BackgroundExecution adapter: BGContinuedProcessingTask with the GPU resource (iOS 26).
/// Every refusal sends the export to the foreground (ExportCenter's admission).
struct ContinuedProcessingExecution: BackgroundExecution {
  var name: String { "continued-processing" }

  var supportsBackgroundGPU: Bool { BGTaskScheduler.supportedResources.contains(.gpu) }

  func register(_ identifier: String, launched: @escaping @Sendable (any BackgroundTask) -> Void) -> Bool {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
      guard let task = task as? BGContinuedProcessingTask else {
        task.setTaskCompleted(success: false)
        return
      }
      launched(ContinuedProcessingTask(task))
    }
  }

  func submit(_ identifier: String, title: String, subtitle: String) throws {
    let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
    request.strategy = .queue
    request.requiredResources = .gpu
    try BGTaskScheduler.shared.submit(request)
  }

  func cancel(_ identifier: String) {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
  }
}

/// A running BGContinuedProcessingTask behind the BackgroundTask port.
final class ContinuedProcessingTask: BackgroundTask, @unchecked Sendable {
  private let task: BGContinuedProcessingTask

  init(_ task: BGContinuedProcessingTask) { self.task = task }

  func setProgress(completed: Int64, total: Int64) {
    if task.progress.totalUnitCount != total { task.progress.totalUnitCount = total }
    task.progress.completedUnitCount = completed
  }

  func updateTitle(_ title: String, subtitle: String) { task.updateTitle(title, subtitle: subtitle) }
  func setExpirationHandler(_ handler: @escaping @Sendable () -> Void) { task.expirationHandler = handler }
  func setTaskCompleted(success: Bool) { task.setTaskCompleted(success: success) }
}

/// PhotoLibrary adapter: PhotoKit, add-only.
struct PhotoKitLibrary: PhotoLibrary {
  var name: String { "photokit" }

  func requestAddAccessIfUndetermined() async {
    if PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined {
      _ = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    }
  }

  func saveVideo(_ url: URL) async -> Bool {
    let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    guard status == .authorized || status == .limited else { return false }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil)
      }
      return true
    } catch {
      return false
    }
  }
}

/// DeviceProfile adapter: ProcessInfo and the lab Sampler's probes.
struct SystemDeviceProfile: DeviceProfile {
  var name: String { "system" }

  var thermalState: ProcessInfo.ThermalState { ProcessInfo.processInfo.thermalState }
  var thermalName: String { Sampler.thermalName() }
  var physicalMemoryBytes: UInt64 { ProcessInfo.processInfo.physicalMemory }
  var osVersion: String { ProcessInfo.processInfo.operatingSystemVersionString }
  var model: String { Sampler.deviceModel() }
}
