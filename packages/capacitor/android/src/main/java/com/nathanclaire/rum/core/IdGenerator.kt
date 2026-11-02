package com.nathanclaire.rum.core

import java.security.SecureRandom
import java.util.UUID

/**
 * Spec W3 / R9 (= Cordova W4): port of `edge_telemetry_android` `IdGenerator`. Never throws:
 * device_id is required on every batch. Lives in native storage only, never the WebView.
 */
class IdGenerator(private val store: Store) {
    /** The SharedPreferences calls the native core needs; either may throw. */
    interface Store {
        fun get(key: String): String?

        /** A null value removes the key. */
        fun put(key: String, value: String?): Boolean
    }

    // Set once the primary id has failed; pins the fallback for this process so the id is stable.
    @Volatile private var pinnedFallbackId: String? = null

    @Synchronized
    fun deviceId(): String {
        pinnedFallbackId?.let { return it }
        return try {
            // A persisted fallback wins over the primary slot, so a transient primary failure
            // can't make device_id flip between processes.
            store.get(KEY_FALLBACK_DEVICE_ID) ?: store.get(KEY_DEVICE_ID) ?: generate("device").let {
                if (store.put(KEY_DEVICE_ID, it)) it else fallbackId()
            }
        } catch (e: RuntimeException) {
            fallbackId()
        }
    }

    /** P7 `reset()`: a fresh device_id replaces both slots; pinned in memory if storage fails. */
    @Synchronized
    fun rotate(): String {
        val id = generate("device")
        try {
            if (store.put(KEY_DEVICE_ID, id) && store.put(KEY_FALLBACK_DEVICE_ID, null)) {
                pinnedFallbackId = null
                return id
            }
        } catch (ignored: RuntimeException) {
            // falls through to pinning
        }
        pinnedFallbackId = id
        return id
    }

    // R9: a random UUIDv4 persisted once under its own key; if storage fails too, in-memory for
    // this process.
    private fun fallbackId(): String {
        val id = try {
            store.get(KEY_FALLBACK_DEVICE_ID) ?: UUID.randomUUID().toString().let {
                if (store.put(KEY_FALLBACK_DEVICE_ID, it)) it else UUID.randomUUID().toString()
            }
        } catch (e: RuntimeException) {
            UUID.randomUUID().toString()
        }
        pinnedFallbackId = id
        return id
    }

    companion object {
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_FALLBACK_DEVICE_ID = "device_id_fallback"
        private val RANDOM = SecureRandom()

        fun sessionId() = generate("session")

        fun generate(kind: String): String {
            val bytes = ByteArray(8).also { RANDOM.nextBytes(it) }
            return kind + "_" + System.currentTimeMillis() + "_" +
                bytes.joinToString("") { "%02x".format(it) } + "_android"
        }
    }
}

/** A write the caller can live without: on failure the value stays in memory / this process only. */
fun IdGenerator.Store.putQuietly(key: String, value: String?) {
    try {
        put(key, value)
    } catch (ignored: RuntimeException) {
        // see above
    }
}
