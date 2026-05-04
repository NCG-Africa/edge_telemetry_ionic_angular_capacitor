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
  return {
    timestamp: new Date().toISOString(),
    type: 'batch',
    events,
  };
}
