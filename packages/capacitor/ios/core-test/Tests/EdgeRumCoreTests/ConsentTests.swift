@testable import EdgeRumCore
import XCTest

final class ConsentTests: XCTestCase {
    var defaults: UserDefaults!
    let suite = "edge_rum_tests_\(UUID().uuidString)"
    var dir: URL!
    var outbox: Outbox!
    var user: User!
    var session: Session!
    var deviceId: DeviceId!

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("edge_rum_\(UUID().uuidString)")
        let health = Health(dir: dir)
        outbox = Outbox(dir: dir, health: health)
        user = User(defaults: defaults)
        deviceId = DeviceId(keychain: DeviceIdTests.FakeKeychain(), defaults: defaults)
        var n = 0
        session = Session(defaults: defaults, health: health, sampleRate: 1, roll: { 0 },
                          newId: { n += 1; return "session_\(n)" }, userId: { [unowned self] in user.id })
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    func consent(_ config: Bool) -> Consent {
        Consent(defaults: defaults, configEnabled: config, session: session, user: user, outbox: outbox, deviceId: deviceId)
    }

    func testOptInModeArmsNothingUntilEnable() {
        let c = consent(false)
        XCTAssertFalse(c.enabled)
        XCTAssertNil(session.id, "no session in opt-in mode")
        XCTAssertTrue(session.admit([event("navigation")]).isEmpty, "nothing admitted")
        XCTAssertEqual(names(c.setEnabled(true)), ["session.started"], "enable starts a session")
        XCTAssertTrue(c.enabled)
        XCTAssertTrue(consent(false).enabled, "persisted over the config")
    }

    func testDisablePersistsOverConfigAndWipesOutboxTraitsAndSession() throws {
        let c = consent(true)
        _ = session.begin()
        _ = user.identify(["id": "u1"])
        try outbox.append(SenderTests.identity, ["{}"])
        outbox.seal()
        try outbox.append(SenderTests.identity, ["{}"])

        XCTAssertTrue(c.setEnabled(false).isEmpty)
        XCTAssertFalse(c.enabled)
        outbox.seal()
        XCTAssertTrue(outbox.sealed().isEmpty)
        XCTAssertNil(User(defaults: defaults).id)
        XCTAssertNil(session.id)
        XCTAssertFalse(consent(true).enabled, "persisted over enabled=true")
    }

    func testRepeatedEnableIsANoOp() {
        let c = consent(true)
        _ = session.begin()
        XCTAssertTrue(c.setEnabled(true).isEmpty)
        XCTAssertEqual(session.id, "session_1")
    }

    func testResetRotatesDeviceIdAndClearsUserAndOutbox() throws {
        let c = consent(true)
        let before = deviceId.resolve()
        _ = user.identify(["id": "u1"])
        try outbox.append(SenderTests.identity, ["{}"])

        let after = c.reset()
        XCTAssertNotEqual(before, after)
        XCTAssertEqual(deviceId.resolve(), after)
        XCTAssertNil(user.id)
        outbox.seal()
        XCTAssertTrue(outbox.sealed().isEmpty)
        XCTAssertTrue(c.enabled, "reset leaves enabled state alone")
    }
}

final class UserTests: XCTestCase {
    var defaults: UserDefaults!
    let suite = "edge_rum_tests_\(UUID().uuidString)"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testIdentifyPersistsAndEmitsProfileUpdateOnlyWhenTraitsChange() throws {
        let user = User(defaults: defaults)
        let update = try XCTUnwrap(user.identify(["id": "u1", "name": "Ann", "email": "a@x.io"]))
        XCTAssertEqual(update["eventName"] as? String, "user.profile.update")
        let a = update["attributes"] as? [String: Any] ?? [:]
        XCTAssertEqual(a.count, 3)
        XCTAssertEqual(a["user.id"] as? String, "u1")
        XCTAssertEqual(a["user.name"] as? String, "Ann")
        XCTAssertEqual(a["user.email"] as? String, "a@x.io")

        let relaunched = User(defaults: defaults)
        XCTAssertEqual(relaunched.id, "u1")
        XCTAssertNil(relaunched.identify(["id": "u1", "name": "Ann"]), "same traits: no update")
        XCTAssertNil(relaunched.identify(["id": "u2"]), "id-only change: no update")
        XCTAssertEqual(relaunched.id, "u2")
        let phone = try XCTUnwrap(relaunched.identify(["phone": "+254700000000"]))["attributes"] as? [String: Any] ?? [:]
        XCTAssertEqual(phone["user.phone"] as? String, "+254700000000")
        XCTAssertEqual(phone["user.name"] as? String, "Ann")
    }

    func testBlankAndNonStringTraitsAreIgnored() {
        let user = User(defaults: defaults)
        XCTAssertNil(user.identify(["id": " ", "name": NSNull(), "email": 4]))
        XCTAssertNil(user.id)
    }

    func testClearForgetsEverything() {
        let user = User(defaults: defaults)
        _ = user.identify(["id": "u1", "name": "Ann"])
        user.clear()
        XCTAssertNil(user.id)
        XCTAssertNil(User(defaults: defaults).id)
        let again = User(defaults: defaults).identify(["name": "Ann"])?["attributes"] as? [String: Any]
        XCTAssertEqual(again?["user.name"] as? String, "Ann", "traits forgotten: same name is a change again")
    }
}
