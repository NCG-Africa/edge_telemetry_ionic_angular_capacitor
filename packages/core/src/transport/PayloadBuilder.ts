import type { EventAttributes } from '../index';

export interface EventPayload {
  type: 'event';
  eventName: string;
  timestamp: string;
  attributes: EventAttributes;
}

export interface MetricPayload {
  type: 'metric';
  metricName: string;
  value: number;
  timestamp: string;
  attributes: EventAttributes;
}

export type BatchItem = EventPayload | MetricPayload;

export interface BatchPayload {
  type: 'telemetry_batch';
  timestamp: string;
  location?: string;
  batch_size: number;
  events: BatchItem[];
}

export function buildEventPayload(
  eventName: string,
  contextAttributes: EventAttributes,
  eventAttributes: EventAttributes,
): EventPayload {
  return {
    type: 'event',
    eventName,
    timestamp: new Date().toISOString(),
    attributes: { ...contextAttributes, ...eventAttributes },
  };
}

export function buildMetricPayload(
  metricName: string,
  value: number,
  contextAttributes: EventAttributes,
  eventAttributes: EventAttributes,
): MetricPayload {
  return {
    type: 'metric',
    metricName,
    value,
    timestamp: new Date().toISOString(),
    attributes: { ...contextAttributes, ...eventAttributes },
  };
}

export function buildBatchPayload(events: BatchItem[], location?: string): BatchPayload {
  return {
    type: 'telemetry_batch',
    timestamp: new Date().toISOString(),
    ...(typeof location === 'string' && location.length > 0 ? { location } : {}),
    batch_size: events.length,
    events,
  };
}
