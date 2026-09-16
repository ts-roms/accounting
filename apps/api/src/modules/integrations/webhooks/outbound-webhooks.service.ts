import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { HEADERS } from '@accounting/config';
import type { PaginatedResult, WebhookDeliveryStatus } from '@accounting/types';
import type {
  CreateWebhookInput,
  ListWebhookDeliveriesQuery,
  ReplayWebhookInput,
  UpdateWebhookInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  integrationEvents,
  integrationWebhookDeliveries,
  integrationWebhooks,
  type IntegrationEvent,
  type IntegrationWebhook,
  type IntegrationWebhookDelivery,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { CredentialsService } from '../core/credentials.service';
import { IntegrationError } from '../core/integration-error';
import { OUTBOX_ENQUEUED_EVENT, OutboxService } from '../events/outbox.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { decideRetry, parseRetryAfter } from '../retries/retry-policy';
import { signPayload } from './webhook-signature';

const MODULE = 'INTEGRATIONS';
const JOB_DISPATCH = 'dispatch-outbox';
const JOB_DELIVER = 'deliver';
const JOB_RETRY_DUE = 'retry-due';

export interface WebhookView extends Omit<IntegrationWebhook, 'secretCiphertext'> {
  pendingDeliveries: number;
  exhaustedDeliveries: number;
}

export interface CreatedWebhook extends WebhookView {
  /** Shown once. */
  secret: string;
}

/**
 * Outbound webhooks. Outbox rows are fanned out to matching subscriptions as
 * delivery rows; each delivery is signed (HMAC-SHA256, timestamped), sent with
 * a timeout and retried with exponential backoff until `maxAttempts`, then
 * marked EXHAUSTED and surfaced as a notification. Nothing is ever dropped
 * silently: every state is a row.
 */
@Injectable()
export class OutboundWebhooksService implements OnModuleInit {
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly credentials: CredentialsService,
    private readonly jobs: JobRunnerService,
    private readonly audit: AuditService,
    private readonly logs: IntegrationLogsService,
    private readonly notifications: NotificationsService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboundWebhooksService.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.WEBHOOK_DELIVERY, JOB_DISPATCH, () => this.dispatchPending(), 1);
    this.jobs.register<{ deliveryId: string }>(
      QUEUES.WEBHOOK_DELIVERY,
      JOB_DELIVER,
      ({ deliveryId }) => this.deliver(deliveryId),
      4,
    );
    this.jobs.register(QUEUES.WEBHOOK_DELIVERY, JOB_RETRY_DUE, () => this.enqueueDueRetries(), 1);
    void this.jobs.schedule(
      QUEUES.WEBHOOK_DELIVERY,
      JOB_DISPATCH,
      { every: 30_000 },
      {},
      'Deliver pending outbox events to their webhook subscriptions',
    );
    void this.jobs.schedule(
      QUEUES.WEBHOOK_DELIVERY,
      JOB_RETRY_DUE,
      { every: 15_000 },
      {},
      'Retry webhook deliveries whose back-off has elapsed',
    );
  }

  /** Woken shortly after an outbox row commits; in queue mode this is debounced by the fixed job id. */
  @OnEvent(OUTBOX_ENQUEUED_EVENT)
  async onOutboxEnqueued(): Promise<void> {
    await this.jobs
      .enqueue(
        QUEUES.WEBHOOK_DELIVERY,
        JOB_DISPATCH,
        {},
        { jobId: 'dispatch-outbox-now', removeOnComplete: true },
      )
      .catch(() => undefined);
  }

  // ------------------------------------------------------------ subscriptions

  async list(organizationId: string): Promise<WebhookView[]> {
    const rows = await this.viewQuery()
      .where(eq(integrationWebhooks.organizationId, organizationId))
      .orderBy(desc(integrationWebhooks.createdAt));
    return rows;
  }

  async get(organizationId: string, id: string): Promise<WebhookView> {
    const [row] = await this.viewQuery().where(
      and(eq(integrationWebhooks.id, id), eq(integrationWebhooks.organizationId, organizationId)),
    );
    if (!row) throw new NotFoundError('Webhook', id);
    return row;
  }

  async create(actor: AuthenticatedUser, input: CreateWebhookInput): Promise<CreatedWebhook> {
    const secret = input.secret ?? `whsec_${randomBytes(24).toString('base64url')}`;
    const id = await this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: integrationWebhooks.id })
        .from(integrationWebhooks)
        .where(
          and(
            eq(integrationWebhooks.organizationId, actor.organizationId),
            eq(integrationWebhooks.name, input.name),
          ),
        );
      if (dup) throw new DuplicateError('Webhook', 'name', input.name);
      const [row] = await tx
        .insert(integrationWebhooks)
        .values({
          organizationId: actor.organizationId,
          companyId: input.companyId ?? null,
          integrationId: input.integrationId ?? null,
          name: input.name,
          description: input.description ?? null,
          url: input.url,
          events: input.events,
          secretCiphertext: this.credentials.cipher.encrypt(secret),
          maxAttempts: input.maxAttempts,
          createdBy: actor.id,
        })
        .returning({ id: integrationWebhooks.id });
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Webhook',
          entityId: row!.id,
          newValue: { name: input.name, url: input.url, events: input.events },
          companyId: input.companyId ?? null,
        },
        tx,
      );
      return row!.id;
    });
    return { ...(await this.get(actor.organizationId, id)), secret };
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateWebhookInput,
  ): Promise<WebhookView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(integrationWebhooks)
        .where(
          and(
            eq(integrationWebhooks.id, id),
            eq(integrationWebhooks.organizationId, actor.organizationId),
          ),
        )
        .for('update');
      if (!existing) throw new NotFoundError('Webhook', id);
      await tx
        .update(integrationWebhooks)
        .set({
          name: input.name ?? existing.name,
          url: input.url ?? existing.url,
          events: input.events ?? existing.events,
          description: input.description === undefined ? existing.description : input.description,
          status: input.status ?? existing.status,
          maxAttempts: input.maxAttempts ?? existing.maxAttempts,
          failureCount: input.status === 'ACTIVE' ? 0 : existing.failureCount,
          disabledReason:
            input.status === 'ACTIVE'
              ? null
              : input.status === 'DISABLED'
                ? 'Disabled by administrator'
                : existing.disabledReason,
        })
        .where(eq(integrationWebhooks.id, id));
      await this.audit.record(
        {
          action: input.status === 'DISABLED' ? 'DEACTIVATE' : 'UPDATE',
          module: MODULE,
          entityType: 'Webhook',
          entityId: id,
          previousValue: {
            name: existing.name,
            url: existing.url,
            status: existing.status,
            events: existing.events,
          },
          newValue: input,
          companyId: existing.companyId,
        },
        tx,
      );
    });
    return this.get(actor.organizationId, id);
  }

  async remove(actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(integrationWebhooks)
        .where(
          and(
            eq(integrationWebhooks.id, id),
            eq(integrationWebhooks.organizationId, actor.organizationId),
          ),
        )
        .returning();
      if (!rows[0]) throw new NotFoundError('Webhook', id);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Webhook',
          entityId: id,
          previousValue: { name: rows[0].name, url: rows[0].url },
          companyId: rows[0].companyId,
        },
        tx,
      );
    });
  }

  /** Rotates the signing secret; returns the new one once. */
  async rotateSecret(actor: AuthenticatedUser, id: string): Promise<{ secret: string }> {
    await this.get(actor.organizationId, id);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await this.db.transaction(async (tx) => {
      await tx
        .update(integrationWebhooks)
        .set({ secretCiphertext: this.credentials.cipher.encrypt(secret) })
        .where(eq(integrationWebhooks.id, id));
      await this.audit.record(
        {
          action: 'ROTATE',
          module: MODULE,
          entityType: 'Webhook',
          entityId: id,
          newValue: { secretRotated: true },
        },
        tx,
      );
    });
    return { secret };
  }

  /** Sends a `webhook.test` event through the normal pipeline. */
  async test(actor: AuthenticatedUser, id: string): Promise<IntegrationWebhookDelivery> {
    const webhook = await this.get(actor.organizationId, id);
    const event = await this.db.transaction((tx) =>
      this.outbox.enqueue(tx, {
        eventType: 'webhook.test',
        companyId: webhook.companyId,
        organizationId: webhook.organizationId,
        payload: { webhookId: id, triggeredBy: actor.email, at: new Date().toISOString() },
      }),
    );
    if (!event)
      throw new BusinessRuleError(ErrorCodes.INTEGRATION_ERROR, 'Could not create the test event.');
    const [delivery] = await this.db
      .insert(integrationWebhookDeliveries)
      .values({ webhookId: id, eventId: event.id, eventType: event.eventType, maxAttempts: 1 })
      .returning();
    await this.outbox.markProcessed(event.id);
    await this.deliver(delivery!.id);
    const [fresh] = await this.db
      .select()
      .from(integrationWebhookDeliveries)
      .where(eq(integrationWebhookDeliveries.id, delivery!.id));
    return fresh!;
  }

  // ---------------------------------------------------------------- deliveries

  async listDeliveries(
    organizationId: string,
    query: ListWebhookDeliveriesQuery,
  ): Promise<
    PaginatedResult<
      IntegrationWebhookDelivery & { webhookName: string; payload: Record<string, unknown> }
    >
  > {
    const filters: SQL[] = [eq(integrationWebhooks.organizationId, organizationId)];
    if (query.webhookId) filters.push(eq(integrationWebhookDeliveries.webhookId, query.webhookId));
    if (query.status) filters.push(eq(integrationWebhookDeliveries.status, query.status));
    if (query.eventType) filters.push(eq(integrationWebhookDeliveries.eventType, query.eventType));
    const where = and(...filters);
    const base = this.db
      .select({
        ...getTableColumns(integrationWebhookDeliveries),
        webhookName: integrationWebhooks.name,
        payload: integrationEvents.payload,
      })
      .from(integrationWebhookDeliveries)
      .innerJoin(
        integrationWebhooks,
        eq(integrationWebhooks.id, integrationWebhookDeliveries.webhookId),
      )
      .innerJoin(integrationEvents, eq(integrationEvents.id, integrationWebhookDeliveries.eventId))
      .where(where);
    const [items, [count]] = await Promise.all([
      base
        .orderBy(desc(integrationWebhookDeliveries.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(integrationWebhookDeliveries)
        .innerJoin(
          integrationWebhooks,
          eq(integrationWebhooks.id, integrationWebhookDeliveries.webhookId),
        )
        .where(where),
    ]);
    return toPaginatedResult(items, Number(count?.total ?? 0), query);
  }

  /** Re-queues failed / exhausted deliveries as fresh delivery rows (the originals stay as history). */
  async replay(
    actor: AuthenticatedUser,
    id: string,
    input: ReplayWebhookInput,
  ): Promise<{ replayed: number }> {
    const webhook = await this.get(actor.organizationId, id);
    const filters: SQL[] = [eq(integrationWebhookDeliveries.webhookId, id)];
    if (input.deliveryIds?.length)
      filters.push(inArray(integrationWebhookDeliveries.id, input.deliveryIds));
    else
      filters.push(
        inArray(integrationWebhookDeliveries.status, ['FAILED', 'EXHAUSTED', 'DISABLED']),
      );
    const originals = await this.db
      .select()
      .from(integrationWebhookDeliveries)
      .where(and(...filters));
    if (originals.length === 0) return { replayed: 0 };
    const created = await this.db
      .insert(integrationWebhookDeliveries)
      .values(
        originals.map((o) => ({
          webhookId: id,
          eventId: o.eventId,
          eventType: o.eventType,
          maxAttempts: webhook.maxAttempts,
          replayOfId: o.id,
        })),
      )
      .returning({ id: integrationWebhookDeliveries.id });
    await this.audit.record({
      action: 'UPDATE',
      module: MODULE,
      entityType: 'Webhook',
      entityId: id,
      newValue: { replayed: created.length },
      metadata: { actor: actor.email },
    });
    for (const d of created)
      await this.jobs.enqueue(QUEUES.WEBHOOK_DELIVERY, JOB_DELIVER, { deliveryId: d.id });
    return { replayed: created.length };
  }

  // ------------------------------------------------------------------ workers

  /** Fan out PENDING outbox events to matching ACTIVE subscriptions. */
  async dispatchPending(): Promise<number> {
    const events = await this.outbox.pending(200);
    let created = 0;
    for (const event of events) {
      try {
        const subs = await this.subscriptionsFor(event);
        if (subs.length) {
          const rows = await this.db
            .insert(integrationWebhookDeliveries)
            .values(
              subs.map((s) => ({
                webhookId: s.id,
                eventId: event.id,
                eventType: event.eventType,
                maxAttempts: s.maxAttempts,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: integrationWebhookDeliveries.id });
          created += rows.length;
          for (const r of rows)
            await this.jobs.enqueue(QUEUES.WEBHOOK_DELIVERY, JOB_DELIVER, { deliveryId: r.id });
        }
        await this.outbox.markProcessed(event.id);
      } catch (err) {
        await this.outbox.markFailed(
          event.id,
          err instanceof Error ? err.message : 'dispatch failed',
        );
        this.logger.error({ err, eventId: event.id }, 'Outbox dispatch failed');
      }
    }
    return created;
  }

  private async subscriptionsFor(
    event: IntegrationEvent,
    executor: DbExecutor = this.db,
  ): Promise<IntegrationWebhook[]> {
    return executor
      .select()
      .from(integrationWebhooks)
      .where(
        and(
          eq(integrationWebhooks.organizationId, event.organizationId),
          eq(integrationWebhooks.status, 'ACTIVE'),
          sql`${integrationWebhooks.events} @> ${JSON.stringify([event.eventType])}::jsonb`,
          event.companyId
            ? or(
                isNull(integrationWebhooks.companyId),
                eq(integrationWebhooks.companyId, event.companyId),
              )
            : isNull(integrationWebhooks.companyId),
        ),
      );
  }

  /** One attempt at one delivery; schedules the next attempt or exhausts. */
  async deliver(deliveryId: string): Promise<void> {
    const [delivery] = await this.db
      .select()
      .from(integrationWebhookDeliveries)
      .where(eq(integrationWebhookDeliveries.id, deliveryId));
    if (!delivery || !['PENDING', 'RETRYING'].includes(delivery.status)) return;
    if (delivery.nextAttemptAt && delivery.nextAttemptAt.getTime() > Date.now() + 1000) return; // not due yet
    const [webhook] = await this.db
      .select()
      .from(integrationWebhooks)
      .where(eq(integrationWebhooks.id, delivery.webhookId));
    const [event] = await this.db
      .select()
      .from(integrationEvents)
      .where(eq(integrationEvents.id, delivery.eventId));
    if (!webhook || !event) return;
    if (webhook.status !== 'ACTIVE') {
      await this.db
        .update(integrationWebhookDeliveries)
        .set({ status: 'DISABLED', lastError: 'Webhook disabled' })
        .where(eq(integrationWebhookDeliveries.id, deliveryId));
      return;
    }
    const attempt = delivery.attempts + 1;
    const body = JSON.stringify({
      id: event.id,
      type: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      companyId: event.companyId,
      data: event.payload,
      delivery: { id: delivery.id, attempt },
    });
    const ts = Math.floor(Date.now() / 1000);
    const secret = this.credentials.cipher.decrypt(webhook.secretCiphertext);
    const started = Date.now();
    let status: number | null = null;
    let error: IntegrationError | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.env.WEBHOOK_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'accounting-webhooks/1.0',
            [HEADERS.WEBHOOK_SIGNATURE]: signPayload(secret, body, ts),
            [HEADERS.WEBHOOK_EVENT_ID]: event.id,
            [HEADERS.WEBHOOK_EVENT_TYPE]: event.eventType,
            [HEADERS.WEBHOOK_DELIVERY_ID]: delivery.id,
          },
          body,
          signal: controller.signal,
        });
        status = res.status;
        if (!res.ok)
          error = IntegrationError.fromHttpStatus(
            res.status,
            undefined,
            parseRetryAfter(res.headers.get('retry-after')),
          );
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error = IntegrationError.from(err);
    }
    const durationMs = Date.now() - started;
    const now = new Date();
    if (!error) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(integrationWebhookDeliveries)
          .set({
            status: 'DELIVERED',
            attempts: attempt,
            lastAttemptAt: now,
            lastHttpStatus: status,
            responseTimeMs: durationMs,
            deliveredAt: now,
            nextAttemptAt: null,
            lastError: null,
          })
          .where(eq(integrationWebhookDeliveries.id, deliveryId));
        await tx
          .update(integrationWebhooks)
          .set({ lastDeliveryAt: now, lastSuccessAt: now, failureCount: 0 })
          .where(eq(integrationWebhooks.id, webhook.id));
      });
      await this.logs.record({
        organizationId: webhook.organizationId,
        integrationId: webhook.integrationId,
        direction: 'OUTBOUND',
        operation: `webhook.deliver.${event.eventType}`,
        status: 'SUCCESS',
        httpStatus: status,
        durationMs,
        requestId: delivery.id,
        metadata: { webhookId: webhook.id, attempt },
      });
      return;
    }
    const decision = decideRetry(
      error.code,
      attempt,
      { maxAttempts: delivery.maxAttempts, baseDelayMs: 2_000, maxDelayMs: 6 * 3600 * 1000 },
      error.options.retryAfterMs,
    );
    const nextStatus: WebhookDeliveryStatus = decision.retry ? 'RETRYING' : 'EXHAUSTED';
    const nextAttemptAt = decision.retry ? new Date(Date.now() + decision.delayMs) : null;
    await this.db.transaction(async (tx) => {
      await tx
        .update(integrationWebhookDeliveries)
        .set({
          status: nextStatus,
          attempts: attempt,
          lastAttemptAt: now,
          lastHttpStatus: status,
          responseTimeMs: durationMs,
          nextAttemptAt,
          lastError: `${error!.code}: ${error!.message}`.slice(0, 1000),
        })
        .where(eq(integrationWebhookDeliveries.id, deliveryId));
      await tx
        .update(integrationWebhooks)
        .set({ lastDeliveryAt: now, failureCount: sql`${integrationWebhooks.failureCount} + 1` })
        .where(eq(integrationWebhooks.id, webhook.id));
    });
    await this.logs.record({
      organizationId: webhook.organizationId,
      integrationId: webhook.integrationId,
      direction: 'OUTBOUND',
      operation: `webhook.deliver.${event.eventType}`,
      status: 'FAILURE',
      httpStatus: status,
      errorCode: error.code,
      durationMs,
      requestId: delivery.id,
      message: error.message,
      metadata: { webhookId: webhook.id, attempt, next: nextStatus, delayMs: decision.delayMs },
    });
    if (nextStatus === 'EXHAUSTED') {
      await this.notifications.notify({
        organizationId: webhook.organizationId,
        eventType: 'WEBHOOK_FAILING',
        severity: 'ERROR',
        title: `Webhook "${webhook.name}" exhausted its retries`,
        body: `${event.eventType}: ${error.message}`,
        link: '/admin/webhooks',
        entityType: 'Webhook',
        entityId: webhook.id,
        permission: 'webhook.manage',
        companyId: webhook.companyId,
        dedupeKey: `webhook-exhausted:${webhook.id}`,
      });
    } else if (decision.delayMs <= 60_000) {
      await this.jobs.enqueue(
        QUEUES.WEBHOOK_DELIVERY,
        JOB_DELIVER,
        { deliveryId },
        { delay: decision.delayMs },
      );
    }
    // Longer delays are picked up by the retry-due sweeper.
  }

  /** Sweeper: RETRYING deliveries whose time has come. */
  async enqueueDueRetries(): Promise<number> {
    const due = await this.db
      .select({ id: integrationWebhookDeliveries.id })
      .from(integrationWebhookDeliveries)
      .where(
        and(
          eq(integrationWebhookDeliveries.status, 'RETRYING'),
          lte(integrationWebhookDeliveries.nextAttemptAt, new Date()),
        ),
      )
      .limit(200);
    for (const d of due)
      await this.jobs.enqueue(QUEUES.WEBHOOK_DELIVERY, JOB_DELIVER, { deliveryId: d.id });
    return due.length;
  }

  /** Test helper: run the whole pipeline synchronously (inline mode). */
  async flush(): Promise<void> {
    await this.dispatchPending();
    await this.jobs.drain();
    await this.enqueueDueRetries();
    await this.jobs.drain();
  }

  async healthFor(webhookIds: string[]): Promise<{ exhausted24h: number; delivered24h: number }> {
    if (webhookIds.length === 0) return { exhausted24h: 0, delivered24h: 0 };
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [row] = await this.db
      .select({
        exhausted: sql<number>`count(*) filter (where ${integrationWebhookDeliveries.status} = 'EXHAUSTED')::int`,
        delivered: sql<number>`count(*) filter (where ${integrationWebhookDeliveries.status} = 'DELIVERED')::int`,
      })
      .from(integrationWebhookDeliveries)
      .where(
        and(
          inArray(integrationWebhookDeliveries.webhookId, webhookIds),
          sql`${integrationWebhookDeliveries.createdAt} >= ${since}`,
        ),
      );
    return { exhausted24h: Number(row?.exhausted ?? 0), delivered24h: Number(row?.delivered ?? 0) };
  }

  async webhookIdsForIntegration(integrationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: integrationWebhooks.id })
      .from(integrationWebhooks)
      .where(eq(integrationWebhooks.integrationId, integrationId));
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ helpers

  private viewQuery() {
    const { secretCiphertext: _s, ...columns } = getTableColumns(integrationWebhooks);
    return this.db
      .select({
        ...columns,
        pendingDeliveries: sql<number>`(select count(*)::int from integration_webhook_deliveries d where d.webhook_id = ${integrationWebhooks.id} and d.status in ('PENDING','RETRYING'))`,
        exhaustedDeliveries: sql<number>`(select count(*)::int from integration_webhook_deliveries d where d.webhook_id = ${integrationWebhooks.id} and d.status = 'EXHAUSTED')`,
      })
      .from(integrationWebhooks);
  }
}
