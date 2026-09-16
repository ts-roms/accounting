import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import {
  OPEN_DOCUMENT_STATUSES,
  P,
  type CollectionCaseStatus,
  type PaginatedResult,
} from '@accounting/types';
import type {
  CollectionActivityInput,
  CreateCollectionCaseInput,
  CreatePromiseInput,
  CreditHoldInput,
  ListCollectionCasesQuery,
  ListPromisesQuery,
  UpdateCollectionCaseInput,
  UpdatePromiseInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  collectionActivities,
  collectionCases,
  companies,
  customerPayments,
  customers,
  dunningPolicies,
  invoices,
  promisesToPay,
  users,
  type CollectionActivity,
  type CollectionCase,
  type PromiseToPay,
} from '@/database/schema';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { daysBetween } from '@/modules/subledger/subledger.logic';
import { ArConfigService } from './ar-config.service';
import { CreditService } from './credit.service';
import { CustomersService } from './customers.service';
import { dueDunningSteps, evaluatePromise } from './receivables.logic';

const MODULE = 'RECEIVABLES';
const OPEN_CASE_STATUSES: CollectionCaseStatus[] = [
  'NEW',
  'CONTACTED',
  'PROMISED',
  'ESCALATED',
  'DISPUTED',
];

export interface CollectionCaseView extends CollectionCase {
  customerCode: string;
  customerName: string;
  collectorName: string | null;
  outstanding: string;
  overdue: string;
  daysOverdue: number;
  openPromise: { id: string; amount: string; promiseDate: string } | null;
}

export interface CollectionCaseDetail extends CollectionCaseView {
  activities: Array<
    CollectionActivity & { performedByName: string | null; invoiceNumber: string | null }
  >;
  promises: PromiseToPay[];
  invoices: Array<{
    id: string;
    documentNumber: string;
    dueDate: string;
    total: string;
    balance: string;
    daysOverdue: number;
    openDisputes: number;
  }>;
}

export interface PromiseView extends PromiseToPay {
  customerCode: string;
  customerName: string;
  caseNumber: string | null;
  collectorName: string | null;
}

/**
 * Collections workspace (Prompt #6): cases per customer, activities, promises
 * to pay, escalation, credit holds (through CreditService) and the dunning
 * engine. Nothing here touches the ledger; it reads balances from the
 * subledger and writes collection state, notifications and outbox events.
 */
