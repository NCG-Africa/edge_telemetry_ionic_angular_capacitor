import Foundation

/// Spec A3, E12, E15, X10, Y3 (= Cordova `Crash`, Android `Crash`): the native breadcrumb mirror,
/// the last trace root, and the `app.crash` / `app.hang` records built from them. PLCrashReporter
/// writes the crash; the plugin hands its fields over as a `Report` next launch, and `replay` turns
/// it into an event under the identity, session, breadcrumbs and root `saveContext` saved before it died.
final class Crash {
    static let breadcrumbs = 50
    /// X1 idle line, counted from mint (native sees no extensions); `launch` is idle-exempt.
    static let rootIdleMs: Int64 = 2_000
    /// X1 cap: no root lives past it.
    static let rootCapMs: Int64 = 10_000
    /// Sibling `CrashReportingService` caps; whole frames are kept.
    private static let maxStack = 2000
    private static let maxMessage = 1000
    private static let signalNumbers = ["SIGILL": 4, "SIGTRAP": 5, "SIGABRT": 6, "SIGFPE": 8, "SIGBUS": 10, "SIGSEGV": 11]

    /// A record ready for `Outbox.writeSolo`.
    struct Pending {
        let identity: String
        let event: String
    }

    /// Y3: one frame in the iOS sibling's `StackFrames` format, `image +0x<offset> <symbol>`.
    struct Frame {
        let pc: UInt64
        /// Image load base; 0 when no image holds `pc`.
        let base: UInt64
        let uuid: String
        let path: String
        let symbol: String?

        var name: String { (path as NSString).lastPathComponent }

        /// `image +0x<offset>`; the absolute address when unresolved.
        var location: String {
            base == 0 ? "0x" + String(pc, radix: 16) : name + " +0x" + String(pc &- base, radix: 16)
        }

        var text: String { location + (base == 0 ? "" : symbol.map { " " + $0 } ?? "") }
    }

    /// What the plugin reads out of a PLCrashReporter report (Core can't link PLCrashReporter).
    struct Report {
        /// Whole seconds from PLCrashReporter, in ms.
        let at: Int64
        /// Uncaught NSException; nil for a signal.
        var exceptionName: String?
        var exceptionReason: String?
        var signal: String?
        var signalCode: String?
        var faultAddress: UInt64 = 0
        /// PLCrashReporter thread number; 0 = main.
        var thread: Int?
        var frames: [Frame] = []
    }

    private let context: URL
    private let clock: () -> Int64
    private let lock = NSLock()
    private var crumbs: [Any] = []
    private var screen: String?
    /// X10: the last root JS relayed; never parents, never expires on its own.
    private var root: [String: Any]?

