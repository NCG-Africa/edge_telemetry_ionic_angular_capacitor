@testable import EdgeRumCore
import XCTest

final class SignalsTests: XCTestCase {
    var defaults: UserDefaults!
    let suite = "edge_rum_tests_\(UUID().uuidString)"
    var dir: URL!
    var health: Health!
    var now: Int64 = 1_793_008_802_000 // 2026-10-26T10:00:02.000Z

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("edge_rum_\(UUID().uuidString)")
        health = Health(dir: dir)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    func session() -> Session {
        let s = Session(defaults: defaults, health: health, clock: { [unowned self] in now }, sampleRate: 1,
                        roll: { 0 }, newId: { "session_1" }, userId: { nil })
        _ = s.begin()
        return s
    }

    func attrs(_ e: [String: Any]?) -> [String: Any] {
        e?["attributes"] as? [String: Any] ?? [:]
    }

    func names(_ lines: [String]) -> [String] {
        lines.map { json($0)["eventName"] as? String ?? json($0)["metricName"] as? String ?? "" }
    }

    /// The lines as one sent batch (`solo`: their own segment, as a crash), dumped as a golden batch.
    static func dumpGoldenBatch(_ name: String, _ dir: URL, _ health: Health, _ lines: [String], solo: Bool = false,
                             file: StaticString = #filePath, line: UInt = #line) throws {
        StubProtocol.reset()
        let sendAt: Int64 = 1_793_008_803_000 // 10:00:03.000Z
        let outbox = Outbox(dir: dir, clock: { sendAt }, health: health)
        if solo {
            for l in lines { try outbox.writeSolo(SenderTests.identity, l) }
        } else {
            try outbox.append(SenderTests.identity, lines)
            outbox.seal()
        }
        let sender = Sender(outbox: outbox, health: health, sdkVersion: "1.0.0", session: StubProtocol.session(),
                            clock: { sendAt }, sleep: { _ in }, retryMs: [1])
        sender.configure(apiKey: "k", url: SenderTests.endpoint)
        StubProtocol.replies = [.status(200)]
        sender.drain()
        let body = try XCTUnwrap(StubProtocol.requests.first.map { gunzip($0.body) }, file: file, line: line)
        dumpGolden(name, body)
    }

    // MARK: - E22–E24, E26, E32

    func testMemoryIsOneUsageEventInFootprintMbFallingBackToRss() {
        let both = Signals.memory(footprint: 1 << 20, resident: 2 << 20, source: "periodic", at: now)
        XCTAssertEqual(both?["eventName"] as? String, "memory.usage")
        XCTAssertEqual(both?["type"] as? String, "event")
        XCTAssertEqual(attrs(both)["memory.usage_mb"] as? Double, 1)
        XCTAssertEqual(attrs(both)["memory.type"] as? String, "footprint")
        XCTAssertEqual(attrs(both)["memory.resident_kb"] as? Int64, 2048)
        let rssOnly = attrs(Signals.memory(footprint: nil, resident: 196_608_000, source: "periodic", at: now))
        XCTAssertEqual(rssOnly["memory.usage_mb"] as? Double, 187.5)
        XCTAssertEqual(rssOnly["memory.type"] as? String, "rss")
        XCTAssertNil(Signals.memory(footprint: nil, resident: nil, source: "periodic", at: now))
    }

    func testPressureWithoutReadingOmitsUsage() {
        let a = attrs(Signals.pressure(footprint: nil, at: now))
        XCTAssertEqual(a["memory.pressure_level"] as? String, "critical")
        XCTAssertNil(a["memory.usage_mb"])
    }

    func testProcessMemoryReadsThisProcess() {
        XCTAssertGreaterThan(Signals.footprintBytes() ?? 0, 0)
        XCTAssertGreaterThan(Signals.residentBytes() ?? 0, 0)
    }

    func testBundleIdIsTheLiveUpdateFolderOrBuiltin() {
        let app = "/private/var/containers/Bundle/Application/0A1B/App.app"
        XCTAssertEqual(Signals.bundleId(serverBasePath: app + "/public", appBundlePath: app), "builtin")
        XCTAssertEqual(Signals.bundleId(serverBasePath: nil, appBundlePath: app), "builtin")
        XCTAssertEqual(Signals.bundleId(serverBasePath: "", appBundlePath: app), "builtin")
        XCTAssertEqual(Signals.bundleId(serverBasePath: "/var/mobile/Library/NoCloud/ionic_built_snapshots/b-42/",
                                        appBundlePath: app), "b-42")
    }

