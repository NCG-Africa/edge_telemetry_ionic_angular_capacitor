package com.nathanclaire.rum.core

import java.io.File
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CrashTest {
    companion object {
        /** The build that crashed; the relaunch runs [SenderTest.IDENTITY] (1.4.2). */
        val CRASHED_IDENTITY = SenderTest.IDENTITY.replace("1.4.2", "1.4.1").replace("\"142\"", "\"141\"")
        const val NDK_REPORT = "signal 11\ncode 1\nfault_addr 0\ntime_ms 1793008801500\npid 4242\ntid 4242\n" +
            "thread fixture.app\n" +
            "frame 1a2c 4f6e8a0b1c2d3e4f5a6b7c8d9e0f1a2b /data/app/~~x/com.nathanclaire.rum.fixture-y/lib/arm64/libgame.so\n" +
            "frame 9f10 - /system/lib64/libc.so\n"
        val ROOT: JSONObject = JSONObject()
            .put("trace.id", "4bf92f3577b34da6a3ce929d0e0e4736")
            .put("rum.action.id", "00f067aa0ba902b7")
            .put("trace.root_type", "interaction")

        fun payload(crumbs: Int, screen: String?): JSONObject {
            val b = JSONArray()
            for (i in 0 until crumbs) b.put(JSONObject().put("category", "navigation").put("message", "crumb $i"))
            val events = JSONArray()
            if (screen != null) events.put(SessionTest.event("navigation", "navigation.to_screen" to screen))
            return JSONObject().put("events", events).put("breadcrumbs", b)
        }

        fun fixedException(): IllegalStateException {
            val e = IllegalStateException("cart is null", NullPointerException("item"))
            e.stackTrace = arrayOf(
                StackTraceElement("com.fixture.Cart", "total", "Cart.java", 42),
                StackTraceElement("android.os.Handler", "dispatchMessage", "Handler.java", 102),
            )
            e.cause!!.stackTrace = arrayOf()
            return e
        }
    }

    @get:Rule val tmp = TemporaryFolder()
    val store = IdGeneratorTest.FakeStore()
    val main = Thread("main")
    var now = 1793008802000L // 2026-10-26T10:00:02.000Z
    lateinit var dir: File
    lateinit var health: Health
    lateinit var session: Session
    lateinit var crash: Crash
    lateinit var outbox: Outbox
    val server = MockWebServer()
    var original: Thread.UncaughtExceptionHandler? = null

    @Before fun setUp() {
        original = Thread.getDefaultUncaughtExceptionHandler()
        dir = File(tmp.root, "edge_rum")
        health = Health(dir)
        session = Session(store, health, { now }, 1.0, { 0.0 }, { "session_1" }, { "u1" })
        session.begin()
        crash = Crash(dir, main) { now }
        outbox = Outbox(dir, { now }, health)
        server.start()
    }

    @After fun tearDown() {
        Thread.setDefaultUncaughtExceptionHandler(original)
        server.shutdown()
    }

    /** The plugin's `solo()`: session gate, then a segment of its own. */
    fun solo(event: JSONObject, identity: String = SenderTest.IDENTITY) {
        for (line in session.admit(listOf(event))) outbox.writeSolo(identity, line)
    }

    /** Next launch: a fresh outbox seals leftovers; drains everything; one body per batch. */
    fun relaunchAndSend(): List<String> {
        now += 1_000
        val outbox = Outbox(dir, { now }, health)
        val sender = Sender(outbox, health, "1.0.0", { now }, { }, longArrayOf(1))
        sender.configure("k", server.url("/").toString())
        val n = outbox.sealed().size
        repeat(n) { server.enqueue(MockResponse().setResponseCode(200)) }
        sender.drain()
        return List(n) { SenderTest.gunzip(server.takeRequest()) }
    }

    fun attrs(e: JSONObject): JSONObject = e.getJSONObject("attributes")

    @Test fun jvmCrashIsSoloSegmentReplayedNextLaunchInItsOwnBatchWithoutHealth() {
        crash.mirror(payload(2, "/cart"))
        now -= 1_000
        crash.setRoot(ROOT)
        now += 1_000
        outbox.append(SenderTest.IDENTITY, session.admit(listOf(SessionTest.event("navigation"))))
        health.count("outbox_full", 3)

        solo(crash.jvm(main, fixedException()))
        val bodies = relaunchAndSend()

        assertEquals("crash batch + the open segment sealed at relaunch", 2, bodies.size)
        SenderTest.assertGolden("app-crash-jvm.json", bodies[0])
        val events = JSONObject(bodies[1]).getJSONArray("events")
        assertEquals("sdk.health rides the normal batch", "sdk.health", events.getJSONObject(events.length() - 1).getString("eventName"))
    }

    @Test fun installJvmChainsToThePreviousHandler() {
        val order = mutableListOf<String>()
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> order.add("previous") }
        val sunk = mutableListOf<JSONObject>()
        crash.installJvm {
            order.add("sink")
            sunk.add(it)
        }
        Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(Thread("worker"), fixedException())

        assertEquals(listOf("sink", "previous"), order)
        assertEquals("worker", attrs(sunk[0]).getString("crash_thread"))
        assertFalse(attrs(sunk[0]).getBoolean("crash_is_main_thread"))
    }

    @Test fun failingSinkStillChains() {
        val order = mutableListOf<String>()
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> order.add("previous") }
        crash.installJvm { throw IllegalStateException("disk full") }
        Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(main, fixedException())
        assertEquals(listOf("previous"), order)
    }

    @Test fun breadcrumbRingKeepsLastFifty() {
        crash.mirror(payload(40, "/a"))
        crash.mirror(payload(30, null))
        val crumbs = JSONArray(attrs(crash.jvm(main, fixedException())).getString("crash.breadcrumbs"))
        assertEquals(Crash.BREADCRUMBS, crumbs.length())
        assertEquals("crumb 20", crumbs.getJSONObject(0).getString("message"))
        assertEquals("crumb 29", crumbs.getJSONObject(49).getString("message"))
    }

    @Test fun setLastScreenOverridesMirroredScreen() {
        crash.mirror(payload(0, "/a"))
        crash.screen("/b")
        assertEquals("/b", attrs(crash.jvm(main, fixedException())).getString("screen_name"))
    }

    @Test fun ndkCrashReplaysNextLaunchUnderTheCrashedBuildsIdentityWithStaleRoot() {
        crash.mirror(payload(1, "/checkout"))
        now = 1793008790000L // 11.5 s before the report's time_ms: past the root cap
        crash.setRoot(ROOT)
        crash.saveContext(CRASHED_IDENTITY, "session_1", "u1")
        File(crash.ndkReportPath()).writeText(NDK_REPORT)
        now = 1793008802000L

        val next = Crash(dir, main) { now }
        val p = next.takeNdk()!!
        assertEquals(CRASHED_IDENTITY, p.identity)
        assertNull("report consumed", next.takeNdk())
        outbox.writeSolo(p.identity, p.event)
        SenderTest.assertGolden("app-crash-ndk.json", relaunchAndSend()[0])
    }

    @Test fun tornNdkReportIsDropped() {
        crash.saveContext(CRASHED_IDENTITY, "session_1", null)
        File(crash.ndkReportPath()).writeText("sig")
        assertNull(crash.takeNdk())
        assertFalse(File(crash.ndkReportPath()).exists())
    }

    @Test fun ndkFrameNamesAndMainThread() {
        val a = attrs(Crash.ndk(NDK_REPORT.replace("tid 4242", "tid 4300"), JSONObject()))
        assertEquals("libgame.so+0x1a2c", a.getString("error_context"))
        assertFalse(a.getBoolean("crash_is_main_thread"))
        assertTrue(a.getString("stacktrace").startsWith("#00 pc 0000000000001a2c  /data/app/"))
        assertFalse("no root, no trace keys", a.has("trace.id"))
    }

    @Test fun clearForgetsEverything() {
        crash.mirror(payload(3, "/a"))
        crash.setRoot(ROOT)
        crash.saveContext(CRASHED_IDENTITY, "session_1", null)
        File(crash.ndkReportPath()).writeText(NDK_REPORT)
        crash.clear()
        assertNull(crash.takeNdk())
        val a = attrs(crash.jvm(main, fixedException()))
        assertEquals("[]", a.getString("crash.breadcrumbs"))
        assertFalse(a.has("screen_name"))
        assertFalse(a.has("trace.id"))
    }

    @Test fun anrAndHangGoldenBatches() {
        crash.mirror(payload(0, "/cart"))
        crash.setRoot(ROOT)
        val stack = "at android.os.MessageQueue.nativePollOnce(Native Method)\nat com.fixture.Cart.total(Cart.java:42)\n"
        solo(crash.stall("app.hang", 2_100, stack))
        now += 1
        crash.setRoot(null) // JS cleared it (background): ids kept, flagged stale
        solo(crash.stall("app.anr", 5_000, stack))
        val bodies = relaunchAndSend()
        SenderTest.assertGolden("app-hang.json", bodies[0])
        SenderTest.assertGolden("app-anr.json", bodies[1])
    }

    /** E13: renderer death is a solo segment, replayed next launch, exempt from a sampled-out session (S2). */
    @Test fun webViewDeathIsExemptSoloSegmentGoldenBatch() {
        session = Session(store, health, { now }, 0.0, { 0.9 }, { "session_1" }, { "u1" })
        session.restart()
        crash.mirror(payload(1, "/checkout"))
        crash.setRoot(ROOT)
        solo(crash.webViewTerminated("crash"))
        SenderTest.assertGolden("app-crash-webview.json", relaunchAndSend()[0])
        assertEquals("oom_killed", attrs(crash.webViewTerminated("oom_killed")).getString("webview.reason"))
    }

    @Test fun rootIsLiveUpToTheIdleLineAtTheEvent() {
        crash.setRoot(ROOT)
        now += Crash.ROOT_IDLE_MS
        assertFalse(attrs(crash.jvm(main, fixedException())).has("trace.root_expired"))
        now += 1
        assertTrue(attrs(crash.jvm(main, fixedException())).getBoolean("trace.root_expired"))
        crash.setRoot(ROOT)
        assertFalse("a new root is live again", attrs(crash.jvm(main, fixedException())).has("trace.root_expired"))
    }

    @Test fun launchRootIsIdleExemptUpToTheCap() {
        crash.setRoot(JSONObject(ROOT.toString()).put("trace.root_type", "launch"))
        now += Crash.ROOT_CAP_MS
        assertFalse(attrs(crash.jvm(main, fixedException())).has("trace.root_expired"))
        now += 1
        assertTrue(attrs(crash.jvm(main, fixedException())).getBoolean("trace.root_expired"))
    }

    @Test fun stallIsJudgedWhenTheMainThreadBlocked() {
        crash.setRoot(ROOT)
        now += 5_000 // ANR seen 5 s into a stall that began right after the tap
        assertFalse(attrs(crash.stall("app.anr", 5_000, "")).has("trace.root_expired"))
        assertTrue("hang that began 3 s after the tap", attrs(crash.stall("app.hang", 2_000, "")).getBoolean("trace.root_expired"))
    }

    @Test fun clearingWithNoRootStaysUnannotated() {
        crash.setRoot(null)
        crash.setRoot(JSONObject())
        assertFalse(attrs(crash.jvm(main, fixedException())).has("trace.id"))
    }

    @Test fun sampledOutSessionKeepsAnrDropsHang() {
        store.values.clear()
        session = Session(store, health, { now }, 0.5, { 0.9 }, { "session_2" }, { null })
        session.begin()
        solo(crash.stall("app.hang", 2_000, ""))
        solo(crash.stall("app.anr", 5_000, ""))
        val sealed = outbox.sealed()
        assertEquals(1, sealed.size)
        assertTrue(outbox.read(sealed[0]).events[0].contains("\"app.anr\""))
    }
}
