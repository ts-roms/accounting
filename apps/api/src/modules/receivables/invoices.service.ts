import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  P,
  OPEN_DOCUMENT_STATUSES,
  type DocumentType,
  type PaginatedResult,
  type SubledgerDocumentType,
} from '@accounting/types';
import type {
  AllocateInput,
  CollectionUpdateInput,
  CreateInvoiceInput,
  ListDocumentsQuery,
  UpdateInvoiceInput,
  VoidDocumentInput,
} from '@accounting/validation';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { SodService } from '@/modules/rbac/sod.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  customers,
  deliveries,
  deliveryLines,
  invoiceLines,
  invoices,
  journalEntries,
  paymentAllocations,
  customerPayments,
  type Invoice,
  type InvoiceLine,
} from '@/database/schema';
import {
  addDays,
  computeLines,
  daysBetween,
  deriveDocumentStatus,
  isDebitDocument,
  validateAllocations,
  type AllocationTarget,
} from '@/modules/subledger/subledger.logic';
import { DocumentStockService } from '@/modules/inventory/document-stock.service';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { OrderFulfillmentService } from '@/modules/orders/order-fulfillment.service';
import { CustomersService } from './customers.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { TaxEngineService } from '@/modules/tax/tax-engine.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { ArConfigService } from './ar-config.service';
import { CreditService } from './credit.service';
import { dueDateFor, type CreditFinding } from './receivables.logic';

const MODULE = 'RECEIVABLES';
const NUMBER_TYPE: Record<SubledgerDocumentType, DocumentType> = {
  INVOICE: 'INV',
  CREDIT_NOTE: 'CN',
  DEBIT_NOTE: 'DN',
};

export interface InvoiceWarning {
  code: 'CREDIT_LIMIT_EXCEEDED' | 'CREDIT_RULE';
  message: string;
  details: Record<string, unknown>;
}

export interface InvoiceView extends Invoice {
  customerCode: string;
  customerName: string;
  journalNumber: string | null;
  balance: string;
  daysOverdue: number;
  /** Open (unresolved) disputes on this document. */
  openDisputes: number;
  deliveryNumber: string | null;
  salesOrderNumber: string | null;
}

export interface AllocationView {
  id: string;
  amount: string;
  allocationDate: string;
  paymentId: string | null;
  paymentNumber: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  invoiceId: string;
  invoiceNumber: string;
}

export interface InvoiceDetail extends InvoiceView {
  lines: Array<InvoiceLine & { accountCode: string; accountName: string }>;
  /** Settlements applied TO this document (for invoices) or BY this document (for credit notes). */
  allocations: AllocationView[];
  warnings?: InvoiceWarning[];
}

