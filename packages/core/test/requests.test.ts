import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerRequestCapture,
  type NetworkRequestAttributes,
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
  let originalFetch: typeof fetch;
  let fakeFetch: ReturnType<typeof vi.fn>;
  let recorded: Array<{ eventName: string; attrs: NetworkRequestAttributes }>;
  let target: typeof globalThis;
  let deps: RequestsDeps;

  beforeEach(() => {
    recorded = [];
    fakeFetch = vi.fn().mockResolvedValue(mockResponse(200, { 'content-length': '1024' }));
    target = { fetch: fakeFetch } as unknown as typeof globalThis;
    originalFetch = fakeFetch as unknown as typeof fetch;
    deps = {
      recordEvent: (eventName, attrs) => {
        recorded.push({ eventName, attrs });
      },
      getCurrentRoute: () => '/home',
      target,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures a successful GET request', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/data');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.eventName).toBe('network_request');
    expect(recorded[0]?.attrs['network.url']).toBe('https://api.example.com/data');
    expect(recorded[0]?.attrs['network.method']).toBe('GET');
    expect(recorded[0]?.attrs['network.status_code']).toBe(200);
    expect(recorded[0]?.attrs['network.response_body_size']).toBe(1024);
    expect(recorded[0]?.attrs['network.parent_screen']).toBe('/home');
  });

  it('captures POST method from init', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch('https://api.example.com/submit', {
      method: 'POST',
      body: '{"name":"test"}',
    });
    handle.dispose();

    expect(recorded[0]?.attrs['network.method']).toBe('POST');
    expect(recorded[0]?.attrs['network.request_body_size']).toBe(15);
  });

  it('records status 0 and duration on network error', async () => {
    fakeFetch.mockRejectedValueOnce(new Error('network down'));
    const handle = registerRequestCapture(deps);

    await expect(target.fetch('https://api.example.com/fail')).rejects.toThrow('network down');
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.attrs['network.status_code']).toBe(0);
    expect(recorded[0]?.attrs['network.duration_ms']).toBeGreaterThanOrEqual(0);
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
    expect(recorded[0]?.attrs['network.url']).toBe('https://api.example.com/data');
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
    expect(recorded[0]?.attrs['network.url']).toBe('https://api.example.com/data');
  });

  it('applies sanitizeUrl to captured URLs', async () => {
    const handle = registerRequestCapture({
      ...deps,
      sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),
    });

    await target.fetch('https://api.example.com/users/12345');
    handle.dispose();

    expect(recorded[0]?.attrs['network.url']).toBe('https://api.example.com/users/:id');
  });

  it('restores original fetch on dispose', async () => {
    const beforePatch = target.fetch;
    const handle = registerRequestCapture(deps);
    expect(target.fetch).not.toBe(beforePatch);
    handle.dispose();
    // After dispose, fetch should no longer be the patched version
    await target.fetch('https://api.example.com/after-dispose');
    // Only the call during the test should be recorded (not through capture)
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
    handle.dispose(); // should not throw
    expect(recorded).toHaveLength(0);
  });

  it('handles URL object input', async () => {
    const handle = registerRequestCapture(deps);
    await target.fetch(new URL('https://api.example.com/url-object'));
    handle.dispose();

    expect(recorded[0]?.attrs['network.url']).toBe('https://api.example.com/url-object');
  });
});
