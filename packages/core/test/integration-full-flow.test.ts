/**
 * Integration tests — end-to-end EdgeRum flow with a mocked transport.
 *
 * These exercise the real EdgeRum.init() path, real Collector, real Pipeline, real
 * SessionManager, real PayloadBuilder — only `fetch` is mocked. The goal is to catch
 * cross-module regressions that unit tests miss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EdgeRum,
  __getCollector,
  __getPipeline,
  __getSession,
  __setTransportFetch,
  __resetEdgeRumForTests,
} from '../src/EdgeRum';
import type { FetchLike } from '../src/transport/RetryTransport';

const config = {
  apiKey: 'edge_integration_key',
  endpoint: 'https://collector.example.com/collector/telemetry',
  appName: 'TestApp',
  appVersion: '4.2.1',
  appPackage: 'com.test.app',
  appBuild: '42',
  environment: 'production' as const,
  batchSize: 100,
  flushIntervalMs: 60_000, // big — never auto-flush; we flush manually
};

interface SentBatch {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function setupTransport(): { sent: SentBatch[]; fetchFn: FetchLike } {
  const sent: SentBatch[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    sent.push({ url, headers, body: JSON.parse(bodyText) });
    return new Response('', { status: 200 });
  };
  return { sent, fetchFn };
}

describe('Integration — full init → events → flush', () => {
  let sent: SentBatch[];
  let fetchFn: FetchLike;

  beforeEach(() => {
    __resetEdgeRumForTests();
    ({ sent, fetchFn } = setupTransport());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetEdgeRumForTests();
  });

  it('init emits a session.started event in the first batch', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);
    await __getPipeline()!.flush();

    expect(sent).toHaveLength(1);
    const batch = sent[0]!.body as { type: string; events: Array<Record<string, unknown>> };
    expect(batch.type).toBe('telemetry_batch');
    const sessionStarted = batch.events.find(
      (e) => (e as { eventName?: string }).eventName === 'session.started',
    );
    expect(sessionStarted).toBeDefined();
    expect((sessionStarted as { attributes: Record<string, unknown> }).attributes['session.start_reason']).toBe('init');
  });

  it('a realistic event mix produces a well-formed batch', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);

    EdgeRum.identify({ name: 'Alice', email: 'alice@example.com' });
    EdgeRum.track('checkout_started', { amount: 49.99, currency: 'GBP' });
    EdgeRum.trackScreen('CheckoutModal');
    EdgeRum.time('image_upload').end({ file_size_kb: 1024 });
    EdgeRum.captureError(new Error('payment_failed'), { step: 'confirm' });

    await __getPipeline()!.flush();

    expect(sent.length).toBeGreaterThanOrEqual(1);
    const allEvents = sent.flatMap((b) => (b.body as { events: Array<Record<string, unknown>> }).events);

    // session.started (from init)
    expect(allEvents.find((e) => (e as { eventName?: string }).eventName === 'session.started')).toBeDefined();
    // user.profile.update (from identify)
    expect(allEvents.find((e) => (e as { eventName?: string }).eventName === 'user.profile.update')).toBeDefined();
    // custom_event (from track)
    const custom = allEvents.find((e) => (e as { eventName?: string }).eventName === 'custom_event');
    expect(custom).toBeDefined();
    expect((custom as { attributes: Record<string, unknown> }).attributes['event.name']).toBe('checkout_started');
    expect((custom as { attributes: Record<string, unknown> }).attributes['amount']).toBe(49.99);
    // navigation (from trackScreen)
    const nav = allEvents.find((e) => (e as { eventName?: string }).eventName === 'navigation');
    expect(nav).toBeDefined();
    expect((nav as { attributes: Record<string, unknown> }).attributes['navigation.to_screen']).toBe('CheckoutModal');
    // metric (from time)
    const metric = allEvents.find((e) => (e as { type?: string }).type === 'metric');
    expect(metric).toBeDefined();
    expect((metric as { metricName?: string }).metricName).toBe('image_upload');
    // app.crash (from captureError)
    const crash = allEvents.find((e) => (e as { eventName?: string }).eventName === 'app.crash');
    expect(crash).toBeDefined();
    expect((crash as { attributes: Record<string, unknown> }).attributes['cause']).toBe('ManualCapture');
  });

  it('every event carries the full identity context', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);

    EdgeRum.track('a');
    EdgeRum.track('b');
    await __getPipeline()!.flush();

    const allEvents = sent.flatMap((b) => (b.body as { events: Array<Record<string, unknown>> }).events);
    for (const item of allEvents) {
      const attrs = (item as { attributes: Record<string, unknown> }).attributes;
      expect(attrs['app.name']).toBe('TestApp');
      expect(attrs['app.version']).toBe('4.2.1');
      expect(attrs['app.package_name']).toBe('com.test.app');
      expect(attrs['app.build_number']).toBe('42');
      expect(attrs['app.environment']).toBe('production');
      expect(attrs['session.id']).toMatch(/^session_\d+_[a-f0-9]{16}_(ios|android|web)$/);
      expect(attrs['user.id']).toMatch(/^user_\d+_[a-f0-9]{16}$/);
      expect(attrs['sdk.contract_version']).toBe('3.1.0');
      expect(attrs['sdk.platform']).toBe('ionic-angular-capacitor');
    }
  });

  it('every batch envelope is well-formed', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);

    EdgeRum.track('e');
    await __getPipeline()!.flush();

    for (const batch of sent) {
      expect(batch.url).toBe('https://collector.example.com/collector/telemetry');
      expect(batch.headers['content-type']).toBe('application/json');
      expect(batch.headers['x-api-key']).toBe('edge_integration_key');
      expect(batch.body['type']).toBe('telemetry_batch');
      expect(batch.body['timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const events = batch.body['events'] as Array<unknown>;
      expect(Array.isArray(events)).toBe(true);
      expect(batch.body['batch_size']).toBe(events.length);
    }
  });

  it('attributes are flat primitives only (no nested objects)', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);

    EdgeRum.identify({ name: 'A', email: 'b' });
    EdgeRum.track('e', { x: 1, y: 'a', z: true });
    await __getPipeline()!.flush();

    const allEvents = sent.flatMap((b) => (b.body as { events: Array<Record<string, unknown>> }).events);
    for (const item of allEvents) {
      const attrs = (item as { attributes: Record<string, unknown> }).attributes;
      for (const [key, value] of Object.entries(attrs)) {
        // crash.breadcrumbs is the one documented JSON-string exception, but it's still a string.
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  it('session.sequence increments after each successful send', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);
    const session = __getSession()!;
    expect(session.getSequence()).toBe(0);

    EdgeRum.track('a');
    await __getPipeline()!.flush();
    expect(session.getSequence()).toBe(1);

    EdgeRum.track('b');
    await __getPipeline()!.flush();
    expect(session.getSequence()).toBe(2);
  });

  it('app.crash carries breadcrumbs from preceding events', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);

    EdgeRum.track('action-a');
    EdgeRum.track('action-b');
    EdgeRum.trackScreen('Home');
    EdgeRum.captureError(new Error('boom'));
    await __getPipeline()!.flush();

    const allEvents = sent.flatMap((b) => (b.body as { events: Array<Record<string, unknown>> }).events);
    const crash = allEvents.find((e) => (e as { eventName?: string }).eventName === 'app.crash');
    const crumbsJson = (crash as { attributes: Record<string, unknown> }).attributes[
      'crash.breadcrumbs'
    ] as string;
    expect(typeof crumbsJson).toBe('string');
    const crumbs = JSON.parse(crumbsJson) as Array<{ type: string; name: string }>;
    // Should include the three preceding events (session.started + 2 track + 1 trackScreen)
    expect(crumbs.length).toBeGreaterThanOrEqual(3);
    expect(crumbs.some((c) => c.type === 'custom_event' && c.name === 'action-a')).toBe(true);
    expect(crumbs.some((c) => c.type === 'navigation' && c.name === 'Home')).toBe(true);
  });

  it('a successful send triggers an opportunistic offline-queue drain attempt', async () => {
    // Pipeline.flush() should call flushOfflineQueue after every successful send —
    // this is the self-healing path. (The 4-attempt retry path itself is exercised
    // directly in retry-transport.test.ts; covering the whole 40s retry schedule
    // here would make CI prohibitively slow.)
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);
    const pipeline = __getPipeline()!;
    const drainSpy = vi.spyOn(pipeline, 'flushOfflineQueue');

    EdgeRum.track('a');
    await pipeline.flush();

    expect(drainSpy).toHaveBeenCalled();
  });

  it('session.finalized carries the journey summary built from navigation events', async () => {
    EdgeRum.init(config);
    __setTransportFetch(fetchFn);

    // Visit three screens
    EdgeRum.trackScreen('Home');
    EdgeRum.trackScreen('Profile');
    EdgeRum.trackScreen('Settings');

    // Emit a finalized via the collector directly (LifecycleCapture would normally do this)
    const collector = __getCollector()!;
    const session = __getSession()!;
    const journey = session.getJourneySnapshot();
    collector.recordEvent('session.finalized', {
      'session.id': session.getSessionId(),
      'session.start_time': session.getStartTime(),
      'session.sequence': session.getSequence(),
      'session.duration_ms': 5000,
      'session.ended_at': new Date().toISOString(),
      'session.end_reason': 'backgrounded',
      ...journey,
    });

    await __getPipeline()!.flush();

    const allEvents = sent.flatMap((b) => (b.body as { events: Array<Record<string, unknown>> }).events);
    const finalized = allEvents.find((e) => (e as { eventName?: string }).eventName === 'session.finalized');
    expect(finalized).toBeDefined();
    const attrs = (finalized as { attributes: Record<string, unknown> }).attributes;
    expect(attrs['session.visited_screens']).toBe('Home,Profile,Settings');
    expect(attrs['session.screen_count']).toBe(3);
    expect((attrs['session.event_count'] as number)).toBeGreaterThanOrEqual(3);
    expect(attrs['session.end_reason']).toBe('backgrounded');
  });
});
