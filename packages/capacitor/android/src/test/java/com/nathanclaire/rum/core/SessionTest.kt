package com.nathanclaire.rum.core

import java.io.File
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionTest {
    @get:Rule val tmp = TemporaryFolder()
    val store = IdGeneratorTest.FakeStore()
    var now = 1793008800000L // 2026-10-26T10:00:00.000Z
    var roll = 0.0
    var ids = 0
    var userId: String? = null
    val health by lazy { Health(File(tmp.root, "edge_rum")) }

    fun session(rate: Double) = Session(store, health, { now }, rate, { roll }, { "session_${++ids}" }, { userId })

    companion object {
        fun event(name: String, vararg attrs: Pair<String, Any>) = JSONObject()
            .put("type", "event").put("eventName", name).put("timestamp", "t")
            .put("attributes", JSONObject().apply { attrs.forEach { put(it.first, it.second) } })

        fun metric(name: String) = JSONObject()
            .put("type", "metric").put("metricName", name).put("value", 1).put("attributes", JSONObject())

        fun parse(lines: List<String>) = lines.map(::JSONObject)

        fun names(lines: List<String>) = parse(lines).map { it.optString("eventName", it.optString("metricName")) }

        fun attrs(line: String): JSONObject = JSONObject(line).getJSONObject("attributes")

        fun repeat(e: JSONObject, n: Int) = List(n) { e }

        fun crash(type: String, stack: String) =
            event("app.error", "error.type" to type, "error.stacktrace" to stack)
    }

    @Test fun firstBeginStartsFirstSession() {
        val started = parse(session(1.0).begin())[0]
        assertEquals("session.started", started.getString("eventName"))
        val a = started.getJSONObject("attributes")
        assertEquals("session_1", a.getString("session.id"))
        assertEquals("2026-10-26T10:00:00.000Z", a.getString("session.start_time"))
        assertTrue(a.getBoolean("session.is_first_session"))
        assertEquals(1, a.getInt("session.total_sessions"))
        assertFalse("S1: absent at rate 1", a.has("session.sampled"))
    }

    @Test fun stampsSessionAndUserOnEveryEvent() {
        val s = session(1.0)
        s.begin()
        userId = "u1"
        val a = attrs(s.admit(listOf(event("navigation")))[0])
        assertEquals("session_1", a.getString("session.id"))
        assertEquals("u1", a.getString("user.id"))
    }

    @Test fun idleTimeoutRotatesWithBackdatedFinalizeAndFreshCounters() {
        val s = session(1.0)
        s.begin()
        s.admit(listOf(event("navigation", "navigation.to_screen" to "/home"), metric("perf.lcp")))
        now += 60_000
        s.admit(listOf(event("navigation", "navigation.to_screen" to "/cart")))
        now += Session.IDLE_MS + 1

        val out = s.admit(listOf(event("custom.event")))
        assertEquals(listOf("session.finalized", "session.started", "custom.event"), names(out))
        val fin = attrs(out[0])
        assertEquals("session_1", fin.getString("session.id"))
        assertEquals(60_000, fin.getLong("session.duration_ms"))
        assertEquals(2, fin.getInt("session.event_count"))
        assertEquals(1, fin.getInt("session.metric_count"))
        assertEquals(2, fin.getInt("session.screen_count"))
        assertEquals("/home,/cart", fin.getString("session.visited_screens"))
        val started = attrs(out[1])
        assertEquals("session_2", started.getString("session.id"))
        assertFalse(started.getBoolean("session.is_first_session"))
        assertEquals(2, started.getInt("session.total_sessions"))
        assertEquals("session_2", attrs(out[2]).getString("session.id"))
        assertEquals("session_2", s.id())
    }

    @Test fun activeSessionEndsAtFourHoursWithMaxDuration() {
        val s = session(1.0)
        s.begin()
        val start = now
        while (now - start < Session.MAX_DURATION_MS - 60_000) {
            now += 60_000
            assertEquals(listOf("custom.event"), names(s.admit(listOf(event("custom.event")))))
        }
        now += 60_000
        val out = s.admit(listOf(event("custom.event")))
        assertEquals(listOf("session.finalized", "session.started", "custom.event"), names(out))
        assertEquals("max_duration", attrs(out[0]).getString("session.reason"))
        assertEquals("session_2", attrs(out[2]).getString("session.id"))
    }

    @Test fun idleRotationSaysTimeout() {
        val s = session(1.0)
        s.begin()
        now += Session.IDLE_MS + 1
        assertEquals("timeout", attrs(s.rotateIfIdle()[0]).getString("session.reason"))
    }

    @Test fun rotateIfIdleOnlyRotatesPastTheTimeout() {
        val s = session(1.0)
        s.begin()
        now += Session.IDLE_MS
        assertTrue(s.rotateIfIdle().isEmpty())
        now += 1
        assertEquals(listOf("session.finalized", "session.started"), names(s.rotateIfIdle()))
    }

    @Test fun sessionAndRollSurviveReloadAndRelaunchWithinTimeout() {
        roll = 0.9
        val s = session(0.5)
        s.begin()
        assertFalse(s.sampled())
        s.admit(listOf(event("navigation")))

        now += 1_000
        roll = 0.0 // a fresh roll would keep the session; the persisted one must win
        val again = session(0.5)
        assertTrue("resumed, no bookends", again.begin().isEmpty())
        assertEquals("session_1", again.id())
        assertFalse(again.sampled())
    }

    @Test fun relaunchAfterTimeoutFinalizesRecordedSession() {
        val s = session(1.0)
        s.begin()
        s.admit(listOf(event("navigation")))
        now += Session.IDLE_MS + 1

        val out = session(1.0).begin()
        assertEquals(listOf("session.finalized", "session.started"), names(out))
        assertEquals(1, attrs(out[0]).getInt("session.event_count"))
    }

    @Test fun sampledOutKeepsOnlyExemptAndCountsEverythingUncounted() {
        roll = 0.9
        val s = session(0.5)
        assertFalse(attrs(s.begin()[0]).getBoolean("session.sampled"))

        val kept = s.admit(listOf(
            event("navigation"), metric("perf.lcp"), event("app.hang"), event("user.profile.update"),
            event("app.error"),
            event("app.crash"), event("app.crash", "error.cause" to "webview_terminated"),
            event("app.anr"), event("app.exit"), event("app.start"), event("sdk.health"),
        ))
        assertEquals(listOf("app.crash", "app.crash", "app.anr", "app.exit", "app.start", "sdk.health"), names(kept))
        assertEquals("S7: sampled-out drops not counted", emptyMap<String, Long>(), health.snapshot())

        now += Session.IDLE_MS + 1
        val fin = attrs(s.rotateIfIdle()[0])
        assertEquals("S6: counted before gates", 10, fin.getInt("session.event_count"))
        assertEquals(1, fin.getInt("session.metric_count"))
        assertFalse(fin.getBoolean("session.sampled"))
    }

    @Test fun sampledInAtFractionalRateSaysSo() {
        roll = 0.1
        val s = session(0.5)
        assertTrue(attrs(s.begin()[0]).getBoolean("session.sampled"))
        assertEquals(1, s.admit(listOf(event("navigation"))).size)
    }

    @Test fun sampleRateIsClamped() {
        roll = 0.0
        val none = session(-1.0)
        none.begin()
        assertFalse(none.sampled())
        store.values.clear()
        roll = 0.999
        val all = session(7.0)
        assertFalse("clamped to 1: no session.sampled", attrs(all.begin()[0]).has("session.sampled"))
        assertTrue(all.sampled())
    }

    @Test fun interactionCap() = assertCap(event("ui.interaction"), 200, "events_dropped.cap.interaction")

    @Test fun bridgeSummaryCapIsFiftyTotal() = assertCap(event("bridge.summary", "bridge.service" to "Camera"), 50, "events_dropped.cap.bridge")

    @Test fun customCapIsCombinedAcrossCustomHostMetricsAndTasks() {
        val s = session(1.0)
        s.begin()
        assertEquals(500, s.admit(repeat(event("custom.event"), 300)).size +
            s.admit(repeat(metric("checkout_ms"), 150)).size +
            s.admit(repeat(event("task.complete"), 50)).size)
        assertEquals(0, s.admit(listOf(event("custom.event"), metric("cart"), event("task.complete"))).size)
        assertEquals(1, s.admit(listOf(metric("perf.lcp"))).size)
        assertEquals(mapOf("events_dropped.cap.custom" to 3L), health.snapshot())
    }

    @Test fun errorCapPerDedupKeyThenTotal() {
        val s = session(1.0)
        s.begin()
        assertEquals(5, s.admit(repeat(crash("TypeError", "TypeError: x\n    at f (app:///main.js:1:2)"), 6)).size)
        // Same type, different top frame → own key.
        assertEquals(5, s.admit(repeat(crash("TypeError", "TypeError: x\n    at g (app:///main.js:9:9)"), 5)).size)
        for (i in 0 until 8) s.admit(repeat(crash("E$i", ""), 5))
        assertEquals("50 total", 0, s.admit(listOf(crash("New", ""))).size)
        assertEquals("app.crash never capped", 1, s.admit(listOf(event("app.crash"))).size)
        assertEquals(mapOf("events_dropped.cap.error" to 2L), health.snapshot())
    }

    @Test fun anAtSignInTheMessageIsNotTheTopFrame() {
        val s = session(1.0)
        s.begin()
        val f = crash("E", "Error: bad a@b.io\n    at f (app:///x.js:1:1)")
        val g = crash("E", "Error: bad a@b.io\n    at g (app:///x.js:2:1)")
        assertEquals("distinct frames under one message → distinct keys", 10,
            s.admit(repeat(f, 5) + repeat(g, 4) + crash("E", "g@app:///x.js:2:1")).size)
    }

    @Test fun uncappedEventsPassFreely() {
        val s = session(1.0)
        s.begin()
        assertEquals(1000, s.admit(repeat(event("http.request"), 1000)).size)
    }

    @Test fun screenCountKeepsCountingPastTheVisitedList() {
        val s = session(1.0)
        s.begin()
        s.admit(repeat(event("navigation", "navigation.to_screen" to "/a"), 60))
        now += Session.IDLE_MS + 1
        val fin = attrs(s.rotateIfIdle()[0])
        assertEquals(60, fin.getInt("session.screen_count"))
        assertEquals(50, fin.getString("session.visited_screens").split(",").size)
    }

    @Test fun capsSurviveReloadAndResetOnRotation() {
        val s = session(1.0)
        s.begin()
        s.admit(repeat(event("ui.interaction"), 200))
        val reloaded = session(1.0)
        reloaded.begin()
        assertEquals(0, reloaded.admit(listOf(event("ui.interaction"))).size)
        now += Session.IDLE_MS + 1
        assertEquals(3, reloaded.admit(listOf(event("ui.interaction"))).size)
    }

    @Test fun restartStartsFreshWithoutFinalizingAndEndForgets() {
        val s = session(1.0)
        s.begin()
        assertEquals(listOf("session.started"), names(s.restart()))
        assertEquals("session_2", s.id())
        s.end()
        assertNull(s.id())
        assertTrue(s.admit(listOf(event("navigation"))).isEmpty())
        assertEquals("ended session not finalized on relaunch", listOf("session.started"), names(session(1.0).begin()))
    }

    @Test fun capDropsReachTheWireAsSdkHealth() {
        val s = session(1.0)
        val lines = s.begin() + s.admit(repeat(event("ui.interaction"), 201))
        val outbox = Outbox(File(tmp.root, "edge_rum"), { now }, health)
        outbox.append(SenderTest.IDENTITY, lines)
        outbox.seal()
        val server = MockWebServer()
        server.start()
        try {
            val sender = Sender(outbox, health, "5.0.0", { now }, { }, longArrayOf(1))
            sender.configure("edge_k", server.url("/").toString())
            server.enqueue(MockResponse().setResponseCode(200))
            sender.drain()
            val events = JSONObject(SenderTest.gunzip(server.takeRequest())).getJSONArray("events")
            val last = events.getJSONObject(events.length() - 1)
            assertEquals("sdk.health", last.getString("eventName"))
            assertEquals(1, last.getJSONObject("attributes").getInt("events_dropped.cap.interaction"))
        } finally {
            server.shutdown()
        }
    }

    fun assertCap(e: JSONObject, limit: Int, reason: String) {
        val s = session(1.0)
        s.begin()
        assertEquals(limit, s.admit(repeat(e, limit + 2)).size)
        assertEquals(mapOf(reason to 2L), health.snapshot())
    }
}
