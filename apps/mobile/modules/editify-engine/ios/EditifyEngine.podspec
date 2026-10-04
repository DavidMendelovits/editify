Pod::Spec.new do |s|
  s.name           = 'EditifyEngine'
  s.version        = '0.1.0'
  s.summary        = 'Editify on-device media engine: adapters, Expo module, composition root'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Editify'
  s.homepage       = 'https://editify.app'
  # release/1.1 runs on iOS 18 and up (the iOS 26 APIs sit behind #available in Engine adapters).
  s.platforms      = { :ios => '18.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'EditifyCore'
  # Debug builds compile the EDITIFY_ADAPTERS=legacy override (AdapterSelection); Release never does.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS[config=Debug]' => '$(inherited) EDITIFY_TEST_ADAPTERS',
  }
  # Disjoint from EditifyCore's Core/**.
  s.source_files = 'Engine/**/*.swift'
end
