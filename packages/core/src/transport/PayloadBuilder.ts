import type { EventAttributes } from '../index';

export interface EventPayload {
  type: 'event';
  eventName: string;
  timestamp: string;
  attributes: EventAttributes;
}

export interface BatchPayload {
  timestamp: string;
  type: 'batch';
  device_id?: string;
  events: EventPayload[];
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

export function buildBatchPayload(events: EventPayload[]): BatchPayload {
  const deviceId = events[0]?.attributes?.['device.id'];
  return {
    timestamp: new Date().toISOString(),
    type: 'batch',
    ...(typeof deviceId === 'string' ? { device_id: deviceId } : {}),
    events,
  };
}
