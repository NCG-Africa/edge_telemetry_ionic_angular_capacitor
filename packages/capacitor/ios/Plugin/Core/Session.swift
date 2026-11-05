import Foundation

/// Spec E1, S1–S3 (= Android `Session`): the native session and the gate every event passes at
/// outbox append. One record (id, roll, counters, caps) persisted per hand-off, so a WebView reload
/// or a relaunch inside the idle timeout resumes the same session. Worker queue only.
final class Session {
    static let idleMs: Int64 = 30 * 60_000
    static let recordKey = "edge_rum_capacitor.session"
    static let totalKey = "edge_rum_capacitor.total_sessions"
    /// `session.visited_screens` keeps the first 50; `session.screen_count` counts them all.
    private static let maxScreens = 50
    /// S3 per-session caps.
    static let capErrors = 50
    static let capErrorsPerKey = 5
    static let capInteractions = 200
    static let capBridge = 50
    static let capCustom = 500
    /// S2: never sampled out, never capped (fatal / WebView-death `app.crash` checked separately).
    private static let exempt: Set = ["session.started", "session.finalized", "app.anr", "app.exit", "app.start", "sdk.health"]
    /// SDK metrics; any other metric name is the host's (`measure()` / `time()`).
    private static let sdkMetrics: Set = ["LCP", "INP", "CLS", "FCP", "TTFB", "resource_timing", "memory_usage"]
    /// A JSC frame (`fn@url:line[:col]`); a V8 message line with an `@` in it doesn't match.
    private static let jscFrame = #"^[^\s@]*@\S+:\d+(:\d+)?$"#

    private let defaults: UserDefaults
    private let health: Health
    private let clock: () -> Int64
    private let rate: Double
    private let roll: () -> Double
    private let newId: () -> String
    private let userId: () -> String?

    private(set) var id: String?
    private var startedAt: Int64 = 0
    private var lastActivityAt: Int64 = 0
    private var isSampled = false
    private var eventCount = 0
    private var metricCount = 0
    private var screenCount = 0
    private var screens: [String] = []
    private var caps: [String: Int] = [:]

    /// `roll` defaults to the system RNG (SecRandom-backed on Apple platforms).
    init(defaults: UserDefaults, health: Health, clock: @escaping () -> Int64 = Outbox.now, sampleRate: Double,
         roll: @escaping () -> Double = { Double.random(in: 0..<1) },
         newId: @escaping () -> String = { DeviceId.newId("session") }, userId: @escaping () -> String?) {
        self.defaults = defaults
        self.health = health
        self.clock = clock
        // C1: clamped 0..1; NaN (unparseable config) keeps everything.
        rate = sampleRate.isNaN ? 1 : min(max(sampleRate, 0), 1)
        self.roll = roll
        self.newId = newId
        self.userId = userId
    }

    /// False without a live session.
    var sampled: Bool { id != nil && isSampled }

    /// Launch / `enable()`: resumes the recorded session if still live, else finalizes it and starts one.
    func begin() -> [String] {
        if id == nil { load() }
        if id != nil { return rotateIfIdle() }
        var out: [String] = []
        start(&out)
        return out
    }

    /// Rotation check without activity (foreground). Bookends to append, or none.
    func rotateIfIdle() -> [String] {
        var out: [String] = []
        if id != nil && clock() - lastActivityAt > Self.idleMs {
            out.append(finalized())
            start(&out)
        }
        return out
    }

    /// `reset()`: a fresh session; the old one is discarded with the outbox, not finalized.
    func restart() -> [String] {
        var out: [String] = []
        start(&out)
        return out
    }

    /// `disable()`: forgets the session; nothing is finalized for it.
    func end() {
        id = nil
        defaults.removeObject(forKey: Self.recordKey)
    }

    /// The gate (S1): counts each event (Cordova S6), drops it if sampled out or capped, stamps
    /// `session.id` / `user.id` on what's kept. Returns the lines to append, bookends first.
    func admit(_ events: [[String: Any]]) -> [String] {
        guard id != nil else { return [] }
        var out = rotateIfIdle()
        for var e in events {
            var attrs = e["attributes"] as? [String: Any] ?? [:]
            let isMetric = e["type"] as? String == "metric"
            let name = e[isMetric ? "metricName" : "eventName"] as? String ?? ""
            count(isMetric, name, attrs)
            if !Self.isExempt(name, attrs) {
                guard isSampled else { continue }
                if let reason = capReason(isMetric, name, attrs) {
                    health.count(reason, 1)
                    continue
                }
            }
            stamp(&attrs)
            e["attributes"] = attrs
            if let line = Self.line(e) { out.append(line) }
        }
        lastActivityAt = clock()
        persist()
        return out
    }

