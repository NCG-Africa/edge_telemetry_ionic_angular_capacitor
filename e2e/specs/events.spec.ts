import { test, expect } from '@playwright/test';
import {
  allEvents,
  assertEnvelope,
  initHarness,
  resetIngest,
  waitForPayloads,
} from './helpers';

test.describe('event types', () => {
  test.beforeEach(async ({ request }) => {
    await resetIngest(request);
  });

  test('EdgeRum.track() produces custom_event with event.name', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string, a?: Record<string, string | number | boolean>) => void } }).__edgeRumHarness;
      h.track('checkout_started', { currency: 'GBP', amount: 49.99 });
    });

    const payloads = await waitForPayloads(request);
    for (const p of payloads) assertEnvelope(p);
    const events = allEvents(payloads);
    const custom = events.find((e) => e.eventName === 'custom_event');
    expect(custom).toBeDefined();
    expect(custom!.attributes['event.name']).toBe('checkout_started');
    expect(custom!.attributes['currency']).toBe('GBP');
    expect(custom!.attributes['amount']).toBe(49.99);
  });

  test('EdgeRum.captureError() produces app.crash with handled:true', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { captureError: (m: string) => void } }).__edgeRumHarness;
      h.captureError('boom from test');
    });

    const payloads = await waitForPayloads(request);
    for (const p of payloads) assertEnvelope(p);
    const events = allEvents(payloads);
    const crash = events.find((e) => e.eventName === 'app.crash');
    expect(crash).toBeDefined();
    expect(crash!.attributes['message']).toBe('boom from test');
    expect(crash!.attributes['handled']).toBe(true);
    expect(crash!.attributes['is_fatal']).toBe(false);
    expect(crash!.attributes['runtime']).toBe('webview');
    expect(crash!.attributes['cause']).toBe('ManualCapture');
  });

  test('EdgeRum.time().end() produces custom_metric with metric.name, metric.value, metric.unit', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(async () => {
      const h = (window as unknown as { __edgeRumHarness: { time: (n: string, ms: number) => void } }).__edgeRumHarness;
      h.time('image_upload', 50);
      await new Promise((r) => setTimeout(r, 100));
    });

    const payloads = await waitForPayloads(request);
    for (const p of payloads) assertEnvelope(p);
    const events = allEvents(payloads);
    const metric = events.find((e) => e.eventName === 'custom_metric');
    expect(metric).toBeDefined();
    expect(metric!.attributes['metric.name']).toBe('image_upload');
    expect(metric!.attributes['metric.unit']).toBe('ms');
    expect(typeof metric!.attributes['metric.value']).toBe('number');
    expect(metric!.attributes['metric.value']).toBeGreaterThanOrEqual(0);
  });

  test('unhandled window error produces app.crash with handled:false', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      // Throw in a microtask so the window error handler fires without killing the current evaluate
      setTimeout(() => {
        throw new Error('unhandled-in-window');
      }, 0);
    });
    // Let the error fire and flush
    await page.waitForTimeout(1500);

    const payloads = await waitForPayloads(request);
    for (const p of payloads) assertEnvelope(p);
    const events = allEvents(payloads);
    const crash = events.find(
      (e) => e.eventName === 'app.crash' && e.attributes['handled'] === false,
    );
    expect(crash).toBeDefined();
    expect(crash!.attributes['is_fatal']).toBe(false);
    expect(crash!.attributes['runtime']).toBe('webview');
    expect(crash!.attributes['cause']).toBe('UnhandledError');
  });

  test('EdgeRum.identify() adds user.id to subsequent events', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { identify: (u: { id: string }) => void; track: (n: string) => void } }).__edgeRumHarness;
      h.identify({ id: 'u_abc_123' });
      h.track('after_identify');
    });

    const payloads = await waitForPayloads(request);
    const events = allEvents(payloads);
    const after = events.find((e) => e.eventName === 'custom_event');
    expect(after).toBeDefined();
    expect(after!.attributes['user.id']).toBe('u_abc_123');
  });

  test('session.sequence increments after successful sends', async ({ page, request }) => {
    await initHarness(page);

    // First batch
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('first');
    });
    await waitForPayloads(request, { minCount: 1 });

    // Second batch (after first has been sent, so sequence should have incremented)
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('second');
    });
    await waitForPayloads(request, { minCount: 2 });

    const payloads = await waitForPayloads(request, { minCount: 2 });
    const firstBatchEvents = payloads[0]!.events;
    const secondBatchEvents = payloads[payloads.length - 1]!.events;

    const firstSeq = firstBatchEvents[0]!.attributes['session.sequence'];
    const secondSeq = secondBatchEvents[0]!.attributes['session.sequence'];
    expect(typeof firstSeq).toBe('number');
    expect(typeof secondSeq).toBe('number');
    expect(secondSeq as number).toBeGreaterThan(firstSeq as number);
  });
});
