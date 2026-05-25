package com.nathanclaire.rum

import android.os.Build
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Hooks `Thread.setDefaultUncaughtExceptionHandler` to capture uncaught Java/Kotlin
 * exceptions, write a CrashRecord to disk, and chain to the existing handler so the
 * OS still shows the crash dialog / kills the process.
 *
 * Idempotent: install() can be called multiple times without re-chaining.
 */
object JvmCrashHandler {

    @Volatile private var installed = false

    fun install(storage: CrashRecordStorage, lastScreenProvider: () -> String) {
        if (installed) return
        installed = true

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val record = buildRecord(thread, throwable, lastScreenProvider())
                storage.writeJvmRecord(record)
            } catch (_: Throwable) {
                // best-effort — process is dying anyway
            }
            // Chain so the OS still gets a crash event.
            previous?.uncaughtException(thread, throwable)
        }
    }

    private fun buildRecord(thread: Thread, throwable: Throwable, lastScreen: String): CrashRecord {
        val sw = StringWriter()
        throwable.printStackTrace(PrintWriter(sw))
        val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        df.timeZone = TimeZone.getTimeZone("UTC")
        return CrashRecord(
            id = CrashRecordStorage.newId(),
            ts = df.format(Date()),
            cause = "NativeCrash",
            exceptionType = throwable.javaClass.name,
            message = throwable.message ?: "",
            stacktrace = sw.toString(),
            isFatal = true,
            handled = false,
            errorContext = "screen:$lastScreen",
            platform = "android",
            platformVersion = Build.VERSION.RELEASE ?: "",
            thread = thread.name,
        )
    }
}
