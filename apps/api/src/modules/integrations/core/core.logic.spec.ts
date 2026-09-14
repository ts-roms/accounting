import { HttpStatus } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { computeHealth } from '../health/health.logic';
import { requestFingerprint, stableStringify } from '../idempotency/idempotency.service';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  hashState,
  needsRefresh,
  parseTokenResponse,
  safeReturnTo,
} from '../oauth/oauth.logic';
import { CredentialCipher } from './credential-cipher';
import { IntegrationError } from './integration-error';
import { ProviderThrottle } from './provider-http';
import { redact, redactString, safeHeaders } from './redaction';

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher('unit-test-secret-0123456789');

  it('round-trips and never stores plaintext', () => {
    const secret = 'sk_live_super_secret';
    const envelope = cipher.encrypt(secret);
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(envelope).not.toContain(secret);
    expect(cipher.decrypt(envelope)).toBe(secret);
    expect(cipher.encrypt(secret)).not.toBe(envelope); // fresh IV every time
  });

  it('detects tampering and wrong keys', () => {
    const envelope = cipher.encrypt('{"apiKey":"x"}');
    const [v, iv, tag, data] = envelope.split(':');
    expect(() => cipher.decrypt(`${v}:${iv}:${tag}:${data!.slice(0, -2)}AA`)).toThrow();
    expect(() => new CredentialCipher('another-secret-0123456789').decrypt(envelope)).toThrow();
    expect(cipher.decryptJson(cipher.encryptJson({ a: 1 }))).toEqual({ a: 1 });
  });

  it('accepts hex / base64 32-byte keys and passphrases', () => {
    expect(CredentialCipher.deriveKey('a'.repeat(64))).toHaveLength(32);
    expect(CredentialCipher.deriveKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(CredentialCipher.deriveKey('just a passphrase')).toHaveLength(32);
    expect(() => new CredentialCipher('short')).toThrow();
  });
});

describe('redaction', () => {
  it('masks credential-like keys, bearer values and our API keys', () => {
    const out = redact({
      authorization: 'Bearer abc',
      nested: { client_secret: 'x', ok: 'keep', token: 't' },
      list: [{ password: 'p' }, 'ak_abcdefghijklmnop'],
      note: 'key ak_1234567890abcdef in text',
    });
    expect(out).toEqual({
      authorization: '[REDACTED]',
      nested: { client_secret: '[REDACTED]', ok: 'keep', token: '[REDACTED]' },
      list: [{ password: '[REDACTED]' }, 'ak_[REDACTED]'],
      note: 'key ak_[REDACTED] in text',
    });
    expect(redactString('Basic dXNlcjpwYXNz')).toBe('[REDACTED]');
    expect(
      safeHeaders({ authorization: 'Bearer x', 'content-type': 'application/json', cookie: 'a=b' }),
    ).toEqual({ 'content-type': 'application/json' });
  });
});