@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly customersService: CustomersService,
    private readonly credit: CreditService,
    private readonly config: ArConfigService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CollectionsService.name);
  }

  // ------------------------------------------------------------------- cases

  async listCases(
    companyId: string,
    query: ListCollectionCasesQuery,
  ): Promise<PaginatedResult<CollectionCaseView>> {
    const filters: SQL[] = [eq(collectionCases.companyId, companyId)];
    if (query.customerId) filters.push(eq(collectionCases.customerId, query.customerId));
    if (query.collectorId) filters.push(eq(collectionCases.collectorId, query.collectorId));
    if (query.status) filters.push(eq(collectionCases.status, query.status));
    if (query.openOnly) filters.push(inArray(collectionCases.status, OPEN_CASE_STATUSES));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(collectionCases.documentNumber, term),
          ilike(customers.name, term),
          ilike(customers.code, term),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, count] = await Promise.all([
      this.caseQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc' ? asc(collectionCases.openedAt) : desc(collectionCases.openedAt),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(collectionCases)
        .innerJoin(customers, eq(customers.id, collectionCases.customerId))
        .where(where),
    ]);
    const decorated = await this.decorateCases(companyId, rows);
    return toPaginatedResult(decorated, Number(count[0]?.n ?? 0), query);
  }

  async getCase(companyId: string, id: string): Promise<CollectionCaseDetail> {
    const [row] = await this.caseQuery().where(
      and(eq(collectionCases.id, id), eq(collectionCases.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Collection case', id);
    const [view] = await this.decorateCases(companyId, [row]);
    const today = new Date().toISOString().slice(0, 10);
    const [activities, promises, docs] = await Promise.all([
      this.db
        .select({
          activity: collectionActivities,
          performedByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
          invoiceNumber: invoices.documentNumber,
        })
        .from(collectionActivities)
        .leftJoin(users, eq(users.id, collectionActivities.performedBy))
        .leftJoin(invoices, eq(invoices.id, collectionActivities.invoiceId))
        .where(eq(collectionActivities.caseId, id))
        .orderBy(desc(collectionActivities.performedAt)),
      this.db
        .select()
        .from(promisesToPay)
        .where(eq(promisesToPay.caseId, id))
        .orderBy(desc(promisesToPay.promiseDate)),
      this.db
        .select({
          id: invoices.id,
          documentNumber: invoices.documentNumber,
          dueDate: invoices.dueDate,
          total: invoices.total,
          currency: invoices.currency,
          allocatedAmount: invoices.allocatedAmount,
          openDisputes: sql<number>`(select count(*)::int from invoice_disputes d where d.invoice_id = ${invoices.id} and d.status in ('OPEN', 'INVESTIGATING'))`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, companyId),
            eq(invoices.customerId, row.c.customerId),
            eq(invoices.accountingStatus, 'POSTED'),
            inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
            inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          ),
        )
        .orderBy(asc(invoices.dueDate)),
    ]);
    return {
      ...view!,
      activities: activities.map((a) => ({
        ...a.activity,
        performedByName: a.performedByName,
        invoiceNumber: a.invoiceNumber,
      })),
      promises,
      invoices: docs.map((d) => ({
        id: d.id,
        documentNumber: d.documentNumber,
        dueDate: d.dueDate,
        total: d.total,
        balance: Money.of(d.total, d.currency)
          .subtract(Money.of(d.allocatedAmount, d.currency))
          .toString(),
        daysOverdue: d.dueDate < today ? daysBetween(d.dueDate, today) : 0,
        openDisputes: d.openDisputes,
      })),
    };
  }

  async createCase(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateCollectionCaseInput,
  ): Promise<CollectionCaseDetail> {
    const id = await this.db.transaction(async (tx) => {
      const customer = await this.customersService.getOrThrow(companyId, input.customerId, tx);
      return this.openCase(tx, companyId, customer.id, {
        collectorId: input.collectorId ?? null,
        nextActionAt: input.nextActionAt ?? null,
        nextAction: input.nextAction ?? null,
        notes: input.notes ?? null,
        source: 'MANUAL',
        createdBy: actor.id,
      });
    });
    return this.getCase(companyId, id);
  }

  /** Opens a case unless the customer already has an open one (returns the open case id). */
  async openCase(
    tx: DbExecutor,
    companyId: string,
    customerId: string,
    input: {
      collectorId: string | null;
      nextActionAt: string | null;
      nextAction: string | null;
      notes: string | null;
      source: 'MANUAL' | 'AUTO' | 'DUNNING';
      createdBy: string | null;
    },
  ): Promise<string> {
    const [open] = await tx
      .select({ id: collectionCases.id })
      .from(collectionCases)
      .where(
        and(
          eq(collectionCases.customerId, customerId),
          inArray(collectionCases.status, OPEN_CASE_STATUSES),
        ),
      );
    if (open) return open.id;
    const documentNumber = await this.numbering.allocate(
      companyId,
      'COL',
      new Date().getFullYear(),
      tx,
    );
    const [created] = await tx
      .insert(collectionCases)
      .values({ companyId, documentNumber, customerId, ...input })
      .returning();
    await this.audit.record(
      {
        action: 'CREATE',
        module: MODULE,
        entityType: 'CollectionCase',
        entityId: created!.id,
        newValue: { documentNumber, customerId, source: input.source },
        companyId,
        userId: input.createdBy,
      },
      tx,
    );
    await this.outbox.enqueue(tx, {
      eventType: 'collection.case_opened',
      companyId,
      dedupeKey: 'collection.case_opened:' + created!.id,
      payload: { caseId: created!.id, documentNumber, customerId, source: input.source },
    });
    return created!.id;
  }

  async updateCase(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateCollectionCaseInput,
  ): Promise<CollectionCaseDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lockCase(tx, companyId, id);
      const patch: Partial<typeof collectionCases.$inferInsert> = {};
      if (input.collectorId !== undefined) patch.collectorId = input.collectorId;
      if (input.nextActionAt !== undefined) patch.nextActionAt = input.nextActionAt;
      if (input.nextAction !== undefined) patch.nextAction = input.nextAction ?? null;
      if (input.notes !== undefined) patch.notes = input.notes ?? null;
      if (input.status && input.status !== existing.status) {
        patch.status = input.status;
        if (input.status === 'ESCALATED') patch.escalationLevel = existing.escalationLevel + 1;
        if (input.status === 'CLOSED' || input.status === 'COLLECTED') patch.closedAt = new Date();
        await tx.insert(collectionActivities).values({
          caseId: id,
          customerId: existing.customerId,
          activityType: input.status === 'ESCALATED' ? 'ESCALATION' : 'STATUS_CHANGE',
          summary: `Status changed from ${existing.status} to ${input.status}`,
          details: input.notes ?? null,
          performedBy: actor.id,
        });
      }
      await tx.update(collectionCases).set(patch).where(eq(collectionCases.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CollectionCase',
          entityId: id,
          previousValue: { status: existing.status, collectorId: existing.collectorId },
          newValue: patch,
          metadata: {
            documentNumber: existing.documentNumber,
            kind: 'COLLECTION_ACTION',
            editor: actor.email,
          },
          companyId,
        },
        tx,
      );
    });
    return this.getCase(companyId, id);
  }

  async addActivity(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CollectionActivityInput,
  ): Promise<CollectionCaseDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lockCase(tx, companyId, id);
      if (input.invoiceId) {
        const [inv] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(eq(invoices.id, input.invoiceId), eq(invoices.customerId, existing.customerId)),
          );
        if (!inv) throw new NotFoundError('Invoice', input.invoiceId);
      }
      await tx.insert(collectionActivities).values({
        caseId: id,
        customerId: existing.customerId,
        invoiceId: input.invoiceId ?? null,
        activityType: input.activityType,
        summary: input.summary,
        details: input.details ?? null,
        contactName: input.contactName ?? null,
        performedBy: actor.id,
      });
      const contact = ['CALL', 'EMAIL', 'MEETING', 'LETTER'].includes(input.activityType);
      const patch: Partial<typeof collectionCases.$inferInsert> = {};
      if (contact) {
        patch.lastContactAt = new Date();
        if (existing.status === 'NEW') patch.status = 'CONTACTED';
      }
      if (input.activityType === 'ESCALATION') {
        patch.status = 'ESCALATED';
        patch.escalationLevel = existing.escalationLevel + 1;
      }
      if (input.nextActionAt !== undefined) patch.nextActionAt = input.nextActionAt;
      if (input.nextAction !== undefined) patch.nextAction = input.nextAction ?? null;
      if (Object.keys(patch).length)
        await tx.update(collectionCases).set(patch).where(eq(collectionCases.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CollectionCase',
          entityId: id,
          newValue: { activity: input.activityType, summary: input.summary },
          metadata: {
            documentNumber: existing.documentNumber,
            kind: 'COLLECTION_ACTION',
            editor: actor.email,
          },
          companyId,
        },
        tx,
      );
    });
    return this.getCase(companyId, id);
  }

  /** Credit hold from the workspace - delegates to CreditService (permission enforced by the controller). */
  async creditHold(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CreditHoldInput,
  ): Promise<CollectionCaseDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lockCase(tx, companyId, id);
      const customer = await this.customersService.getOrThrow(companyId, existing.customerId, tx);
      await this.credit.setHold(tx, companyId, actor, customer, input);
      await tx.insert(collectionActivities).values({
        caseId: id,
        customerId: existing.customerId,
        activityType: 'CREDIT_HOLD',
        summary: input.hold ? 'Customer placed on credit hold' : 'Credit hold released',
        details: input.reason,
        performedBy: actor.id,
      });
    });
    return this.getCase(companyId, id);
  }

  // ---------------------------------------------------------------- promises

  async listPromises(
    companyId: string,
    query: ListPromisesQuery,
  ): Promise<PaginatedResult<PromiseView>> {
    const filters: SQL[] = [eq(promisesToPay.companyId, companyId)];
    if (query.customerId) filters.push(eq(promisesToPay.customerId, query.customerId));
    if (query.caseId) filters.push(eq(promisesToPay.caseId, query.caseId));
    if (query.status) filters.push(eq(promisesToPay.status, query.status));
    const where = and(...filters);
    const [rows, count] = await Promise.all([
      this.promiseQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc'
            ? asc(promisesToPay.promiseDate)
            : desc(promisesToPay.promiseDate),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(promisesToPay)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(count[0]?.n ?? 0), query);
  }

  async createPromise(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePromiseInput,
  ): Promise<PromiseView> {
    const id = await this.db.transaction(async (tx) => {
      const customer = await this.customersService.getOrThrow(companyId, input.customerId, tx);
      const caseId =
        input.caseId ??
        (await this.openCase(tx, companyId, customer.id, {
          collectorId: actor.id,
          nextActionAt: input.promiseDate,
          nextAction: 'Follow up promise to pay',
          notes: null,
          source: 'MANUAL',
          createdBy: actor.id,
        }));
      const existingCase = await this.lockCase(tx, companyId, caseId);
      if (existingCase.customerId !== customer.id)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The case belongs to a different customer.',
        );
      if (input.invoiceIds.length) {
        const rows = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(inArray(invoices.id, input.invoiceIds), eq(invoices.customerId, customer.id)));
        if (rows.length !== input.invoiceIds.length)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'Every promised invoice must belong to the customer.',
          );
      }
      const [created] = await tx
        .insert(promisesToPay)
        .values({
          companyId,
          customerId: customer.id,
          caseId,
          currency: customer.currency,
          amount: Money.parse(input.amount, customer.currency).toString(),
          promiseDate: input.promiseDate,
          invoiceIds: input.invoiceIds,
          collectorId: existingCase.collectorId ?? actor.id,
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .returning();
      await tx.insert(collectionActivities).values({
        caseId,
        customerId: customer.id,
        invoiceId: input.invoiceIds[0] ?? null,
        activityType: 'PROMISE',
        summary: `Promise to pay ${customer.currency} ${created!.amount} by ${input.promiseDate}`,
        details: input.notes ?? null,
        performedBy: actor.id,
      });
      await tx
        .update(collectionCases)
        .set({
          status: 'PROMISED',
          nextActionAt: input.promiseDate,
          nextAction: 'Verify promised payment',
          lastContactAt: new Date(),
        })
        .where(eq(collectionCases.id, caseId));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PromiseToPay',
          entityId: created!.id,
          newValue: { amount: created!.amount, promiseDate: input.promiseDate, caseId },
          metadata: { kind: 'COLLECTION_ACTION' },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.getPromise(companyId, id);
  }

  async updatePromise(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePromiseInput,
  ): Promise<PromiseView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(promisesToPay)
        .where(and(eq(promisesToPay.id, id), eq(promisesToPay.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Promise to pay', id);
      if (
        input.status &&
        input.status !== 'CANCELLED' &&
        input.status !== existing.status &&
        existing.status !== 'PENDING'
      )
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `A ${existing.status} promise can no longer change.`,
        );
      await tx
        .update(promisesToPay)
        .set({
          status: input.status ?? existing.status,
          notes: input.notes === undefined ? existing.notes : input.notes,
          evaluatedAt: input.status ? new Date() : existing.evaluatedAt,
        })
        .where(eq(promisesToPay.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PromiseToPay',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: input.status ?? existing.status },
          metadata: { kind: 'COLLECTION_ACTION', editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.getPromise(companyId, id);
  }

  async getPromise(companyId: string, id: string): Promise<PromiseView> {
    const [row] = await this.promiseQuery().where(
      and(eq(promisesToPay.id, id), eq(promisesToPay.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Promise to pay', id);
    return row;
  }

  // ------------------------------------------------------------ daily sweep

  /**
   * The collections sweep (scheduled daily, callable on demand):
   *  1. invoice.overdue events + notifications for newly overdue invoices
   *  2. auto-open cases when the AR settings say so
   *  3. dunning steps per invoice according to the customer's / default policy
   *  4. promise evaluation (KEPT / BROKEN)
   *  5. collected cases closed when the customer has no overdue balance
   * Every step is idempotent (dedupe keys, unique dunning rows).
   */
  async runSweep(
    companyId: string,
    asOf = new Date().toISOString().slice(0, 10),
  ): Promise<{
    overdue: number;
    casesOpened: number;
    dunningSteps: number;
    promisesEvaluated: number;
    casesCollected: number;
    creditHolds: number;
  }> {
    const summary = {
      overdue: 0,
      casesOpened: 0,
      dunningSteps: 0,
      promisesEvaluated: 0,
      casesCollected: 0,
      creditHolds: 0,
    };
    const [company] = await this.db
      .select({ id: companies.id, organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) return summary;
    const settings = await this.config.settings(companyId);
    const policies = await this.db
      .select()
      .from(dunningPolicies)
      .where(and(eq(dunningPolicies.companyId, companyId), eq(dunningPolicies.status, 'ACTIVE')));
    const defaultPolicy =
      policies.find((p) => p.id === settings.defaultDunningPolicyId) ??
      policies.find((p) => p.isDefault) ??
      null;

    const overdueDocs = await this.db
      .select({
        invoice: invoices,
        customerGroupId: customers.customerGroupId,
        customerName: customers.name,
        customerCode: customers.code,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.dueDate} < ${asOf}`,
        ),
      )
      .orderBy(asc(invoices.dueDate));
    summary.overdue = overdueDocs.length;

    const groupPolicy = new Map<string, string | null>();
    for (const g of await this.db
      .select({
        id: customers.customerGroupId,
        dunningPolicyId: sql<
          string | null
        >`(select dunning_policy_id from customer_groups cg where cg.id = ${customers.customerGroupId})`,
      })
      .from(customers)
      .where(eq(customers.companyId, companyId)))
      if (g.id) groupPolicy.set(g.id, g.dunningPolicyId);

    for (const { invoice, customerGroupId, customerName, customerCode } of overdueDocs) {
      const daysOverdue = daysBetween(invoice.dueDate, asOf);
      const balance = Money.of(invoice.total, invoice.currency).subtract(
        Money.of(invoice.allocatedAmount, invoice.currency),
      );
      const [disputed] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(sql`invoice_disputes d`)
        .where(sql`d.invoice_id = ${invoice.id} and d.status in ('OPEN', 'INVESTIGATING')`);
      const isDisputed = Number(disputed?.n ?? 0) > 0;
      await this.db.transaction(async (tx) => {
        // 1. overdue event (dedupe per invoice) + notification (throttled by policy)
        await this.outbox.enqueue(tx, {
          eventType: 'invoice.overdue',
          companyId,
          dedupeKey: 'invoice.overdue:' + invoice.id,
          payload: {
            invoiceId: invoice.id,
            documentNumber: invoice.documentNumber,
            customerId: invoice.customerId,
            dueDate: invoice.dueDate,
            daysOverdue,
            balance: balance.toString(),
            currency: invoice.currency,
          },
        });
        await this.notifications.notify(
          {
            organizationId: company.organizationId,
            eventType: 'INVOICE_OVERDUE',
            severity: 'WARNING',
            title: `${invoice.documentNumber} is ${daysOverdue} days overdue`,
            body: `${customerName}: ${invoice.currency} ${balance.toString()} outstanding.`,
            link: `/receivables/invoices/${invoice.id}`,
            entityType: 'Invoice',
            entityId: invoice.id,
            permission: P['collection.manage'],
            companyId,
            dedupeKey: `invoice-overdue:${invoice.id}`,
          },
          tx,
        );
        // 2. auto case
        let caseId: string | null = null;
        if (settings.autoCaseDaysOverdue > 0 && daysOverdue >= settings.autoCaseDaysOverdue) {
          const before = await this.openCaseId(tx, invoice.customerId);
          caseId = await this.openCase(tx, companyId, invoice.customerId, {
            collectorId: null,
            nextActionAt: asOf,
            nextAction: 'Review overdue invoices',
            notes: null,
            source: 'AUTO',
            createdBy: null,
          });
          if (!before) summary.casesOpened += 1;
        }
        // 3. dunning - disputed invoices are never dunned
        const policyId =
          (customerGroupId ? groupPolicy.get(customerGroupId) : null) ?? defaultPolicy?.id ?? null;
        const policy = policies.find((p) => p.id === policyId) ?? null;
        if (
          policy &&
          !isDisputed &&
          !balance.lessThan(Money.of(policy.minimumAmount, invoice.currency))
        ) {
          const done = await tx
            .select({ step: collectionActivities.dunningStep })
            .from(collectionActivities)
            .where(
              and(
                eq(collectionActivities.invoiceId, invoice.id),
                eq(collectionActivities.dunningPolicyId, policy.id),
              ),
            );
          const executed = new Set(done.map((d) => d.step).filter((s): s is number => s !== null));
          const due = dueDunningSteps(policy.steps, daysOverdue, executed);
          if (due.length) {
            caseId =
              caseId ??
              (await this.openCase(tx, companyId, invoice.customerId, {
                collectorId: null,
                nextActionAt: asOf,
                nextAction: 'Dunning follow-up',
                notes: null,
                source: 'DUNNING',
                createdBy: null,
              }));
            for (const { index, step } of due) {
              await tx.insert(collectionActivities).values({
                caseId,
                customerId: invoice.customerId,
                invoiceId: invoice.id,
                activityType: 'DUNNING',
                summary: `${step.label} (${step.action.toLowerCase().replace('_', ' ')}) - ${invoice.documentNumber}, ${daysOverdue} days overdue`,
                details: `Policy "${policy.name}", step ${index + 1} at ${step.daysOverdue} days.`,
                dunningPolicyId: policy.id,
                dunningStep: index,
                performedBy: null,
              });
              summary.dunningSteps += 1;
              if (step.action === 'ESCALATION')
                await tx
                  .update(collectionCases)
                  .set({
                    status: 'ESCALATED',
                    escalationLevel: sql`${collectionCases.escalationLevel} + 1`,
                  })
                  .where(
                    and(
                      eq(collectionCases.id, caseId),
                      inArray(collectionCases.status, OPEN_CASE_STATUSES),
                    ),
                  );
              if (step.action === 'CREDIT_HOLD') {
                const customer = await this.customersService.getOrThrow(
                  companyId,
                  invoice.customerId,
                  tx,
                );
                await this.credit.setHold(
                  tx,
                  companyId,
                  { id: null, email: 'system', organizationId: company.organizationId },
                  customer,
                  {
                    hold: true,
                    reason: `Dunning policy "${policy.name}": ${step.label} (${invoice.documentNumber} ${daysOverdue} days overdue)`,
                  },
                  'DUNNING',
                );
                summary.creditHolds += 1;
              }
              await this.notifications.notify(
                {
                  organizationId: company.organizationId,
                  eventType: 'COLLECTION_ACTION_REQUIRED',
                  severity: step.action === 'REMINDER' ? 'INFO' : 'WARNING',
                  title: `${step.label}: ${customerCode} ${invoice.documentNumber}`,
                  body: `${customerName} - ${invoice.currency} ${balance.toString()} is ${daysOverdue} days overdue (${step.action.toLowerCase().replace('_', ' ')}).`,
                  link: `/receivables/collections/${caseId}`,
                  entityType: 'CollectionCase',
                  entityId: caseId,
                  permission: P['collection.manage'],
                  companyId,
                  dedupeKey: `dunning:${invoice.id}:${index}`,
                },
                tx,
              );
            }
          }
        }
      });
    }

    // 4. promises
    const pending = await this.db
      .select()
      .from(promisesToPay)
      .where(and(eq(promisesToPay.companyId, companyId), eq(promisesToPay.status, 'PENDING')));
    for (const promise of pending) {
      const [paid] = await this.db
        .select({ total: sql<string>`coalesce(sum(${customerPayments.amount}), 0)` })
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.customerId, promise.customerId),
            eq(customerPayments.status, 'POSTED'),
            eq(customerPayments.paymentType, 'PAYMENT'),
            gte(customerPayments.paymentDate, promise.createdAt.toISOString().slice(0, 10)),
            lte(customerPayments.paymentDate, promise.promiseDate),
          ),
        );
      const settled = Money.of(paid?.total ?? '0', promise.currency).toString();
      const status = evaluatePromise(promise, settled, asOf, promise.currency);
      if (status === promise.status && settled === promise.settledAmount) continue;
      summary.promisesEvaluated += 1;
      await this.db.transaction(async (tx) => {
        await tx
          .update(promisesToPay)
          .set({ status, settledAmount: settled, evaluatedAt: new Date() })
          .where(eq(promisesToPay.id, promise.id));
        if (status === 'BROKEN') {
          if (promise.caseId)
            await tx.insert(collectionActivities).values({
              caseId: promise.caseId,
              customerId: promise.customerId,
              activityType: 'NOTE',
              summary: `Promise to pay ${promise.currency} ${promise.amount} by ${promise.promiseDate} was broken (${settled} received)`,
              performedBy: null,
            });
          await this.outbox.enqueue(tx, {
            eventType: 'collection.promise_broken',
            companyId,
            dedupeKey: 'collection.promise_broken:' + promise.id,
            payload: {
              promiseId: promise.id,
              customerId: promise.customerId,
              amount: promise.amount,
              promiseDate: promise.promiseDate,
              settled,
            },
          });
          await this.notifications.notify(
            {
              organizationId: company.organizationId,
              eventType: 'PROMISE_BROKEN',
              severity: 'WARNING',
              title: `Promise to pay broken (${promise.currency} ${promise.amount})`,
              body: `Promised by ${promise.promiseDate}; ${settled} received.`,
              link: promise.caseId
                ? `/receivables/collections/${promise.caseId}`
                : `/receivables/customers/${promise.customerId}`,
              entityType: 'PromiseToPay',
              entityId: promise.id,
              userIds: promise.collectorId ? [promise.collectorId] : undefined,
              permission: promise.collectorId ? undefined : P['collection.manage'],
              companyId,
              dedupeKey: `promise-broken:${promise.id}`,
            },
            tx,
          );
        }
      });
    }

    // 5. cases whose customer no longer owes anything overdue -> COLLECTED
    const openCases = await this.db
      .select()
      .from(collectionCases)
      .where(
        and(
          eq(collectionCases.companyId, companyId),
          inArray(collectionCases.status, OPEN_CASE_STATUSES),
        ),
      );
    if (openCases.length) {
      const balances = await this.customersService.balances(companyId, [
        ...new Set(openCases.map((c) => c.customerId)),
      ]);
      for (const c of openCases) {
        const b = balances.get(c.customerId);
        if (!b || !Money.of(b.overdue, 'PHP').isZero()) continue;
        await this.db.transaction(async (tx) => {
          await tx
            .update(collectionCases)
            .set({ status: 'COLLECTED', closedAt: new Date() })
            .where(eq(collectionCases.id, c.id));
          await tx.insert(collectionActivities).values({
            caseId: c.id,
            customerId: c.customerId,
            activityType: 'STATUS_CHANGE',
            summary: 'No overdue balance remains - case collected',
            performedBy: null,
          });
        });
        summary.casesCollected += 1;
      }
    }
    this.logger.info({ companyId, asOf, ...summary }, 'Collections sweep');
    return summary;
  }

  // --------------------------------------------------------------- internals

  private async openCaseId(tx: DbExecutor, customerId: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: collectionCases.id })
      .from(collectionCases)
      .where(
        and(
          eq(collectionCases.customerId, customerId),
          inArray(collectionCases.status, OPEN_CASE_STATUSES),
        ),
      );
    return row?.id ?? null;
  }

  private caseQuery() {
    return this.db
      .select({
        c: collectionCases,
        customerCode: customers.code,
        customerName: customers.name,
        collectorName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(collectionCases)
      .innerJoin(customers, eq(customers.id, collectionCases.customerId))
      .leftJoin(users, eq(users.id, collectionCases.collectorId));
  }

  private async decorateCases(
    companyId: string,
    rows: Array<{
      c: CollectionCase;
      customerCode: string;
      customerName: string;
      collectorName: string | null;
    }>,
  ): Promise<CollectionCaseView[]> {
    if (!rows.length) return [];
    const today = new Date().toISOString().slice(0, 10);
    const customerIds = [...new Set(rows.map((r) => r.c.customerId))];
    const balances = await this.customersService.balances(companyId, customerIds);
    const oldest = await this.db
      .select({
        customerId: invoices.customerId,
        dueDate: sql<string | null>`min(${invoices.dueDate})`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          inArray(invoices.customerId, customerIds),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.dueDate} < ${today}`,
        ),
      )
      .groupBy(invoices.customerId);
    const oldestBy = new Map(oldest.map((o) => [o.customerId, o.dueDate]));
    const promises = await this.db
      .select({
        id: promisesToPay.id,
        caseId: promisesToPay.caseId,
        amount: promisesToPay.amount,
        promiseDate: promisesToPay.promiseDate,
      })
      .from(promisesToPay)
      .where(
        and(
          inArray(
            promisesToPay.caseId,
            rows.map((r) => r.c.id),
          ),
          eq(promisesToPay.status, 'PENDING'),
        ),
      )
      .orderBy(asc(promisesToPay.promiseDate));
    const promiseBy = new Map<string, { id: string; amount: string; promiseDate: string }>();
    for (const p of promises)
      if (p.caseId && !promiseBy.has(p.caseId))
        promiseBy.set(p.caseId, { id: p.id, amount: p.amount, promiseDate: p.promiseDate });
    return rows.map((r) => {
      const b = balances.get(r.c.customerId)!;
      const due = oldestBy.get(r.c.customerId) ?? null;
      return {
        ...r.c,
        customerCode: r.customerCode,
        customerName: r.customerName,
        collectorName: r.collectorName,
        outstanding: b.outstanding,
        overdue: b.overdue,
        daysOverdue: due ? daysBetween(due, today) : 0,
        openPromise: promiseBy.get(r.c.id) ?? null,
      };
    });
  }

  private promiseQuery() {
    return this.db
      .select({
        id: promisesToPay.id,
        companyId: promisesToPay.companyId,
        customerId: promisesToPay.customerId,
        caseId: promisesToPay.caseId,
        status: promisesToPay.status,
        currency: promisesToPay.currency,
        amount: promisesToPay.amount,
        promiseDate: promisesToPay.promiseDate,
        invoiceIds: promisesToPay.invoiceIds,
        collectorId: promisesToPay.collectorId,
        notes: promisesToPay.notes,
        settledAmount: promisesToPay.settledAmount,
        evaluatedAt: promisesToPay.evaluatedAt,
        createdBy: promisesToPay.createdBy,
        createdAt: promisesToPay.createdAt,
        updatedAt: promisesToPay.updatedAt,
        customerCode: customers.code,
        customerName: customers.name,
        caseNumber: collectionCases.documentNumber,
        collectorName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(promisesToPay)
      .innerJoin(customers, eq(customers.id, promisesToPay.customerId))
      .leftJoin(collectionCases, eq(collectionCases.id, promisesToPay.caseId))
      .leftJoin(users, eq(users.id, promisesToPay.collectorId));
  }

  private async lockCase(tx: DbExecutor, companyId: string, id: string): Promise<CollectionCase> {
    const [row] = await tx
      .select()
      .from(collectionCases)
      .where(and(eq(collectionCases.id, id), eq(collectionCases.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Collection case', id);
    return row;
  }
}
