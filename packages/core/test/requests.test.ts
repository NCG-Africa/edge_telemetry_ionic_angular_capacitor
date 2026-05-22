import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerRequestCapture,
  type HttpRequestAttributes,
  type RequestsDeps,
} from '../src/instrumentation/requests';

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as unknown as Response;
}

describe('registerRequestCapture', () => {
  let fakeFetch: ReturnType<typeof vi.fn>;
  let recorded: Array<{ eventName: string; attrs: HttpRequestAttributes }>;
  let target: typeof globalThis;
  let deps: RequestsDeps;

  beforeEach(() => {
    recorded = [];
    fakeFetch = vi.fn().mockResolvedValue(mockResponse(200, { 'content-length': '1024' }));
    target = { fetch: fakeFetch } as unknown as typeof globalThis;
    deps = {
      recordEvent: (eventName, attrs) => {
        recorded.push({ eventName, attrs });
      },
      target,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures a successful GET request as an http.request event', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.eventName).toBe('http.request');
    expect(recorded[0]?.attrs['http.url']).toBe('https://api.example.com/data');
    expect(recorded[0]?.attrs['http.method']).toBe('GET');
    expect(recorded[0]?.attrs['http.status_code']).toBe(200);
    expect(recorded[0]?.attrs['http.success']).toBe(true);
    expect(recorded[0]?.attrs['http.timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof recorded[0]?.attrs['http.duration_ms']).toBe('number');
  });

  it('captures POST method from init', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/submit', {
      method: 'POST',
      body: '{"name":"test"}',
    });
    handle.dispose();

    expect(recorded[0]?.attrs['http.method']).toBe('POST');
  });

  it('marks http.success false for 4xx and 5xx responses', async () => {
    fakeFetch.mockResolvedValueOnce(mockResponse(404));
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/missing');
    handle.dispose();

    expect(recorded[0]?.attrs['http.status_code']).toBe(404);
    expect(recorded[0]?.attrs['http.success']).toBe(false);
  });

  it('records status 0, success false, and duration on network error', async () => {
    fakeFetch.mockRejectedValueOnce(new Error('network down'));
    const handle = registerRequestCapture(deps);

    await expect(target.fetch('https://api.example.com/fail')).rejects.toThrow('network down');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.attrs['http.status_code']).toBe(0);
    expect(recorded[0]?.attrs['http.success']).toBe(false);
    expect(recorded[0]?.attrs['http.duration_ms']).toBeGreaterThanOrEqual(0);
  });

  it('ignores URLs matching string patterns', async () => {
    const handle = registerRequestCapture({
      ...deps,
      ignoreUrls: ['/collector/telemetry', 'analytics.example.com'],
    });

    await target.fetch('https://edgetelemetry.ncgafrica.com/collector/telemetry');
    await target.fetch('https://analytics.example.com/track');
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.attrs['http.url']).toBe('https://api.example.com/data');
  });

  it('ignores URLs matching RegExp patterns', async () => {
    const handle = registerRequestCapture({
      ...deps,
      ignoreUrls: [/\/collector\//],
    });

    await target.fetch('https://example.com/collector/telemetry');
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.attrs['http.url']).toBe('https://api.example.com/data');
  });

  it('applies sanitizeUrl to captured URLs', async () => {
    const handle = registerRequestCapture({
      ...deps,
      sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),
    });

    await target.fetch('https://api.example.com/users/12345');
    handle.dispose();

    expect(recorded[0]?.attrs['http.url']).toBe('https://api.example.com/users/:id');
  });

  it('strips default sensitive query params even without a user sanitizer', async () => {
    const handle = registerRequestCapture(deps);

    await target.fetch('https://api.example.com/s?q=hats&token=abc123&password=x');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    const url = recorded[0]?.attrs['http.url'] as string;
    expect(url).toBe('https://api.example.com/s?q=hats');
    expect(url).not.toContain('token');
    expect(url).not.toContain('password');
    expect(url).not.toContain('abc123');
  });

  it('runs the default sanitizer before a user-provided sanitizer', async () => {
    const handle = registerRequestCapture({
      ...deps,
      sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),
    });

    await target.fetch('https://api.example.com/users/12345?token=abc&q=hats');
    handle.dispose();

    expect(recorded[0]?.attrs['http.url']).toBe(
      'https://api.example.com/users/:id?q=hats',
    );
  });

  it('restores original fetch on dispose', async () => {
    const beforePatch = target.fetch;
    const handle = registerRequestCapture(deps);
    expect(target.fetch).not.toBe(beforePatch);
    handle.dispose();
    await target.fetch('https://api.example.com/after-dispose');
    expect(recorded).toHaveLength(0);
  });

  it('produces only primitive attribute values', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    const attrs = recorded[0]?.attrs;
    expect(attrs).toBeDefined();
    for (const value of Object.values(attrs!)) {
      expect(typeof value).toMatch(/^(string|number|boolean)$/);
    }
  });

  it('does not emit any network.* request attributes', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    const attrs = recorded[0]?.attrs as Record<string, unknown>;
    expect(attrs).not.toHaveProperty('network.url');
    expect(attrs).not.toHaveProperty('network.method');
    expect(attrs).not.toHaveProperty('network.status_code');
    expect(attrs).not.toHaveProperty('network.duration_ms');
    expect(attrs).not.toHaveProperty('network.request_body_size');
    expect(attrs).not.toHaveProperty('network.response_body_size');
    expect(attrs).not.toHaveProperty('network.parent_screen');
  });

  it('contains no OTel terminology', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    const json = JSON.stringify(recorded);
    expect(json).not.toContain('traceId');
    expect(json).not.toContain('spanId');
    expect(json).not.toContain('resourceSpans');
    expect(json).not.toContain('opentelemetry');
  });

  it('returns a no-op handle when fetch is unavailable', () => {
    const handle = registerRequestCapture({
      ...deps,
      target: {} as typeof globalThis,
    });
    handle.dispose();
    expect(recorded).toHaveLength(0);
  });

  it('handles URL object input', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch(new URL('https://api.example.com/url-object'));
    handle.dispose();

    expect(recorded[0]?.attrs['http.url']).toBe('https://api.example.com/url-object');
  });
});
