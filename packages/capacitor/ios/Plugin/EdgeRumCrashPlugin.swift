import Foundation
import Capacitor
import UIKit
import WebKit

/// Capacitor plugin bridge. Hosts the 5.0 native core (`Core/`: identity, session, consent, user,
/// outbox, sender) and delegates crash work to `CrashReporter` (PLCrashReporter wrapper) and `HangDetector`.
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
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markHandled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLastScreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPerfSampling", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPerfSampling", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchFrameSamples", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchMemorySamples", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "identify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearUser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise)
    ]

    private static var installed = false
    private static let installLock = NSLock()

    // ── 5.0 native core (spec A2, W1–W3, T1) ──────────────────────────────
    private var health: Health!
    private var outbox: Outbox!
    private var sender: Sender!
    private var user: User!
    private var session: Session!
    private var consent: Consent!
    private var ticker: DispatchSourceTimer?
    /// Serial: core init and every plugin method, so nothing runs before init or interleaves a hand-off.
    private let worker = DispatchQueue(label: "com.nathanclaire.rum.worker")
    /// Replaced by `reset()`.
    private var identity = ""
    private let processStartedAt = EdgeRumCrashPlugin.processStartMs()
    /// W3: 4.x ids lived in localStorage; deleted, never carried over.
    private static let legacyCleanup =
        "['edge_rum_device_id','edge_rum_anon_uid','edge_rum_total_sessions','edge_rum_q','edge_rum_location']"
        + ".forEach(function(k){try{localStorage.removeItem(k)}catch(e){}})"

    /// Called once by Capacitor when the plugin is discovered and linked,
    /// before any JS runs. Set a breakpoint here (or grep the device console
    /// for the `[edge-rum]` debug log) to verify that SPM/CocoaPods linkage
    /// is wiring this plugin into the consumer app. The real work happens
    /// in `install(_:)` which fires when JS calls `plugin.install()`.
    public override func load() {
        super.load()
        // Plugins load before the start page, so the script runs ahead of any app JS.
        bridge?.webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.legacyCleanup, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
            // P7: opt-in mode starts nothing until enable().
            if self.consent.enabled { self.append(self.session.begin()) } else { self.clearCrashRecords() }
            self.sender.trigger()
            // T3: 30 s after the first event, within a second. T6: 30 s retry tick for parked segments.
            var ticks = 0
            let timer = DispatchSource.makeTimerSource(queue: self.worker)
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.outbox.sealIfDue()
                ticks += 1
                if ticks % 30 == 0 { self.sender.trigger() }
            }
            timer.resume()
            self.ticker = timer
        }
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didEnterBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willEnterForeground),
                       name: UIApplication.willEnterForegroundNotification, object: nil)
        #if DEBUG
        print("[edge-rum] EdgeRumCrashPlugin loaded (SPM/CocoaPods linkage OK; awaiting JS install)")
        #endif
    }

    @objc func install(_ call: CAPPluginCall) {
        worker.async {
            // P7: opt-in mode / disabled arms no native handlers.
            if self.consent.enabled { self.arm(call) } else { call.resolve(["installed": false]) }
        }
    }

    private func arm(_ call: CAPPluginCall) {
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
        worker.async {
            // P7: a crash recorded while disabled (handlers can't be uninstalled) is never sent.
            guard self.consent.enabled else {
                self.clearCrashRecords()
                call.resolve(["crashes": []])
                return
            }
            call.resolve(["crashes": CrashReporter.shared.fetchPending()])
        }
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

    @objc func startPerfSampling(_ call: CAPPluginCall) {
        worker.async {
            if self.consent.enabled { self.startSampling(call) } else { call.resolve(["started": false]) }
        }
    }

    private func startSampling(_ call: CAPPluginCall) {
        let captureFrames = call.getBool("captureFrames") ?? true
        let captureMemory = call.getBool("captureMemory") ?? true
        let memoryIntervalMs = call.getInt("memoryIntervalMs") ?? 10_000
        let slowThresholdMs = call.getDouble("frameSlowThresholdMs") ?? 16.67
        let captureAllFrames = call.getBool("captureAllFrames") ?? false

        if captureMemory {
            MemorySampler.shared.start(intervalMs: memoryIntervalMs)
        }
        if captureFrames {
            FrameSampler.shared.start(slowThresholdMs: slowThresholdMs, captureAllFrames: captureAllFrames)
        }
        call.resolve(["started": true])
    }

    @objc func stopPerfSampling(_ call: CAPPluginCall) {
        // On the worker so it can't overtake a queued start.
        worker.async {
            MemorySampler.shared.stop()
            FrameSampler.shared.stop()
            call.resolve()
        }
    }

    @objc func fetchFrameSamples(_ call: CAPPluginCall) {
        let frames = FrameSampler.shared.fetchPending()
        call.resolve(["frames": frames])
    }

    @objc func fetchMemorySamples(_ call: CAPPluginCall) {
        let samples = MemorySampler.shared.fetchPending()
        call.resolve(["samples": samples])
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
        worker.async {
            // P7: opt-in mode / disabled → nothing captured or buffered.
            guard self.consent.enabled else { return call.resolve() }
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
            self.clearCrashRecords()
            if self.consent.enabled {
                self.append(self.session.restart())
                self.notifyState("session")
            }
            call.resolve()
        }
    }

    private func setEnabled(_ on: Bool, _ call: CAPPluginCall) {
        let was = consent.enabled
        append(consent.setEnabled(on))
        // ponytail: PLCrashReporter's handlers can't be uninstalled; they stay but record nothing JS
        // will send (records cleared here, fetchPending empty while disabled). enable() re-arms via JS `install`.
        if !on { disarm() }
        if was != on { notifyState("enabled") }
        call.resolve()
    }

    /// P7 `disable()`: stops the hang detector and samplers, deletes unsent crash records.
    private func disarm() {
        HangDetector.shared.stop()
        MemorySampler.shared.stop()
        FrameSampler.shared.stop()
        Self.installLock.lock()
        Self.installed = false
        Self.installLock.unlock()
        clearCrashRecords()
    }

    private func clearCrashRecords() {
        CrashReporter.shared.purgeNativeReport()
        CrashReporter.shared.markHandled(ids: CrashReporter.shared.fetchPending().compactMap { $0["id"] as? String })
    }

    /// Worker only. S1: every event goes through the session gate on its way into the outbox.
    private func admit(_ events: [[String: Any]]) -> Bool {
        gated { $0.admit(events) }
    }

    /// Worker only. One session call committed to the outbox (rolled back if the append fails),
    /// with a `state` push when it rotated the session.
    @discardableResult
    private func gated(_ call: (Session) -> [String]) -> Bool {
        let before = session.id
        do {
            try session.commit({ try self.outbox.append(self.identity, $0); self.sender.trigger() }, call)
        } catch {
            return false
        }
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
        sender.trigger()
        return true
    }

    /// T3: background seals the open segment and sends, inside a background task.
    @objc private func didEnterBackground() {
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
            self.outbox.seal()
            self.sender.trigger { DispatchQueue.main.async(execute: end) }
        }
    }

    @objc private func willEnterForeground() {
        worker.async {
            // E1: a foreground after the idle timeout starts a new session.
            if self.consent.enabled { self.gated { $0.rotateIfIdle() } }
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
