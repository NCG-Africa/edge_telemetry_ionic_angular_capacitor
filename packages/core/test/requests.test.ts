import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerRequestCapture,
  type HttpRequestAttributes,
  type RequestsDeps,
  type RequestsHandle,
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
    expect(recorded[0]?.attrs['http.url']).toBe('api.example.com/data');
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
    expect(recorded[0]?.attrs['http.url']).toBe('api.example.com/data');
  });

  it('E25: every send counts as activity, ignored URLs included', async () => {
    const onSend = vi.fn();
    const handle = registerRequestCapture({ ...deps, ignoreUrls: ['analytics.example.com'], onSend });
    await target.fetch('https://analytics.example.com/track');
    await target.fetch('https://api.example.com/data');
    handle.dispose();
    expect(onSend).toHaveBeenCalledTimes(2);
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
    expect(recorded[0]?.attrs['http.url']).toBe('api.example.com/data');
  });

  it('templates the URL, then hands it to sanitizeUrl (P2)', async () => {
    const seen: string[] = [];
    const handle = registerRequestCapture({
      ...deps,
      sanitizeUrl: (url) => {
        seen.push(url);
        return url.replace('/users', '/u');
      },
    });

    await target.fetch('https://api.example.com/v2/users/12345?token=abc&q=hats#x');
    handle.dispose();

    expect(seen).toEqual(['api.example.com/v2/users/{id}']);
    expect(recorded[0]?.attrs['http.url']).toBe('api.example.com/v2/u/{id}');
  });

  it('keeps the templated URL when sanitizeUrl throws', async () => {
    const handle = registerRequestCapture({ ...deps, sanitizeUrl: () => { throw new Error('bad'); } });
    await target.fetch('https://api.example.com/users/1?token=t');
    handle.dispose();

    expect(recorded[0]?.attrs['http.url']).toBe('api.example.com/users/{id}');
  });

  it('unwraps a CapacitorHttp proxy URL and applies ignoreUrls to the real one', async () => {
    const proxied = (u: string) => `capacitor://localhost/_capacitor_http_interceptor_?u=${encodeURIComponent(u)}`;
    const handle = registerRequestCapture({ ...deps, ignoreUrls: ['ingest.example.com'] });
    await target.fetch(proxied('https://api.example.com/orders/9'));
    await target.fetch(proxied('https://ingest.example.com/collector'));
    handle.dispose();

    expect(recorded.map((r) => r.attrs['http.url'])).toEqual(['api.example.com/orders/{id}']);
  });

  it('records request and response sizes where available (E6)', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/submit', { method: 'POST', body: '{"name":"é"}' });
    await target.fetch('https://api.example.com/form', { method: 'POST', body: new FormData() });
    handle.dispose();

    expect(recorded[0]?.attrs['http.request_size']).toBe(13);
    expect(recorded[0]?.attrs['http.response_size']).toBe(1024);
    expect(recorded[1]?.attrs).not.toHaveProperty('http.request_size');
  });

  it('omits response size without a numeric Content-Length', async () => {
    fakeFetch.mockResolvedValueOnce(mockResponse(200));
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    expect(recorded[0]?.attrs).not.toHaveProperty('http.response_size');
    expect(recorded[0]?.attrs).not.toHaveProperty('http.request_size');
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

    expect(recorded[0]?.attrs['http.url']).toBe('api.example.com/url-object');
  });
});

describe('registerRequestCapture — XMLHttpRequest (#85)', () => {
  class FakeXhr extends EventTarget {
    status = 0;
    length: string | null = null;
    open(_method: string, _url: string | URL): void {}
    send(_body?: unknown): void {}
    getResponseHeader(name: string): string | null {
      return name === 'content-length' ? this.length : null;
    }
    finish(status: number, length: string | null = null): void {
      this.status = status;
      this.length = length;
      this.dispatchEvent(new Event('loadend'));
    }
  }

  let recorded: HttpRequestAttributes[];
  let target: typeof globalThis;
  const originalOpen = FakeXhr.prototype.open;
  const originalSend = FakeXhr.prototype.send;

  beforeEach(() => {
    recorded = [];
    target = { XMLHttpRequest: FakeXhr } as unknown as typeof globalThis;
  });

  function capture(ignoreUrls: (string | RegExp)[] = []): RequestsHandle {
    return registerRequestCapture({
      recordEvent: (_name, attrs) => recorded.push(attrs),
      ignoreUrls,
      target,
    });
  }

  it('records an http.request event when the request ends', () => {
    const handle = capture();
    const xhr = new FakeXhr();
    xhr.open('post', 'https://api.example.com/items');
    xhr.send('{}');
    expect(recorded).toHaveLength(0);
    xhr.finish(201);
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.['http.url']).toBe('api.example.com/items');
    expect(recorded[0]?.['http.method']).toBe('POST');
    expect(recorded[0]?.['http.status_code']).toBe(201);
    expect(recorded[0]?.['http.success']).toBe(true);
    expect(recorded[0]?.['http.request_size']).toBe(2);
  });

  it('templates the URL and reads Content-Length for the response size', () => {
    const handle = capture();
    const xhr = new FakeXhr();
    xhr.open('GET', 'https://api.example.com/users/42?token=t');
    xhr.send();
    xhr.finish(200, '512');
    handle.dispose();

    expect(recorded[0]?.['http.url']).toBe('api.example.com/users/{id}');
    expect(recorded[0]?.['http.response_size']).toBe(512);
  });

  it('reports each send of a reused instance once', () => {
    const handle = capture();
    const xhr = new FakeXhr();
    xhr.open('GET', 'https://api.example.com/a');
    xhr.send();
    xhr.finish(200);
    xhr.open('GET', 'https://api.example.com/b');
    xhr.send();
    xhr.finish(200);
    handle.dispose();

    expect(recorded.map((r) => r['http.url'])).toEqual(['api.example.com/a', 'api.example.com/b']);
  });

  it('drops the listener of a send that a reopen abandoned', () => {
    const handle = capture();
    const xhr = new FakeXhr();
    xhr.open('GET', 'https://api.example.com/a');
    xhr.send();
    // Reopened in flight: the browser aborts without a loadend for /a.
    xhr.open('GET', 'https://api.example.com/b');
    xhr.send();
    xhr.finish(200);
    handle.dispose();

    expect(recorded.map((r) => r['http.url'])).toEqual(['api.example.com/b']);
  });

  it('records status 0 and success false on network error', () => {
    const handle = capture();
    const xhr = new FakeXhr();
    xhr.open('GET', 'https://api.example.com/down');
    xhr.send();
    xhr.finish(0);
    handle.dispose();

    expect(recorded[0]?.['http.status_code']).toBe(0);
    expect(recorded[0]?.['http.success']).toBe(false);
  });

  it('skips ignored URLs (e.g. the SDK endpoint)', () => {
    const handle = capture(['example.com/collector']);
    const xhr = new FakeXhr();
    xhr.open('POST', 'https://example.com/collector/telemetry');
    xhr.send();
    xhr.finish(200);
    handle.dispose();

    expect(recorded).toHaveLength(0);
  });

  it('restores the original open/send on dispose', () => {
    capture().dispose();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
  });
});
