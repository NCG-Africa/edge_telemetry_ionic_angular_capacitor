package com.nathanclaire.rum.core

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.Locale
import org.json.JSONException
import org.json.JSONObject

/**
 * Spec T1 (= Cordova T2–T4, T7): append-only NDJSON segments. The open segment's first line is the
 * identity frozen for the whole segment (T4); every later line is one event. One sealed segment =
 * one batch.
 */
class Outbox(private val dir: File, private val clock: () -> Long, private val health: Health) {
    class Segment(val identity: String?, val events: List<String>)

    private val open = File(dir, "open.ndjson.part")
    private var openCount = 0
    private var openedAt = 0L
    private var seq = 0
    private var sending: File? = null

    init {
        dir.mkdirs()
        // A previous process's open segment is sealed now and sent this launch (T3).
        seal()
    }

    /** Appends one hand-off and flushes it to the OS; seals every [SEAL_EVENTS] events. */
    @Synchronized
    @Throws(IOException::class)
    fun append(identity: String, events: List<String>) {
        var i = 0
        while (i < events.size) {
            // At least 1: if a seal's rename failed, the segment grows past 50 rather than spinning here.
            val n = minOf(events.size - i, maxOf(1, SEAL_EVENTS - openCount))
            write(identity, events.subList(i, i + n))
            i += n
            if (openCount >= SEAL_EVENTS) seal()
        }
    }

    private fun write(identity: String, events: List<String>) {
        val sb = StringBuilder()
        if (!open.exists()) {
            sb.append(identity).append('\n')
            openCount = 0
            openedAt = clock()
        }
        for (e in events) sb.append(e).append('\n')
        val before = open.length()
        try {
            FileOutputStream(open, true).use { it.write(sb.toString().toByteArray(Charsets.UTF_8)) }
        } catch (e: IOException) {
            // A partial write would end up mid-file once the next hand-off lands; cut it off.
            try {
                RandomAccessFile(open, "rw").use { it.setLength(before) }
            } catch (ignored: IOException) {
                // Truncation failed too: the torn line stays trailing until the next append.
            }
            if (before == 0L) open.delete()
            throw e
        }
        openCount += events.size
    }

    /**
     * T4: a native crash / ANR / hang record, sealed at once as a segment of its own under the
     * identity of the build that produced it. Marked `solo` so the sender keeps `sdk.health` out of
     * it (E31). Safe from a dying thread: one write, one rename.
     */
    @Synchronized
    @Throws(IOException::class)
    fun writeSolo(identity: String, event: String) {
        val tmp = File(dir, "solo.tmp")
        val line = try {
            JSONObject(identity).put("solo", true).toString()
        } catch (e: JSONException) {
            throw IOException(e)
        }
        tmp.writeText(line + '\n' + event + '\n')
        if (!tmp.renameTo(File(dir, sealedName(clock(), seq++)))) {
            tmp.delete()
            throw IOException("solo segment rename failed")
        }
    }

    /** 30 s after the open segment's first event (T3). */
    @Synchronized
    fun sealIfDue() {
        if (open.exists() && clock() - openedAt >= SEAL_AGE_MS) seal()
    }

    @Synchronized
    fun seal() {
        // On failure the segment stays open and the next append retries the seal.
        if (open.exists() && open.renameTo(File(dir, sealedName(clock(), seq++)))) openCount = 0
        enforceCaps()
    }

    /** P7: `disable()` / `reset()` delete everything unsent; not counted as drops. */
    @Synchronized
    fun clear() {
        open.delete()
        openCount = 0
        for (f in sealed()) f.delete()
    }

    /** Sealed segments, oldest first. */
    fun sealed(): List<File> =
        dir.listFiles { _, name -> sealedAt(name) >= 0 }?.sorted() ?: emptyList()

    /** Reads a segment; a torn trailing line (no newline, e.g. killed mid-write) is discarded. */
    @Throws(IOException::class)
    fun read(f: File): Segment {
        val text = f.readText()
        val lines = text.substring(0, text.lastIndexOf('\n') + 1).split('\n').filter { it.isNotEmpty() }
        if (lines.isEmpty()) return Segment(null, emptyList())
        return Segment(lines[0], lines.subList(1, lines.size))
    }

    /** The segment the sender is posting; caps leave it alone so it isn't counted as dropped. */
    @Synchronized
    fun sending(f: File?) {
        sending = f
    }

    /** T7: over 5 MB or 200 segments → drop oldest; older than 7 days → drop. Counted (T8). */
    private fun enforceCaps() {
        val files = sealed()
        var total = files.sumOf { it.length() }
        var count = files.size
        val now = clock()
        for (f in files) {
            val expired = now - sealedAt(f.name) > MAX_AGE_MS
            if (!expired && total <= MAX_BYTES && count <= MAX_SEGMENTS) break
            if (f == sending) continue
            val events = try {
                read(f).events.size
            } catch (e: IOException) {
                0
            }
            total -= f.length()
            count--
            f.delete()
            health.count(if (expired) "expired" else "outbox_full", events.toLong())
        }
    }

    companion object {
        const val SEAL_EVENTS = 50
        const val SEAL_AGE_MS = 30_000L
        const val MAX_BYTES = 5L * 1024 * 1024
        const val MAX_SEGMENTS = 200
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

        private val SEALED = Regex("(\\d{13})-\\d{6}\\.ndjson")

        /** Seal time + per-process sequence, so name order is age order. */
        private fun sealedName(sealedAt: Long, seq: Int) = String.format(Locale.US, "%013d-%06d.ndjson", sealedAt, seq)

        /** Seal time from a sealed segment's name; -1 for any other file. */
        private fun sealedAt(name: String): Long = SEALED.matchEntire(name)?.groupValues?.get(1)?.toLong() ?: -1
    }
}
