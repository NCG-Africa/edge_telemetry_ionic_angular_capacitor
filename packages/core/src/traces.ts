import { call, state, type EventAttributes } from './core';

// Spec X1–X10 (ADR-035): one ambient root, read synchronously by the request patches. Wire =
// Android trace v3 (`TraceManager.kt`) plus `skipped_no_cors` / `skipped_no_session`.

type RootType = 'launch' | 'interaction' | 'navigation' | 'request' | 'resume';
interface Root { id: string; span: string; type: RootType; startMs: number; opened: number; touched: number }

/** A request's trace decision: the header to write (none = leave the consumer's alone) and its row keys. */
export interface RequestTrace {
  header?: string;
  /** Row keys at completion; extends the root (X1). */
  end: (durationMs: number) => EventAttributes;
}

const IDLE_MS = 2000; // X1
const CAP_MS = 10_000; // X1

let root: Root | undefined;
/** A root existed and was cleared or aged out: the next unattributed request is `injected_expired` (X9). */
let stale = false;
let allow: string[] = [];

const mono = () => performance.now();
const epoch = () => performance.timeOrigin + performance.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** X9: `crypto.getRandomValues`, lowercase hex, all-zero rejected. */
function hex(bytes: number): string {
  for (;;) {
    const s = Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    if (/[^0]/.test(s)) return s;
  }
}

/** Tier 2 (X8): join keys only. */
const tier2 = (r: Root): EventAttributes => ({ 'trace.id': r.id, 'rum.action.id': r.span, 'trace.root_type': r.type });

/** X1 lazy expiry. `launch` is idle-exempt until the first resume, which replaces it (X2). */
function current(): Root | undefined {
  if (!root) return undefined;
  const t = mono();
  if ((root.type === 'launch' || t - root.touched <= IDLE_MS) && t - root.opened <= CAP_MS) return root;
  root = undefined;
  stale = true;
  return undefined;
}

/** X10: `setRoot` once per mint or replace. */
function mint(type: RootType, startMs = epoch()): Root {
  const t = mono();
  root = { id: hex(16), span: hex(8), type, startMs, opened: t, touched: t };
  stale = false;
  call('setRoot', tier2(root));
  return root;
}

/** X9: background and session rotation. Native keeps the ids and marks them ended. */
export function clearRoot(): void {
  if (!root) return;
  root = undefined;
  stale = true;
  call('setRoot', {});
}

const rootKeys = (r: Root): EventAttributes => ({
  'trace.id': r.id, 'span.id': r.span, 'rum.action.id': r.span, 'trace.root_type': r.type, 'span.start_time': iso(r.startMs),
});

const childKeys = (r: Root, startMs: number): EventAttributes => ({
  'trace.id': r.id, 'span.id': hex(8), 'parent.span.id': r.span, 'rum.action.id': r.span, 'trace.root_type': r.type, 'span.start_time': iso(startMs),
});

/** X4 (Android `TelemetryConfig` rules): bare host, exact or `.suffix` with ≥ 2 labels. Bad entries dropped. */
function normalize(entries: unknown): string[] {
  const out: string[] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const h = typeof e === 'string' ? e.trim().toLowerCase() : '';
    if (h && !/[/:\s]/.test(h) && (!h.startsWith('.') || h.slice(1).includes('.'))) out.push(h);
    else if (state.options.debug) console.warn(`[edge-rum] traceHostAllowlist entry ${String(e)} ignored: use a bare host or .suffix`);
  }
  return out;
}

/** X4: exact, or a true suffix for a leading-dot entry. Never a substring. */
const allowed = (host: string) => allow.some((e) => (e.startsWith('.') ? host.endsWith(e) : host === e));

