// swift-tools-version: 5.9
//
// SPM manifest for `@nathanclaire/rum-capacitor`.
//
// Capacitor 8 SPM-only iOS projects (no Podfile) need this file for
// `npx cap sync ios` to discover and link the native plugin. The legacy
// CocoaPods path remains supported via the parallel podspec at
// `ios/EdgeRumCapacitor.podspec`.
//
// Versioning note — `capacitor-swift-pm`'s major version is aligned with
// Capacitor's major version (7.x for Capacitor 7, 8.x for Capacitor 8).
// SwiftPM's `from:` is up-to-next-major, so this manifest targets
// Capacitor 8 consumers only. Capacitor 7 CocoaPods consumers continue
// to work via the podspec; Capacitor 7 SPM is out of scope.
//
// The target points at `ios/Plugin`, which contains Swift sources only.
// Plugin method registration is handled by `CAPBridgedPlugin` in
// `EdgeRumCrashPlugin.swift` — SwiftPM refuses to resolve targets that
// mix `.swift` and `.m` sources, which is why the legacy `CAP_PLUGIN`
// macro `.m` file was removed in 3.3.4.

import PackageDescription

let package = Package(
    name: "EdgeRumCapacitor",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "EdgeRumCapacitor",
            targets: ["EdgeRumCapacitorPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "EdgeRumCapacitorPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Plugin"
        )
    ]
)
