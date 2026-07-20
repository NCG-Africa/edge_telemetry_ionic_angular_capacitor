import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryTransport } from '../src/transport/RetryTransport';

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name] ?? null;
      },
    },
  } as unknown as Response;
}

describe('RetryTransport.sendOnce', () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  let transport: RetryTransport;

  beforeEach(() => {
    fetchFn = vi.fn();
    transport = new RetryTransport(
      { endpoint: 'https://example.com/collector/telemetry', apiKey: 'edge_test', debug: false },
      fetchFn as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    );
  });

  it('sends with correct headers', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(200));
    await transport.sendOnce('{"test":true}');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://example.com/collector/telemetry',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'edge_test',
        },
        body: '{"test":true}',
      }),
    );
  });

  it('classifies 200 as ok', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(200));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'ok' });
  });

  it('classifies non-retryable 4xx as fatal (single POST, no retry)', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(400));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'fatal' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('classifies 503 as retryable and does NOT sleep or retry inline', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(503));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'retryable', retryAfterMs: undefined });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('classifies a status-0 response as retryable', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(0));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'retryable', retryAfterMs: undefined });
  });

  it('classifies a thrown network error as retryable', async () => {
    fetchFn.mockRejectedValueOnce(new Error('network error'));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'retryable' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('carries Retry-After (seconds → ms) on a 429', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(429, { 'retry-after': '3' }));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'retryable', retryAfterMs: 3000 });
  });

  it('omits retryAfterMs on a 429 with no Retry-After header', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(429));
    await expect(transport.sendOnce('test')).resolves.toEqual({ status: 'retryable', retryAfterMs: undefined });
  });

  it('uses X-API-Key header, not Authorization Bearer', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(200));
    await transport.sendOnce('test');
    const call = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('edge_test');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('setFetchFn swaps the active fetch implementation', async () => {
    const replacement = vi.fn().mockResolvedValueOnce(mockResponse(200));
    transport.setFetchFn(replacement as unknown as (input: string, init?: RequestInit) => Promise<Response>);
    await transport.sendOnce('{"swapped":true}');
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
