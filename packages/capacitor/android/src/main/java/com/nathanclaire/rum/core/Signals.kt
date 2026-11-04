package com.nathanclaire.rum.core

import org.json.JSONObject

/**
 * Spec E2, E22–E24, E26, E32 (= Cordova `Signals`): native `app_lifecycle`, `memory_usage`,
 * `memory_pressure` and `network_change` records, N1 keys. The plugin reads the platform; these only shape it.
 */
object Signals {
    /** E2: native fg/bg (`foregrounded` / `backgrounded`); JS sends its own `appStateChange` states. */
    fun lifecycle(state: String, at: Long): JSONObject =
        Crash.event("app_lifecycle", at, JSONObject().put("lifecycle.state", state))

    /** E22 / E23: one `memory_usage` per measure (RSS, PSS), in MB. A missing reading (< 0) is skipped. */
    fun memory(rssKb: Long, pssKb: Long, source: String, at: Long): List<JSONObject> = listOfNotNull(
        if (rssKb >= 0) memoryMetric(rssKb, "rss", source, at) else null,
        if (pssKb >= 0) memoryMetric(pssKb, "pss", source, at) else null,
    )

    private fun memoryMetric(kb: Long, type: String, source: String, at: Long): JSONObject {
        val mb = mb(kb)
        return JSONObject()
            .put("type", "metric")
            .put("metricName", "memory_usage")
            .put("value", mb)
            .put("timestamp", Sender.rfc3339(at))
            .put("attributes", JSONObject()
                .put("metric.unit", "MB")
                .put("memory.usage_mb", mb)
                .put("memory.type", type)
                .put("memory.source", source))
    }

    /** E24: `ComponentCallbacks2` trim level → `memory_pressure`; UI_HIDDEN (20) is a backgrounding, not pressure → null. */
    fun pressure(level: Int, rssKb: Long, at: Long): JSONObject? {
        val name = PRESSURE[level] ?: return null
        val a = JSONObject().put("memory.pressure_level", name).put("memory.trim_level", level)
        if (rssKb >= 0) a.put("memory.usage_mb", mb(rssKb)).put("memory.type", "rss")
        return Crash.event("memory_pressure", at, a.put("memory.source", "on_trim_memory"))
    }

    /** E26: default network transport changed (`wifi` / `cellular` / `ethernet` / `other` / `none`). */
    fun network(previous: String, current: String, at: Long): JSONObject = Crash.event(
        "network_change", at, JSONObject().put("network.type", current).put("network.previous_type", previous),
    )

    /** `VmRSS:` of `/proc/self/status`, in kB; -1 when absent. */
    fun rssKb(procStatus: String): Long {
        val line = procStatus.lineSequence().firstOrNull { it.startsWith("VmRSS:") } ?: return -1
        return line.substring(6).trim().split(Regex("\\s+"))[0].toLongOrNull() ?: -1
    }

    /** E32 / P5: `app.bundle_id` = last segment of Capacitor's `getServerBasePath()`, or `builtin` (APK assets). */
    fun bundleId(serverBasePath: String?): String =
        serverBasePath?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null } ?: "builtin"

    /** `TRIM_MEMORY_*` by value; `onLowMemory` arrives as 80 (complete). */
    private val PRESSURE = mapOf(
        5 to "running_moderate", 10 to "running_low", 15 to "running_critical",
        40 to "background", 60 to "moderate", 80 to "complete",
    )

    private fun mb(kb: Long): Double = Math.round(kb / 102.4) / 10.0
}
