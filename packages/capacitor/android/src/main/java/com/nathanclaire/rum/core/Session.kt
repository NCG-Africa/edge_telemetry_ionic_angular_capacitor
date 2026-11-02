package com.nathanclaire.rum.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Spec E1, S1–S3 (= Cordova S1–S8 with the Ionic deltas): the native session and the gate every
 * event passes at outbox append. One record (id, roll, counters, caps) persisted per hand-off, so
 * a WebView reload or a relaunch inside the idle timeout resumes the same session.
 */
class Session(
    private val store: IdGenerator.Store,
    private val health: Health,
    private val clock: () -> Long,
    sampleRate: Double,
    private val roll: () -> Double,
    private val newId: () -> String,
    private val userId: () -> String?,
) {
    // C1: clamped 0..1; NaN (unparseable config) keeps everything.
    private val rate = if (sampleRate.isNaN()) 1.0 else sampleRate.coerceIn(0.0, 1.0)

    private var id: String? = null
    private var startedAt = 0L
    private var lastActivityAt = 0L
    private var sampled = false
    private var eventCount = 0
    private var metricCount = 0
    private var screenCount = 0
    private var screens = ArrayList<String>()
    private var caps = HashMap<String, Int>()

    @Synchronized fun id(): String? = id

    @Synchronized fun sampled(): Boolean = sampled

    /** Launch / `enable()`: resumes the recorded session if still live, else finalizes it and starts one. */
    @Synchronized
    fun begin(): List<String> {
        if (id == null) load()
        if (id != null) return rotateIfIdle()
        return ArrayList<String>().also(::start)
    }

    /** Rotation check without activity (foreground). Bookends to append, or none. */
    @Synchronized
    fun rotateIfIdle(): List<String> {
        val out = ArrayList<String>()
        if (id != null && clock() - lastActivityAt > IDLE_MS) {
            out.add(finalized())
            start(out)
        }
        return out
    }

    /** `reset()`: a fresh session; the old one is discarded with the outbox, not finalized. */
    @Synchronized
    fun restart(): List<String> = ArrayList<String>().also(::start)

    /** `disable()`: forgets the session; nothing is finalized for it. */
    @Synchronized
    fun end() {
        id = null
        put(KEY_RECORD, null)
    }

    /**
     * The gate (S1): counts each event (Cordova S6), drops it if sampled out or capped, stamps
     * `session.id` / `user.id` on what's kept. Returns the lines to append, bookends first.
     */
    @Synchronized
    fun admit(events: List<JSONObject>): List<String> {
        if (id == null) return emptyList()
        val out = ArrayList(rotateIfIdle())
        gate(events, out)
        lastActivityAt = clock()
        persist()
        return out
    }

    /**
     * The gate for native signals that arrive in the background (network, memory): never rotate
     * and don't count as activity, so they can't keep an idle session alive (E1).
     */
    @Synchronized
    fun admitPassive(events: List<JSONObject>): List<String> {
        if (id == null) return emptyList()
        val out = ArrayList<String>()
        gate(events, out)
        persist()
        return out
    }

    private fun gate(events: List<JSONObject>, out: MutableList<String>) {
        for (e in events) {
            val attrs = e.optJSONObject("attributes") ?: JSONObject()
            val metric = e.optString("type") == "metric"
            val name = e.optString(if (metric) "metricName" else "eventName")
            count(metric, name, attrs)
            if (!exempt(name, attrs)) {
                if (!sampled) continue
                val reason = capReason(metric, name, attrs)
                if (reason != null) {
                    health.count(reason, 1)
                    continue
                }
            }
            e.put("attributes", stamp(attrs))
            out.add(e.toString())
        }
    }

    private fun count(metric: Boolean, name: String, attrs: JSONObject) {
        if (metric) metricCount++ else eventCount++
        val screen = attrs.optString("navigation.to_screen")
        if (name != "navigation" || screen.isEmpty()) return
        screenCount++
        if (screens.size < MAX_SCREENS) screens.add(screen)
    }

    /** S3 / Cordova S7: the `sdk.health` reason when a cap is hit, else null (and the event is counted). */
    private fun capReason(metric: Boolean, name: String, attrs: JSONObject): String? {
        if (metric && name in SDK_METRICS) return null
        return when (if (metric) "custom_event" else name) {
            "app.crash" -> {
                val key = "error:" + attrs.optString("exception_type") + "|" + topFrame(attrs.optString("stacktrace"))
                if (allow("error", CAP_ERRORS, key, CAP_ERRORS_PER_KEY)) null else "cap.error"
            }
            "ui.interaction" -> if (allow("interaction", CAP_INTERACTIONS)) null else "cap.interaction"
            "bridge.summary" -> if (allow("bridge", CAP_BRIDGE)) null else "cap.bridge"
            // and host metrics
            "custom_event", "task.complete" -> if (allow("custom", CAP_CUSTOM)) null else "cap.custom"
            else -> null
        }
    }

    /** Takes a slot from the total and, if given, the per-key cap; neither is taken when either is full. */
    private fun allow(total: String, totalLimit: Int, key: String? = null, keyLimit: Int = 0): Boolean {
        val t = caps[total] ?: 0
        val k = key?.let { caps[it] } ?: 0
        if (t >= totalLimit || (key != null && k >= keyLimit)) return false
        caps[total] = t + 1
        if (key != null) caps[key] = k + 1
        return true
    }

    private fun stamp(attrs: JSONObject): JSONObject {
        attrs.put("session.id", id)
        userId()?.let { attrs.put("user.id", it) }
        return attrs
    }

    private fun start(out: MutableList<String>) {
        val now = clock()
        id = newId()
        startedAt = now
        lastActivityAt = now
        sampled = rate >= 1 || roll() < rate // S1
        eventCount = 0
        metricCount = 0
        screenCount = 0
        screens = ArrayList()
        caps = HashMap()
        // Unreadable count: this one counts as first.
        val total = (runCatching { store.get(KEY_TOTAL)?.toInt() }.getOrNull() ?: 0) + 1
        put(KEY_TOTAL, total.toString())
        persist()
        val a = sampledAttr(JSONObject()
            .put("session.start_time", Sender.rfc3339(startedAt))
            .put("session.is_first_session", total == 1)
            .put("session.total_sessions", total))
        out.add(bookend("session.started", now, a))
    }

    /** E1: backdated to the last activity, so idle time isn't session time. */
    private fun finalized(): String = bookend("session.finalized", lastActivityAt, sampledAttr(JSONObject()
        .put("session.start_time", Sender.rfc3339(startedAt))
        .put("session.duration_ms", maxOf(0, lastActivityAt - startedAt))
        .put("session.event_count", eventCount)
        .put("session.metric_count", metricCount)
        .put("session.screen_count", screenCount)
        .put("session.visited_screens", screens.joinToString(","))))

    /** S1 (= Cordova S3): only when the rate is below 1. */
    private fun sampledAttr(a: JSONObject) = if (rate < 1) a.put("session.sampled", sampled) else a

    private fun bookend(name: String, at: Long, attrs: JSONObject) = JSONObject()
        .put("type", "event")
        .put("eventName", name)
        .put("timestamp", Sender.rfc3339(at))
        .put("attributes", stamp(attrs))
        .toString()

    private fun persist() = put(KEY_RECORD, JSONObject()
        .put("id", id)
        .put("start", startedAt)
        .put("last", lastActivityAt)
        .put("sampled", sampled)
        .put("events", eventCount)
        .put("metrics", metricCount)
        .put("screen_count", screenCount)
        .put("screens", JSONArray(screens))
        .put("caps", JSONObject(caps as Map<*, *>))
        .toString())

    /** Storage failures keep the in-memory session going; a relaunch then starts a new one. */
    private fun put(key: String, value: String?) {
        try {
            store.put(key, value)
        } catch (ignored: RuntimeException) {
            // see above
        }
    }

    private fun load() {
        try {
            val r = JSONObject(store.get(KEY_RECORD) ?: return)
            startedAt = r.getLong("start")
            lastActivityAt = r.getLong("last")
            sampled = r.getBoolean("sampled")
            eventCount = r.getInt("events")
            metricCount = r.getInt("metrics")
            screenCount = r.getInt("screen_count")
            val s = r.getJSONArray("screens")
            screens = ArrayList((0 until s.length()).map(s::getString))
            val c = r.getJSONObject("caps")
            caps = HashMap()
            // org.json `keys()` is a raw Iterator on Android.
            for (k in c.keys()) caps[k as String] = c.getInt(k)
            id = r.getString("id") // last: a corrupt record leaves no half-loaded session
        } catch (e: Exception) {
            id = null
        }
    }

    companion object {
        const val IDLE_MS = 30 * 60_000L
        const val KEY_RECORD = "session"
        const val KEY_TOTAL = "total_sessions"
        /** `session.visited_screens` keeps the first 50; `session.screen_count` counts them all. */
        private const val MAX_SCREENS = 50
        /** S3 per-session caps. */
        const val CAP_ERRORS = 50
        const val CAP_ERRORS_PER_KEY = 5
        const val CAP_INTERACTIONS = 200
        const val CAP_BRIDGE = 50
        const val CAP_CUSTOM = 500

        /** S2: never sampled out, never capped (fatal / WebView-death `app.crash` checked separately). */
        private val EXEMPT = setOf("session.started", "session.finalized", "app.anr", "app.exit", "app.start", "sdk.health")
        /** SDK metrics; any other metric name is the host's (`measure()` / `time()`). */
        private val SDK_METRICS = setOf("LCP", "INP", "CLS", "FCP", "TTFB", "resource_timing", "memory_usage")
        /** A JSC frame (`fn@url:line[:col]`); a V8 message line with an `@` in it doesn't match. */
        private val JSC_FRAME = Regex("^[^\\s@]*@\\S+:\\d+(:\\d+)?$")

        private fun exempt(name: String, attrs: JSONObject) = name in EXEMPT ||
            (name == "app.crash" && (attrs.optBoolean("is_fatal") || attrs.optString("cause") == "WebViewTerminated"))

        // ponytail: first line that looks like a frame (V8 `at …`, JSC `fn@url`); parsed frames are issue 11's.
        private fun topFrame(stack: String): String =
            stack.lineSequence().map(String::trim).firstOrNull { it.startsWith("at ") || JSC_FRAME.matches(it) } ?: ""
    }
}
