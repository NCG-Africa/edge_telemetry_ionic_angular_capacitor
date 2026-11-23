package com.nathanclaire.rum.core

import java.io.File
import org.json.JSONArray
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Spec 2026-11-23 stable goldens, JS set: the rows `test/golden-batch.test.ts` hands to `enqueue`,
 * stamped by the session gate and sent by the real sender, dumped to `test/golden-raw/js`.
 * Skipped until vitest has written the rows (`scripts/conform.sh` runs both in order).
 */
class JsGoldenTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun jsRowsAsGoldenBatch() {
        val rows = File("../../../../test/golden-raw/js-rows.json")
        assumeTrue("run test/golden-batch.test.ts first", rows.exists())
        val events = JSONArray(rows.readText()).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
        val now = 1793008802000L // 2026-10-26T10:00:02.000Z
        val dir = File(tmp.root, "edge_rum")
        val health = Health(dir)
        val session = Session(IdGeneratorTest.FakeStore(), health, { now }, 1.0, { 0.0 }, { "session_1" }, { "u1" })
        session.begin() // its session.started bookend is native's, not part of the JS set
        val ctx = SignalsTest.deviceContext()
        session.context { ctx }
        SignalsTest.dumpGoldenBatch("batch.json", dir, health, now, session.admit(events), "js")
    }
}
