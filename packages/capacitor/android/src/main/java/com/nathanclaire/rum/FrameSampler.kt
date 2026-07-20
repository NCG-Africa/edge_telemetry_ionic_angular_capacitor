package com.nathanclaire.rum

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import java.util.ArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Choreographer-based frame sampler. Each `doFrame` callback gives us the vsync
 * timestamp in nanos; differences between consecutive vsyncs are the rendered-
 * frame intervals. Intervals are aggregated into one windowed summary per screen
 * (ADR-030), byte-compatible with the web `registerFrameCapture` and iOS
 * `FrameSampler` shape so the EdgeTelemetryProcessor buckets all three platforms
 * identically.
 *
 * A window closes on a screen change (the JS route relayed via `setLastScreen`,
 * read through `screenProvider`), a 30s cap, or `stop()`. Windows with no slow
 * frame are suppressed — a smooth screen sends nothing. `fetchPending()` returns
 * the summaries accumulated since the last drain; `value` = window p95.
 */
object FrameSampler {

    private val pendingSummaries = ArrayList<Map<String, Any?>>()
    private val lock = Object()
    private val running = AtomicBoolean(false)
    private var slowThresholdMs: Double = 16.67
    private var screenProvider: () -> String = { "" }

    // A window force-closes after this long so a screen held for minutes yields
    // several summaries instead of one coarse blob (mirrors web MAX_WINDOW_MS).
    private const val MAX_WINDOW_MS = 30_000.0
    // Two consecutive missed vsyncs at the slow threshold marks a "dropped" frame.
    private const val DROP_MULTIPLIER = 2.0

    // In-window accumulator state — touched only on the main looper (Choreographer
    // fires there), so it needs no lock.
    private val durations = ArrayList<Double>()
    private var windowRoute: String = ""
    private var windowStartNanos: Long = -1L
    private var lastFrameTimeNanos: Long = -1L

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running.get()) return
            val prev = lastFrameTimeNanos
            lastFrameTimeNanos = frameTimeNanos
            // Re-arm immediately so we don't miss the next vsync even when we bail
            // on the rest of this callback.
            Choreographer.getInstance().postFrameCallback(this)
            if (prev < 0) return

            val totalMs = (frameTimeNanos - prev) / 1_000_000.0
            if (totalMs <= 0.0) return

            val route = screenProvider()
            // Close the current window before appending when the screen changed or
            // the time cap is hit; the straddling frame opens the fresh window.
            if (durations.isNotEmpty() &&
                (route != windowRoute || (frameTimeNanos - windowStartNanos) / 1_000_000.0 >= MAX_WINDOW_MS)
            ) {
                flushWindow(prev)
            }
            if (durations.isEmpty()) {
                windowRoute = route
                windowStartNanos = prev
            }
            durations.add(totalMs)
        }
    }

    fun start(slowThresholdMs: Double, captureAllFrames: Boolean, screenProvider: () -> String) {
        // captureAllFrames is retained for bridge-signature compatibility but no
        // longer gates anything: the windowed summary needs every frame interval
        // (frames_total is the jank-ratio denominator, p50/p95 span all frames).
        if (running.getAndSet(true)) return
        this.slowThresholdMs = slowThresholdMs
        this.screenProvider = screenProvider
        // Choreographer.postFrameCallback must run on the main looper. Reset the
        // window accumulators there too so all accumulator state stays confined
        // to the looper (mirrors iOS resetting inside DispatchQueue.main.async).
        Handler(Looper.getMainLooper()).post {
            lastFrameTimeNanos = -1L
            resetWindow()
            Choreographer.getInstance().postFrameCallback(frameCallback)
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        Handler(Looper.getMainLooper()).post {
            // Flush an in-progress window so a screen's jank isn't lost on teardown.
            flushWindow(lastFrameTimeNanos)
            Choreographer.getInstance().removeFrameCallback(frameCallback)
            lastFrameTimeNanos = -1L
        }
    }

    /**
     * Close the in-progress window on backgrounding. Choreographer stops firing
     * while backgrounded, so the first frame after foregrounding would otherwise
     * measure the whole background gap as one giant "dropped" frame and inflate
     * `window_ms`. Flushing here (a scene change) and clearing `lastFrameTimeNanos`
     * discards that straddling interval — mirrors iOS `onBackground`.
     */
    fun onBackground() {
        if (!running.get()) return
        Handler(Looper.getMainLooper()).post {
            flushWindow(lastFrameTimeNanos)
            lastFrameTimeNanos = -1L
        }
    }

    /**
     * Drains and returns all windowed summaries accumulated since the last call,
     * as a list of maps the Capacitor bridge can serialize directly into JSON.
     */
    fun fetchPending(): List<Map<String, Any?>> {
        synchronized(lock) {
            val drained = pendingSummaries.toList()
            pendingSummaries.clear()
            return drained
        }
    }

    // Emit one summary for the closing window, then reset. Suppressed entirely
    // when the window is empty or no slow frame occurred — the volume cut.
    private fun flushWindow(endTimeNanos: Long) {
        val ds = ArrayList(durations)
        val start = windowStartNanos
        val route = windowRoute
        resetWindow()

        if (ds.isEmpty()) return
        var slow = 0
        var dropped = 0
        for (d in ds) {
            if (d >= slowThresholdMs) slow++
            if (d >= slowThresholdMs * DROP_MULTIPLIER) dropped++
        }
        if (slow == 0) return

        val sorted = ds.sorted()
        val p95 = percentile(sorted, 0.95)
        val windowMs = if (start < 0) 0.0 else maxOf(0.0, (endTimeNanos - start) / 1_000_000.0)
        val summary = mapOf<String, Any?>(
            "value" to p95,
            "frames_total" to ds.size,
            "slow_frames" to slow,
            "dropped_frames" to dropped,
            "p50_ms" to percentile(sorted, 0.5),
            "p95_ms" to p95,
            "worst_ms" to (sorted.lastOrNull() ?: 0.0),
            "window_ms" to windowMs,
            "screen" to route,
        )
        synchronized(lock) {
            pendingSummaries.add(summary)
        }
    }

    private fun resetWindow() {
        durations.clear()
        windowRoute = ""
        windowStartNanos = -1L
    }

    // Nearest-rank percentile over an ascending-sorted list. The window is
    // time-bounded (≤ 30s), so sort-once-on-flush beats a streaming estimator.
    private fun percentile(sortedAsc: List<Double>, p: Double): Double {
        if (sortedAsc.isEmpty()) return 0.0
        val idx = Math.ceil(p * sortedAsc.size).toInt() - 1
        val clamped = minOf(sortedAsc.size - 1, maxOf(0, idx))
        return sortedAsc[clamped]
    }
}
