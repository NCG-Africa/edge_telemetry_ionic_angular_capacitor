import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Periodic process-memory sampler. Pulls `mach_task_basic_info.resident_size`
/// every `intervalMs`, plus on memory-pressure events. Samples accumulate in an
/// in-memory ring buffer that the JS layer drains via `fetchMemorySamples()`.
///
/// Suspends sampling while backgrounded — RSS is meaningless once the app is
/// frozen, and we don't want stale samples blocking the foreground baseline.
final class MemorySampler {

    static let shared = MemorySampler()
    private init() {}

    struct Sample {
        let ts: String
        let valueMb: Double
        let pressure: String?
        let type: String
        let source: String
    }

    private let queue = DispatchQueue(label: "com.nathanclaire.rum.memory-sampler", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var pressureSource: DispatchSourceMemoryPressure?
    private var samples: [Sample] = []
    private var intervalMs: Int = 10_000
    private var lastPressure: String = "normal"
    private var started: Bool = false

    // Cap the buffer at ~10 minutes worth at the default cadence so a long
    // network outage can't grow it unbounded. JS drains every flush tick.
    private let maxSamples = 60

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func start(intervalMs: Int) {
        queue.async { [weak self] in
            guard let self = self else { return }
            if self.started { return }
            self.intervalMs = max(1000, intervalMs)
            self.armPressureSource()
            self.armTimer()
            self.registerLifecycle()
            self.started = true
            // First sample so the JS layer sees a baseline before the first interval.
            self.sampleLocked(reason: "start")
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.timer?.cancel()
            self.timer = nil
            self.pressureSource?.cancel()
            self.pressureSource = nil
            NotificationCenter.default.removeObserver(self)
            self.started = false
        }
    }

    /// Drain and return all pending samples as a JSON-serializable array.
    func fetchPending() -> [[String: Any]] {
        return queue.sync {
            let pending = samples
            samples.removeAll(keepingCapacity: true)
            return pending.map { s -> [String: Any] in
                var dict: [String: Any] = [
                    "ts": s.ts,
                    "value_mb": s.valueMb,
                    "type": s.type,
                    "source": s.source,
                ]
                if let p = s.pressure { dict["pressure"] = p }
                return dict
            }
        }
    }

    /// Force an immediate sample — used on foreground/background transitions
    /// driven from the JS lifecycle hook.
    func sampleNow() {
        queue.async { [weak self] in
            self?.sampleLocked(reason: "manual")
        }
    }

    // MARK: - Private

    private func armTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        let intervalNs = UInt64(intervalMs) * NSEC_PER_MSEC
        t.schedule(deadline: .now() + .milliseconds(intervalMs),
                   repeating: .nanoseconds(Int(intervalNs)))
        t.setEventHandler { [weak self] in
            self?.sampleLocked(reason: "tick")
        }
        t.resume()
        timer = t
    }

    private func armPressureSource() {
        let mask: DispatchSource.MemoryPressureEvent = [.normal, .warning, .critical]
        let source = DispatchSource.makeMemoryPressureSource(eventMask: mask, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            let evt = source.data
            if evt.contains(.critical) {
                self.lastPressure = "critical"
            } else if evt.contains(.warning) {
                self.lastPressure = "moderate"
            } else if evt.contains(.normal) {
                self.lastPressure = "normal"
            }
            self.sampleLocked(reason: "pressure")
        }
        source.resume()
        pressureSource = source
    }

    private func registerLifecycle() {
        #if canImport(UIKit)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        #endif
    }

    @objc private func onBackground() {
        queue.async { [weak self] in
            self?.timer?.suspend()
        }
    }

    @objc private func onForeground() {
        queue.async { [weak self] in
            self?.timer?.resume()
        }
    }

    private func sampleLocked(reason: String) {
        _ = reason // reserved for future debug logging
        let mb = currentResidentMB()
        if mb < 0 { return }
        let sample = Sample(
            ts: Self.iso8601.string(from: Date()),
            valueMb: mb,
            pressure: lastPressure.isEmpty ? nil : lastPressure,
            type: "rss",
            source: "native"
        )
        samples.append(sample)
        if samples.count > maxSamples {
            samples.removeFirst(samples.count - maxSamples)
        }
    }

    /// Reads RSS via mach task info. Returns megabytes, or -1 if the syscall fails.
    private func currentResidentMB() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
        let kerr: kern_return_t = withUnsafeMutablePointer(to: &info) { infoPtr in
            infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { ptr in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), ptr, &count)
            }
        }
        if kerr != KERN_SUCCESS { return -1 }
        return Double(info.resident_size) / (1024.0 * 1024.0)
    }
}
