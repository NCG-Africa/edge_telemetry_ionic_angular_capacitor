import Darwin
import Foundation

/// Spec E2, E22–E24, E26, E32 (= Cordova iOS `Signals`, Android `Signals`): native `app.lifecycle`,
/// `memory.usage`, `memory.pressure` and `network.change` records, on the event catalogue's names
/// (#149). The plugin reads the platform; these only shape it.
enum Signals {
    /// E2: native fg/bg (`foregrounded` / `backgrounded`); JS sends its own `appStateChange` states.
    static func lifecycle(_ state: String, at: Int64) -> [String: Any] {
        Crash.record("app.lifecycle", at, ["lifecycle.state": state])
    }

    /// E22 / E23: one `memory.usage` event. `memory.usage_mb` is `phys_footprint` in MB (the number
    /// jetsam kills on; the catalogue's iOS footprint, processor #33), else RSS when it is missing;
    /// RSS also rides in `memory.resident_kb`. Nil with neither reading.
    static func memory(footprint: Int64?, resident: Int64?, source: String, at: Int64) -> [String: Any]? {
        guard let bytes = footprint ?? resident else { return nil }
        var a: [String: Any] = ["memory.usage_mb": mb(bytes), "memory.type": footprint != nil ? "footprint" : "rss",
                                "memory.source": source]
        if let resident { a["memory.resident_kb"] = resident / 1024 }
        return Crash.record("memory.usage", at, a)
    }

    /// E24: `UIApplicationDidReceiveMemoryWarning` → `memory.pressure`; iOS has one level, the
    /// catalogue's `critical`.
    static func pressure(footprint: Int64?, at: Int64) -> [String: Any] {
        var a: [String: Any] = ["memory.pressure_level": "critical", "memory.source": "memory_warning"]
        if let footprint {
            a["memory.usage_mb"] = mb(footprint)
            a["memory.type"] = "footprint"
        }
        return Crash.record("memory.pressure", at, a)
    }

    /// E26: path transport changed (`wifi` / `cellular` / `ethernet` / `other` / `none`).
    static func network(previous: String, current: String, at: Int64) -> [String: Any] {
        Crash.record("network.change", at, ["network.type": current, "network.previous_type": previous])
    }

    /// E32 / P5: `app.bundle_id` = last segment of Capacitor's `getServerBasePath()`, or `builtin`
    /// when it serves the app bundle's own `public` folder (no live update applied).
    static func bundleId(serverBasePath: String?, appBundlePath: String) -> String {
        guard let path = serverBasePath, !path.isEmpty, !path.hasPrefix(appBundlePath) else { return "builtin" }
        let last = (path as NSString).lastPathComponent
        return last.isEmpty || last == "/" ? "builtin" : last
    }

    /// `TASK_VM_INFO.phys_footprint`, bytes.
    static func footprintBytes() -> Int64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Int64(info.phys_footprint) : nil
    }

    /// `MACH_TASK_BASIC_INFO.resident_size`, bytes.
    static func residentBytes() -> Int64? {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Int64(info.resident_size) : nil
    }

    private static func mb(_ bytes: Int64) -> Double {
        (Double(bytes) / 104_857.6).rounded() / 10
    }
}
