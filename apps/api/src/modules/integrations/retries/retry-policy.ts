import type { IntegrationErrorCode } from '@accounting/types';

/**
 * Pure retry rules keyed by the standardised error code.
 *
 *   TIMEOUT / NETWORK / PROVIDER (5xx)  -> retry with exponential backoff
 *   RATE_LIMITED (429)                  -> retry, honouring Retry-After when given
 *   AUTHENTICATION_ERROR (401)          -> refresh credentials once, then retry
 *   VALIDATION / MAPPING / DUPLICATE /
 *   AUTHORIZATION / IDEMPOTENCY         -> never retried blindly
 */
export interface RetryDecision {
  retry: boolean;
  /** Delay before the next attempt (0 when `retry` is false). */
  delayMs: number;
  /** Ask the connector to refresh credentials before the retry. */
  refreshCredentials: boolean;
  reason: string;
}

export interface RetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deterministic jitter source for tests (0..1). */
  jitter?: () => number;
}

const DEFAULTS = { baseDelayMs: 1_000, maxDelayMs: 60 * 60 * 1_000 };

const RETRYABLE: ReadonlySet<IntegrationErrorCode> = new Set([
  'TIMEOUT',
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
  'AUTHENTICATION_ERROR',
  'UNKNOWN_ERROR',
]);

export function isRetryable(code: IntegrationErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** Exponential backoff with full jitter: base * 2^(attempt-1), capped. */
export function backoffDelayMs(
  attempt: number,
  opts: Pick<RetryPolicyOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter'> = {},
): number {
  const base = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const max = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const exp = Math.min(base * 2 ** Math.max(attempt - 1, 0), max);
  const jitter = opts.jitter ?? Math.random;
  // Full jitter keeps the mean at half the exponential value and avoids thundering herds.
  return Math.round(exp / 2 + (exp / 2) * jitter());
}

export function decideRetry(
  code: IntegrationErrorCode,
  attempt: number,
  opts: RetryPolicyOptions,
  retryAfterMs?: number,
): RetryDecision {
  if (attempt >= opts.maxAttempts)
    return { retry: false, delayMs: 0, refreshCredentials: false, reason: 'max attempts reached' };
  if (!isRetryable(code))
    return {
      retry: false,
      delayMs: 0,
      refreshCredentials: false,
      reason: `${code} is not retryable`,
    };
  if (code === 'AUTHENTICATION_ERROR') {
    // One credential refresh; a second 401 means the credentials are really gone.
    if (attempt >= 2)
      return {
        retry: false,
        delayMs: 0,
        refreshCredentials: false,
        reason: 'credentials rejected twice',
      };
    return {
      retry: true,
      delayMs: 0,
      refreshCredentials: true,
      reason: 'refresh credentials then retry',
    };
  }
  if (code === 'RATE_LIMITED' && retryAfterMs && retryAfterMs > 0) {
    return {
      retry: true,
      delayMs: Math.min(retryAfterMs, opts.maxDelayMs ?? DEFAULTS.maxDelayMs),
      refreshCredentials: false,
      reason: 'provider Retry-After',
    };
  }
  return {
    retry: true,
    delayMs: backoffDelayMs(attempt, opts),
    refreshCredentials: false,
    reason: 'exponential backoff',
  };
}

/** Parses an HTTP Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
