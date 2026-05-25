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
