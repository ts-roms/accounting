import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { RequestContext } from '@/common/context/request-context';
import { AppError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import { integrationEvents, type IntegrationEvent } from '@/database/schema';
import { QUEUES } from '@/modules/jobs/queue.service';
import type { InboundWebhookEvent } from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import { IntegrationPrincipalService } from '../core/integration-principal.service';
import { IntegrationsService } from '../core/integrations.service';
import { safeHeaders } from '../core/redaction';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { MappingsService } from '../mapping/mappings.service';
import { SyncService } from '../sync/sync.service';
import { BankTransactionsImporter } from '../sync/importers/bank-transactions.importer';
import { BillsImporter } from '../sync/importers/bills.importer';
import { ProductsImporter } from '../sync/importers/products.importer';
import { VendorsImporter } from '../sync/importers/vendors.importer';
import { CustomersImporter } from '../sync/importers/customers.importer';
import type { Importer } from '../sync/importers/importer';
import { InvoicesImporter } from '../sync/importers/invoices.importer';
import { PaymentsImporter } from '../sync/importers/payments.importer';

const JOB_PROCESS = 'process-inbound';

export interface InboundReceipt {
  accepted: boolean;
  eventId: string;
  duplicate: boolean;
}

/**
 * Inbound webhook pipeline:
 *   verify signature (connector) -> dedupe by provider event id
 *   -> persist INBOUND event -> queue -> connector.handleWebhook
 *   -> mapping -> importer -> domain service.
 *
 * The HTTP handler returns as soon as the event is stored; processing is
 * asynchronous and retried through the same job. A replayed request (same
 * event id) is acknowledged but never processed twice.
 */
@Injectable()
export class InboundWebhooksService implements OnModuleInit {
  private readonly importers: Map<string, Importer>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrations: IntegrationsService,
    private readonly principals: IntegrationPrincipalService,
    private readonly mappings: MappingsService,
    private readonly jobs: JobRunnerService,
    private readonly logs: IntegrationLogsService,
    private readonly sync: SyncService,
    private readonly logger: PinoLogger,
    customers: CustomersImporter,
    invoices: InvoicesImporter,
    payments: PaymentsImporter,
    bankTransactions: BankTransactionsImporter,
    vendors: VendorsImporter,
    bills: BillsImporter,
    products: ProductsImporter,
  ) {
    this.logger.setContext(InboundWebhooksService.name);
    this.importers = new Map(
      [customers, invoices, payments, bankTransactions, vendors, bills, products].map((i) => [
        i.entity,
        i,
      ]),
    );
  }

  onModuleInit(): void {
    this.jobs.register<{ eventId: string }>(
      QUEUES.WEBHOOK_INBOUND,
      JOB_PROCESS,
      ({ eventId }) => this.process(eventId),
      4,
    );
  }

  async receive(
    integrationId: string,
    headers: Record<string, string | undefined>,
    rawBody: string,
    body: unknown,
  ): Promise<InboundReceipt> {
    const started = Date.now();
    const integration = await this.integrations.findAnyById(integrationId);
    if (!integration) throw new NotFoundError('Integration', integrationId);
    const connector = this.integrations.connector(integration.provider);
    if (!connector.verifyWebhook || !connector.handleWebhook)
      throw new AppError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'This provider does not accept webhooks.',
        HttpStatus.NOT_FOUND,
      );
    if (integration.status === 'DISABLED')
      throw new AppError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'Integration is disabled.',
        HttpStatus.GONE,
      );

    const ctx = await this.integrations.context(integration);
    const verification = await connector.verifyWebhook(ctx, { headers, rawBody, body });
    if (!verification.ok || !verification.event) {
      await this.logs.record({
        organizationId: integration.organizationId,
        integrationId: integration.id,
        direction: 'INBOUND',
        operation: 'webhook.receive',
        status: 'FAILURE',
        httpStatus: 401,
        errorCode: 'AUTHENTICATION_ERROR',
        durationMs: Date.now() - started,
        message: `Signature rejected: ${verification.reason ?? 'unknown'}`,
        metadata: { headers: safeHeaders(headers) },
      });
      throw new AppError(
        ErrorCodes.WEBHOOK_SIGNATURE_INVALID,
        'Webhook signature is invalid.',
        HttpStatus.UNAUTHORIZED,
        {
          reason: verification.reason ?? 'MISMATCH',
        },
      );
    }
    const event = verification.event;
    const [row] = await this.db
      .insert(integrationEvents)
      .values({
        organizationId: integration.organizationId,
        companyId: integration.companyId,
        integrationId: integration.id,
        direction: 'INBOUND',
        eventType: event.eventType,
        externalEventId: event.eventId,
        payload: event.payload,
        status: 'PENDING',
        correlationId: RequestContext.get()?.correlationId ?? null,
        occurredAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
      })
      .onConflictDoNothing({
        target: [integrationEvents.integrationId, integrationEvents.externalEventId],
        where: sql`${integrationEvents.externalEventId} IS NOT NULL`,
      })
      .returning();
    if (!row) {
      const [existing] = await this.db
        .select({ id: integrationEvents.id })
        .from(integrationEvents)
        .where(
          and(
            eq(integrationEvents.integrationId, integration.id),
            eq(integrationEvents.externalEventId, event.eventId),
          ),
        );
      await this.logs.record({
        organizationId: integration.organizationId,
        integrationId: integration.id,
        direction: 'INBOUND',
        operation: `webhook.${event.eventType}`,
        status: 'SKIPPED',
        externalEventId: event.eventId,
        durationMs: Date.now() - started,
        message: 'Duplicate event id (replay ignored)',
      });
      return { accepted: true, eventId: existing?.id ?? '', duplicate: true };
    }
    await this.logs.record({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      direction: 'INBOUND',
      operation: `webhook.${event.eventType}`,
      status: 'SUCCESS',
      externalEventId: event.eventId,
      httpStatus: 202,
      durationMs: Date.now() - started,
      message: 'Accepted',
    });
    await this.jobs.enqueue(
      QUEUES.WEBHOOK_INBOUND,
      JOB_PROCESS,
      { eventId: row.id },
      { attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
    );
    return { accepted: true, eventId: row.id, duplicate: false };
  }

  /** Worker: hand the event to the connector, then run its imports through mapping + importers. */
  async process(eventId: string): Promise<void> {
    const [event] = await this.db
      .select()
      .from(integrationEvents)
      .where(eq(integrationEvents.id, eventId));
    if (!event || !event.integrationId || (event.status !== 'PENDING' && event.status !== 'FAILED'))
      return;
    const integration = await this.integrations.findAnyById(event.integrationId);
    if (!integration) return;
    await this.db
      .update(integrationEvents)
      .set({ status: 'PROCESSING' })
      .where(eq(integrationEvents.id, eventId));
    const started = Date.now();
    try {
      const connector = this.integrations.connector(integration.provider);
      const ctx = await this.integrations.context(integration);
      const principal = await this.principals.build(integration);
      const webhookEvent: InboundWebhookEvent = {
        eventId: event.externalEventId ?? event.id,
        eventType: event.eventType,
        occurredAt: event.occurredAt.toISOString(),
        payload: event.payload,
      };
      const handling = await connector.handleWebhook!(ctx, webhookEvent);
      const outcomes: string[] = [];
      await RequestContext.run(
        {
          correlationId: event.correlationId ?? ctx.correlationId,
          userId: principal.id,
          userEmail: principal.email,
          organizationId: integration.organizationId,
          companyId: integration.companyId ?? undefined,
        },
        async () => {
          for (const item of handling.imports) {
            const importer = this.importers.get(item.entity);
            if (!importer)
              throw new IntegrationError('MAPPING_ERROR', `No importer for ${item.entity}`);
            const mapped = await this.mappings.apply(
              integration.id,
              integration.provider,
              item.entity,
              item.record.data,
            );
            if (mapped.errors.length)
              throw new IntegrationError(
                'MAPPING_ERROR',
                mapped.errors.map((e) => `${e.target}: ${e.message}`).join('; '),
                { details: { errors: mapped.errors } },
              );
            const outcome = await importer.import(
              {
                integration,
                principal,
                companyId: integration.companyId ?? principal.companyId ?? '',
                provider: integration.provider,
                correlationId: ctx.correlationId,
              },
              item.record,
              mapped.output,
            );
            outcomes.push(
              `${item.entity}:${outcome.action}${outcome.documentNumber ? ` ${outcome.documentNumber}` : ''}`,
            );
          }
          for (const entity of handling.syncEntities ?? []) {
            await this.sync
              .trigger(
                null,
                integration.organizationId,
                integration.id,
                { entity, mode: 'INCREMENTAL' },
                'WEBHOOK',
              )
              .catch((err: unknown) => {
                this.logger.warn(
                  { err, integrationId: integration.id, entity },
                  'Webhook-triggered sync not started',
                );
              });
          }
        },
      );
      await this.db
        .update(integrationEvents)
        .set({ status: 'PROCESSED', processedAt: new Date(), attempts: event.attempts + 1 })
        .where(eq(integrationEvents.id, eventId));
      await this.integrations.recordSuccess(integration.id);
      await this.logs.record({
        organizationId: integration.organizationId,
        integrationId: integration.id,
        direction: 'INBOUND',
        operation: `webhook.process.${event.eventType}`,
        status: 'SUCCESS',
        externalEventId: event.externalEventId,
        durationMs: Date.now() - started,
        message: outcomes.join(', ') || handling.note || 'processed',
      });
    } catch (err) {
      const ie = IntegrationError.from(err);
      await this.db
        .update(integrationEvents)
        .set({
          status: 'FAILED',
          lastError: `${ie.code}: ${ie.message}`.slice(0, 1000),
          attempts: event.attempts + 1,
        })
        .where(eq(integrationEvents.id, eventId));
      await this.integrations.recordFailure(
        integration,
        `webhook.process.${event.eventType}`,
        ie,
        Date.now() - started,
      );
      // Let the queue retry transient failures; permanent ones stay FAILED for a manual replay.
      if (['TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'RATE_LIMITED'].includes(ie.code))
        throw ie;
    }
  }

  /** Manual replay of a FAILED inbound event (the same idempotent path). */
  async replay(organizationId: string, eventId: string): Promise<IntegrationEvent> {
    const [event] = await this.db
      .select()
      .from(integrationEvents)
      .where(
        and(
          eq(integrationEvents.id, eventId),
          eq(integrationEvents.organizationId, organizationId),
          eq(integrationEvents.direction, 'INBOUND'),
        ),
      );
    if (!event) throw new NotFoundError('Inbound event', eventId);
    if (event.status !== 'FAILED' && event.status !== 'REJECTED')
      throw new AppError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `Event is ${event.status.toLowerCase()}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    await this.db
      .update(integrationEvents)
      .set({ status: 'PENDING' })
      .where(eq(integrationEvents.id, eventId));
    await this.jobs.enqueue(QUEUES.WEBHOOK_INBOUND, JOB_PROCESS, { eventId });
    const [updated] = await this.db
      .select()
      .from(integrationEvents)
      .where(eq(integrationEvents.id, eventId));
    return updated!;
  }

  async listEvents(
    organizationId: string,
    integrationId: string,
    limit = 50,
  ): Promise<IntegrationEvent[]> {
    return this.db
      .select()
      .from(integrationEvents)
      .where(
        and(
          eq(integrationEvents.organizationId, organizationId),
          eq(integrationEvents.integrationId, integrationId),
          eq(integrationEvents.direction, 'INBOUND'),
        ),
      )
      .orderBy(desc(integrationEvents.occurredAt))
      .limit(limit);
  }
}
