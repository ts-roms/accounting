import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ConnectorCapability, IntegrationStatus, SyncEntity } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { RequestContext } from '@/common/context/request-context';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import { integrationExternalReferences, integrations } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { ConnectorRegistry } from '../core/connector-registry';
import { IntegrationError } from '../core/integration-error';
import { IntegrationPrincipalService } from '../core/integration-principal.service';
import { IntegrationsService } from '../core/integrations.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { ExternalReferencesService } from '../mapping/external-references.service';
import { MappingsService } from '../mapping/mappings.service';
import { BillsExporter, InvoicesExporter } from './exporters/documents.exporter';
import type { ExportRecord, Exporter } from './exporters/exporter';
import { CustomersExporter, ProductsExporter, VendorsExporter } from './exporters/parties.exporter';
import { pushEntity } from './push-engine';

const MODULE = 'INTEGRATIONS';

/** Seeing a record's integration trail is part of seeing the record. */
const ENTITY_VIEW_PERMISSION: Record<SyncEntity, string> = {
  customers: 'customer.view',
  vendors: 'vendor.view',
  invoices: 'invoice.view',
  bills: 'bill.view',
  payments: 'invoice.view',
  'bank-transactions': 'bank-account.view',
  products: 'product.view',
  'sales-orders': 'sales-order.view',
  'purchase-orders': 'purchase-order.view',
};

export interface RecordReferenceView {
  id: string;
  integrationId: string;
  integrationName: string;
  provider: string;
  providerName: string;
  integrationStatus: IntegrationStatus;
  entityType: string;
  externalId: string;
  /** OUTBOUND when the platform sent the record (pushedAt present), INBOUND when it imported it. */
  direction: 'INBOUND' | 'OUTBOUND';
  canPush: boolean;
  metadata: Record<string, unknown>;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface PushTargetView {
  integrationId: string;
  integrationName: string;
  provider: string;
  providerName: string;
}

export interface RecordLinksView {
  references: RecordReferenceView[];
  /** PUSH-capable integrations covering this entity that have not sent this record yet. */
  pushTargets: PushTargetView[];
}

export interface PushRecordResult {
  integrationId: string;
  entity: SyncEntity;
  internalId: string;
  outcome: 'CREATED' | 'UPDATED' | 'FAILED';
  externalId: string | null;
  error: { code: string; message: string } | null;
}

/**
 * The record-centric side of the integration platform: which providers know
 * a given invoice / bill / customer / vendor / product / statement, and a
 * targeted re-push of one record through the same exporter -> mapping ->
 * connector.push path a job uses (own reference, log and audit row, no job
 * row and no cursor movement).
 */
@Injectable()
export class RecordLinksService {
  private readonly exporters: Map<SyncEntity, Exporter>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrations: IntegrationsService,
    private readonly registry: ConnectorRegistry,
    private readonly principals: IntegrationPrincipalService,
    private readonly mappings: MappingsService,
    private readonly refs: ExternalReferencesService,
    private readonly logs: IntegrationLogsService,
    private readonly audit: AuditService,
    customers: CustomersExporter,
    vendors: VendorsExporter,
    products: ProductsExporter,
    invoices: InvoicesExporter,
    bills: BillsExporter,
  ) {
    this.exporters = new Map<SyncEntity, Exporter>(
      [customers, vendors, products, invoices, bills].map((e) => [e.entity, e]),
    );
  }

