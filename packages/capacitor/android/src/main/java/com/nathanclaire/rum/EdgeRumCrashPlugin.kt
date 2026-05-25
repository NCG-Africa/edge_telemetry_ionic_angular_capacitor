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

    private fun lastScreen(): String = storage.getLastScreen()
}
