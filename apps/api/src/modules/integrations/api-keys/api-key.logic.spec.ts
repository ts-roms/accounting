import { API_KEY_PREFIX } from '@accounting/types';
import {
  apiKeyState,
  effectiveApiKeyPermissions,
  FixedWindowRateLimiter,
  generateApiKey,
  grantableScopes,
  hashApiKey,
  isApiKeySecret,
  prefixOf,
} from './api-key.logic';

describe('api-key.logic', () => {
  it('generates prefixed secrets whose hash, not plaintext, is stored', () => {
    const key = generateApiKey();
    expect(key.secret.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.prefix).toHaveLength(8);
    expect(prefixOf(key.secret)).toBe(key.prefix);
    expect(key.hash).toBe(hashApiKey(key.secret));
    expect(key.hash).not.toContain(key.secret);
    expect(isApiKeySecret(key.secret)).toBe(true);
    expect(isApiKeySecret('eyJhbGciOi...jwt')).toBe(false);
    expect(generateApiKey().secret).not.toBe(key.secret);
  });

  it('caps a key at the owner permissions and never grants posting without an explicit scope', () => {
    const owner = new Set([
      'invoice.view',
      'invoice.create',
      'customer.view',
      'invoice.post',
      'invoice.approve',
    ]);
    const write = effectiveApiKeyPermissions(['invoices:write'], owner);
    expect([...write].sort()).toEqual(['customer.view', 'invoice.create', 'invoice.view']);
    expect(write.has('invoice.post')).toBe(false);
    const post = effectiveApiKeyPermissions(['invoices:post'], owner);
    expect(post.has('invoice.post')).toBe(true);
    // Owner without posting rights: the :post scope is inert.
    const limited = effectiveApiKeyPermissions(['invoices:post'], new Set(['invoice.view']));
    expect([...limited]).toEqual(['invoice.view']);
    expect(effectiveApiKeyPermissions(['journals:create'], new Set(['journal.post'])).size).toBe(0);
  });

  it('only lets an owner grant scopes fully covered by their own permissions', () => {
    const owner = new Set(['customer.view', 'customer.manage', 'invoice.view']);
    const { allowed, denied } = grantableScopes(
      ['customers:write', 'invoices:write', 'bogus:scope'],
      owner,
    );
    expect(allowed).toEqual(['customers:write']);
    expect(denied).toEqual([
      { scope: 'invoices:write', missing: ['invoice.create'] },
      { scope: 'bogus:scope', missing: ['unknown scope'] },
    ]);
  });

  it('derives ACTIVE / EXPIRED / REVOKED at read time', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    expect(apiKeyState({ status: 'ACTIVE', expiresAt: null, revokedAt: null }, now)).toBe('ACTIVE');
    expect(
      apiKeyState(
        { status: 'ACTIVE', expiresAt: new Date('2026-09-30T00:00:00Z'), revokedAt: null },
        now,
      ),
    ).toBe('EXPIRED');
    expect(apiKeyState({ status: 'ACTIVE', expiresAt: null, revokedAt: now }, now)).toBe('REVOKED');
    expect(apiKeyState({ status: 'REVOKED', expiresAt: null, revokedAt: null }, now)).toBe(
      'REVOKED',
    );
  });

  it('rate limits per key in fixed windows', () => {
    let t = 0;
    const limiter = new FixedWindowRateLimiter(60_000, () => t);
    expect(limiter.hit('k', 2)).toBe(1);
    expect(limiter.hit('k', 2)).toBe(0);
    expect(limiter.hit('k', 2)).toBe(-1);
    expect(limiter.hit('other', 2)).toBe(1);
    t = 60_001;
    expect(limiter.hit('k', 2)).toBe(1);
  });
});