    /// Compact JSON, slashes unescaped; nil for a non-JSON value.
    static func line(_ obj: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func count(_ isMetric: Bool, _ name: String, _ attrs: [String: Any]) {
        if isMetric { metricCount += 1 } else { eventCount += 1 }
        guard name == "navigation", let screen = attrs["navigation.to_screen"] as? String, !screen.isEmpty else { return }
        screenCount += 1
        if screens.count < Self.maxScreens { screens.append(screen) }
    }

    /// S3 / Cordova S7: the `sdk.health` reason when a cap is hit, else nil (and the event is counted).
    private func capReason(_ isMetric: Bool, _ name: String, _ attrs: [String: Any]) -> String? {
        if isMetric && Self.sdkMetrics.contains(name) { return nil }
        switch isMetric ? "custom_event" : name {
        case "app.crash":
            let key = "error:" + (attrs["exception_type"] as? String ?? "") + "|" + Self.topFrame(attrs["stacktrace"] as? String ?? "")
            return allow("error", Self.capErrors, key, Self.capErrorsPerKey) ? nil : "cap.error"
        case "ui.interaction": return allow("interaction", Self.capInteractions) ? nil : "cap.interaction"
        case "bridge.summary": return allow("bridge", Self.capBridge) ? nil : "cap.bridge"
        // `custom_event`, host metrics (mapped above) and tasks share one budget.
        case "custom_event", "task.complete": return allow("custom", Self.capCustom) ? nil : "cap.custom"
        default: return nil
        }
    }

    /// Takes a slot from the total and, if given, the per-key cap; neither is taken when either is full.
    private func allow(_ total: String, _ totalLimit: Int, _ key: String? = nil, _ keyLimit: Int = 0) -> Bool {
        let t = caps[total] ?? 0
        let k = key.flatMap { caps[$0] } ?? 0
        if t >= totalLimit || (key != nil && k >= keyLimit) { return false }
        caps[total] = t + 1
        if let key { caps[key] = k + 1 }
        return true
    }

    private func stamp(_ attrs: inout [String: Any]) {
        attrs["session.id"] = id
        if let u = userId() { attrs["user.id"] = u }
    }

    private func start(_ out: inout [String]) {
        let now = clock()
        id = newId()
        startedAt = now
        lastActivityAt = now
        isSampled = rate >= 1 || roll() < rate // S1
        eventCount = 0
        metricCount = 0
        screenCount = 0
        screens = []
        caps = [:]
        let total = defaults.integer(forKey: Self.totalKey) + 1
        defaults.set(total, forKey: Self.totalKey)
        persist()
        out.append(bookend("session.started", now, sampledAttr([
            "session.start_time": Sender.rfc3339(startedAt),
            "session.is_first_session": total == 1,
            "session.total_sessions": total,
        ])))
    }

    /// E1: backdated to the last activity, so idle time isn't session time.
    private func finalized() -> String {
        bookend("session.finalized", lastActivityAt, sampledAttr([
            "session.start_time": Sender.rfc3339(startedAt),
            "session.duration_ms": max(0, lastActivityAt - startedAt),
            "session.event_count": eventCount,
            "session.metric_count": metricCount,
            "session.screen_count": screenCount,
            "session.visited_screens": screens.joined(separator: ","),
        ]))
    }

    /// S1 (= Cordova S3): only when the rate is below 1.
    private func sampledAttr(_ a: [String: Any]) -> [String: Any] {
        var a = a
        if rate < 1 { a["session.sampled"] = isSampled }
        return a
    }

    private func bookend(_ name: String, _ at: Int64, _ attrs: [String: Any]) -> String {
        var attrs = attrs
        stamp(&attrs)
        // ponytail: primitives only, always serializable.
        return Self.line(["type": "event", "eventName": name, "timestamp": Sender.rfc3339(at), "attributes": attrs]) ?? ""
    }

    private func persist() {
        guard let id else { return }
        defaults.set([
            "id": id, "start": startedAt, "last": lastActivityAt, "sampled": isSampled,
            "events": eventCount, "metrics": metricCount, "screen_count": screenCount,
            "screens": screens, "caps": caps,
        ] as [String: Any], forKey: Self.recordKey)
    }

    /// A missing or corrupt record leaves no session.
    private func load() {
        guard let r = defaults.dictionary(forKey: Self.recordKey),
              let rid = r["id"] as? String, let start = r["start"] as? Int64, let last = r["last"] as? Int64,
              let sampled = r["sampled"] as? Bool, let events = r["events"] as? Int, let metrics = r["metrics"] as? Int,
              let screenCount = r["screen_count"] as? Int, let screens = r["screens"] as? [String],
              let caps = r["caps"] as? [String: Int] else { return }
        startedAt = start
        lastActivityAt = last
        isSampled = sampled
        eventCount = events
        metricCount = metrics
        self.screenCount = screenCount
        self.screens = screens
        self.caps = caps
        id = rid
    }

    private static func isExempt(_ name: String, _ attrs: [String: Any]) -> Bool {
        exempt.contains(name) ||
            (name == "app.crash" && (attrs["is_fatal"] as? Bool == true || attrs["cause"] as? String == "WebViewTerminated"))
    }

    // ponytail: first line that looks like a frame (V8 `at …`, JSC `fn@url`); parsed frames are issue 11's.
    private static func topFrame(_ stack: String) -> String {
        stack.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.hasPrefix("at ") || $0.range(of: jscFrame, options: .regularExpression) != nil } ?? ""
    }
}
