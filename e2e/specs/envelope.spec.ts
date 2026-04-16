import { test, expect } from '@playwright/test';
import {
  allEvents,
  assertEnvelope,
  getRequests,
  initHarness,
  resetIngest,
  waitForPayloads,
} from './helpers';

test.describe('envelope and auth', () => {
  test.beforeEach(async ({ request }) => {
    await resetIngest(request);
  });

  test('sends JSON batch payloads with X-API-Key and correct envelope', async ({ page, request }) => {
    await initHarness(page);

    await page.evaluate(() => {
      (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness.track('envelope_test');
    });

    const payloads = await waitForPayloads(request);
    expect(payloads.length).toBeGreaterThanOrEqual(1);

    for (const payload of payloads) {
      assertEnvelope(payload);
    }

    const requests = await getRequests(request);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    for (const req of requests) {
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/collector/telemetry');
      expect(req.headers['x-api-key']).toBe('edge_test_key_123');
      expect(req.headers['content-type']).toMatch(/application\/json/);
      expect(req.parseError).toBeNull();
    }
  });

  test('every event carries required context attributes', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('ctx_test');
    });

    const payloads = await waitForPayloads(request);
    const events = allEvents(payloads);
    expect(events.length).toBeGreaterThanOrEqual(1);

    for (const event of events) {
      expect(event.attributes['session.id']).toMatch(/^session_\d+_[0-9a-f]{8}_web$/);
      expect(event.attributes['session.startTime']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.attributes['sdk.platform']).toBe('ionic-angular-capacitor');
      expect(event.attributes['sdk.version']).toMatch(/^\d/);
      expect(event.attributes['app.name']).toBe('IntegrationHarness');
      expect(event.attributes['app.version']).toBe('0.0.0-test');
      expect(event.attributes['app.package']).toBe('com.edgemetrics.test');
      expect(event.attributes['app.environment']).toBe('development');
    }
  });

  test('payloads contain no OTel identifiers', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('otel_leak_check');
    });

    const requests = await getRequests(request);
    const body = requests.map((r) => r.rawBody).join('\n');
    expect(body).not.toContain('traceId');
    expect(body).not.toContain('spanId');
    expect(body).not.toContain('resourceSpans');
    expect(body).not.toContain('instrumentationScope');
    expect(body).not.toContain('opentelemetry');
    expect(body).not.toContain('TracerProvider');
    expect(body).not.toContain('SpanProcessor');
  });

  test('all attribute values are primitives — no nested objects', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string, a?: Record<string, string | number | boolean>) => void } }).__edgeRumHarness;
      h.track('flatness_test', { 'string_val': 'x', 'num_val': 42, 'bool_val': true });
    });

    const payloads = await waitForPayloads(request);
    const events = allEvents(payloads);

    for (const event of events) {
      for (const [key, value] of Object.entries(event.attributes)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
        expect(Array.isArray(value)).toBe(false);
        expect(value).not.toBeNull();
        if (typeof value === 'object') {
          throw new Error(`attributes.${key} is a nested object`);
        }
      }
    }
  });
});
