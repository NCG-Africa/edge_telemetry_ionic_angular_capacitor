package com.nathanclaire.rum

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Main-thread ANR watchdog. Posts a heartbeat to the main Looper every
 * `timeoutMs / 2`. If the heartbeat isn't picked up within `timeoutMs`, captures
 * the current main-thread stack and writes an ANR record.
 *
 * Lightweight by design — only one background thread, no allocations in the
 * hot path while the main thread is responsive.
 */
object AnrWatchdog {

    @Volatile private var thread: Thread? = null
    private val running = AtomicBoolean(false)

    fun start(storage: CrashRecordStorage, timeoutMs: Int, lastScreenProvider: () -> String) {
        if (running.getAndSet(true)) return
        val mainHandler = Handler(Looper.getMainLooper())
        val interval = (timeoutMs / 2).coerceAtLeast(500)
        val t = Thread({
            while (running.get()) {
                val ticked = AtomicBoolean(false)
                val postedAt = SystemClock.uptimeMillis()
                mainHandler.post { ticked.set(true) }
                try {
                    Thread.sleep(timeoutMs.toLong())
                } catch (_: InterruptedException) {
                    return@Thread
                }
                if (!ticked.get() && running.get()) {
                    val elapsed = SystemClock.uptimeMillis() - postedAt
                    try {
                        val stack = Looper.getMainLooper().thread.stackTrace
                            .joinToString("\n") { "at ${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
                        storage.writeAnrRecord(buildRecord(stack, elapsed, lastScreenProvider()))
                    } catch (_: Throwable) {
                        // best-effort
                    }
                    // Avoid spamming if the main thread is stuck for minutes — wait at least
                    // `timeoutMs` before sampling again.
                    try { Thread.sleep(timeoutMs.toLong()) } catch (_: InterruptedException) { return@Thread }
                }
                // small pause between scans
                try { Thread.sleep(interval.toLong()) } catch (_: InterruptedException) { return@Thread }
            }
        }, "edge-rum-anr-watchdog")
        t.isDaemon = true
        t.start()
        thread = t
    }

    fun stop() {
        running.set(false)
        thread?.interrupt()
        thread = null
    }

    private fun buildRecord(stack: String, durationMs: Long, lastScreen: String): CrashRecord {
        val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        df.timeZone = TimeZone.getTimeZone("UTC")
        return CrashRecord(
            id = CrashRecordStorage.newId(),
            ts = df.format(Date()),
            cause = "ANR",
            exceptionType = "MainThreadHang",
            message = "Main thread blocked for ${durationMs}ms",
            stacktrace = stack,
            isFatal = false,
            handled = true,
            errorContext = "screen:$lastScreen",
            platform = "android",
            platformVersion = Build.VERSION.RELEASE ?: "",
            thread = "main",
            anrDurationMs = durationMs,
        )
    }
}
