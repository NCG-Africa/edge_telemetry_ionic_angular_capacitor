import Foundation

/// Spec A5, E3 (= Android `Launch`): the one `app.start` per cold launch, assembled from the native
/// process start + WebView created marks and the JS `markPhase` phases (ADR-044 §1). `bridgeReady`
/// stands where Cordova had `deviceready`; there is no ready timeout (E17 not emitted).
/// Processor #32 / #149: `app.start.duration_ms` ends at bridge ready; `markReady()` is a phase
/// (`app.start.mark_ready_ms`) and no longer extends it. One per process (`sent`).
final class Launch {
    /// A5: `markReady()` counts when it lands within this long of `bridgeReady`.
    static let readyWindowMs: Int64 = 30_000
    static let bridgeReady = "bridgeReady"
    static let markReady = "markReady"
    /// JS phases (A5) → `app.start.*` keys (N2), in launch order.
    private static let phases = [
        ("responseEnd", "app.start.response_end_ms"),
        ("DOMContentLoaded", "app.start.dom_content_loaded_ms"),
        ("load", "app.start.load_ms"),
        (bridgeReady, "app.start.bridge_ready_ms"),
        (markReady, "app.start.mark_ready_ms"),
    ]

    private let processStart: Int64
    private let webViewCreated: Int64
    private let lock = NSLock()
    private var marks: [String: Int64] = [:]
    private var emitted = false
    /// A second bridge (another `CAPBridgeViewController`) in the same process owes no `app.start`.
    private static var sent = false
    /// Guards `sent`: each bridge's `Launch` has its own `lock`.
    private static let sentLock = NSLock()
    private let once: Bool

    /// `once`: at most one `app.start` for the whole process (the plugin); tests build many.
    init(processStart: Int64, webViewCreated: Int64, once: Bool = false) {
        self.processStart = processStart
        self.webViewCreated = webViewCreated
        self.once = once
        if once {
            // Claimed at creation, not at emit: a second bridge may load before the first one sends.
            Self.sentLock.lock()
            emitted = Self.sent
            Self.sent = true
            Self.sentLock.unlock()
        }
    }

    /// Records a phase (first mark wins: a WebView reload re-sends them). Returns `app.start` when
    /// this mark completes it: `markReady` with `bridgeReady` seen, inside the window.
    func mark(_ phase: String, _ ts: Int64) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard !emitted, marks[phase] == nil, Self.phases.contains(where: { $0.0 == phase }) else { return nil }
        if phase == Self.markReady, let r = marks[Self.bridgeReady], ts - r > Self.readyWindowMs { return nil }
        marks[phase] = ts
        return marks[Self.bridgeReady] != nil && marks[Self.markReady] != nil ? emit() : nil
    }

    /// Window over (or app backgrounded): `app.start` without `markReady`, if `bridgeReady` came and it's still owed.
    func finish() -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        return emitted || marks[Self.bridgeReady] == nil ? nil : emit()
    }

    private func emit() -> [String: Any] {
        emitted = true
        // Callers checked `bridgeReady` is marked.
        let end = marks[Self.bridgeReady]!
        var a: [String: Any] = [
            "app.start.type": "cold",
            "app.start.duration_ms": max(0, end - processStart),
            "app.start.webview_created_ms": max(0, webViewCreated - processStart),
        ]
        for (phase, key) in Self.phases {
            if let ts = marks[phase] { a[key] = max(0, ts - processStart) }
        }
        return Crash.record("app.start", end, a)
    }
}
