package com.nathanclaire.rum.core

import java.io.File
import java.util.TreeMap
import org.json.JSONObject

/**
 * Spec T1 (= Cordova T8) / R4: drop counters by reason, persisted until a batch carrying them as
 * `sdk.health` is accepted. Keys follow the iOS sibling (`events_dropped.<reason>`).
 */
class Health(dir: File) {
    private val file = File(dir, "health.json")
    private val dropped = TreeMap<String, Long>()

    init {
        dir.mkdirs()
        try {
            val saved = JSONObject(file.readText())
            // org.json `keys()` is a raw Iterator on Android.
            for (key in saved.keys()) dropped[key as String] = saved.getLong(key)
        } catch (ignored: Exception) {
            // Missing or corrupt: start from zero.
        }
    }

    @Synchronized
    fun count(reason: String, n: Long) {
        if (n <= 0) return
        val key = "events_dropped.$reason"
        dropped[key] = (dropped[key] ?: 0) + n
        persist()
    }

    @Synchronized
    fun snapshot(): Map<String, Long> = TreeMap(dropped)

    /** Removes counts a delivered batch carried; drops counted since stay. */
    @Synchronized
    fun subtract(sent: Map<String, Long>) {
        if (sent.isEmpty()) return
        for ((key, n) in sent) {
            val left = (dropped[key] ?: continue) - n
            if (left > 0) dropped[key] = left else dropped.remove(key)
        }
        persist()
    }

    private fun persist() {
        val tmp = File(file.path + ".tmp")
        try {
            tmp.writeText(JSONObject(dropped as Map<*, *>).toString())
        } catch (e: java.io.IOException) {
            return
        }
        tmp.renameTo(file)
    }
}
