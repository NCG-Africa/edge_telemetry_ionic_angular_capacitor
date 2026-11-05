import Foundation
import CrashReporter // PLCrashReporter — declared in the podspec and Package.swift.

/// Spec E12, E15, Y3: PLCrashReporter adapter. Arms signal + uncaught NSException capture, reads
/// last launch's report into a `Crash.Report` (Core can't link PLCrashReporter), and walks the
/// main thread for a hang via a live report.
enum CrashReporter {
    /// `[]` = no on-device symbolication: raw addresses, symbolicated from uploaded dSYMs (Y3),
    /// which keeps crash-time work and the record small.
    private static let reporter =
        PLCrashReporter(configuration: PLCrashReporterConfig(signalHandlerType: .BSD, symbolicationStrategy: []))
    /// The main thread's Mach port, so the watchdog thread can walk it; set by `enable`.
    private static var mainThread: thread_t = 0

    /// Once per process; PLCrashReporter's handlers can't be uninstalled. Main thread: the
    /// alternate signal stack (stack overflow) is per thread.
    static func enable() throws {
        mainThread = mach_thread_self()
        guard let reporter else {
            throw NSError(domain: "EdgeRum", code: -1, userInfo: [NSLocalizedDescriptionKey: "PLCrashReporter unavailable"])
        }
        try reporter.enable()
    }

    /// Last launch's crash, if any. PLCrashReporter's record is purged either way.
    static func takePending() -> Crash.Report? {
        guard let reporter, reporter.hasPendingCrashReport() else { return nil }
        defer { reporter.purgePendingCrashReport() }
        guard let data = try? reporter.loadPendingCrashReportDataAndReturnError(),
              let report = try? PLCrashReport(data: data) else { return nil }
        let crashed = (report.threads as? [PLCrashReportThreadInfo] ?? []).first { $0.crashed }
        let at = Int64((report.systemInfo?.timestamp ?? Date()).timeIntervalSince1970 * 1000)
        var r = Crash.Report(at: at)
        // ponytail: PLCrashReporter numbers threads in task order; 0 is main in practice.
        r.thread = crashed?.threadNumber
        if report.hasExceptionInfo, let exc = report.exceptionInfo {
            r.exceptionName = exc.exceptionName ?? "NSException"
            r.exceptionReason = exc.exceptionReason
            // The throw site; the crashed thread only shows the abort.
            r.frames = frames(exc.stackFrames, report)
        } else if let sig = report.signalInfo {
            r.signal = sig.name
            r.signalCode = sig.code
            r.faultAddress = sig.address
        }
        if r.frames.isEmpty { r.frames = frames(crashed?.stackFrames, report) }
        return r
    }

    /// E15: the main thread's frames, read from the watchdog thread; empty when it can't.
    static func mainFrames() -> [Crash.Frame] {
        guard let reporter, mainThread != 0, let data = try? reporter.generateLiveReport(withThread: mainThread),
              let report = try? PLCrashReport(data: data) else { return [] }
        // The walked thread is marked crashed.
        let main = (report.threads as? [PLCrashReportThreadInfo] ?? []).first { $0.crashed }
        return frames(main?.stackFrames, report)
    }

    private static func frames(_ list: [Any]?, _ report: PLCrashReport) -> [Crash.Frame] {
        (list as? [PLCrashReportStackFrameInfo] ?? []).map { f in
            let pc = f.instructionPointer
            let image = report.image(forAddress: pc)
            return Crash.Frame(pc: pc, base: image?.imageBaseAddress ?? 0,
                               uuid: image?.hasImageUUID == true ? image?.imageUUID ?? "" : "",
                               path: image?.imageName ?? "", symbol: f.symbolInfo?.symbolName)
        }
    }
}
