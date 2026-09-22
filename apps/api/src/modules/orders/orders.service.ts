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
  type DocumentType,
  type OrderStatus,
  type OrderType,
  type OutboundEventType,
  type PaginatedResult,
  type PermissionKey,
} from '@accounting/types';
import type {
  CancelOrderInput,
  ConvertOrderInput,
  CreateOrderInput,
  FulfilOrderInput,
  ListOrdersQuery,
  RejectOrderInput,
  UpdateOrderInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  customers,
  invoices,
  orderLines,
  orders,
  vendorBills,
  vendors,
  type Order,
  type OrderLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BillsService } from '@/modules/payables/bills.service';
import { VendorsService } from '@/modules/payables/vendors.service';
import { SodService, type SodConflict } from '@/modules/rbac/sod.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { CustomersService } from '@/modules/receivables/customers.service';
import { CreditService } from '@/modules/receivables/credit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { InvoicesService } from '@/modules/receivables/invoices.service';
import { DocumentStockService } from '@/modules/inventory/document-stock.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { businessToday } from '@/common/time/clock';
import { MatchingService } from './matching.service';
import { OrderFulfillmentService } from './order-fulfillment.service';
import {
  computeOrderLines,
  EDITABLE_STATUSES,
  labelForType,
  nextStatus,
  ORDER_RULES,
  type OrderAction,
} from './orders.logic';

const NUMBER_TYPE: Record<OrderType, DocumentType> = {
  QUOTATION: 'QT',
  SALES_ORDER: 'SO',
  PURCHASE_REQUEST: 'PR',
  PURCHASE_ORDER: 'PO',
};
const MODULE_OF: Record<OrderType, 'SALES' | 'PURCHASING'> = {
  QUOTATION: 'SALES',
  SALES_ORDER: 'SALES',
  PURCHASE_REQUEST: 'PURCHASING',
  PURCHASE_ORDER: 'PURCHASING',
};
/** Outbound webhook events raised by sales-order transitions (Prompt #6). */
const SO_EVENTS: Partial<Record<OrderAction, OutboundEventType>> = {
  submit: 'sales_order.submitted',
  approve: 'sales_order.approved',
  confirm: 'sales_order.confirmed',
  cancel: 'sales_order.cancelled',
};
/** Outbound webhook events raised by purchase-order transitions (Prompt #7). */
const PO_EVENTS: Partial<Record<OrderAction, OutboundEventType>> = {
  submit: 'purchase_order.submitted',
  approve: 'purchase_order.approved',
  reject: 'purchase_order.rejected',
};
/** Document-level segregation of duties: who created it may not approve it. */
const SOD_PAIR: Partial<Record<OrderType, [string, string]>> = {
  SALES_ORDER: [P['sales-order.create'], P['sales-order.approve']],
  PURCHASE_REQUEST: [P['purchase-request.create'], P['purchase-request.approve']],
  PURCHASE_ORDER: [P['purchase-order.create'], P['purchase-order.approve']],
};

export interface OrderView extends Order {
  partyId: string | null;
  partyCode: string | null;
  partyName: string | null;
  sourceOrderNumber: string | null;
  convertedOrderNumber: string | null;
}

export interface OrderLineView extends OrderLine {
  accountCode: string;
  accountName: string;
  /** Remaining quantities for the next fulfilment step. */
  remainingToReceive: string;
  remainingToBill: string;
  remainingToReturn: string;
}

export interface OrderDetail extends OrderView {
  lines: OrderLineView[];
  /** AR / AP documents raised from this order. */
  documents: Array<{
    id: string;
    documentNumber: string;
    documentType: string;
    status: string;
    documentDate: string;
    total: string;
    matchStatus?: string;
  }>;
  sodWarnings?: SodConflict[];
}

