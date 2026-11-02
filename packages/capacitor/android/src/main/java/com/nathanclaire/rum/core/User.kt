package com.nathanclaire.rum.core

import org.json.JSONObject

/** Spec P7 (= Cordova P6): `identify()` traits, persisted until `clearUser()`. */
class User(private val store: IdGenerator.Store) {
    private var user: JSONObject = try {
        store.get(KEY)?.let(::JSONObject) ?: JSONObject()
    } catch (ignored: Exception) {
        JSONObject()
    }

    @Synchronized
    fun id(): String? = if (user.has("id")) user.optString("id") else null

    /**
     * Merges the given non-blank keys. Returns one `user.profile.update` event when name, email
     * or phone changed, else null.
     */
    @Synchronized
    fun identify(given: JSONObject): JSONObject? {
        var traitsChanged = false
        for (k in listOf("id") + TRAITS) {
            val v = given.opt(k) as? String ?: continue
            if (v.isBlank()) continue
            if (k != "id" && v != user.opt(k)) traitsChanged = true
            user.put(k, v)
        }
        try {
            store.put(KEY, user.toString())
        } catch (ignored: RuntimeException) {
            // kept in memory for this process
        }
        if (!traitsChanged) return null
        val attrs = JSONObject()
        if (user.has("id")) attrs.put("user.id", user.get("id"))
        for (k in TRAITS) if (user.has(k)) attrs.put("user.$k", user.get(k))
        return JSONObject()
            .put("type", "event")
            .put("eventName", "user.profile.update")
            .put("timestamp", Sender.rfc3339(System.currentTimeMillis()))
            .put("attributes", attrs)
    }

    @Synchronized
    fun clear() {
        user = JSONObject()
        try {
            store.put(KEY, null)
        } catch (ignored: RuntimeException) {
            // forgotten in memory; a stale copy may return next launch
        }
    }

    companion object {
        const val KEY = "user"
        private val TRAITS = listOf("name", "email", "phone")
    }
}