    init(dir: URL, clock: @escaping () -> Int64 = Outbox.now) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        context = dir.appendingPathComponent("crash_context.json")
        self.clock = clock
    }

    /// A3: mirrors an `enqueue` hand-off's breadcrumbs (last 50) and its last screen.
    func mirror(_ payload: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        crumbs += payload["breadcrumbs"] as? [Any] ?? []
        if crumbs.count > Self.breadcrumbs { crumbs.removeFirst(crumbs.count - Self.breadcrumbs) }
        for case let e as [String: Any] in payload["events"] as? [Any] ?? [] {
            if let to = (e["attributes"] as? [String: Any])?["navigation.to_screen"] as? String, !to.isEmpty { screen = to }
        }
    }

    /// A2 `setLastScreen`.
    func setScreen(_ s: String) {
        lock.lock(); defer { lock.unlock() }
        screen = s.isEmpty ? nil : s
    }

    /// X10 `setRoot`: a root's `trace.id` / `rum.action.id` / `trace.root_type`, or none when JS
    /// cleared it (background, rotation). A cleared root keeps its ids and counts as expired.
    func setRoot(_ given: [String: Any]?) {
        lock.lock(); defer { lock.unlock() }
        guard let traceId = given?["trace.id"] as? String, !traceId.isEmpty else {
            root?["ended"] = true
            return
        }
        root = ["trace.id": traceId, "rum.action.id": given?["rum.action.id"] as? String ?? "",
                "trace.root_type": given?["trace.root_type"] as? String ?? "", "set_at": clock()]
    }

    /// E15: main-thread stall at or past the line. Not fatal, not handled; main stack only.
    func hang(durationMs: Int64, frames: [Frame]) -> [String: Any] {
        var a: [String: Any] = [
            "message": "Main thread blocked for \(durationMs) ms",
            "crash_thread": "main",
            "crash_is_main_thread": true,
            "is_fatal": false,
            "handled": false,
            "hang_duration_ms": durationMs,
        ]
        Self.stack(frames, into: &a)
        let at = clock()
        lock.lock()
        a["screen_name"] = screen
        // Judged when the main thread blocked, not when the watchdog noticed.
        Self.annotate(&a, root, at - durationMs)
        lock.unlock()
        return Self.record("app.hang", at, a)
    }

    /// What a crash report can't know: the identity, session, user, breadcrumbs and root of the
    /// moment. Saved after every hand-off and root change; best effort.
    func saveContext(identity: String, sessionId: String?, userId: String?) {
        var a: [String: Any] = [:]
        a["session.id"] = sessionId
        a["user.id"] = userId
        var ctx: [String: Any] = ["identity": identity]
        lock.lock()
        a["crash.breadcrumbs"] = Self.json(crumbs)
        a["screen_name"] = screen
        ctx["root"] = root
        lock.unlock()
        ctx["attributes"] = a
        guard let line = Session.line(ctx) else { return }
        try? Data(line.utf8).write(to: context, options: .atomic)
    }

    /// Last launch's crash as a solo-segment record under the crashed build's identity (T4);
    /// nil without a usable saved context.
    func replay(_ report: Report) -> Pending? {
        guard let data = try? Data(contentsOf: context),
              let ctx = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let identity = ctx["identity"] as? String,
              let line = Session.line(Self.native(report, ctx["attributes"] as? [String: Any] ?? [:],
                                                  root: ctx["root"] as? [String: Any])) else { return nil }
        return Pending(identity: identity, event: line)
    }

    /// P7 `disable()` / `reset()`: nothing from before survives.
    func clear() {
        try? FileManager.default.removeItem(at: context)
        lock.lock()
        crumbs = []
        screen = nil
        root = nil
        lock.unlock()
    }

    /// E12: the record for a crash report, `context` merged in, X10 keys from `root`.
    static func native(_ r: Report, _ context: [String: Any], root: [String: Any]? = nil) -> [String: Any] {
        var a: [String: Any]
        if let name = r.exceptionName {
            let reason = r.exceptionReason ?? ""
            a = ["message": cap(reason.isEmpty ? name : name + ": " + reason, maxMessage),
                 "exception_type": name, "cause": "NSException"]
        } else {
            let name = r.signal ?? "SIGNAL"
            a = ["message": "\(name), code \(r.signalCode ?? "0"), fault addr 0x\(String(r.faultAddress, radix: 16))",
                 "exception_type": name, "cause": "signal \(signalNumbers[name].map(String.init) ?? name)"]
        }
        if let t = r.thread {
            a["crash_thread"] = t == 0 ? "main" : "thread \(t)"
            a["crash_is_main_thread"] = t == 0
        }
        a["error_context"] = r.frames.first?.location ?? "unknown"
        stack(r.frames, into: &a)
        a["is_fatal"] = true
        a["handled"] = false
        a.merge(context) { _, saved in saved }
        // PLCrashReporter stamps whole seconds: judge the root at the latest the crash could have been.
        annotate(&a, root, r.at + 999)
        return record("app.crash", r.at, a)
    }

    /// X8 Tier 2 + X10: the root's keys, plus `trace.root_expired=true` when JS had cleared it or
    /// it was past X1's lines at `at` (absent = the root was live).
    // ponytail: native sees mint time only, not JS's idle extensions, so a root kept alive by a
    // slow request reads expired after 2 s (errs toward "expired"; ids still sent). Relay
    // extensions through setRoot if the backend needs the finer claim.
    private static func annotate(_ a: inout [String: Any], _ root: [String: Any]?, _ at: Int64) {
        guard let root, let traceId = root["trace.id"] as? String else { return }
        let type = root["trace.root_type"] as? String ?? ""
        a["trace.id"] = traceId
        a["rum.action.id"] = root["rum.action.id"] as? String ?? ""
        a["trace.root_type"] = type
        let setAt = (root["set_at"] as? NSNumber)?.int64Value ?? 0
        let line = type == "launch" ? rootCapMs : rootIdleMs
        if root["ended"] as? Bool == true || at - setAt > line { a["trace.root_expired"] = true }
    }

    /// `stacktrace` (whole frames up to `maxStack` bytes, as the sibling's `StackFrames.capped`) and
    /// `crash.binary_images`, the images those frames reference (Y3 symbolication keys).
    private static func stack(_ frames: [Frame], into a: inout [String: Any]) {
        var kept: [Frame] = []
        var size = -1 // no separator before the first frame
        for f in frames {
            size += f.text.utf8.count + 1
            if size > maxStack { break }
            kept.append(f)
        }
        guard !kept.isEmpty else { return }
        a["stacktrace"] = kept.map(\.text).joined(separator: "\n")
        var seen = Set<UInt64>()
        var images: [[String: String]] = []
        for f in kept where f.base != 0 && seen.insert(f.base).inserted {
            var image = ["name": f.name, "base": "0x" + String(f.base, radix: 16)]
            if !f.uuid.isEmpty { image["uuid"] = f.uuid }
            images.append(image)
        }
        if !images.isEmpty { a["crash.binary_images"] = json(images) }
    }

    static func record(_ name: String, _ at: Int64, _ attrs: [String: Any]) -> [String: Any] {
        ["type": "event", "eventName": name, "timestamp": Sender.rfc3339(at), "attributes": attrs]
    }

    private static func cap(_ s: String, _ max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max))
    }

    /// Compact, sorted keys: the wire string is stable.
    private static func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }
}
