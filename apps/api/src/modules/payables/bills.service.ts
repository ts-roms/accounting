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
  CreateBillInput,
  ListDocumentsQuery,
  UpdateBillInput,
  VoidDocumentInput,
} from '@accounting/validation';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { SodService } from '@/modules/rbac/sod.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  vendors,
  billLines,
  billHolds,
  companies,
  vendorBills,
  journalEntries,
  vendorPaymentAllocations,
  vendorPayments,
  type VendorBill,
  type BillLine,
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
import { MatchingService } from '@/modules/orders/matching.service';
import { OrderFulfillmentService } from '@/modules/orders/order-fulfillment.service';
import { VendorsService } from './vendors.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { TaxEngineService } from '@/modules/tax/tax-engine.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { businessToday } from '@/common/time/clock';
import { ApConfigService } from './ap-config.service';
import { discountAvailable, discountWindowFor } from './payables.logic';

const MODULE = 'PAYABLES';
const NUMBER_TYPE: Record<SubledgerDocumentType, DocumentType> = {
  INVOICE: 'BILL',
  CREDIT_NOTE: 'VCN',
  DEBIT_NOTE: 'VDN',
};

export interface BillWarning {
  code: 'POSSIBLE_DUPLICATE_BILL';
  message: string;
  details: Record<string, string>;
}

export interface BillView extends VendorBill {
  vendorCode: string;
  vendorName: string;
  journalNumber: string | null;
  balance: string;
  daysOverdue: number;
  /** Early-payment discount still obtainable today (Prompt #7). */
  discountAvailableToday: string;
  purchaseOrderNumber: string | null;
  activeHoldReason: string | null;
}

export interface AllocationView {
  id: string;
  amount: string;
  allocationDate: string;
  paymentId: string | null;
  paymentNumber: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  billId: string;
  billNumber: string;
}

export interface BillDetail extends BillView {
  lines: Array<BillLine & { accountCode: string; accountName: string }>;
  /** Settlements applied TO this document (for bills) or BY this document (for credit notes). */
  allocations: AllocationView[];
  warnings?: BillWarning[];
}

/**
 * Vendor vendorBills, credit notes and debit notes. Business status
 * (DRAFT/APPROVED/PARTIALLY_PAID/PAID/VOID) is independent from the accounting
 * status (UNPOSTED/POSTED/REVERSED); posting always goes through the
 * AccountingPostingService with the mapped AR control account.
 */
