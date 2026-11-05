import type { EdgeRumEvent, EventAttributes } from './core';

/** Host hook run on every JS event just before hand-off; return `null` to drop the event. */
export type BeforeSend = (event: EdgeRumEvent) => EdgeRumEvent | null;

export type HookOutcome = { kind: 'kept'; event: EdgeRumEvent } | { kind: 'dropped' } | { kind: 'failed' };

// Spec P1 (= Cordova P5). Identity/session/trace keys are re-stamped from the original after
// the hook, so an over-broad `delete attrs[k]` loop can't strip what the backend keys on.
const RESTAMPED = new Set([
  'session.id', 'session.start_time', 'session.sequence', 'event.sequence',
  'device.platform', 'trace.id', 'span.id', 'parent.span.id', 'rum.action.id', 'trace.root_type', 'view.id',
]);
const isRestamped = (k: string) => RESTAMPED.has(k) || k.startsWith('sdk.') || k.startsWith('app.');

/** Run the hook and enforce the re-stamp on what comes back. */
export function applyBeforeSend(original: EdgeRumEvent, hook: BeforeSend): HookOutcome {
  let returned: EdgeRumEvent | null;
  try {
    // A copy: re-stamping from an object the hook already mutated would restore nothing.
    returned = hook({ ...original, attributes: { ...original.attributes } });
  } catch {
    // Fail closed: sending the original ships exactly what the hook existed to remove.
    return { kind: 'failed' };
  }
  // Only an explicit null is "drop this"; undefined/strings/etc. are host bugs.
  if (returned === null) return { kind: 'dropped' };
  if (typeof returned !== 'object') return { kind: 'failed' };

  const attributes: EventAttributes = {};
  for (const [k, v] of Object.entries(returned.attributes ?? {})) if (!isRestamped(k)) attributes[k] = v;
  for (const [k, v] of Object.entries(original.attributes)) if (isRestamped(k)) attributes[k] = v;
  // Key by key, not spread: a hook can't rename the row or move it between event and numeric paths.
  const kept: EdgeRumEvent = { type: original.type, timestamp: original.timestamp, attributes };
  if (original.eventName !== undefined) kept.eventName = original.eventName;
  if (original.metricName !== undefined) kept.metricName = original.metricName;
  if (original.value !== undefined) kept.value = typeof returned.value === 'number' ? returned.value : original.value;
  return { kind: 'kept', event: kept };
}
