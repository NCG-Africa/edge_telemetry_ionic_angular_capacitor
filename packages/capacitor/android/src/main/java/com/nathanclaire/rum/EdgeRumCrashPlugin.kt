package com.nathanclaire.rum

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.nathanclaire.rum.core.Health
import com.nathanclaire.rum.core.IdGenerator
import com.nathanclaire.rum.core.Outbox
import com.nathanclaire.rum.core.Sender
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Capacitor plugin shim. Thin — delegates to:
 *  - [JvmCrashHandler] for Java/Kotlin uncaught Throwables
 *  - [AnrWatchdog] for main-thread liveness
 *  - [NativeCrashBridge] for NDK signal handlers
 *
 * NOTE: this file has not been built in this repo's CI — see
 * `goofy-rolling-flask.md` "Manual validation steps" for the smoke tests
 * you need to run on a real Android device or emulator.
 */
@CapacitorPlugin(name = "EdgeRum")
class EdgeRumCrashPlugin : Plugin() {

    @Volatile private var installed = false
    private val storage by lazy { CrashRecordStorage(context.cacheDir) }

    // ── 5.0 native core (spec A2, W1–W3, T1) ──────────────────────────────
    private lateinit var health: Health
    private lateinit var outbox: Outbox
    private lateinit var sender: Sender
    /** Serial: core init, timers and every plugin method, so nothing runs before init or interleaves a hand-off. */
    private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private lateinit var identity: String
    private val processStartedAt =
        System.currentTimeMillis() - (SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime())

