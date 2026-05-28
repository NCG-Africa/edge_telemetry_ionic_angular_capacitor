package com.nathanclaire.rum

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Debug
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Periodic process-memory sampler. Reads PSS via [Debug.MemoryInfo] every
 * `intervalMs`, plus on memory-pressure callbacks delivered by Android's
 * [ComponentCallbacks2.onTrimMemory]. Samples accumulate in a capped in-memory
 * ring buffer that the JS layer drains via `fetchMemorySamples()`.
 *
 * Pressure mapping (matches the wire contract in docs/decisions.md):
 *  - TRIM_MEMORY_RUNNING_MODERATE → "moderate"
 *  - TRIM_MEMORY_RUNNING_LOW → "high"
 *  - TRIM_MEMORY_RUNNING_CRITICAL / _COMPLETE / any _BACKGROUND → "critical"
 *  - otherwise → "normal"
 */
object MemorySampler {

    data class Sample(
        val ts: String,
        val valueMb: Double,
        val pressure: String?,
        val type: String,
        val source: String,
    )

    private val samples = ArrayDeque<Sample>()
    private val lock = Object()
    private val lastPressure = AtomicReference("normal")
    private var executor: ScheduledExecutorService? = null
    private var future: ScheduledFuture<*>? = null
    private var callbacks: ComponentCallbacks2? = null
    private var appContext: Context? = null

    private const val MAX_SAMPLES = 60

    private val isoFormatter: SimpleDateFormat
        get() {
            val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            df.timeZone = TimeZone.getTimeZone("UTC")
            return df
        }

    @Synchronized
    fun start(context: Context, intervalMs: Long) {
        if (executor != null) return
        appContext = context.applicationContext
        val exec = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "edge-rum-memory-sampler").apply { isDaemon = true }
        }
        executor = exec
        val safeInterval = intervalMs.coerceAtLeast(1_000L)
        future = exec.scheduleAtFixedRate(
            { runCatching { sampleNow() } },
            safeInterval,
            safeInterval,
            TimeUnit.MILLISECONDS,
        )

        // Memory-pressure callbacks fire on the main thread; flip the latest
        // pressure level and take an immediate sample so the value lines up
        // with the pressure event time.
        val cb = object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                lastPressure.set(pressureFor(level))
                runCatching { sampleNow() }
            }
            override fun onLowMemory() {
                lastPressure.set("critical")
                runCatching { sampleNow() }
            }
            override fun onConfigurationChanged(newConfig: Configuration) { /* no-op */ }
        }
        callbacks = cb
        runCatching { appContext?.registerComponentCallbacks(cb) }

        // Initial baseline sample.
        runCatching { sampleNow() }
    }

    @Synchronized
    fun stop() {
        future?.cancel(false)
        future = null
        executor?.shutdownNow()
        executor = null
        val cb = callbacks
        if (cb != null) {
            runCatching { appContext?.unregisterComponentCallbacks(cb) }
            callbacks = null
        }
        appContext = null
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
            val m = mutableMapOf<String, Any?>(
                "ts" to s.ts,
                "value_mb" to s.valueMb,
                "type" to s.type,
                "source" to s.source,
            )
            // Omit (don't send empty string) when no pressure is known so the
            // processor doesn't bucket samples under a bogus "" key.
            s.pressure?.takeIf { it.isNotEmpty() }?.let { m["pressure"] = it }
            m
        }
    }

    /** Force an immediate sample — used on foreground/background transitions. */
    fun sampleNow() {
        val mb = currentPssMb()
        if (mb < 0) return
        val sample = Sample(
            ts = isoFormatter.format(Date()),
            valueMb = mb,
            pressure = lastPressure.get(),
            type = "pss",
            source = "native",
        )
        synchronized(lock) {
            samples.add(sample)
            while (samples.size > MAX_SAMPLES) samples.pollFirst()
        }
    }

    private fun currentPssMb(): Double {
        return try {
            val info = Debug.MemoryInfo()
            Debug.getMemoryInfo(info)
            // totalPss is reported in KB.
            info.totalPss / 1024.0
        } catch (t: Throwable) {
            -1.0
        }
    }

    private fun pressureFor(level: Int): String {
        // Order matters: critical > background > low > moderate. Sample under
        // the worst pressure currently observed.
        return when (level) {
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL,
            ComponentCallbacks2.TRIM_MEMORY_COMPLETE,
            ComponentCallbacks2.TRIM_MEMORY_MODERATE,
            ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> "critical"
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "high"
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> "moderate"
            ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> "normal"
            else -> "normal"
        }
    }

    /** Reads the current device-wide low-memory flag — exposed for tests. */
    internal fun isLowMemory(context: Context): Boolean {
        return try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            val info = ActivityManager.MemoryInfo()
            am?.getMemoryInfo(info)
            info.lowMemory
        } catch (t: Throwable) {
            false
        }
    }
}
