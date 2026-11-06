import { applyBeforeSend, type BeforeSend } from './beforeSend';
import { breadcrumbs } from './internal/breadcrumbs';

/** A value an event attribute may hold. */
export type AttributeValue = string | number | boolean;
/** Flat key/value attributes carried by an event. */
export type EventAttributes = Record<string, AttributeValue>;

/**
 * One captured event, as `beforeSend` sees it. Named events carry `eventName`; rows from
 * `measure()` / `time()` and performance captures carry `metricName` and a numeric `value`.
 */
export interface EdgeRumEvent {
  type: 'event' | 'metric';
  eventName?: string;
  metricName?: string;
  value?: number;
  /** UTC ISO 8601 capture time. */
  timestamp: string;
  attributes: EventAttributes;
}

/** A capture passed to `init({ captures })`, e.g. `vitals()`. Start it once; may return a stop function. */
export interface Capture {
  readonly name: string;
  start(): void | (() => void);
}

/** `EdgeRum.init()` options (all optional). Launch-time settings live in `capacitor.config.ts`. */
export interface EdgeRumOptions {
  /** Runtime API key; overrides the `capacitor.config.ts` value for this launch only (not stored). */
  apiKey?: string;
  /** Runtime ingest URL; overrides the `capacitor.config.ts` value for this launch only (not stored). */
  endpoint?: string;
  /** What to capture beyond errors and requests. `provideEdgeRum()` defaults to `defaultCaptures()`. */
  captures?: Capture[];
  /** Hosts that receive a `traceparent` request header: exact (`api.example.com`) or dot-anchored suffix (`.example.com`). Default none. */
  traceHostAllowlist?: string[];
  /** Requests to these URLs (substring or RegExp) are not captured. */
  ignoreUrls?: (string | RegExp)[];
  /** Further scrub a request URL after the built-in scrub; can only remove more. */
  sanitizeUrl?: (url: string) => string;
  /**
   * Inspect or edit each event before it leaves JS; return `null` to drop it. Must be synchronous.
   * Sees JS-captured events only: native-origin events (native crashes, launch time, lifecycle,
   * memory, network, sessions) bypass it. Session and trace keys are restored after it runs.
   */
  beforeSend?: BeforeSend;
  /** Release name stamped on JS errors, for source-map lookup. */
  release?: string;
  /** Log SDK warnings to the console. Default `false`. */
  debug?: boolean;
}

interface NativeState { enabled?: boolean; sessionId?: string | null; sampled?: boolean; type?: string }
type Method = (...args: unknown[]) => Promise<unknown>;
type Plugin = Record<string, Method>;
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  registerPlugin?: (name: string) => Plugin;
  Plugins?: Record<string, Plugin | undefined>;
}

const FLUSH_MS = 2000; // T1
const FLUSH_AT = 20; // T1
const BUFFER_CAP = 500; // A4
const TIER2_EVENTS = new Set(['app.crash', 'custom_event', 'screen.duration']); // X8

