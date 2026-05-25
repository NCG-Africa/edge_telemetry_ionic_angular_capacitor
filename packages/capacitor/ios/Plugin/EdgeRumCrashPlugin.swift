import Foundation
import Capacitor

/// Capacitor plugin bridge. Thin shim — delegates to `CrashReporter` (PLCrashReporter wrapper)
/// and `HangDetector` for the actual work.
///
/// NOTE: this file ships in `packages/capacitor/ios/` and is built via CocoaPods when the
/// consumer app runs `pod install`. It has not been built in this repo's CI — see
/// `goofy-rolling-flask.md` "Manual validation steps" for the smoke tests you need to run.
@objc(EdgeRumCrashPlugin)
public class EdgeRumCrashPlugin: CAPPlugin {

    private static var installed = false
    private static let installLock = NSLock()

    /// Called once by Capacitor when the plugin is discovered and linked,
    /// before any JS runs. Set a breakpoint here (or grep the device console
    /// for the `[edge-rum]` debug log) to verify that SPM/CocoaPods linkage
    /// is wiring this plugin into the consumer app. The real work happens
    /// in `install(_:)` which fires when JS calls `plugin.install()`.
    public override func load() {
        super.load()
        #if DEBUG
        print("[edge-rum] EdgeRumCrashPlugin loaded (SPM/CocoaPods linkage OK; awaiting JS install)")
        #endif
    }

    @objc func install(_ call: CAPPluginCall) {
        EdgeRumCrashPlugin.installLock.lock()
        defer { EdgeRumCrashPlugin.installLock.unlock() }

        if EdgeRumCrashPlugin.installed {
            call.resolve(["installed": true])
            return
        }

        let enableHang = call.getBool("enableHangDetection") ?? true
        let hangTimeoutMs = call.getInt("hangTimeoutMs") ?? 5000

        do {
            try CrashReporter.shared.install()
        } catch {
            // PLCrashReporter failed to arm — still mark as installed=false so the JS
            // bridge surfaces a health-monitor error but doesn't loop on retry.
            call.resolve(["installed": false, "error": error.localizedDescription])
            return
        }

        if enableHang {
            HangDetector.shared.start(timeoutMs: hangTimeoutMs)
        }

        EdgeRumCrashPlugin.installed = true
        call.resolve(["installed": true])
    }

    @objc func fetchPending(_ call: CAPPluginCall) {
        let crashes = CrashReporter.shared.fetchPending()
        call.resolve(["crashes": crashes])
    }

    @objc func markHandled(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self) else {
            call.reject("`ids` must be an array of strings")
            return
        }
        CrashReporter.shared.markHandled(ids: ids)
        call.resolve()
    }

    @objc func setLastScreen(_ call: CAPPluginCall) {
        let screen = call.getString("screen") ?? ""
        CrashReporter.shared.setLastScreen(screen)
        call.resolve()
    }
}
