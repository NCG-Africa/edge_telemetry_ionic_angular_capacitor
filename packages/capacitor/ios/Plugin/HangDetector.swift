import Foundation

/// Detects main-thread hangs by posting a heartbeat to the main queue every second.
/// If the heartbeat doesn't run within `timeoutMs`, captures the current main-thread
/// backtrace and writes a Hang record via `CrashReporter`.
///
/// NOTE: only watches while the app is foregrounded. Background-task hangs require
/// `BGTaskScheduler` integration — out of scope for this iteration.
final class HangDetector {

    static let shared = HangDetector()
    private init() {}

    private var watchdogTimer: DispatchSourceTimer?
    private let watchdogQueue = DispatchQueue(label: "com.nathanclaire.rum.hang-detector", qos: .utility)
    private var lastHeartbeat = Date()
    private var pendingHeartbeat = false
    private var timeoutMs: Int = 5000

    func start(timeoutMs: Int) {
        stop()
        self.timeoutMs = timeoutMs
        lastHeartbeat = Date()
        let timer = DispatchSource.makeTimerSource(queue: watchdogQueue)
        timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            self?.tick()
        }
        timer.resume()
        watchdogTimer = timer

        // Register lifecycle observers so we don't fire false positives while backgrounded.
        NotificationCenter.default.addObserver(self, selector: #selector(onBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    func stop() {
        watchdogTimer?.cancel()
        watchdogTimer = nil
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onBackground() {
        watchdogTimer?.suspend()
    }

    @objc private func onForeground() {
        lastHeartbeat = Date()
        pendingHeartbeat = false
        watchdogTimer?.resume()
    }

    private func tick() {
        if pendingHeartbeat {
            // Previous heartbeat hasn't been picked up by the main queue.
            let elapsedMs = Int(Date().timeIntervalSince(lastHeartbeat) * 1000)
            if elapsedMs >= timeoutMs {
                let stacktrace = Thread.callStackSymbols.joined(separator: "\n")
                CrashReporter.shared.writeHangRecord(stacktrace: stacktrace, durationMs: elapsedMs)
                // Reset so we don't spam — wait for the main queue to catch up.
                pendingHeartbeat = false
                lastHeartbeat = Date()
            }
            return
        }
        pendingHeartbeat = true
        let scheduledAt = Date()
        DispatchQueue.main.async { [weak self] in
            self?.lastHeartbeat = scheduledAt
            self?.pendingHeartbeat = false
        }
    }
}

#if canImport(UIKit)
import UIKit
#endif
