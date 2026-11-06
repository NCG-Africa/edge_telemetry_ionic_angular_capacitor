// swift-tools-version: 5.9
// Demo app only. Names follow the Capacitor CLI's fixName("edge-rum-demo-scenarios").
import PackageDescription

let package = Package(
    name: "EdgeRumDemoScenarios",
    platforms: [.iOS(.v15)],
    products: [.library(name: "EdgeRumDemoScenarios", targets: ["DemoScenarios"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
    targets: [
        .target(
            name: "DemoScenarios",
            dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")],
            path: "ios/Sources/DemoScenarios"
        )
    ]
)
