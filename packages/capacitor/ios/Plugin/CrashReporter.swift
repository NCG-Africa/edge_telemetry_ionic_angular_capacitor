import Foundation
import CrashReporter // PLCrashReporter — declared in the podspec.

/// Wraps PLCrashReporter for:
///  - signal-grade crash capture (SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT)
///  - uncaught Obj-C exceptions (NSException)
///  - uncaught Swift errors that surface as NSException at the runtime boundary
///
/// On install:
///  1. If a crash report from the previous session exists on disk, parse it,
///     serialize to our pending-crashes JSON file, and purge the PLCR record.
///  2. Enable PLCrashReporter so future crashes are caught.
///
/// `fetchPending()` returns the array of pending crash dictionaries; `markHandled(ids:)`
/// deletes the consumed ones.
final class CrashReporter {

    static let shared = CrashReporter()
    private init() {}

    private let pendingFileName = "pending-crashes.json"
    private let lastScreenKey = "edgerum.lastScreen"
    private let queue = DispatchQueue(label: "com.nathanclaire.rum.crash-reporter")

    private var cacheDir: URL? {
        let fm = FileManager.default
        guard let base = try? fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else {
            return nil
        }
        let dir = base.appendingPathComponent("edge-rum", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private var pendingFileUrl: URL? {
        cacheDir?.appendingPathComponent(pendingFileName)
    }

    /// Returns the screen most recently set by the JS bridge — empty string if unknown.
    /// Stored in UserDefaults so the signal handler can read it without touching the
    /// file system from an async-signal-unsafe context.
    func setLastScreen(_ screen: String) {
        UserDefaults.standard.set(screen, forKey: lastScreenKey)
    }

    private var lastScreen: String {
        UserDefaults.standard.string(forKey: lastScreenKey) ?? ""
    }

    func install() throws {
        // `.none` ships raw addresses in the crash record and relies on the
        // backend to symbolicate from uploaded dSYMs — the standard pattern
        // for production crash SDKs (Sentry / Crashlytics / Datadog all do
        // this). Avoids the crash-time cost of in-process symbol-table walks
        // and keeps the dump small. Records carry `crash.symbolication:
        // "required"` so the backend knows the addresses need mapping.
        let config = PLCrashReporterConfig(signalHandlerType: .BSD, symbolicationStrategy: [])  // [] = PLCrashReporterSymbolicationStrategyNone (NS_OPTIONS, value 0)
        guard let reporter = PLCrashReporter(configuration: config) else {
            throw NSError(domain: "EdgeRumCrash", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "PLCrashReporter(configuration:) returned nil"])
        }

        if reporter.hasPendingCrashReport(),
           let data = try? reporter.loadPendingCrashReportDataAndReturnError() {
            if let record = parseCrashReport(data: data) {
                appendPending(record: record)
            }
            reporter.purgePendingCrashReport()
        }

        // Modern PLCrashReporter (SPM 1.11+) renames `-enableCrashReporterAndReturnError:`
        // to a throwing `enable()` in the Swift bridge.
        try reporter.enable()
    }

    func fetchPending() -> [[String: Any]] {
        var result: [[String: Any]] = []
        queue.sync {
            guard let url = pendingFileUrl,
                  let data = try? Data(contentsOf: url),
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                return
            }
            result = arr
        }
        return result
    }

    func markHandled(ids: [String]) {
        queue.sync {
            guard let url = pendingFileUrl else { return }
            let existing: [[String: Any]] = {
                guard let data = try? Data(contentsOf: url),
                      let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                    return []
                }
                return arr
            }()
            let idSet = Set(ids)
            let remaining = existing.filter { record in
                guard let id = record["id"] as? String else { return true }
                return !idSet.contains(id)
            }
            if remaining.isEmpty {
                try? FileManager.default.removeItem(at: url)
            } else if let data = try? JSONSerialization.data(withJSONObject: remaining, options: []) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    private func appendPending(record: [String: Any]) {
        queue.sync {
            guard let url = pendingFileUrl else { return }
            var arr: [[String: Any]] = {
                guard let data = try? Data(contentsOf: url),
                      let existing = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                    return []
                }
                return existing
            }()
            arr.append(record)
            if let out = try? JSONSerialization.data(withJSONObject: arr, options: []) {
                try? out.write(to: url, options: .atomic)
            }
        }
    }

    private func parseCrashReport(data: Data) -> [String: Any]? {
        guard let report = try? PLCrashReport(data: data) else { return nil }
        // `PLCrashReportTextFormatiOS` is the bare C-typedef enum case; Swift
        // does not strip the type prefix for non-NS_ENUM C enums.
        let textual = PLCrashReportTextFormatter.stringValue(for: report, with: PLCrashReportTextFormatiOS) ?? ""

        var exceptionType = "Unknown"
        var message = ""
        var signalName: String?

        if let exc = report.exceptionInfo {
            exceptionType = exc.exceptionName ?? "NSException"
            message = exc.exceptionReason ?? ""
        } else if let sig = report.signalInfo {
            exceptionType = sig.name ?? "Signal"
            signalName = sig.name
            message = "Mach signal \(sig.name ?? "?") at 0x\(String(sig.address, radix: 16))"
        }

        let osVersion = report.systemInfo?.operatingSystemVersion ?? ""
        let crashTimestamp = report.systemInfo?.timestamp ?? Date()
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var record: [String: Any] = [
            "id": UUID().uuidString,
            "ts": isoFormatter.string(from: crashTimestamp),
            "cause": "NativeCrash",
            "exception_type": exceptionType,
            "message": message,
            "stacktrace": textual,
            "is_fatal": true,
            "handled": false,
            "runtime": "native",
            "error_context": "screen:" + lastScreen,
            "platform": "ios",
            "platform_version": osVersion,
            "thread": "main",
            "symbolication": "required"
        ]
        if let s = signalName {
            record["signal"] = s
        }
        return record
    }

    /// Public for HangDetector to write its own records through the same persistence path.
    func writeHangRecord(stacktrace: String, durationMs: Int) {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let record: [String: Any] = [
            "id": UUID().uuidString,
            "ts": isoFormatter.string(from: Date()),
            "cause": "Hang",
            "exception_type": "MainThreadHang",
            "message": "Main thread blocked for \(durationMs)ms",
            "stacktrace": stacktrace,
            "is_fatal": false,
            "handled": true,
            "runtime": "native",
            "error_context": "screen:" + lastScreen,
            "platform": "ios",
            "platform_version": ProcessInfo.processInfo.operatingSystemVersionString,
            "thread": "main"
        ]
        appendPending(record: record)
    }
}
