import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type FixtureItem =
  | { type: 'event'; eventName: string; timestamp: string; attributes: Record<string, unknown> }
  | { type: 'metric'; metricName: string; value: number; timestamp: string; attributes: Record<string, unknown> };

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/example-batch.json', import.meta.url), 'utf8'),
) as {
  timestamp: string;
  type: string;
  device_id?: string;
  batch_size: number;
  events: FixtureItem[];
};

describe('Android-aligned batch envelope', () => {
  it('has ISO 8601 top-level timestamp', () => {
    expect(fixture.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('type is exactly "batch"', () => {
    expect(fixture.type).toBe('batch');
  });

  it('events is an array', () => {
    expect(Array.isArray(fixture.events)).toBe(true);
  });

  it('every item is "event" or "metric", with the right discriminated fields and flat attributes', () => {
    for (const item of fixture.events) {
      if (item.type === 'event') {
        expect(typeof item.eventName).toBe('string');
      } else if (item.type === 'metric') {
        expect(typeof item.metricName).toBe('string');
        expect(typeof item.value).toBe('number');
      } else {
        throw new Error(`unexpected item.type: ${(item as { type: string }).type}`);
      }
      expect(item.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item.attributes).toBeDefined();
      for (const [, v] of Object.entries(item.attributes)) {
        expect(typeof v).toMatch(/^(string|number|boolean)$/);
      }
    }
  });

  it('has device_id at root level matching device_ prefix', () => {
    expect(fixture.device_id).toMatch(/^device_/);
  });

  it('has batch_size at root level equal to events.length', () => {
    expect(typeof fixture.batch_size).toBe('number');
    expect(fixture.batch_size).toBe(fixture.events.length);
  });

  it('contains context attributes with correct ID prefixes', () => {
    const ev = fixture.events[0];
    if (!ev) throw new Error('fixture must contain at least one event');
    expect(ev.attributes['session.id']).toMatch(/^session_/);
    expect(ev.attributes['device.id']).toMatch(/^device_/);
    expect(ev.attributes['sdk.platform']).toBe('ionic-angular-capacitor');
  });

  it('body contains none of the banned OTel field names', () => {
    const body = JSON.stringify(fixture);
    expect(body).not.toMatch(/traceId/);
    expect(body).not.toMatch(/spanId/);
    expect(body).not.toMatch(/resourceSpans/);
    expect(body).not.toMatch(/instrumentationScope/);
    expect(body).not.toMatch(/opentelemetry/i);
  });
});
