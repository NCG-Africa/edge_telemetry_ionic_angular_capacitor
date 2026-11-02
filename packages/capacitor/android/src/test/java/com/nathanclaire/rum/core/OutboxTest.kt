package com.nathanclaire.rum.core

import java.io.File
import java.io.FileOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OutboxTest {
    companion object {
        const val ID_V1 = """{"app":{"package_name":"com.x","platform":"android","version":"1.0"},"device_id":"d1"}"""
        const val ID_V2 = """{"app":{"package_name":"com.x","platform":"android","version":"2.0"},"device_id":"d1"}"""

        fun events(n: Int) = List(n) { """{"type":"event","eventName":"e$it"}""" }
    }

    @get:Rule val tmp = TemporaryFolder()
    var now = 1_700_000_000_000L
    lateinit var dir: File
    lateinit var health: Health
    lateinit var outbox: Outbox

    @Before fun setUp() {
        dir = File(tmp.root, "edge_rum")
        health = Health(dir)
        outbox = Outbox(dir, { now }, health)
    }

    @Test fun sealsAtFiftyEventsSplittingLargeHandOffs() {
        outbox.append(ID_V1, events(120))
        val sealed = outbox.sealed()
        assertEquals(2, sealed.size)
        assertEquals(50, outbox.read(sealed[0]).events.size)
        assertEquals(50, outbox.read(sealed[1]).events.size)
        outbox.seal()
        assertEquals(20, outbox.read(outbox.sealed()[2]).events.size)
    }

    @Test fun sealsThirtySecondsAfterFirstEvent() {
        outbox.append(ID_V1, events(1))
        now += 29_999
        outbox.sealIfDue()
        assertTrue(outbox.sealed().isEmpty())
        now += 1
        outbox.sealIfDue()
        assertEquals(1, outbox.sealed().size)
    }

    @Test fun nextLaunchSealsLeftoversAndKeepsOrder() {
        outbox.append(ID_V1, events(3))
        outbox.seal()
        now += 10
        outbox.append(ID_V1, events(2))
        val relaunched = Outbox(dir, { now + 1 }, health)
        val sealed = relaunched.sealed()
        assertEquals(2, sealed.size)
        assertEquals(3, relaunched.read(sealed[0]).events.size)
        assertEquals(2, relaunched.read(sealed[1]).events.size)
    }

    @Test fun identityIsFrozenInTheFirstLine() {
        outbox.append(ID_V1, events(1))
        outbox.append(ID_V2, events(1))
        outbox.seal()
        val seg = outbox.read(outbox.sealed()[0])
        assertEquals(ID_V1, seg.identity)
        assertEquals(2, seg.events.size)
    }

    @Test fun tornTrailingLineIsDiscarded() {
        outbox.append(ID_V1, events(2))
        FileOutputStream(File(dir, "open.ndjson.part"), true).use { it.write("""{"type":"ev""".toByteArray()) }
        val relaunched = Outbox(dir, { now }, health)
        assertEquals(events(2), relaunched.read(relaunched.sealed()[0]).events)
    }

    @Test fun dropsSegmentsOlderThanSevenDays() {
        outbox.append(ID_V1, events(4))
        outbox.seal()
        now += Outbox.MAX_AGE_MS + 1
        outbox.append(ID_V1, events(1))
        outbox.seal()
        assertEquals(1, outbox.sealed().size)
        assertEquals(mapOf("events_dropped.expired" to 4L), health.snapshot())
    }

    @Test fun capsSkipTheSegmentBeingSent() {
        outbox.append(ID_V1, events(4))
        outbox.seal()
        val inFlight = outbox.sealed()[0]
        outbox.sending(inFlight)
        now += Outbox.MAX_AGE_MS + 1
        outbox.seal()
        assertTrue(inFlight.exists())
        assertEquals(emptyMap<String, Long>(), health.snapshot())
    }

    @Test fun segmentCountCapDropsOldest() {
        for (i in 0 until Outbox.MAX_SEGMENTS + 2) {
            now++
            outbox.append(ID_V1, listOf("""{"n":$i}"""))
            outbox.seal()
        }
        val sealed = outbox.sealed()
        assertEquals(Outbox.MAX_SEGMENTS, sealed.size)
        assertEquals("""{"n":2}""", outbox.read(sealed[0]).events[0])
        assertEquals(mapOf("events_dropped.outbox_full" to 2L), health.snapshot())
    }

    @Test fun byteCapDropsOldest() {
        val event = """{"pad":"${"x".repeat(1024 * 1024)}"}"""
        repeat(6) {
            now++
            outbox.append(ID_V1, listOf(event))
            outbox.seal()
        }
        assertEquals(4, outbox.sealed().size)
        assertEquals(mapOf("events_dropped.outbox_full" to 2L), health.snapshot())
    }

    @Test fun healthSurvivesRelaunchAndSubtractsWhatWasSent() {
        health.count("expired", 3)
        val reloaded = Health(dir)
        assertEquals(mapOf("events_dropped.expired" to 3L), reloaded.snapshot())
        reloaded.count("expired", 2)
        reloaded.subtract(mapOf("events_dropped.expired" to 3L))
        assertEquals(mapOf("events_dropped.expired" to 2L), Health(dir).snapshot())
    }

    @Test fun failedSealDoesNotStallAppends() {
        outbox.append(ID_V1, events(Outbox.SEAL_EVENTS - 1))
        dir.setWritable(false) // rename into the dir fails, so the seal at 50 can't happen
        try {
            outbox.append(ID_V1, events(3))
        } finally {
            dir.setWritable(true)
        }
        outbox.seal()
        assertEquals(52, outbox.read(outbox.sealed()[0]).events.size)
    }
}
