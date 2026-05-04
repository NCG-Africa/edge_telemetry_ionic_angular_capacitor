import { describe, it, expect } from 'vitest';
import { buildEventPayload, buildBatchPayload } from '../src/transport/PayloadBuilder';

describe('PayloadBuilder', () => {
  describe('buildEventPayload', () => {
    it('creates an event with type "event"', () => {
      const event = buildEventPayload('screen_view', {}, {});
      expect(event.type).toBe('event');
    });

    it('uses the provided eventName', () => {
      const event = buildEventPayload('network_request', {}, {});
      expect(event.eventName).toBe('network_request');
    });

    it('produces an ISO 8601 timestamp', () => {
      const event = buildEventPayload('performance', {}, {});
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('merges context and event attributes with event taking precedence', () => {
      const context = { 'app.name': 'MyApp', 'sdk.platform': 'ionic-angular-capacitor' };
      const eventAttrs = { 'navigation.to_screen': '/home', 'app.name': 'Override' };
      const event = buildEventPayload('screen_view', context, eventAttrs);
      expect(event.attributes['app.name']).toBe('Override');
      expect(event.attributes['sdk.platform']).toBe('ionic-angular-capacitor');
      expect(event.attributes['navigation.to_screen']).toBe('/home');
    });

    it('produces only primitive attribute values', () => {
      const event = buildEventPayload('test', { a: 'str', b: 42, c: true }, {});
      Object.values(event.attributes).forEach((v) => {
        expect(typeof v).toMatch(/^(string|number|boolean)$/);
      });
    });
  });

  describe('buildBatchPayload', () => {
    it('wraps events in the correct envelope structure', () => {
      const events = [buildEventPayload('screen_view', {}, {})];
      const payload = buildBatchPayload(events);
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(payload.type).toBe('batch');
      expect(payload.events).toHaveLength(1);
    });

    it('produces valid JSON with no nested objects in attributes', () => {
      const events = [
        buildEventPayload('test', { 'session.id': 'session_123_abcd1234_web' }, { x: 1 }),
      ];
      const payload = buildBatchPayload(events);
      const json = JSON.stringify(payload);
      const parsed = JSON.parse(json);
      expect(parsed.type).toBe('batch');
      parsed.events.forEach((ev: Record<string, unknown>) => {
        const attrs = ev.attributes as Record<string, unknown>;
        Object.values(attrs).forEach((v) => {
          expect(typeof v).toMatch(/^(string|number|boolean)$/);
        });
      });
    });

    it('does not contain OTel terminology', () => {
      const events = [buildEventPayload('test', {}, {})];
      const json = JSON.stringify(buildBatchPayload(events));
      expect(json).not.toContain('traceId');
      expect(json).not.toContain('spanId');
      expect(json).not.toContain('resourceSpans');
      expect(json).not.toContain('opentelemetry');
    });
  });
});
