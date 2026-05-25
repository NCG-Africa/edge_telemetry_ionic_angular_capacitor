import type { EventAttributes } from '../index';
import type { ContextManager } from './context';
import type { Pipeline } from './pipeline';
import type { SessionManager } from '../session/SessionManager';
import { buildEventPayload, buildMetricPayload } from '../transport/PayloadBuilder';
import { breadcrumbs } from './breadcrumbs';

const IMMEDIATE_FLUSH_EVENT_NAMES = new Set(['app.crash', 'session.finalized']);
const CRITICAL_EVENT_NAMES = new Set([
  'app.crash',
  'session.started',
  'session.finalized',
  'user.profile.update',
]);

export class Collector {
  private readonly context: ContextManager;
  private readonly pipeline: Pipeline;
  private readonly session: SessionManager;
  private enabled: boolean;
  private readonly debug: boolean;

  constructor(options: {
    context: ContextManager;
    pipeline: Pipeline;
    session: SessionManager;
    enabled?: boolean;
    debug?: boolean;
  }) {
    this.context = options.context;
    this.pipeline = options.pipeline;
    this.session = options.session;
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
  }

  recordEvent(eventName: string, eventAttributes: EventAttributes): void {
    if (!this.enabled) return;

    if (!CRITICAL_EVENT_NAMES.has(eventName) && !this.session.isSampled()) {
      return;
    }

    this.session.incrementEventCount();
    if (eventName === 'navigation') {
      const toScreen = eventAttributes['navigation.to_screen'];
      if (typeof toScreen === 'string') {
        this.session.recordScreenVisit(toScreen);
      }
    }
    // Push a breadcrumb for everything except crashes themselves.
    if (eventName !== 'app.crash') {
      breadcrumbs.push({
        ts: new Date().toISOString(),
        type: eventName,
        name: extractCrumbName(eventName, eventAttributes),
      });
    }

    const contextAttributes = this.context.getContextAttributes();
    const event = buildEventPayload(eventName, contextAttributes, eventAttributes);

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.warn('[edge-rum] recordEvent', eventName, event.attributes);
    }

    if (IMMEDIATE_FLUSH_EVENT_NAMES.has(eventName)) {
      this.pipeline.pushImmediate(event);
    } else {
      this.pipeline.push(event);
    }
  }

  recordMetric(metricName: string, value: number, eventAttributes: EventAttributes = {}): void {
    if (!this.enabled) return;

    if (!this.session.isSampled()) {
      return;
    }

    this.session.incrementMetricCount();

    const contextAttributes = this.context.getContextAttributes();
    const metric = buildMetricPayload(metricName, value, contextAttributes, eventAttributes);

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.warn('[edge-rum] recordMetric', metricName, value, metric.attributes);
    }

    this.pipeline.push(metric);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  flushPipeline(): void {
    void this.pipeline.flush();
  }
}

function extractCrumbName(eventName: string, attrs: EventAttributes): string {
  if (typeof attrs['navigation.to_screen'] === 'string') return attrs['navigation.to_screen'];
  if (typeof attrs['screen.name'] === 'string') return attrs['screen.name'];
  if (typeof attrs['http.url'] === 'string') return String(attrs['http.url']);
  if (typeof attrs['interaction.target_tag'] === 'string') {
    const id = typeof attrs['interaction.target_id'] === 'string' ? `#${attrs['interaction.target_id']}` : '';
    return `${attrs['interaction.target_tag']}${id}`;
  }
  if (typeof attrs['event.name'] === 'string') return attrs['event.name'];
  return eventName;
}
