package com.nathanclaire.rum.core

import org.json.JSONObject

/**
 * Spec E2, E22–E24, E26, E32 (= Cordova `Signals`): native `app.lifecycle`, `memory.usage`,
 * `memory.pressure` and `network.change` records, on the event catalogue's names (#149). The plugin
 * reads the platform; these only shape it.
 */
object Signals {
    /** E2: native fg/bg (`foregrounded` / `backgrounded`); JS sends its own `appStateChange` states. */
    fun lifecycle(state: String, at: Long): JSONObject =
        Crash.event("app.lifecycle", at, JSONObject().put("lifecycle.state", state))

    /**
     * E22 / E23: one `memory.usage` event. `memory.usage_mb` is the process's total PSS in MB (the
     * catalogue's Android footprint, processor #33), else RSS when PSS is missing; RSS also rides in
     * `memory.resident_kb`. Null with neither reading (< 0).
     */
    fun memory(rssKb: Long, pssKb: Long, source: String, at: Long): JSONObject? {
        val (kb, type) = when {
            pssKb >= 0 -> pssKb to "pss"
            rssKb >= 0 -> rssKb to "rss"
            else -> return null
        }
        val a = JSONObject().put("memory.usage_mb", mb(kb)).put("memory.type", type).put("memory.source", source)
        if (rssKb >= 0) a.put("memory.resident_kb", rssKb)
        return Crash.event("memory.usage", at, a)
    }

    /**
     * E24: `ComponentCallbacks2` trim level → `memory.pressure` with the catalogue's
     * `moderate|critical` (as the Android SDK). UI_HIDDEN (20) is a backgrounding and
     * BACKGROUND (40) only means "near the front of the LRU list": no pressure, not in the map, null.
     */
    fun pressure(level: Int, pssKb: Long, at: Long): JSONObject? {
        val (trim, pressure) = PRESSURE[level] ?: return null
        val a = JSONObject().put("memory.pressure_level", pressure).put("memory.trim_level", trim)
        if (pssKb >= 0) a.put("memory.usage_mb", mb(pssKb)).put("memory.type", "pss")
        return Crash.event("memory.pressure", at, a.put("memory.source", "on_trim_memory"))
    }

    /** E26: default network transport changed (`wifi` / `cellular` / `ethernet` / `other` / `none`). */
    fun network(previous: String, current: String, at: Long): JSONObject = Crash.event(
        "network.change", at, JSONObject().put("network.type", current).put("network.previous_type", previous),
    )

    /** `VmRSS:` of `/proc/self/status`, in kB; -1 when absent. */
    fun rssKb(procStatus: String): Long {
        val line = procStatus.lineSequence().firstOrNull { it.startsWith("VmRSS:") } ?: return -1
        return line.substring(6).trim().split(Regex("\\s+"))[0].toLongOrNull() ?: -1
    }

    /** E32 / P5: `app.bundle_id` = last segment of Capacitor's `getServerBasePath()`, or `builtin` (APK assets). */
    fun bundleId(serverBasePath: String?): String =
        serverBasePath?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null } ?: "builtin"

    /** `TRIM_MEMORY_*` by value → (`memory.trim_level`, `memory.pressure_level`); `onLowMemory` arrives as 80. */
    private val PRESSURE = mapOf(
        5 to ("running_moderate" to "moderate"), 10 to ("running_low" to "moderate"),
        15 to ("running_critical" to "critical"),
        60 to ("moderate" to "moderate"), 80 to ("complete" to "critical"),
    )

    private fun mb(kb: Long): Double = Math.round(kb / 102.4) / 10.0
}
