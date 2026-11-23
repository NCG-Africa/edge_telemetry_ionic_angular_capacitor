@testable import EdgeRumCore
import XCTest

final class CrashTests: XCTestCase {
    /// The build that crashed; the relaunch runs `SenderTests.identity` (1.4.2).
    static let crashedIdentity = SenderTests.identity.replacingOccurrences(of: "1.4.2", with: "1.4.1")
        .replacingOccurrences(of: #""142""#, with: #""141""#)
    static let app = "/private/var/containers/Bundle/Application/0A1B/Fixture.app/Fixture"
    static let frames = [
        Crash.Frame(pc: 0x102a41a2c, base: 0x102a40000, uuid: "4f6e8a0b1c2d3e4f5a6b7c8d9e0f1a2b", path: app,
                    symbol: nil), // no on-device symbolication (Y3)
        Crash.Frame(pc: 0x1a0f39f10, base: 0x1a0f00000, uuid: "9a8b7c6d5e4f30211203f4e5d6c7b8a9",
                    path: "/usr/lib/system/libsystem_c.dylib", symbol: nil),
        Crash.Frame(pc: 0xdead, base: 0, uuid: "", path: "", symbol: nil),
    ]
    /// PLCrashReporter's SIGSEGV on main at 2026-10-26T10:00:01Z (whole seconds).
    static let signal = Crash.Report(at: 1_793_008_801_000, signal: "SIGSEGV", signalCode: "SEGV_MAPERR",
                                     faultAddress: 0x8, thread: 0, frames: frames)
    static let exception = Crash.Report(at: 1_793_008_801_000, exceptionName: "NSInvalidArgumentException",
                                        exceptionReason: "-[Cart total]: unrecognized selector", thread: 3,
                                        frames: frames)
    static let root: [String: Any] = ["trace.id": "4bf92f3577b34da6a3ce929d0e0e4736",
                                      "rum.action.id": "00f067aa0ba902b7", "trace.root_type": "interaction"]

    var defaults: UserDefaults!
    let suite = "edge_rum_tests_\(UUID().uuidString)"
    var now: Int64 = 1_793_008_801_000 // 2026-10-26T10:00:01.000Z
    var dir: URL!
    var health: Health!
    var session: Session!
    var crash: Crash!
    var outbox: Outbox!

    override func setUp() {
        StubProtocol.reset()
        defaults = UserDefaults(suiteName: suite)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("edge_rum_\(UUID().uuidString)")
        health = Health(dir: dir)
        session = makeSession(rate: 1, roll: 0)
        _ = session.begin()
        crash = Crash(dir: dir, clock: { [unowned self] in now })
        outbox = Outbox(dir: dir, clock: { [unowned self] in now }, health: health)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    func makeSession(rate: Double, roll: Double) -> Session {
        Session(defaults: defaults, health: health, clock: { [unowned self] in now }, sampleRate: rate,
                roll: { roll }, newId: { "session_1" }, userId: { "u1" })
    }

    static func payload(_ crumbs: Int, _ screen: String?) -> [String: Any] {
        let b = (0..<crumbs).map { ["category": "navigation", "message": "crumb \($0)"] }
        let events = screen.map { [event("navigation", ["navigation.to_screen": $0])] } ?? []
        return ["events": events, "breadcrumbs": b]
    }

    /// The plugin's `solo()`: session gate, then a segment of its own.
    func solo(_ event: [String: Any], _ identity: String = SenderTests.identity) throws {
        for line in session.admit([event]) { try outbox.writeSolo(identity, line) }
    }

    /// Next launch: a fresh outbox seals leftovers; drains everything; one body per batch.
    func relaunchAndSend() -> [String] {
        now = 1_793_008_803_000 // 2026-10-26T10:00:03.000Z
        let outbox = Outbox(dir: dir, clock: { [unowned self] in now }, health: health)
        let sender = Sender(outbox: outbox, health: health, sdkVersion: "1.0.0", session: StubProtocol.session(),
                            clock: { [unowned self] in now }, sleep: { _ in }, retryMs: [1])
        sender.configure(apiKey: "k", url: SenderTests.endpoint)
        StubProtocol.replies = Array(repeating: .status(200), count: outbox.sealed().count)
        sender.drain()
        return StubProtocol.requests.map { gunzip($0.body) }
    }

    func attrs(_ e: [String: Any]?) -> [String: Any] {
        e?["attributes"] as? [String: Any] ?? [:]
    }

    /// The moment before the crash: crumbs, screen, root, context saved.
    func crashContext() {
        crash.mirror(Self.payload(1, "/checkout"))
        crash.setRoot(Self.root) // minted at 10:00:01.000, crash 500 ms later: live
        crash.saveContext(identity: Self.crashedIdentity, sessionId: "session_1", userId: "u1")
    }

    func testSignalCrashReplaysNextLaunchInItsOwnBatchUnderTheCrashedBuild() throws {
        crashContext()
        try outbox.append(SenderTests.identity, session.admit([event("navigation")]))
        health.count("outbox_full", 3)

        let next = Crash(dir: dir, clock: { [unowned self] in now })
        let p = try XCTUnwrap(next.replay(Self.signal))
        XCTAssertEqual(p.identity, Self.crashedIdentity)
        try outbox.writeSolo(p.identity, p.event)
        let bodies = relaunchAndSend()

        XCTAssertEqual(bodies.count, 2, "crash batch + the open segment sealed at relaunch")
        dumpGolden("app-crash-signal.json", bodies[0])
        let events = json(bodies[1])["events"] as? [[String: Any]] ?? []
        XCTAssertEqual(events.last?["eventName"] as? String, "sdk.health", "sdk.health rides the normal batch")
    }

    func testExceptionCrashGoldenBatchWithExpiredRoot() throws {
        crashContext()
        crash.setRoot(nil) // JS cleared it (background): ids kept, expired
        crash.saveContext(identity: Self.crashedIdentity, sessionId: "session_1", userId: "u1")
        let p = try XCTUnwrap(crash.replay(Self.exception))
        try outbox.writeSolo(p.identity, p.event)
        dumpGolden("app-crash-exception.json", relaunchAndSend()[0])
    }

    func testHangGoldenBatch() throws {
        crash.mirror(Self.payload(0, "/cart"))
        crash.setRoot(Self.root)
        now += 2_100
        try solo(crash.hang(durationMs: 2_100, frames: Self.frames))
        dumpGolden("app-hang.json", relaunchAndSend()[0])
    }

    func testMissingContextIsDropped() {
        XCTAssertNil(crash.replay(Self.signal), "no context to replay under")
    }

    func testUnknownSignalAndNoThread() {
        let r = Crash.Report(at: 0, signal: "SIGSYS", signalCode: "0")
        let a = attrs(Crash.native(r, [:]))
        XCTAssertEqual(a["error.cause"] as? String, "native_crash")
        XCTAssertEqual(a["error.type"] as? String, "SIGSYS")
        XCTAssertNil(a["error.thread"])
        XCTAssertNil(a["error.stacktrace"])
    }

    // MARK: - X10 root annotation

    func rootKeys(_ at: Int64, _ root: [String: Any]?) -> [String: Any] {
        crash.setRoot(root)
        now = at
        crash.saveContext(identity: Self.crashedIdentity, sessionId: nil, userId: nil)
        let r = Crash.Report(at: at, signal: "SIGABRT")
        return attrs(json(crash.replay(r)?.event ?? ""))
    }

    func testNoRootNoTraceKeys() {
        let a = rootKeys(now, nil)
        XCTAssertNil(a["trace.id"])
        XCTAssertNil(a["trace.root_expired"])
    }

    func testRootIsJudgedAtTheEndOfTheCrashSecond() {
        XCTAssertNil(rootKeys(now + 1_000, Self.root)["trace.root_expired"], "1.999 s at most: live")
    }

    func testRootPastIdleLineIsExpired() {
        let a = rootKeys(now + 1_002, Self.root)
        XCTAssertEqual(a["trace.id"] as? String, "4bf92f3577b34da6a3ce929d0e0e4736")
        XCTAssertEqual(a["trace.root_expired"] as? Bool, true)
    }

    func testLaunchRootIsIdleExemptUntilTheCap() {
        var launch = Self.root
        launch["trace.root_type"] = "launch"
        XCTAssertNil(rootKeys(now + 9_000, launch)["trace.root_expired"])
        crash.clear()
        XCTAssertEqual(rootKeys(now + 10_001, launch)["trace.root_expired"] as? Bool, true)
    }

    func testClearedRootKeepsIdsAndIsExpired() {
        crash.setRoot(Self.root)
        crash.setRoot(nil)
        crash.saveContext(identity: Self.crashedIdentity, sessionId: nil, userId: nil)
        let a = attrs(json(crash.replay(Crash.Report(at: now, signal: "SIGABRT"))?.event ?? ""))
        XCTAssertEqual(a["rum.action.id"] as? String, "00f067aa0ba902b7")
        XCTAssertEqual(a["trace.root_expired"] as? Bool, true)
    }

    func testHangJudgesRootWhenMainBlocked() {
        crash.setRoot(Self.root)
        now += 3_000 // noticed 3 s after mint, but main blocked 1.5 s after mint
        XCTAssertNil(attrs(crash.hang(durationMs: 1_500, frames: []))["trace.root_expired"])
    }

    // MARK: - A3 breadcrumbs, P7

    func testBreadcrumbRingKeepsLastFifty() throws {
        crash.mirror(Self.payload(40, "/a"))
        crash.mirror(Self.payload(30, nil))
        crash.saveContext(identity: Self.crashedIdentity, sessionId: "session_1", userId: nil)
        let a = attrs(json(try XCTUnwrap(crash.replay(Self.signal)).event))
        let crumbs = try JSONSerialization.jsonObject(with: Data((a["error.breadcrumbs"] as? String ?? "").utf8)) as? [[String: Any]]
        XCTAssertEqual(crumbs?.count, Crash.breadcrumbs)
        XCTAssertEqual(crumbs?.first?["message"] as? String, "crumb 20")
        XCTAssertEqual(crumbs?.last?["message"] as? String, "crumb 29")
        XCTAssertEqual(a["screen.name"] as? String, "/a")
    }

    func testSetScreenOverridesAndEmptyClears() {
        crash.mirror(Self.payload(0, "/a"))
        crash.setScreen("/b")
        XCTAssertEqual(attrs(crash.hang(durationMs: 2_000, frames: []))["screen.name"] as? String, "/b")
        crash.setScreen("")
        XCTAssertNil(attrs(crash.hang(durationMs: 2_000, frames: []))["screen.name"])
    }

    func testClearForgetsEverything() {
        crash.mirror(Self.payload(3, "/a"))
        crash.setRoot(Self.root)
        crash.saveContext(identity: Self.crashedIdentity, sessionId: nil, userId: nil)
        crash.clear()
        let a = attrs(crash.hang(durationMs: 2_000, frames: []))
        XCTAssertNil(a["screen.name"])
        XCTAssertNil(a["trace.id"])
        XCTAssertNil(crash.replay(Self.signal), "saved context gone")
    }

    func testSampledOutSessionDropsHang() throws {
        defaults.removePersistentDomain(forName: suite)
        session = makeSession(rate: 0.5, roll: 0.9)
        _ = session.begin()
        try solo(crash.hang(durationMs: 2_000, frames: []))
        XCTAssertTrue(outbox.sealed().isEmpty, "app.hang follows the roll (S2)")
    }

    func testStackKeepsWholeFramesUnderTheCap() {
        let many = Array(repeating: Self.frames[0], count: 200)
        let a = attrs(crash.hang(durationMs: 2_000, frames: many))
        let stack = a["error.stacktrace"] as? String ?? ""
        XCTAssertLessThanOrEqual(stack.utf8.count, 2000)
        XCTAssertTrue(stack.hasSuffix("Fixture +0x1a2c"), "no torn frame")
    }
}
