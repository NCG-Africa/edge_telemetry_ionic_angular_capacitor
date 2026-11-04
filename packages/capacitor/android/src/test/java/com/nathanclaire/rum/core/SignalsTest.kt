package com.nathanclaire.rum.core

import java.io.File
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SignalsTest {
    companion object {
        const val PROC_STATUS = "Name:\tfixture.app\nVmPeak:\t 2000000 kB\nVmRSS:\t  187392 kB\nThreads:\t42\n"

        /** E32: the context the plugin assembles, as one fixed device. */
        fun deviceContext(): JSONObject = JSONObject()
            .put("device.platform", "android")
            .put("device.platform_version", "16")
            .put("device.model", "Pixel 9")
            .put("device.manufacturer", "Google")
            .put("device.brand", "google")
            .put("device.android_sdk", "36")
            .put("device.android_release", "16")
            .put("device.hardware", "tokay")
            .put("device.product", "tokay")
            .put("device.locale", "en-KE")
            .put("device.timezone", "Africa/Nairobi")
            .put("device.low_ram", false)
            .put("device.cpu_abi", "arm64-v8a")
            .put("device.cpu_cores", 8)
            .put("device.screen_density", 420)
            .put("device.screen_width_px", 1080)
            .put("device.screen_height_px", 2424)
            .put("webview.version", "130.0.6723.58")
            .put("app.bundle_id", "builtin")
            .put("network.type", "wifi")

        /** Seals [lines] into one batch, sends it, and compares the body with the golden file. */
        fun assertGoldenBatch(name: String, dir: File, health: Health, now: Long, lines: List<String>) {
            val outbox = Outbox(dir, { now }, health)
            outbox.append(SenderTest.IDENTITY, lines)
            outbox.seal()
            val server = MockWebServer()
            server.start()
            try {
                val sender = Sender(outbox, health, "1.0.0", { now }, { }, longArrayOf(1))
                sender.configure("k", server.url("/").toString())
                server.enqueue(MockResponse().setResponseCode(200))
                sender.drain()
                SenderTest.assertGolden(name, SenderTest.gunzip(server.takeRequest()))
            } finally {
                server.shutdown()
            }
        }
    }

    @get:Rule val tmp = TemporaryFolder()
    val store = IdGeneratorTest.FakeStore()
    var now = 1793008802000L // 2026-10-26T10:00:02.000Z

    fun session(): Session = Session(store, Health(File(tmp.root, "edge_rum")), { now }, 1.0, { 0.0 }, { "session_1" }, { null })
        .also { it.begin() }

    @Test fun parsesRss() {
        assertEquals(187392, Signals.rssKb(PROC_STATUS))
        assertEquals(-1, Signals.rssKb("Name:\tx\n"))
        assertEquals(-1, Signals.rssKb("VmRSS:\tjunk kB\n"))
    }

    @Test fun memorySkipsMissingReadings() {
        assertEquals(2, Signals.memory(1024, 2048, "periodic", now).size)
        val pssOnly = Signals.memory(-1, 2048, "periodic", now)
        assertEquals(1, pssOnly.size)
        assertEquals(2.0, pssOnly[0].getDouble("value"), 0.0)
        assertEquals("pss", pssOnly[0].getJSONObject("attributes").getString("memory.type"))
    }

    @Test fun uiHiddenIsNotPressure() {
        assertNull(Signals.pressure(20, 1, now))
        assertNull(Signals.pressure(7, 1, now))
        assertFalse(Signals.pressure(15, -1, now)!!.getJSONObject("attributes").has("memory.usage_mb"))
    }

    @Test fun bundleIdIsLastPathSegmentOrBuiltin() {
        assertEquals("builtin", Signals.bundleId(null))
        assertEquals("builtin", Signals.bundleId(""))
        assertEquals("1.2.3", Signals.bundleId("/data/user/0/app/files/versions/1.2.3"))
        assertEquals("abc", Signals.bundleId("/data/user/0/app/files/abc/"))
    }

    @Test fun contextStampedButEventKeysWin() {
        val s = session()
        val ctx = JSONObject().put("device.model", "Pixel 9").put("network.type", "wifi")
        s.context { ctx }
        val e = JSONObject(s.admit(listOf(Signals.network("wifi", "cellular", now)))[0])
        assertEquals("Pixel 9", e.getJSONObject("attributes").getString("device.model"))
        assertEquals("cellular", e.getJSONObject("attributes").getString("network.type"))
    }

    @Test fun passiveSignalsNeitherRotateNorCountAsActivity() {
        val s = session()
        now += Session.IDLE_MS / 2 + 1
        assertEquals(listOf("network_change"), SessionTest.names(s.admitPassive(listOf(Signals.network("wifi", "none", now)))))
        now += Session.IDLE_MS / 2 + 1
        val late = s.admitPassive(listOf(Signals.pressure(15, 1, now)!!))
        assertEquals("no rotation from the background", listOf("memory_pressure"), SessionTest.names(late))
        assertEquals("session_1", SessionTest.attrs(late[0]).getString("session.id"))
        assertEquals(
            listOf("session.finalized", "session.started", "custom_event"),
            SessionTest.names(s.admit(listOf(SessionTest.event("custom_event")))),
        )
    }

    @Test fun goldenBatches() {
        val dir = File(tmp.root, "edge_rum")
        val health = Health(dir)
        val session = session()
        val ctx = deviceContext()
        session.context { ctx }
        assertGoldenBatch("app-lifecycle.json", dir, health, now, session.admit(listOf(Signals.lifecycle("backgrounded", now))))
        session.context { JSONObject() }
        assertGoldenBatch("memory-usage.json", dir, health, now, session.admit(Signals.memory(187392, 143360, "session_start", now)))
        assertGoldenBatch("memory-pressure.json", dir, health, now, session.admit(listOf(Signals.pressure(15, 187392, now)!!)))
        assertGoldenBatch("network-change.json", dir, health, now, session.admit(listOf(Signals.network("wifi", "none", now))))
    }
}
