// swift-tools-version: 5.9
//
// SPM manifest for `@nathanclaire/rum-capacitor`.
//
// Capacitor 8 SPM-only iOS projects (no Podfile) need this file for
// `npx cap sync ios` to discover and link the native plugin. The legacy
// CocoaPods path remains supported via the parallel podspec at
// `ios/EdgeRumCapacitor.podspec`.
//
// Naming note — the Capacitor CLI auto-derives the consumer's
// `CapApp-SPM/Package.swift` entries from `Plugin.name`, which is
// `fixName(npmPackageName)` from `cli/src/plugin.ts`:
//   "@nathanclaire/rum-capacitor" → "NathanclaireRumCapacitor"
// The CLI does NOT read `capacitor.ios.name` for SPM (that field is
// only honoured by the legacy CocoaPods path / podspec name). So the
// package + product + target names below MUST match the auto-derived
// value or the consumer manifest fails with "product '...' not found
// in package '...'". The Swift class name (`@objc(EdgeRumCrashPlugin)`),
// the `jsName = "EdgeRumCrash"` declared in `CAPBridgedPlugin`, and the
// CocoaPods podspec name (`EdgeRumCapacitor`) are unrelated to this
// SPM-side naming and remain unchanged.
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
    name: "NathanclaireRumCapacitor",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "NathanclaireRumCapacitor",
            targets: ["NathanclaireRumCapacitorPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // PLCrashReporter — the iOS native crash reporter (NSException + Mach
        // signals). The CocoaPods path gets this via the podspec's
        // `s.dependency 'PLCrashReporter', '~> 1.11'`; the SPM path needs the
        // explicit declaration here. 1.11.2 is the lowest SPM-tagged release
        // of the 1.11 series.
        .package(url: "https://github.com/microsoft/plcrashreporter.git", from: "1.11.2")
    ],
    targets: [
        .target(
            name: "NathanclaireRumCapacitorPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CrashReporter", package: "plcrashreporter")
            ],
            path: "ios/Plugin"
        )
    ]
)
