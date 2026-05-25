package com.nathanclaire.rum

import android.os.Build
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * JNI loader + decoder for NDK signal-handler records.
 *
 * The signal handler (native-crash.cpp) writes fixed-format binary records to the
 * configured file descriptor using `write(2)` only — no malloc, no Java callbacks.
 * On next launch, this class reads the file, decodes records, and returns them as
 * CrashRecord objects.
 *
 * Record format (per crash, fixed 1KB ceiling):
 *   uint32  magic   = 0xED9E51DE
 *   uint32  signal
 *   uint64  fault_address
 *   uint64  ts_millis
 *   uint16  frame_count
 *   uint64  frames[frame_count]    (up to 32)
 *   uint32  marker  = 0xEEEEEEEE   (end-of-record)
 *
 * If the marker is missing the record is treated as partial and skipped.
 */
object NativeCrashBridge {

    @Volatile private var installed = false
    @Volatile private var ndkRecordPath: String = ""

    init {
        try {
            System.loadLibrary("edge-rum-native")
        } catch (_: UnsatisfiedLinkError) {
            // NDK module unavailable — ANR + JVM still work; signal capture is degraded.
        }
    }

    fun install(recordFilePath: String, @Suppress("UNUSED_PARAMETER") lastScreenProvider: () -> String) {
        if (installed) return
        installed = true
        ndkRecordPath = recordFilePath
        try {
            nativeInstall(recordFilePath)
        } catch (_: Throwable) {
            // signal handler install failed; continue with degraded coverage
        }
    }

    fun fetchPendingNdk(storage: CrashRecordStorage): List<CrashRecord> {
        val file = storage.ndkRecordFile
        if (!file.exists() || file.length() == 0L) return emptyList()
        val records = mutableListOf<CrashRecord>()
        try {
            RandomAccessFile(file, "r").use { raf ->
                while (raf.filePointer < raf.length()) {
                    val rec = readRecord(raf) ?: break
                    records.add(rec.toCrashRecord(lastScreen = storage.getLastScreen()))
                }
            }
            // Records consumed — truncate atomically.
            File(file.absolutePath).delete()
        } catch (_: Throwable) {
            // Treat as unreadable; nuke the file so it can't block subsequent reads.
            try { file.delete() } catch (_: Throwable) {}
        }
        return records
    }

    private fun readRecord(raf: RandomAccessFile): RawRecord? {
        if (raf.length() - raf.filePointer < 32) return null
        val magic = raf.readInt()
        if (magic != MAGIC.toInt()) return null
        val signal = raf.readInt()
        val faultAddr = raf.readLong()
        val tsMillis = raf.readLong()
        val frameCount = raf.readUnsignedShort()
        if (frameCount > 64) return null
        val frames = LongArray(frameCount)
        for (i in 0 until frameCount) frames[i] = raf.readLong()
        if (raf.length() - raf.filePointer < 4) return null
        val marker = raf.readInt()
        if (marker != END_MARKER.toInt()) return null
        return RawRecord(signal, faultAddr, tsMillis, frames)
    }

    private external fun nativeInstall(recordFilePath: String): Boolean

    private const val MAGIC: Long = 0xED9E51DE
    private const val END_MARKER: Long = 0xEEEEEEEE

    private data class RawRecord(val signal: Int, val faultAddress: Long, val tsMillis: Long, val frames: LongArray) {
        fun toCrashRecord(lastScreen: String): CrashRecord {
            val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            df.timeZone = TimeZone.getTimeZone("UTC")
            val stack = frames.joinToString("\n") { "0x" + it.toString(16) }
            return CrashRecord(
                id = CrashRecordStorage.newId(),
                ts = df.format(Date(tsMillis)),
                cause = "NativeCrash",
                exceptionType = signalToName(signal),
                message = "Signal ${signalToName(signal)} at 0x${faultAddress.toString(16)}",
                stacktrace = stack,
                isFatal = true,
                handled = false,
                errorContext = "screen:$lastScreen",
                platform = "android",
                platformVersion = Build.VERSION.RELEASE ?: "",
                signal = signalToName(signal),
                thread = "unknown",
                symbolication = "required",
            )
        }

        private fun signalToName(sig: Int): String = when (sig) {
            4 -> "SIGILL"
            6 -> "SIGABRT"
            7 -> "SIGBUS"
            8 -> "SIGFPE"
            11 -> "SIGSEGV"
            else -> "SIG_$sig"
        }
    }
}
