import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { parseExpression } from 'cron-parser';
import type {
  IntegrationDirection,
  PaginatedResult,
  SyncEntity,
  SyncTrigger,
} from '@accounting/types';
import type { ListSyncJobsQuery, TriggerSyncInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { RequestContext } from '@/common/context/request-context';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  integrationSyncCursors,
  integrationSyncJobs,
  integrations,
  type Integration,
  type IntegrationSyncJob,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { IntegrationError } from '../core/integration-error';
import { IntegrationPrincipalService } from '../core/integration-principal.service';
import { CredentialsService } from '../core/credentials.service';
import { IntegrationsService } from '../core/integrations.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { ExternalReferencesService } from '../mapping/external-references.service';
import { MappingsService } from '../mapping/mappings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { decideRetry } from '../retries/retry-policy';
import { BankTransactionsImporter } from './importers/bank-transactions.importer';
import { BillsImporter } from './importers/bills.importer';
import { ProductsImporter } from './importers/products.importer';
import { VendorsImporter } from './importers/vendors.importer';
import { CustomersImporter } from './importers/customers.importer';
import type { Importer } from './importers/importer';
import { InvoicesImporter } from './importers/invoices.importer';
import { PaymentsImporter } from './importers/payments.importer';
import { SalesOrdersImporter } from './importers/sales-orders.importer';
import { PurchaseOrdersImporter } from './importers/purchase-orders.importer';
import { BillsExporter, InvoicesExporter } from './exporters/documents.exporter';
import { EXPORT_BATCH_SIZE, type Exporter } from './exporters/exporter';
import { CustomersExporter, ProductsExporter, VendorsExporter } from './exporters/parties.exporter';
import { pushEntity } from './push-engine';
import { syncEntity, type EntitySyncResult, type SyncCounters } from './sync-engine';

const MODULE = 'INTEGRATIONS';
const JOB_RUN = 'run-sync';
const JOB_DUE = 'sync-due';
const BATCH_SIZE = 100;
const MAX_AUTO_RETRIES = 3;

/**
 * Synchronisation engine: creates sync job rows, runs them on the
 * `integration-sync` queue (pull -> map -> import per entity, checkpointed
 * per batch), keeps per-entity cursors for incremental runs and schedules
 * cron-driven syncs. Failures are classified; retryable ones are re-queued
 * with backoff as new RETRY jobs so every attempt is visible. OUTBOUND jobs
 * run the mirror loop (export -> map -> push, see push-engine.ts) with the
 * same job rows, cursors, retries and audit trail.
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly importers: Map<SyncEntity, Importer>;
  private readonly exporters: Map<SyncEntity, Exporter>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrations: IntegrationsService,
    private readonly principals: IntegrationPrincipalService,
    private readonly mappings: MappingsService,
    private readonly jobs: JobRunnerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly logs: IntegrationLogsService,
    private readonly credentials: CredentialsService,
    private readonly refs: ExternalReferencesService,
    private readonly logger: PinoLogger,
    customers: CustomersImporter,
    invoices: InvoicesImporter,
    payments: PaymentsImporter,
    bankTransactions: BankTransactionsImporter,
    vendors: VendorsImporter,
    bills: BillsImporter,
    products: ProductsImporter,
    salesOrders: SalesOrdersImporter,
    customersOut: CustomersExporter,
    vendorsOut: VendorsExporter,
    productsOut: ProductsExporter,
    invoicesOut: InvoicesExporter,
    billsOut: BillsExporter,
    purchaseOrders: PurchaseOrdersImporter,
  ) {
    this.logger.setContext(SyncService.name);
    this.importers = new Map<SyncEntity, Importer>(
      [
        customers,
        invoices,
        payments,
        bankTransactions,
        vendors,
        bills,
        products,
        salesOrders,
        purchaseOrders,
      ].map((i) => [i.entity, i]),
    );
    this.exporters = new Map<SyncEntity, Exporter>(
      [customersOut, vendorsOut, productsOut, invoicesOut, billsOut].map((e) => [e.entity, e]),
    );
  }

  onModuleInit(): void {
    this.jobs.register<{ jobId: string }>(
      QUEUES.INTEGRATION_SYNC,
      JOB_RUN,
      ({ jobId }) => this.run(jobId),
      2,
    );
    this.jobs.register(QUEUES.INTEGRATION_MAINTENANCE, JOB_DUE, () => this.runDue());
    void this.jobs.schedule(QUEUES.INTEGRATION_MAINTENANCE, JOB_DUE, { every: 60_000 });
  }

  // ----------------------------------------------------------------- queries

  async list(
    organizationId: string,
    integrationId: string,
    query: ListSyncJobsQuery,
  ): Promise<PaginatedResult<IntegrationSyncJob>> {
    await this.integrations.getRow(organizationId, integrationId);
    const filters: SQL[] = [eq(integrationSyncJobs.integrationId, integrationId)];
    if (query.status) filters.push(eq(integrationSyncJobs.status, query.status));
    if (query.entity) filters.push(eq(integrationSyncJobs.entity, query.entity));
    if (query.direction) filters.push(eq(integrationSyncJobs.direction, query.direction));
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(integrationSyncJobs)
        .where(where)
        .orderBy(desc(integrationSyncJobs.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, integrationSyncJobs, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  async get(organizationId: string, jobId: string): Promise<IntegrationSyncJob> {
    const [row] = await this.db
      .select()
      .from(integrationSyncJobs)
      .where(
        and(
          eq(integrationSyncJobs.id, jobId),
          eq(integrationSyncJobs.organizationId, organizationId),
        ),
      );
    if (!row) throw new NotFoundError('Sync job', jobId);
    return row;
  }

  async cursors(integrationId: string) {
    return this.db
      .select()
      .from(integrationSyncCursors)
      .where(eq(integrationSyncCursors.integrationId, integrationId));
  }

  // ----------------------------------------------------------------- trigger

  async trigger(
    actor: AuthenticatedUser | null,
    organizationId: string,
    integrationId: string,
    input: TriggerSyncInput,
    trigger: SyncTrigger = 'MANUAL',
    direction: IntegrationDirection = 'INBOUND',
  ): Promise<IntegrationSyncJob> {
    const integration = await this.integrations.getRow(organizationId, integrationId);
    const connector = this.integrations.connector(integration.provider);
    if (direction === 'INBOUND' && !connector.descriptor.capabilities.includes('PULL'))
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `${connector.descriptor.name} does not support pull synchronisation.`,
      );
    if (
      direction === 'OUTBOUND' &&
      (!connector.descriptor.capabilities.includes('PUSH') || !connector.push)
    )
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `${connector.descriptor.name} does not support pushing records.`,
      );
    if (integration.status === 'DISABLED' || integration.status === 'DISCONNECTED')
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `The integration is ${integration.status.toLowerCase()}; connect it first.`,
      );
    if (input.entity && !connector.descriptor.entities.includes(input.entity))
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${connector.descriptor.name} does not sync ${input.entity}.`,
      );
    const [active] = await this.db
      .select({ id: integrationSyncJobs.id })
      .from(integrationSyncJobs)
      .where(
        and(
          eq(integrationSyncJobs.integrationId, integrationId),
          inArray(integrationSyncJobs.status, ['QUEUED', 'RUNNING']),
        ),
      );
    if (active)
      throw new BusinessRuleError(
        ErrorCodes.SYNC_IN_PROGRESS,
        'A sync is already queued or running for this integration.',
        { jobId: active.id },
      );

    let startCursor: string | null = null;
    let resumedFromJobId: string | null = null;
    if (input.resumeJobId) {
      const previous = await this.get(organizationId, input.resumeJobId);
      if (!['FAILED', 'PAUSED', 'CANCELLED'].includes(previous.status))
        throw new BusinessRuleError(
          ErrorCodes.INTEGRATION_INVALID_STATE,
          `Only failed, paused or cancelled jobs can be resumed (job is ${previous.status}).`,
        );
      if (previous.direction !== direction)
        throw new BusinessRuleError(
          ErrorCodes.INTEGRATION_INVALID_STATE,
          `Job ${previous.id} is ${previous.direction.toLowerCase()}; it cannot resume a ${direction.toLowerCase()} run.`,
        );
      startCursor = previous.lastCursor;
      resumedFromJobId = previous.id;
      trigger = trigger === 'MANUAL' ? 'RESUME' : trigger;
    }

    const job = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrationSyncJobs)
        .values({
          organizationId,
          integrationId,
          entity: input.entity ?? null,
          direction,
          mode: input.mode,
          trigger,
          status: 'QUEUED',
          requestedBy: actor?.id ?? null,
          resumedFromJobId,
          startCursor,
        })
        .returning();
      await this.audit.record(
        {
          action: 'SYNC_START',
          module: MODULE,
          entityType: 'IntegrationSyncJob',
          entityId: row!.id,
          newValue: {
            integrationId,
            entity: input.entity ?? 'ALL',
            direction,
            mode: input.mode,
            trigger,
          },
          companyId: integration.companyId,
          organizationId,
          userId: actor?.id ?? null,
          userEmail: actor?.email ?? null,
        },
        tx,
      );
      return row!;
    });
    const queueJobId = await this.jobs.enqueue(QUEUES.INTEGRATION_SYNC, JOB_RUN, { jobId: job.id });
    if (queueJobId)
      await this.db
        .update(integrationSyncJobs)
        .set({ queueJobId })
        .where(eq(integrationSyncJobs.id, job.id));
    return this.get(organizationId, job.id);
  }

  async cancel(
    actor: AuthenticatedUser,
    organizationId: string,
    jobId: string,
  ): Promise<IntegrationSyncJob> {
    const job = await this.get(organizationId, jobId);
    if (job.status === 'QUEUED') {
      await this.db
        .update(integrationSyncJobs)
        .set({ status: 'CANCELLED', finishedAt: new Date() })
        .where(eq(integrationSyncJobs.id, jobId));
    } else if (job.status === 'RUNNING') {
      // Cooperative: the engine checks between batches and stops at the next checkpoint.
      await this.db
        .update(integrationSyncJobs)
        .set({ status: 'PAUSED' })
        .where(eq(integrationSyncJobs.id, jobId));
    } else {
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `Job is ${job.status.toLowerCase()}.`,
      );
    }
    await this.audit.record({
      action: 'CANCEL',
      module: MODULE,
      entityType: 'IntegrationSyncJob',
      entityId: jobId,
      metadata: { actor: actor.email },
    });
    return this.get(organizationId, jobId);
  }

  /** Test / diagnostics helper: waits for inline jobs. */
  async drain(): Promise<void> {
    await this.jobs.drain();
  }

  // --------------------------------------------------------------------- run

  async run(jobId: string): Promise<void> {
    const [job] = await this.db
      .select()
      .from(integrationSyncJobs)
      .where(eq(integrationSyncJobs.id, jobId));
    if (!job || job.status !== 'QUEUED') return; // idempotent under redelivery
    const [integration] = await this.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, job.integrationId));
    if (!integration) return;
    const started = new Date();
    await this.db
      .update(integrationSyncJobs)
      .set({ status: 'RUNNING', startedAt: started })
      .where(eq(integrationSyncJobs.id, jobId));
    await this.db
      .update(integrations)
      .set({ status: 'SYNCING' })
      .where(eq(integrations.id, integration.id));

    const totals: SyncCounters = {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };
    let lastCursor = job.startCursor;
    let nextCursor: string | null = null;
    let cancelled = false;
    try {
      const principal = await this.principals.build(integration);
      const connector = this.integrations.connector(integration.provider);
      const ctx = await this.integrations.context(integration);
      const entities = job.entity ? [job.entity as SyncEntity] : [...connector.descriptor.entities];
      await RequestContext.run(
        {
          correlationId: ctx.correlationId,
          userId: principal.id,
          userEmail: principal.email,
          organizationId: integration.organizationId,
          companyId: integration.companyId ?? undefined,
        },
        async () => {
          for (const entity of entities) {
            const stored =
              job.mode === 'FULL'
                ? null
                : await this.cursorFor(integration.id, entity, job.direction);
            const startCursor = job.startCursor ?? stored;
            const shared = {
              connector,
              ctx,
              integration,
              principal,
              entity,
              mode: job.mode,
              startCursor,
              checkpoint: async (cursor: string | null, counters: SyncCounters) => {
                await this.db
                  .update(integrationSyncJobs)
                  .set({
                    lastCursor: cursor,
                    recordsProcessed: totals.processed + counters.processed,
                    recordsCreated: totals.created + counters.created,
                    recordsUpdated: totals.updated + counters.updated,
                    recordsSkipped: totals.skipped + counters.skipped,
                    recordsFailed: totals.failed + counters.failed,
                  })
                  .where(eq(integrationSyncJobs.id, jobId));
                await this.saveCursor(integration.id, entity, job.direction, cursor);
              },
              cancelled: async () => {
                const [current] = await this.db
                  .select({ status: integrationSyncJobs.status })
                  .from(integrationSyncJobs)
                  .where(eq(integrationSyncJobs.id, jobId));
                return current?.status === 'PAUSED';
              },
            };
            let result: EntitySyncResult;
            if (job.direction === 'OUTBOUND') {
              const exporter = this.exporters.get(entity);
              if (!exporter) {
                totals.failures.push({
                  externalId: null,
                  code: 'MAPPING_ERROR',
                  message: `No exporter for ${entity}`,
                });
                continue;
              }
              result = await pushEntity({
                ...shared,
                batchSize: EXPORT_BATCH_SIZE,
                exporter,
                map: async (record) => {
                  const r = await this.mappings.apply(
                    integration.id,
                    integration.provider,
                    entity,
                    record.data,
                    {},
                    this.db,
                    'OUTBOUND',
                  );
                  return { output: r.output, errors: r.errors };
                },
                existing: async (ids) => {
                  const rows = await this.refs.findByInternalIds(integration.id, entity, ids);
                  return new Map(
                    rows.map((r) => [
                      r.internalId,
                      {
                        externalId: r.externalId,
                        pushedAt:
                          typeof r.metadata.pushedAt === 'string' ? r.metadata.pushedAt : null,
                      },
                    ]),
                  );
                },
                link: async (record, answer) => {
                  await this.db.transaction((tx) =>
                    this.refs.linkByInternal(tx, {
                      integrationId: integration.id,
                      provider: integration.provider,
                      entityType: entity,
                      externalId: answer.externalId ?? `internal:${record.internalId}`,
                      internalId: record.internalId,
                      metadata: {
                        ...answer.metadata,
                        label: record.label,
                        pushedAt: new Date().toISOString(),
                        jobId,
                      },
                    }),
                  );
                },
              });
            } else {
              const importer = this.importers.get(entity);
              if (!importer) {
                totals.failures.push({
                  externalId: null,
                  code: 'MAPPING_ERROR',
                  message: `No importer for ${entity}`,
                });
                continue;
              }
              result = await syncEntity({
                ...shared,
                batchSize: BATCH_SIZE,
                importer,
                map: async (record) => {
                  const r = await this.mappings.apply(
                    integration.id,
                    integration.provider,
                    entity,
                    record.data,
                  );
                  return { output: r.output, errors: r.errors };
                },
              });
            }
            for (const k of ['processed', 'created', 'updated', 'skipped', 'failed'] as const)
              totals[k] += result.counters[k];
            totals.failures.push(
              ...result.counters.failures.slice(0, 100 - totals.failures.length),
            );
            lastCursor = result.lastCursor;
            nextCursor = result.nextCursor;
            if (result.cancelled) {
              cancelled = true;
              break;
            }
          }
        },
      );
      const finished = new Date();
      await this.db.transaction(async (tx) => {
        await tx
          .update(integrationSyncJobs)
          .set({
            status: cancelled ? 'PAUSED' : 'COMPLETED',
            finishedAt: finished,
            durationMs: finished.getTime() - started.getTime(),
            recordsProcessed: totals.processed,
            recordsCreated: totals.created,
            recordsUpdated: totals.updated,
            recordsSkipped: totals.skipped,
            recordsFailed: totals.failed,
            failures: totals.failures,
            lastCursor,
            nextCursor,
          })
          .where(eq(integrationSyncJobs.id, jobId));
        await tx
          .update(integrations)
          .set({
            status: 'CONNECTED',
            lastSyncAt: finished,
            lastSuccessAt: finished,
            failureCount: 0,
            lastError: null,
            nextSyncAt: this.nextRun(integration.syncSchedule, finished),
          })
          .where(eq(integrations.id, integration.id));
        await this.audit.record(
          {
            action: 'SYNC_COMPLETE',
            module: MODULE,
            entityType: 'IntegrationSyncJob',
            entityId: jobId,
            newValue: {
              status: cancelled ? 'PAUSED' : 'COMPLETED',
              ...totals,
              failures: undefined,
            },
            companyId: integration.companyId,
            organizationId: integration.organizationId,
            userId: job.requestedBy,
          },
          tx,
        );
      });
      await this.logs.record({
        organizationId: integration.organizationId,
        integrationId: integration.id,
        direction: job.direction,
        operation: `${job.direction === 'OUTBOUND' ? 'push' : 'sync'}:${job.entity ?? 'all'}`,
        status: 'SUCCESS',
        durationMs: finished.getTime() - started.getTime(),
        message: `${totals.processed} processed, ${totals.created} created, ${totals.updated} updated, ${totals.skipped} skipped, ${totals.failed} failed`,
        metadata: { jobId, mode: job.mode, trigger: job.trigger },
      });
    } catch (err) {
      await this.fail(job, integration, IntegrationError.from(err), started, totals, lastCursor);
    }
  }

  private async fail(
    job: IntegrationSyncJob,
    integration: Integration,
    error: IntegrationError,
    started: Date,
    totals: SyncCounters,
    lastCursor: string | null,
  ) {
    const finished = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(integrationSyncJobs)
        .set({
          status: 'FAILED',
          finishedAt: finished,
          durationMs: finished.getTime() - started.getTime(),
          errorCode: error.code,
          errorMessage: error.message.slice(0, 2000),
          recordsProcessed: totals.processed,
          recordsCreated: totals.created,
          recordsUpdated: totals.updated,
          recordsSkipped: totals.skipped,
          recordsFailed: totals.failed,
          failures: totals.failures,
          lastCursor,
        })
        .where(eq(integrationSyncJobs.id, job.id));
      await this.audit.record(
        {
          action: 'SYNC_FAIL',
          module: MODULE,
          entityType: 'IntegrationSyncJob',
          entityId: job.id,
          newValue: {
            errorCode: error.code,
            message: error.message.slice(0, 500),
            processed: totals.processed,
          },
          companyId: integration.companyId,
          organizationId: integration.organizationId,
          userId: job.requestedBy,
        },
        tx,
      );
    });
    await this.integrations.recordFailure(
      integration,
      `${job.direction === 'OUTBOUND' ? 'push' : 'sync'}:${job.entity ?? 'all'}`,
      error,
      finished.getTime() - started.getTime(),
      'ERROR',
    );
    await this.notifications.notify({
      organizationId: integration.organizationId,
      eventType: 'SYNC_FAILED',
      severity: 'ERROR',
      title: `${job.direction === 'OUTBOUND' ? 'Push' : 'Sync'} failed for "${integration.name}"`,
      body: `${error.code}: ${error.message}`,
      link: `/admin/integrations/${integration.id}`,
      entityType: 'IntegrationSyncJob',
      entityId: job.id,
      permission: 'integration.manage',
      companyId: integration.companyId,
      dedupeKey: `sync-failed:${integration.id}`,
    });
    // Automatic retry with backoff for transient failures; each attempt is its own job row.
    const attempt = await this.attemptNumber(job);
    const decision = decideRetry(
      error.code,
      attempt,
      { maxAttempts: MAX_AUTO_RETRIES },
      error.options.retryAfterMs,
    );
    if (decision.retry) {
      if (decision.refreshCredentials) await this.refreshCredentials(integration);
      const [retry] = await this.db
        .insert(integrationSyncJobs)
        .values({
          organizationId: job.organizationId,
          integrationId: job.integrationId,
          entity: job.entity,
          direction: job.direction,
          mode: job.mode,
          trigger: 'RETRY',
          status: 'QUEUED',
          requestedBy: job.requestedBy,
          resumedFromJobId: job.id,
          startCursor: lastCursor,
        })
        .returning();
      await this.jobs.enqueue(
        QUEUES.INTEGRATION_SYNC,
        JOB_RUN,
        { jobId: retry!.id },
        { delay: decision.delayMs },
      );
      this.logger.info(
        {
          jobId: job.id,
          retryJobId: retry!.id,
          delayMs: decision.delayMs,
          reason: decision.reason,
        },
        'Sync retry scheduled',
      );
    }
  }

  private async attemptNumber(job: IntegrationSyncJob): Promise<number> {
    let attempt = 1;
    let current = job;
    while (current.resumedFromJobId && current.trigger === 'RETRY' && attempt < 10) {
      const [prev] = await this.db
        .select()
        .from(integrationSyncJobs)
        .where(eq(integrationSyncJobs.id, current.resumedFromJobId));
      if (!prev) break;
      attempt += 1;
      current = prev;
    }
    return attempt;
  }

  private async refreshCredentials(integration: Integration): Promise<void> {
    const connector = this.integrations.connector(integration.provider);
    if (!connector.refreshCredentials) return;
    try {
      const secrets = await connector.refreshCredentials(
        await this.integrations.context(integration),
      );
      if (secrets)
        await this.db.transaction((tx) => this.credentials.store(tx, integration.id, secrets));
    } catch (err) {
      this.logger.warn({ err, integrationId: integration.id }, 'Credential refresh failed');
    }
  }

  // ---------------------------------------------------------------- cursors

  private async cursorFor(
    integrationId: string,
    entity: string,
    direction: IntegrationDirection,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ cursor: integrationSyncCursors.cursor })
      .from(integrationSyncCursors)
      .where(
        and(
          eq(integrationSyncCursors.integrationId, integrationId),
          eq(integrationSyncCursors.entity, entity),
          eq(integrationSyncCursors.direction, direction),
        ),
      );
    return row?.cursor ?? null;
  }

  private async saveCursor(
    integrationId: string,
    entity: string,
    direction: IntegrationDirection,
    cursor: string | null,
  ): Promise<void> {
    await this.db
      .insert(integrationSyncCursors)
      .values({ integrationId, entity, direction, cursor, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: [
          integrationSyncCursors.integrationId,
          integrationSyncCursors.entity,
          integrationSyncCursors.direction,
        ],
        set: { cursor, lastSyncedAt: new Date() },
      });
  }

  // ------------------------------------------------------------- scheduling

  nextRun(schedule: string | null, from: Date): Date | null {
    if (!schedule) return null;
    try {
      return parseExpression(schedule, { currentDate: from }).next().toDate();
    } catch {
      return null;
    }
  }

  /** Every minute: start SCHEDULED syncs for integrations whose next run is due. */
  async runDue(): Promise<number> {
    const now = new Date();
    const due = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.status, 'CONNECTED'),
          isNull(integrations.deletedAt),
          sql`${integrations.syncSchedule} IS NOT NULL`,
          sql`(${integrations.nextSyncAt} IS NULL OR ${integrations.nextSyncAt} <= ${now})`,
        ),
      );
    let started = 0;
    for (const integration of due) {
      const next = this.nextRun(integration.syncSchedule, now);
      await this.db
        .update(integrations)
        .set({ nextSyncAt: next })
        .where(eq(integrations.id, integration.id));
      if (integration.nextSyncAt === null) continue; // first tick only computes the schedule
      try {
        // A schedule pulls when the connector can; push-only providers push instead.
        const capabilities = this.integrations.connector(integration.provider).descriptor
          .capabilities;
        const direction: IntegrationDirection = capabilities.includes('PULL')
          ? 'INBOUND'
          : 'OUTBOUND';
        await this.trigger(
          null,
          integration.organizationId,
          integration.id,
          { mode: 'INCREMENTAL' },
          'SCHEDULED',
          direction,
        );
        started += 1;
      } catch (err) {
        this.logger.warn({ err, integrationId: integration.id }, 'Scheduled sync not started');
      }
    }
    return started;
  }

  /** Integrations still marked SYNCING with no live job (crash recovery). */
  async recoverStale(): Promise<number> {
    const stale = await this.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.status, 'SYNCING'),
          lte(integrations.updatedAt, new Date(Date.now() - 6 * 3600 * 1000)),
        ),
      );
    for (const s of stale)
      await this.db
        .update(integrations)
        .set({ status: 'CONNECTED' })
        .where(eq(integrations.id, s.id));
    return stale.length;
  }
}
