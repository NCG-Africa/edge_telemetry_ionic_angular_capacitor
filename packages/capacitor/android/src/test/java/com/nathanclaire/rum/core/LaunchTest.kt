package com.nathanclaire.rum.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LaunchTest {
    companion object {
        const val T0 = 1793008800000L // 2026-10-26T10:00:00.000Z, process start
    }

    @get:Rule val tmp = TemporaryFolder()
    val store = IdGeneratorTest.FakeStore()
    val launch = Launch(T0, T0 + 120)

    fun pagePhases() {
        assertNull(launch.mark("responseEnd", T0 + 300))
        assertNull(launch.mark("DOMContentLoaded", T0 + 450))
        assertNull(launch.mark("load", T0 + 600))
    }

    @Test fun bridgeReadyAloneWaitsForTheWindow() {
        pagePhases()
        assertNull("markReady may still come", launch.mark("bridgeReady", T0 + 700))
        val a = launch.finish()!!.getJSONObject("attributes")
        assertEquals(700, a.getLong("app.start.duration_ms"))
        assertEquals(120, a.getLong("app.start.webview_created_ms"))
        assertFalse(a.has("app.start.mark_ready_ms"))
        assertNull("once per launch", launch.finish())
    }

    @Test fun markReadyInsideWindowCompletesIt() {
        pagePhases()
        launch.mark("bridgeReady", T0 + 700)
        val e = launch.mark("markReady", T0 + 2000)!!
        assertEquals(2000, e.getJSONObject("attributes").getLong("app.start.duration_ms"))
        assertEquals(Sender.rfc3339(T0 + 2000), e.getString("timestamp"))
        assertNull(launch.finish())
    }

    @Test fun markReadyBeforeBridgeReadyCountsAtBridgeReady() {
        assertNull(launch.mark("markReady", T0 + 500))
        assertNotNull(launch.mark("bridgeReady", T0 + 700))
    }

    @Test fun lateMarkReadyIgnored() {
        launch.mark("bridgeReady", T0 + 700)
        assertNull(launch.mark("markReady", T0 + 700 + Launch.READY_WINDOW_MS + 1))
        assertFalse(launch.finish()!!.getJSONObject("attributes").has("app.start.mark_ready_ms"))
    }

    @Test fun reloadUnknownAndCordovaPhasesIgnored() {
        launch.mark("load", T0 + 600)
        launch.mark("load", T0 + 9000)
        launch.mark("bogus", T0 + 1)
        assertNull("A5: no deviceready on Capacitor", launch.mark("deviceready", T0 + 650))
        assertNull(launch.mark(null, T0 + 1))
        assertNull("no bridgeReady, no app.start", launch.finish())
        launch.mark("bridgeReady", T0 + 700)
        val a = launch.finish()!!.getJSONObject("attributes")
        assertEquals(600, a.getLong("app.start.load_ms"))
        assertFalse(a.has("app.start.deviceready_ms"))
    }

    @Test fun goldenBatch() {
        val now = T0 + 2000
        val dir = File(tmp.root, "edge_rum")
        val health = Health(dir)
        // S2: exempt, so it survives a sampled-out session.
        val session = Session(store, health, { now }, 0.0, { 0.9 }, { "session_1" }, { null })
        session.begin()
        pagePhases()
        launch.mark("bridgeReady", T0 + 700)
        val lines = session.admit(listOf(launch.mark("markReady", T0 + 1500)!!))
        SignalsTest.assertGoldenBatch("app-start.json", dir, health, now, lines)
    }
}
