import { backoffDelayMs, decideRetry, isRetryable, parseRetryAfter } from './retry-policy';

describe('retry-policy', () => {
  const opts = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: () => 1 };

  it('retries transient failures with exponential backoff', () => {
    expect(decideRetry('TIMEOUT', 1, opts)).toMatchObject({ retry: true, delayMs: 1000 });
    expect(decideRetry('PROVIDER_ERROR', 2, opts)).toMatchObject({ retry: true, delayMs: 2000 });
    expect(decideRetry('NETWORK_ERROR', 3, opts)).toMatchObject({ retry: true, delayMs: 4000 });
    expect(decideRetry('NETWORK_ERROR', 4, opts)).toMatchObject({ retry: true, delayMs: 8000 });
  });

  it('caps the delay and stops at max attempts', () => {
    expect(backoffDelayMs(20, { baseDelayMs: 1000, maxDelayMs: 60_000, jitter: () => 1 })).toBe(
      60_000,
    );
    expect(decideRetry('TIMEOUT', 5, opts).retry).toBe(false);
  });

  it('never blindly retries validation, mapping, duplicate or authorization errors', () => {
    for (const code of [
      'VALIDATION_ERROR',
      'MAPPING_ERROR',
      'DUPLICATE',
      'AUTHORIZATION_ERROR',
      'IDEMPOTENCY_CONFLICT',
    ] as const) {
      expect(isRetryable(code)).toBe(false);
      expect(decideRetry(code, 1, opts).retry).toBe(false);
    }
  });

  it('refreshes credentials once on 401, then gives up', () => {
    expect(decideRetry('AUTHENTICATION_ERROR', 1, opts)).toMatchObject({
      retry: true,
      refreshCredentials: true,
      delayMs: 0,
    });
    expect(decideRetry('AUTHENTICATION_ERROR', 2, opts).retry).toBe(false);
  });

  it('honours Retry-After on 429', () => {
    expect(decideRetry('RATE_LIMITED', 1, opts, 15_000)).toMatchObject({
      retry: true,
      delayMs: 15_000,
    });
    expect(decideRetry('RATE_LIMITED', 1, opts, 999_999).delayMs).toBe(60_000);
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(new Date(1_000_000).toUTCString(), 0)).toBe(1_000_000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });

  it('uses full jitter (half to full of the exponential value)', () => {
    expect(backoffDelayMs(3, { baseDelayMs: 1000, jitter: () => 0 })).toBe(2000);
    expect(backoffDelayMs(3, { baseDelayMs: 1000, jitter: () => 0.5 })).toBe(3000);
  });
});
