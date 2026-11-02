package com.nathanclaire.rum.core

/**
 * Spec E14, E15 (= Cordova `Watchdog`): main-thread watchdog. A daemon thread posts a heartbeat to
 * the main looper; how long it takes to run is read against the hang line (C1 `hangTimeoutMs`) and
 * the ANR line (`anrTimeoutMs`). One stall past both fires both, once each; the latches clear when
 * the main thread answers. A threshold ≤ 0 is off. Foreground only: started on resume, stopped on pause.
 */
class Watchdog(
    private val hangMs: Long,
    private val anrMs: Long,
    private val postToMain: (Runnable) -> Unit,
    private val clock: () -> Long,
    private val mainStack: () -> String,
    private val onHang: (stack: String, ms: Long) -> Unit,
    private val onAnr: (stack: String, ms: Long) -> Unit,
) {
    @Volatile private var waiting = false
    @Volatile private var pendingSince = 0L
    @Volatile private var hangFired = false
    @Volatile private var anrFired = false
    private var worker: Thread? = null

    private val pong = Runnable {
        waiting = false
        hangFired = false
        anrFired = false
    }

    /** Half the lowest enabled line, so a stall at the line is seen within one scan; 0 when both are off. */
    fun intervalMs(): Long {
        val lowest = minOf(if (hangMs > 0) hangMs else Long.MAX_VALUE, if (anrMs > 0) anrMs else Long.MAX_VALUE)
        return if (lowest == Long.MAX_VALUE) 0 else maxOf(1, lowest / 2)
    }

    @Synchronized
    fun start() {
        val interval = intervalMs()
        if (worker != null || interval == 0L) return
        waiting = false
        worker = Thread({
            while (!Thread.currentThread().isInterrupted) {
                scanOnce()
                try {
                    Thread.sleep(interval)
                } catch (e: InterruptedException) {
                    return@Thread
                }
            }
        }, "edge-rum-watchdog").apply {
            isDaemon = true
            start()
        }
    }

    @Synchronized
    fun stop() {
        worker?.interrupt()
        worker = null
    }

    /** One heartbeat cycle; tests drive it with a fake clock. */
    fun scanOnce() {
        if (!waiting) {
            waiting = true
            hangFired = false
            anrFired = false
            pendingSince = clock()
            postToMain(pong)
            return
        }
        val blocked = clock() - pendingSince
        val hang = hangMs > 0 && !hangFired && blocked >= hangMs
        val anr = anrMs > 0 && !anrFired && blocked >= anrMs
        if (!hang && !anr) return
        // One stack per scan: a stall crossing both lines in one read reports the same frames.
        val stack = mainStack()
        if (hang) {
            hangFired = true
            onHang(stack, blocked)
        }
        if (anr) {
            anrFired = true
            onAnr(stack, blocked)
        }
    }
}
