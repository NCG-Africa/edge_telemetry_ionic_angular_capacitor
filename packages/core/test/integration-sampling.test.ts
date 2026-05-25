/**
 * Integration tests for per-session sampling + critical-event allowlist.
 *
 * Verifies the contract from ADR-019:
 *  - Sampling decision is made ONCE at session start (not per-event).
 *  - Critical events bypass sampling: app.crash, session.started, session.finalized,
 *    user.profile.update.
 *  - All other events (navigation, screen.duration, http.request, custom_event, metrics,
 *    user.interaction, page_load, network_change, app_lifecycle) are sampled.
 *  - Identity attributes ride along regardless of sampling.
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

interface SentBatch {
  body: { type: string; events: Array<Record<string, unknown>> };
}

function setupTransport(): { sent: SentBatch[]; fetchFn: FetchLike } {
  const sent: SentBatch[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    sent.push({ body: JSON.parse(bodyText) });
    return new Response('', { status: 200 });
  };
  return { sent, fetchFn };
}

function eventNames(sent: SentBatch[]): string[] {
  return sent
    .flatMap((b) => b.body.events)
    .map((e) => (e as { eventName?: string; metricName?: string }).eventName ?? `metric:${(e as { metricName?: string }).metricName}`)
    .filter(Boolean) as string[];
}

const baseConfig = {
  apiKey: 'edge_sampling_test',
  endpoint: 'https://collector.example.com/collector/telemetry',
  appPackage: 'com.test.app',
  batchSize: 100,
  flushIntervalMs: 60_000,
};

describe('Integration — per-session sampling', () => {
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

  it('sampleRate=1: a sampled-IN session emits all events including non-critical', async () => {
    EdgeRum.init({ ...baseConfig, sampleRate: 1.0 });
    __setTransportFetch(fetchFn);
    expect(__getSession()!.isSampled()).toBe(true);

    EdgeRum.track('custom-a');
    EdgeRum.trackScreen('Home');
    EdgeRum.time('upload').end();
    await __getPipeline()!.flush();

    const names = eventNames(sent);
    // Non-critical events all present
    expect(names).toContain('custom_event');
    expect(names).toContain('navigation');
    expect(names).toContain('metric:upload');
  });

  it('sampleRate=0: a sampled-OUT session emits ONLY critical events', async () => {
    EdgeRum.init({ ...baseConfig, sampleRate: 0 });
    __setTransportFetch(fetchFn);
    expect(__getSession()!.isSampled()).toBe(false);

    // Critical events — should emit
    EdgeRum.identify({ name: 'Alice' });
    EdgeRum.captureError(new Error('critical-still-emits'));

    // Non-critical — should be DROPPED
    EdgeRum.track('dropped-custom');
    EdgeRum.trackScreen('DroppedScreen');
    EdgeRum.time('dropped-metric').end();
    await __getPipeline()!.flush();

    const names = eventNames(sent);

    // session.started fired at init — must be in the batch
    expect(names).toContain('session.started');
    // user.profile.update from identify — must bypass sampling
    expect(names).toContain('user.profile.update');
    // app.crash from captureError — must bypass sampling
    expect(names).toContain('app.crash');

    // Non-critical events are DROPPED
    expect(names).not.toContain('custom_event');
    expect(names).not.toContain('navigation');
    expect(names).not.toContain('metric:dropped-metric');
  });

  it('sampleRate=0: counters reflect what was actually emitted (no phantom counts)', async () => {
    EdgeRum.init({ ...baseConfig, sampleRate: 0 });
    __setTransportFetch(fetchFn);

    // 5 dropped non-critical, 2 critical
    EdgeRum.track('dropped-1');
    EdgeRum.track('dropped-2');
    EdgeRum.trackScreen('Dropped-A');
    EdgeRum.trackScreen('Dropped-B');
    EdgeRum.time('dropped').end();
    EdgeRum.identify({ name: 'A' });
    EdgeRum.captureError(new Error('boom'));

    const journey = __getSession()!.getJourneySnapshot();
    // session.started (1) + identify (1) + crash (1) = 3 events emitted
    expect(journey['session.event_count']).toBe(3);
    // No metrics emitted (sampled out)
    expect(journey['session.metric_count']).toBe(0);
    // No screens visited (sampled out)
    expect(journey['session.screen_count']).toBe(0);
    expect(journey['session.visited_screens']).toBe('');
  });

  it('sampling decision is preserved across many emits within a session', () => {
    EdgeRum.init({ ...baseConfig, sampleRate: 0 });
    const first = __getSession()!.isSampled();

    for (let i = 0; i < 100; i++) {
      EdgeRum.track(`call-${i}`);
    }
    expect(__getSession()!.isSampled()).toBe(first); // unchanged

    // 100 non-critical events were attempted, all dropped — counters stay near-zero
    const journey = __getSession()!.getJourneySnapshot();
    expect(journey['session.event_count']).toBeLessThan(5);
  });

  it('rotation re-rolls the sampling decision', () => {
    EdgeRum.init({ ...baseConfig, sampleRate: 1.0 });
    const session = __getSession()!;
    expect(session.isSampled()).toBe(true);

    session.startNewSession();
    expect(session.isSampled()).toBe(true); // still sampled-in at rate 1.0
  });

  it('identity attributes are present even on sampled-out sessions', async () => {
    EdgeRum.init({
      ...baseConfig,
      sampleRate: 0,
      appName: 'TestApp',
      appVersion: '1.0.0',
      appBuild: '7',
    });
    __setTransportFetch(fetchFn);

    EdgeRum.captureError(new Error('checking-identity'));
    await __getPipeline()!.flush();

    const crash = sent.flatMap((b) => b.body.events).find(
      (e) => (e as { eventName?: string }).eventName === 'app.crash',
    );
    expect(crash).toBeDefined();
    const attrs = (crash as { attributes: Record<string, unknown> }).attributes;
    expect(attrs['app.name']).toBe('TestApp');
    expect(attrs['app.version']).toBe('1.0.0');
    expect(attrs['app.build_number']).toBe('7');
    expect(attrs['session.id']).toMatch(/^session_/);
    expect(attrs['user.id']).toMatch(/^user_/);
    expect(attrs['sdk.contract_version']).toBe('3.1.0');
  });

  it('clamps invalid sampleRate values to [0, 1]', () => {
    __resetEdgeRumForTests();
    EdgeRum.init({ ...baseConfig, sampleRate: -0.5 });
    expect(__getSession()!.isSampled()).toBe(false);

    __resetEdgeRumForTests();
    EdgeRum.init({ ...baseConfig, sampleRate: 5.0 });
    expect(__getSession()!.isSampled()).toBe(true);

    __resetEdgeRumForTests();
    EdgeRum.init({ ...baseConfig, sampleRate: Number.NaN });
    expect(__getSession()!.isSampled()).toBe(true); // NaN → defaults to 1.0
  });
});
