package com.nathanclaire.rum.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.GZIPOutputStream
import org.json.JSONException
import org.json.JSONObject

/**
 * Spec T1 (= Cordova T3, T5, T6), T2, W1 and wire rules R1–R4, R10, R12, R13: drains sealed
 * segments oldest first, one request in flight, each as a gzipped contract-4 envelope.
 */
class Sender(
    private val outbox: Outbox,
    private val health: Health,
    private val sdkVersion: String,
    private val clock: () -> Long = System::currentTimeMillis,
    private val sleeper: (Long) -> Unit = Thread::sleep,
    private val retryMs: LongArray = RETRY_MS,
) {
    /** C1: key and URL travel together, so a send always reads a matching pair. */
    private class Target(val apiKey: String?, val url: String?) {
        fun ready() = apiKey != null && url != null
    }

    private val parkedUntil = HashMap<String, Long>()
    private val executor = Executors.newSingleThreadExecutor()
    private val pending = AtomicBoolean()
    @Volatile private var target = Target(null, null)

    fun shutdown() {
        executor.shutdownNow()
    }

    /**
     * Sets whichever of key / URL is non-blank; the other keeps its value. Segments stay on disk
     * until both are known (C1).
     */
    @Synchronized
    fun configure(apiKey: String?, url: String?) {
        target = Target(orElse(apiKey, target.apiKey), orElse(url, target.url))
    }

    private fun orElse(value: String?, fallback: String?) = value?.trim()?.ifEmpty { null } ?: fallback

    fun configured() = target.ready()

    /** Schedules a drain on the sender thread; triggers while one is queued coalesce. */
    fun trigger() {
        if (!pending.compareAndSet(false, true)) return
        try {
            executor.execute {
                pending.set(false)
                drain()
            }
        } catch (ignored: RejectedExecutionException) {
            // shut down; segments stay on disk for the next process
        }
    }

    /** Sends every sealed segment not inside its park backoff; stops at the first one it parks. */
    fun drain() {
        val t = target
        if (!t.ready()) return
        for (f in outbox.sealed()) {
            val until = parkedUntil[f.name]
            if (until != null && clock() < until) continue
            outbox.sending(f)
            try {
                if (!send(f, t)) return
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } finally {
                outbox.sending(null)
            }
        }
    }

    /** @return false when the segment was parked. */
    private fun send(f: File, t: Target): Boolean {
        val seg = try {
            outbox.read(f)
        } catch (e: IOException) {
            return true // vanished (capped or deleted meanwhile)
        }
        if (seg.identity == null || seg.events.isEmpty()) {
            f.delete()
            return true
        }
        val identity = try {
            JSONObject(seg.identity).also {
                it.getString("device_id")
                it.getJSONObject("app")
            }
        } catch (e: JSONException) {
            f.delete()
            health.count("corrupt", seg.events.size.toLong())
            return true
        }
        // T4: a solo (crash) segment carries no `sdk.health`; the next normal batch does.
        val drops = if (identity.optBoolean("solo")) emptyMap() else health.snapshot()
        val queueDepth = outbox.sealed().size
        var attempt = 0
        while (true) {
            var status: Int
            var retryAfterMs = 0L
            try {
                val body = body(identity, seg.events, drops, queueDepth, clock()).toByteArray(Charsets.UTF_8)
                val c = post(gzip(body), t)
                try {
                    status = c.responseCode
                    retryAfterMs = retryAfterMs(c.getHeaderField("Retry-After"))
                } finally {
                    c.disconnect()
                }
            } catch (e: Exception) {
                if (e is InterruptedException) throw e
                status = -1 // network error, or a body we can't build (retried, then parked)
            }
            val ok = status in 200..299
            // R12: any other 4xx is never retried or queued.
            val rejected = status in 400..499 && status != 429
            if (ok || rejected) {
                f.delete()
                parkedUntil.remove(f.name)
                if (ok) health.subtract(drops) else health.count("rejected", seg.events.size.toLong())
                return true
            }
            // A Retry-After beyond the in-process schedule parks instead of holding the only sender thread.
            if (attempt == retryMs.size || retryAfterMs > retryMs.last()) {
                parkedUntil[f.name] = clock() + maxOf(PARK_MS, retryAfterMs)
                return false
            }
            val base = retryMs[attempt++]
            sleeper(maxOf(base + ThreadLocalRandom.current().nextLong(base / 4 + 1), retryAfterMs))
        }
    }

    private fun post(gzipped: ByteArray, t: Target): HttpURLConnection {
        val c = URL(t.url).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 15_000
        c.readTimeout = 15_000
        c.doOutput = true
        c.setFixedLengthStreamingMode(gzipped.size)
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("Content-Encoding", "gzip")
        c.setRequestProperty("X-API-Key", t.apiKey)
        c.outputStream.use { it.write(gzipped) }
        return c
    }

    /**
     * Contract-4 envelope, closed at 8 keys (R3). Identity is the segment's frozen first line
     * (T4); `sdk` and `contract_version` are current; `timestamp` is this attempt's (R13).
     */
    private fun body(identity: JSONObject, events: List<String>, drops: Map<String, Long>, queueDepth: Int, now: Long): String {
        val timestamp = rfc3339(now)
        val sb = StringBuilder(256 + events.size * 256)
            .append("{\"type\":\"telemetry_batch\",\"contract_version\":\"").append(CONTRACT_VERSION)
            .append("\",\"timestamp\":").append(JSONObject.quote(timestamp))
            .append(",\"batch_size\":").append(events.size + if (drops.isEmpty()) 0 else 1)
            .append(",\"device_id\":").append(JSONObject.quote(identity.getString("device_id")))
            .append(",\"sdk\":{\"name\":\"").append(SDK_NAME).append("\",\"version\":").append(JSONObject.quote(sdkVersion))
            .append("},\"app\":").append(identity.getJSONObject("app"))
            .append(",\"events\":[")
        events.forEachIndexed { i, e ->
            if (i > 0) sb.append(',')
            sb.append(e)
        }
        if (drops.isNotEmpty()) {
            // R4: unprefixed counters, counted in batch_size, stamped at flush time.
            val attrs = JSONObject(drops as Map<*, *>).put("queue_depth", queueDepth)
            val health = JSONObject()
                .put("type", "event")
                .put("eventName", "sdk.health")
                .put("timestamp", timestamp)
                .put("attributes", attrs)
            sb.append(',').append(health)
        }
        return sb.append("]}").toString()
    }

    companion object {
        /** W1. */
        const val SDK_NAME = "ionic"
        const val CONTRACT_VERSION = "4.3.0"
        /** T6: delays before the 3 retries that follow a failed first send. */
        val RETRY_MS = longArrayOf(1_000, 4_000, 16_000)
        /** Backoff of a parked segment; matches the 30 s tick that retries it (T6). */
        const val PARK_MS = 30_000L

        /** W2 (= Cordova W3) + T4: the identity line frozen into each segment; null values omitted (R15). */
        fun identityLine(name: String?, packageName: String?, version: String?, buildNumber: String?, deviceId: String): String {
            val app = JSONObject()
                .put("name", name)
                .put("package_name", packageName)
                .put("platform", "android")
                .put("version", version)
                .put("build_number", buildNumber)
            return JSONObject().put("app", app).put("device_id", deviceId).toString()
        }

        fun rfc3339(ms: Long): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date(ms))

        private fun gzip(body: ByteArray): ByteArray {
            val bytes = ByteArrayOutputStream(body.size / 4 + 64)
            GZIPOutputStream(bytes).use { it.write(body) }
            return bytes.toByteArray()
        }

        /** `Retry-After` in delta-seconds; HTTP-date form ignored. */
        private fun retryAfterMs(header: String?): Long =
            header?.trim()?.toLongOrNull()?.coerceAtLeast(0)?.times(1000) ?: 0
    }
}
