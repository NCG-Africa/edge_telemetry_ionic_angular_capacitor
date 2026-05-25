Pod::Spec.new do |s|
  s.name = 'EdgeRumCapacitor'
  s.version = '3.3.0'
  s.summary = 'Edge RUM Capacitor native crash bridge (PLCrashReporter + hang detector)'
  s.license = 'MIT'
  s.homepage = 'https://github.com/mktowett/edge_telemetry_ionic_angular_capacitor'
  s.author = { 'NathanClaire' => 'noreply@nathanclaire.com' }
  s.source = { :git => 'https://github.com/mktowett/edge_telemetry_ionic_angular_capacitor.git', :tag => s.version.to_s }
  s.source_files = 'Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '13.0'
  s.swift_version = '5.5'

  s.dependency 'Capacitor'
  s.dependency 'PLCrashReporter', '~> 1.11'
end