/**
 * Customer invoices, credit notes and debit notes. Business status
 * (DRAFT/APPROVED/PARTIALLY_PAID/PAID/VOID) is independent from the accounting
 * status (UNPOSTED/POSTED/REVERSED); posting always goes through the
 * AccountingPostingService with the mapped AR control account.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly customersService: CustomersService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly stock: DocumentStockService,
    private readonly inventory: InventoryService,
    private readonly tax: TaxEngineService,
    private readonly dimensions: DimensionsService,
    private readonly rates: ExchangeRatesService,
    private readonly fx: FxService,
    private readonly authority: AuthorityService,
    private readonly outbox: OutboxService,
    private readonly sod: SodService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly config: ArConfigService,
    private readonly credit: CreditService,
  ) {}

  // ----------------------------------------------------------------- queries

  async list(companyId: string, query: ListDocumentsQuery): Promise<PaginatedResult<InvoiceView>> {
    const today = new Date().toISOString().slice(0, 10);
    const filters: SQL[] = [eq(invoices.companyId, companyId)];
    if (query.partyId) filters.push(eq(invoices.customerId, query.partyId));
    if (query.documentType) filters.push(eq(invoices.documentType, query.documentType));
    if (query.status) filters.push(eq(invoices.status, query.status));
    if (query.from) filters.push(gte(invoices.documentDate, query.from));
    if (query.to) filters.push(lte(invoices.documentDate, query.to));
    if (query.branchId) filters.push(eq(invoices.branchId, query.branchId));
    if (query.salesOrderId) filters.push(eq(invoices.salesOrderId, query.salesOrderId));
    if (query.disputedOnly)
      filters.push(
        sql`exists (select 1 from invoice_disputes d where d.invoice_id = ${invoices.id} and d.status in ('OPEN', 'INVESTIGATING'))`,
      );
    if (query.openOnly)
      filters.push(
        inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
        eq(invoices.accountingStatus, 'POSTED'),
      );
    if (query.overdueOnly)
      filters.push(
        inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
        sql`${invoices.dueDate} < ${today}`,
        inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
      );
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(invoices.documentNumber, term),
          ilike(invoices.reference, term),
          ilike(invoices.description, term),
          ilike(customers.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'dueDate'
        ? invoices.dueDate
        : query.sortBy === 'total'
          ? invoices.total
          : query.sortBy === 'documentNumber'
            ? invoices.documentNumber
            : invoices.documentDate;
    const direction = query.sortDir === 'asc' ? asc : desc;

    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(sortColumn), desc(invoices.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(where),
    ]);
    return toPaginatedResult(
      rows.map((r) => this.decorate(r, today)),
      Number(countRows[0]?.total ?? 0),
      query,
    );
  }

  async get(companyId: string, id: string): Promise<InvoiceDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(invoices.id, id), eq(invoices.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Invoice', id);
    const [lines, allocations] = await Promise.all([
      this.lines(id),
      this.allocations(companyId, row.id, row.documentType),
    ]);
    return { ...this.decorate(row, new Date().toISOString().slice(0, 10)), lines, allocations };
  }

  // ---------------------------------------------------------------- commands

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateInvoiceInput,
  ): Promise<InvoiceDetail> {
    const { id, warnings } = await this.db.transaction((tx) =>
      this.createInTx(tx, companyId, actor, input),
    );
    return { ...(await this.get(companyId, id)), warnings };
  }

  /**
   * Creates the document inside the caller's transaction (used by sales orders
   * and returns so the order counters and the invoice commit together).
   */
  async createInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateInvoiceInput,
  ): Promise<{ id: string; warnings: InvoiceWarning[] }> {
    {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.companyId, companyId),
              eq(invoices.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return { id: existing.id, warnings: [] as InvoiceWarning[] };
      }
      const customer = await this.customersService.getOrThrow(companyId, input.customerId, tx);
      if (customer.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.PARTY_INACTIVE,
          `Customer ${customer.code} is inactive.`,
        );
      const currency = customer.currency;
      const { rate: exchangeRate, baseCurrency } = await this.rates.documentRate(
        companyId,
        currency,
        input.documentDate,
        input.exchangeRate,
        tx,
      );
      const { lines, subtotal } = computeLines(input.lines, currency);
      await this.assertLineAccounts(
        companyId,
        lines.map((l) => l.accountId),
        tx,
      );
      await this.stock.validateLines(tx, companyId, lines);
      await this.dimensions.validateRefs(tx, companyId, lines, input.documentDate);
      const taxed = await this.tax.applyToLines(
        tx,
        companyId,
        'SALES',
        input.documentDate,
        currency,
        lines,
      );
      const total = subtotal.add(taxed.totals.taxTotal).subtract(taxed.totals.withholdingTotal);
      const baseTotal = total.convert(baseCurrency, exchangeRate);
      await this.posting.resolvePeriod(tx, companyId, input.documentDate, { draft: true });
      const paymentTermId = input.paymentTermId ?? customer.paymentTermId ?? null;
      const dueDate =
        input.dueDate ??
        (await this.dueDate(
          tx,
          companyId,
          input.documentDate,
          paymentTermId,
          customer.paymentTermsDays,
        ));
      if (dueDate < input.documentDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Due date cannot be before the document date.',
        );
      const documentNumber = await this.numbering.allocate(
        companyId,
        NUMBER_TYPE[input.documentType],
        Number(input.documentDate.slice(0, 4)),
        tx,
        { branchId: input.branchId ?? null },
      );

      if (input.salesOrderId) {
        await this.fulfillment.consume(
          tx,
          companyId,
          input.salesOrderId,
          'BILLING',
          lines
            .filter((l) => l.orderLineId)
            .map((l) => ({ orderLineId: l.orderLineId!, quantity: l.quantity })),
          { expectedType: 'SALES_ORDER', partyId: customer.id },
        );
      } else if (lines.some((l) => l.orderLineId)) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Lines reference order lines but no sales order is set.',
        );
      }
      if (input.deliveryId) {
        await this.consumeDelivery(
          tx,
          companyId,
          input.deliveryId,
          input.salesOrderId ?? null,
          customer.id,
          lines,
          currency,
        );
      }
      const [created] = await tx
        .insert(invoices)
        .values({
          companyId,
          customerId: customer.id,
          branchId: input.branchId ?? null,
          salesOrderId: input.salesOrderId ?? null,
          deliveryId: input.deliveryId ?? null,
          paymentTermId,
          documentType: input.documentType,
          documentNumber,
          documentDate: input.documentDate,
          dueDate,
          reference: input.reference ?? null,
          description: input.description ?? null,
          currency,
          exchangeRate,
          baseTotal: baseTotal.toString(),
          subtotal: subtotal.toString(),
          taxTotal: taxed.totals.taxTotal.toString(),
          withholdingTotal: taxed.totals.withholdingTotal.toString(),
          total: total.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!created) throw new Error('Insert returned no row');
      await tx
        .insert(invoiceLines)
        .values(lines.map((l, i) => ({ ...l, ...taxed.lines[i]!, invoiceId: created.id })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Invoice',
          entityId: created.id,
          newValue: {
            documentNumber,
            documentType: created.documentType,
            customerId: customer.id,
            total: created.total,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'invoice.created',
        companyId,
        dedupeKey: 'invoice.created:' + created.id,
        payload: this.eventPayload(created),
      });
      const warnings = await this.creditLimitWarnings(companyId, customer.id, created, tx);
      return { id: created.id, warnings };
    }
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateInvoiceInput,
  ): Promise<InvoiceDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'edited');
      const customer = await this.customersService.getOrThrow(
        companyId,
        input.customerId ?? existing.customerId,
        tx,
      );
      const documentDate = input.documentDate ?? existing.documentDate;
      await this.posting.resolvePeriod(tx, companyId, documentDate, { draft: true });
      if (customer.currency !== existing.currency) {
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `${existing.documentNumber} is in ${existing.currency}; the party is billed in ${customer.currency}.`,
        );
      }
      const rateChanged = input.exchangeRate !== undefined || input.documentDate !== undefined;
      const { rate: exchangeRate, baseCurrency } = rateChanged
        ? await this.rates.documentRate(
            companyId,
            existing.currency,
            documentDate,
            input.exchangeRate,
            tx,
          )
        : {
            rate: existing.exchangeRate,
            baseCurrency: await this.accounts.companyCurrency(companyId, tx),
          };
      let totals = {
        subtotal: existing.subtotal,
        taxTotal: existing.taxTotal,
        withholdingTotal: existing.withholdingTotal,
        total: existing.total,
      };
      if (input.lines) {
        const { lines, subtotal } = computeLines(input.lines, existing.currency);
        await this.assertLineAccounts(
          companyId,
          lines.map((l) => l.accountId),
          tx,
        );
        await this.stock.validateLines(tx, companyId, lines);
        await this.dimensions.validateRefs(tx, companyId, lines, documentDate);
        const taxed = await this.tax.applyToLines(
          tx,
          companyId,
          'SALES',
          documentDate,
          existing.currency,
          lines,
        );
        if (existing.salesOrderId) {
          await this.fulfillment.release(
            tx,
            existing.salesOrderId,
            'BILLING',
            await this.orderLinesOf(tx, id),
          );
          await this.fulfillment.consume(
            tx,
            companyId,
            existing.salesOrderId,
            'BILLING',
            lines
              .filter((l) => l.orderLineId)
              .map((l) => ({ orderLineId: l.orderLineId!, quantity: l.quantity })),
            { expectedType: 'SALES_ORDER', partyId: customer.id },
          );
        }
        await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
        await tx
          .insert(invoiceLines)
          .values(lines.map((l, i) => ({ ...l, ...taxed.lines[i]!, invoiceId: id })));
        totals = {
          subtotal: subtotal.toString(),
          taxTotal: taxed.totals.taxTotal.toString(),
          withholdingTotal: taxed.totals.withholdingTotal.toString(),
          total: subtotal
            .add(taxed.totals.taxTotal)
            .subtract(taxed.totals.withholdingTotal)
            .toString(),
        };
      }
      const paymentTermId =
        input.paymentTermId === undefined ? existing.paymentTermId : input.paymentTermId;
      const dueDate =
        input.dueDate ??
        (input.documentDate || input.paymentTermId !== undefined
          ? await this.dueDate(
              tx,
              companyId,
              documentDate,
              paymentTermId,
              customer.paymentTermsDays,
            )
          : existing.dueDate);
      if (dueDate < documentDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Due date cannot be before the document date.',
        );
      await tx
        .update(invoices)
        .set({
          customerId: customer.id,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          documentDate,
          dueDate,
          paymentTermId,
          reference: input.reference === undefined ? existing.reference : input.reference,
          description: input.description === undefined ? existing.description : input.description,
          exchangeRate,
          baseTotal: Money.of(totals.total, existing.currency)
            .convert(baseCurrency, exchangeRate)
            .toString(),
          ...totals,
        })
        .where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          // Header before / after: the audit service derives the field-level history from it.
          previousValue: {
            customerId: existing.customerId,
            branchId: existing.branchId,
            documentDate: existing.documentDate,
            dueDate: existing.dueDate,
            reference: existing.reference,
            description: existing.description,
            subtotal: existing.subtotal,
            taxTotal: existing.taxTotal,
            total: existing.total,
          },
          newValue: {
            customerId: customer.id,
            branchId: input.branchId === undefined ? existing.branchId : input.branchId,
            documentDate,
            dueDate,
            reference: input.reference === undefined ? existing.reference : input.reference,
            description: input.description === undefined ? existing.description : input.description,
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            total: totals.total,
          },
          metadata: {
            documentNumber: existing.documentNumber,
            editor: actor.email,
            reason: input.changeReason ?? null,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'deleted');
      if (existing.deliveryId) await this.releaseDelivery(tx, id);
      if (existing.salesOrderId) {
        await this.fulfillment.release(
          tx,
          existing.salesOrderId,
          'BILLING',
          await this.orderLinesOf(tx, id),
        );
      }
      await tx.delete(invoices).where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber, total: existing.total },
          companyId,
        },
        tx,
      );
    });
  }

  /**
   * DRAFT -> SUBMITTED: runs the credit policy for invoices / debit notes and
   * opens the approval workflow when one matches the amount (Prompt #6).
   */
  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<InvoiceDetail> {
    const warnings = await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'submitted');
      const warnings = await this.runCreditPolicy(tx, companyId, existing);
      await this.approvals.open(tx, this.workflowRef(companyId, existing, actor.id));
      await tx
        .update(invoices)
        .set({ status: 'SUBMITTED', submittedBy: actor.id, submittedAt: new Date() })
        .where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED', warnings },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      await this.notifyApprovers(tx, companyId, existing);
      return warnings;
    });
    return { ...(await this.get(companyId, id)), warnings };
  }

  async approve(companyId: string, actor: AuthenticatedUser, id: string): Promise<InvoiceDetail> {
    const warnings = await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED'], 'approved');
      // Configured approval chain (if any) must be complete before the approver's own step.
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, existing, existing.createdBy ?? actor.id),
      );
      const creditWarnings = await this.runCreditPolicy(tx, companyId, existing);
      // Delegated authority (if any) is validated and recorded in this transaction.
      const authority = await this.authority.assert(tx, actor, P['invoice.approve'], {
        companyId,
        branchId: existing.branchId,
        amount: existing.total,
        currency: existing.currency,
        documentType: 'INVOICE',
        documentId: id,
        documentNumber: existing.documentNumber,
        createdBy: existing.createdBy,
        action: 'Approved customer invoice',
      });
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['invoice.create'], P['invoice.approve']],
        existing.createdBy,
        actor.id,
        tx,
        { companyId, entityType: 'Invoice', entityId: id, documentNumber: existing.documentNumber },
      );
      await tx
        .update(invoices)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: existing.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'invoice.approved',
        companyId,
        dedupeKey: `invoice.approved:${id}`,
        payload: this.eventPayload(existing),
      });
      await this.notify(tx, companyId, existing, {
        eventType: 'INVOICE_APPROVED',
        title: `${labelFor(existing.documentType)} ${existing.documentNumber} approved`,
        body: `Approved for ${existing.currency} ${existing.total}; ready to post.`,
        permission: P['invoice.post'],
        userIds: existing.createdBy ? [existing.createdBy] : [],
      });
      return [
        ...creditWarnings,
        ...(await this.creditLimitWarnings(companyId, existing.customerId, existing, tx)),
      ];
    });
    return { ...(await this.get(companyId, id)), warnings };
  }

  /** Posts the accounting effect: Dr AR / Cr revenue lines (credit notes mirror it). Idempotent. */
  async post(companyId: string, actor: AuthenticatedUser, id: string): Promise<InvoiceDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.accountingStatus === 'POSTED') return;
      this.assertStatus(existing, ['APPROVED'], 'posted');
      const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE', tx);
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(asc(invoiceLines.lineNumber));
      const customer = await this.customersService.getOrThrow(companyId, existing.customerId, tx);
      const debitSide = isDebitDocument(existing.documentType);
      // Foreign-currency documents post in base at the document rate; the control carries the exact sum.
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const toBase = (v: string) =>
        Money.of(v, existing.currency).convert(baseCurrency, existing.exchangeRate).toString();
      const baseLines = lines.map((l) => ({
        ...l,
        amount: toBase(l.amount),
        taxAmount: toBase(l.taxAmount),
        withholdingAmount: toBase(l.withholdingAmount),
      }));
      const baseTotal = Money.sum(
        baseLines.map((l) =>
          Money.of(l.amount, baseCurrency)
            .add(Money.of(l.taxAmount, baseCurrency))
            .subtract(Money.of(l.withholdingAmount, baseCurrency)),
        ),
        baseCurrency,
      );
      // Stocked product lines move inventory and add COGS lines to the same entry (Phase 5).
      // When the invoice bills a delivery the goods already left (and COGS posted) with it.
      const stock = await this.stock.postSalesLines(tx, {
        companyId,
        sourceId: existing.id,
        movementDate: existing.documentDate,
        actorId: actor.id,
        currency: baseCurrency,
        isCreditNote: !debitSide,
        lines: existing.deliveryId ? baseLines.map((l) => ({ ...l, productId: null })) : baseLines,
      });
      if (existing.deliveryId)
        await this.copyDeliveryCosts(tx, existing.deliveryId, lines, baseCurrency);
      for (const [lineId, cost] of stock.costByLine) {
        await tx
          .update(invoiceLines)
          .set({ costAmount: cost.toString() })
          .where(eq(invoiceLines.id, lineId));
      }
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.documentDate,
          description: `${labelFor(existing.documentType)} ${existing.documentNumber}${existing.description ? ` - ${existing.description}` : ''}`,
          reference: existing.reference ?? existing.documentNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'AR_DOCUMENT',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: control.id,
              debit: debitSide ? baseTotal.toString() : '0',
              credit: debitSide ? '0' : baseTotal.toString(),
              description: `${existing.documentNumber} - customer receivable`,
            },
            ...baseLines.map((l) => ({
              accountId: l.accountId,
              debit: debitSide ? '0' : l.amount,
              credit: debitSide ? l.amount : '0',
              description: l.description,
              branchId: l.branchId,
              departmentId: l.departmentId,
              costCenterId: l.costCenterId,
              projectId: l.projectId,
            })),
            ...stock.postingLines,
            ...(await this.tax.postingLines(
              tx,
              companyId,
              'SALES',
              baseCurrency,
              baseLines,
              !debitSide,
            )),
          ],
        },
        { permission: P['invoice.post'] },
      );
      await this.inventory.setJournal(tx, stock.movementIds, entry.id);
      await this.tax.record(
        tx,
        {
          companyId,
          side: 'SALES',
          sourceType: 'AR_DOCUMENT',
          sourceId: existing.id,
          documentNumber: existing.documentNumber,
          journalEntryId: entry.id,
          transactionDate: existing.documentDate,
          party: {
            id: customer.id,
            name: customer.name,
            taxNumber: customer.taxIdentificationNumber,
          },
          negate: !debitSide,
        },
        baseLines,
        baseCurrency,
      );
      await tx
        .update(invoices)
        .set({
          baseTotal: baseTotal.toString(),
          accountingStatus: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          newValue: { accountingStatus: 'POSTED', journalEntryId: entry.id },
          metadata: {
            documentNumber: existing.documentNumber,
            journalNumber: entry.documentNumber,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType:
          existing.documentType === 'CREDIT_NOTE'
            ? 'credit_note.posted'
            : existing.documentType === 'DEBIT_NOTE'
              ? 'debit_note.posted'
              : 'invoice.posted',
        companyId,
        dedupeKey: 'invoice.posted:' + id,
        payload: {
          ...this.eventPayload(existing),
          accountingStatus: 'POSTED',
          journalEntryId: entry.id,
          journalNumber: entry.documentNumber,
        },
      });
      await this.notify(tx, companyId, existing, {
        eventType: 'INVOICE_POSTED',
        title: `${labelFor(existing.documentType)} ${existing.documentNumber} posted`,
        body: `Journal ${entry.documentNumber} - ${existing.currency} ${existing.total}.`,
        userIds: [existing.createdBy, existing.approvedBy].filter((u): u is string => Boolean(u)),
      });
    });
    return this.get(companyId, id);
  }

  /** Voids a document; a posted one is reversed in the ledger. Settled documents cannot be voided. */
  async void(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VoidDocumentInput,
  ): Promise<InvoiceDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID'], 'voided');
      if (!Money.of(existing.allocatedAmount, existing.currency).isZero()) {
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_HAS_ALLOCATIONS,
          'Remove the payments or credits applied to this document before voiding it.',
        );
      }
      if (existing.documentType === 'CREDIT_NOTE') {
        const [applied] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(paymentAllocations)
          .where(eq(paymentAllocations.creditNoteId, id));
        if (Number(applied?.n ?? 0) > 0)
          throw new BusinessRuleError(
            ErrorCodes.DOCUMENT_HAS_ALLOCATIONS,
            'This credit note has been applied to invoices and cannot be voided.',
          );
      }
      let reversalId: string | null = null;
      if (existing.accountingStatus === 'POSTED' && existing.journalEntryId) {
        const reversalDate = input.reversalDate ?? existing.documentDate;
        // Stock goes back the way it came (at the original cost) so the mirror entry stays exact.
        const stockReversal = await this.inventory.reverseDocument(
          tx,
          companyId,
          'AR_DOCUMENT',
          existing.id,
          'AR_DOCUMENT_VOID',
          reversalDate,
          actor.id,
          existing.currency,
        );
        const originalLines = await tx.query.journalLines.findMany({
          where: (l, ops) => ops.eq(l.journalEntryId, existing.journalEntryId!),
          orderBy: (l, ops) => ops.asc(l.lineNumber),
        });
        const reversal = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: reversalDate,
            description: `Void ${existing.documentNumber}: ${input.reason}`,
            reference: existing.documentNumber,
            journalType: 'REVERSAL',
            branchId: existing.branchId,
            sourceType: 'AR_DOCUMENT_VOID',
            sourceId: existing.id,
            reversalOfId: existing.journalEntryId,
            actor,
            lines: originalLines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              description: l.description,
              branchId: l.branchId,
              departmentId: l.departmentId,
              costCenterId: l.costCenterId,
              projectId: l.projectId,
            })),
          },
          { permission: P['invoice.void'] },
        );
        await tx
          .update(journalEntries)
          .set({ status: 'REVERSED', reversedById: reversal.id })
          .where(eq(journalEntries.id, existing.journalEntryId));
        await this.inventory.setJournal(tx, stockReversal.movementIds, reversal.id);
        await this.tax.reverse(
          tx,
          'AR_DOCUMENT',
          existing.id,
          reversal.id,
          reversalDate,
          existing.currency,
        );
        reversalId = reversal.id;
      }
      await this.approvals.cancelFor(tx, 'INVOICE', id);
      if (existing.deliveryId) await this.releaseDelivery(tx, id);
      if (existing.salesOrderId) {
        await this.fulfillment.release(
          tx,
          existing.salesOrderId,
          'BILLING',
          await this.orderLinesOf(tx, id),
        );
      }
      await tx
        .update(invoices)
        .set({
          status: 'VOID',
          accountingStatus: reversalId ? 'REVERSED' : existing.accountingStatus,
          reversalJournalEntryId: reversalId,
          voidReason: input.reason,
          voidedBy: actor.id,
          voidedAt: new Date(),
        })
        .where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'VOID', reversalJournalEntryId: reversalId },
          metadata: { documentNumber: existing.documentNumber, reason: input.reason },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: reversalId ? 'invoice.voided' : 'invoice.cancelled',
        companyId,
        dedupeKey: 'invoice.cancelled:' + id,
        payload: { ...this.eventPayload(existing), status: 'VOID', reason: input.reason },
      });
    });
    return this.get(companyId, id);
  }

  async updateCollection(
    companyId: string,
    id: string,
    input: CollectionUpdateInput,
  ): Promise<InvoiceDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      await tx
        .update(invoices)
        .set({
          promisedPaymentDate:
            input.promisedPaymentDate === undefined
              ? existing.promisedPaymentDate
              : input.promisedPaymentDate,
          collectionNotes:
            input.collectionNotes === undefined ? existing.collectionNotes : input.collectionNotes,
        })
        .where(eq(invoices.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Invoice',
          entityId: id,
          newValue: {
            promisedPaymentDate: input.promisedPaymentDate,
            collectionNotes: input.collectionNotes,
          },
          metadata: { documentNumber: existing.documentNumber, kind: 'collection' },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Applies an open credit note against the customer's open invoices (no ledger effect: both are already posted to AR). */
  async applyCreditNote(
    companyId: string,
    actor: AuthenticatedUser,
    creditNoteId: string,
    input: AllocateInput,
    allocationDate = new Date().toISOString().slice(0, 10),
  ): Promise<InvoiceDetail> {
    await this.db.transaction(async (tx) => {
      const note = await this.lock(tx, companyId, creditNoteId);
      if (note.documentType !== 'CREDIT_NOTE')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${note.documentNumber} is not a credit note.`,
        );
      if (note.accountingStatus !== 'POSTED' || note.status === 'VOID')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${note.documentNumber} must be posted before it can be applied.`,
        );
      const available = Money.of(note.total, note.currency).subtract(
        Money.of(note.allocatedAmount, note.currency),
      );
      const targets = await this.lockTargets(
        tx,
        companyId,
        input.allocations.map((a) => a.documentId),
      );
      const applied = validateAllocations(
        input.allocations,
        targets,
        note.customerId,
        available,
        note.currency,
      );
      const inserted = await tx
        .insert(paymentAllocations)
        .values(
          input.allocations.map((a) => ({
            companyId,
            invoiceId: a.documentId,
            creditNoteId: note.id,
            amount: Money.parse(a.amount, note.currency).toString(),
            allocationDate,
            createdBy: actor.id,
          })),
        )
        .returning({ id: paymentAllocations.id });
      await this.applyToTargets(tx, targets, input.allocations, note.currency);
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const gain = this.fx.settlementGain(
        input.allocations.map((a) => ({
          amount: a.amount,
          currency: note.currency,
          documentRate: targets.get(a.documentId)!.exchangeRate,
        })),
        note.exchangeRate,
        baseCurrency,
        'AR',
      );
      await this.fx.postRealizedGain(tx, {
        companyId,
        side: 'AR',
        entryDate: allocationDate,
        gain,
        baseCurrency,
        description: `Realized FX on applying ${note.documentNumber}`,
        sourceType: 'AR_CREDIT_APPLICATION',
        sourceId: note.id,
        eventId: inserted[0]!.id,
        actor,
        permission: P['invoice.post'],
        branchId: note.branchId,
      });
      const newAllocated = Money.of(note.allocatedAmount, note.currency).add(applied);
      await tx
        .update(invoices)
        .set({
          allocatedAmount: newAllocated.toString(),
          status: deriveDocumentStatus(Money.of(note.total, note.currency), newAllocated),
        })
        .where(eq(invoices.id, note.id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Invoice',
          entityId: note.id,
          newValue: { applied: applied.toString(), allocations: input.allocations },
          metadata: { documentNumber: note.documentNumber, kind: 'credit-note-application' },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, creditNoteId);
  }

  // ------------------------------------------------------- shared with payments

  /** Locks open documents targeted by allocations (used by payments too). */
  async lockTargets(
    tx: DbExecutor,
    companyId: string,
    ids: string[],
  ): Promise<Map<string, AllocationTarget>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: invoices.id,
        documentNumber: invoices.documentNumber,
        documentType: invoices.documentType,
        status: invoices.status,
        accountingStatus: invoices.accountingStatus,
        partyId: invoices.customerId,
        total: invoices.total,
        allocatedAmount: invoices.allocatedAmount,
        currency: invoices.currency,
        exchangeRate: invoices.exchangeRate,
      })
      .from(invoices)
      .where(and(eq(invoices.companyId, companyId), inArray(invoices.id, ids)))
      .for('update');
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Increases `allocated_amount` on each target and updates its business status. */
  async applyToTargets(
    tx: DbExecutor,
    targets: Map<string, AllocationTarget>,
    allocations: Array<{ documentId: string; amount: string }>,
    currency: string,
  ): Promise<void> {
    for (const a of allocations) {
      const target = targets.get(a.documentId)!;
      const allocated = Money.of(target.allocatedAmount, currency).add(
        Money.parse(a.amount, currency),
      );
      const status = deriveDocumentStatus(Money.of(target.total, currency), allocated);
      await tx
        .update(invoices)
        .set({ allocatedAmount: allocated.toString(), status })
        .where(eq(invoices.id, target.id));
      target.allocatedAmount = allocated.toString();
      target.status = status;
    }
  }

  /** Reverses allocations (payment void): decreases `allocated_amount` and recomputes status. */
  async releaseFromTargets(
    tx: DbExecutor,
    companyId: string,
    allocations: Array<{ invoiceId: string; amount: string }>,
    currency: string,
  ): Promise<void> {
    const targets = await this.lockTargets(
      tx,
      companyId,
      allocations.map((a) => a.invoiceId),
    );
    for (const a of allocations) {
      const target = targets.get(a.invoiceId)!;
      const allocated = Money.of(target.allocatedAmount, currency).subtract(
        Money.of(a.amount, currency),
      );
      await tx
        .update(invoices)
        .set({
          allocatedAmount: allocated.toString(),
          status: deriveDocumentStatus(Money.of(target.total, currency), allocated),
        })
        .where(eq(invoices.id, target.id));
      target.allocatedAmount = allocated.toString();
    }
  }

  // --------------------------------------------------------------- internals

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(invoices),
        customerCode: customers.code,
        customerName: customers.name,
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${invoices.journalEntryId})`,
        openDisputes: sql<number>`(select count(*)::int from invoice_disputes d where d.invoice_id = ${invoices.id} and d.status in ('OPEN', 'INVESTIGATING'))`,
        deliveryNumber: sql<
          string | null
        >`(select document_number from deliveries dl where dl.id = ${invoices.deliveryId})`,
        salesOrderNumber: sql<
          string | null
        >`(select document_number from orders o where o.id = ${invoices.salesOrderId})`,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId));
  }

  // ------------------------------------------------------- Prompt #6 helpers

  /** Due date from the named payment term, falling back to the customer's net days. */
  private async dueDate(
    tx: DbExecutor,
    companyId: string,
    documentDate: string,
    paymentTermId: string | null,
    fallbackDays: number,
  ): Promise<string> {
    if (!paymentTermId) return addDays(documentDate, fallbackDays);
    const term = await this.config.paymentTerm(companyId, paymentTermId, tx);
    return dueDateFor(documentDate, term);
  }

  private workflowRef(companyId: string, doc: Invoice, requestedBy: string) {
    return {
      companyId,
      documentType: 'INVOICE' as const,
      documentId: doc.id,
      documentNumber: doc.documentNumber,
      amount: doc.total,
      currency: doc.currency,
      requestedBy,
    };
  }

  /** Credit policy for invoices / debit notes: BLOCK throws, the rest become warnings on the document. */
  private async runCreditPolicy(
    tx: DbExecutor,
    companyId: string,
    doc: Invoice,
  ): Promise<InvoiceWarning[]> {
    if (!isDebitDocument(doc.documentType)) return [];
    const customer = await this.customersService.getOrThrow(companyId, doc.customerId, tx);
    const result = await this.credit.check(tx, companyId, customer, 'INVOICE', doc.total, {
      excludeDocumentId: doc.id,
    });
    await this.credit.notifyOverLimit(tx, companyId, customer, result.summary);
    return result.findings.map((f: CreditFinding) => ({
      code: 'CREDIT_RULE' as const,
      message: `${f.rule}: ${f.message}`,
      details: { action: f.action, trigger: f.trigger, ...f.details },
    }));
  }

  /** Links a draft invoice to a delivered delivery and records the invoiced quantities per delivery line. */
  private async consumeDelivery(
    tx: DbExecutor,
    companyId: string,
    deliveryId: string,
    salesOrderId: string | null,
    customerId: string,
    lines: Array<{ orderLineId: string | null; quantity: string }>,
    currency: string,
  ): Promise<void> {
    const [delivery] = await tx
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, companyId)))
      .for('update');
    if (!delivery) throw new NotFoundError('Delivery', deliveryId);
    if (delivery.status !== 'DELIVERED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${delivery.documentNumber} is ${delivery.status}; only delivered deliveries can be invoiced.`,
      );
    if (
      delivery.customerId !== customerId ||
      (salesOrderId && delivery.salesOrderId !== salesOrderId)
    )
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${delivery.documentNumber} belongs to a different customer or sales order.`,
      );
    const dlines = await tx
      .select()
      .from(deliveryLines)
      .where(eq(deliveryLines.deliveryId, deliveryId));
    const byOrderLine = new Map(dlines.map((l) => [l.orderLineId, l]));
    for (const line of lines) {
      if (!line.orderLineId) continue;
      const dl = byOrderLine.get(line.orderLineId);
      if (!dl) continue;
      const remaining = Money.of(dl.quantity, currency).subtract(
        Money.of(dl.invoicedQuantity, currency),
      );
      if (Money.of(line.quantity, currency).greaterThan(remaining))
        throw new BusinessRuleError(
          ErrorCodes.ORDER_LINE_OVERFULFILLED,
          `${delivery.documentNumber} line ${dl.lineNumber}: only ${remaining.toString()} left to invoice.`,
        );
      await tx
        .update(deliveryLines)
        .set({ invoicedQuantity: sql`${deliveryLines.invoicedQuantity} + ${line.quantity}` })
        .where(eq(deliveryLines.id, dl.id));
    }
  }

  private async releaseDelivery(tx: DbExecutor, invoiceId: string): Promise<void> {
    const rows = await tx
      .select({
        orderLineId: invoiceLines.orderLineId,
        quantity: invoiceLines.quantity,
        deliveryId: invoices.deliveryId,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(eq(invoiceLines.invoiceId, invoiceId));
    for (const r of rows) {
      if (!r.orderLineId || !r.deliveryId) continue;
      await tx
        .update(deliveryLines)
        .set({
          invoicedQuantity: sql`GREATEST(${deliveryLines.invoicedQuantity} - ${r.quantity}, 0)`,
        })
        .where(
          and(
            eq(deliveryLines.deliveryId, r.deliveryId),
            eq(deliveryLines.orderLineId, r.orderLineId),
          ),
        );
    }
  }

  /** Cost already relieved by the delivery, recorded on the invoice lines for margin reporting. */
  private async copyDeliveryCosts(
    tx: DbExecutor,
    deliveryId: string,
    lines: InvoiceLine[],
    baseCurrency: string,
  ): Promise<void> {
    const dlines = await tx
      .select()
      .from(deliveryLines)
      .where(eq(deliveryLines.deliveryId, deliveryId));
    for (const line of lines) {
      const dl = dlines.find((d) => d.orderLineId === line.orderLineId);
      if (!dl?.costAmount || !line.orderLineId) continue;
      const share = Money.of(dl.costAmount, baseCurrency)
        .multiply(line.quantity)
        .divide(dl.quantity);
      await tx
        .update(invoiceLines)
        .set({ costAmount: share.toString() })
        .where(eq(invoiceLines.id, line.id));
    }
  }

  private async notify(
    tx: DbExecutor,
    companyId: string,
    doc: Invoice,
    input: {
      eventType: 'INVOICE_APPROVED' | 'INVOICE_POSTED' | 'APPROVAL_REQUIRED';
      title: string;
      body: string;
      permission?: string;
      userIds?: string[];
    },
  ): Promise<void> {
    const [company] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) return;
    await this.notifications.notify(
      {
        organizationId: company.organizationId,
        eventType: input.eventType,
        title: input.title,
        body: input.body,
        link: `/receivables/invoices/${doc.id}`,
        entityType: 'Invoice',
        entityId: doc.id,
        userIds: input.userIds,
        permission: input.permission,
        companyId,
        dedupeKey: `${input.eventType}:${doc.id}`,
      },
      tx,
    );
  }

  private async notifyApprovers(tx: DbExecutor, companyId: string, doc: Invoice): Promise<void> {
    await this.notify(tx, companyId, doc, {
      eventType: 'APPROVAL_REQUIRED',
      title: `${labelFor(doc.documentType)} ${doc.documentNumber} awaits approval`,
      body: `${doc.currency} ${doc.total} submitted for approval.`,
      permission: P['invoice.approve'],
    });
  }

  private decorate<
    T extends Invoice & {
      customerCode: string;
      customerName: string;
      journalNumber: string | null;
    },
  >(row: T, today: string): T & { balance: string; daysOverdue: number } {
    const open = OPEN_DOCUMENT_STATUSES.includes(row.status) && row.accountingStatus === 'POSTED';
    const balance = open
      ? Money.of(row.total, row.currency)
          .subtract(Money.of(row.allocatedAmount, row.currency))
          .toString()
      : '0.0000';
    const overdue =
      open && isDebitDocument(row.documentType) && row.dueDate < today
        ? daysBetween(row.dueDate, today)
        : 0;
    return { ...row, balance, daysOverdue: overdue };
  }

  private async lines(invoiceId: string) {
    const rows = await this.db.query.invoiceLines.findMany({
      where: (l, ops) => ops.eq(l.invoiceId, invoiceId),
      orderBy: (l, ops) => ops.asc(l.lineNumber),
    });
    const accountRows = rows.length
      ? await this.db.query.accounts.findMany({
          where: (a, ops) => ops.inArray(a.id, [...new Set(rows.map((r) => r.accountId))]),
        })
      : [];
    const byId = new Map(accountRows.map((a) => [a.id, a]));
    return rows.map((l) => ({
      ...l,
      accountCode: byId.get(l.accountId)?.code ?? '',
      accountName: byId.get(l.accountId)?.name ?? '',
    }));
  }

  private async allocations(
    companyId: string,
    id: string,
    documentType: SubledgerDocumentType,
  ): Promise<AllocationView[]> {
    const where =
      documentType === 'CREDIT_NOTE'
        ? eq(paymentAllocations.creditNoteId, id)
        : eq(paymentAllocations.invoiceId, id);
    const rows = await this.db
      .select({
        id: paymentAllocations.id,
        amount: paymentAllocations.amount,
        allocationDate: paymentAllocations.allocationDate,
        paymentId: paymentAllocations.paymentId,
        paymentNumber: customerPayments.documentNumber,
        creditNoteId: paymentAllocations.creditNoteId,
        creditNoteNumber: sql<
          string | null
        >`(select document_number from invoices c where c.id = ${paymentAllocations.creditNoteId})`,
        invoiceId: paymentAllocations.invoiceId,
        invoiceNumber: invoices.documentNumber,
      })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .leftJoin(customerPayments, eq(customerPayments.id, paymentAllocations.paymentId))
      .where(and(eq(paymentAllocations.companyId, companyId), where))
      .orderBy(asc(paymentAllocations.allocationDate), asc(paymentAllocations.createdAt));
    return rows;
  }

  /** Order-line quantities consumed by this document's lines. */
  private async orderLinesOf(
    tx: DbExecutor,
    invoiceId: string,
  ): Promise<Array<{ orderLineId: string; quantity: string }>> {
    const rows = await tx
      .select({ orderLineId: invoiceLines.orderLineId, quantity: invoiceLines.quantity })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId));
    return rows
      .filter((r): r is { orderLineId: string; quantity: string } => Boolean(r.orderLineId))
      .map((r) => ({ orderLineId: r.orderLineId, quantity: r.quantity }));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<Invoice> {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Invoice', id);
    return row;
  }

  /** Outbound webhook payload: identifiers and amounts only, never line-level PII. */
  private eventPayload(doc: Invoice): Record<string, unknown> {
    return {
      invoiceId: doc.id,
      documentNumber: doc.documentNumber,
      documentType: doc.documentType,
      customerId: doc.customerId,
      documentDate: doc.documentDate,
      dueDate: doc.dueDate,
      currency: doc.currency,
      total: doc.total,
      status: doc.status,
      accountingStatus: doc.accountingStatus,
      reference: doc.reference,
    };
  }

  private assertStatus(doc: Invoice, allowed: Invoice['status'][], verb: string): void {
    if (!allowed.includes(doc.status)) {
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${doc.documentNumber} cannot be ${verb} from status ${doc.status}.`,
        { status: doc.status, allowed },
      );
    }
  }

  private async assertLineAccounts(
    companyId: string,
    accountIds: string[],
    tx: DbExecutor,
  ): Promise<void> {
    const rows = await this.accounts.findByIds(companyId, [...new Set(accountIds)], tx);
    const byId = new Map(rows.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const account = byId.get(id);
      if (!account)
        throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'A line references an unknown account.');
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be used on document lines.`,
        );
    }
  }

  private async creditLimitWarnings(
    companyId: string,
    customerId: string,
    doc: Invoice,
    tx: DbExecutor,
  ): Promise<InvoiceWarning[]> {
    if (!isDebitDocument(doc.documentType)) return [];
    const customer = await this.customersService.getOrThrow(companyId, customerId, tx);
    if (!customer.creditLimit) return [];
    const balances = await this.customersService.balances(companyId, [customerId], tx);
    // Exposure = posted net balance + every unposted (draft/approved) invoice and debit note, including this one.
    const [pending] = await tx
      .select({ total: sql<string>`coalesce(sum(${invoices.total}), 0)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.customerId, customerId),
          eq(invoices.accountingStatus, 'UNPOSTED'),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.status} <> 'VOID'`,
        ),
      );
    const exposure = Money.of(balances.get(customerId)!.net, doc.currency).add(
      Money.of(pending?.total ?? '0', doc.currency),
    );
    const limit = Money.of(customer.creditLimit, doc.currency);
    if (exposure.greaterThan(limit)) {
      return [
        {
          code: 'CREDIT_LIMIT_EXCEEDED',
          message: `Customer exposure ${exposure.toString()} exceeds the credit limit ${limit.toString()}.`,
          details: { exposure: exposure.toString(), creditLimit: limit.toString() },
        },
      ];
    }
    return [];
  }
}

function labelFor(type: SubledgerDocumentType): string {
  return type === 'INVOICE' ? 'Invoice' : type === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note';
}
