import { describe, it, expect } from 'vitest';
import {
  buildEventPayload,
  buildMetricPayload,
  buildBatchPayload,
} from '../src/transport/PayloadBuilder';

describe('PayloadBuilder', () => {
  describe('buildEventPayload', () => {
    it('creates an event with type "event"', () => {
      const event = buildEventPayload('navigation', {}, {});
      expect(event.type).toBe('event');
    });

    it('uses the provided eventName', () => {
      const event = buildEventPayload('http.request', {}, {});
      expect(event.eventName).toBe('http.request');
    });

    it('produces an ISO 8601 timestamp', () => {
      const event = buildEventPayload('performance', {}, {});
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('merges context and event attributes with event taking precedence', () => {
      const context = { 'app.name': 'MyApp', 'sdk.platform': 'ionic-angular-capacitor' };
      const eventAttrs = { 'navigation.to_screen': '/home', 'app.name': 'Override' };
      const event = buildEventPayload('navigation', context, eventAttrs);
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

  describe('buildMetricPayload', () => {
    it('puts metricName and value at the event root, not in attributes', () => {
      const metric = buildMetricPayload('image_upload', 890, { 'app.name': 'MyApp' }, { 'metric.unit': 'ms' });
      expect(metric.type).toBe('metric');
      expect(metric.metricName).toBe('image_upload');
      expect(metric.value).toBe(890);
      expect(metric.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(metric.attributes['metric.unit']).toBe('ms');
      expect(metric.attributes['app.name']).toBe('MyApp');
      expect(metric.attributes).not.toHaveProperty('metricName');
      expect(metric.attributes).not.toHaveProperty('value');
    });
  });

  describe('buildBatchPayload', () => {
    it('wraps events in the telemetry_batch envelope', () => {
      const events = [buildEventPayload('navigation', { 'device.id': 'device_1_abcd1234_web' }, {})];
      const payload = buildBatchPayload(events);
      expect(payload.type).toBe('telemetry_batch');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(payload.batch_size).toBe(1);
      expect(payload.events).toHaveLength(1);
    });

    it('omits location when not provided', () => {
      const payload = buildBatchPayload([]);
      expect(payload.location).toBeUndefined();
    });

    it('includes location when provided', () => {
      const payload = buildBatchPayload([], 'Nairobi/Kenya');
      expect(payload.location).toBe('Nairobi/Kenya');
    });

    it('omits location for empty string', () => {
      const payload = buildBatchPayload([], '');
      expect(payload.location).toBeUndefined();
    });

    it('does not include a top-level device_id field', () => {
      const events = [buildEventPayload('navigation', { 'device.id': 'device_1_abcd1234_web' }, {})];
      const payload = buildBatchPayload(events);
      expect(payload).not.toHaveProperty('device_id');
    });

    it('sets batch_size equal to events.length', () => {
      const events = [
        buildEventPayload('navigation', { 'device.id': 'device_1_abcd1234_web' }, {}),
        buildEventPayload('http.request', { 'device.id': 'device_1_abcd1234_web' }, {}),
        buildEventPayload('custom_event', { 'device.id': 'device_1_abcd1234_web' }, {}),
      ];
      const payload = buildBatchPayload(events);
      expect(payload.batch_size).toBe(3);
      expect(payload.events).toHaveLength(3);
    });

    it('reports batch_size of 0 when events array is empty', () => {
      const payload = buildBatchPayload([]);
      expect(payload.batch_size).toBe(0);
    });

    it('aligned shape: app.package_name + session.start_time + top-level metric', () => {
      const ctx = {
        'app.name': 'MyApp',
        'app.package_name': 'com.yourco.app',
        'app.build_number': '42',
        'device.id': 'device_1_abcd1234_web',
        'session.id': 'session_1_x9y8z7w6_web',
        'session.start_time': '2024-01-15T10:25:00.000Z',
      };
      const events = [
        buildEventPayload('navigation', ctx, {
          'navigation.to_screen': '/home',
          'navigation.method': 'initial',
        }),
        buildEventPayload('screen.duration', ctx, {
          'screen.name': '/home',
          'screen.duration_ms': 4331,
          'screen.exit_method': 'navigate',
        }),
        buildMetricPayload('image_upload', 890, ctx, { 'metric.unit': 'ms' }),
      ];
      const payload = buildBatchPayload(events, 'Nairobi/Kenya');

      expect(payload.type).toBe('telemetry_batch');
      expect(payload.location).toBe('Nairobi/Kenya');
      expect(payload.batch_size).toBe(payload.events.length);
      expect(payload.batch_size).toBe(3);

      for (const ev of payload.events) {
        expect(ev.attributes['app.package_name']).toBe('com.yourco.app');
        expect(ev.attributes['session.start_time']).toBe('2024-01-15T10:25:00.000Z');
        expect(ev.attributes).not.toHaveProperty('app.package');
        expect(ev.attributes).not.toHaveProperty('session.startTime');
      }

      const metric = payload.events.find((ev) => ev.type === 'metric');
      expect(metric).toBeDefined();
      if (metric && metric.type === 'metric') {
        expect(metric.metricName).toBe('image_upload');
        expect(metric.value).toBe(890);
        expect(metric.attributes['metric.unit']).toBe('ms');
        expect(metric.attributes).not.toHaveProperty('metric.name');
        expect(metric.attributes).not.toHaveProperty('metric.value');
      }
    });

    it('produces valid JSON with no nested objects in attributes', () => {
      const events = [
        buildEventPayload('test', { 'session.id': 'session_123_abcd1234_web' }, { x: 1 }),
      ];
      const payload = buildBatchPayload(events);
      const json = JSON.stringify(payload);
      const parsed = JSON.parse(json);
      expect(parsed.type).toBe('telemetry_batch');
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
