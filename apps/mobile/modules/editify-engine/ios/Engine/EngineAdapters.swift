import AVFoundation

/// The composition root (decision D5): the one place the engine picks an adapter for each
/// port in EditifyCore. Everything that reaches media, the system or the user's library goes
/// through the set held here: the module's analyzer calls, the scheduler, the export, the
/// preview player.
///
///   EditifyEngineModule ─┐                    ┌─ mediaSource         ─▶ PhotoKitMediaSource (PhotoKit | Files)
///   AnalysisScheduler   ─┤                    ├─ audioDecoder        ─▶ AssetReaderAudioDecoder (AVAssetReader)
///   ExportCenter        ─┼─ EngineAdapters ───┼─ transcriber         ─▶ SpeechAnalyzerTranscriber (iOS 26)
///   EditifyPlayerView   ─┘   .current         ├─ soundClassifier     ─▶ SoundAnalysisClassifier
///                                             ├─ faceDetector        ─▶ VisionFaceDetector
///                                             ├─ proxy               ─▶ WriterProxy (ProxyPipeline)
///                                             ├─ videoComposition    ─▶ ConfigurationVideoComposition (iOS 26)
///                                             │     └─ handed to videoExport and playback, which build plans with it
///                                             ├─ videoExport         ─▶ WriterVideoExport (PlanExporter)
///                                             ├─ playback            ─▶ PlanPlayerPlayback (PlanPlayer)
///                                             ├─ backgroundExecution ─▶ ContinuedProcessingExecution (iOS 26)
///                                             ├─ photoLibrary        ─▶ PhotoKitLibrary
///                                             └─ deviceProfile       ─▶ SystemDeviceProfile
///
/// Today every port has exactly one adapter, the code the engine always ran. The iOS 18
/// adapters, the choice by OS version and the test override come later (T6); they change
/// `make()` and nothing that calls through these ports.
struct EngineAdapters: Sendable {
  let mediaSource: any MediaSource<AVAsset>
  let audioDecoder: any AudioDecoder<AVAsset>
  let transcriber: any Transcriber<AVAsset>
  let soundClassifier: any SoundClassifier<AVAsset>
  let faceDetector: any FaceDetector<AVAsset>
  let proxy: any Proxy<AVAsset>
  let videoComposition: PlanVideoComposition
  let videoExport: any VideoExport<PlanAssetResolver>
  let playback: any Playback<PlanPlayer, PlanAssetResolver>
  let backgroundExecution: any BackgroundExecution
  let photoLibrary: any PhotoLibrary
  let deviceProfile: any DeviceProfile

  /// The set the app runs with, built once.
  static let current = make()

  static func make() -> EngineAdapters {
    let composition = ConfigurationVideoComposition()
    return EngineAdapters(
      mediaSource: PhotoKitMediaSource(),
      audioDecoder: AssetReaderAudioDecoder(),
      transcriber: SpeechAnalyzerTranscriber(),
      soundClassifier: SoundAnalysisClassifier(),
      faceDetector: VisionFaceDetector(),
      proxy: WriterProxy(),
      videoComposition: composition,
      videoExport: WriterVideoExport(composition: composition),
      playback: PlanPlayerPlayback(composition: composition),
      backgroundExecution: ContinuedProcessingExecution(),
      photoLibrary: PhotoKitLibrary(),
      deviceProfile: SystemDeviceProfile())
  }

  /// Which adapter fills each port, by port name.
  var names: [String: String] {
    [
      "mediaSource": mediaSource.name, "audioDecoder": audioDecoder.name, "transcriber": transcriber.name,
      "soundClassifier": soundClassifier.name, "faceDetector": faceDetector.name, "proxy": proxy.name,
      "videoComposition": videoComposition.name, "videoExport": videoExport.name, "playback": playback.name,
      "backgroundExecution": backgroundExecution.name, "photoLibrary": photoLibrary.name, "deviceProfile": deviceProfile.name,
    ]
  }
}
