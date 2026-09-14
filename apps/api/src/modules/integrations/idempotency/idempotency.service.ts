import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/database/database.types';
import { idempotencyKeys, type IdempotencyKey } from '@/database/schema';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Canonical hash of what makes two requests "the same". */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${stableStringify(body ?? null)}`)
    .digest('hex');
}

/** Deterministic JSON (sorted keys) so key order in the client never changes the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export type ClaimResult =
  | { kind: 'ACQUIRED'; row: IdempotencyKey }
  | { kind: 'REPLAY'; row: IdempotencyKey }
  | { kind: 'IN_PROGRESS'; row: IdempotencyKey }
  | { kind: 'MISMATCH'; row: IdempotencyKey };

/**
 * Concurrency-safe claim of an (organization, key) pair: the unique index
 * arbitrates races, so two identical retries can never both execute the
 * handler. Completed responses are stored for replay until the TTL passes.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async claim(
    organizationId: string,
    key: string,
    endpoint: string,
    requestHash: string,
  ): Promise<ClaimResult> {
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({
        organizationId,
        idempotencyKey: key,
        endpoint,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing({
        target: [idempotencyKeys.organizationId, idempotencyKeys.idempotencyKey],
      })
      .returning();
    if (inserted[0]) return { kind: 'ACQUIRED', row: inserted[0] };

    const [existing] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.organizationId, organizationId),
          eq(idempotencyKeys.idempotencyKey, key),
        ),
      );
    if (!existing) return this.claim(organizationId, key, endpoint, requestHash);
    if (existing.expiresAt.getTime() <= Date.now()) {
      // Expired: release and re-claim.
      await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      return this.claim(organizationId, key, endpoint, requestHash);
    }
    if (existing.requestHash !== requestHash || existing.endpoint !== endpoint)
      return { kind: 'MISMATCH', row: existing };
    if (existing.status === 'IN_PROGRESS') return { kind: 'IN_PROGRESS', row: existing };
    return { kind: 'REPLAY', row: existing };
  }

  async complete(id: string, responseStatus: number, responseBody: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus,
        responseBody: responseBody === undefined ? null : (responseBody as object),
        completedAt: new Date(),
      })
      .where(eq(idempotencyKeys.id, id));
  }

  /** Server-side failures release the key so the client can retry. */
  async release(id: string): Promise<void> {
    await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, sql`now()`))
      .returning({ id: idempotencyKeys.id });
    return rows.length;
  }
}
