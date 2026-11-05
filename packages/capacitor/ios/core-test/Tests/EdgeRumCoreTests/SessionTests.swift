@testable import EdgeRumCore
import XCTest

func event(_ name: String, _ attrs: [String: Any] = [:]) -> [String: Any] {
    ["type": "event", "eventName": name, "timestamp": "t", "attributes": attrs]
}

func metric(_ name: String) -> [String: Any] {
    ["type": "metric", "metricName": name, "value": 1, "attributes": [String: Any]()]
}

func names(_ lines: [String]) -> [String] {
    lines.map { json($0)["eventName"] as? String ?? json($0)["metricName"] as? String ?? "" }
}

func attrs(_ line: String) -> [String: Any] {
    json(line)["attributes"] as? [String: Any] ?? [:]
}

func crash(_ type: String, _ stack: String) -> [String: Any] {
    event("app.crash", ["is_fatal": false, "handled": true, "exception_type": type, "stacktrace": stack])
}

final class SessionTests: XCTestCase {
    var defaults: UserDefaults!
    let suite = "edge_rum_tests_\(UUID().uuidString)"
    var dir: URL!
    var health: Health!
    var now: Int64 = 1_793_008_800_000 // 2026-10-26T10:00:00.000Z
    var roll = 0.0
    var ids = 0
    var userId: String?

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("edge_rum_\(UUID().uuidString)")
        health = Health(dir: dir)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    func session(_ rate: Double) -> Session {
        Session(defaults: defaults, health: health, clock: { [unowned self] in now }, sampleRate: rate,
                roll: { [unowned self] in roll }, newId: { [unowned self] in ids += 1; return "session_\(ids)" },
                userId: { [unowned self] in userId })
    }

    func testFirstBeginStartsFirstSession() {
        let out = session(1).begin()
        XCTAssertEqual(names(out), ["session.started"])
        let a = attrs(out[0])
        XCTAssertEqual(a["session.id"] as? String, "session_1")
        XCTAssertEqual(a["session.start_time"] as? String, "2026-10-26T10:00:00.000Z")
        XCTAssertEqual(a["session.is_first_session"] as? Bool, true)
        XCTAssertEqual(a["session.total_sessions"] as? Int, 1)
        XCTAssertNil(a["session.sampled"], "S1: absent at rate 1")
    }

    func testStampsSessionAndUserOnEveryEvent() {
        let s = session(1)
        _ = s.begin()
        userId = "u1"
        let a = attrs(s.admit([event("navigation")])[0])
        XCTAssertEqual(a["session.id"] as? String, "session_1")
        XCTAssertEqual(a["user.id"] as? String, "u1")
    }

    func testIdleTimeoutRotatesWithBackdatedFinalizeAndFreshCounters() {
        let s = session(1)
        _ = s.begin()
        _ = s.admit([event("navigation", ["navigation.to_screen": "/home"]), metric("LCP")])
        now += 60_000
        _ = s.admit([event("navigation", ["navigation.to_screen": "/cart"])])
        now += Session.idleMs + 1

        let out = s.admit([event("custom_event")])
        XCTAssertEqual(names(out), ["session.finalized", "session.started", "custom_event"])
        let fin = attrs(out[0])
        XCTAssertEqual(json(out[0])["timestamp"] as? String, "2026-10-26T10:01:00.000Z", "E1: backdated")
        XCTAssertEqual(fin["session.id"] as? String, "session_1")
        XCTAssertEqual(fin["session.duration_ms"] as? Int, 60_000)
        XCTAssertEqual(fin["session.event_count"] as? Int, 2)
        XCTAssertEqual(fin["session.metric_count"] as? Int, 1)
        XCTAssertEqual(fin["session.screen_count"] as? Int, 2)
        XCTAssertEqual(fin["session.visited_screens"] as? String, "/home,/cart")
        let started = attrs(out[1])
        XCTAssertEqual(started["session.id"] as? String, "session_2")
        XCTAssertEqual(started["session.is_first_session"] as? Bool, false)
        XCTAssertEqual(started["session.total_sessions"] as? Int, 2)
        XCTAssertEqual(attrs(out[2])["session.id"] as? String, "session_2")
        XCTAssertEqual(s.id, "session_2")
    }

    func testRotateIfIdleOnlyRotatesPastTheTimeout() {
        let s = session(1)
        _ = s.begin()
        now += Session.idleMs
        XCTAssertTrue(s.rotateIfIdle().isEmpty)
        now += 1
        XCTAssertEqual(names(s.rotateIfIdle()), ["session.finalized", "session.started"])
    }

    func testSessionAndRollSurviveReloadAndRelaunchWithinTimeout() {
        roll = 0.9
        let s = session(0.5)
        _ = s.begin()
        XCTAssertFalse(s.sampled)
        _ = s.admit([event("navigation")])

        now += 1_000
        roll = 0 // a fresh roll would keep the session; the persisted one must win
        let again = session(0.5)
        XCTAssertTrue(again.begin().isEmpty, "resumed, no bookends")
        XCTAssertEqual(again.id, "session_1")
        XCTAssertFalse(again.sampled)
    }

