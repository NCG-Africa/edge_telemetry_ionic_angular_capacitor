package com.nathanclaire.rum.core

import java.io.File
import java.io.IOException
import java.io.PrintWriter
import java.io.StringWriter
import java.math.BigInteger
import java.util.ArrayDeque
import java.util.Locale
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Spec A3, E12–E15, X10, Y3 (= Cordova `Crash`): the native breadcrumb mirror, the last trace root,
 * and the `app.crash` / `app.anr` / `app.hang` records built from them. JVM crashes are written
 * in-process; an NDK crash leaves a plain-text report (`native-crash.c`) that [takeNdk] turns into
 * an event next launch, under the identity, session, breadcrumbs and root saved by [saveContext].
 */
class Crash(dir: File, private val main: Thread, private val clock: () -> Long) {
    /** A record ready for [Outbox.writeSolo]. */
    class Pending(val identity: String, val event: String)

    private val report = File(dir, "ndk_crash.txt")
    private val context = File(dir, "crash_context.json")
    private val breadcrumbs = ArrayDeque<Any>()
    private var screen: String? = null
    /** X10: the last root JS relayed; never parents, never expires on its own. */
    private var root: JSONObject? = null

    init {
        dir.mkdirs()
    }

    fun ndkReportPath(): String = report.path

    /** A3: mirrors an `enqueue` hand-off's breadcrumbs (last 50) and its last screen. */
    @Synchronized
    fun mirror(payload: JSONObject) {
        val crumbs = payload.optJSONArray("breadcrumbs")
        for (i in 0 until (crumbs?.length() ?: 0)) {
            breadcrumbs.addLast(crumbs!!.opt(i))
            if (breadcrumbs.size > BREADCRUMBS) breadcrumbs.removeFirst()
        }
        val events = payload.optJSONArray("events")
        for (i in 0 until (events?.length() ?: 0)) {
            val to = events!!.optJSONObject(i)?.optJSONObject("attributes")?.optString("navigation.to_screen") ?: ""
            if (to.isNotEmpty()) screen = to
        }
    }

    /** A2 `setLastScreen`. */
    @Synchronized
    fun screen(s: String) {
        screen = s.ifEmpty { null }
    }

    @Synchronized
    fun screen(): String? = screen

    /**
     * X10 `setRoot`: a root's `trace.id` / `rum.action.id` / `trace.root_type`, or none when JS
     * cleared it (background, rotation). A cleared root keeps its ids and counts as expired.
     */
    @Synchronized
    fun setRoot(given: JSONObject?) {
        val traceId = given?.optString("trace.id").orEmpty()
        if (traceId.isEmpty()) {
            root?.put(KEY_ENDED, true)
            return
        }
        root = JSONObject()
            .put("trace.id", traceId)
            .put("rum.action.id", given!!.optString("rum.action.id"))
            .put("trace.root_type", given.optString("trace.root_type"))
            .put(KEY_SET_AT, clock())
    }

