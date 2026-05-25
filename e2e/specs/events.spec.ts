import { test, expect } from '@playwright/test';
import {
  allEvents,
  allMetrics,
  assertEnvelope,
  initHarness,
  resetIngest,
  waitForItem,
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

    const payloads = await waitForItem(
      request,
      (item) =>
        item.type === 'event' &&
        item.eventName === 'custom_event' &&
        item.attributes['event.name'] === 'checkout_started',
    );
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

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'app.crash',
    );
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

  test('EdgeRum.time().end() produces a top-level metric event with metricName + value', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(async () => {
      const h = (window as unknown as { __edgeRumHarness: { time: (n: string, ms: number) => void } }).__edgeRumHarness;
      h.time('image_upload', 50);
      await new Promise((r) => setTimeout(r, 100));
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'metric' && item.metricName === 'image_upload',
    );
    for (const p of payloads) assertEnvelope(p);
    const metrics = allMetrics(payloads);
    const metric = metrics.find((m) => m.metricName === 'image_upload');
    expect(metric).toBeDefined();
    expect(metric!.type).toBe('metric');
    expect(typeof metric!.value).toBe('number');
    expect(metric!.value).toBeGreaterThanOrEqual(0);
    expect(metric!.attributes['metric.unit']).toBe('ms');
    // metric.name and metric.value must NOT be in attributes anymore
    expect(metric!.attributes['metric.name']).toBeUndefined();
    expect(metric!.attributes['metric.value']).toBeUndefined();
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

  test('every event carries an auto-generated anonymous user.id pre-identify', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('before_identify');
    });

    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.eventName === 'custom_event',
    );
    const events = allEvents(payloads);
    const tracked = events.find((e) => e.eventName === 'custom_event');
    expect(tracked).toBeDefined();
    expect(tracked!.attributes['user.id']).toMatch(/^user_\d+_[0-9a-f]{16}$/);
  });

  test('EdgeRum.identify() attaches user.name / user.email / user.phone, keeps SDK-owned user.id', async ({ page, request }) => {
    await initHarness(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { identify: (u: { name?: string; email?: string; phone?: string }) => void; track: (n: string) => void } }).__edgeRumHarness;
      h.identify({ name: 'Alice', email: 'alice@example.com', phone: '+1-555-0100' });
      h.track('after_identify');
    });

    const payloads = await waitForItem(
      request,
      (item) =>
        item.type === 'event' &&
        item.eventName === 'custom_event' &&
        item.attributes['event.name'] === 'after_identify',
    );
    const events = allEvents(payloads);
    const after = events.find((e) => e.eventName === 'custom_event' && e.attributes['event.name'] === 'after_identify');
    expect(after).toBeDefined();
    expect(after!.attributes['user.id']).toMatch(/^user_\d+_[0-9a-f]{16}$/);
    expect(after!.attributes['user.name']).toBe('Alice');
    expect(after!.attributes['user.email']).toBe('alice@example.com');
    expect(after!.attributes['user.phone']).toBe('+1-555-0100');
  });

  test('session.sequence increments after successful sends', async ({ page, request }) => {
    await initHarness(page);

    // First batch — wait until track 'first' is delivered
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('first');
    });
    await waitForItem(
      request,
      (item) => item.type === 'event' && item.attributes['event.name'] === 'first',
    );

    // Second batch — wait until track 'second' is delivered
    await page.evaluate(() => {
      const h = (window as unknown as { __edgeRumHarness: { track: (n: string) => void } }).__edgeRumHarness;
      h.track('second');
    });
    const payloads = await waitForItem(
      request,
      (item) => item.type === 'event' && item.attributes['event.name'] === 'second',
    );

    // Find the batches by content rather than index — order may vary.
    const firstBatch = payloads.find((p) =>
      p.events.some((e) => e.attributes['event.name'] === 'first'),
    )!;
    const secondBatch = payloads.find((p) =>
      p.events.some((e) => e.attributes['event.name'] === 'second'),
    )!;
    const firstSeq = firstBatch.events.find(
      (e) => e.attributes['event.name'] === 'first',
    )!.attributes['session.sequence'];
    const secondSeq = secondBatch.events.find(
      (e) => e.attributes['event.name'] === 'second',
    )!.attributes['session.sequence'];
    expect(typeof firstSeq).toBe('number');
    expect(typeof secondSeq).toBe('number');
    expect(secondSeq as number).toBeGreaterThan(firstSeq as number);
  });
});
