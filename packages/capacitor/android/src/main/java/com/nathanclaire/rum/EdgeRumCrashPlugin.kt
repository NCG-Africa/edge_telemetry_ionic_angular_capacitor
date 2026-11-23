package com.nathanclaire.rum

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.nathanclaire.rum.core.Consent
import com.nathanclaire.rum.core.Crash
import com.nathanclaire.rum.core.Exits
import com.nathanclaire.rum.core.Health
import com.nathanclaire.rum.core.IdGenerator
import com.nathanclaire.rum.core.Launch
import com.nathanclaire.rum.core.Outbox
import com.nathanclaire.rum.core.Sender
import com.nathanclaire.rum.core.Session
import com.nathanclaire.rum.core.Signals
import com.nathanclaire.rum.core.User
import com.nathanclaire.rum.core.Watchdog
import java.io.File
import java.security.SecureRandom
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Capacitor plugin shim over the native core (`com.nathanclaire.rum.core`): reads the platform,
 * the core shapes and stores it. Native crash / ANR / hang capture arms itself (E12, E14, E15);
 * WebView death, `app.start`, lifecycle, memory and network are native signals (A5, A6, E2, E3, E13, E22–E26).
 *
 * NOTE: this file has not been built in this repo's CI — see
 * `goofy-rolling-flask.md` "Manual validation steps" for the smoke tests
 * you need to run on a real Android device or emulator.
 */
@CapacitorPlugin(name = "EdgeRum")
class EdgeRumCrashPlugin : Plugin() {

