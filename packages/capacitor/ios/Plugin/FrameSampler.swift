import Foundation
import QuartzCore
#if canImport(UIKit)
import UIKit
#endif

// CADisplayLink is unavailable on macOS. This package only targets iOS / tvOS
// / Mac Catalyst, but SourceKit indexes the file across all platforms and
// flags the unavailable initializer — gate the entire sampler so non-iOS
// targets see only an empty no-op stub.
#if os(iOS) || os(tvOS) || targetEnvironment(macCatalyst)

/// CADisplayLink-driven frame sampler. Measures the interval between successive
/// `display` callbacks and aggregates them into one windowed summary per screen
/// (ADR-030), byte-compatible with the web `registerFrameCapture` shape so the
/// EdgeTelemetryProcessor buckets iOS and web frames identically.
///
/// A window closes on a screen change (the JS route relayed via
/// `setLastScreen`), a 30s cap, backgrounding, or `stop()`. Windows with no
/// slow frame are suppressed — a smooth screen sends nothing. `fetchPending()`
/// returns the summaries accumulated since the last drain; `value` = window p95.
final class FrameSampler: NSObject {

    static let shared = FrameSampler()
    private override init() {}

    private let queue = DispatchQueue(label: "com.nathanclaire.rum.frame-sampler", qos: .utility)
    private var displayLink: CADisplayLink?
    private var slowThresholdMs: Double = 16.67
    private var started: Bool = false

    // A window force-closes after this long so a screen held for minutes yields
    // several summaries instead of one coarse blob (mirrors web MAX_WINDOW_MS).
    private let maxWindowMs: Double = 30_000
    // Two consecutive missed vsyncs at the slow threshold marks a "dropped" frame.
    private let dropMultiplier: Double = 2

    // Shared with CrashReporter — the JS side relays the current route here via
    // setLastScreen. Reading it lets a route change close the frame window,
    // mirroring the web getCurrentRoute() boundary without new native plumbing.
    private let lastScreenKey = "edgerum.lastScreen"

    // In-window accumulator state — touched only on the main thread (CADisplayLink
    // fires on the main runloop), so it needs no lock.
    private var durations: [Double] = []
    private var windowRoute: String = ""
    private var windowStart: CFTimeInterval = -1
    private var lastTimestamp: CFTimeInterval = -1

    // Closed-window summaries awaiting drain — crosses the main→queue boundary,
    // so it is only ever touched inside `queue`.
    private var pendingSummaries: [[String: Any]] = []

    func start(slowThresholdMs: Double, captureAllFrames: Bool) {
        // captureAllFrames is retained for bridge-signature compatibility but no
        // longer gates anything: the windowed summary needs every frame interval
        // (frames_total is the jank-ratio denominator, p50/p95 span all frames).
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.started { return }
            self.slowThresholdMs = slowThresholdMs
            self.lastTimestamp = -1
            self.resetWindow()
            let link = CADisplayLink(target: self, selector: #selector(self.onFrame(link:)))
            link.add(to: .main, forMode: .common)
            self.displayLink = link
            self.registerLifecycle()
            self.started = true
        }
    }

    func stop() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.flushWindow(endTimestamp: self.lastTimestamp)
            self.displayLink?.invalidate()
            self.displayLink = nil
            NotificationCenter.default.removeObserver(self)
            self.started = false
        }
    }

    func fetchPending() -> [[String: Any]] {
        return queue.sync {
            let pending = pendingSummaries
            pendingSummaries.removeAll(keepingCapacity: true)
            return pending
        }
    }

    // MARK: - Private

    @objc private func onFrame(link: CADisplayLink) {
        let ts = link.timestamp
        let prev = lastTimestamp
        lastTimestamp = ts
        if prev < 0 { return }

        let total = (ts - prev) * 1000.0
        if total <= 0 { return }

        let route = currentScreen()
        // Close the current window before appending when the screen changed or
        // the time cap is hit; the straddling frame opens the fresh window.
        if !durations.isEmpty && (route != windowRoute || (ts - windowStart) * 1000.0 >= maxWindowMs) {
            flushWindow(endTimestamp: prev)
        }
        if durations.isEmpty {
            windowRoute = route
            windowStart = prev
        }
        durations.append(total)
    }

    // Emit one summary for the closing window, then reset. Suppressed entirely
    // when the window is empty or no slow frame occurred — the volume cut.
    private func flushWindow(endTimestamp: CFTimeInterval) {
        let ds = durations
        let start = windowStart
        let route = windowRoute
        resetWindow()

        if ds.isEmpty { return }
        var slow = 0
        var dropped = 0
        for d in ds {
            if d >= slowThresholdMs { slow += 1 }
            if d >= slowThresholdMs * dropMultiplier { dropped += 1 }
        }
        if slow == 0 { return }

        let sorted = ds.sorted()
        let p95 = percentile(sorted, 0.95)
        let summary: [String: Any] = [
            "value": p95,
            "frames_total": ds.count,
            "slow_frames": slow,
            "dropped_frames": dropped,
            "p50_ms": percentile(sorted, 0.5),
            "p95_ms": p95,
            "worst_ms": sorted.last ?? 0,
            "window_ms": max(0, (endTimestamp - start) * 1000.0),
            "screen": route,
        ]
        queue.async { [weak self] in
            self?.pendingSummaries.append(summary)
        }
    }

    private func resetWindow() {
        durations.removeAll(keepingCapacity: true)
        windowRoute = ""
        windowStart = -1
    }

    // Nearest-rank percentile over an ascending-sorted array. The window is
    // time-bounded (≤ 30s), so sort-once-on-flush beats a streaming estimator.
    private func percentile(_ sortedAsc: [Double], _ p: Double) -> Double {
        if sortedAsc.isEmpty { return 0 }
        let idx = Int(ceil(p * Double(sortedAsc.count))) - 1
        let clamped = min(sortedAsc.count - 1, max(0, idx))
        return sortedAsc[clamped]
    }

    private func currentScreen() -> String {
        return UserDefaults.standard.string(forKey: lastScreenKey) ?? ""
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
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Backgrounding is a scene change — close the window so its jank
            // isn't merged into whatever screen resumes.
            self.flushWindow(endTimestamp: self.lastTimestamp)
            self.displayLink?.isPaused = true
            self.lastTimestamp = -1
        }
    }

    @objc private func onForeground() {
        DispatchQueue.main.async { [weak self] in
            self?.displayLink?.isPaused = false
        }
    }
}

#else

/// No-op stub for non-iOS targets so the surrounding plugin compiles uniformly.
/// macOS / Linux / SourceKit-indexing only — never runs in production.
final class FrameSampler {
    static let shared = FrameSampler()
    private init() {}
    func start(slowThresholdMs: Double, captureAllFrames: Bool) {}
    func stop() {}
    func fetchPending() -> [[String: Any]] { return [] }
}

#endif
