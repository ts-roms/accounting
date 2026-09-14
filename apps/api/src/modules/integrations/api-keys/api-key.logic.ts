import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_PREFIX, permissionsForScopes, type PermissionKey } from '@accounting/types';

/**
 * Pure helpers for API keys: secret generation, hashing and the authority
 * calculation. No I/O so every rule is unit-tested.
 *
 * Secret format: `ak_<8 char prefix><32 char random>` - the prefix is stored
 * in clear for lookup / display; only the SHA-256 of the whole secret is kept.
 */
export interface GeneratedApiKey {
  secret: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(random: (bytes: number) => Buffer = randomBytes): GeneratedApiKey {
  const body = random(30)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 40);
  const secret = `${API_KEY_PREFIX}${body}`;
  return { secret, prefix: body.slice(0, 8), hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function isApiKeySecret(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX) && token.length >= 20;
}

export function prefixOf(secret: string): string {
  return secret.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8);
}

/**
 * Effective permissions of a key: what its scopes grant, intersected with
 * what the owner currently holds in the requested company. A key therefore
 * loses authority the moment its owner does.
 */
export function effectiveApiKeyPermissions(
  scopes: readonly string[],
  ownerPermissions: ReadonlySet<string>,
): Set<PermissionKey> {
  const fromScopes = permissionsForScopes(scopes);
  const out = new Set<PermissionKey>();
  for (const p of fromScopes) if (ownerPermissions.has(p)) out.add(p);
  return out;
}

/** Scopes the owner may grant: every scope whose permissions they all hold. */
export function grantableScopes(
  scopes: readonly string[],
  ownerPermissions: ReadonlySet<string>,
): { allowed: string[]; denied: Array<{ scope: string; missing: string[] }> } {
  const allowed: string[] = [];
  const denied: Array<{ scope: string; missing: string[] }> = [];
  for (const scope of scopes) {
    const needed = [...permissionsForScopes([scope])];
    const missing = needed.filter((p) => !ownerPermissions.has(p));
    if (needed.length > 0 && missing.length === 0) allowed.push(scope);
    else denied.push({ scope, missing: needed.length === 0 ? ['unknown scope'] : missing });
  }
  return { allowed, denied };
}

export type ApiKeyState = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export function apiKeyState(
  key: { status: ApiKeyState; expiresAt: Date | null; revokedAt: Date | null },
  now: Date = new Date(),
): ApiKeyState {
  if (key.status === 'REVOKED' || key.revokedAt) return 'REVOKED';
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/** Fixed-window per-key limiter; adequate for one process, swap for Redis at scale. */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns remaining quota after this hit, or -1 when the limit is exceeded. */
  hit(key: string, limit: number): number {
    const t = this.now();
    const windowStart = t - (t % this.windowMs);
    const entry = this.windows.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      this.windows.set(key, { windowStart, count: 1 });
      return limit - 1;
    }
    if (entry.count >= limit) return -1;
    entry.count += 1;
    return limit - entry.count;
  }

  /** Drop stale windows (called by the cleanup job). */
  prune(): void {
    const t = this.now();
    for (const [k, v] of this.windows)
      if (t - v.windowStart > this.windowMs * 2) this.windows.delete(k);
  }
}
