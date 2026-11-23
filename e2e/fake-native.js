// Spec Q1: fake Capacitor bridge for the browser harness. Stands in for the native `EdgeRum`
// plugin (A2): logs every call (the specs pin the A2 table against it) and posts each `enqueue`
// to mock-ingest as a contract-4 batch, as the native sender would.
// `__native.log` / `__native.post` let the bench switch off the harness's own costs.
window.__calls = [];
window.__native = { log: true, post: true };
const realFetch = window.fetch.bind(window); // the SDK patches fetch; native sends don't go through it

const state = { enabled: true, sessionId: 'harness-session', sampled: true, configured: true, sdkVersion: '0.0.0', deviceStartedAt: Date.now() };
const listeners = [];

function enqueue({ events }) {
  if (!window.__native.post) return Promise.resolve();
  const batch = {
    type: 'telemetry_batch',
    contract_version: '4.3.0',
    timestamp: new Date().toISOString(),
    batch_size: events.length,
    device_id: 'harness-device',
    sdk: { name: 'ionic', version: '0.0.0' },
    app: { name: 'harness', version: '1.0.0', build_number: '1', platform: 'ios' },
    // Native stamps identity at append (A1); mirrored here so specs can see it.
    events: events.map((e) => ({ ...e, attributes: { ...e.attributes, 'session.id': state.sessionId } })),
  };
  return realFetch('http://localhost:4319/collector/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'edge_test_key' },
    body: JSON.stringify(batch),
  }).then((r) => (r.ok ? undefined : Promise.reject(new Error(String(r.status)))));
}

const plugin = {
  addListener(event, cb) {
    if (window.__native.log) window.__calls.push({ method: 'addListener', arg: event });
    listeners.push(cb);
    return Promise.resolve({ remove() {} });
  },
};
for (const method of ['getState', 'enqueue', 'configure', 'identify', 'clearUser', 'enable', 'disable', 'reset', 'markPhase', 'setLastScreen', 'setRoot']) {
  plugin[method] = (arg) => {
    if (window.__native.log) window.__calls.push({ method, arg: arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)) });
    if (method === 'getState') return Promise.resolve({ ...state });
    if (method === 'enqueue') return enqueue(arg);
    return Promise.resolve();
  };
}

/** Rotate the session as native would (spec E1), notifying `addListener('state')`. */
window.__rotate = (sessionId) => {
  state.sessionId = sessionId;
  for (const cb of listeners) cb({ type: 'session', ...state });
};

window.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'ios',
  registerPlugin: (name) => (name === 'EdgeRum' ? plugin : undefined),
  Plugins: {},
};
