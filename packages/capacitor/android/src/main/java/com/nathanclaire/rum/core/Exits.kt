package com.nathanclaire.rum.core

import org.json.JSONObject

/**
 * Spec E16 (= Cordova `Exits`): `app.exit` from `ActivityManager.getHistoricalProcessExitReasons`
 * (API 30+), one per exit record newer than the persisted watermark. The plugin maps
 * `ApplicationExitInfo` to [Record]. No trace keys: the exit is another process's (X8).
 */
object Exits {
    const val KEY_WATERMARK = "exit_watermark"
    /** Sibling cap: double the stack cap; the culprit sits at the head. */
    private const val MAX_TRACE = 4000
    /** `ApplicationExitInfo.REASON_*`, by value (0–16). */
    private val REASONS = arrayOf("unknown", "exit_self", "signaled", "low_memory", "crash", "crash_native",
        "anr", "initialization_failure", "permission_change", "excessive_resource_usage", "user_requested",
        "user_stopped", "dependency_died", "other", "freezer", "package_state_change", "package_updated")

    /** [trace] is set on ANR records only (the OS's text trace). */
    class Record(
        val reason: Int,
        val importance: Int,
        val status: Int,
        val description: String?,
        val pssKb: Long,
        val rssKb: Long,
        val timestamp: Long,
        val trace: String?,
    )

    /** Events for records newer than the watermark, which then advances to the newest of them. */
    fun harvest(records: List<Record>, store: IdGenerator.Store, now: Long): List<JSONObject> {
        // Unreadable: everything still in the OS buffer counts as new.
        val watermark = runCatching { store.get(KEY_WATERMARK)?.toLong() }.getOrNull() ?: -1
        val fresh = records.filter { it.timestamp > watermark }
        if (fresh.isNotEmpty()) {
            // On failure: re-sent next launch; better than lost.
            store.putQuietly(KEY_WATERMARK, fresh.maxOf { it.timestamp }.toString())
        }
        return fresh.map { Crash.event("app.exit", now, attributes(it)) }
    }

    private fun attributes(r: Record): JSONObject {
        val a = JSONObject()
            .put("exit.reason", REASONS.getOrNull(r.reason) ?: "unknown_${r.reason}")
            .put("exit.importance", importance(r.importance))
            .put("exit.description", r.description)
            .put("exit.status", r.status)
            .put("exit.pss_kb", r.pssKb)
            .put("exit.rss_kb", r.rssKb)
            .put("exit.timestamp", r.timestamp)
        r.trace?.let { a.put("exit.trace", if (it.length <= MAX_TRACE) it else it.substring(0, MAX_TRACE) + "\n…[trace truncated]") }
        return a
    }

    /** `RunningAppProcessInfo.IMPORTANCE_*`, by value. */
    private fun importance(code: Int) = when (code) {
        100 -> "foreground"
        125 -> "foreground_service"
        200 -> "visible"
        230 -> "perceptible"
        300 -> "service"
        400 -> "cached"
        1000 -> "gone"
        else -> "unknown_$code"
    }
}
