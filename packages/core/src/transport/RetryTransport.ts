export interface RetryTransportOptions {
  endpoint: string;
  apiKey: string;
  debug?: boolean;
}

const RETRY_DELAYS_MS = [0, 2000, 8000, 30000] as const;

const RETRYABLE_STATUS = new Set([0, 429, 503]);

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

function getFetch(): FetchLike {
  return (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function')
    ? globalThis.fetch.bind(globalThis)
    : (() => { throw new Error('fetch is not available'); }) as unknown as FetchLike;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private readonly fetchFn: FetchLike;

  constructor(options: RetryTransportOptions, fetchFn?: FetchLike) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.debug = options.debug ?? false;
    this.fetchFn = fetchFn ?? getFetch();
  }

  async send(body: string): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 0;
      if (delay > 0) {
        await sleep(delay);
      }

      try {
        const response = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
          },
          body,
        });

        if (response.ok) {
          return;
        }

        if (response.status === 429) {
          const retryAfter = getRetryAfterMs(response);
          if (retryAfter !== undefined && attempt < RETRY_DELAYS_MS.length - 1) {
            await sleep(retryAfter);
            continue;
          }
        }

        if (!RETRYABLE_STATUS.has(response.status)) {
          if (this.debug) {
            // eslint-disable-next-line no-console
            console.warn(`[edge-rum] non-retryable response ${response.status}, discarding`);
          }
          return;
        }

        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }
}
