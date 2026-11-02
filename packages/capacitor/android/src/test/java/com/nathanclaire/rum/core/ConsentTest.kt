package com.nathanclaire.rum.core

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ConsentTest {
    @get:Rule val tmp = TemporaryFolder()
    val store = IdGeneratorTest.FakeStore()
    lateinit var outbox: Outbox
    lateinit var user: User
    lateinit var session: Session
    lateinit var ids: IdGenerator

    @Before fun setUp() {
        val dir = File(tmp.root, "edge_rum")
        val health = Health(dir)
        outbox = Outbox(dir, System::currentTimeMillis, health)
        user = User(store)
        ids = IdGenerator(store)
        var n = 0
        session = Session(store, health, System::currentTimeMillis, 1.0, { 0.0 }, { "session_${++n}" }, user::id)
    }

    fun consent(pref: Boolean) = Consent(store, pref, session, user, outbox, ids)

    @Test fun optInModeArmsNothingUntilEnable() {
        val c = consent(false)
        assertFalse(c.enabled())
        assertNull("no session in opt-in mode", session.id())
        assertTrue("nothing admitted", session.admit(listOf(SessionTest.event("navigation"))).isEmpty())
        assertEquals("enable starts a session", listOf("session.started"), SessionTest.names(c.setEnabled(true)))
        assertTrue(c.enabled())
        assertTrue("persisted over the pref", consent(false).enabled())
    }

    @Test fun disablePersistsOverPrefAndWipesOutboxTraitsAndSession() {
        val c = consent(true)
        session.begin()
        user.identify(JSONObject().put("id", "u1"))
        outbox.append(SenderTest.IDENTITY, listOf("{}"))
        outbox.seal()
        outbox.append(SenderTest.IDENTITY, listOf("{}"))

        assertTrue(c.setEnabled(false).isEmpty())
        assertFalse(c.enabled())
        outbox.seal()
        assertTrue(outbox.sealed().isEmpty())
        assertNull(User(store).id())
        assertNull(session.id())
        assertFalse("persisted over enabled=true", consent(true).enabled())
    }

    @Test fun repeatedEnableIsANoOp() {
        val c = consent(true)
        session.begin()
        assertTrue(c.setEnabled(true).isEmpty())
        assertEquals("session_1", session.id())
    }

    @Test fun resetRotatesDeviceIdAndClearsUserAndOutbox() {
        val c = consent(true)
        val before = ids.deviceId()
        user.identify(JSONObject().put("id", "u1"))
        outbox.append(SenderTest.IDENTITY, listOf("{}"))

        val after = c.reset()
        assertNotEquals(before, after)
        assertEquals(after, IdGenerator(store).deviceId())
        assertNull(user.id())
        outbox.seal()
        assertTrue(outbox.sealed().isEmpty())
        assertTrue("reset leaves enabled state alone", c.enabled())
    }
}
