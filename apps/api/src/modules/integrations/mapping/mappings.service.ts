import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { IntegrationDirection, SyncEntity } from '@accounting/types';
import type {
  MappingFieldRuleInput,
  PreviewMappingInput,
  UpsertMappingInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { integrationMappings, type IntegrationMapping } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { ConnectorRegistry } from '../core/connector-registry';
import { applyMapping, type MappingContext, type MappingResult } from './mapping.logic';

const MODULE = 'INTEGRATIONS';

export interface ResolvedMapping {
  rules: MappingFieldRuleInput[];
  lookups: Record<string, Record<string, unknown>>;
  source: 'INTEGRATION' | 'CONNECTOR_DEFAULT' | 'NONE';
}

/**
 * Per-integration mapping configuration. Resolution order: an active
 * integration mapping, else the connector's default for the entity. The
 * engine itself (`mapping.logic.ts`) stays pure.
 */
@Injectable()
export class MappingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly registry: ConnectorRegistry,
  ) {}

  async list(integrationId: string): Promise<IntegrationMapping[]> {
    return this.db
      .select()
      .from(integrationMappings)
      .where(eq(integrationMappings.integrationId, integrationId))
      .orderBy(asc(integrationMappings.entity), asc(integrationMappings.direction));
  }

  async upsert(
    actor: AuthenticatedUser,
    integrationId: string,
    input: UpsertMappingInput,
  ): Promise<IntegrationMapping> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(integrationMappings)
        .where(
          and(
            eq(integrationMappings.integrationId, integrationId),
            eq(integrationMappings.entity, input.entity),
            eq(integrationMappings.direction, input.direction),
          ),
        );
      const [row] = await tx
        .insert(integrationMappings)
        .values({
          integrationId,
          entity: input.entity,
          direction: input.direction,
          name: input.name,
          rules: input.rules,
          lookups: input.lookups,
          isActive: input.isActive,
          updatedBy: actor.id,
        })
        .onConflictDoUpdate({
          target: [
            integrationMappings.integrationId,
            integrationMappings.entity,
            integrationMappings.direction,
          ],
          set: {
            name: input.name,
            rules: input.rules,
            lookups: input.lookups,
            isActive: input.isActive,
            version: (existing?.version ?? 0) + 1,
            updatedBy: actor.id,
          },
        })
        .returning();
      await this.audit.record(
        {
          action: existing ? 'UPDATE' : 'CREATE',
          module: MODULE,
          entityType: 'IntegrationMapping',
          entityId: row!.id,
          previousValue: existing
            ? { version: existing.version, rules: existing.rules.length }
            : null,
          newValue: { entity: input.entity, direction: input.direction, rules: input.rules.length },
          metadata: { integrationId },
        },
        tx,
      );
      return row!;
    });
  }

  async remove(actor: AuthenticatedUser, integrationId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(integrationMappings)
        .where(
          and(eq(integrationMappings.id, id), eq(integrationMappings.integrationId, integrationId)),
        )
        .returning();
      if (rows[0])
        await this.audit.record(
          {
            action: 'DELETE',
            module: MODULE,
            entityType: 'IntegrationMapping',
            entityId: id,
            previousValue: { entity: rows[0].entity, direction: rows[0].direction },
            metadata: { integrationId, actor: actor.email },
          },
          tx,
        );
    });
  }

  async resolve(
    integrationId: string,
    provider: string,
    entity: SyncEntity,
    direction: IntegrationDirection = 'INBOUND',
    executor: DbExecutor = this.db,
  ): Promise<ResolvedMapping> {
    const [row] = await executor
      .select()
      .from(integrationMappings)
      .where(
        and(
          eq(integrationMappings.integrationId, integrationId),
          eq(integrationMappings.entity, entity),
          eq(integrationMappings.direction, direction),
          eq(integrationMappings.isActive, true),
        ),
      );
    if (row)
      return {
        rules: row.rules as MappingFieldRuleInput[],
        lookups: row.lookups,
        source: 'INTEGRATION',
      };
    const descriptor = this.registry.has(provider)
      ? this.registry.get(provider).descriptor
      : undefined;
    const defaults =
      direction === 'OUTBOUND'
        ? descriptor?.defaultOutboundMappings?.[entity]
        : descriptor?.defaultMappings?.[entity];
    if (defaults) return { rules: defaults, lookups: {}, source: 'CONNECTOR_DEFAULT' };
    return { rules: [], lookups: {}, source: 'NONE' };
  }

  async apply(
    integrationId: string,
    provider: string,
    entity: SyncEntity,
    record: Record<string, unknown>,
    ctx: Omit<MappingContext, 'lookups'> = {},
    executor: DbExecutor = this.db,
    direction: IntegrationDirection = 'INBOUND',
  ): Promise<MappingResult & { source: ResolvedMapping['source'] }> {
    const mapping = await this.resolve(integrationId, provider, entity, direction, executor);
    // Outbound with no rules at all = pass the domain view through unchanged.
    if (mapping.source === 'NONE' && direction === 'OUTBOUND')
      return { output: { ...record }, errors: [], source: mapping.source };
    const result = applyMapping(mapping.rules, record, { ...ctx, lookups: mapping.lookups });
    return { ...result, source: mapping.source };
  }

  async preview(
    integrationId: string,
    provider: string,
    input: PreviewMappingInput,
  ): Promise<MappingResult & { source: ResolvedMapping['source'] }> {
    const mapping = await this.resolve(integrationId, provider, input.entity, input.direction);
    return {
      ...applyMapping(mapping.rules, input.sample, { lookups: mapping.lookups }),
      source: mapping.source,
    };
  }
}
