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
// Capacitor 8 consumers only. Capacitor 7 SPM consumers were unreachable
// from the previous `from: "7.0.0"` declaration because their app's
// `capacitor-swift-pm` resolves to 8.x and conflicted with our 7.x pin —
// resulting in either a resolution error or the plugin being silently
// dropped during `cap sync ios`. Capacitor 7 CocoaPods consumers continue
// to work via the podspec.
//
// Layout matches the official capacitor-team plugin template
// (https://github.com/ionic-team/capacitor-plugins): a single target rooted
// at `ios/Plugin` picks up both the Swift sources and the Obj-C `CAP_PLUGIN`
// registration file. Swift / Obj-C interop within one SPM target works
// because the Swift class is marked `@objc(EdgeRumCrashPlugin)` and the
// CAP_PLUGIN macro resolves it at runtime via the ObjC class registry.

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