@Injectable()
export class BillsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly vendorsService: VendorsService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly matching: MatchingService,
    private readonly stock: DocumentStockService,
    private readonly inventory: InventoryService,
    private readonly tax: TaxEngineService,
    private readonly dimensions: DimensionsService,
    private readonly rates: ExchangeRatesService,
    private readonly fx: FxService,
    private readonly authority: AuthorityService,
    private readonly sod: SodService,
    private readonly approvals: ApprovalsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: ApConfigService,
  ) {}

  // ----------------------------------------------------------------- queries

  async list(companyId: string, query: ListDocumentsQuery): Promise<PaginatedResult<BillView>> {
    const today = businessToday();
    const filters: SQL[] = [eq(vendorBills.companyId, companyId)];
    if (query.partyId) filters.push(eq(vendorBills.vendorId, query.partyId));
    if (query.documentType) filters.push(eq(vendorBills.documentType, query.documentType));
    if (query.status) filters.push(eq(vendorBills.status, query.status));
    if (query.from) filters.push(gte(vendorBills.documentDate, query.from));
    if (query.to) filters.push(lte(vendorBills.documentDate, query.to));
    if (query.openOnly)
      filters.push(
        inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
        eq(vendorBills.accountingStatus, 'POSTED'),
      );
    if (query.overdueOnly)
      filters.push(
        inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
        sql`${vendorBills.dueDate} < ${today}`,
        inArray(vendorBills.documentType, ['INVOICE', 'DEBIT_NOTE']),
      );
    if (query.onHold !== undefined) filters.push(eq(vendorBills.onHold, query.onHold));
    if (query.purchaseOrderId) filters.push(eq(vendorBills.purchaseOrderId, query.purchaseOrderId));
    if (query.vendorGroupId) filters.push(eq(vendors.vendorGroupId, query.vendorGroupId));
    if (query.branchId) filters.push(eq(vendorBills.branchId, query.branchId));
    if (query.discountAvailableOnly)
      filters.push(
        inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
        eq(vendorBills.accountingStatus, 'POSTED'),
        sql`${vendorBills.discountDate} >= ${query.asOf ?? today}`,
        sql`${vendorBills.discountAmount} > ${vendorBills.discountTakenAmount}`,
      );
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(vendorBills.documentNumber, term),
          ilike(vendorBills.reference, term),
          ilike(vendorBills.description, term),
          ilike(vendorBills.vendorInvoiceNumber, term),
          ilike(vendors.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'dueDate'
        ? vendorBills.dueDate
        : query.sortBy === 'total'
          ? vendorBills.total
          : query.sortBy === 'documentNumber'
            ? vendorBills.documentNumber
            : vendorBills.documentDate;
    const direction = query.sortDir === 'asc' ? asc : desc;

    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(sortColumn), desc(vendorBills.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(vendorBills)
        .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
        .where(where),
    ]);
    return toPaginatedResult(
      rows.map((r) => this.decorate(r, today)),
      Number(countRows[0]?.total ?? 0),
      query,
    );
  }

  async get(companyId: string, id: string): Promise<BillDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(vendorBills.id, id), eq(vendorBills.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('VendorBill', id);
    const [lines, allocations] = await Promise.all([
      this.lines(id),
      this.allocations(companyId, row.id, row.documentType),
    ]);
    return { ...this.decorate(row, businessToday()), lines, allocations };
  }

  // ---------------------------------------------------------------- commands

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBillInput,
  ): Promise<BillDetail> {
    const { id, warnings } = await this.db.transaction((tx) =>
      this.createInTx(tx, companyId, actor, input),
    );
    return { ...(await this.get(companyId, id)), warnings };
  }

  /**
   * Creates the document inside the caller's transaction (used by purchase
   * orders and returns so the order counters, the match and the bill commit together).
   */
  async createInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBillInput,
  ): Promise<{ id: string; warnings: BillWarning[] }> {
    {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: vendorBills.id })
          .from(vendorBills)
          .where(
            and(
              eq(vendorBills.companyId, companyId),
              eq(vendorBills.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return { id: existing.id, warnings: [] as BillWarning[] };
      }
      const vendor = await this.vendorsService.assertUsable(companyId, input.vendorId, tx, 'bill');
      const settings = await this.config.settings(companyId, tx);
      const currency = vendor.currency;
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
        'PURCHASES',
        input.documentDate,
        currency,
        lines,
      );
      const total = subtotal.add(taxed.totals.taxTotal).subtract(taxed.totals.withholdingTotal);
      const baseTotal = total.convert(baseCurrency, exchangeRate);
      await this.posting.resolvePeriod(tx, companyId, input.documentDate, { draft: true });
      // Due date and early-payment window: named term (bill / vendor / company default) or the vendor's net days.
      // The company default term is applied to new vendors on creation; here the vendor's own term (or net days) decides.
      const paymentTermId = input.paymentTermId ?? vendor.paymentTermId ?? null;
      const term = paymentTermId
        ? await this.config.paymentTerm(companyId, paymentTermId, tx)
        : null;
      const window = term
        ? discountWindowFor(input.documentDate, total.toString(), currency, term)
        : null;
      const dueDate =
        input.dueDate ?? window?.dueDate ?? addDays(input.documentDate, vendor.paymentTermsDays);
      const discountDate = isDebitDocument(input.documentType)
        ? (window?.discountDate ?? null)
        : null;
      const discountAmount = discountDate ? window!.discountAmount : '0';
      if (
        settings.requirePoForStockBills &&
        !input.purchaseOrderId &&
        lines.some((l) => l.productId)
      )
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Bills for stocked products must reference a purchase order (AP policy).',
        );
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

      const warnings = await this.duplicateWarnings(
        companyId,
        vendor.id,
        subtotal.toString(),
        input.documentDate,
        tx,
      );
      if (input.purchaseOrderId) {
        await this.fulfillment.consume(
          tx,
          companyId,
          input.purchaseOrderId,
          'BILLING',
          lines
            .filter((l) => l.orderLineId)
            .map((l) => ({ orderLineId: l.orderLineId!, quantity: l.quantity })),
          { expectedType: 'PURCHASE_ORDER', partyId: vendor.id },
        );
      } else if (lines.some((l) => l.orderLineId)) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Lines reference order lines but no purchase order is set.',
        );
      }
      let created: VendorBill | undefined;
      try {
        [created] = await tx
          .insert(vendorBills)
          .values({
            companyId,
            vendorId: vendor.id,
            branchId: input.branchId ?? null,
            purchaseOrderId: input.purchaseOrderId ?? null,
            documentType: input.documentType,
            documentNumber,
            documentDate: input.documentDate,
            dueDate,
            reference: input.reference ?? null,
            description: input.description ?? null,
            vendorInvoiceNumber: input.vendorInvoiceNumber ?? null,
            scheduledPaymentDate: input.scheduledPaymentDate ?? null,
            paymentTermId,
            discountDate,
            discountAmount,
            goodsReceiptId: input.goodsReceiptId ?? null,
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
      } catch (err) {
        if (isUniqueViolation(err, 'vendor_bills_vendor_invoice_uq')) {
          throw new BusinessRuleError(
            ErrorCodes.DUPLICATE_VENDOR_INVOICE,
            `Supplier invoice ${input.vendorInvoiceNumber} was already recorded for ${vendor.name}.`,
            { vendorInvoiceNumber: input.vendorInvoiceNumber },
          );
        }
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await tx
        .insert(billLines)
        .values(lines.map((l, i) => ({ ...l, ...taxed.lines[i]!, billId: created.id })));
      if (created.documentType === 'INVOICE') {
        await this.matching.evaluateBill(tx, companyId, created.id, warnings.length > 0);
      }
      if (warnings.length && settings.blockDuplicateVendorInvoice && input.vendorInvoiceNumber)
        throw new BusinessRuleError(
          ErrorCodes.DUPLICATE_VENDOR_INVOICE,
          warnings[0]!.message,
          warnings[0]!.details,
        );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: created.id,
          newValue: {
            documentNumber,
            documentType: created.documentType,
            vendorId: vendor.id,
            total: created.total,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bill.created',
        companyId,
        dedupeKey: 'bill.created:' + created.id,
        payload: this.eventPayload(created, vendor.code),
      });
      return { id: created.id, warnings };
    }
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateBillInput,
  ): Promise<BillDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'edited');
      const vendor = await this.vendorsService.getOrThrow(
        companyId,
        input.vendorId ?? existing.vendorId,
        tx,
      );
      const documentDate = input.documentDate ?? existing.documentDate;
      await this.posting.resolvePeriod(tx, companyId, documentDate, { draft: true });
      if (vendor.currency !== existing.currency) {
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `${existing.documentNumber} is in ${existing.currency}; the vendor is billed in ${vendor.currency}.`,
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
          'PURCHASES',
          documentDate,
          existing.currency,
          lines,
        );
        if (existing.purchaseOrderId) {
          await this.fulfillment.release(
            tx,
            existing.purchaseOrderId,
            'BILLING',
            await this.orderLinesOf(tx, id),
          );
          await this.fulfillment.consume(
            tx,
            companyId,
            existing.purchaseOrderId,
            'BILLING',
            lines
              .filter((l) => l.orderLineId)
              .map((l) => ({ orderLineId: l.orderLineId!, quantity: l.quantity })),
            { expectedType: 'PURCHASE_ORDER', partyId: vendor.id },
          );
        }
        await tx.delete(billLines).where(eq(billLines.billId, id));
        await tx
          .insert(billLines)
          .values(lines.map((l, i) => ({ ...l, ...taxed.lines[i]!, billId: id })));
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
      const dueDate =
        input.dueDate ??
        (input.documentDate ? addDays(documentDate, vendor.paymentTermsDays) : existing.dueDate);
      if (dueDate < documentDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Due date cannot be before the document date.',
        );
      await tx
        .update(vendorBills)
        .set({
          vendorId: vendor.id,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          documentDate,
          dueDate,
          reference: input.reference === undefined ? existing.reference : input.reference,
          description: input.description === undefined ? existing.description : input.description,
          vendorInvoiceNumber:
            input.vendorInvoiceNumber === undefined
              ? existing.vendorInvoiceNumber
              : input.vendorInvoiceNumber,
          scheduledPaymentDate:
            input.scheduledPaymentDate === undefined
              ? existing.scheduledPaymentDate
              : input.scheduledPaymentDate,
          exchangeRate,
          baseTotal: Money.of(totals.total, existing.currency)
            .convert(baseCurrency, exchangeRate)
            .toString(),
          ...totals,
        })
        .where(eq(vendorBills.id, id));
      if (existing.documentType === 'INVOICE') {
        await this.matching.evaluateBill(tx, companyId, id);
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: id,
          // Header before / after: the audit service derives the field-level history from it.
          previousValue: {
            vendorId: existing.vendorId,
            branchId: existing.branchId,
            documentDate: existing.documentDate,
            dueDate: existing.dueDate,
            reference: existing.reference,
            description: existing.description,
            vendorInvoiceNumber: existing.vendorInvoiceNumber,
            subtotal: existing.subtotal,
            taxTotal: existing.taxTotal,
            total: existing.total,
          },
          newValue: {
            vendorId: vendor.id,
            branchId: input.branchId === undefined ? existing.branchId : input.branchId,
            documentDate,
            dueDate,
            reference: input.reference === undefined ? existing.reference : input.reference,
            description: input.description === undefined ? existing.description : input.description,
            vendorInvoiceNumber:
              input.vendorInvoiceNumber === undefined
                ? existing.vendorInvoiceNumber
                : input.vendorInvoiceNumber,
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
      if (existing.purchaseOrderId) {
        await this.fulfillment.release(
          tx,
          existing.purchaseOrderId,
          'BILLING',
          await this.orderLinesOf(tx, id),
        );
      }
      await tx.delete(vendorBills).where(eq(vendorBills.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber, total: existing.total },
          companyId,
        },
        tx,
      );
    });
  }

  async approve(companyId: string, actor: AuthenticatedUser, id: string): Promise<BillDetail> {
    const warnings = await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED'], 'approved');
      await this.vendorsService.assertUsable(companyId, existing.vendorId, tx, 'bill');
      // Delegated authority (if any) is validated and recorded in this transaction.
      const authority = await this.authority.assert(tx, actor, P['bill.approve'], {
        companyId,
        branchId: existing.branchId,
        amount: existing.total,
        currency: existing.currency,
        documentType: 'VENDOR_BILL',
        documentId: id,
        documentNumber: existing.documentNumber,
        createdBy: existing.createdBy,
        action: 'Approved vendor bill',
      });
      // Workflow-gated: a matching approval chain must be complete before the bill is approved.
      await this.approvals.assertApproved(tx, {
        companyId,
        documentType: 'VENDOR_BILL',
        documentId: id,
        documentNumber: existing.documentNumber,
        amount: existing.total,
        currency: existing.currency,
        requestedBy: existing.createdBy ?? actor.id,
        branchId: existing.branchId,
      });
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['bill.create'], P['bill.approve']],
        existing.createdBy,
        actor.id,
        tx,
        {
          companyId,
          entityType: 'VendorBill',
          entityId: id,
          documentNumber: existing.documentNumber,
        },
      );
      await tx
        .update(vendorBills)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(vendorBills.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: existing.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bill.approved',
        companyId,
        dedupeKey: 'bill.approved:' + id,
        payload: { ...this.eventPayload(existing), status: 'APPROVED', approvedBy: actor.email },
      });
      if (existing.createdBy && existing.createdBy !== actor.id)
        await this.notify(tx, companyId, existing, {
          eventType: 'BILL_APPROVED',
          title: `${labelFor(existing.documentType)} ${existing.documentNumber} approved`,
          body: `Approved by ${actor.email}; it can now be posted.`,
          userIds: [existing.createdBy],
        });
      return [] as BillWarning[];
    });
    return { ...(await this.get(companyId, id)), warnings };
  }

  /**
   * DRAFT -> SUBMITTED: opens the approval workflow when one matches the amount
   * and tells approvers (Prompt #7). Approval itself stays an explicit step.
   */
  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<BillDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'submitted');
      await this.vendorsService.assertUsable(companyId, existing.vendorId, tx, 'bill');
      await this.approvals.open(tx, this.workflowRef(companyId, existing, actor.id));
      await tx
        .update(vendorBills)
        .set({ status: 'SUBMITTED', submittedBy: actor.id, submittedAt: new Date() })
        .where(eq(vendorBills.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED' },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bill.submitted',
        companyId,
        dedupeKey: 'bill.submitted:' + id,
        payload: { ...this.eventPayload(existing), status: 'SUBMITTED', submittedBy: actor.email },
      });
      await this.notify(tx, companyId, existing, {
        eventType: 'BILL_APPROVAL_REQUIRED',
        title: `${labelFor(existing.documentType)} ${existing.documentNumber} awaits approval`,
        body: `${existing.currency} ${existing.total} from ${existing.vendorInvoiceNumber ?? 'the vendor'} submitted by ${actor.email}.`,
        permission: P['bill.approve'],
      });
    });
    return this.get(companyId, id);
  }

  /** Posts the accounting effect: Dr AR / Cr revenue lines (credit notes mirror it). Idempotent. */
  async post(companyId: string, actor: AuthenticatedUser, id: string): Promise<BillDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.accountingStatus === 'POSTED') return;
      this.assertStatus(existing, ['APPROVED'], 'posted');
      const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_PAYABLE', tx);
      const vendor = await this.vendorsService.getOrThrow(companyId, existing.vendorId, tx);
      const lines = await tx
        .select()
        .from(billLines)
        .where(eq(billLines.billId, id))
        .orderBy(asc(billLines.lineNumber));
      const debitSide = isDebitDocument(existing.documentType);
      // Foreign-currency bills post in base at the document rate; the control carries the exact sum.
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
      // Stocked product lines post to inventory / GRNI / PPV instead of the expense account (Phase 5).
      const stock = await this.stock.postPurchaseLines(tx, {
        companyId,
        sourceId: existing.id,
        movementDate: existing.documentDate,
        actorId: actor.id,
        currency: baseCurrency,
        isCreditNote: !debitSide,
        lines: baseLines,
      });
      for (const [lineId, cost] of stock.costByLine) {
        await tx
          .update(billLines)
          .set({ costAmount: cost.toString() })
          .where(eq(billLines.id, lineId));
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
          sourceType: 'AP_DOCUMENT',
          sourceId: existing.id,
          actor,
          lines: [
            // Bills and debit notes credit the AP control account; vendor credit notes debit it.
            {
              accountId: control.id,
              debit: debitSide ? '0' : baseTotal.toString(),
              credit: debitSide ? baseTotal.toString() : '0',
              description: `${existing.documentNumber} - vendor payable`,
            },
            ...stock.postingLines,
            ...(await this.tax.postingLines(
              tx,
              companyId,
              'PURCHASES',
              baseCurrency,
              baseLines,
              !debitSide,
            )),
          ],
        },
        { permission: P['bill.post'] },
      );
      await this.inventory.setJournal(tx, stock.movementIds, entry.id);
      await this.tax.record(
        tx,
        {
          companyId,
          side: 'PURCHASES',
          sourceType: 'AP_DOCUMENT',
          sourceId: existing.id,
          documentNumber: existing.documentNumber,
          journalEntryId: entry.id,
          transactionDate: existing.documentDate,
          party: { id: vendor.id, name: vendor.name, taxNumber: vendor.taxIdentificationNumber },
          negate: !debitSide,
        },
        baseLines,
        baseCurrency,
      );
      await tx
        .update(vendorBills)
        .set({
          baseTotal: baseTotal.toString(),
          accountingStatus: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(vendorBills.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'VendorBill',
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
        eventType: existing.documentType === 'CREDIT_NOTE' ? 'vendor_credit.posted' : 'bill.posted',
        companyId,
        dedupeKey: 'bill.posted:' + id,
        payload: {
          ...this.eventPayload(existing, vendor.code),
          accountingStatus: 'POSTED',
          journalEntryId: entry.id,
          journalNumber: entry.documentNumber,
        },
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
  ): Promise<BillDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(
        existing,
        ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_PAID', 'PAID'],
        'voided',
      );
      await this.approvals.cancelFor(tx, 'VENDOR_BILL', id);
      if (existing.onHold)
        await tx
          .update(billHolds)
          .set({
            status: 'RELEASED',
            releasedBy: actor.id,
            releasedAt: new Date(),
            releaseNote: 'Bill voided',
          })
          .where(and(eq(billHolds.billId, id), eq(billHolds.status, 'ACTIVE')));
      await this.outbox.enqueue(tx, {
        eventType: 'bill.voided',
        companyId,
        dedupeKey: 'bill.voided:' + id,
        payload: { ...this.eventPayload(existing), reason: input.reason },
      });
      if (!Money.of(existing.allocatedAmount, existing.currency).isZero()) {
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_HAS_ALLOCATIONS,
          'Remove the payments or credits applied to this document before voiding it.',
        );
      }
      if (existing.documentType === 'CREDIT_NOTE') {
        const [applied] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(vendorPaymentAllocations)
          .where(eq(vendorPaymentAllocations.creditNoteId, id));
        if (Number(applied?.n ?? 0) > 0)
          throw new BusinessRuleError(
            ErrorCodes.DOCUMENT_HAS_ALLOCATIONS,
            'This credit note has been applied to bills and cannot be voided.',
          );
      }
      let reversalId: string | null = null;
      if (existing.accountingStatus === 'POSTED' && existing.journalEntryId) {
        const reversalDate = input.reversalDate ?? existing.documentDate;
        const stockReversal = await this.inventory.reverseDocument(
          tx,
          companyId,
          'AP_DOCUMENT',
          existing.id,
          'AP_DOCUMENT_VOID',
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
            sourceType: 'AP_DOCUMENT_VOID',
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
          { permission: P['bill.void'] },
        );
        await tx
          .update(journalEntries)
          .set({ status: 'REVERSED', reversedById: reversal.id })
          .where(eq(journalEntries.id, existing.journalEntryId));
        await this.inventory.setJournal(tx, stockReversal.movementIds, reversal.id);
        await this.tax.reverse(
          tx,
          'AP_DOCUMENT',
          existing.id,
          reversal.id,
          reversalDate,
          existing.currency,
        );
        reversalId = reversal.id;
      }
      if (existing.purchaseOrderId) {
        await this.fulfillment.release(
          tx,
          existing.purchaseOrderId,
          'BILLING',
          await this.orderLinesOf(tx, id),
        );
      }
      await tx
        .update(vendorBills)
        .set({
          status: 'VOID',
          accountingStatus: reversalId ? 'REVERSED' : existing.accountingStatus,
          reversalJournalEntryId: reversalId,
          voidReason: input.reason,
          voidedBy: actor.id,
          voidedAt: new Date(),
        })
        .where(eq(vendorBills.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'VOID', reversalJournalEntryId: reversalId },
          metadata: { documentNumber: existing.documentNumber, reason: input.reason },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Payment scheduling: when the bill is planned to be paid. */
  async updateSchedule(
    companyId: string,
    id: string,
    scheduledPaymentDate: string | null,
  ): Promise<BillDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      await tx.update(vendorBills).set({ scheduledPaymentDate }).where(eq(vendorBills.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: id,
          previousValue: { scheduledPaymentDate: existing.scheduledPaymentDate },
          newValue: { scheduledPaymentDate },
          metadata: { documentNumber: existing.documentNumber, kind: 'schedule' },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Applies an open credit note against the vendor's open bills (no ledger effect: both are already posted to AR). */
  async applyCreditNote(
    companyId: string,
    actor: AuthenticatedUser,
    creditNoteId: string,
    input: AllocateInput,
    allocationDate = businessToday(),
  ): Promise<BillDetail> {
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
        note.vendorId,
        available,
        note.currency,
      );
      await tx.insert(vendorPaymentAllocations).values(
        input.allocations.map((a) => ({
          companyId,
          billId: a.documentId,
          creditNoteId: note.id,
          amount: Money.parse(a.amount, note.currency).toString(),
          allocationDate,
          createdBy: actor.id,
        })),
      );
      await this.applyToTargets(tx, targets, input.allocations, note.currency);
      const newAllocated = Money.of(note.allocatedAmount, note.currency).add(applied);
      await tx
        .update(vendorBills)
        .set({
          allocatedAmount: newAllocated.toString(),
          status: deriveDocumentStatus(Money.of(note.total, note.currency), newAllocated),
        })
        .where(eq(vendorBills.id, note.id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorBill',
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
        id: vendorBills.id,
        documentNumber: vendorBills.documentNumber,
        documentType: vendorBills.documentType,
        status: vendorBills.status,
        accountingStatus: vendorBills.accountingStatus,
        partyId: vendorBills.vendorId,
        total: vendorBills.total,
        allocatedAmount: vendorBills.allocatedAmount,
        currency: vendorBills.currency,
        exchangeRate: vendorBills.exchangeRate,
        matchStatus: vendorBills.matchStatus,
        paymentHold: vendorBills.onHold,
      })
      .from(vendorBills)
      .where(and(eq(vendorBills.companyId, companyId), inArray(vendorBills.id, ids)))
      .for('update');
    // A match exception or an active payment hold keeps the bill out of any settlement.
    return new Map(
      rows.map((r) => [r.id, { ...r, onHold: r.matchStatus === 'EXCEPTION' || r.paymentHold }]),
    );
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
        .update(vendorBills)
        .set({ allocatedAmount: allocated.toString(), status })
        .where(eq(vendorBills.id, target.id));
      target.allocatedAmount = allocated.toString();
      target.status = status;
    }
  }

  /** Reverses allocations (payment void): decreases `allocated_amount` and recomputes status. */
  async releaseFromTargets(
    tx: DbExecutor,
    companyId: string,
    allocations: Array<{ billId: string; amount: string }>,
    currency: string,
  ): Promise<void> {
    const targets = await this.lockTargets(
      tx,
      companyId,
      allocations.map((a) => a.billId),
    );
    for (const a of allocations) {
      const target = targets.get(a.billId)!;
      const allocated = Money.of(target.allocatedAmount, currency).subtract(
        Money.of(a.amount, currency),
      );
      await tx
        .update(vendorBills)
        .set({
          allocatedAmount: allocated.toString(),
          status: deriveDocumentStatus(Money.of(target.total, currency), allocated),
        })
        .where(eq(vendorBills.id, target.id));
      target.allocatedAmount = allocated.toString();
    }
  }

  // --------------------------------------------------------------- internals

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(vendorBills),
        vendorCode: vendors.code,
        vendorName: vendors.name,
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${vendorBills.journalEntryId})`,
        purchaseOrderNumber: sql<
          string | null
        >`(select document_number from orders o where o.id = ${vendorBills.purchaseOrderId})`,
        activeHoldReason: sql<
          string | null
        >`(select h.reason::text from bill_holds h where h.bill_id = ${vendorBills.id} and h.status = 'ACTIVE' order by h.placed_at desc limit 1)`,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId));
  }

  private eventPayload(doc: VendorBill, vendorCode?: string) {
    return {
      billId: doc.id,
      documentNumber: doc.documentNumber,
      documentType: doc.documentType,
      vendorId: doc.vendorId,
      vendorCode,
      vendorInvoiceNumber: doc.vendorInvoiceNumber,
      documentDate: doc.documentDate,
      dueDate: doc.dueDate,
      currency: doc.currency,
      total: doc.total,
      purchaseOrderId: doc.purchaseOrderId,
    };
  }

  private workflowRef(companyId: string, doc: VendorBill, requestedBy: string) {
    return {
      companyId,
      documentType: 'VENDOR_BILL' as const,
      documentId: doc.id,
      documentNumber: doc.documentNumber,
      amount: doc.total,
      currency: doc.currency,
      requestedBy,
      branchId: doc.branchId,
    };
  }

  private async notify(
    tx: DbExecutor,
    companyId: string,
    doc: VendorBill,
    input: {
      eventType: 'BILL_APPROVAL_REQUIRED' | 'BILL_APPROVED' | 'BILL_POSTED';
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
        link: `/purchasing/bills/${doc.id}`,
        entityType: 'VendorBill',
        entityId: doc.id,
        userIds: input.userIds,
        permission: input.permission,
        companyId,
        dedupeKey: `${input.eventType}:${doc.id}`,
      },
      tx,
    );
  }

  private decorate<
    T extends VendorBill & { vendorCode: string; vendorName: string; journalNumber: string | null },
  >(
    row: T,
    today: string,
  ): T & { balance: string; daysOverdue: number; discountAvailableToday: string } {
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
    const discountAvailableToday = open
      ? discountAvailable(row, today, row.currency).toString()
      : '0.0000';
    return { ...row, balance, daysOverdue: overdue, discountAvailableToday };
  }

  private async lines(billId: string) {
    const rows = await this.db.query.billLines.findMany({
      where: (l, ops) => ops.eq(l.billId, billId),
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
        ? eq(vendorPaymentAllocations.creditNoteId, id)
        : eq(vendorPaymentAllocations.billId, id);
    const rows = await this.db
      .select({
        id: vendorPaymentAllocations.id,
        amount: vendorPaymentAllocations.amount,
        allocationDate: vendorPaymentAllocations.allocationDate,
        paymentId: vendorPaymentAllocations.paymentId,
        paymentNumber: vendorPayments.documentNumber,
        creditNoteId: vendorPaymentAllocations.creditNoteId,
        creditNoteNumber: sql<
          string | null
        >`(select document_number from vendor_bills c where c.id = ${vendorPaymentAllocations.creditNoteId})`,
        billId: vendorPaymentAllocations.billId,
        billNumber: vendorBills.documentNumber,
      })
      .from(vendorPaymentAllocations)
      .innerJoin(vendorBills, eq(vendorBills.id, vendorPaymentAllocations.billId))
      .leftJoin(vendorPayments, eq(vendorPayments.id, vendorPaymentAllocations.paymentId))
      .where(and(eq(vendorPaymentAllocations.companyId, companyId), where))
      .orderBy(
        asc(vendorPaymentAllocations.allocationDate),
        asc(vendorPaymentAllocations.createdAt),
      );
    return rows;
  }

  /** Three-way match review by an approver: exceptions acknowledged, payment hold lifted. */
  async reviewMatch(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    note: string,
  ): Promise<BillDetail> {
    await this.matching.review(companyId, actor, id, note);
    return this.get(companyId, id);
  }

  /** Order-line quantities consumed by this document's lines. */
  private async orderLinesOf(
    tx: DbExecutor,
    billId: string,
  ): Promise<Array<{ orderLineId: string; quantity: string }>> {
    const rows = await tx
      .select({ orderLineId: billLines.orderLineId, quantity: billLines.quantity })
      .from(billLines)
      .where(eq(billLines.billId, billId));
    return rows
      .filter((r): r is { orderLineId: string; quantity: string } => Boolean(r.orderLineId))
      .map((r) => ({ orderLineId: r.orderLineId, quantity: r.quantity }));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<VendorBill> {
    const [row] = await tx
      .select()
      .from(vendorBills)
      .where(and(eq(vendorBills.id, id), eq(vendorBills.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('VendorBill', id);
    return row;
  }

  private assertStatus(doc: VendorBill, allowed: VendorBill['status'][], verb: string): void {
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

  /** Soft duplicate detection: same vendor, same amount, dated within 7 days of each other. */
  private async duplicateWarnings(
    companyId: string,
    vendorId: string,
    total: string,
    documentDate: string,
    tx: DbExecutor,
  ): Promise<BillWarning[]> {
    const rows = await tx
      .select({
        documentNumber: vendorBills.documentNumber,
        documentDate: vendorBills.documentDate,
        vendorInvoiceNumber: vendorBills.vendorInvoiceNumber,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.vendorId, vendorId),
          eq(vendorBills.documentType, 'INVOICE'),
          eq(vendorBills.total, total),
          sql`abs(${vendorBills.documentDate} - ${documentDate}::date) <= 7`,
          sql`${vendorBills.status} <> 'VOID'`,
        ),
      );
    return rows.map((r) => ({
      code: 'POSSIBLE_DUPLICATE_BILL' as const,
      message: `${r.documentNumber} (${r.documentDate}${r.vendorInvoiceNumber ? `, supplier no. ${r.vendorInvoiceNumber}` : ''}) has the same vendor and amount.`,
      details: { documentNumber: r.documentNumber, documentDate: r.documentDate },
    }));
  }
}

function labelFor(type: SubledgerDocumentType): string {
  return type === 'INVOICE'
    ? 'Vendor bill'
    : type === 'CREDIT_NOTE'
      ? 'Vendor credit note'
      : 'Vendor debit note';
}