    func testContextStampedButEventKeysWin() {
        let s = session()
        s.context = { ["device.model": "iPhone16,2", "network.type": "wifi"] }
        let a = attrs(json(s.admit([Signals.network(previous: "wifi", current: "cellular", at: now)])[0]))
        XCTAssertEqual(a["device.model"] as? String, "iPhone16,2")
        XCTAssertEqual(a["network.type"] as? String, "cellular")
    }

    func testPassiveAdmitNeitherRotatesNorCountsAsActivity() {
        let s = session()
        now += Session.idleMs + 1
        XCTAssertEqual(names(s.admitPassive([Signals.network(previous: "wifi", current: "none", at: now)])),
                       ["network.change"])
        XCTAssertEqual(names(s.rotateIfIdle()), ["session.finalized", "session.started"],
                       "a background signal doesn't keep the session alive")
    }

    /// E32: the context the plugin assembles, as one fixed device.
    static let deviceContext: [String: Any] = [
        "device.platform": "ios",
        "device.platform_version": "26.1",
        "device.model": "iPhone16,2",
        "device.manufacturer": "Apple",
        "device.brand": "Apple",
        "device.locale": "en-KE",
        "device.timezone": "Africa/Nairobi",
        "device.dark_mode": false,
        "device.cpu_abi": "arm64",
        "device.cpu_cores": 6,
        "device.screen_density": 480,
        "device.screen_width_px": 1290,
        "device.screen_height_px": 2796,
        "display.refresh_rate": 120,
        "webview.version": "21622.2.11.11.9",
        "app.bundle_id": "builtin",
        "network.type": "wifi",
    ]

    func testGoldenBatches() throws {
        let s = session()
        s.context = { Self.deviceContext }
        try Self.dumpGoldenBatch("app-lifecycle.json", dir, health, s.admit([Signals.lifecycle("backgrounded", at: now)]))
        s.context = { [:] }
        try Self.dumpGoldenBatch("memory-usage.json", dir, health,
                              s.admit([try XCTUnwrap(Signals.memory(footprint: 196_608_000, resident: 262_144_000,
                                                                    source: "session_start", at: now))]))
        try Self.dumpGoldenBatch("memory-pressure.json", dir, health, s.admit([Signals.pressure(footprint: 196_608_000, at: now)]))
        try Self.dumpGoldenBatch("network-change.json", dir, health,
                              s.admit([Signals.network(previous: "wifi", current: "none", at: now)]))
        // Idle rotation: both bookends, then the profile event in the new session.
        now += Session.idleMs + 1
        let user = User(defaults: defaults, clock: { [unowned self] in now })
        let profile = try XCTUnwrap(user.identify(["id": "u1", "name": "Ada", "email": "ada@example.com"]))
        try Self.dumpGoldenBatch("session.json", dir, health, s.admit([profile]))
    }

    // MARK: - A6, E13

    func testInferenceFlagsADocumentStartWithoutCleanShutdown() {
        var page = PageWatch()
        XCTAssertFalse(page.loaded("capacitor://localhost/"), "first document of the process")
        page.hidden()
        XCTAssertFalse(page.loaded("capacitor://localhost/"), "reloaded cleanly")
        // pushState moved the app to /tabs/profile; Capacitor reloads that URL after the death.
        XCTAssertTrue(page.loaded("capacitor://localhost/tabs/profile"),
                      "same origin again, no pagehide: the content process died")
        XCTAssertTrue(page.loaded("capacitor://localhost/#/cart"), "hash routing too")
        XCTAssertFalse(page.loaded("https://example.com/login"), "another origin: a navigation away")
    }

    func testWebViewTerminatedGoldenBatch() throws {
        let s = session()
        let crash = Crash(dir: dir, clock: { [unowned self] in now })
        crash.mirror(CrashTests.payload(1, "/checkout"))
        crash.setRoot(CrashTests.root)
        let e = crash.webViewTerminated()
        try Self.dumpGoldenBatch("app-crash-webview.json", dir, health, s.admit([e]), solo: true)
    }

    func testWebViewTerminatedIsExemptFromTheRoll() {
        defaults.removePersistentDomain(forName: suite)
        let s = Session(defaults: defaults, health: health, clock: { [unowned self] in now }, sampleRate: 0.5,
                        roll: { 0.9 }, newId: { "session_1" }, userId: { nil })
        _ = s.begin()
        let crash = Crash(dir: dir, clock: { [unowned self] in now })
        XCTAssertEqual(names(s.admit([crash.webViewTerminated()])), ["app.crash"], "S2")
    }
}
