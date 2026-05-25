import { test, expect } from '@playwright/test';
import {
  allEvents,
  assertEnvelope,
  initHarness,
  resetIngest,
  waitForItem,
  waitForPayloads,
} from './helpers';

test.describe('session lifecycle e2e', () => {
  test.beforeEach(async ({ request }) => {
    await resetIngest(request);
  });

  test('init emits exactly one session.started with start_reason=init', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('flush-trigger');
    });

    const payloads = await waitForPayloads(request);
    for (const p of payloads) assertEnvelope(p);
    const events = allEvents(payloads);
    const started = events.filter((e) => e.eventName === 'session.started');
    expect(started).toHaveLength(1);
    expect(started[0]!.attributes['session.start_reason']).toBe('init');
  });

  test('session.started carries the full identity context (session/user/device/app/sdk)', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('x');
    });

    const payloads = await waitForPayloads(request);
    const started = allEvents(payloads).find((e) => e.eventName === 'session.started')!;
    const attrs = started.attributes;
    expect(attrs['session.id']).toMatch(/^session_\d+_[a-f0-9]{16}_(ios|android|web)$/);
    expect(attrs['session.start_time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attrs['user.id']).toMatch(/^user_\d+_[a-f0-9]{16}$/);
    expect(attrs['app.name']).toBe('IntegrationHarness');
    expect(attrs['app.package_name']).toBe('com.edgemetrics.test');
    expect(attrs['sdk.contract_version']).toBe('3.1.0');
    expect(attrs['sdk.platform']).toBe('ionic-angular-capacitor');
    expect(typeof attrs['session.is_first_session']).toBe('boolean');
    expect(typeof attrs['session.total_sessions']).toBe('number');
  });

  test('pagehide emits session.finalized with end_reason=app_closed and journey snapshot', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: {
        trackScreen: (n: string) => void;
        track: (n: string) => void;
        time: (n: string, d: number) => void;
        dispatchPagehide: () => void;
      } }).__edgeRumHarness;
      h.trackScreen('Home');
      h.trackScreen('Profile');
      h.track('purchase');
      h.time('upload', 1);
      // Give the timer a tick to fire so the metric counter increments
      setTimeout(() => h.dispatchPagehide(), 30);
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'session.finalized',
      { timeoutMs: 4_000 },
    );
    for (const p of payloads) assertEnvelope(p);
    const events = allEvents(payloads);
    const finalized = events.find((e) => e.eventName === 'session.finalized');
    expect(finalized).toBeDefined();
    expect(finalized!.attributes['session.end_reason']).toBe('app_closed');
    expect(typeof finalized!.attributes['session.duration_ms']).toBe('number');
    expect(finalized!.attributes['session.duration_ms']).toBeGreaterThanOrEqual(0);
    // Visited screens populated by trackScreen calls
    const visited = finalized!.attributes['session.visited_screens'] as string;
    expect(visited).toContain('Home');
    expect(visited).toContain('Profile');
    expect(finalized!.attributes['session.screen_count']).toBe(2);
    expect((finalized!.attributes['session.event_count'] as number)).toBeGreaterThan(0);
    // Health monitor count (should be 0 for a clean run)
    expect(finalized!.attributes['sdk.error_count']).toBeDefined();
  });

  test('session.finalized id matches the corresponding session.started id', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { dispatchPagehide: () => void } }).__edgeRumHarness;
      h.dispatchPagehide();
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'session.finalized',
    );
    const events = allEvents(payloads);
    const started = events.find((e) => e.eventName === 'session.started')!;
    const finalized = events.find((e) => e.eventName === 'session.finalized')!;
    expect(started.attributes['session.id']).toBe(finalized.attributes['session.id']);
  });

  test('pagehide twice does not emit a second session.finalized', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { dispatchPagehide: () => void } }).__edgeRumHarness;
      h.dispatchPagehide();
      h.dispatchPagehide();
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'session.finalized',
    );
    // Give a tick to ensure no second finalized races in
    await new Promise((r) => setTimeout(r, 500));
    const final = await waitForPayloads(request);
    const events = allEvents(final);
    const finalized = events.filter((e) => e.eventName === 'session.finalized');
    expect(finalized).toHaveLength(1);
  });
});
