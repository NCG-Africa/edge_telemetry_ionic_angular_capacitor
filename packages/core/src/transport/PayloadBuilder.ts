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
  timestamp: string;
  type: 'batch';
  device_id?: string;
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

export function buildBatchPayload(events: BatchItem[]): BatchPayload {
  const deviceId = events[0]?.attributes?.['device.id'];
  return {
    timestamp: new Date().toISOString(),
    type: 'batch',
    ...(typeof deviceId === 'string' ? { device_id: deviceId } : {}),
    batch_size: events.length,
    events,
  };
}