/**
 * Quotations, sales orders, purchase requests and purchase orders share one
 * lifecycle engine; the order type selects the party, the allowed transitions
 * and the fulfilment counters. Orders never post to the ledger - invoicing and
 * billing go through the AR / AP subledger services in the same transaction.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly numbering: DocumentNumberingService,
    private readonly sod: SodService,
    private readonly authority: AuthorityService,
    private readonly customersService: CustomersService,
    private readonly vendorsService: VendorsService,
    private readonly invoicesService: InvoicesService,
    private readonly billsService: BillsService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly matching: MatchingService,
    private readonly stock: DocumentStockService,
    private readonly approvals: ApprovalsService,
    private readonly credit: CreditService,
    private readonly outbox: OutboxService,
  ) {}

  // ----------------------------------------------------------------- queries

  async list(
    companyId: string,
    type: OrderType,
    query: ListOrdersQuery,
  ): Promise<PaginatedResult<OrderView>> {
    const filters: SQL[] = [eq(orders.companyId, companyId), eq(orders.orderType, type)];
    if (query.partyId)
      filters.push(or(eq(orders.customerId, query.partyId), eq(orders.vendorId, query.partyId))!);
    if (query.status) filters.push(eq(orders.status, query.status));
    if (query.from) filters.push(gte(orders.orderDate, query.from));
    if (query.to) filters.push(lte(orders.orderDate, query.to));
    if (query.openOnly) filters.push(eq(orders.status, 'APPROVED'));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(orders.documentNumber, term),
          ilike(orders.reference, term),
          ilike(orders.description, term),
          ilike(customers.name, term),
          ilike(vendors.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'total'
        ? orders.total
        : query.sortBy === 'documentNumber'
          ? orders.documentNumber
          : query.sortBy === 'expectedDate'
            ? orders.expectedDate
            : orders.orderDate;
    const direction = query.sortDir === 'asc' ? asc : desc;
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(sortColumn), desc(orders.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(orders)
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .leftJoin(vendors, eq(vendors.id, orders.vendorId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, type: OrderType, id: string): Promise<OrderDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(orders.id, id), eq(orders.companyId, companyId), eq(orders.orderType, type)),
    );
    if (!row) throw new NotFoundError(labelForType(type), id);
    const [lines, documents] = await Promise.all([this.lines(row), this.documents(companyId, row)]);
    return { ...row, lines, documents };
  }

  // ---------------------------------------------------------------- commands

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    type: OrderType,
    input: CreateOrderInput,
  ): Promise<OrderDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(eq(orders.companyId, companyId), eq(orders.idempotencyKey, input.idempotencyKey)),
          );
        if (existing) return existing.id;
      }
      const party = await this.resolveParty(companyId, type, input, tx);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const computed = computeOrderLines(input.lines, currency);
      await this.assertLineAccounts(
        companyId,
        computed.lines.map((l) => l.accountId),
        tx,
      );
      await this.stock.validateLines(tx, companyId, computed.lines);
      this.assertDates(input.orderDate, input.expectedDate ?? null);
      const documentNumber = await this.numbering.allocate(
        companyId,
        NUMBER_TYPE[type],
        Number(input.orderDate.slice(0, 4)),
        tx,
        { branchId: input.branchId ?? null },
      );
      const [created] = await tx
        .insert(orders)
        .values({
          companyId,
          orderType: type,
          documentNumber,
          branchId: input.branchId ?? null,
          customerId: party.customerId,
          vendorId: party.vendorId,
          orderDate: input.orderDate,
          expectedDate: input.expectedDate ?? null,
          reference: input.reference ?? null,
          description: input.description ?? null,
          notes: input.notes ?? null,
          currency,
          subtotal: computed.subtotal.toString(),
          discountTotal: computed.discountTotal.toString(),
          total: computed.total.toString(),
          paymentTermId: input.paymentTermId ?? party.paymentTermId ?? null,
          salespersonId: input.salespersonId ?? party.salespersonId ?? null,
          warehouseId: input.warehouseId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!created) throw new Error('Insert returned no row');
      await tx
        .insert(orderLines)
        .values(computed.lines.map((l) => ({ ...l, orderId: created.id })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE_OF[type],
          entityType: entityType(type),
          entityId: created.id,
          newValue: {
            documentNumber,
            total: created.total,
            partyId: party.customerId ?? party.vendorId,
          },
          companyId,
        },
        tx,
      );
      if (type === 'SALES_ORDER') {
        await this.outbox.enqueue(tx, {
          eventType: 'sales_order.created',
          companyId,
          dedupeKey: 'sales_order.created:' + created.id,
          payload: {
            salesOrderId: created.id,
            documentNumber,
            customerId: created.customerId,
            total: created.total,
            currency,
            status: created.status,
          },
        });
      }
      return created.id;
    });
    return this.get(companyId, type, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    type: OrderType,
    id: string,
    input: UpdateOrderInput,
  ): Promise<OrderDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, EDITABLE_STATUSES, 'edited');
      const party = await this.resolveParty(
        companyId,
        type,
        {
          customerId: input.customerId ?? existing.customerId ?? undefined,
          vendorId: input.vendorId === undefined ? existing.vendorId : input.vendorId,
        },
        tx,
      );
      const orderDate = input.orderDate ?? existing.orderDate;
      const expectedDate =
        input.expectedDate === undefined ? existing.expectedDate : input.expectedDate;
      this.assertDates(orderDate, expectedDate);
      let totals = {
        subtotal: existing.subtotal,
        discountTotal: existing.discountTotal,
        total: existing.total,
      };
      if (input.lines) {
        const computed = computeOrderLines(input.lines, existing.currency);
        await this.assertLineAccounts(
          companyId,
          computed.lines.map((l) => l.accountId),
          tx,
        );
        await this.stock.validateLines(tx, companyId, computed.lines);
        await tx.delete(orderLines).where(eq(orderLines.orderId, id));
        await tx.insert(orderLines).values(computed.lines.map((l) => ({ ...l, orderId: id })));
        totals = {
          subtotal: computed.subtotal.toString(),
          discountTotal: computed.discountTotal.toString(),
          total: computed.total.toString(),
        };
      }
      await tx
        .update(orders)
        .set({
          customerId: party.customerId,
          vendorId: party.vendorId,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          orderDate,
          expectedDate,
          reference: input.reference === undefined ? existing.reference : input.reference,
          description: input.description === undefined ? existing.description : input.description,
          notes: input.notes === undefined ? existing.notes : input.notes,
          paymentTermId:
            input.paymentTermId === undefined ? existing.paymentTermId : input.paymentTermId,
          salespersonId:
            input.salespersonId === undefined ? existing.salespersonId : input.salespersonId,
          warehouseId: input.warehouseId === undefined ? existing.warehouseId : input.warehouseId,
          ...totals,
        })
        .where(eq(orders.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE_OF[type],
          entityType: entityType(type),
          entityId: id,
          previousValue: { total: existing.total, orderDate: existing.orderDate },
          newValue: { total: totals.total, orderDate },
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  async remove(companyId: string, type: OrderType, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'deleted');
      await tx.delete(orders).where(eq(orders.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE_OF[type],
          entityType: entityType(type),
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber, total: existing.total },
          companyId,
        },
        tx,
      );
    });
  }

  /** Generic status transition (submit, send, accept, approve, reject, close, cancel). */
  async transition(
    companyId: string,
    actor: AuthenticatedUser,
    type: OrderType,
    id: string,
    action: Exclude<OrderAction, 'convert'>,
    input?: RejectOrderInput | CancelOrderInput,
  ): Promise<OrderDetail> {
    const warnings: SodConflict[] = [];
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      const to = nextStatus(type, action, existing.status);
      const workflowType: 'PURCHASE_ORDER' | 'SALES_ORDER' | null =
        type === 'PURCHASE_ORDER'
          ? 'PURCHASE_ORDER'
          : type === 'SALES_ORDER'
            ? 'SALES_ORDER'
            : null;
      if (workflowType && (action === 'cancel' || action === 'reject')) {
        await this.approvals.cancelFor(tx, workflowType, id);
      }
      // Sales orders: the credit policy runs before any approval workflow (Prompt #6).
      let creditCheck: Record<string, unknown> | undefined;
      if (
        type === 'SALES_ORDER' &&
        (action === 'submit' || action === 'approve') &&
        existing.customerId
      ) {
        const customer = await this.customersService.getOrThrow(companyId, existing.customerId, tx);
        const result = await this.credit.check(
          tx,
          companyId,
          customer,
          'SALES_ORDER',
          existing.total,
          { excludeOrderId: id },
        );
        creditCheck = {
          checkedAt: new Date().toISOString(),
          action,
          outcome: result.outcome,
          findings: result.findings,
          summary: result.summary,
        };
        if (action === 'approve' && result.outcome === 'REQUIRE_APPROVAL') {
          // A credit finding that requires approval can only be cleared by someone holding
          // sales-order.approve (natively or by delegation - AuthorityService verifies the grant).
          const mayApprove =
            actor.permissions.has(P['sales-order.approve']) ||
            (actor.delegations ?? []).some((d) => d.permission === 'sales-order.approve');
          if (!mayApprove) {
            throw new BusinessRuleError(
              ErrorCodes.CREDIT_CHECK_FAILED,
              'Credit policy requires approval by a sales-order approver: ' +
                result.findings.map((f) => f.message).join(' '),
              { findings: result.findings },
            );
          }
        }
        await this.credit.notifyOverLimit(tx, companyId, customer, result.summary);
      }
      if (workflowType && (action === 'submit' || action === 'approve')) {
        const ref = {
          companyId,
          documentType: workflowType,
          documentId: id,
          documentNumber: existing.documentNumber,
          amount: existing.total,
          currency: existing.currency,
          requestedBy: existing.createdBy ?? actor.id,
          branchId: existing.branchId,
        };
        if (action === 'submit') await this.approvals.open(tx, { ...ref, requestedBy: actor.id });
        else await this.approvals.assertApproved(tx, ref);
      }
      let delegatedAudit: Record<string, unknown> | undefined;
      if (action === 'approve' && SOD_PAIR[type]) {
        // Delegated authority (if any): scope, amount ceiling and SoD are checked and the use recorded.
        const authority = await this.authority.assert(
          tx,
          actor,
          SOD_PAIR[type]![1] as PermissionKey,
          {
            companyId,
            branchId: existing.branchId,
            amount: existing.total,
            currency: existing.currency,
            documentType:
              type === 'SALES_ORDER' || type === 'PURCHASE_ORDER' || type === 'PURCHASE_REQUEST'
                ? type
                : 'ORDER',
            documentId: id,
            documentNumber: existing.documentNumber,
            createdBy: existing.createdBy,
            action: 'Approved ' + type.toLowerCase().replace(/_/g, ' '),
          },
        );
        delegatedAudit = authority.audit;
        const conflict = await this.sod.checkActorSeparation(
          actor.organizationId,
          SOD_PAIR[type]!,
          existing.createdBy,
          actor.id,
          tx,
        );
        if (conflict) warnings.push(conflict);
      }
      if (action === 'approve' || action === 'accept') {
        // A purchase order needs a vendor before it is approved; a request may still be vendor-less.
        if (type === 'PURCHASE_ORDER' && !existing.vendorId)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'Choose a vendor before approving the purchase order.',
          );
      }
      // Vendor hold / onboarding gate: no purchase order is submitted or approved for an unusable vendor (Prompt #7).
      if (
        type === 'PURCHASE_ORDER' &&
        (action === 'submit' || action === 'approve') &&
        existing.vendorId
      )
        await this.vendorsService.assertUsable(companyId, existing.vendorId, tx, 'purchase order');
      if (
        action === 'cancel' &&
        (existing.receiptStatus !== 'NONE' || existing.billingStatus !== 'NONE')
      ) {
        throw new BusinessRuleError(
          ErrorCodes.ORDER_INVALID_STATE,
          `${existing.documentNumber} already has receipts or documents; close it instead of cancelling.`,
        );
      }
      const reason = input && 'reason' in input ? input.reason : undefined;
      await tx
        .update(orders)
        .set({
          status: to,
          ...(action === 'submit' ? { submittedAt: new Date() } : {}),
          ...(action === 'approve' || action === 'accept'
            ? { approvedBy: actor.id, approvedAt: new Date() }
            : {}),
          ...(action === 'confirm' ? { confirmedBy: actor.id, confirmedAt: new Date() } : {}),
          ...(creditCheck ? { creditCheck } : {}),
          ...(action === 'reject' ? { rejectionReason: reason ?? null } : {}),
          ...(action === 'cancel' ? { cancelReason: reason ?? null } : {}),
          ...(action === 'close' ? { closedAt: new Date() } : {}),
        })
        .where(eq(orders.id, id));
      await this.audit.record(
        {
          action:
            action === 'approve' || action === 'accept'
              ? 'APPROVE'
              : action === 'reject'
                ? 'REJECT'
                : action === 'submit'
                  ? 'SUBMIT'
                  : action === 'cancel'
                    ? 'VOID'
                    : 'UPDATE',
          module: MODULE_OF[type],
          entityType: entityType(type),
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: to, reason, sodWarnings: warnings.length ? warnings : undefined },
          metadata: {
            documentNumber: existing.documentNumber,
            ...delegatedAudit,
            ...(creditCheck ? { creditOutcome: creditCheck.outcome } : {}),
          },
          companyId,
        },
        tx,
      );
      if (type === 'PURCHASE_ORDER' && PO_EVENTS[action]) {
        await this.outbox.enqueue(tx, {
          eventType: PO_EVENTS[action]!,
          companyId,
          dedupeKey: PO_EVENTS[action] + ':' + id + ':' + to,
          payload: {
            purchaseOrderId: id,
            documentNumber: existing.documentNumber,
            vendorId: existing.vendorId,
            total: existing.total,
            currency: existing.currency,
            status: to,
          },
        });
      }
      if (type === 'SALES_ORDER' && SO_EVENTS[action]) {
        await this.outbox.enqueue(tx, {
          eventType: SO_EVENTS[action]!,
          companyId,
          dedupeKey: SO_EVENTS[action] + ':' + id,
          payload: {
            salesOrderId: id,
            documentNumber: existing.documentNumber,
            customerId: existing.customerId,
            total: existing.total,
            currency: existing.currency,
            status: to,
          },
        });
      }
    });
    return { ...(await this.get(companyId, type, id)), sodWarnings: warnings };
  }

  /** Quotation -> sales order, purchase request -> purchase order. The new order starts as a draft. */
  async convert(
    companyId: string,
    actor: AuthenticatedUser,
    type: OrderType,
    id: string,
    input: ConvertOrderInput,
  ): Promise<OrderDetail> {
    const target = ORDER_RULES[type].convertsTo;
    if (!target) {
      throw new BusinessRuleError(
        ErrorCodes.ORDER_INVALID_STATE,
        `A ${labelForType(type).toLowerCase()} cannot be converted.`,
      );
    }
    const newId = await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      const to = nextStatus(type, 'convert', existing.status);
      const vendorId = input.vendorId ?? existing.vendorId;
      if (target === 'PURCHASE_ORDER' && !vendorId) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A vendor is required to raise the purchase order.',
        );
      }
      const party = await this.resolveParty(
        companyId,
        target,
        { customerId: existing.customerId ?? undefined, vendorId },
        tx,
      );
      const lines = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, id))
        .orderBy(asc(orderLines.lineNumber));
      const orderDate = input.orderDate ?? businessToday();
      const documentNumber = await this.numbering.allocate(
        companyId,
        NUMBER_TYPE[target],
        Number(orderDate.slice(0, 4)),
        tx,
        { branchId: existing.branchId },
      );
      const [created] = await tx
        .insert(orders)
        .values({
          companyId,
          orderType: target,
          documentNumber,
          branchId: existing.branchId,
          customerId: party.customerId,
          vendorId: party.vendorId,
          orderDate,
          expectedDate:
            input.expectedDate === undefined ? existing.expectedDate : input.expectedDate,
          reference: existing.reference ?? existing.documentNumber,
          description: existing.description,
          notes: existing.notes,
          currency: existing.currency,
          subtotal: existing.subtotal,
          discountTotal: existing.discountTotal,
          total: existing.total,
          sourceOrderId: existing.id,
          createdBy: actor.id,
        })
        .returning();
      if (!created) throw new Error('Insert returned no row');
      await tx.insert(orderLines).values(
        lines.map((l) => ({
          orderId: created.id,
          lineNumber: l.lineNumber,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPercent: l.discountPercent,
          amount: l.amount,
          accountId: l.accountId,
          branchId: l.branchId,
          productId: l.productId,
          warehouseId: l.warehouseId,
          sourceLineId: l.id,
        })),
      );
      await tx
        .update(orders)
        .set({ status: to, convertedOrderId: created.id })
        .where(eq(orders.id, id));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE_OF[target],
          entityType: entityType(target),
          entityId: created.id,
          newValue: { documentNumber, total: created.total, sourceOrderId: existing.id },
          metadata: { convertedFrom: existing.documentNumber },
          companyId,
        },
        tx,
      );
      return created.id;
    });
    return this.get(companyId, target, newId);
  }

  /**
   * Raises the AR invoice (sales order) or AP bill (purchase order) for the
   * outstanding - or the requested - quantities. The subledger service posts
   * nothing yet: the document is a draft that follows the normal approve / post flow.
   */
  async fulfil(
    companyId: string,
    actor: AuthenticatedUser,
    type: OrderType,
    id: string,
    input: FulfilOrderInput,
  ): Promise<{ documentId: string; documentNumber: string; warnings: unknown[] }> {
    if (type !== 'SALES_ORDER' && type !== 'PURCHASE_ORDER') {
      throw new BusinessRuleError(
        ErrorCodes.ORDER_INVALID_STATE,
        `A ${labelForType(type).toLowerCase()} cannot be invoiced or billed.`,
      );
    }
    const result = await this.db.transaction(async (tx) => {
      const { order, lines } = await this.fulfillment.lockOpenOrder(tx, companyId, id, type);
      const byId = new Map(lines.map((l) => [l.id, l]));
      const requested: Array<{ orderLineId: string; quantity: string; unitPrice?: string }> =
        input.lines ??
        lines
          .map((l) => ({
            orderLineId: l.id,
            quantity: this.fulfillment.remaining(l, 'BILLING', order.currency, type),
          }))
          .filter((l) => Money.of(l.quantity, order.currency).isPositive());
      if (requested.length === 0) {
        throw new BusinessRuleError(
          ErrorCodes.ORDER_INVALID_STATE,
          `${order.documentNumber} has nothing left to ${type === 'SALES_ORDER' ? 'invoice' : 'bill'}.`,
        );
      }
      const documentLines = requested.map((r) => {
        const line = byId.get(r.orderLineId);
        if (!line) throw new NotFoundError('Order line', r.orderLineId);
        return {
          description: line.description,
          quantity: r.quantity,
          unitPrice: r.unitPrice ?? line.unitPrice,
          discountPercent: line.discountPercent,
          accountId: line.accountId,
          branchId: line.branchId,
          orderLineId: line.id,
          productId: line.productId,
          warehouseId: line.warehouseId,
        };
      });
      const base = {
        documentType: 'INVOICE' as const,
        documentDate: input.documentDate,
        dueDate: input.dueDate,
        reference: input.reference ?? order.reference ?? order.documentNumber,
        description: input.description ?? order.description ?? undefined,
        branchId: order.branchId,
        lines: documentLines,
        idempotencyKey: input.idempotencyKey,
      };
      if (type === 'SALES_ORDER') {
        const { id: documentId, warnings } = await this.invoicesService.createInTx(
          tx,
          companyId,
          actor,
          { ...base, customerId: order.customerId!, salesOrderId: order.id },
        );
        return { documentId, warnings, table: 'invoices' as const };
      }
      const { id: documentId, warnings } = await this.billsService.createInTx(
        tx,
        companyId,
        actor,
        {
          ...base,
          vendorId: order.vendorId!,
          purchaseOrderId: order.id,
          vendorInvoiceNumber: input.vendorInvoiceNumber,
        },
      );
      return { documentId, warnings, table: 'vendor_bills' as const };
    });
    const [doc] =
      result.table === 'invoices'
        ? await this.db
            .select({ n: invoices.documentNumber })
            .from(invoices)
            .where(eq(invoices.id, result.documentId))
        : await this.db
            .select({ n: vendorBills.documentNumber })
            .from(vendorBills)
            .where(eq(vendorBills.id, result.documentId));
    return {
      documentId: result.documentId,
      documentNumber: doc?.n ?? '',
      warnings: result.warnings,
    };
  }

  // ----------------------------------------------------------------- helpers

  private viewQuery(executor: DbExecutor) {
    const source = sql<
      string | null
    >`(select o2.document_number from orders o2 where o2.id = ${orders.sourceOrderId})`;
    const converted = sql<
      string | null
    >`(select o3.document_number from orders o3 where o3.id = ${orders.convertedOrderId})`;
    return executor
      .select({
        ...getTableColumns(orders),
        partyId: sql<string | null>`coalesce(${orders.customerId}, ${orders.vendorId})`,
        partyCode: sql<string | null>`coalesce(${customers.code}, ${vendors.code})`,
        partyName: sql<string | null>`coalesce(${customers.name}, ${vendors.name})`,
        sourceOrderNumber: source,
        convertedOrderNumber: converted,
      })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(vendors, eq(vendors.id, orders.vendorId))
      .$dynamic();
  }

  private async lines(order: Order): Promise<OrderLineView[]> {
    const rows = await this.db
      .select({
        line: orderLines,
        accountCode: accounts.code,
        accountName: accounts.name,
      })
      .from(orderLines)
      .innerJoin(accounts, eq(accounts.id, orderLines.accountId))
      .where(eq(orderLines.orderId, order.id))
      .orderBy(asc(orderLines.lineNumber));
    return rows.map((r) => ({
      ...r.line,
      accountCode: r.accountCode,
      accountName: r.accountName,
      remainingToReceive: this.fulfillment.remaining(
        r.line,
        'RECEIPT',
        order.currency,
        order.orderType,
      ),
      remainingToBill: this.fulfillment.remaining(
        r.line,
        'BILLING',
        order.currency,
        order.orderType,
      ),
      remainingToReturn: this.fulfillment.remaining(
        r.line,
        'RETURN',
        order.currency,
        order.orderType,
      ),
    }));
  }

  private async documents(companyId: string, order: Order): Promise<OrderDetail['documents']> {
    if (order.orderType === 'SALES_ORDER') {
      return this.db
        .select({
          id: invoices.id,
          documentNumber: invoices.documentNumber,
          documentType: invoices.documentType,
          status: invoices.status,
          documentDate: invoices.documentDate,
          total: invoices.total,
        })
        .from(invoices)
        .where(and(eq(invoices.companyId, companyId), eq(invoices.salesOrderId, order.id)))
        .orderBy(asc(invoices.documentDate), asc(invoices.documentNumber));
    }
    if (order.orderType === 'PURCHASE_ORDER') {
      return this.db
        .select({
          id: vendorBills.id,
          documentNumber: vendorBills.documentNumber,
          documentType: vendorBills.documentType,
          status: vendorBills.status,
          documentDate: vendorBills.documentDate,
          total: vendorBills.total,
          matchStatus: vendorBills.matchStatus,
        })
        .from(vendorBills)
        .where(and(eq(vendorBills.companyId, companyId), eq(vendorBills.purchaseOrderId, order.id)))
        .orderBy(asc(vendorBills.documentDate), asc(vendorBills.documentNumber));
    }
    return [];
  }

  private async resolveParty(
    companyId: string,
    type: OrderType,
    input: { customerId?: string; vendorId?: string | null },
    tx: DbExecutor,
  ): Promise<{
    customerId: string | null;
    vendorId: string | null;
    paymentTermId?: string | null;
    salespersonId?: string | null;
  }> {
    const rule = ORDER_RULES[type].party;
    if (rule === 'CUSTOMER') {
      if (!input.customerId)
        throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'A customer is required.');
      const customer = await this.customersService.getOrThrow(companyId, input.customerId, tx);
      if (customer.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.PARTY_INACTIVE,
          `Customer ${customer.code} is inactive.`,
        );
      return {
        customerId: customer.id,
        vendorId: null,
        paymentTermId: customer.paymentTermId,
        salespersonId: customer.salespersonId,
      };
    }
    if (!input.vendorId) {
      if (rule === 'VENDOR')
        throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'A vendor is required.');
      return { customerId: null, vendorId: null };
    }
    const vendor = await this.vendorsService.getOrThrow(companyId, input.vendorId, tx);
    if (vendor.status !== 'ACTIVE')
      throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, `Vendor ${vendor.code} is inactive.`);
    return { customerId: null, vendorId: vendor.id };
  }

  private assertDates(orderDate: string, expectedDate: string | null): void {
    if (expectedDate && expectedDate < orderDate)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The expected date cannot be before the order date.',
      );
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
          `${account.code} ${account.name} cannot be used on order lines.`,
        );
    }
  }

  private async lock(
    tx: DbExecutor,
    companyId: string,
    type: OrderType,
    id: string,
  ): Promise<Order> {
    const [row] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.companyId, companyId), eq(orders.orderType, type)))
      .for('update');
    if (!row) throw new NotFoundError(labelForType(type), id);
    return row;
  }

  private assertStatus(order: Order, allowed: readonly OrderStatus[], verb: string): void {
    if (!allowed.includes(order.status)) {
      throw new BusinessRuleError(
        ErrorCodes.ORDER_INVALID_STATE,
        `${order.documentNumber} cannot be ${verb} from status ${order.status}.`,
        { status: order.status, allowed: [...allowed] },
      );
    }
  }

  /** Used by goods receipts / returns to find the order's open bills for re-matching. */
  async rematch(tx: DbExecutor, companyId: string, purchaseOrderId: string): Promise<void> {
    await this.matching.reevaluateOrder(tx, companyId, purchaseOrderId);
  }

  /** Ids of open bills / invoices (for tests and views). */
  async openDocumentIds(companyId: string, orderId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: vendorBills.id })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.purchaseOrderId, orderId),
          inArray(vendorBills.status, ['DRAFT', 'APPROVED', 'PARTIALLY_PAID']),
        ),
      );
    return rows.map((r) => r.id);
  }
}

function entityType(type: OrderType): string {
  return {
    QUOTATION: 'Quotation',
    SALES_ORDER: 'SalesOrder',
    PURCHASE_REQUEST: 'PurchaseRequest',
    PURCHASE_ORDER: 'PurchaseOrder',
  }[type];
}
