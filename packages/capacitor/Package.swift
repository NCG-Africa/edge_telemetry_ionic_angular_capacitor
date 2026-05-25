// swift-tools-version: 5.9
//
// SPM manifest for `@nathanclaire/rum-capacitor`.
//
// Capacitor 7+ consumers using SPM-only iOS projects (no Podfile) need a
// Package.swift at the plugin root for `npx cap sync ios` to discover and
// link the native plugin. The legacy CocoaPods path remains supported via
// the parallel podspec at `ios/EdgeRumCapacitor.podspec`.
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
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "EdgeRumCapacitor",
            targets: ["EdgeRumCapacitorPlugin"]
        )
    ],
    dependencies: [
        // Range `from: "7.0.0"` covers both Capacitor 7 and 8 consumers.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
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
