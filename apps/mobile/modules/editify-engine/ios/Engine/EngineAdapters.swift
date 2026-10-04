import AVFoundation

/// The composition root (decision D5): the one place the engine picks an adapter for each
/// port in EditifyCore. Everything that reaches media, the system or the user's library goes
/// through the set held here: the module's analyzer calls, the scheduler, the export, the
/// preview player.
///
///   EditifyEngineModule ─┐                    ┌─ mediaSource         ─▶ PhotoKitMediaSource (PhotoKit | Files, MediaFingerprint)
///   AnalysisScheduler   ─┤                    ├─ audioDecoder        ─▶ AssetReaderAudioDecoder (AVAssetReader)
///   ExportCenter        ─┼─ EngineAdapters ───┼─ transcriber         ─▶ modern: SpeechAnalyzerTranscriber (iOS 26)
///   EditifyPlayerView   ─┘   .current         │                         legacy: UnavailableTranscriber
///                                             ├─ soundClassifier     ─▶ SoundAnalysisClassifier
///                                             ├─ faceDetector        ─▶ VisionFaceDetector
///                                             ├─ proxy               ─▶ WriterProxy (ProxyPipeline, Gemini style proxy)
///                                             ├─ videoComposition    ─▶ modern: ConfigurationVideoComposition (iOS 26)
///                                             │     │                   legacy: MutableVideoComposition (iOS 18)
///                                             │     └─ handed to videoExport and playback, which build plans with it
///                                             ├─ videoExport         ─▶ WriterVideoExport (PlanExporter)
///                                             ├─ playback            ─▶ PlanPlayerPlayback (PlanPlayer)
///                                             ├─ backgroundExecution ─▶ modern + entitlement: ContinuedProcessingExecution
///                                             │                         otherwise: ForegroundExecution
///                                             ├─ photoLibrary        ─▶ PhotoKitLibrary
///                                             └─ deviceProfile       ─▶ SystemDeviceProfile
///
/// Which set: AdapterSelection.choose (the diagram of the decision is there). `make` builds
/// each instance behind `#available`, so the iOS 26 APIs are reached only from adapters the
/// runtime can run, and `names` / `capabilities()` report the instances actually built.
///
/// Through the ports: loading media, the Photos read access, probes, fingerprints, originals
/// and geometry (MediaSource); decoding (AudioDecoder); words, laughter, faces (Transcriber,
/// SoundClassifier, FaceDetector); the 1080p and the Gemini style proxies (Proxy); building,
/// exporting and playing plans (VideoComposition, VideoExport, Playback); background exports
/// (BackgroundExecution); saving to Photos (PhotoLibrary); thermal state and its changes,
/// memory, OS and model (DeviceProfile). PlanBuilder and PlanPlayer take the VideoComposition
/// adapter as a required argument, so nothing builds a plan with one this root didn't pick.
///
/// What stays outside on purpose:
///   - The app lifecycle on the driving side: ExportCenter's and EditifyPlayerView's UIKit
///     observers (foreground, background, memory warnings), the idle timer and the
///     background grace task. They are the module's own UI behaviour, not a driven resource.
///   - App-container files JS already resolved (ExportCenter.loadAsset reopens a file:// ref
///     with precise timing; the preview opens the user's server URLs) and the silent carrier
///     PlanBuilder writes itself.
///   - The error types AssetSource defines (NotFound, InCloud, Unreachable): values callers
///     throw and match, not calls.
///   - PlanExporter's default thermal probe (`thermalCritical`): a seam the export harness
///     overrides; ExportCenter runs PlanExporter through VideoExport.
///   - The capability lab (Lab/): spikes that measure AssetSource, Sampler and the analyzers
///     themselves load media through AssetSource directly.
struct EngineAdapters: Sendable {
  let selection: AdapterSelection
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

  /// The set the app runs with, built once at module load.
  static let current = make(os: ProcessInfo.processInfo.operatingSystemVersion, override: AdapterSelection.launchOverride)

  /// `override`: AdapterSelection.launchOverride (always nil without -D EDITIFY_TEST_ADAPTERS).
  static func make(os: OperatingSystemVersion, override: AdapterSet?,
                   backgroundGPUEntitled: Bool = AdapterSelection.backgroundGPUEntitled) -> EngineAdapters {
    let selection = AdapterSelection.choose(os: os, override: override, backgroundGPUEntitled: backgroundGPUEntitled)
    let composition = PlanVideoCompositions.make(selection.videoComposition)
    return EngineAdapters(
      selection: selection,
      mediaSource: PhotoKitMediaSource(),
      audioDecoder: AssetReaderAudioDecoder(),
      transcriber: makeTranscriber(selection.transcribers),
      soundClassifier: SoundAnalysisClassifier(),
      faceDetector: VisionFaceDetector(),
      proxy: WriterProxy(),
      videoComposition: composition,
      videoExport: WriterVideoExport(composition: composition),
      playback: PlanPlayerPlayback(composition: composition),
      backgroundExecution: makeBackgroundExecution(selection.backgroundExecution),
      photoLibrary: PhotoKitLibrary(),
      deviceProfile: SystemDeviceProfile())
  }

  private static func makeTranscriber(_ chain: [AdapterSelection.Transcriber]) -> any Transcriber<AVAsset> {
    if chain.first == .speechAnalyzer, #available(iOS 26.0, *) { return SpeechAnalyzerTranscriber() }
    return UnavailableTranscriber()
  }

  private static func makeBackgroundExecution(_ kind: AdapterSelection.Background) -> any BackgroundExecution {
    if kind == .continuedProcessing, #available(iOS 26.0, *) { return ContinuedProcessingExecution() }
    return ForegroundExecution()
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

  /// What JS reads before it decides (D5): the adapters this process runs, by name.
  ///   {os, adapterSet, transcriber, backgroundExport, backgroundGPU, composition, tier}
  /// `tier` is reserved for the RAM tier (T7) and null until then.
  func capabilities() -> [String: Any] {
    [
      "os": AdapterSelection.versionString(ProcessInfo.processInfo.operatingSystemVersion),
      "adapterSet": selection.set.rawValue,
      "transcriber": transcriber.name,
      "backgroundExport": backgroundExecution.name,
      "backgroundGPU": backgroundExecution.supportsBackgroundGPU,
      "composition": videoComposition.name,
      "tier": NSNull(),
    ]
  }
}