    // ── 5.0 native core (spec A2, W1–W3, T1) ──────────────────────────────
    private lateinit var health: Health
    private lateinit var outbox: Outbox
    private lateinit var sender: Sender
    /** Serial: core init, timers and every plugin method, so nothing runs before init or interleaves a hand-off. */
    private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private lateinit var user: User
    private lateinit var session: Session
    private lateinit var consent: Consent
    /** Replaced by `reset()`; read by the crash and watchdog threads. */
    @Volatile private lateinit var identity: String
    private lateinit var crash: Crash
    private lateinit var watchdog: Watchdog
    /** JVM + NDK handlers can't be uninstalled: once per process. */
    private val armed = AtomicBoolean()
    /** The watchdog runs in the foreground only (E14, E15). */
    @Volatile private var foreground = false
    private val processStartedAt =
        System.currentTimeMillis() - (SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime())
    /** E32: launch-time device context; `app.bundle_id` and `network.type` are added per event. */
    private lateinit var device: JSONObject
    /** E26: last default-network transport; null until the first callback. */
    @Volatile private var networkType: String? = null
    private var trimCallback: ComponentCallbacks2? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun load() {
        // A5: plugins load once the bridge has created the WebView; close enough to "WebView created".
        synchronized(EdgeRumCrashPlugin::class.java) {
            if (launch == null) launch = Launch(processStartedAt, System.currentTimeMillis())
        }
        val dir = File(context.filesDir, "edge_rum")
        crash = Crash(dir, Looper.getMainLooper().thread, System::currentTimeMillis)
        val main = Handler(Looper.getMainLooper())
        // C1: `hang`/`hangTimeoutMs` (true/2000), `anr`/`anrTimeoutMs` (true/5000).
        watchdog = Watchdog(
            if (config.getBoolean("hang", true)) config.getInt("hangTimeoutMs", 2000).toLong() else 0,
            if (config.getBoolean("anr", true)) config.getInt("anrTimeoutMs", 5000).toLong() else 0,
            { main.post(it) }, SystemClock::uptimeMillis, { mainStack() },
            { stack, ms -> solo { crash.stall("app.hang", ms, stack) } },
            { stack, ms -> solo { crash.stall("app.anr", ms, stack) } },
        )
        // Off the UI thread: outbox caps and the id store touch disk.
        onWorker {
            health = Health(dir)
            outbox = Outbox(dir, System::currentTimeMillis, health)
            sender = Sender(outbox, health, BuildConfig.SDK_VERSION)
            // C1: `plugins.EdgeRum` in capacitor.config; missing key/endpoint → capture to disk until `configure`.
            sender.configure(config.getString("apiKey", null), config.getString("endpoint", null))
            val prefs = prefsStore(context)
            val ids = IdGenerator(prefs)
            identity = identityLine(context, ids.deviceId())
            user = User(prefs)
            val random = SecureRandom()
            // C1 `sampleRate`; a non-number is NaN, which Session treats as keep-all (S1).
            val rate = config.configJSON.opt("sampleRate")?.let { (it as? Number)?.toDouble() ?: Double.NaN } ?: 1.0
            session = Session(prefs, health, System::currentTimeMillis, rate, random::nextDouble, IdGenerator::sessionId, user::id)
            consent = Consent(prefs, config.getBoolean("enabled", true), session, user, outbox, ids)
            device = deviceContext(context)
            session.context(::eventContext)
            // T4: last launch's NDK crash, under the identity it crashed with. Gone either way.
            val ndk = crash.takeNdk()
            if (ndk != null && consent.enabled()) writeSolo(ndk.identity, ndk.event)
            val exits = harvestExits(prefs)
            // P7: opt-in mode starts nothing until enable().
            if (consent.enabled()) {
                append(session.begin())
                admit(exits)
                // Armed after the context exists, so an NDK crash always has one to replay under.
                saveCrashContext()
                arm()
            }
            sender.trigger()
        }
        // T3: 30 s after the first event, within a second.
        worker.scheduleWithFixedDelay({ outbox.sealIfDue() }, 1, 1, TimeUnit.SECONDS)
        // T6: 30 s retry tick for parked segments.
        worker.scheduleWithFixedDelay({ sender.trigger() }, 30, 30, TimeUnit.SECONDS)
        // C1 / E23: opt-in periodic memory, foreground only.
        if (config.getBoolean("memorySampling", false)) {
            val every = maxOf(1000, config.getInt("memorySamplingIntervalMs", 30000)).toLong()
            worker.scheduleWithFixedDelay({ if (foreground) sampleMemory("periodic") }, every, every, TimeUnit.MILLISECONDS)
        }
        watchMemoryPressure()
        watchNetwork()

        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageLoaded(webView: WebView) {
                // W3: 4.x ids lived in localStorage; deleted once per process, never carried over.
                if (legacyCleared.compareAndSet(false, true)) webView.evaluateJavascript(LEGACY_CLEANUP, null)
            }

            /** E13 / A6: recorded synchronously before the WebView goes; the default (crash / kill) still follows. */
            override fun onRenderProcessGone(webView: WebView, detail: RenderProcessGoneDetail): Boolean {
                val reason = if (Build.VERSION.SDK_INT >= 26 && !detail.didCrash()) "oom_killed" else "crash"
                solo { crash.webViewTerminated(reason) }
                return false
            }
        })
    }

    /** E24: `onTrimMemory` / `onLowMemory` → `memory.pressure`. */
    private fun watchMemoryPressure() {
        val cb = object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                val at = System.currentTimeMillis()
                capture(true) { listOfNotNull(Signals.pressure(level, Debug.getPss(), at)) }
            }

            @Deprecated("Deprecated in Java")
            override fun onLowMemory() = onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)

            override fun onConfigurationChanged(newConfig: Configuration) = Unit
        }
        context.applicationContext.registerComponentCallbacks(cb)
        trimCallback = cb
    }

    /** E26: default-network transport changes → `network.change`; the first reading only seeds `network.type`. */
    private fun watchNetwork() {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(n: Network, c: NetworkCapabilities) = network(
                when {
                    c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                    else -> "other"
                },
            )

            override fun onLost(n: Network) = network("none")
        }
        try {
            // No network now → "none", so the first one that comes is a reported transition.
            if (cm.activeNetwork == null) networkType = "none"
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: RuntimeException) {
            // Missing permission (stripped manifest) or the per-app callback limit: no network.change.
            Log.w(TAG, "network callback unavailable", e)
        }
    }

    @Synchronized
    private fun network(type: String) {
        val previous = networkType
        if (type == previous) return
        networkType = type
        val at = System.currentTimeMillis()
        if (previous != null) capture(true) { listOf(Signals.network(previous, type, at)) }
    }

    /** E32: device context plus the live `app.bundle_id` (an OTA swap changes it) and `network.type`. */
    private fun eventContext(): JSONObject {
        val c = JSONObject(device.toString())
        c.put("app.bundle_id", Signals.bundleId(runCatching { bridge.serverBasePath }.getOrNull()))
        networkType?.let { c.put("network.type", it) }
        return c
    }

    /**
     * Native signals from any thread: built there (timestamps), gated and appended on the worker.
     * `passive` ones (background network / memory) don't count as session activity.
     */
    private fun capture(passive: Boolean, records: () -> List<JSONObject>) = onWorker {
        try {
            val events = records()
            if (passive) recordPassive(events) else record(events)
        } catch (e: Exception) {
            Log.w(TAG, "native record failed", e)
        }
    }

    /** Worker only: consent (P7), then the session gate. */
    private fun record(events: List<JSONObject>) {
        if (events.isNotEmpty() && consent.enabled()) admit(events)
    }

    private fun recordPassive(events: List<JSONObject>) {
        if (events.isNotEmpty() && consent.enabled()) append(session.admitPassive(events))
    }

    /** E22 / E23: RSS + PSS, worker only (`getPss` walks smaps). */
    private fun sampleMemory(source: String) {
        try {
            recordPassive(listOfNotNull(Signals.memory(rssKb(), Debug.getPss(), source, System.currentTimeMillis())))
        } catch (e: RuntimeException) {
            Log.w(TAG, "memory sample failed", e)
        }
    }

    /** A2 / A5: JS phase marks; `bridgeReady` opens the `markReady` window. */
    @PluginMethod
    fun markPhase(call: PluginCall) {
        val phase = call.getString("phase")
        val ts = call.data.optLong("ts", System.currentTimeMillis())
        onWorker(call) {
            val start = launch?.mark(phase, ts)
            if (start != null) {
                record(listOf(start))
            } else if (phase == Launch.BRIDGE_READY) {
                worker.schedule({ finishLaunch() }, Launch.READY_WINDOW_MS, TimeUnit.MILLISECONDS)
            }
            call.resolve()
        }
    }

    /** Worker only: `app.start` without `markReady`, if still owed. */
    private fun finishLaunch() = record(listOfNotNull(launch?.finish()))

    @PluginMethod
    fun getState(call: PluginCall) {
        onWorker(call) { call.resolve(state()) }
    }

    private fun state(): JSObject =
        JSObject()
            .put("enabled", consent.enabled())
            .put("sessionId", session.id())
            .put("userId", user.id())
            .put("sampled", session.sampled())
            .put("configured", sender.configured())
            .put("sdkVersion", BuildConfig.SDK_VERSION)
            .put("deviceStartedAt", processStartedAt)

    /** A2 `addListener('state')`: `{ type, …state }` on session rotation / enabled change. */
    private fun notifyState(type: String) = notifyListeners("state", state().put("type", type))

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
        val received = (0 until events.length()).mapNotNull { events.optJSONObject(it) }
        val drops = call.getObject("drops")
        val payload = call.data
        onWorker(call) {
            // P7: opt-in mode / disabled → nothing captured or buffered.
            if (!consent.enabled()) return@onWorker call.resolve()
            crash.mirror(payload) // A3
            // Not counted on failure: JS counts a failed hand-off as a drop and resends (A4, T8).
            if (!admit(received)) return@onWorker call.reject("append failed")
            // T8: JS-side drops, counted only once the append lands so a resend can't double them.
            drops?.keys()?.forEach { health.count(it, drops.optLong(it)) }
            call.resolve()
        }
    }

    /** P7 (= Cordova P6): persisted traits; a trait change becomes one `user.profile.update`. */
    @PluginMethod
    fun identify(call: PluginCall) {
        val traits = call.data
        onWorker(call) {
            if (consent.enabled()) user.identify(traits)?.let { admit(listOf(it)) }
            call.resolve()
        }
    }

    @PluginMethod
    fun clearUser(call: PluginCall) = onWorker(call) {
        user.clear()
        saveCrashContext()
        call.resolve()
    }

    @PluginMethod
    fun enable(call: PluginCall) = onWorker(call) { setEnabled(true, call) }

    @PluginMethod
    fun disable(call: PluginCall) = onWorker(call) { setEnabled(false, call) }

    /** P7: new device_id and session, user and outbox cleared; enabled state untouched. */
    @PluginMethod
    fun reset(call: PluginCall) = onWorker(call) {
        identity = identityLine(context, consent.reset())
        crash.clear()
        if (consent.enabled()) {
            append(session.restart())
            saveCrashContext()
            notifyState("session")
        }
        call.resolve()
    }

    private fun setEnabled(on: Boolean, call: PluginCall) {
        val was = consent.enabled()
        append(consent.setEnabled(on))
        // ponytail: JVM/NDK handlers can't be uninstalled; they stay, but `solo` records nothing while
        // disabled and an NDK report is dropped at the next launch's `takeNdk`.
        if (on) {
            saveCrashContext()
            arm()
        } else {
            disarm()
        }
        if (was != on) notifyState("enabled")
        call.resolve()
    }

    /** P7 `disable()`: stops the watchdog, forgets crumbs, root and any NDK report. */
    private fun disarm() {
        watchdog.stop()
        crash.clear()
    }

    /** E12, E14, E15: crash handlers once per process; the watchdog while in the foreground. Worker only. */
    private fun arm() {
        if (foreground) watchdog.start()
        if (!armed.compareAndSet(false, true)) return
        crash.installJvm { e -> solo { e } }
        try {
            System.loadLibrary("edge-rum-native")
            Ndk.install(crash.ndkReportPath())
        } catch (e: UnsatisfiedLinkError) {
            Log.w(TAG, "NDK crash handler unavailable", e)
        }
    }

    /**
     * T4: a native crash / ANR / hang becomes its own segment under the running build's identity,
     * after the session gate (a hang follows the roll, S2). Any thread, including a dying one.
     */
    private fun solo(record: () -> JSONObject) {
        try {
            if (!consent.enabled()) return
            val event = record()
            val before = session.id()
            append(session.rotateIfIdle())
            for (line in session.admit(listOf(event))) writeSolo(identity, line)
            if (before != null && before != session.id()) notifyState("session")
        } catch (e: Exception) {
            Log.w(TAG, "native record failed", e)
        }
    }

    private fun writeSolo(identity: String, line: String) {
        try {
            outbox.writeSolo(identity, line)
            sender.trigger()
        } catch (e: java.io.IOException) {
            Log.w(TAG, "solo segment failed", e)
        }
    }

    /** What a later NDK crash report replays under (T4): identity, session, user, crumbs, root. */
    private fun saveCrashContext() = crash.saveContext(identity, session.id(), user.id())

    /** E16: new exit records since the last launch; advances the watermark even when not sent (P7). */
    private fun harvestExits(store: IdGenerator.Store): List<JSONObject> {
        if (Build.VERSION.SDK_INT < 30) return emptyList()
        return try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val records = am.getHistoricalProcessExitReasons(null, 0, 0).map {
                val trace = if (it.reason == ApplicationExitInfo.REASON_ANR) trace(it) else null
                Exits.Record(it.reason, it.importance, it.status, it.description, it.pss, it.rss, it.timestamp, trace)
            }
            Exits.harvest(records, store, System.currentTimeMillis())
        } catch (e: Exception) {
            // Odd OEM builds throw from the buffer read; never let that take down launch.
            Log.w(TAG, "exit harvest failed", e)
            emptyList()
        }
    }

    /** Worker only. S1: every event goes through the session gate on its way into the outbox. */
    private fun admit(events: List<JSONObject>): Boolean {
        val before = session.id()
        val ok = append(session.admit(events))
        saveCrashContext()
        if (before != null && before != session.id()) notifyState("session")
        return ok
    }

    private fun append(lines: List<String>): Boolean {
        if (lines.isEmpty()) return true
        // E22: a new session gets its memory bookend.
        // ponytail: substring check on serialized lines; Session returns strings, not events.
        if (lines.any { it.contains("\"eventName\":\"session.started\"") }) onWorker { sampleMemory("session_start") }
        return try {
            outbox.append(identity, lines)
            sender.trigger()
            true
        } catch (e: Exception) {
            Log.w(TAG, "append failed", e)
            false
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

    /** E2: native foreground. */
    override fun handleOnStart() {
        super.handleOnStart()
        val at = System.currentTimeMillis()
        capture(false) { listOf(Signals.lifecycle("foregrounded", at)) }
    }

    /**
     * E2 background; E22 end bookend — every background may be the session's last (it ends
     * after the idle timeout, unobserved), so each one samples; A5: an owed `app.start` goes now.
     */
    override fun handleOnStop() {
        super.handleOnStop()
        val at = System.currentTimeMillis()
        capture(false) { listOf(Signals.lifecycle("backgrounded", at)) }
        onWorker {
            finishLaunch()
            sampleMemory("session_end")
        }
        flush()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        foreground = true
        onWorker {
            // E1: a foreground after the idle timeout starts a new session.
            if (consent.enabled()) {
                if (foreground) watchdog.start()
                val bookends = session.rotateIfIdle()
                if (bookends.isNotEmpty()) {
                    append(bookends)
                    saveCrashContext()
                    notifyState("session")
                }
            }
            sender.trigger()
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        watchdog.stop()
        trimCallback?.let { context.applicationContext.unregisterComponentCallbacks(it) }
        networkCallback?.let {
            runCatching { (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) }
        }
        // Graceful: queued hand-offs still land on disk; the sender stops after them.
        onWorker { sender.shutdown() }
        worker.shutdown()
    }

    @PluginMethod
    fun setLastScreen(call: PluginCall) {
        val screen = call.getString("screen", "") ?: ""
        onWorker(call) {
            if (consent.enabled()) {
                crash.screen(screen)
                saveCrashContext()
            }
            call.resolve()
        }
    }

    /** A2 / X10: `{ trace.id, rum.action.id, trace.root_type }` on root mint/replace; empty when cleared. */
    @PluginMethod
    fun setRoot(call: PluginCall) {
        val root = call.data
        onWorker(call) {
            if (consent.enabled()) {
                crash.setRoot(root)
                saveCrashContext()
            }
            call.resolve()
        }
    }

    // T3: background also seals the open segment and sends (repeated on stop).
    override fun handleOnPause() {
        super.handleOnPause()
        foreground = false
        watchdog.stop()
        // Again behind any start a resume queued on the worker.
        onWorker { if (!foreground) watchdog.stop() }
        flush()
    }

    private companion object {
        const val TAG = "EdgeRum"
        /** A5: one per process, so an Activity recreated in a live process doesn't start a second cold launch. */
        var launch: Launch? = null
        val legacyCleared = AtomicBoolean()
        const val LEGACY_CLEANUP =
            "['edge_rum_device_id','edge_rum_anon_uid','edge_rum_total_sessions','edge_rum_q','edge_rum_location']" +
                ".forEach(function(k){try{localStorage.removeItem(k)}catch(e){}})"

        fun mainStack(): String =
            Looper.getMainLooper().thread.stackTrace.joinToString("") { "at $it\n" }

        /** The OS's ANR text trace, first 8 KB. */
        fun trace(info: ApplicationExitInfo): String? = try {
            info.traceInputStream?.bufferedReader()?.use { r ->
                val sb = StringBuilder()
                while (sb.length < 8192) sb.append(r.readLine() ?: break).append('\n')
                sb.toString()
            }
        } catch (e: java.io.IOException) {
            null
        }

        fun rssKb(): Long = try {
            Signals.rssKb(File("/proc/self/status").readText())
        } catch (e: Exception) {
            -1
        }

        /** E32 (= Cordova device context) plus always-on `webview.version` (P5). */
        fun deviceContext(ctx: Context): JSONObject {
            val m = ctx.resources.displayMetrics
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            val night = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
            val c = JSONObject()
                .put("device.platform", "android")
                .put("device.platform_version", Build.VERSION.RELEASE)
                .put("device.model", Build.MODEL)
                .put("device.manufacturer", Build.MANUFACTURER)
                .put("device.brand", Build.BRAND)
                .put("device.android_sdk", Build.VERSION.SDK_INT)
                .put("device.android_release", Build.VERSION.RELEASE)
                .put("device.hardware", Build.HARDWARE)
                .put("device.product", Build.PRODUCT)
                .put("device.locale", Locale.getDefault().toLanguageTag())
                .put("device.timezone", TimeZone.getDefault().id)
                .put("device.low_ram", am?.isLowRamDevice == true)
                .put("device.dark_mode", night == Configuration.UI_MODE_NIGHT_YES)
                .put("device.cpu_abi", Build.SUPPORTED_ABIS.firstOrNull())
                .put("device.cpu_cores", Runtime.getRuntime().availableProcessors())
                .put("device.screen_density", m.densityDpi)
                .put("device.screen_width_px", m.widthPixels)
                .put("device.screen_height_px", m.heightPixels)
            // ponytail: API 26+ only; below it the key is omitted (minSdk 24 devices are rare).
            if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.versionName?.let { c.put("webview.version", it) }
            return c
        }

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

/** E12: JNI entry of `native-crash.c` (`libedge-rum-native.so`); idempotent. */
internal object Ndk {
    @JvmStatic external fun install(reportPath: String)
}