    func testRelaunchAfterTimeoutFinalizesRecordedSession() {
        let s = session(1)
        _ = s.begin()
        _ = s.admit([event("navigation")])
        now += Session.idleMs + 1

        let out = session(1).begin()
        XCTAssertEqual(names(out), ["session.finalized", "session.started"])
        XCTAssertEqual(attrs(out[0])["session.event_count"] as? Int, 1)
    }

    func testCorruptRecordStartsFresh() {
        defaults.set(["id": "session_x"], forKey: Session.recordKey)
        XCTAssertEqual(names(session(1).begin()), ["session.started"])
    }

    func testSampledOutKeepsOnlyExemptAndCountsEverythingUncounted() {
        roll = 0.9
        let s = session(0.5)
        XCTAssertEqual(attrs(s.begin()[0])["session.sampled"] as? Bool, false)

        let kept = s.admit([
            event("navigation"), metric("LCP"), event("app.hang"), event("user.profile.update"),
            event("app.crash", ["is_fatal": false]),
            event("app.crash", ["is_fatal": true]), event("app.crash", ["cause": "WebViewTerminated"]),
            event("app.anr"), event("app.exit"), event("app.start"), event("sdk.health"),
        ])
        XCTAssertEqual(names(kept), ["app.crash", "app.crash", "app.anr", "app.exit", "app.start", "sdk.health"])
        XCTAssertEqual(health.snapshot(), [:], "S7: sampled-out drops not counted")

        now += Session.idleMs + 1
        let fin = attrs(s.rotateIfIdle()[0])
        XCTAssertEqual(fin["session.event_count"] as? Int, 10, "S6: counted before gates")
        XCTAssertEqual(fin["session.metric_count"] as? Int, 1)
        XCTAssertEqual(fin["session.sampled"] as? Bool, false)
    }

    func testSampledInAtFractionalRateSaysSo() {
        roll = 0.1
        let s = session(0.5)
        XCTAssertEqual(attrs(s.begin()[0])["session.sampled"] as? Bool, true)
        XCTAssertEqual(s.admit([event("navigation")]).count, 1)
    }

    func testSampleRateIsClamped() {
        roll = 0
        let none = session(-1)
        _ = none.begin()
        XCTAssertFalse(none.sampled)
        defaults.removePersistentDomain(forName: suite)
        roll = 0.999
        let all = session(7)
        XCTAssertNil(attrs(all.begin()[0])["session.sampled"], "clamped to 1: no session.sampled")
        XCTAssertTrue(all.sampled)
    }

    func testInteractionCap() {
        assertCap(event("ui.interaction"), 200, "events_dropped.cap.interaction")
    }

    func testBridgeSummaryCapIsFiftyTotal() {
        assertCap(event("bridge.summary", ["bridge.service": "Camera"]), 50, "events_dropped.cap.bridge")
    }

    func testCustomCapIsCombinedAcrossCustomHostMetricsAndTasks() {
        let s = session(1)
        _ = s.begin()
        let kept = s.admit(Array(repeating: event("custom_event"), count: 300)).count
            + s.admit(Array(repeating: metric("checkout_ms"), count: 150)).count
            + s.admit(Array(repeating: event("task.complete"), count: 50)).count
        XCTAssertEqual(kept, 500)
        XCTAssertEqual(s.admit([event("custom_event"), metric("cart"), event("task.complete")]).count, 0)
        XCTAssertEqual(s.admit([metric("LCP")]).count, 1)
        XCTAssertEqual(health.snapshot(), ["events_dropped.cap.custom": 3])
    }

    func testErrorCapPerDedupKeyThenTotal() {
        let s = session(1)
        _ = s.begin()
        XCTAssertEqual(s.admit(Array(repeating: crash("TypeError", "TypeError: x\n    at f (app:///main.js:1:2)"), count: 6)).count, 5)
        // Same type, different top frame → own key.
        XCTAssertEqual(s.admit(Array(repeating: crash("TypeError", "TypeError: x\n    at g (app:///main.js:9:9)"), count: 5)).count, 5)
        for i in 0..<8 { _ = s.admit(Array(repeating: crash("E\(i)", ""), count: 5)) }
        XCTAssertEqual(s.admit([crash("New", "")]).count, 0, "50 total")
        XCTAssertEqual(s.admit([event("app.crash", ["is_fatal": true])]).count, 1, "fatal never capped")
        XCTAssertEqual(health.snapshot(), ["events_dropped.cap.error": 2])
    }

