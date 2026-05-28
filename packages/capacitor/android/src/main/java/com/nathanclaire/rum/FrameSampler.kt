package com.nathanclaire.rum

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Choreographer-based frame sampler. Each `doFrame` callback gives us the
 * vsync timestamp in nanos; differences between consecutive vsyncs are the
 * rendered-frame intervals.
 *
 * Build/raster split: this sampler does NOT use `Window.OnFrameMetricsAvailableListener`
 * (API 24+) because the Capacitor plugin doesn't reliably own the activity
 * window across lifecycle. For consistent semantics across API levels we send
 * the full interval as `build_ms` and `0` as `raster_ms`, matching the iOS
 * CADisplayLink behavior. The wire-contract requirement that both fields are
 * numbers (never null) is satisfied.
 */
object FrameSampler {

    data class Sample(
        val ts: String,
        val totalMs: Double,
        val buildMs: Double,
        val rasterMs: Double,
        val dropped: Boolean,
        val type: String,
    )

    private val samples = ArrayDeque<Sample>()
    private val lock = Object()
    private val running = AtomicBoolean(false)
    private var slowThresholdMs: Double = 16.67
    private var captureAll: Boolean = false
    private var lastFrameTimeNanos: Long = -1L

    private const val MAX_SAMPLES = 240

    private val isoFormatter: SimpleDateFormat
        get() {
            val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            df.timeZone = TimeZone.getTimeZone("UTC")
            return df
        }

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running.get()) return
            val prev = lastFrameTimeNanos
            lastFrameTimeNanos = frameTimeNanos
            // Re-arm immediately so we don't miss the next vsync even when we
            // bail on the rest of this callback.
            Choreographer.getInstance().postFrameCallback(this)
            if (prev < 0) return

            val totalMs = (frameTimeNanos - prev) / 1_000_000.0
            if (totalMs <= 0.0) return
            if (!captureAll && totalMs < slowThresholdMs) return

            val dropped = totalMs >= slowThresholdMs * 2.0
            val sample = Sample(
                ts = isoFormatter.format(Date()),
                totalMs = totalMs,
                buildMs = totalMs,
                rasterMs = 0.0,
                dropped = dropped,
                type = "ui",
            )
            synchronized(lock) {
                samples.add(sample)
                while (samples.size > MAX_SAMPLES) samples.pollFirst()
            }
        }
    }

    fun start(slowThresholdMs: Double, captureAllFrames: Boolean) {
        if (running.getAndSet(true)) return
        this.slowThresholdMs = slowThresholdMs
        this.captureAll = captureAllFrames
        this.lastFrameTimeNanos = -1L
        // Choreographer.postFrameCallback must run on the main looper.
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            Choreographer.getInstance().postFrameCallback(frameCallback)
        }
    }

    fun stop() {
        running.set(false)
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            Choreographer.getInstance().removeFrameCallback(frameCallback)
        }
        lastFrameTimeNanos = -1L
    }

    /**
     * Drains and returns all pending samples as a list of maps the Capacitor
     * bridge can serialize directly into JSON.
     */
    fun fetchPending(): List<Map<String, Any?>> {
        val drained: List<Sample>
        synchronized(lock) {
            drained = samples.toList()
            samples.clear()
        }
        return drained.map { s ->
            mapOf(
                "ts" to s.ts,
                "total_ms" to s.totalMs,
                "build_ms" to s.buildMs,
                "raster_ms" to s.rasterMs,
                "dropped" to s.dropped,
                "type" to s.type,
            )
        }
    }
}
