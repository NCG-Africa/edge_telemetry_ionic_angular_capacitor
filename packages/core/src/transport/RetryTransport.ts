export interface RetryTransportOptions {
  endpoint: string;
  apiKey: string;
  debug?: boolean;
}

const RETRYABLE_STATUS = new Set([0, 429, 503]);

// One POST, classified. Timing/backoff is NOT here (ADR-028) — it lives in the
// OfflineQueue drain. `retryable` carries any Retry-After (ms) for the drain to
// honor; `fatal` is a non-retryable response the drain drops immediately.
export type SendResult =
  | { status: 'ok' }
  | { status: 'retryable'; retryAfterMs?: number }
  | { status: 'fatal' };

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

function getFetch(): FetchLike {
  return (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function')
    ? globalThis.fetch.bind(globalThis)
    : (() => { throw new Error('fetch is not available'); }) as unknown as FetchLike;
}

function getRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return undefined;
}

export class RetryTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly debug: boolean;
  private fetchFn: FetchLike;

  constructor(options: RetryTransportOptions, fetchFn?: FetchLike) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.debug = options.debug ?? false;
    this.fetchFn = fetchFn ?? getFetch();
  }

  setFetchFn(fetchFn: FetchLike): void {
    this.fetchFn = fetchFn;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  // Stateless single POST. Never sleeps, never throws — classifies the outcome
  // so the caller (fail-fast flush) or the paced drain decides what happens next.
  async sendOnce(body: string): Promise<SendResult> {
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body,
      });

      if (response.ok) return { status: 'ok' };

      if (RETRYABLE_STATUS.has(response.status)) {
        return { status: 'retryable', retryAfterMs: getRetryAfterMs(response) };
      }

      if (this.debug) {
        // eslint-disable-next-line no-console
        console.warn(`[edge-rum] non-retryable response ${response.status}, dropping`);
      }
      return { status: 'fatal' };
    } catch (err) {
      // Network-level failure (fetch threw) — same class as a status-0 response.
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.warn('[edge-rum] send failed', err);
      }
      return { status: 'retryable' };
    }
  }
}
