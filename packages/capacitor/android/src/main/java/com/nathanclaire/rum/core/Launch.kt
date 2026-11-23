package com.nathanclaire.rum.core

import org.json.JSONObject

/**
 * Spec A5, E3 (= Cordova `Launch` with Capacitor phases): the one `app.start` per cold launch,
 * assembled from the native process start + WebView created marks and the JS `markPhase` phases.
 * `bridgeReady` stands where Cordova had `deviceready`; there is no ready timeout (E17 not emitted).
 * Processor #32 / #149: `app.start.duration_ms` ends at bridge ready; `markReady()` is a phase
 * (`app.start.mark_ready_ms`) and no longer extends it. The plugin keeps one per process.
 */
class Launch(private val processStart: Long, private val webViewCreated: Long) {
    private val marks = HashMap<String, Long>()
    private var emitted = false

    /**
     * Records a phase (first mark wins: a WebView reload re-sends them). Returns `app.start` when
     * this mark completes it: `markReady` with `bridgeReady` seen, inside the window.
     */
    @Synchronized
    fun mark(phase: String?, ts: Long): JSONObject? {
        if (emitted || phase == null || phase in marks || phase !in PHASES) return null
        val ready = marks[BRIDGE_READY]
        if (phase == MARK_READY && ready != null && ts - ready > READY_WINDOW_MS) return null
        marks[phase] = ts
        return if (BRIDGE_READY in marks && MARK_READY in marks) emit() else null
    }

    /** Window over (or app backgrounded): `app.start` without `markReady`, if `bridgeReady` came and it's still owed. */
    @Synchronized
    fun finish(): JSONObject? = if (emitted || BRIDGE_READY !in marks) null else emit()

    private fun emit(): JSONObject {
        emitted = true
        val end = marks.getValue(BRIDGE_READY)
        val a = JSONObject()
            .put("app.start.type", "cold")
            .put("app.start.duration_ms", maxOf(0, end - processStart))
            .put("app.start.webview_created_ms", maxOf(0, webViewCreated - processStart))
        for ((phase, key) in PHASES) marks[phase]?.let { a.put(key, maxOf(0, it - processStart)) }
        return Crash.event("app.start", end, a)
    }

    companion object {
        /** A5: `markReady()` counts when it lands within this long of `bridgeReady`. */
        const val READY_WINDOW_MS = 30_000L
        const val BRIDGE_READY = "bridgeReady"
        const val MARK_READY = "markReady"
        /** JS phases (A5) → `app.start.*` keys (N2), in launch order. */
        private val PHASES = linkedMapOf(
            "responseEnd" to "app.start.response_end_ms",
            "DOMContentLoaded" to "app.start.dom_content_loaded_ms",
            "load" to "app.start.load_ms",
            BRIDGE_READY to "app.start.bridge_ready_ms",
            MARK_READY to "app.start.mark_ready_ms",
        )
    }
}