  async forRecord(
    actor: AuthenticatedUser,
    companyId: string,
    entityType: SyncEntity,
    internalId: string,
  ): Promise<RecordLinksView> {
    const permission = ENTITY_VIEW_PERMISSION[entityType];
    if (!actor.permissions.has(permission))
      throw new ForbiddenError(`Viewing ${entityType} requires ${permission}.`);
    const rows = await this.db
      .select({
        ref: integrationExternalReferences,
        integrationName: integrations.name,
        provider: integrations.provider,
        status: integrations.status,
        companyId: integrations.companyId,
        capabilities: integrations.capabilities,
      })
      .from(integrationExternalReferences)
      .innerJoin(integrations, eq(integrations.id, integrationExternalReferences.integrationId))
      .where(
        and(
          eq(integrationExternalReferences.entityType, entityType),
          eq(integrationExternalReferences.internalId, internalId),
          eq(integrations.organizationId, actor.organizationId),
          eq(integrations.companyId, companyId),
          isNull(integrations.deletedAt),
        ),
      );
    const references: RecordReferenceView[] = rows.map((r) => ({
      id: r.ref.id,
      integrationId: r.ref.integrationId,
      integrationName: r.integrationName,
      provider: r.provider,
      providerName: this.providerName(r.provider),
      integrationStatus: r.status,
      entityType: r.ref.entityType,
      externalId: r.ref.externalId,
      direction: typeof r.ref.metadata.pushedAt === 'string' ? 'OUTBOUND' : 'INBOUND',
      canPush: this.pushes(r.provider, entityType, r.capabilities as ConnectorCapability[]),
      metadata: r.ref.metadata,
      lastSeenAt: r.ref.lastSeenAt,
      createdAt: r.ref.createdAt,
    }));
    const linked = new Set(references.map((r) => r.integrationId));
    const candidates = await this.db
      .select({
        id: integrations.id,
        name: integrations.name,
        provider: integrations.provider,
        capabilities: integrations.capabilities,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.organizationId, actor.organizationId),
          eq(integrations.companyId, companyId),
          isNull(integrations.deletedAt),
          inArray(integrations.status, ['CONNECTED', 'SYNCING']),
        ),
      );
    const pushTargets = candidates
      .filter(
        (c) =>
          !linked.has(c.id) &&
          this.pushes(c.provider, entityType, c.capabilities as ConnectorCapability[]),
      )
      .map((c) => ({
        integrationId: c.id,
        integrationName: c.name,
        provider: c.provider,
        providerName: this.providerName(c.provider),
      }));
    return { references, pushTargets };
  }

  /** Sends exactly one record now; the outcome is returned rather than tracked as a job. */
  async pushRecord(
    actor: AuthenticatedUser,
    organizationId: string,
    integrationId: string,
    entity: SyncEntity,
    internalId: string,
  ): Promise<PushRecordResult> {
    const integration = await this.integrations.getRow(organizationId, integrationId);
    const connector = this.integrations.connector(integration.provider);
    if (!connector.descriptor.capabilities.includes('PUSH') || !connector.push)
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `${connector.descriptor.name} does not support pushing records.`,
      );
    if (!connector.descriptor.entities.includes(entity))
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${connector.descriptor.name} does not handle ${entity}.`,
      );
    if (integration.status === 'DISABLED' || integration.status === 'DISCONNECTED')
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `The integration is ${integration.status.toLowerCase()}; connect it first.`,
      );
    const exporter = this.exporters.get(entity);
    if (!exporter)
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, `No exporter for ${entity}.`);

    const principal = await this.principals.build(integration);
    const ctx = await this.integrations.context(integration);
    const started = Date.now();
    const companyId = integration.companyId ?? principal.companyId ?? '';
    const exportCtx = {
      integration,
      principal,
      companyId,
      provider: integration.provider,
      correlationId: ctx.correlationId,
    };
    const record = await exporter.byId(exportCtx, internalId);
    if (!record)
      throw new NotFoundError(
        `${entity} record that can be pushed (drafts are never sent)`,
        internalId,
      );

    let answer: { externalId: string | null; metadata?: Record<string, unknown> } | null = null;
    const single: Exporter = {
      entity,
      byId: exporter.byId.bind(exporter),
      select: async (_ctx, query) =>
        query.after ? { records: [], hasMore: false } : { records: [record], hasMore: false },
    };
    let failure: { code: string; message: string } | null = null;
    let updated = false;
    try {
      const result = await RequestContext.run(
        {
          correlationId: ctx.correlationId,
          userId: principal.id,
          userEmail: principal.email,
          organizationId,
          companyId,
        },
        () =>
          pushEntity({
            connector,
            ctx,
            integration,
            principal,
            entity,
            mode: 'FULL',
            startCursor: null,
            batchSize: 1,
            exporter: single,
            map: async (r: ExportRecord) => {
              const m = await this.mappings.apply(
                integration.id,
                integration.provider,
                entity,
                r.data,
                {},
                this.db,
                'OUTBOUND',
              );
              return { output: m.output, errors: m.errors };
            },
            existing: async (ids) => {
              const rows = await this.refs.findByInternalIds(integration.id, entity, ids);
              return new Map(
                rows.map((r) => [
                  r.internalId,
                  {
                    externalId: r.externalId,
                    pushedAt: typeof r.metadata.pushedAt === 'string' ? r.metadata.pushedAt : null,
                  },
                ]),
              );
            },
            link: async (r, a) => {
              answer = { externalId: a.externalId, metadata: a.metadata };
              await this.db.transaction((tx) =>
                this.refs.linkByInternal(tx, {
                  integrationId: integration.id,
                  provider: integration.provider,
                  entityType: entity,
                  externalId: a.externalId ?? `internal:${r.internalId}`,
                  internalId: r.internalId,
                  metadata: {
                    ...a.metadata,
                    label: r.label,
                    pushedAt: new Date().toISOString(),
                    pushedBy: actor.email,
                  },
                }),
              );
            },
            checkpoint: async () => undefined,
            cancelled: async () => false,
          }),
      );
      const first = result.counters.failures[0];
      if (first) failure = { code: first.code, message: first.message };
      updated = result.counters.updated > 0;
    } catch (err) {
      // Transport / auth failures surface like any provider error; nothing was linked.
      const ie = IntegrationError.from(err);
      failure = { code: ie.code, message: ie.message };
    }
    const outcome: PushRecordResult['outcome'] = failure
      ? 'FAILED'
      : updated
        ? 'UPDATED'
        : 'CREATED';
    const external = answer as { externalId: string | null } | null;
    await this.logs.record({
      organizationId,
      integrationId: integration.id,
      direction: 'OUTBOUND',
      operation: `push-record:${entity}`,
      status: failure ? 'FAILURE' : 'SUCCESS',
      errorCode: failure?.code ?? null,
      durationMs: Date.now() - started,
      message: failure
        ? `${record.label}: ${failure.message}`
        : `${record.label} sent (${external?.externalId ?? 'no provider id'})`,
      metadata: { internalId, label: record.label, actor: actor.email },
    });
    await this.audit.record({
      action: failure ? 'SYNC_FAIL' : 'SYNC_COMPLETE',
      module: MODULE,
      entityType: 'IntegrationExternalReference',
      entityId: internalId,
      newValue: {
        integrationId: integration.id,
        entity,
        outcome,
        externalId: external?.externalId ?? null,
        error: failure?.message ?? null,
      },
      companyId,
      organizationId,
      userId: actor.id,
      userEmail: actor.email,
    });
    return {
      integrationId: integration.id,
      entity,
      internalId,
      outcome,
      externalId: external?.externalId ?? null,
      error: failure ? { code: failure.code, message: failure.message } : null,
    };
  }

  private pushes(provider: string, entity: SyncEntity, capabilities: ConnectorCapability[]) {
    if (!capabilities.includes('PUSH') || !this.registry.has(provider)) return false;
    const connector = this.registry.get(provider);
    return Boolean(connector.push) && connector.descriptor.entities.includes(entity);
  }

  private providerName(provider: string): string {
    return this.registry.has(provider) ? this.registry.get(provider).descriptor.name : provider;
  }
}
