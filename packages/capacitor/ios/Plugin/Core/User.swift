import Foundation

/// Spec P7 (= Android `User`): `identify()` traits, persisted until `clearUser()`. Worker queue only.
final class User {
    static let key = "edge_rum_capacitor.user"
    private static let traits = ["name", "email", "phone"]

    private let defaults: UserDefaults
    private let clock: () -> Int64
    private var user: [String: String]

    init(defaults: UserDefaults, clock: @escaping () -> Int64 = Outbox.now) {
        self.defaults = defaults
        self.clock = clock
        user = defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:]
    }

    var id: String? { user["id"] }

    /// Merges the given non-blank string keys. Returns one `user.profile.update` event when name,
    /// email or phone changed, else nil.
    func identify(_ given: [String: Any]) -> [String: Any]? {
        var traitsChanged = false
        for k in ["id"] + Self.traits {
            guard let v = given[k] as? String, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if k != "id" && v != user[k] { traitsChanged = true }
            user[k] = v
        }
        defaults.set(user, forKey: Self.key)
        guard traitsChanged else { return nil }
        var attrs: [String: Any] = [:]
        if let id { attrs["user.id"] = id }
        for k in Self.traits { if let v = user[k] { attrs["user." + k] = v } }
        return ["type": "event", "eventName": "user.profile.update", "timestamp": Sender.rfc3339(clock()), "attributes": attrs]
    }

    func clear() {
        user = [:]
        defaults.removeObject(forKey: Self.key)
    }
}
