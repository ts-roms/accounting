import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  integrationExternalReferences,
  type IntegrationExternalReference,
} from '@/database/schema';

/**
 * internal id <-> provider id per integration and entity type. Importers
 * consult this before creating anything, which is what makes a re-run of the
 * same sync (or a replayed webhook) update instead of duplicate.
 */
@Injectable()
export class ExternalReferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findByExternal(
    integrationId: string,
    entityType: string,
    externalId: string,
    executor: DbExecutor = this.db,
  ): Promise<IntegrationExternalReference | undefined> {
    const [row] = await executor
      .select()
      .from(integrationExternalReferences)
      .where(
        and(
          eq(integrationExternalReferences.integrationId, integrationId),
          eq(integrationExternalReferences.entityType, entityType),
          eq(integrationExternalReferences.externalId, externalId),
        ),
      );
    return row;
  }

  async findByInternal(
    integrationId: string,
    entityType: string,
    internalId: string,
    executor: DbExecutor = this.db,
  ): Promise<IntegrationExternalReference | undefined> {
    const [row] = await executor
      .select()
      .from(integrationExternalReferences)
      .where(
        and(
          eq(integrationExternalReferences.integrationId, integrationId),
          eq(integrationExternalReferences.entityType, entityType),
          eq(integrationExternalReferences.internalId, internalId),
        ),
      );
    return row;
  }

  /** Idempotent link; the unique indexes reject an external id pointing at two records. */
  async link(
    tx: DbExecutor,
    input: {
      integrationId: string;
      provider: string;
      entityType: string;
      externalId: string;
      internalId: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<IntegrationExternalReference> {
    const [row] = await tx
      .insert(integrationExternalReferences)
      .values({
        integrationId: input.integrationId,
        provider: input.provider,
        entityType: input.entityType,
        externalId: input.externalId,
        internalId: input.internalId,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [
          integrationExternalReferences.integrationId,
          integrationExternalReferences.entityType,
          integrationExternalReferences.externalId,
        ],
        set: { lastSeenAt: new Date(), metadata: input.metadata ?? {} },
      })
      .returning();
    return row!;
  }

  /**
   * Outbound counterpart of link(): the internal record is the identity and
   * the provider id may change between pushes (a new acknowledgement number).
   */
  async linkByInternal(
    tx: DbExecutor,
    input: {
      integrationId: string;
      provider: string;
      entityType: string;
      externalId: string;
      internalId: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<IntegrationExternalReference> {
    const [row] = await tx
      .insert(integrationExternalReferences)
      .values({
        integrationId: input.integrationId,
        provider: input.provider,
        entityType: input.entityType,
        externalId: input.externalId,
        internalId: input.internalId,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [
          integrationExternalReferences.integrationId,
          integrationExternalReferences.entityType,
          integrationExternalReferences.internalId,
        ],
        set: {
          externalId: input.externalId,
          lastSeenAt: new Date(),
          metadata: input.metadata ?? {},
        },
      })
      .returning();
    return row!;
  }

  async findByInternalIds(
    integrationId: string,
    entityType: string,
    internalIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<IntegrationExternalReference[]> {
    if (!internalIds.length) return [];
    return executor
      .select()
      .from(integrationExternalReferences)
      .where(
        and(
          eq(integrationExternalReferences.integrationId, integrationId),
          eq(integrationExternalReferences.entityType, entityType),
          inArray(integrationExternalReferences.internalId, internalIds),
        ),
      );
  }

  async list(integrationId: string, entityType?: string, limit = 200) {
    return this.db
      .select()
      .from(integrationExternalReferences)
      .where(
        entityType
          ? and(
              eq(integrationExternalReferences.integrationId, integrationId),
              eq(integrationExternalReferences.entityType, entityType),
            )
          : eq(integrationExternalReferences.integrationId, integrationId),
      )
      .orderBy(desc(integrationExternalReferences.lastSeenAt))
      .limit(limit);
  }

  async forInternalIds(
    integrationId: string,
    entityType: string,
    internalIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<Map<string, string>> {
    if (internalIds.length === 0) return new Map();
    const rows = await executor
      .select({
        internalId: integrationExternalReferences.internalId,
        externalId: integrationExternalReferences.externalId,
      })
      .from(integrationExternalReferences)
      .where(
        and(
          eq(integrationExternalReferences.integrationId, integrationId),
          eq(integrationExternalReferences.entityType, entityType),
          inArray(integrationExternalReferences.internalId, internalIds),
        ),
      );
    return new Map(rows.map((r) => [r.internalId, r.externalId]));
  }
}
