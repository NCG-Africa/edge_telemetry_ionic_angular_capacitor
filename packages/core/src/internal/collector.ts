import type { EventAttributes } from '../index';
import type { ContextManager } from './context';
import type { Pipeline } from './pipeline';
import { buildEventPayload } from '../transport/PayloadBuilder';

const ERROR_EVENT_NAMES = new Set(['app.crash']);

export class Collector {
  private readonly context: ContextManager;
  private readonly pipeline: Pipeline;
  private enabled: boolean;
  private readonly sampleRate: number;
  private readonly debug: boolean;

  constructor(options: {
    context: ContextManager;
    pipeline: Pipeline;
    enabled?: boolean;
    sampleRate?: number;
    debug?: boolean;
  }) {
    this.context = options.context;
    this.pipeline = options.pipeline;
    this.enabled = options.enabled ?? true;
    this.sampleRate = options.sampleRate ?? 1.0;
    this.debug = options.debug ?? false;
  }

  recordEvent(eventName: string, eventAttributes: EventAttributes): void {
    if (!this.enabled) return;

    if (this.sampleRate < 1.0 && Math.random() >= this.sampleRate) {
      return;
    }

    const contextAttributes = this.context.getContextAttributes();
    const event = buildEventPayload(eventName, contextAttributes, eventAttributes);

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.warn('[edge-rum] recordEvent', eventName, event.attributes);
    }

    if (ERROR_EVENT_NAMES.has(eventName)) {
      this.pipeline.pushImmediate(event);
    } else {
      this.pipeline.push(event);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  flushPipeline(): void {
    void this.pipeline.flush();
  }
}
