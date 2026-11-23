@testable import EdgeRumCore
import XCTest

final class LaunchTests: XCTestCase {
    static let t0: Int64 = 1_793_008_800_000 // 2026-10-26T10:00:00.000Z, process start
    let launch = Launch(processStart: LaunchTests.t0, webViewCreated: LaunchTests.t0 + 120)

    func attrs(_ e: [String: Any]?) -> [String: Any] {
        e?["attributes"] as? [String: Any] ?? [:]
    }

    func pagePhases() {
        XCTAssertNil(launch.mark("responseEnd", Self.t0 + 300))
        XCTAssertNil(launch.mark("DOMContentLoaded", Self.t0 + 450))
        XCTAssertNil(launch.mark("load", Self.t0 + 600))
    }

    func testBridgeReadyAloneWaitsForTheWindow() {
        pagePhases()
        XCTAssertNil(launch.mark("bridgeReady", Self.t0 + 700), "markReady may still come")
        let a = attrs(launch.finish())
        XCTAssertEqual(a["app.start.duration_ms"] as? Int64, 700)
        XCTAssertEqual(a["app.start.webview_created_ms"] as? Int64, 120)
        XCTAssertEqual(a["app.start.bridge_ready_ms"] as? Int64, 700)
        XCTAssertNil(a["app.start.mark_ready_ms"])
        XCTAssertNil(launch.finish(), "once per launch")
    }

    func testMarkReadyInsideWindowCompletesItButDoesNotExtendIt() {
        pagePhases()
        _ = launch.mark("bridgeReady", Self.t0 + 700)
        let e = launch.mark("markReady", Self.t0 + 2000)
        XCTAssertEqual(attrs(e)["app.start.duration_ms"] as? Int64, 700, "#149: ends at bridge ready")
        XCTAssertEqual(attrs(e)["app.start.mark_ready_ms"] as? Int64, 2000)
        XCTAssertEqual(e?["timestamp"] as? String, Sender.rfc3339(Self.t0 + 700))
        XCTAssertNil(launch.finish())
    }

    func testMarkReadyBeforeBridgeReadyCountsAtBridgeReady() {
        XCTAssertNil(launch.mark("markReady", Self.t0 + 500))
        XCTAssertEqual(attrs(launch.mark("bridgeReady", Self.t0 + 700))["app.start.duration_ms"] as? Int64, 700)
    }

    func testLateMarkReadyIgnored() {
        _ = launch.mark("bridgeReady", Self.t0 + 700)
        XCTAssertNil(launch.mark("markReady", Self.t0 + 700 + Launch.readyWindowMs + 1))
        XCTAssertNil(attrs(launch.finish())["app.start.mark_ready_ms"])
    }

    func testReloadUnknownAndCordovaPhasesIgnored() {
        _ = launch.mark("load", Self.t0 + 600)
        _ = launch.mark("load", Self.t0 + 9000)
        _ = launch.mark("bogus", Self.t0 + 1)
        _ = launch.mark("deviceready", Self.t0 + 650)
        XCTAssertNil(launch.finish(), "no bridgeReady, no app.start (E17 not emitted)")
        _ = launch.mark("bridgeReady", Self.t0 + 700)
        let a = attrs(launch.finish())
        XCTAssertEqual(a["app.start.load_ms"] as? Int64, 600)
        XCTAssertNil(a["bogus"])
        XCTAssertNil(a["app.start.deviceready_ms"])
    }

    func testGoldenBatch() throws {
        let suite = "edge_rum_tests_\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("edge_rum_\(UUID().uuidString)")
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: dir)
        }
        let health = Health(dir: dir)
        // S2: exempt, so it survives a sampled-out session.
        let session = Session(defaults: defaults, health: health, clock: { Self.t0 + 2000 }, sampleRate: 0,
                              roll: { 0.9 }, newId: { "session_1" }, userId: { nil })
        _ = session.begin()
        pagePhases()
        _ = launch.mark("bridgeReady", Self.t0 + 700)
        let start = try XCTUnwrap(launch.mark("markReady", Self.t0 + 1500))
        try SignalsTests.assertGolden("app-start.json", dir, health, session.admit([start]))
    }
}