/** W3C parse, Android's rules: `[traceId, parentId]` lowercased, or nothing if absent or malformed. */
export function parseTraceparent(v: string | null | undefined): [string, string] | undefined {
  const [ver = '', id = '', parent = '', flags = ''] = (v ?? '').split('-');
  const ok = (s: string, n: number) => s.length === n && /^[0-9a-f]+$/i.test(s);
  if (!ok(ver, 2) || ver.toLowerCase() === 'ff' || !ok(flags, 2)) return undefined;
  if (!ok(id, 32) || !ok(parent, 16) || !/[^0]/.test(id) || !/[^0]/.test(parent)) return undefined;
  return [id.toLowerCase(), parent.toLowerCase()];
}

/** Init: the `launch` root (X2), Tier-2 annotation for `record()`, the empty-allowlist warning (X4). */
export function startTraces(allowlist: unknown): void {
  allow = normalize(allowlist);
  if (!allow.length && state.options.debug) console.warn('[edge-rum] traceHostAllowlist is empty: no traceparent header is sent on any request');
  state.annotate = () => {
    const r = current();
    return r && tier2(r);
  };
  state.onAppState = (active) => (active ? mint('resume') : clearRoot());
  mint('launch', performance.timeOrigin);
}

/** X2 / X8: a click always mints a new `interaction` root; Tier-1 keys for its event. */
export const interactionRoot = (): EventAttributes => rootKeys(mint('interaction'));

/** X2 / X8: Router `NavigationStart` mints only when no root is live; otherwise a child of it. */
export const navigationSpan = (): EventAttributes => childSpan() ?? rootKeys(mint('navigation'));

/** X1: a child is starting. Extends the live root and returns its `span.id`, if one is live. */
export function touchRoot(): string | undefined {
  const r = current();
  if (r) r.touched = mono();
  return r?.span;
}

/** X6 / X8: a Capacitor plugin call is a child of the live root; nothing when none is live. */
export function childSpan(): EventAttributes | undefined {
  const r = current();
  if (!r) return undefined;
  r.touched = mono(); // X1: a child start extends the root
  return childKeys(r, epoch());
}

/**
 * X3–X8 for one request at send. `url` resolved, proxy unwrapped; `consumer` = the app's own
 * `traceparent`, if any. Nothing at all for a sampled-out session (X5).
 */
export function traceRequest(url: string, consumer: string | null | undefined, noCors: boolean): RequestTrace | undefined {
  if (state.sampled === false) return undefined;
  const t0 = epoch();
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // No host, nothing allowlisted.
  }
  const foreign = parseTraceparent(consumer);
  // X7 precedence: off_allowlist > no_cors > no_session > adopted > injected_*.
  const skip = !allowed(host) ? 'skipped_off_allowlist' : noCors ? 'skipped_no_cors' : !state.ready ? 'skipped_no_session' : undefined;
  let r = current();
  let keys: EventAttributes;
  if (!skip && foreign) {
    // X5: the consumer's trace; `rum.action.id` stays the local root's span. Header untouched.
    keys = { 'trace.id': foreign[0], 'span.id': foreign[1], 'span.start_time': iso(t0), 'traceparent.outcome': 'adopted' };
    if (r) Object.assign(keys, { 'rum.action.id': r.span, 'trace.root_type': r.type });
  } else {
    const outcome = skip ?? (r ? 'injected_attributed' : stale ? 'injected_expired' : 'injected_unattributed');
    if (r) {
      r.touched = mono(); // X1: a child start extends the root
      keys = childKeys(r, t0);
    } else if (skip) {
      // Android: a skip stamps parentless ids and never writes the carrier (no root, no `setRoot`).
      keys = { 'trace.id': hex(16), 'span.id': hex(8), 'span.start_time': iso(t0) };
    } else keys = rootKeys((r = mint('request', t0)));
    keys['traceparent.outcome'] = outcome;
  }
  const child = 'parent.span.id' in keys;
  const owner = r;
  return {
    header: skip || foreign ? undefined : `00-${keys['trace.id']}-${keys['span.id']}-01`,
    end: (durationMs) => {
      if (owner) owner.touched = mono(); // X1: completion extends the root
      // Children only: a root's extent is derived server-side.
      return child ? { ...keys, 'span.duration_ms': durationMs } : keys;
    },
  };
}
