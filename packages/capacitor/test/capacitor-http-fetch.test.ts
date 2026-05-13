import { describe, it, expect, vi } from 'vitest';

import {
  createCapacitorHttpFetch,
  type CapacitorHttpLike,
  type CapacitorHttpResponseLike,
} from '../src/capacitor-http-fetch';

function fakeHttp(response: CapacitorHttpResponseLike | Error): {
  http: CapacitorHttpLike;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (_opts) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    http: { request } as unknown as CapacitorHttpLike,
    request,
  };
}

describe('createCapacitorHttpFetch', () => {
  it('passes url, method, headers, and body through to CapacitorHttp.request', async () => {
    const { http, request } = fakeHttp({
      data: '',
      status: 200,
      headers: {},
      url: 'https://example.com/collector/telemetry',
    });
    const fetchFn = createCapacitorHttpFetch({ loadCapacitorHttp: async () => http });

    await fetchFn('https://example.com/collector/telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'edge_test',
      },
      body: '{"x":1}',
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      url: 'https://example.com/collector/telemetry',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'edge_test',
      },
      data: '{"x":1}',
    });
  });

  it('returns a Response-shape with ok=true and case-insensitive headers for 200', async () => {
    const { http } = fakeHttp({
      data: '',
      status: 200,
      headers: { 'Retry-After': '7' },
      url: 'https://example.com/collector/telemetry',
    });
    const fetchFn = createCapacitorHttpFetch({ loadCapacitorHttp: async () => http });

    const res = await fetchFn('https://example.com/collector/telemetry', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('RETRY-AFTER')).toBe('7');
    expect(res.headers.get('missing')).toBeNull();
  });

  it('returns ok=false for 503 so retry logic engages', async () => {
    const { http } = fakeHttp({
      data: '',
      status: 503,
      headers: {},
      url: 'https://example.com/collector/telemetry',
    });
    const fetchFn = createCapacitorHttpFetch({ loadCapacitorHttp: async () => http });

    const res = await fetchFn('https://example.com/collector/telemetry', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it('surfaces thrown errors from CapacitorHttp.request', async () => {
    const { http } = fakeHttp(new Error('bridge unavailable'));
    const fetchFn = createCapacitorHttpFetch({ loadCapacitorHttp: async () => http });

    await expect(
      fetchFn('https://example.com/collector/telemetry', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('bridge unavailable');
  });

  it('caches the loaded plugin across calls (lazy-imports once)', async () => {
    const { http } = fakeHttp({
      data: '',
      status: 200,
      headers: {},
      url: 'https://example.com/collector/telemetry',
    });
    const load = vi.fn(async () => http);
    const fetchFn = createCapacitorHttpFetch({ loadCapacitorHttp: load });

    await fetchFn('https://example.com/collector/telemetry', { method: 'POST', body: '{}' });
    await fetchFn('https://example.com/collector/telemetry', { method: 'POST', body: '{}' });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('accepts Headers instance and array-of-pairs forms', async () => {
    const { http, request } = fakeHttp({
      data: '',
      status: 200,
      headers: {},
      url: 'https://example.com/collector/telemetry',
    });
    const fetchFn = createCapacitorHttpFetch({ loadCapacitorHttp: async () => http });

    await fetchFn('https://example.com/collector/telemetry', {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['X-API-Key', 'edge_test'],
      ],
      body: '{}',
    });

    const firstCall = request.mock.calls[0]?.[0] as { headers?: Record<string, string> };
    expect(firstCall.headers?.['Content-Type']).toBe('application/json');
    expect(firstCall.headers?.['X-API-Key']).toBe('edge_test');
  });
});
