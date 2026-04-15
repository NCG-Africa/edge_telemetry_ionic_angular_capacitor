import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/example-batch.json', import.meta.url), 'utf8'),
) as {
  timestamp: string;
  data: { type: string; events: Array<{ type: string; eventName: string; timestamp: string; attributes: Record<string, unknown> }> };
};

describe('Android-aligned batch envelope', () => {
  it('has ISO 8601 top-level timestamp', () => {
    expect(fixture.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('data.type is exactly "batch"', () => {
    expect(fixture.data.type).toBe('batch');
  });

  it('data.events is an array', () => {
    expect(Array.isArray(fixture.data.events)).toBe(true);
  });

  it('every event has type === "event", eventName, ISO timestamp, flat attributes', () => {
    for (const ev of fixture.data.events) {
      expect(ev.type).toBe('event');
      expect(typeof ev.eventName).toBe('string');
      expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ev.attributes).toBeDefined();
      for (const [, v] of Object.entries(ev.attributes)) {
        expect(typeof v).toMatch(/^(string|number|boolean)$/);
      }
    }
  });

  it('contains context attributes with correct ID prefixes', () => {
    const ev = fixture.data.events[0];
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
