Pod::Spec.new do |s|
  s.name           = 'EditifyEngine'
  s.version        = '0.1.0'
  s.summary        = 'Editify on-device media engine (capability lab)'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Editify'
  s.homepage       = 'https://editify.app'
  # Decision 2A: iOS 26 floor (SpeechAnalyzer, BGContinuedProcessingTask), no @available forks.
  s.platforms      = { :ios => '26.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '**/*.{h,m,swift}'
  # OV7: the caption faces, byte-identical to server/fonts (server/test/render-golden.test.ts checks).
  s.resource_bundles = { 'EditifyEngineFonts' => ['Fonts/*.ttf'] }
end
