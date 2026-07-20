package com.nathanclaire.rum

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

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
@CapacitorPlugin(name = "EdgeRumCrash")
class EdgeRumCrashPlugin : Plugin() {

    @Volatile private var installed = false
    private val storage by lazy { CrashRecordStorage(context.cacheDir) }

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
    override fun handleOnPause() {
        super.handleOnPause()
        runCatching { FrameSampler.onBackground() }
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
}
