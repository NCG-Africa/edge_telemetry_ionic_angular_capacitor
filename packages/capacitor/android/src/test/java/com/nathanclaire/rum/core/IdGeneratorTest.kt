package com.nathanclaire.rum.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IdGeneratorTest {
    /** In-memory SharedPreferences stand-in; flags simulate storage failures. */
    class FakeStore : IdGenerator.Store {
        val values = HashMap<String, String?>()
        var failPrimaryRead = false
        var failAll = false

        override fun get(key: String): String? {
            if (failAll || (failPrimaryRead && key == IdGenerator.KEY_DEVICE_ID)) throw IllegalStateException()
            return values[key]
        }

        override fun put(key: String, value: String?): Boolean {
            if (failAll) throw IllegalStateException()
            values[key] = value
            return true
        }
    }

    @Test fun generatesOncePersistsAndReuses() {
        val store = FakeStore()
        val id = IdGenerator(store).deviceId()
        assertTrue(id, id.matches(Regex("device_\\d+_[0-9a-f]{16}_android")))
        assertEquals(id, IdGenerator(store).deviceId())
    }

    @Test fun primaryFailureFallsBackToPersistedUuidThatWinsLater() {
        val store = FakeStore()
        store.values[IdGenerator.KEY_DEVICE_ID] = "device_primary"
        store.failPrimaryRead = true
        val fallback = IdGenerator(store).deviceId()
        assertTrue(fallback, fallback.matches(Regex("[0-9a-f-]{36}")))

        // Next process: primary readable again, but the persisted fallback wins (no flip).
        store.failPrimaryRead = false
        assertEquals(fallback, IdGenerator(store).deviceId())
    }

    @Test fun brokenStorageUsesInMemoryIdPinnedForTheProcess() {
        val store = FakeStore()
        store.failAll = true
        val ids = IdGenerator(store)
        val id = ids.deviceId()
        assertEquals(id, ids.deviceId())
        assertNotEquals(id, IdGenerator(store).deviceId())
    }
}
