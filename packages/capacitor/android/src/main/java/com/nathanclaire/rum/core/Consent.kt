package com.nathanclaire.rum.core

/** Spec P7: the enabled state and what `enable()`, `disable()` and `reset()` do to stored data. */
class Consent(
    private val store: IdGenerator.Store,
    /** C1 `enabled`; a persisted `enable()`/`disable()` overrides it. */
    prefEnabled: Boolean,
    private val session: Session,
    private val user: User,
    private val outbox: Outbox,
    private val ids: IdGenerator,
) {
    // Unreadable: the config decides.
    @Volatile private var enabled = runCatching { store.get(KEY_ENABLED) }.getOrNull()?.toBoolean() ?: prefEnabled

    fun enabled() = enabled

    /**
     * Persisted. Enabling begins a session (bookends returned to append); disabling forgets the
     * session and deletes the unsent outbox and the user's traits.
     */
    @Synchronized
    fun setEnabled(on: Boolean): List<String> {
        try {
            store.put(KEY_ENABLED, on.toString())
        } catch (ignored: RuntimeException) {
            // applies to this process only
        }
        if (on == enabled) return emptyList()
        enabled = on
        if (on) return session.begin()
        session.end()
        outbox.clear()
        user.clear()
        return emptyList()
    }

    /** Clears user and outbox and rotates device_id; the caller starts the new session. Returns the new device_id. */
    @Synchronized
    fun reset(): String {
        outbox.clear()
        user.clear()
        return ids.rotate()
    }

    companion object {
        const val KEY_ENABLED = "enabled"
    }
}