    override fun load() {
        // Off the UI thread: outbox caps and the id store touch disk.
        onWorker {
            val dir = File(context.filesDir, "edge_rum")
            health = Health(dir)
            outbox = Outbox(dir, System::currentTimeMillis, health)
            sender = Sender(outbox, health, BuildConfig.SDK_VERSION)
            // C1: `plugins.EdgeRum` in capacitor.config; missing key/endpoint → capture to disk until `configure`.
            sender.configure(config.getString("apiKey", null), config.getString("endpoint", null))
            identity = identityLine(context, IdGenerator(prefsStore(context)).deviceId())
            sender.trigger()
        }
        // T3: 30 s after the first event, within a second.
        worker.scheduleWithFixedDelay({ outbox.sealIfDue() }, 1, 1, TimeUnit.SECONDS)
        // T6: 30 s retry tick for parked segments.
        worker.scheduleWithFixedDelay({ sender.trigger() }, 30, 30, TimeUnit.SECONDS)

        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageLoaded(webView: WebView) {
                // W3: 4.x ids lived in localStorage; deleted once per process, never carried over.
                if (legacyCleared.compareAndSet(false, true)) webView.evaluateJavascript(LEGACY_CLEANUP, null)
            }
        })
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        // ponytail: session, sampling and consent fields arrive with the session store (#109).
        onWorker(call) {
            call.resolve(
                JSObject()
                    .put("enabled", true)
                    .put("configured", sender.configured())
                    .put("sdkVersion", BuildConfig.SDK_VERSION)
                    .put("deviceStartedAt", processStartedAt),
            )
        }
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        // From init(); runtime only, never persisted (C1).
        val apiKey = call.getString("apiKey")
        val endpoint = call.getString("endpoint")
        onWorker(call) {
            sender.configure(apiKey, endpoint)
            sender.trigger()
            call.resolve()
        }
    }

    @PluginMethod
    fun enqueue(call: PluginCall) {
        val events = call.getArray("events")
        if (events == null) {
            call.reject("events missing")
            return
        }
        val lines = (0 until events.length()).mapNotNull { events.optJSONObject(it)?.toString() }
        val drops = call.getObject("drops")
        onWorker(call) {
            try {
                if (lines.isNotEmpty()) outbox.append(identity, lines)
            } catch (e: Exception) {
                // Not counted: JS counts a failed hand-off as a drop and resends (A4, T8).
                Log.w(TAG, "append failed", e)
                call.reject("append failed")
                return@onWorker
            }
            // T8: JS-side drops, counted only once the append lands so a resend can't double them.
            drops?.keys()?.forEach { health.count(it, drops.optLong(it)) }
            sender.trigger()
            call.resolve()
        }
    }

    /** A [call] is rejected if the worker has shut down, so it never hangs unsettled. */
    private fun onWorker(call: PluginCall? = null, task: () -> Unit) {
        try {
            worker.execute(task)
        } catch (ignored: RejectedExecutionException) {
            call?.reject("shutting down")
        }
    }

    /** T3: background seals the open segment and sends; off the UI thread (caps may read files). */
    private fun flush() = onWorker {
        outbox.seal()
        sender.trigger()
    }

    override fun handleOnStop() {
        super.handleOnStop()
        flush()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        onWorker { sender.trigger() }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        // Graceful: queued hand-offs still land on disk; the sender stops after them.
        onWorker { sender.shutdown() }
        worker.shutdown()
    }

    @PluginMethod
    fun install(call: PluginCall) {
        if (installed) {
            call.resolve(JSObject().put("installed", true))
            return
        }

        val enableAnr = call.getBoolean("enableAnrDetection", true) ?: true
        val anrTimeoutMs = call.getInt("anrTimeoutMs", 5000) ?: 5000

        try {
            JvmCrashHandler.install(storage) { lastScreen() }
            NativeCrashBridge.install(storage.ndkRecordFile.absolutePath) { lastScreen() }
            if (enableAnr) {
                AnrWatchdog.start(storage, anrTimeoutMs) { lastScreen() }
            }
            installed = true
            call.resolve(JSObject().put("installed", true))
        } catch (t: Throwable) {
            call.resolve(JSObject().put("installed", false).put("error", t.message ?: ""))
        }
    }

    @PluginMethod
    fun fetchPending(call: PluginCall) {
        val jvm = storage.readJvmCrashes()
        val anr = storage.readAnrCrashes()
        val ndk = NativeCrashBridge.fetchPendingNdk(storage)
        val all = (jvm + anr + ndk)
        val arr = JSArray()
        for (r in all) arr.put(r.toJson())
        call.resolve(JSObject().put("crashes", arr))
    }

    @PluginMethod
    fun markHandled(call: PluginCall) {
        val ids = call.getArray("ids")
        val idList = mutableListOf<String>()
        if (ids != null) {
            for (i in 0 until ids.length()) {
                val s = ids.optString(i, null) ?: continue
                idList.add(s)
            }
        }
        storage.deleteByIds(idList)
        call.resolve()
    }

    @PluginMethod
    fun setLastScreen(call: PluginCall) {
        val screen = call.getString("screen", "") ?: ""
        storage.setLastScreen(screen)
        call.resolve()
    }

    @PluginMethod
    fun startPerfSampling(call: PluginCall) {
        val captureFrames = call.getBoolean("captureFrames", true) ?: true
        val captureMemory = call.getBoolean("captureMemory", true) ?: true
        val memoryIntervalMs = call.getInt("memoryIntervalMs", 10_000) ?: 10_000
        // `getDouble` is missing on PluginCall; JS sends a number, JSON parses
        // as Double, getString round-trip is the simplest cross-bridge option.
        val slowThresholdMs = call.data.optDouble("frameSlowThresholdMs", 16.67)
        val captureAllFrames = call.getBoolean("captureAllFrames", false) ?: false

        if (captureMemory) {
            MemorySampler.start(context, memoryIntervalMs.toLong())
        }
        if (captureFrames) {
            FrameSampler.start(slowThresholdMs, captureAllFrames) { lastScreen() }
        }
        call.resolve(JSObject().put("started", true))
    }

    @PluginMethod
    fun stopPerfSampling(call: PluginCall) {
        runCatching { MemorySampler.stop() }
        runCatching { FrameSampler.stop() }
        call.resolve()
    }

    // Backgrounding is a scene change: close the current frame window so the
    // background gap isn't measured as one giant dropped frame on resume
    // (mirrors iOS didEnterBackground). No-op unless frame sampling is running.
    // T3: background also seals the open segment and sends (repeated on stop).
    override fun handleOnPause() {
        super.handleOnPause()
        runCatching { FrameSampler.onBackground() }
        flush()
    }

    @PluginMethod
    fun fetchFrameSamples(call: PluginCall) {
        val frames = runCatching { FrameSampler.fetchPending() }.getOrDefault(emptyList())
        val arr = JSArray()
        for (f in frames) arr.put(toJsObject(f))
        call.resolve(JSObject().put("frames", arr))
    }

    @PluginMethod
    fun fetchMemorySamples(call: PluginCall) {
        val samples = runCatching { MemorySampler.fetchPending() }.getOrDefault(emptyList())
        val arr = JSArray()
        for (s in samples) arr.put(toJsObject(s))
        call.resolve(JSObject().put("samples", arr))
    }

    private fun toJsObject(map: Map<String, Any?>): JSObject {
        val obj = JSObject()
        for ((k, v) in map) {
            // JSObject has overloaded put() for primitives; nulls are dropped
            // (matches the wire contract — omit instead of sending null).
            when (v) {
                null -> Unit
                is Boolean -> obj.put(k, v)
                is Int -> obj.put(k, v)
                is Long -> obj.put(k, v)
                is Double -> obj.put(k, v)
                is Float -> obj.put(k, v.toDouble())
                else -> obj.put(k, v.toString())
            }
        }
        return obj
    }

    private fun lastScreen(): String = storage.getLastScreen()

    private companion object {
        const val TAG = "EdgeRum"
        val legacyCleared = AtomicBoolean()
        const val LEGACY_CLEANUP =
            "['edge_rum_device_id','edge_rum_anon_uid','edge_rum_total_sessions','edge_rum_q','edge_rum_location']" +
                ".forEach(function(k){try{localStorage.removeItem(k)}catch(e){}})"

        fun prefsStore(ctx: Context): IdGenerator.Store {
            val prefs = ctx.getSharedPreferences("edge_rum_ids", Context.MODE_PRIVATE)
            return object : IdGenerator.Store {
                override fun get(key: String): String? = prefs.getString(key, null)

                // A null value removes the key.
                override fun put(key: String, value: String?): Boolean = prefs.edit().putString(key, value).commit()
            }
        }

        /** W2: app identity from PackageManager, no override. */
        fun identityLine(ctx: Context, deviceId: String): String {
            val pm = ctx.packageManager
            val info = try {
                pm.getPackageInfo(ctx.packageName, 0)
            } catch (e: PackageManager.NameNotFoundException) {
                null // own package; unreachable in practice. Version keys stay omitted (R15).
            }
            @Suppress("DEPRECATION")
            val build = info?.let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else it.versionCode.toLong() }
            return Sender.identityLine(
                ctx.applicationInfo.loadLabel(pm).toString(), ctx.packageName, info?.versionName, build?.toString(), deviceId,
            )
        }
    }
}