const cap = () => (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
let isLive: boolean | undefined;
/** A7 / R16: no native platform (web, SSR, tests without the bridge) → every method is a silent no-op. */
export const live = (): boolean => (isLive ??= !!cap()?.isNativePlatform?.());

/** A8: run outside Angular's zone so SDK timers and listeners never trigger change detection. */
export function outside<T>(f: () => T): T {
  const zone = (globalThis as { Zone?: { root: { run<R>(f: () => R): R } } }).Zone;
  return zone ? zone.root.run(f) : f();
}

/** A non-empty string, e.g. an event or task name. */
export const isName = (s: unknown): s is string => typeof s === 'string' && s !== '';
/** A value an attribute may hold (flat primitives only). */
export const isValue = (v: unknown): v is AttributeValue => ['string', 'number', 'boolean'].includes(typeof v);

export const state = {
  started: false,
  ready: false,
  enabled: true,
  sessionId: undefined as string | undefined,
  options: {} as EdgeRumOptions,
  globals: {} as EventAttributes,
  route: '/',
  /** E25 dead taps: bumped by every navigation and request. */
  activity: 0,
  /** Native S1 decision; `false` = no `traceparent` (X5). */
  sampled: undefined as boolean | undefined,
  /** X8 Tier-2 keys (`trace.id`, `rum.action.id`, `trace.root_type`) of the live trace root, if any. */
  annotate: (): EventAttributes | undefined => undefined,
  /** `appStateChange`: resume mints a root, background clears it (X2, X9). */
  onAppState: (() => {}) as (active: boolean) => void,
  /** Called when native reports a new session (E29 abandons open tasks). */
  onSessionChange: () => {},
};

let plugin: Plugin | undefined;
let buffer: EdgeRumEvent[] = [];
const drops: Record<string, number> = {};
const pending: (() => void)[] = [];
let consentOverride: boolean | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

// Never `return plugin` from a promise chain: Capacitor's proxy answers `.then` and breaks `await`.
// A missing method throws inside the chain, so it surfaces as a rejection like any native failure.
const invoke = (method: string, ...args: unknown[]) => Promise.resolve().then(() => (plugin?.[method] as Method)(...args));

/** Fire-and-forget A2 method; held until native state is known. */
export function call(method: string, arg?: object): void {
  if (!live()) return;
  whenReady(() => void invoke(method, arg).catch(() => {}));
}

/** Run once native state is known (immediately if it already is). */
export function whenReady(f: () => void): void {
  if (state.ready) f();
  else if (pending.length < BUFFER_CAP) pending.push(f); // A4 cap, also for held calls
}

export function setEnabled(on: boolean): void {
  if (!state.ready) consentOverride = on;
  state.enabled = on;
  if (!on) discard(); // consent, not loss: uncounted
}

/** Drop everything buffered, uncounted (reset, not loss). */
export function discard(): void {
  buffer = [];
  breadcrumbs.reset();
}

function count(reason: string, n = 1) {
  drops[reason] = (drops[reason] ?? 0) + n;
}

export const now = () => new Date().toISOString();
/** The current screen (normalised route or `trackScreen()` name). */
export const route = () => state.route;
/** Run just before the screen changes, while `route()` is still the old one (E7 screen windows). */
export const routeListeners = new Set<() => void>();

export function record(e: EdgeRumEvent): void {
  if (!live() || !state.enabled) return;
  e.attributes = { ...state.globals, ...e.attributes };
  // X8 Tier-2 keys; Y2: `release` only on JS-origin crashes (native crashes never pass through here).
  if (e.eventName && TIER2_EVENTS.has(e.eventName)) Object.assign(e.attributes, state.annotate());
  if (e.eventName === 'app.crash' && state.options.release) e.attributes.release = state.options.release;
  if (e.eventName && e.eventName !== 'app.crash') {
    const a = e.attributes;
    const name = a['navigation.to_screen'] ?? a['screen.name'] ?? a['ui.target'] ?? a['http.url'] ?? a['event.name'] ?? e.eventName;
    breadcrumbs.push({ ts: e.timestamp, type: e.eventName, name: String(name) });
  }
  buffer.push(e);
  if (buffer.length > BUFFER_CAP) {
    buffer.shift();
    count('js_buffer_full');
  }
  if (!state.ready) return;
  // T1: a crash may be the page's last act, so it doesn't wait for the timer.
  if (e.eventName === 'app.crash' || buffer.length >= FLUSH_AT) flush();
  else if (timer === undefined) timer = outside(() => setTimeout(flush, FLUSH_MS));
}

/** Record one named event. */
export const event = (eventName: string, attributes: EventAttributes = {}) =>
  record({ type: 'event', eventName, timestamp: now(), attributes });

/** Record one numeric row. */
export const metric = (metricName: string, value: number, attributes: EventAttributes = {}) =>
  record({ type: 'metric', metricName, value, timestamp: now(), attributes });

/** T1 hand-off: one `enqueue` with everything buffered, after `beforeSend` (P1). */
export function flush(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!state.ready || !state.enabled) return;
  const events: EdgeRumEvent[] = [];
  const hook = state.options.beforeSend;
  for (const e of buffer.splice(0)) {
    const out = hook ? applyBeforeSend(e, hook) : { kind: 'kept' as const, event: e };
    if (out.kind === 'kept') events.push(out.event);
    else {
      count(out.kind === 'dropped' ? 'before_send_null' : 'before_send_error');
      if (out.kind === 'failed' && state.options.debug) console.warn('[edge-rum] beforeSend threw or returned a non-event; event dropped');
    }
  }
  // JS-side drops ride the next hand-off; native folds them into `sdk.health`.
  // Cleared only once native has them, so a failed hand-off resends them.
  const sent = { ...drops };
  const hasDrops = Object.keys(sent).length > 0;
  // A3: new crumbs ride every hand-off so native's mirror is current if the app dies natively.
  const crumbs = breadcrumbs.take();
  if (!events.length && !hasDrops && !crumbs.length) return;
  invoke('enqueue', { events, breadcrumbs: crumbs, ...(hasDrops && { drops: sent }) }).then(() => {
    for (const [k, n] of Object.entries(sent)) {
      drops[k] = (drops[k] ?? 0) - n;
      if (!drops[k]) delete drops[k];
    }
  }, () => {
    breadcrumbs.markUnsent(crumbs);
    if (events.length) count('js_exec_failed', events.length); // A4: no JS fallback sender
  });
}

function applyNativeState(s: unknown) {
  if (!s || typeof s !== 'object') return;
  const n = s as NativeState;
  const before = state.sessionId;
  if (typeof n.enabled === 'boolean') setEnabled(consentOverride ?? n.enabled);
  consentOverride = undefined;
  state.sessionId = n.sessionId ?? undefined;
  if (typeof n.sampled === 'boolean') state.sampled = n.sampled;
  if (before && state.sessionId !== before) state.onSessionChange();
}

/** Connect to the native plugin once: subscribe, read state, then release everything held (A4). */
export function start(): void {
  const c = cap();
  if (state.started || !live() || !c) return;
  state.started = true;
  plugin = c.registerPlugin?.('EdgeRum') ?? c.Plugins?.EdgeRum;
  const markReady = () => {
    if (state.ready) return;
    state.ready = true;
    for (const f of pending.splice(0)) f();
    call('markPhase', { phase: 'bridgeReady', ts: Date.now() }); // A5
    flush();
  };
  outside(() => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    c.Plugins?.App?.addListener?.('appStateChange', (s: { isActive?: boolean }) => {
      state.onAppState(!!s.isActive);
      if (!s.isActive) flush();
    })?.catch(() => {});
    invoke('addListener', 'state', applyNativeState).catch(() => {});
    // Never blocks startup: a failed read still releases the buffer; native gates what it keeps.
    invoke('getState').then((s) => {
      applyNativeState(s);
      markReady();
    }, markReady);
  });
}
