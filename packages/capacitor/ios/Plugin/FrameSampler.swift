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

/// CADisplayLink-driven frame sampler. Records the time between successive
/// `display` callbacks; emits a sample when the interval exceeds the slow
/// threshold (or always, when captureAllFrames is on).
///
/// Build/raster split: CADisplayLink only surfaces the display-refresh tick,
/// not a sub-frame CPU/GPU breakdown. For iOS we send the full interval as
/// `build_ms` and `0` as `raster_ms` — matching the Android < API 24 fallback
/// — rather than fabricating a split. This honours the wire-contract
/// requirement that both fields are numbers, never null.
final class FrameSampler: NSObject {

    static let shared = FrameSampler()
    private override init() {}

    struct Sample {
        let ts: String
        let totalMs: Double
        let buildMs: Double
        let rasterMs: Double
        let dropped: Bool
        let type: String
    }

    private let queue = DispatchQueue(label: "com.nathanclaire.rum.frame-sampler", qos: .utility)
    private var displayLink: CADisplayLink?
    private var samples: [Sample] = []
    private var lastTimestamp: CFTimeInterval = -1
    private var slowThresholdMs: Double = 16.67
    private var captureAll: Bool = false
    private var started: Bool = false

    // Cap so a pathological dropped-frame storm can't grow unbounded.
    private let maxSamples = 240

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func start(slowThresholdMs: Double, captureAllFrames: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.started { return }
            self.slowThresholdMs = slowThresholdMs
            self.captureAll = captureAllFrames
            self.lastTimestamp = -1
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
            self.displayLink?.invalidate()
            self.displayLink = nil
            NotificationCenter.default.removeObserver(self)
            self.started = false
        }
    }

    func fetchPending() -> [[String: Any]] {
        return queue.sync {
            let pending = samples
            samples.removeAll(keepingCapacity: true)
            return pending.map { s -> [String: Any] in
                return [
                    "ts": s.ts,
                    "total_ms": s.totalMs,
                    "build_ms": s.buildMs,
                    "raster_ms": s.rasterMs,
                    "dropped": s.dropped,
                    "type": s.type,
                ]
            }
        }
    }

    // MARK: - Private

    @objc private func onFrame(link: CADisplayLink) {
        let ts = link.timestamp
        defer { lastTimestamp = ts }
        if lastTimestamp < 0 { return }

        let totalMs = (ts - lastTimestamp) * 1000.0
        if totalMs <= 0 { return }
        if !captureAll && totalMs < slowThresholdMs { return }

        let dropped = totalMs >= slowThresholdMs * 2.0
        let sample = Sample(
            ts: Self.iso8601.string(from: Date()),
            totalMs: totalMs,
            buildMs: totalMs,
            rasterMs: 0,
            dropped: dropped,
            type: "ui"
        )

        queue.async { [weak self] in
            guard let self = self else { return }
            self.samples.append(sample)
            if self.samples.count > self.maxSamples {
                self.samples.removeFirst(self.samples.count - self.maxSamples)
            }
        }
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
            self?.displayLink?.isPaused = true
            self?.lastTimestamp = -1
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