    /** E12: chained JVM handler; the previous one (normally the platform's, which kills) always runs after. */
    fun installJvm(sink: (JSONObject) -> Unit) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                sink(jvm(t, e))
            } catch (ignored: Throwable) {
                // Never let reporting replace the original crash.
            } finally {
                previous?.uncaughtException(t, e)
            }
        }
    }

    /** Y3: raw Throwable stack, N1 keys, sibling caps. */
    fun jvm(thread: Thread, e: Throwable): JSONObject {
        val stack = StringWriter().also { e.printStackTrace(PrintWriter(it)) }.toString()
        val a = JSONObject()
            .put("message", cap(e.javaClass.name + ": " + (e.message ?: ""), MAX_MESSAGE))
            .put("stacktrace", cap(stack, MAX_STACK))
            .put("exception_type", cap(e.javaClass.simpleName, MAX_CAUSE))
            .put("cause", cap(e.cause?.message ?: "unknown", MAX_CAUSE))
            .put("error_context", cap(jvmContext(stack), MAX_CONTEXT))
            .put("crash_thread", thread.name)
            .put("crash_is_main_thread", thread === main)
        val at = clock()
        return event("app.crash", at, fatal(a, at))
    }

    /** E13: WebView renderer death, fatal, same path as a JVM crash. `reason` is `crash` or `oom_killed`. */
    fun webViewTerminated(reason: String): JSONObject {
        val a = JSONObject()
            .put("message", "WebView renderer process gone ($reason)")
            .put("exception_type", "WebViewTerminated")
            .put("cause", "WebViewTerminated")
            .put("webview.reason", reason)
            .put("webview.detected_by", "callback")
        val at = clock()
        return event("app.crash", at, fatal(a, at))
    }

    /** E14 / E15: main-thread stall at or past its threshold. Not fatal, not handled; main stack only. */
    fun stall(name: String, durationMs: Long, stack: String): JSONObject {
        val a = JSONObject()
            .put("message", "Main thread blocked for $durationMs ms")
            .put("stacktrace", cap(stack, MAX_STACK))
            .put("crash_thread", main.name)
            .put("crash_is_main_thread", true)
            .put("is_fatal", false)
            .put("handled", false)
            .put(if (name == "app.anr") "anr_duration_ms" else "hang_duration_ms", durationMs)
        val at = clock()
        synchronized(this) {
            screen?.let { a.put("screen_name", it) }
            annotate(a, root, at)
        }
        return event(name, at, a)
    }

    /**
     * What an NDK crash report can't know: the identity, session, user, breadcrumbs and root of
     * the moment. Saved after every hand-off and root change; best effort.
     */
    fun saveContext(identity: String, sessionId: String?, userId: String?) {
        val tmp = File(context.path + ".tmp")
        try {
            val a = JSONObject().put("session.id", sessionId).put("user.id", userId)
            val ctx = JSONObject().put("identity", identity).put("attributes", a)
            synchronized(this) {
                a.put("crash.breadcrumbs", JSONArray(breadcrumbs).toString())
                screen?.let { a.put("screen_name", it) }
                root?.let { ctx.put("root", JSONObject(it.toString())) }
            }
            tmp.writeText(ctx.toString())
        } catch (e: IOException) {
            return
        }
        tmp.renameTo(context)
    }

    /**
     * Last launch's NDK crash, if any, as a solo-segment record under the crashed build's identity
     * (T4); the report is deleted. A report without a usable context (or a torn one) is dropped.
     */
    fun takeNdk(): Pending? {
        if (!report.exists()) return null
        return try {
            val ctx = JSONObject(context.readText())
            Pending(ctx.getString("identity"), ndk(report.readText(), ctx.getJSONObject("attributes"), ctx.optJSONObject("root")).toString())
        } catch (e: Exception) {
            null
        } finally {
            report.delete()
        }
    }

    /** P7 `disable()` / `reset()`: nothing from before survives. */
    fun clear() {
        report.delete()
        context.delete()
        synchronized(this) {
            breadcrumbs.clear()
            screen = null
            root = null
        }
    }

    private fun fatal(a: JSONObject, at: Long): JSONObject {
        synchronized(this) {
            a.put("crash.breadcrumbs", JSONArray(breadcrumbs).toString())
            screen?.let { a.put("screen_name", it) }
            annotate(a, root, at)
        }
        return fatalFlags(a)
    }

    companion object {
        const val BREADCRUMBS = 50
        /** X1 cap: no root lives past it, so a root older than this at the event is stale. */
        const val ROOT_CAP_MS = 10_000L
        private const val KEY_SET_AT = "set_at"
        private const val KEY_ENDED = "ended"
        /** Sibling `CrashReportingService` caps. */
        private const val MAX_MESSAGE = 1000
        private const val MAX_STACK = 2000
        private const val MAX_CAUSE = 255
        private const val MAX_CONTEXT = 500
        private val SIGNAL_NAMES = mapOf(4 to "SIGILL", 5 to "SIGTRAP", 6 to "SIGABRT", 7 to "SIGBUS", 8 to "SIGFPE", 11 to "SIGSEGV")

        /**
         * X8 Tier 2 + X10: the root's keys, plus `trace.root_expired=true` when JS had cleared it or
         * it was older than the cap at [at].
         */
        // ponytail: native sees mint time only, not JS's idle extensions, so idle-expired roots under
        // 10 s read as live; relay expiry through setRoot(null) from JS if that misattributes.
        private fun annotate(a: JSONObject, root: JSONObject?, at: Long) {
            if (root == null) return
            a.put("trace.id", root.getString("trace.id"))
                .put("rum.action.id", root.getString("rum.action.id"))
                .put("trace.root_type", root.getString("trace.root_type"))
            if (root.optBoolean(KEY_ENDED) || at - root.getLong(KEY_SET_AT) > ROOT_CAP_MS) a.put("trace.root_expired", true)
        }

        /** Y3: frames as a tombstone backtrace (`#00 pc <rel pc>  <image> (BuildId: <id>)`), ndk-stack readable. */
        fun ndk(report: String, context: JSONObject, root: JSONObject? = null): JSONObject {
            var signal = -1
            var code = 0
            var faultAddr = 0L
            var at = 0L
            var pid = -1L
            var tid = -2L
            var thread = ""
            val stack = StringBuilder()
            var top: String? = null
            var n = 0
            for (line in report.split('\n')) {
                val sp = line.indexOf(' ')
                if (sp < 0) continue
                val value = line.substring(sp + 1)
                when (line.substring(0, sp)) {
                    "signal" -> signal = value.toInt()
                    "code" -> code = value.toInt()
                    "fault_addr" -> faultAddr = BigInteger(value, 16).toLong()
                    "time_ms" -> at = value.toLong()
                    "pid" -> pid = value.toLong()
                    "tid" -> tid = value.toLong()
                    "thread" -> thread = value
                    "frame" -> {
                        // `<rel pc hex> <build id hex | -> <image path>`
                        val f = value.split(" ", limit = 3)
                        if (f.size < 3) continue
                        val image = f[2]
                        stack.append(String.format(Locale.US, "#%02d pc %016x  %s", n++, BigInteger(f[0], 16).toLong(), image))
                        if (f[1] != "-") stack.append(" (BuildId: ").append(f[1]).append(')')
                        stack.append('\n')
                        if (top == null) top = image.substringAfterLast('/') + "+0x" + f[0]
                    }
                }
            }
            if (signal < 0) throw JSONException("no signal in NDK report")
            val name = SIGNAL_NAMES[signal] ?: "SIG$signal"
            val a = JSONObject()
                .put("message", String.format(Locale.US, "%s, code %d, fault addr 0x%x", name, code, faultAddr))
                .put("stacktrace", cap(stack.toString(), MAX_STACK))
                .put("exception_type", name)
                .put("cause", "signal $signal")
                .put("error_context", top ?: "unknown")
                .put("crash_thread", thread)
                .put("crash_is_main_thread", pid == tid)
            // org.json `keys()` is a raw Iterator on Android.
            for (k in context.keys()) a.put(k as String, context.get(k))
            annotate(a, root, at)
            return event("app.crash", at, fatalFlags(a))
        }

        private fun fatalFlags(a: JSONObject) = a.put("is_fatal", true).put("handled", false)

        fun event(name: String, at: Long, attrs: JSONObject): JSONObject = JSONObject()
            .put("type", "event")
            .put("eventName", name)
            .put("timestamp", Sender.rfc3339(at))
            .put("attributes", attrs)

        /** Sibling `extractErrorContext`: `Class.method` of the first `at` frame. */
        private fun jvmContext(stack: String): String {
            val l = stack.lineSequence().map(String::trim).firstOrNull { it.startsWith("at ") } ?: return "unknown"
            val parts = l.substring(3).substringBefore('(').split('.')
            return if (parts.size >= 2) parts[parts.size - 2] + "." + parts.last() else parts[0]
        }

        private fun cap(s: String, max: Int) = if (s.length <= max) s else s.substring(0, max)
    }
}
