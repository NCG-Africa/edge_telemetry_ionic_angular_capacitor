import Foundation

/// Spec P7 (= Android `Consent`): the enabled state and what `enable()`, `disable()` and `reset()`
/// do to stored data. Worker queue only.
final class Consent {
    static let key = "edge_rum_capacitor.enabled"

    private let defaults: UserDefaults
    private let session: Session
    private let user: User
    private let outbox: Outbox
    private let deviceId: DeviceId
    private(set) var enabled: Bool

    /// `configEnabled` is C1 `enabled`; a persisted `enable()`/`disable()` overrides it.
    init(defaults: UserDefaults, configEnabled: Bool, session: Session, user: User, outbox: Outbox, deviceId: DeviceId) {
        self.defaults = defaults
        self.session = session
        self.user = user
        self.outbox = outbox
        self.deviceId = deviceId
        enabled = defaults.object(forKey: Self.key) as? Bool ?? configEnabled
    }

    /// Persisted. Enabling begins a session (bookends returned to append); disabling forgets the
    /// session and deletes the unsent outbox and the user's traits.
    func setEnabled(_ on: Bool) -> [String] {
        defaults.set(on, forKey: Self.key)
        guard on != enabled else { return [] }
        enabled = on
        if on { return session.begin() }
        session.end()
        wipe()
        return []
    }

    /// Clears user and outbox and rotates device_id; the caller starts the new session. Returns the new device_id.
    func reset() -> String {
        wipe()
        return deviceId.rotate()
    }

    /// Unsent events and the user's traits.
    private func wipe() {
        outbox.clear()
        user.clear()
    }
}
