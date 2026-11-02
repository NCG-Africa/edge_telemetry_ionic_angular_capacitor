package com.nathanclaire.rum.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UserTest {
    val store = IdGeneratorTest.FakeStore()

    @Test fun identifyPersistsAndEmitsProfileUpdateOnlyWhenTraitsChange() {
        val user = User(store)
        val update = user.identify(JSONObject().put("id", "u1").put("name", "Ann").put("email", "a@x.io"))!!
        assertEquals("user.profile.update", update.getString("eventName"))
        val a = update.getJSONObject("attributes")
        assertEquals(3, a.length())
        assertEquals("u1", a.getString("user.id"))
        assertEquals("Ann", a.getString("user.name"))
        assertEquals("a@x.io", a.getString("user.email"))

        val relaunched = User(store)
        assertEquals("u1", relaunched.id())
        assertNull("same traits: no update", relaunched.identify(JSONObject().put("id", "u1").put("name", "Ann")))
        assertNull("id-only change: no update", relaunched.identify(JSONObject().put("id", "u2")))
        assertEquals("u2", relaunched.id())
        val phone = relaunched.identify(JSONObject().put("phone", "+254700000000"))!!.getJSONObject("attributes")
        assertEquals("+254700000000", phone.getString("user.phone"))
        assertEquals("Ann", phone.getString("user.name"))
    }

    @Test fun blankAndNullTraitsAreIgnored() {
        val user = User(store)
        assertNull(user.identify(JSONObject().put("id", " ").put("name", JSONObject.NULL)))
        assertNull(user.id())
    }

    @Test fun clearForgetsEverything() {
        val user = User(store)
        user.identify(JSONObject().put("id", "u1").put("name", "Ann"))
        user.clear()
        assertNull(user.id())
        assertNull(User(store).id())
        assertEquals("traits forgotten: same name is a change again", "Ann",
            User(store).identify(JSONObject().put("name", "Ann"))!!.getJSONObject("attributes").getString("user.name"))
    }
}
