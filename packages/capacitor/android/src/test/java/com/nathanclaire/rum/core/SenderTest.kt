package com.nathanclaire.rum.core

import java.io.File
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SenderTest {
    companion object {
        const val IDENTITY = """{"app":{"name":"Fixture","package_name":"com.nathanclaire.rum.fixture",""" +
            """"platform":"android","version":"1.4.2","build_number":"142"},"device_id":"device_1700000000000_0123456789abcdef_android"}"""
        val EVENTS = listOf(
            """{"type":"event","eventName":"navigation","timestamp":"2026-10-26T10:00:00.000Z","attributes":{"navigation.to_screen":"/home"}}""",
            """{"type":"metric","metricName":"LCP","value":812.5,"timestamp":"2026-10-26T10:00:01.000Z","attributes":{}}""",
        )

        fun gunzip(req: RecordedRequest): String =
            GZIPInputStream(req.body.inputStream()).use { it.readBytes().toString(Charsets.UTF_8) }

        fun golden(name: String): JSONObject =
            JSONObject(SenderTest::class.java.getResourceAsStream("/golden/$name")!!.use { it.readBytes().toString(Charsets.UTF_8) })

        /** Key order is part of the snapshot: the envelope is written in a fixed order. */
        fun assertGolden(name: String, body: String) =
            assertEquals("$name drifted", golden(name).toString(2), JSONObject(body).toString(2))
    }

    @get:Rule val tmp = TemporaryFolder()
    val server = MockWebServer()
    var now = 1793008802000L // 2026-10-26T10:00:02.000Z
    val sleeps = mutableListOf<Long>()
    lateinit var health: Health
    lateinit var outbox: Outbox
    lateinit var sender: Sender

    @Before fun setUp() {
        server.start()
        val dir = File(tmp.root, "edge_rum")
        health = Health(dir)
        outbox = Outbox(dir, { now }, health)
        sender = Sender(outbox, health, "1.0.0", { now }, { sleeps.add(it); now += it }, longArrayOf(1000, 4000, 16000))
        sender.configure("edge_key_secret", server.url("/telemetry").toString())
    }

    @After fun tearDown() = server.shutdown()

    fun sealedBatch() {
        outbox.append(IDENTITY, EVENTS)
        outbox.seal()
    }

    @Test fun postsGzippedContractFourEnvelopeMatchingGolden() {
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(202))
        sender.drain()

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/telemetry", req.path)
        assertEquals("gzip", req.getHeader("Content-Encoding"))
        assertEquals("application/json", req.getHeader("Content-Type"))
        assertEquals("edge_key_secret", req.getHeader("X-API-Key"))
        assertGolden("batch.json", gunzip(req))
        assertTrue(outbox.sealed().isEmpty())
    }

    @Test fun appendsSdkHealthWithDropCountsMatchingGolden() {
        health.count("outbox_full", 7)
        health.count("rejected", 2)
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()

        assertGolden("sdk-health.json", gunzip(server.takeRequest()))
        assertEquals(emptyMap<String, Long>(), health.snapshot())
    }

    @Test fun failedSendKeepsDropCountsForTheNextBatch() {
        health.count("expired", 3)
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(400))
        sender.drain()
        assertEquals(mapOf("events_dropped.expired" to 3L, "events_dropped.rejected" to 2L), health.snapshot())
    }

    @Test fun restampsTimestampPerAttempt() {
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()

        assertEquals("2026-10-26T10:00:02.000Z", JSONObject(gunzip(server.takeRequest())).getString("timestamp"))
        val second = JSONObject(gunzip(server.takeRequest())).getString("timestamp")
        assertTrue(second, second >= "2026-10-26T10:00:03.000Z")
    }

    @Test fun retriesThreeTimesWithBackoffThenParks() {
        sealedBatch()
        repeat(4) { server.enqueue(MockResponse().setResponseCode(500)) }
        sender.drain()

        assertEquals(4, server.requestCount)
        assertEquals(3, sleeps.size)
        assertTrue(sleeps[0] in 1000..1250)
        assertTrue(sleeps[1] in 4000..5000)
        assertTrue(sleeps[2] in 16000..20000)
        assertEquals(1, outbox.sealed().size)

        // Parked: the next trigger inside the backoff does not resend it.
        sender.drain()
        assertEquals(4, server.requestCount)

        now += Sender.PARK_MS
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()
        assertEquals(5, server.requestCount)
        assertTrue(outbox.sealed().isEmpty())
    }

    @Test fun replaysSegmentsLeftByAPreviousProcess() {
        outbox.append(IDENTITY, EVENTS) // open, never sealed: the process died here
        val dir = File(tmp.root, "edge_rum")
        val relaunched = Outbox(dir, { now }, health)
        val next = Sender(relaunched, health, "1.0.0", { now }, { }, longArrayOf(1))
        next.configure("k", server.url("/").toString())
        server.enqueue(MockResponse().setResponseCode(200))
        next.drain()
        assertEquals(2, JSONObject(gunzip(server.takeRequest())).getJSONArray("events").length())
        assertTrue(relaunched.sealed().isEmpty())
    }

    @Test fun parkedSegmentDoesNotBlockNewerOnes() {
        sealedBatch()
        repeat(4) { server.enqueue(MockResponse().setResponseCode(429)) }
        sender.drain()
        now += 1
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()

        assertEquals(5, server.requestCount)
        assertEquals(1, outbox.sealed().size)
    }

    @Test fun honoursRetryAfter() {
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "10"))
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()
        assertEquals(listOf(10_000L), sleeps)
    }

    @Test fun longRetryAfterParksForThatLong() {
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "3600"))
        sender.drain()
        assertTrue(sleeps.isEmpty())

        now += 3_599_000
        sender.drain()
        assertEquals(1, server.requestCount)

        now += 1_000
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()
        assertTrue(outbox.sealed().isEmpty())
    }

    @Test fun networkErrorIsRetried() {
        sealedBatch()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()
        assertEquals(1, sleeps.size)
        assertTrue(outbox.sealed().isEmpty())
    }

    @Test fun otherFourXxDeletesAndCounts() {
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(400))
        sender.drain()

        assertEquals(1, server.requestCount)
        assertTrue(sleeps.isEmpty())
        assertTrue(outbox.sealed().isEmpty())
        assertEquals(mapOf("events_dropped.rejected" to 2L), health.snapshot())
    }

    @Test fun sendsOldestFirst() {
        outbox.append(IDENTITY, listOf("""{"n":1}"""))
        outbox.seal()
        now += 1
        outbox.append(IDENTITY, listOf("""{"n":2}"""))
        outbox.seal()
        server.enqueue(MockResponse().setResponseCode(200))
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()

        assertEquals(1, JSONObject(gunzip(server.takeRequest())).getJSONArray("events").getJSONObject(0).getInt("n"))
        assertEquals(2, JSONObject(gunzip(server.takeRequest())).getJSONArray("events").getJSONObject(0).getInt("n"))
    }

    @Test fun holdsSegmentsUntilConfigured() {
        sender = Sender(outbox, health, "1.0.0")
        sealedBatch()
        sender.configure(null, server.url("/telemetry").toString())
        sender.drain()
        assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
        assertEquals(1, outbox.sealed().size)
    }

    @Test fun configureKeepsTheValueItIsNotGiven() {
        sender.configure("  ", null)
        sender.configure(" edge_new ", "")
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(200))
        sender.drain()
        val req = server.takeRequest()
        assertEquals("edge_new", req.getHeader("X-API-Key"))
        assertEquals("/telemetry", req.path)
    }

    @Test fun identityLineOmitsUnknownVersion() {
        val id = JSONObject(Sender.identityLine("App", "com.x", null, null, "d1"))
        assertEquals("""{"name":"App","package_name":"com.x","platform":"android"}""", id.getJSONObject("app").toString())
        assertEquals("d1", id.getString("device_id"))
    }

    @Test fun corruptIdentityIsDroppedAndCounted() {
        outbox.append("{not json", EVENTS)
        outbox.seal()
        sender.drain()
        assertEquals(0, server.requestCount)
        assertTrue(outbox.sealed().isEmpty())
        assertEquals(mapOf("events_dropped.corrupt" to 2L), health.snapshot())
    }

    @Test fun triggerRunsOffTheCallerThread() {
        sealedBatch()
        server.enqueue(MockResponse().setResponseCode(200))
        sender.trigger()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
    }
}
