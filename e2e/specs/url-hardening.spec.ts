import { test, expect } from '@playwright/test';
import {
  allEvents,
  initHarness,
  resetIngest,
  waitForPayloads,
  TELEMETRY_ENDPOINT,
} from './helpers';

test.describe('URL hardening', () => {
  test.beforeEach(async ({ request }) => {
    await resetIngest(request);
  });

  test('default sanitizer strips PII query params from captured URLs', async ({ page, request }) => {
    await initHarness(page);

    // Make a user fetch that contains a sensitive query param
    await page.evaluate(async () => {
      try {
        await fetch('https://api.example.com/search?q=hats&token=SECRET_ABC123&password=x');
      } catch {
        // Expected — this URL won't actually resolve; we just need the fetch to be captured.
      }
    });

    const payloads = await waitForPayloads(request);
    const events = allEvents(payloads);
    const netReqs = events.filter((e) => e.eventName === 'network_request');
    expect(netReqs.length).toBeGreaterThanOrEqual(1);

    for (const ev of netReqs) {
      const url = ev.attributes['network.url'] as string;
      expect(url).not.toContain('token');
      expect(url).not.toContain('password');
      expect(url).not.toContain('SECRET_ABC123');
      // Non-sensitive param preserved
      expect(url).toContain('q=hats');
    }
  });

  test('SDK does not capture its own telemetry POSTs', async ({ page, request }) => {
    await initHarness(page);

    // Generate some events that will trigger the SDK to POST to the endpoint
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      for (let i = 0; i < 3; i++) h.track(`event_${i}`);
    });

    // Let batches flush
    await waitForPayloads(request, { minCount: 1 });
    await page.waitForTimeout(1500);

    const payloads = await waitForPayloads(request);
    const events = allEvents(payloads);

    // No network_request event should reference the telemetry endpoint
    const selfCapture = events.filter(
      (e) =>
        e.eventName === 'network_request' &&
        typeof e.attributes['network.url'] === 'string' &&
        (e.attributes['network.url'] as string).includes('/collector/telemetry'),
    );
    expect(selfCapture).toHaveLength(0);
  });

  test('fetch to the configured endpoint from user code is not captured', async ({ page, request }) => {
    await initHarness(page);

    // User code explicitly POSTs to the telemetry endpoint (as if they had a
    // conflicting route of their own, or in a test harness). It must not be
    // captured because the endpoint is auto-excluded from request capture.
    await page.evaluate(async (endpoint: string) => {
      try {
        await fetch(endpoint, { method: 'POST', body: '{}' });
      } catch {
        // ignore — we only care about whether this fetch is captured
      }
    }, TELEMETRY_ENDPOINT);

    // Trigger a track so a payload is guaranteed to flush
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('after_manual_post');
    });

    const payloads = await waitForPayloads(request);
    const events = allEvents(payloads);
    const netReqs = events.filter((e) => e.eventName === 'network_request');
    for (const ev of netReqs) {
      expect(ev.attributes['network.url']).not.toContain('/collector/telemetry');
    }
  });
});