    func testAnAtSignInTheMessageIsNotTheTopFrame() {
        let s = session(1)
        _ = s.begin()
        let f = crash("E", "Error: bad a@b.io\n    at f (app:///x.js:1:1)")
        let g = crash("E", "Error: bad a@b.io\n    at g (app:///x.js:2:1)")
        let batch = Array(repeating: f, count: 5) + Array(repeating: g, count: 4) + [crash("E", "g@app:///x.js:2:1")]
        XCTAssertEqual(s.admit(batch).count, 10, "distinct frames under one message → distinct keys")
    }

    func testUncappedEventsPassFreely() {
        let s = session(1)
        _ = s.begin()
        XCTAssertEqual(s.admit(Array(repeating: event("http.request"), count: 1000)).count, 1000)
    }

    func testScreenCountKeepsCountingPastTheVisitedList() {
        let s = session(1)
        _ = s.begin()
        _ = s.admit(Array(repeating: event("navigation", ["navigation.to_screen": "/a"]), count: 60))
        now += Session.idleMs + 1
        let fin = attrs(s.rotateIfIdle()[0])
        XCTAssertEqual(fin["session.screen_count"] as? Int, 60)
        XCTAssertEqual((fin["session.visited_screens"] as? String)?.split(separator: ",").count, 50)
    }

    func testCapsSurviveReloadAndResetOnRotation() {
        let s = session(1)
        _ = s.begin()
        _ = s.admit(Array(repeating: event("ui.interaction"), count: 200))
        let reloaded = session(1)
        _ = reloaded.begin()
        XCTAssertEqual(reloaded.admit([event("ui.interaction")]).count, 0)
        now += Session.idleMs + 1
        XCTAssertEqual(reloaded.admit([event("ui.interaction")]).count, 3)
    }

    func testRestartStartsFreshWithoutFinalizingAndEndForgets() {
        let s = session(1)
        _ = s.begin()
        XCTAssertEqual(names(s.restart()), ["session.started"])
        XCTAssertEqual(s.id, "session_2")
        s.end()
        XCTAssertNil(s.id)
        XCTAssertTrue(s.admit([event("navigation")]).isEmpty)
        XCTAssertEqual(names(session(1).begin()), ["session.started"], "ended session not finalized on relaunch")
    }

    func testFailedAppendRollsBackSoAResendCountsOnce() throws {
        struct DiskFull: Error {}
        let s = session(1)
        _ = s.begin()
        _ = s.admit(Array(repeating: event("ui.interaction"), count: 199))
        now += Session.idleMs + 1
        var appended: [String] = []
        let batch = Array(repeating: event("ui.interaction"), count: 202)

        XCTAssertThrowsError(try s.commit({ _ in throw DiskFull() }) { $0.admit(batch) })
        XCTAssertEqual(s.id, "session_1", "rotation undone")
        XCTAssertEqual(health.snapshot(), [:], "cap drops undone")
        XCTAssertEqual(defaults.dictionary(forKey: Session.recordKey)?["id"] as? String, "session_1", "persisted record undone")
        XCTAssertEqual(defaults.integer(forKey: Session.totalKey), 1, "session total undone")

        try s.commit({ appended += $0 }) { $0.admit(batch) }
        XCTAssertEqual(names(appended).prefix(2), ["session.finalized", "session.started"], "bookends emitted again")
        XCTAssertEqual(attrs(appended[0])["session.event_count"] as? Int, 199, "failed attempt not counted")
        XCTAssertEqual(attrs(appended[1])["session.total_sessions"] as? Int, 2)
        XCTAssertEqual(health.snapshot(), ["events_dropped.cap.interaction": 2])
    }

    func testCapDropsReachTheWireAsSdkHealth() throws {
        StubProtocol.reset()
        let s = session(1)
        let lines = s.begin() + s.admit(Array(repeating: event("ui.interaction"), count: 201))
        let outbox = Outbox(dir: dir, clock: { [unowned self] in now }, health: health)
        try outbox.append(SenderTests.identity, lines)
        outbox.seal()
        let sender = Sender(outbox: outbox, health: health, sdkVersion: "5.0.0", session: StubProtocol.session(),
                            clock: { [unowned self] in now }, sleep: { _ in }, retryMs: [1])
        sender.configure(apiKey: "edge_k", url: SenderTests.endpoint)
        StubProtocol.replies = [.status(200)]
        sender.drain()
        let events = json(gunzip(StubProtocol.requests[0].body))["events"] as? [[String: Any]] ?? []
        let last = events.last ?? [:]
        XCTAssertEqual(last["eventName"] as? String, "sdk.health")
        XCTAssertEqual((last["attributes"] as? [String: Any])?["events_dropped.cap.interaction"] as? Int, 1)
    }

    func assertCap(_ e: [String: Any], _ limit: Int, _ reason: String, line: UInt = #line) {
        let s = session(1)
        _ = s.begin()
        XCTAssertEqual(s.admit(Array(repeating: e, count: limit + 2)).count, limit, line: line)
        XCTAssertEqual(health.snapshot(), [reason: 2], line: line)
    }
}
