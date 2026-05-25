import { test, expect } from '@playwright/test';
import {
  allEvents,
  assertEnvelope,
  initHarness,
  resetIngest,
  waitForItem,
  waitForPayloads,
} from './helpers';

test.describe('click capture and breadcrumbs e2e', () => {
  test.beforeEach(async ({ request }) => {
    await resetIngest(request);
  });

  test('clicking a real DOM button emits a user.interaction event', async ({ page, request }) => {
    await initHarness(page);
    // The harness HTML has <button id="click-target" class="primary lg" role="button" aria-label="Buy now">
    await page.click('#click-target');
    // Trigger a flush
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('after-click');
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'user.interaction',
    );
    for (const p of payloads) assertEnvelope(p);
    const interaction = allEvents(payloads).find((e) => e.eventName === 'user.interaction');
    expect(interaction).toBeDefined();
    expect(interaction!.attributes['interaction.type']).toBe('click');
    expect(interaction!.attributes['interaction.target_tag']).toBe('BUTTON');
    expect(interaction!.attributes['interaction.target_id']).toBe('click-target');
    expect(interaction!.attributes['interaction.target_class']).toContain('primary');
    // role attr present
    expect(interaction!.attributes['interaction.target_role']).toBe('button');
  });

  test('user.interaction NEVER carries inner text (PII guard)', async ({ page, request }) => {
    await initHarness(page);
    await page.click('#click-target');
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('flush');
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'user.interaction',
    );
    const interaction = allEvents(payloads).find((e) => e.eventName === 'user.interaction');
    expect(interaction).toBeDefined();
    expect(interaction!.attributes).not.toHaveProperty('interaction.target_text');
    // The button's innerText is "Click me" — must never appear anywhere
    const serialised = JSON.stringify(interaction);
    expect(serialised).not.toContain('Click me');
  });

  test('rapid duplicate clicks are deduped within 50ms', async ({ page, request }) => {
    await initHarness(page);
    // Click the same button three times in rapid succession via JS (not page.click which has its own delays)
    await page.evaluate(() => {
      const btn = document.getElementById('rage-target')!;
      btn.click();
      btn.click();
      btn.click();
    });
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('flush');
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'user.interaction',
    );
    const interactions = allEvents(payloads).filter(
      (e) => e.eventName === 'user.interaction' && e.attributes['interaction.target_id'] === 'rage-target',
    );
    // First click captured; the rapid duplicates within 50ms are dropped
    expect(interactions).toHaveLength(1);
  });

  test('app.crash carries crash.breadcrumbs JSON-string with preceding actions', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: {
        track: (n: string) => void;
        trackScreen: (n: string) => void;
        captureError: (m: string) => void;
      } }).__edgeRumHarness;
      h.trackScreen('Home');
      h.trackScreen('Profile');
      h.track('viewed-product');
      h.captureError('boom');
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'app.crash',
    );
    const crash = allEvents(payloads).find((e) => e.eventName === 'app.crash');
    expect(crash).toBeDefined();
    const crumbsJson = crash!.attributes['crash.breadcrumbs'] as string;
    expect(typeof crumbsJson).toBe('string');
    const crumbs = JSON.parse(crumbsJson) as Array<{ ts: string; type: string; name: string }>;
    expect(Array.isArray(crumbs)).toBe(true);
    expect(crumbs.length).toBeGreaterThanOrEqual(3);
    // Should include the two trackScreen navigations and the custom_event
    expect(crumbs.some((c) => c.type === 'navigation' && c.name === 'Home')).toBe(true);
    expect(crumbs.some((c) => c.type === 'navigation' && c.name === 'Profile')).toBe(true);
    expect(crumbs.some((c) => c.type === 'custom_event' && c.name === 'viewed-product')).toBe(true);
    expect(crash!.attributes['crash.breadcrumb_count']).toBe(crumbs.length);
  });

  test('breadcrumbs do NOT include the crash event itself (no recursion)', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { captureError: (m: string) => void } }).__edgeRumHarness;
      h.captureError('first');
      h.captureError('second');
    });

    // Wait for at least one crash; both should land together since app.crash flushes immediately.
    let payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'app.crash',
    );
    // Give the second crash a chance to also land.
    await new Promise((r) => setTimeout(r, 200));
    payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.attributes['message'] === 'second',
    );
    const crashes = allEvents(payloads).filter((e) => e.eventName === 'app.crash');
    expect(crashes.length).toBeGreaterThanOrEqual(2);
    for (const c of crashes) {
      const crumbs = JSON.parse(c.attributes['crash.breadcrumbs'] as string) as Array<{ type: string }>;
      // No breadcrumb of type app.crash
      expect(crumbs.some((b) => b.type === 'app.crash')).toBe(false);
    }
  });

  test('clicks update the session journey for visited_screens semantics (via interaction.screen)', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: {
        trackScreen: (n: string) => void;
      } }).__edgeRumHarness;
      h.trackScreen('Home');
    });
    await page.click('#click-target');
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('flush');
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'user.interaction',
    );
    const interaction = allEvents(payloads).find((e) => e.eventName === 'user.interaction')!;
    // After trackScreen('Home'), the click's interaction.screen should be 'Home'.
    expect(interaction.attributes['interaction.screen']).toBe('Home');
  });
});
