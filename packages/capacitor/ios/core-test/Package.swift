// swift-tools-version:5.9

import PackageDescription

// Spec Q2: the plugin's Package.swift needs Capacitor (iOS only); the native core under
// `Plugin/Core` is plain Foundation, so it builds and tests here on the macOS host alone.
// `Sources/EdgeRumCore` is a symlink to `../../Plugin/Core` (SwiftPM rejects paths outside the package).
let package = Package(
    name: "EdgeRumCore",
    platforms: [.macOS(.v11)],
    targets: [
        .target(name: "EdgeRumCore"),
        .testTarget(name: "EdgeRumCoreTests", dependencies: ["EdgeRumCore"])
    ]
)
