import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Short-lived, in-process cache of the per-request authorization context
 * (user row, accessible companies, resolved permissions, delegations). The
 * guard rebuilds that context on every authenticated request - five to six
 * round trips to PostgreSQL - which dominated request latency once a page
 * fired a dozen requests at once.
 *
 * Safety rules:
 *  - session validity is never cached: the guard still checks the session
 *    row on every request, so logout / revocation is immediate;
 *  - every write that changes what a user may do (role assignment, role
 *    permissions, delegations, user status, company status) calls
 *    `invalidateUser` / `invalidateAll`, so changes apply on the next
 *    request in this process; the TTL is only the ceiling for another
 *    process in a multi-instance deployment.
 */
@Injectable()
export class AuthorizationCacheService {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries = 5000;

  constructor() {
    const raw = Number(process.env.AUTHZ_CACHE_TTL_MS ?? 30_000);
    this.ttlMs = Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
  }

  /** Returns the cached value or computes, stores and returns it. TTL 0 disables caching. */
  async remember<T>(userId: string, key: string, compute: () => Promise<T>): Promise<T> {
    if (this.ttlMs === 0) return compute();
    const fullKey = `${userId}|${key}`;
    const hit = this.entries.get(fullKey);
    const now = Date.now();
    if (hit && hit.expiresAt > now) return hit.value as T;
    const value = await compute();
    if (this.entries.size >= this.maxEntries) this.evictExpired(now);
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(fullKey, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  invalidateUser(userId: string): void {
    const prefix = `${userId}|`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

@Global()
@Module({ providers: [AuthorizationCacheService], exports: [AuthorizationCacheService] })
export class AuthorizationCacheModule {}
