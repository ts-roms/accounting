import { IntegrationError } from './integration-error';
import { parseRetryAfter } from '../retries/retry-policy';

/**
 * Per-provider token bucket so outbound calls respect the provider's limit
 * across every integration of that provider in this process. Multi-instance
 * deployments should back this with Redis; the interface stays the same.
 */
export class ProviderThrottle {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Resolves when a request may proceed; never rejects. */
  async acquire(provider: string, perSecond: number | undefined): Promise<void> {
    if (!perSecond || perSecond <= 0) return;
    const capacity = Math.max(1, perSecond);
    const bucket = this.buckets.get(provider) ?? { tokens: capacity, updatedAt: this.now() };
    const elapsed = (this.now() - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * perSecond);
    bucket.updatedAt = this.now();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(provider, bucket);
      return;
    }
    const waitMs = Math.ceil(((1 - bucket.tokens) / perSecond) * 1000);
    this.buckets.set(provider, bucket);
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire(provider, perSecond);
  }

  /** Snapshot for the health endpoint. */
  state(
    provider: string,
    perSecond: number | undefined,
  ): { limited: boolean; tokens: number | null } {
    if (!perSecond) return { limited: false, tokens: null };
    const bucket = this.buckets.get(provider);
    return { limited: Boolean(bucket && bucket.tokens < 1), tokens: bucket?.tokens ?? perSecond };
  }
}

export interface ProviderHttpOptions {
  provider: string;
  rateLimitPerSecond?: number;
  throttle: ProviderThrottle;
  defaultTimeoutMs: number;
  onResponse?: (info: { url: string; method: string; status: number; durationMs: number }) => void;
  fetchImpl?: typeof fetch;
}

/**
 * fetch wrapper used by connectors: throttled, with a timeout, mapping
 * transport failures and non-2xx statuses to `IntegrationError`. Bodies are
 * never logged here - the caller decides what (redacted) metadata to keep.
 */
export function createProviderHttp(options: ProviderHttpOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input: string, init: RequestInit & { timeoutMs?: number } = {}) => {
    await options.throttle.acquire(options.provider, options.rateLimitPerSecond);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? options.defaultTimeoutMs);
    const started = Date.now();
    const method = (init.method ?? 'GET').toUpperCase();
    try {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      options.onResponse?.({
        url: input,
        method,
        status: response.status,
        durationMs: Date.now() - started,
      });
      if (!response.ok) {
        throw IntegrationError.fromHttpStatus(
          response.status,
          undefined,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      return response;
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      options.onResponse?.({ url: input, method, status: 0, durationMs: Date.now() - started });
      throw IntegrationError.from(err);
    } finally {
      clearTimeout(timer);
    }
  };
}
