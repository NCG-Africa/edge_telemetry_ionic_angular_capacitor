package com.nathanclaire.rum.core

import java.io.File
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ExitsTest {
    @get:Rule val tmp = TemporaryFolder()
    val store = IdGeneratorTest.FakeStore()
    val now = 1793008802000L // 2026-10-26T10:00:02.000Z

    // Newest first, as the OS returns them.
    val anr = Exits.Record(6, 100, 0, "user request after error: Input dispatching timed out",
        51_200, 102_400, 1793008700000L, "----- pid 4242 -----\n\"main\" prio=5 tid=1 Native\n")
    val swiped = Exits.Record(10, 400, 0, null, 40_000, 90_000, 1793008600000L, null)

    @Test fun eachRecordOnce() {
        assertEquals(2, Exits.harvest(listOf(anr, swiped), store, now).size)
        assertEquals(0, Exits.harvest(listOf(anr, swiped), store, now).size)
        val later = Exits.Record(4, 100, 0, "crash", 1, 1, 1793008800000L, null)
        val out = Exits.harvest(listOf(later, anr, swiped), store, now)
        assertEquals(1, out.size)
        assertEquals("crash", out[0].getJSONObject("attributes").getString("exit.reason"))
    }

    @Test fun mapsUnknownCodesAndCapsTrace() {
        val big = "frame\n".repeat(1000)
        val a = Exits.harvest(listOf(Exits.Record(99, 7, 0, null, 0, 0, 1, big)), store, now)[0].getJSONObject("attributes")
        assertEquals("unknown_99", a.getString("exit.reason"))
        assertEquals(7, a.getInt("exit.importance"))
        assertFalse("R15: null omitted", a.has("exit.description"))
        assertTrue(a.getString("exit.trace").endsWith("…[trace truncated]"))
    }

    @Test fun unreadableWatermarkResendsRatherThanLoses() {
        store.values[Exits.KEY_WATERMARK] = "garbage"
        assertEquals(2, Exits.harvest(listOf(anr, swiped), store, now).size)
    }

    @Test fun goldenBatch() {
        val dir = File(tmp.root, "edge_rum")
        val health = Health(dir)
        val session = Session(store, health, { now }, 1.0, { 0.0 }, { "session_1" }, { null })
        session.begin()
        val lines = session.admit(Exits.harvest(listOf(anr, swiped), store, now))
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
            SenderTest.dumpGolden("app-exit.json", SenderTest.gunzip(server.takeRequest()))
        } finally {
            server.shutdown()
        }
    }
}
