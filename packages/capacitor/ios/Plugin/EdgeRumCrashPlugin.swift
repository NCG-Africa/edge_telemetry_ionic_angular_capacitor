import Foundation
import Capacitor
import Network
import UIKit
import WebKit

/// Capacitor plugin bridge. Hosts the 5.0 native core (`Core/`: identity, session, consent, user,
/// outbox, sender, crash) and arms native crash (`CrashReporter`, PLCrashReporter) and hang (`Watchdog`) capture itself (E12, E15).
/// WebView death, `app.start`, lifecycle, memory and network are native signals (A5, A6, E2, E3, E13, E22–E26).
///
/// Uses the `CAPBridgedPlugin` protocol (Capacitor 6+) for Swift-only method
/// registration. The legacy `.m` file with the `CAP_PLUGIN` macro that lived
/// alongside this file in 3.3.0–3.3.3 was removed in 3.3.4 because SwiftPM
/// refuses to resolve targets that mix `.swift` and `.m` sources, which broke
/// SPM consumers at package-resolution time.
@objc(EdgeRumCrashPlugin)
public class EdgeRumCrashPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "EdgeRumCrashPlugin"
    public let jsName = "EdgeRum"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setLastScreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRoot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markPhase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "identify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearUser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise)
    ]

    // ── 5.0 native core (spec A2, W1–W3, T1) ──────────────────────────────
    private var health: Health!
    private var outbox: Outbox!
    private var sender: Sender!
    private var user: User!
    private var session: Session!
    private var consent: Consent!
    private var crash: Crash!
    private var watchdog: Watchdog!
    /// Main thread only: the watchdog runs in the foreground while armed (E15).
    private var foreground = true
    private var hangArmed = false
    private var ticker: DispatchSourceTimer?
    /// Serial: core init and every plugin method, so nothing runs before init or interleaves a hand-off.
    private let worker = DispatchQueue(label: "com.nathanclaire.rum.worker")
    /// Replaced by `reset()`.
    private var identity = ""
    private let processStartedAt = EdgeRumCrashPlugin.processStartMs()
    /// A5: set in `load()` before any worker task is queued, so the worker always sees it.
    private var launch: Launch!
    /// A6: worker queue only.
    private var pageWatch = PageWatch()
    /// E32: launch-time device context; `app.bundle_id` and `network.type` are added per event.
    private var device: [String: Any] = [:]
    /// E26: last path transport; nil until the first reading.
    private var networkType: String?
    private let networkLock = NSLock()
    private var pathMonitor: NWPathMonitor?
    /// E32: `getServerBasePath()` read on main (UIKit), cached for the worker. Guarded by `networkLock`.
    private var serverBasePath: String?
    /// W3: 4.x ids lived in localStorage; deleted, never carried over.
    private static let legacyCleanup =
        "['edge_rum_device_id','edge_rum_anon_uid','edge_rum_total_sessions','edge_rum_q','edge_rum_location']"
        + ".forEach(function(k){try{localStorage.removeItem(k)}catch(e){}})"
    /// A6: every document start and clean `pagehide` reach `PageWatch` (the JS-reload heuristic).
    private static let pageHandler = "edgeRumPage"
    private static let pageScript =
        "(function(h){if(!h)return;h.postMessage({t:'load',u:location.href});"
        + "addEventListener('pagehide',function(){h.postMessage({t:'hide'})})})"
        + "(window.webkit&&webkit.messageHandlers&&webkit.messageHandlers.\(pageHandler))"

    /// Called once by Capacitor when the plugin is discovered and linked,
    /// before any JS runs. Set a breakpoint here (or grep the device console
    /// for the `[edge-rum]` debug log) to verify that SPM/CocoaPods linkage
    /// is wiring this plugin into the consumer app. The real work happens
    /// here too: the core, last launch's crash replay and crash / hang arming (no JS `install`).
    public override func load() {
        super.load()
        foreground = UIApplication.shared.applicationState != .background
        let launchedForeground = foreground
        // A5: plugins load once the bridge has created the WebView; close enough to "WebView created".
        launch = Launch(processStart: processStartedAt, webViewCreated: Outbox.now())
        device = Self.deviceContext()
        refreshBasePath()
        // C1: `hang`/`hangTimeoutMs` (true/2000). Started only once armed, after the core exists.
        let hangMs = getConfig().getBoolean("hang", true) ? Int64(getConfig().getInt("hangTimeoutMs", 2000)) : 0
        watchdog = Watchdog(hangMs: hangMs) { [weak self] ms in
            guard let self else { return }
            // Built here, on the watchdog thread, while main is still blocked.
            let record = self.crash.hang(durationMs: ms, frames: CrashReporter.mainFrames())
            self.worker.async { self.solo(record) }
        }
        // Plugins load before the start page, so the script runs ahead of any app JS.
        let content = bridge?.webView?.configuration.userContentController
        content?.addUserScript(
            WKUserScript(source: Self.legacyCleanup, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content?.add(PageMessages(self), name: Self.pageHandler)
        content?.addUserScript(
            WKUserScript(source: Self.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Off the main thread: outbox caps and the Keychain touch disk.
        worker.async {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            let dir = support.appendingPathComponent("edge_rum")
            self.health = Health(dir: dir)
            self.outbox = Outbox(dir: dir, health: self.health)
            self.sender = Sender(outbox: self.outbox, health: self.health, sdkVersion: Sender.packageVersion)
            // C1: `plugins.EdgeRum` in capacitor.config; missing key/endpoint → capture to disk until `configure`.
            let config = self.getConfig()
            self.sender.configure(apiKey: config.getString("apiKey"), url: config.getString("endpoint"))
            let defaults = UserDefaults.standard
            let deviceId = DeviceId()
            self.identity = Self.identityLine(deviceId.resolve())
            self.user = User(defaults: defaults)
            // C1 `sampleRate`; a non-number is NaN, which Session treats as keep-all (S1).
            let rate = config.getConfigJSON()["sampleRate"].map { ($0 as? NSNumber)?.doubleValue ?? .nan } ?? 1
            self.session = Session(defaults: defaults, health: self.health, sampleRate: rate,
                                   userId: { [unowned self] in self.user.id })
            self.consent = Consent(defaults: defaults, configEnabled: config.getBoolean("enabled", true),
                                   session: self.session, user: self.user, outbox: self.outbox, deviceId: deviceId)
            self.crash = Crash(dir: dir)
            self.session.context = { [unowned self] in self.context() }
            // T4: last launch's crash, under the identity it crashed with. Purged either way.
            if let report = CrashReporter.takePending(), self.consent.enabled, let p = self.crash.replay(report) {
                self.writeSolo(p.identity, p.event)
            }
            // P7: opt-in mode starts nothing until enable().
            if self.consent.enabled {
                self.append(self.session.begin())
                if launchedForeground { self.record([Signals.lifecycle("foregrounded", at: Outbox.now())]) } // E2
                // Armed after the context exists, so a crash always has one to replay under.
                self.saveCrashContext()
                self.arm()
            } else {
                self.crash.clear()
            }
            self.sender.trigger()
            // C1 / E23: opt-in periodic memory, foreground only, on the 1 s tick.
            let memoryEvery = config.getBoolean("memorySampling", false)
                ? max(1, config.getInt("memorySamplingIntervalMs", 30_000) / 1000) : 0
            // T3: 30 s after the first event, within a second. T6: 30 s retry tick for parked segments.
            var ticks = 0
            let timer = DispatchSource.makeTimerSource(queue: self.worker)
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.outbox.sealIfDue()
                ticks += 1
                if ticks % 30 == 0 { self.sender.trigger() }
                if memoryEvery > 0 && ticks % memoryEvery == 0 {
                    DispatchQueue.main.async {
                        if self.foreground { self.worker.async { self.sampleMemory("periodic") } }
                    }
                }
            }
            timer.resume()
            self.ticker = timer
        }
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didEnterBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willEnterForeground),
                       name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(didReceiveMemoryWarning),
                       name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        watchNetwork()
        #if DEBUG
        print("[edge-rum] EdgeRumCrashPlugin loaded (SPM/CocoaPods linkage OK; awaiting JS install)")
        #endif
    }

    @objc func setLastScreen(_ call: CAPPluginCall) {
        let screen = call.getString("screen") ?? ""
        worker.async {
            if self.consent.enabled {
                self.crash.setScreen(screen)
                self.saveCrashContext()
            }
            call.resolve()
        }
    }

    /// A2 / X10: `{ trace.id, rum.action.id, trace.root_type }` on root mint/replace; empty when cleared.
    @objc func setRoot(_ call: CAPPluginCall) {
        let root = call.options as? [String: Any]
        worker.async {
            if self.consent.enabled {
                self.crash.setRoot(root)
                self.saveCrashContext()
            }
            call.resolve()
        }
    }

    /// A2 / A5: JS phase marks; `bridgeReady` opens the `markReady` window (ADR-044 §1).
    @objc func markPhase(_ call: CAPPluginCall) {
        let phase = call.getString("phase") ?? ""
        let ts = call.getDouble("ts").map { Int64($0) } ?? Outbox.now()
        worker.async {
            if let start = self.launch.mark(phase, ts) {
                self.record([start])
            } else if phase == Launch.bridgeReady {
                self.worker.asyncAfter(deadline: .now() + .milliseconds(Int(Launch.readyWindowMs))) { self.finishLaunch() }
            }
            call.resolve()
        }
    }

    /// Worker only: `app.start` without `markReady`, if still owed.
    private func finishLaunch() {
        if let start = launch.finish() { record([start]) }
    }

    /// A6 / E13: the user script's document start / clean `pagehide`. Main thread (WebKit).
    fileprivate func page(_ body: Any) {
        guard let m = body as? [String: Any] else { return }
        let url = m["u"] as? String
        if url != nil { refreshBasePath() } // a live update (`setServerBasePath`) reloads the page
        worker.async {
            if m["t"] as? String == "hide" { return self.pageWatch.hidden() }
            guard let url, self.pageWatch.loaded(url) else { return }
            self.solo(self.crash.webViewTerminated())
        }
    }

    /// E26: path transport changes → `network_change`; the first reading only seeds `network.type`.
    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { self?.networkChanged("none"); return }
            self?.networkChanged(path.usesInterfaceType(.wifi) ? "wifi" : path.usesInterfaceType(.cellular) ? "cellular"
                          : path.usesInterfaceType(.wiredEthernet) ? "ethernet" : "other")
        }
        monitor.start(queue: DispatchQueue(label: "com.nathanclaire.rum.network"))
        pathMonitor = monitor
    }

    private func networkChanged(_ type: String) {
        networkLock.lock()
        let previous = networkType
        networkType = type
        networkLock.unlock()
        guard let previous, previous != type else { return }
        let at = Outbox.now()
        worker.async {
            self.recordPassive([Signals.network(previous: previous, current: type, at: at)])
            // T6: connectivity regained retries parked segments.
            if previous == "none" { self.sender.trigger() }
        }
    }

    /// Main thread (UIKit).
    private func refreshBasePath() {
        let path = (bridge?.viewController as? CAPBridgeViewController)?.getServerBasePath()
        networkLock.lock()
        serverBasePath = path
        networkLock.unlock()
    }

    /// E32: device context plus the live `app.bundle_id` and `network.type`, stamped by the session gate.
    private func context() -> [String: Any] {
        networkLock.lock(); defer { networkLock.unlock() }
        var c = device
        c["app.bundle_id"] = Signals.bundleId(serverBasePath: serverBasePath, appBundlePath: Bundle.main.bundlePath)
        c["network.type"] = networkType
        return c
    }

    /// E24: memory warning → `memory_pressure`.
    @objc private func didReceiveMemoryWarning() {
        let at = Outbox.now()
        let footprint = Signals.footprintBytes()
        worker.async { self.recordPassive([Signals.pressure(footprint: footprint, at: at)]) }
    }

    /// Worker only: consent (P7), then the session gate.
    private func record(_ events: [[String: Any]]) {
        if !events.isEmpty && consent.enabled { _ = admit(events) }
    }

    /// Worker only: background-capable signals (network, memory) through the gate that isn't activity.
    private func recordPassive(_ events: [[String: Any]]) {
        if !events.isEmpty && consent.enabled { append(session.admitPassive(events)) }
    }

    /// E22 / E23: footprint + RSS. Worker only.
    private func sampleMemory(_ source: String) {
        recordPassive(Signals.memory(footprint: Signals.footprintBytes(), resident: Signals.residentBytes(),
                                     source: source, at: Outbox.now()))
    }

    @objc func getState(_ call: CAPPluginCall) {
        worker.async { call.resolve(self.state()) }
    }

    /// Worker only.
    private func state() -> [String: Any] {
        [
            "enabled": consent.enabled,
            "sessionId": session.id ?? NSNull(),
            "userId": user.id ?? NSNull(),
            "sampled": session.sampled,
            "configured": sender.configured,
            "sdkVersion": Sender.packageVersion,
            "deviceStartedAt": processStartedAt,
        ]
    }

    /// A2 `addListener('state')`: `{ type, …state }` on session rotation / enabled change.
    private func notifyState(_ type: String) {
        var s = state()
        s["type"] = type
        notifyListeners("state", data: s)
    }

    @objc func configure(_ call: CAPPluginCall) {
        // From init(); runtime only, never persisted (C1).
        let apiKey = call.getString("apiKey")
        let endpoint = call.getString("endpoint")
        worker.async {
            self.sender.configure(apiKey: apiKey, url: endpoint)
            self.sender.trigger()
            call.resolve()
        }
    }

    @objc func enqueue(_ call: CAPPluginCall) {
        guard let events = call.getArray("events") else {
            call.reject("events missing")
            return
        }
        // Filtered here, not in the gate, so a non-JSON event isn't counted into the session.
        let received = events.compactMap { $0 as? [String: Any] }.filter(JSONSerialization.isValidJSONObject)
        let drops = call.getObject("drops") ?? [:]
        let payload = call.options as? [String: Any] ?? [:]
        worker.async {
            // P7: opt-in mode / disabled → nothing captured or buffered.
            guard self.consent.enabled else { return call.resolve() }
            self.crash.mirror(payload) // A3
            // Not counted on failure: JS counts a failed hand-off as a drop and resends (A4, T8).
            guard self.admit(received) else { return call.reject("append failed") }
            // T8: JS-side drops, counted only once the append lands so a resend can't double them.
            for (reason, n) in drops { self.health.count(reason, (n as? NSNumber)?.intValue ?? 0) }
            call.resolve()
        }
    }

    /// P7: persisted traits; a trait change becomes one `user.profile.update`.
    @objc func identify(_ call: CAPPluginCall) {
        let traits = call.options as? [String: Any] ?? [:]
        worker.async {
            if self.consent.enabled, let update = self.user.identify(traits) { _ = self.admit([update]) }
            call.resolve()
        }
    }

    @objc func clearUser(_ call: CAPPluginCall) {
        worker.async {
            self.user.clear()
            call.resolve()
        }
    }

    @objc func enable(_ call: CAPPluginCall) {
        worker.async { self.setEnabled(true, call) }
    }

    @objc func disable(_ call: CAPPluginCall) {
        worker.async { self.setEnabled(false, call) }
    }

    /// P7: new device_id and session, user and outbox cleared; enabled state untouched.
    @objc func reset(_ call: CAPPluginCall) {
        worker.async {
            self.identity = Self.identityLine(self.consent.reset())
            self.crash.clear()
            if self.consent.enabled {
                self.append(self.session.restart())
                self.saveCrashContext()
                self.notifyState("session")
            }
            call.resolve()
        }
    }

    private func setEnabled(_ on: Bool, _ call: CAPPluginCall) {
        let was = consent.enabled
        append(consent.setEnabled(on))
        // ponytail: PLCrashReporter's handlers can't be uninstalled; they stay, but a report written
        // while disabled has no saved context and is dropped by the next launch's `replay`.
        if on {
            saveCrashContext()
            arm()
        } else {
            disarm()
        }
        if was != on { notifyState("enabled") }
        call.resolve()
    }

    /// E12, E15: crash handlers once per process; the watchdog while in the foreground. Worker only.
    private func arm() {
        DispatchQueue.main.async {
            _ = CrashReporter.enabled
            self.hangArmed = true
            if self.foreground { self.watchdog.start() }
        }
    }

    /// P7 `disable()`: stops the watchdog, forgets crumbs, root and saved context.
    private func disarm() {
        DispatchQueue.main.async {
            self.hangArmed = false
            self.watchdog.stop()
        }
        crash.clear()
    }

    /// T4: a native hang record becomes its own segment under the running build's identity, after
    /// the session gate (a hang follows the roll, S2). Worker only.
    private func solo(_ event: [String: Any]) {
        guard consent.enabled else { return }
        gated { $0.rotateIfIdle() }
        gated({ lines in for l in lines { try self.outbox.writeSolo(self.identity, l) } }) { $0.admit([event]) }
    }

    private func writeSolo(_ identity: String, _ line: String) {
        do {
            try outbox.writeSolo(identity, line)
            sender.trigger()
        } catch {
            NSLog("[EdgeRum] solo segment failed: \(error)")
        }
    }

    /// What a later crash report replays under (T4): identity, session, user, crumbs, root. Worker only.
    private func saveCrashContext() {
        crash.saveContext(identity: identity, sessionId: session.id, userId: user.id)
    }

    /// Worker only. S1: every event goes through the session gate on its way into the outbox.
    private func admit(_ events: [[String: Any]]) -> Bool {
        gated { $0.admit(events) }
    }

    /// Worker only. One session call committed to the outbox (rolled back if the append fails),
    /// with a `state` push when it rotated the session.
    /// `write` replaces the outbox append (solo segments).
    @discardableResult
    private func gated(_ write: (([String]) throws -> Void)? = nil, _ call: (Session) -> [String]) -> Bool {
        let before = session.id
        let write = write ?? { try self.outbox.append(self.identity, $0) }
        do {
            var written: [String] = []
            try session.commit({ try write($0); written = $0; self.sender.trigger() }, call)
            // After the commit, so the bookend sample's own gate pass can't nest inside it.
            sampleIfStarted(written)
        } catch {
            return false
        }
        saveCrashContext()
        if before != nil && before != session.id { notifyState("session") }
        return true
    }

    @discardableResult
    private func append(_ lines: [String]) -> Bool {
        guard !lines.isEmpty else { return true }
        do {
            try outbox.append(identity, lines)
        } catch {
            return false
        }
        sampleIfStarted(lines)
        sender.trigger()
        return true
    }

    /// E22: a new session gets its memory bookend, in the same segment. Worker only.
    // ponytail: substring check on serialized lines; Session returns strings, not events.
    private func sampleIfStarted(_ lines: [String]) {
        if lines.contains(where: { $0.contains(#""eventName":"session.started""#) }) { sampleMemory("session_start") }
    }

    /// T3: background seals the open segment and sends, inside a background task.
    /// E2 background; E22 end bookend (every background may be the session's last); A5: an owed `app.start` goes now.
    @objc private func didEnterBackground() {
        let at = Outbox.now()
        foreground = false
        watchdog.stop()
        let app = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        // Main thread only: the expiration handler runs there and must end the task before returning.
        let end = {
            guard task != .invalid else { return }
            app.endBackgroundTask(task)
            task = .invalid
        }
        task = app.beginBackgroundTask(withName: "EdgeRum flush", expirationHandler: end)
        worker.async {
            self.record([Signals.lifecycle("backgrounded", at: at)])
            self.finishLaunch()
            self.sampleMemory("session_end")
            self.outbox.seal()
            self.sender.trigger { DispatchQueue.main.async(execute: end) }
        }
    }

    @objc private func willEnterForeground() {
        let at = Outbox.now()
        foreground = true
        if hangArmed { watchdog.start() }
        worker.async {
            // E1: a foreground after the idle timeout starts a new session.
            if self.consent.enabled { self.gated { $0.rotateIfIdle() } }
            self.record([Signals.lifecycle("foregrounded", at: at)]) // E2
            self.sender.trigger()
        }
    }

    /// W2: app identity from Bundle.main, no override; nil → omitted (R15).
    private static func identityLine(_ deviceId: String) -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        return Sender.identityLine(
            name: (info["CFBundleDisplayName"] ?? info["CFBundleName"]) as? String,
            packageName: Bundle.main.bundleIdentifier,
            version: info["CFBundleShortVersionString"] as? String,
            buildNumber: info["CFBundleVersion"] as? String,
            deviceId: deviceId)
    }

    /// E32 (= Cordova iOS device context) plus always-on `webview.version` (P5). Main thread (UIKit).
    private static func deviceContext() -> [String: Any] {
        var u = utsname()
        uname(&u)
        // `utsname.machine` is a fixed, NUL-terminated C array: its base address is never nil.
        let machine = withUnsafeBytes(of: &u.machine) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        let screen = UIScreen.main
        #if arch(arm64)
        let abi = "arm64"
        #else
        let abi = "x86_64"
        #endif
        var c: [String: Any] = [
            "device.platform": "ios",
            "device.platform_version": UIDevice.current.systemVersion,
            // The simulator reports the host's arch; it names the device it plays.
            "device.model": ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine,
            "device.manufacturer": "Apple",
            "device.brand": "Apple",
            "device.locale": Locale.current.identifier.replacingOccurrences(of: "_", with: "-"),
            "device.timezone": TimeZone.current.identifier,
            "device.dark_mode": UITraitCollection.current.userInterfaceStyle == .dark,
            "device.cpu_abi": abi,
            "device.cpu_cores": ProcessInfo.processInfo.activeProcessorCount,
            "device.screen_density": Int(screen.scale * 160), // dpi, as Android densityDpi (1x = 160)
            "device.screen_width_px": Int(screen.nativeBounds.width),
            "device.screen_height_px": Int(screen.nativeBounds.height),
            "display.refresh_rate": screen.maximumFramesPerSecond,
        ]
        // WebKit ships with the OS; its framework version is the engine build (e.g. 20621.2.5).
        c["webview.version"] = Bundle(for: WKWebView.self).infoDictionary?["CFBundleVersion"] as? String
        return c
    }

    /// Process start, epoch ms (`kinfo_proc.p_starttime`); now if sysctl fails.
    private static func processStartMs() -> Int64 {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Outbox.now() }
        let t = info.kp_proc.p_un.__p_starttime
        return Int64(t.tv_sec) * 1000 + Int64(t.tv_usec) / 1000
    }
}

/// A6: `WKUserContentController` retains its handlers; this one holds the plugin weakly.
private final class PageMessages: NSObject, WKScriptMessageHandler {
    private weak var plugin: EdgeRumCrashPlugin?

    init(_ plugin: EdgeRumCrashPlugin) {
        self.plugin = plugin
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        plugin?.page(message.body)
    }
}
