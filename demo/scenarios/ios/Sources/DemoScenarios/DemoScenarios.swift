import Capacitor
import Foundation
import WebKit

/// Demo app only: native scenarios + deep links: a launch argument (`xcrun simctl launch booted <app id>
/// -scenario <name>`, no "Open in…?" prompt) or the URL scheme (`edgerumdemo://<name>`).
@objc(DemoScenarios)
public class DemoScenarios: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DemoScenarios"
    public let jsName = "DemoScenarios"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "slow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hang", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "crash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "killRenderer", returnType: CAPPluginReturnPromise),
    ]
    // Touched on the main queue only.
    private var listening = false
    private var pending: String?

    override public func load() {
        pending = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["scenario"] as? String
        for name in [Notification.Name.capacitorOpenURL, .capacitorSceneOpenURL] {
            NotificationCenter.default.addObserver(self, selector: #selector(openURL(_:)), name: name, object: nil)
        }
    }

    @objc func openURL(_ n: Notification) {
        let url = (n.object as? [String: Any])?["url"] as? URL ?? n.object as? URL
        guard let url, url.scheme == "edgerumdemo", let host = url.host else { return }
        DispatchQueue.main.async { self.deliver(host) }
    }

    @objc func listen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.listening = true
            call.resolve(["scenario": self.pending ?? ""])
            self.pending = nil
        }
    }

    @objc func slow(_ call: CAPPluginCall) {
        let ms = call.getDouble("ms") ?? 0
        DispatchQueue.global().asyncAfter(deadline: .now() + ms / 1000) { call.resolve() }
    }

    @objc func hang(_ call: CAPPluginCall) {
        let ms = call.getDouble("ms") ?? 0
        call.resolve()
        DispatchQueue.main.async { Thread.sleep(forTimeInterval: ms / 1000) }
    }

    @objc func crash(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            NSException(name: .internalInconsistencyException, reason: "Demo native crash").raise()
        }
    }

    @objc func killRenderer(_ call: CAPPluginCall) {
        call.resolve() // answered first: the call must not outlive the content process
        DispatchQueue.main.async {
            // ponytail: private WebKit API, fine in a demo app; never ship this.
            let kill = NSSelectorFromString("_killWebContentProcess")
            if let web = self.bridge?.webView, web.responds(to: kill) { web.perform(kill) }
        }
    }

    /// Pushed by eval, not a listener: deep links are untrusted input, so names only.
    private func deliver(_ scenario: String) {
        guard scenario.range(of: "^[a-z-]+$", options: .regularExpression) != nil else { return }
        guard listening else { pending = scenario; return }
        bridge?.webView?.evaluateJavaScript("window.runScenario('\(scenario)')")
    }
}
