package com.nathanclaire.rum

import com.getcapacitor.JSObject
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/**
 * Single source of truth for crash persistence on Android.
 *
 * Files live under `<cacheDir>/edge-rum/`:
 *  - `jvm/<id>.json`        — one file per Throwable
 *  - `anr/<id>.json`        — one file per ANR
 *  - `ndk-records.bin`      — append-only binary log written by the signal handler
 *
 * The signal-handler writes happen async-signal-safely (write(2) syscall only),
 * so the NDK log uses a fixed-width record format the Kotlin side decodes on next launch.
 */
class CrashRecordStorage(cacheDir: File) {

    private val baseDir = File(cacheDir, "edge-rum").apply { mkdirs() }
    private val jvmDir = File(baseDir, "jvm").apply { mkdirs() }
    private val anrDir = File(baseDir, "anr").apply { mkdirs() }
    val ndkRecordFile: File = File(baseDir, "ndk-records.bin")

    private val lastScreen = AtomicReference("")

    fun setLastScreen(screen: String) {
        lastScreen.set(screen)
    }

    fun getLastScreen(): String = lastScreen.get() ?: ""

    fun writeJvmRecord(record: CrashRecord) = writeRecord(jvmDir, record)
    fun writeAnrRecord(record: CrashRecord) = writeRecord(anrDir, record)

    fun readJvmCrashes(): List<CrashRecord> = readDir(jvmDir)
    fun readAnrCrashes(): List<CrashRecord> = readDir(anrDir)

    fun deleteByIds(ids: List<String>) {
        if (ids.isEmpty()) return
        val idSet = ids.toSet()
        for (dir in listOf(jvmDir, anrDir)) {
            dir.listFiles()?.forEach { file ->
                val id = file.nameWithoutExtension
                if (idSet.contains(id)) file.delete()
            }
        }
        // NDK records are consumed wholesale by NativeCrashBridge.fetchPendingNdk;
        // it truncates the file after returning the parsed records.
    }

    private fun writeRecord(dir: File, record: CrashRecord) {
        val out = File(dir, "${record.id}.json")
        try {
            out.writeText(record.toJson().toString())
        } catch (_: Throwable) {
            // best-effort — the process is dying.
        }
    }

    private fun readDir(dir: File): List<CrashRecord> {
        val files = dir.listFiles() ?: return emptyList()
        val out = mutableListOf<CrashRecord>()
        for (file in files) {
            try {
                val text = file.readText()
                val json = JSONObject(text)
                out.add(CrashRecord.fromJson(json))
            } catch (_: Throwable) {
                // Discard unreadable records — they'd block the queue otherwise.
                file.delete()
            }
        }
        return out
    }

    companion object {
        fun newId(): String = UUID.randomUUID().toString()
    }
}

data class CrashRecord(
    val id: String,
    val ts: String,
    val cause: String,
    val exceptionType: String,
    val message: String,
    val stacktrace: String,
    val isFatal: Boolean,
    val handled: Boolean,
    val errorContext: String,
    val platform: String = "android",
    val platformVersion: String,
    val signal: String? = null,
    val thread: String? = null,
    val symbolication: String? = null,
    val anrDurationMs: Long? = null,
) {
    fun toJson(): JSObject {
        val o = JSObject()
        o.put("id", id)
        o.put("ts", ts)
        o.put("cause", cause)
        o.put("exception_type", exceptionType)
        o.put("message", message)
        o.put("stacktrace", stacktrace)
        o.put("is_fatal", isFatal)
        o.put("handled", handled)
        o.put("runtime", "native")
        o.put("error_context", errorContext)
        o.put("platform", platform)
        o.put("platform_version", platformVersion)
        signal?.let { o.put("signal", it) }
        thread?.let { o.put("thread", it) }
        symbolication?.let { o.put("symbolication", it) }
        anrDurationMs?.let { o.put("anr.duration_ms", it) }
        return o
    }

    companion object {
        fun fromJson(json: JSONObject): CrashRecord = CrashRecord(
            id = json.getString("id"),
            ts = json.getString("ts"),
            cause = json.getString("cause"),
            exceptionType = json.getString("exception_type"),
            message = json.optString("message", ""),
            stacktrace = json.optString("stacktrace", ""),
            isFatal = json.optBoolean("is_fatal", true),
            handled = json.optBoolean("handled", false),
            errorContext = json.optString("error_context", ""),
            platform = json.optString("platform", "android"),
            platformVersion = json.optString("platform_version", ""),
            signal = json.optString("signal").takeIf { it.isNotEmpty() },
            thread = json.optString("thread").takeIf { it.isNotEmpty() },
            symbolication = json.optString("symbolication").takeIf { it.isNotEmpty() },
            anrDurationMs = if (json.has("anr.duration_ms")) json.getLong("anr.duration_ms") else null,
        )
    }
}
