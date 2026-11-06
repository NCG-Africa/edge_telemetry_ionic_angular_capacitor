// Spec Q3 gate (= Cordova Q4 + router phases, HttpClient XHR, traceparent): drive the built demo/ on a
// booted Android emulator or iOS simulator through the `happy` deep link, then assert the batches
// mock-ingest received. No Appium.
// Usage: node e2e/device/gate.mjs android|ios   (after scripts/demo-build.sh <platform>)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2];
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'com.nathanclaire.rum.demo';
const INGEST = 'http://localhost:4319';
const TIMEOUT_MS = 120_000;

const sh = (cmd, ...args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryRun = (cmd, ...args) => {
  try {
    sh(cmd, ...args);
  } catch {
    // e.g. uninstalling what isn't installed
  }
};

const drivers = {
  android: {
    install() {
      tryRun('adb', 'uninstall', APP_ID); // fresh device_id + session
      sh('adb', 'install', join(root, 'demo/android/app/build/outputs/apk/debug/app-debug.apk'));
      sh('adb', 'reverse', 'tcp:4319', 'tcp:4319'); // the emulator's localhost:4319 → mock-ingest
    },
    // Cold launch with the deep link as an intent extra.
    launchHappy() {
      sh('adb', 'shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`, '--es', 'scenario', 'happy');
    },
    background: () => sh('adb', 'shell', 'input', 'keyevent', 'KEYCODE_HOME'),
  },
  ios: {
    install() {
      const build = join(root, 'demo/ios/App/build/Build/Products/Debug-iphonesimulator');
      const app = readdirSync(build).find((f) => f.endsWith('.app'));
      tryRun('xcrun', 'simctl', 'uninstall', 'booted', APP_ID); // fresh device_id + session
      sh('xcrun', 'simctl', 'install', 'booted', join(build, app));
    },
    // Cold launch with the deep link as a launch argument: `simctl openurl` stops at an "Open in…?" prompt.
    launchHappy() {
      sh('xcrun', 'simctl', 'launch', 'booted', APP_ID, '-scenario', 'happy');
    },
    background: () => sh('xcrun', 'simctl', 'launch', 'booted', 'com.apple.Preferences'),
  },
};

const driver = drivers[platform];
if (!driver) {
  console.error('usage: node e2e/device/gate.mjs android|ios');
  process.exit(2);
}

// Ours, not whatever else may hold :4319: wait for its own ready line, fail if it exits first.
const ingest = spawn(process.execPath, [join(root, 'e2e/mock-ingest-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const ready = new Promise((resolve, reject) => {
  ingest.stdout.on('data', (d) => (process.stdout.write(d), d.includes('listening') && resolve()));
  ingest.on('exit', (code) => reject(new Error(`mock-ingest exited (${code})`)));
});

async function requests() {
  return (await (await fetch(`${INGEST}/__requests`)).json()).requests;
}

const GATE = ['session.started', 'app.start', 'navigation', 'http.request', 'bridge.summary'];
const events = (reqs) => reqs.flatMap((r) => r.parsed?.events ?? []);
const named = (reqs, name) => events(reqs).filter((e) => e.eventName === name);

try {
  await ready;
  driver.install();
  driver.launchHappy();
  await sleep(8000); // launch + bootstrap + happy (~1 s), then the JS hand-off, with margin
  driver.background(); // seals the open segment (T3) and ends the app.start window

  const deadline = Date.now() + TIMEOUT_MS;
  let reqs = await requests();
  while (GATE.some((n) => named(reqs, n).length === 0) && Date.now() < deadline) {
    await sleep(2000);
    reqs = await requests();
  }
  console.log(`[gate] ${reqs.length} batches, events: ${[...new Set(events(reqs).map((e) => e.eventName ?? e.metricName))].join(', ')}`);

  for (const n of GATE) assert.ok(named(reqs, n).length > 0, `no ${n}`);

  // Envelope: X-API-Key, gzip, contract 4 (spec T2, W1).
  for (const r of reqs) {
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers['x-api-key'], 'demo-key');
    assert.equal(r.parseError, null);
    const b = r.parsed;
    assert.deepEqual(Object.keys(b).sort(), ['app', 'batch_size', 'contract_version', 'device_id', 'events', 'sdk', 'timestamp', 'type']);
    assert.equal(b.type, 'telemetry_batch');
    assert.equal(b.contract_version, '4.0.0');
    assert.match(b.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    assert.equal(b.batch_size, b.events.length);
    assert.ok(b.device_id);
    assert.equal(b.sdk.name, 'ionic');
    assert.ok(b.sdk.version);
    assert.equal(b.app.package_name, APP_ID);
    assert.equal(b.app.platform, platform);
    assert.ok(b.app.version);
  }

  // A5 / ADR-044: Capacitor phases, bridgeReady in place of deviceready.
  const start = named(reqs, 'app.start')[0].attributes;
  for (const k of ['app.start.duration_ms', 'app.start.webview_created_ms', 'app.start.load_ms', 'app.start.bridge_ready_ms']) {
    assert.equal(typeof start[k], 'number', `app.start without ${k}`);
  }

  // E4 + E19: the route template, with router phase keys (the route has a guard, a resolver, a lazy chunk).
  const nav = named(reqs, 'navigation').find((e) => e.attributes['navigation.to_screen'] === '/happy');
  assert.ok(nav, 'no navigation to /happy');
  for (const k of ['navigation.guards_ms', 'navigation.resolvers_ms', 'navigation.chunk_load_ms']) {
    assert.equal(typeof nav.attributes[k], 'number', `navigation without ${k}`);
  }

  // E6 + X7: the demo fetches ping.json only through HttpClient's XHR backend, to the allowlisted
  // app origin (localhost), so its row proves XHR capture and records the traceparent injection.
  const ping = named(reqs, 'http.request').find((e) => String(e.attributes['http.url']).endsWith('/ping.json'));
  assert.ok(ping, 'no http.request for ping.json');
  assert.match(String(ping.attributes['traceparent.outcome']), /^injected_/, 'ping.json carried no traceparent');
  assert.match(String(ping.attributes['trace.id']), /^[0-9a-f]{32}$/);

  // `slow`, not `listen`: the app calls `listen` on every launch, whatever the scenario.
  const timed = (e) => e.attributes['bridge.service'] === 'DemoScenarios' && e.attributes['bridge.action'] === 'slow';
  assert.ok(named(reqs, 'bridge.summary').some(timed), 'no bridge.summary for DemoScenarios.slow');
  console.log(`[gate] ${platform} OK`);
} catch (e) {
  console.error(`[gate] ${platform} FAILED`, e);
  console.error(JSON.stringify(events(await requests().catch(() => [])), null, 1));
  process.exitCode = 1;
} finally {
  ingest.kill();
}
