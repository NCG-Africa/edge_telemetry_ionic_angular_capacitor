package com.nathanclaire.rum.core

import org.junit.Assert.assertEquals
import org.junit.Test

class WatchdogTest {
    var now = 0L
    val posted = mutableListOf<Runnable>()
    val fired = mutableListOf<String>()

    fun watchdog(hangMs: Long, anrMs: Long) = Watchdog(hangMs, anrMs, { posted.add(it) }, { now }, { "at main" },
        { _, ms -> fired.add("hang $ms") }, { _, ms -> fired.add("anr $ms") })

    /** Scans every 1 s of a stall of [ms], main thread never answering. */
    fun stall(w: Watchdog, ms: Long) {
        w.scanOnce()
        var t = 0L
        while (t < ms) {
            now += 1_000
            w.scanOnce()
            t += 1_000
        }
    }

    @Test fun oneStallPastBothLinesFiresEachOnce() {
        stall(watchdog(2_000, 5_000), 7_000)
        assertEquals(listOf("hang 2000", "anr 5000"), fired)
    }

    @Test fun belowTheHangLineNothingFires() {
        stall(watchdog(2_000, 5_000), 1_000)
        assertEquals(emptyList<String>(), fired)
    }

    @Test fun answeredHeartbeatRearmsForTheNextStall() {
        val w = watchdog(2_000, 5_000)
        stall(w, 3_000)
        posted[0].run() // main thread free again
        stall(w, 2_000)
        assertEquals(listOf("hang 2000", "hang 2000"), fired)
        assertEquals("one heartbeat per stall", 2, posted.size)
    }

    @Test fun configuredThresholdsAndOffSwitches() {
        stall(watchdog(0, 3_000), 4_000)
        assertEquals(listOf("anr 3000"), fired)
        fired.clear()
        stall(watchdog(1_000, 0), 4_000)
        assertEquals(listOf("hang 1000"), fired)
    }

    @Test fun intervalIsHalfTheLowestEnabledLine() {
        assertEquals(1_000, watchdog(2_000, 5_000).intervalMs())
        assertEquals(2_500, watchdog(0, 5_000).intervalMs())
        assertEquals("both off: never started", 0, watchdog(0, 0).intervalMs())
    }
}
