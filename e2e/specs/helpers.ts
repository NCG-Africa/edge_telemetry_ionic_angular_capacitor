import type { Page, APIRequestContext } from '@playwright/test';

const MOCK_INGEST_PORT = 4319;
export const MOCK_INGEST_URL = `http://localhost:${MOCK_INGEST_PORT}`;
export const TELEMETRY_ENDPOINT = `${MOCK_INGEST_URL}/collector/telemetry`;

export interface EventPayload {
  type: 'event';
  eventName: string;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
}

export interface MetricPayload {
  type: 'metric';
  metricName: string;
  value: number;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
}

export type BatchItem = EventPayload | MetricPayload;

export interface BatchPayload {
  type: 'telemetry_batch';
  timestamp: string;
  location?: string;
  batch_size: number;
  events: BatchItem[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: { 'x-api-key': string | null; 'content-type': string | null };
  rawBody: string;
  parsed: BatchPayload | null;
  parseError: string | null;
  receivedAt: string;
}

export async function resetIngest(request: APIRequestContext): Promise<void> {
  await request.post(`${MOCK_INGEST_URL}/__reset`);
}

export async function getPayloads(request: APIRequestContext): Promise<BatchPayload[]> {
  const res = await request.get(`${MOCK_INGEST_URL}/__payloads`);
  const body = (await res.json()) as { payloads: BatchPayload[] };
  return body.payloads;
}

export async function getRequests(request: APIRequestContext): Promise<RecordedRequest[]> {
  const res = await request.get(`${MOCK_INGEST_URL}/__requests`);
  const body = (await res.json()) as { requests: RecordedRequest[] };
  return body.requests;
}

export async function waitForPayloads(
  request: APIRequestContext,
  options: { minCount?: number; timeoutMs?: number } = {},
): Promise<BatchPayload[]> {
  const minCount = options.minCount ?? 1;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payloads = await getPayloads(request);
    if (payloads.length >= minCount) return payloads;
    await new Promise((r) => setTimeout(r, 100));
  }
  return getPayloads(request);
}

/**
 * Polls the mock ingest until at least one item matching the predicate appears
 * across all received payloads, then returns the full payload list. Use this
 * instead of waitForPayloads when the event of interest may not land in the
 * first batch (the SDK auto-emits vitals/resource_timing/page_load at init,
 * filling a small batch quickly).
 */
export async function waitForItem(
  request: APIRequestContext,
  match: (item: BatchItem) => boolean,
  options: { timeoutMs?: number } = {},
): Promise<BatchPayload[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payloads = await getPayloads(request);
    for (const p of payloads) {
      if (Array.isArray(p?.events) && p.events.some(match)) return payloads;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return getPayloads(request);
}

export async function initHarness(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __edgeRumHarness?: unknown }).__edgeRumHarness));
  await page.evaluate(
    ({ endpoint, overrides: cfgOverrides }: { endpoint: string; overrides: Record<string, unknown> }) => {
      (window as unknown as { __edgeRumHarness: { init: (cfg: Record<string, unknown>) => void } }).__edgeRumHarness.init({
        apiKey: 'edge_test_key_123',
        endpoint,
        appName: 'IntegrationHarness',
        appVersion: '0.0.0-test',
        appPackage: 'com.edgemetrics.test',
        environment: 'development',
        flushIntervalMs: 500,
        batchSize: 5,
        ...cfgOverrides,
      });
    },
    { endpoint: TELEMETRY_ENDPOINT, overrides },
  );
}

const OTEL_FORBIDDEN = ['traceId', 'spanId', 'resourceSpans', 'instrumentationScope', 'opentelemetry'];

export function assertEnvelope(payload: BatchPayload): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is not an object');
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(payload.timestamp)) {
    throw new Error(`payload.timestamp is not ISO 8601: ${payload.timestamp}`);
  }
  if (payload.type !== 'telemetry_batch') {
    throw new Error(`type must be 'telemetry_batch', got ${payload.type}`);
  }
  if (!Array.isArray(payload.events)) {
    throw new Error('events must be an array');
  }
  if (typeof payload.batch_size !== 'number' || payload.batch_size !== payload.events.length) {
    throw new Error(`batch_size must equal events.length, got ${payload.batch_size} vs ${payload.events.length}`);
  }

  const serialised = JSON.stringify(payload);
  for (const banned of OTEL_FORBIDDEN) {
    if (serialised.includes(banned)) {
      throw new Error(`payload contains banned OTel term: ${banned}`);
    }
  }

  for (const item of payload.events) {
    if (item.type === 'event') {
      if (typeof item.eventName !== 'string' || item.eventName.length === 0) {
        throw new Error('event.eventName missing');
      }
    } else if (item.type === 'metric') {
      if (typeof item.metricName !== 'string' || item.metricName.length === 0) {
        throw new Error('metric.metricName missing');
      }
      if (typeof item.value !== 'number') {
        throw new Error(`metric.value must be a number, got ${typeof item.value}`);
      }
    } else {
      throw new Error(`item.type must be 'event' or 'metric', got ${(item as { type: string }).type}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(item.timestamp)) {
      throw new Error(`item.timestamp is not ISO 8601: ${item.timestamp}`);
    }
    if (!item.attributes || typeof item.attributes !== 'object') {
      throw new Error('item.attributes missing');
    }
    for (const [key, value] of Object.entries(item.attributes)) {
      const t = typeof value;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        throw new Error(`attributes.${key} is ${t} — must be string | number | boolean`);
      }
      if (Array.isArray(value)) {
        throw new Error(`attributes.${key} is an array — must be a primitive`);
      }
    }
  }
}

export function allEvents(payloads: BatchPayload[]): EventPayload[] {
  return payloads.flatMap((p) =>
    p && Array.isArray(p.events) ? p.events.filter((it): it is EventPayload => it.type === 'event') : [],
  );
}

export function allMetrics(payloads: BatchPayload[]): MetricPayload[] {
  return payloads.flatMap((p) =>
    p && Array.isArray(p.events) ? p.events.filter((it): it is MetricPayload => it.type === 'metric') : [],
  );
}

export function allItems(payloads: BatchPayload[]): BatchItem[] {
  return payloads.flatMap((p) => (p && Array.isArray(p.events) ? p.events : []));
}