describe('IntegrationError', () => {
  it('classifies HTTP statuses and app errors', () => {
    expect(IntegrationError.fromHttpStatus(401).code).toBe('AUTHENTICATION_ERROR');
    expect(IntegrationError.fromHttpStatus(403).code).toBe('AUTHORIZATION_ERROR');
    expect(IntegrationError.fromHttpStatus(429, undefined, 5000)).toMatchObject({
      code: 'RATE_LIMITED',
      options: { retryAfterMs: 5000 },
    });
    expect(IntegrationError.fromHttpStatus(503).code).toBe('PROVIDER_ERROR');
    expect(IntegrationError.fromHttpStatus(422).code).toBe('VALIDATION_ERROR');
    expect(
      IntegrationError.from(
        new AppError(ErrorCodes.VALIDATION_FAILED, 'bad', HttpStatus.BAD_REQUEST),
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      IntegrationError.from(new AppError(ErrorCodes.DUPLICATE, 'dup', HttpStatus.CONFLICT)).code,
    ).toBe('DUPLICATE');
    expect(
      IntegrationError.from(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code,
    ).toBe('NETWORK_ERROR');
    expect(IntegrationError.from(Object.assign(new Error('x'), { name: 'AbortError' })).code).toBe(
      'TIMEOUT',
    );
    expect(IntegrationError.from('weird').code).toBe('UNKNOWN_ERROR');
  });
});

describe('idempotency fingerprint', () => {
  it('is independent of key order and undefined fields', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(
      '{"a":[2,{"d":1}],"b":1}',
    );
    expect(requestFingerprint('post', '/x', { a: 1, b: 2 })).toBe(
      requestFingerprint('POST', '/x', { b: 2, a: 1 }),
    );
    expect(requestFingerprint('POST', '/x', { a: 1 })).not.toBe(
      requestFingerprint('POST', '/x', { a: 2 }),
    );
    expect(requestFingerprint('POST', '/x', {})).not.toBe(requestFingerprint('POST', '/y', {}));
  });
});

describe('oauth.logic', () => {
  it('builds authorisation URLs with PKCE and validates token responses', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizeUrl: 'https://idp.example/authorize',
        clientId: 'cid',
        redirectUri: 'https://api.example/api/v1/integrations/oauth/callback',
        scopes: ['a', 'b'],
        state: 'st',
        codeChallenge: codeChallengeS256('verifier'),
        extra: { access_type: 'offline' },
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('a b');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(hashState('abc')).toHaveLength(64);
    expect(parseTokenResponse({ access_token: 'x', expires_in: '3600' })).toMatchObject({
      access_token: 'x',
      expires_in: 3600,
    });
    expect(() => parseTokenResponse({ token: 'x' })).toThrow();
    expect(needsRefresh(new Date(Date.now() + 60_000))).toBe(true);
    expect(needsRefresh(new Date(Date.now() + 3_600_000))).toBe(false);
    expect(needsRefresh(null)).toBe(false);
  });

  it('never redirects off-origin after the callback', () => {
    const web = 'http://localhost:3000';
    expect(safeReturnTo('/admin/integrations/1', web, '/x')).toBe(
      'http://localhost:3000/admin/integrations/1',
    );
    expect(safeReturnTo('https://evil.example/phish', web, '/x')).toBe('http://localhost:3000/x');
    expect(safeReturnTo('//evil.example', web, '/x')).toBe('http://localhost:3000/x');
    expect(safeReturnTo('http://localhost:3000/ok?a=1', web, '/x')).toBe(
      'http://localhost:3000/ok?a=1',
    );
  });
});

describe('health.logic', () => {
  const base = {
    status: 'CONNECTED' as const,
    now: new Date('2026-10-05T00:00:00Z'),
    lastSuccessAt: new Date('2026-10-04T23:00:00Z'),
    lastFailureAt: null,
    failureCount: 0,
    credentialsExpireAt: null,
    oauthStatus: null,
    failures24h: 0,
    successes24h: 20,
    avgLatencyMs: 300,
    webhookExhausted24h: 0,
    webhookDelivered24h: 10,
    providerRateLimited: false,
    syncOverdue: false,
  };

  it('scores a healthy integration at 100 and names every deduction otherwise', () => {
    expect(computeHealth(base)).toMatchObject({
      score: 100,
      status: 'HEALTHY',
      webhookHealth: 'HEALTHY',
      deductions: [],
    });
    const bad = computeHealth({
      ...base,
      status: 'ERROR',
      lastFailureAt: new Date('2026-10-04T23:30:00Z'),
      failureCount: 4,
      failures24h: 12,
      successes24h: 8,
      credentialsExpireAt: new Date('2026-10-08T00:00:00Z'),
      webhookExhausted24h: 6,
      webhookDelivered24h: 4,
      avgLatencyMs: 6000,
      providerRateLimited: true,
      syncOverdue: true,
    });
    expect(bad.status).toBe('UNHEALTHY');
    expect(bad.score).toBe(0);
    expect(bad.deductions.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'ERROR',
        'RECENT_FAILURE',
        'CONSECUTIVE_FAILURES',
        'FAILURE_RATE',
        'CREDENTIALS_EXPIRING',
        'WEBHOOKS_FAILING',
        'LATENCY',
        'RATE_LIMITED',
        'SYNC_OVERDUE',
      ]),
    );
    expect(bad.credentialExpiry).toMatchObject({ state: 'EXPIRING', daysLeft: 3 });
    expect(
      computeHealth({ ...base, failureCount: 1, lastFailureAt: new Date('2026-10-04T23:30:00Z') }),
    ).toMatchObject({ status: 'DEGRADED', score: 75 });
    expect(computeHealth({ ...base, status: 'DISABLED' }).status).toBe('UNKNOWN');
  });
});

describe('ProviderThrottle', () => {
  it('lets a burst through then waits for refill', async () => {
    let t = 0;
    const throttle = new ProviderThrottle(() => t);
    await throttle.acquire('P', 2);
    await throttle.acquire('P', 2);
    expect(throttle.state('P', 2).limited).toBe(true);
    t = 1000; // one second refills the bucket
    await throttle.acquire('P', 2);
    expect(throttle.state('P', 2).limited).toBe(false);
    expect(throttle.state('Q', undefined)).toEqual({ limited: false, tokens: null });
  });
});
