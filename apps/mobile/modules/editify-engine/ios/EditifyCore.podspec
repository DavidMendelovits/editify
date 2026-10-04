Pod::Spec.new do |s|
  s.name           = 'EditifyCore'
  s.version        = '0.1.0'
  s.summary        = 'Editify engine domain and ports (no AVFoundation, Speech, Vision, Photos or UIKit)'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Editify'
  s.homepage       = 'https://editify.app'
  # release/1.1 runs on iOS 18 and up (the iOS 26 APIs sit behind #available in Engine adapters).
  s.platforms      = { :ios => '18.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  # Disjoint from EditifyEngine's Engine/**. Core imports only the allowlist in
  # scripts/check-core-imports.mjs (CI checks it).
  s.source_files = 'Core/**/*.swift'
  # OV7: the caption faces, byte-identical to server/fonts (server/test/render-golden.test.ts checks).
  # Owned here, next to CaptionRenderer; the bundle keeps its name so PlanFonts finds it as before.
  s.resource_bundles = { 'EditifyEngineFonts' => ['Core/Fonts/*.ttf'] }
end
