import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('RetryTransport', () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  let transport: RetryTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchFn = vi.fn();
    transport = new RetryTransport(
      { endpoint: 'https://example.com/collector/telemetry', apiKey: 'edge_test', debug: false },
      fetchFn as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends with correct headers', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(200));
    await transport.send('{"test":true}');
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

  it('succeeds on 200', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(200));
    await expect(transport.send('test')).resolves.toBeUndefined();
  });

  it('discards on non-retryable 4xx', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(400));
    await expect(transport.send('test')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 up to 4 attempts then throws', async () => {
    fetchFn.mockResolvedValue(mockResponse(503));
    // Attach the rejection handler BEFORE advancing timers so the promise
    // is never transiently unhandled while fake timers fast-forward.
    const caught = transport.send('test').catch((err: unknown) => err);
    // Advance through all retry delays: 0, 2000, 8000, 30000
    await vi.advanceTimersByTimeAsync(40000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 503/);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('retries on network error', async () => {
    fetchFn.mockRejectedValue(new Error('network error'));
    const caught = transport.send('test').catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(40000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('network error');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('succeeds if a retry returns 200', async () => {
    fetchFn
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200));
    const promise = transport.send('test');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('uses X-API-Key header, not Authorization Bearer', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(200));
    await transport.send('test');
    const call = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('edge_test');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });
});
