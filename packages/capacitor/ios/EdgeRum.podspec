require 'json'

# Spec V2 (= Cordova V3): version from package.json, never hand-edited.
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'EdgeRum'
  s.version = package['version']
  s.summary = 'Edge RUM Capacitor native crash bridge (PLCrashReporter + hang detector)'
  s.license = 'MIT'
  s.homepage = 'https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor'
  s.author = { 'NathanClaire' => 'noreply@nathanclaire.com' }
  s.source = { :git => 'https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor.git', :tag => "v#{s.version}" }
  s.source_files = 'Plugin/**/*.{swift,h,m}'
  # iOS 14 aligns with capacitor-swift-pm 7+ requirements so the SPM and
  # CocoaPods install paths share the same minimum deployment target.
  s.ios.deployment_target = '14.0'
  s.swift_version = '5.5'

  s.dependency 'Capacitor'
  s.dependency 'PLCrashReporter', '~> 1.11'
end
