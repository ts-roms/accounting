import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult, type ReturnType } from '@accounting/types';
import type {
  CancelOrderInput,
  CreateReturnInput,
  CreditReturnInput,
  ListReturnsQuery,
  UpdateReturnInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  customers,
  orders,
  returnLines,
  returns,
  vendors,
  type Return,
  type ReturnLine,
} from '@/database/schema';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BillsService } from '@/modules/payables/bills.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { InvoicesService } from '@/modules/receivables/invoices.service';
import { OrderFulfillmentService } from './order-fulfillment.service';
import { netUnitPrice } from './orders.logic';

const ORDER_TYPE = { SALES: 'SALES_ORDER', PURCHASE: 'PURCHASE_ORDER' } as const;
const MODULE_OF = { SALES: 'SALES', PURCHASE: 'PURCHASING' } as const;

export interface ReturnView extends Return {
  orderNumber: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  creditNoteNumber: string | null;
}

export interface ReturnLineView extends ReturnLine {
  accountCode: string;
  accountName: string;
}

export interface ReturnDetail extends ReturnView {
  lines: ReturnLineView[];
}

/**
 * Sales returns (goods back from a customer) and purchase returns (goods back
 * to a vendor). A return is approved, then credited: crediting raises the
 * credit note through the AR / AP subledger (which posts the reversal of
 * revenue / expense) and records the returned quantity on the order lines.
 * Stock movements arrive with inventory (Phase 5).
 */
@Injectable()
export class ReturnsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly invoicesService: InvoicesService,
    private readonly billsService: BillsService,
    private readonly authority: AuthorityService,
  ) {}

  async list(
    companyId: string,
    type: ReturnType,
    query: ListReturnsQuery,
  ): Promise<PaginatedResult<ReturnView>> {
    const filters: SQL[] = [eq(returns.companyId, companyId), eq(returns.returnType, type)];
    if (query.partyId)
      filters.push(or(eq(returns.customerId, query.partyId), eq(returns.vendorId, query.partyId))!);
    if (query.orderId) filters.push(eq(returns.orderId, query.orderId));
    if (query.status) filters.push(eq(returns.status, query.status));
    if (query.from) filters.push(gte(returns.returnDate, query.from));
    if (query.to) filters.push(lte(returns.returnDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(returns.documentNumber, term),
          ilike(returns.reference, term),
          ilike(orders.documentNumber, term),
          ilike(customers.name, term),
          ilike(vendors.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const direction = query.sortDir === 'asc' ? asc : desc;
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(returns.returnDate), desc(returns.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(returns)
        .innerJoin(orders, eq(orders.id, returns.orderId))
        .leftJoin(customers, eq(customers.id, returns.customerId))
        .leftJoin(vendors, eq(vendors.id, returns.vendorId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, type: ReturnType, id: string): Promise<ReturnDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(returns.id, id), eq(returns.companyId, companyId), eq(returns.returnType, type)),
    );
    if (!row) throw new NotFoundError('Return', id);
    return { ...row, lines: await this.lines(id) };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    type: ReturnType,
    input: CreateReturnInput,
  ): Promise<ReturnDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: returns.id })
          .from(returns)
          .where(
            and(eq(returns.companyId, companyId), eq(returns.idempotencyKey, input.idempotencyKey)),
          );
        if (existing) return existing.id;
      }
      const { order, lines } = await this.fulfillment.lockOpenOrder(
        tx,
        companyId,
        input.orderId,
        ORDER_TYPE[type],
        undefined,
        ['APPROVED', 'CLOSED'],
      );
      const computed = this.computeLines(order.currency, lines, input.lines);
      const documentNumber = await this.numbering.allocate(
        companyId,
        type === 'SALES' ? 'SRN' : 'PRN',
        Number(input.returnDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(returns)
        .values({
          companyId,
          returnType: type,
          documentNumber,
          orderId: order.id,
          customerId: order.customerId,
          vendorId: order.vendorId,
          returnDate: input.returnDate,
          reference: input.reference ?? null,
          reason: input.reason ?? null,
          currency: order.currency,
          total: computed.total.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!created) throw new Error('Insert returned no row');
      await tx
        .insert(returnLines)
        .values(computed.lines.map((l) => ({ ...l, returnId: created.id })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE_OF[type],
          entityType: type === 'SALES' ? 'SalesReturn' : 'PurchaseReturn',
          entityId: created.id,
          newValue: { documentNumber, orderId: order.id, total: created.total },
          companyId,
        },
        tx,
      );
      return created.id;
    });
    return this.get(companyId, type, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    type: ReturnType,
    id: string,
    input: UpdateReturnInput,
  ): Promise<ReturnDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'edited');
      let total = existing.total;
      if (input.lines) {
        const { order, lines } = await this.fulfillment.lockOpenOrder(
          tx,
          companyId,
          existing.orderId,
          ORDER_TYPE[type],
          undefined,
          ['APPROVED', 'CLOSED'],
        );
        const computed = this.computeLines(order.currency, lines, input.lines);
        await tx.delete(returnLines).where(eq(returnLines.returnId, id));
        await tx.insert(returnLines).values(computed.lines.map((l) => ({ ...l, returnId: id })));
        total = computed.total.toString();
      }
      await tx
        .update(returns)
        .set({
          returnDate: input.returnDate ?? existing.returnDate,
          reference: input.reference === undefined ? existing.reference : input.reference,
          reason: input.reason === undefined ? existing.reason : input.reason,
          total,
        })
        .where(eq(returns.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE_OF[type],
          entityType: type === 'SALES' ? 'SalesReturn' : 'PurchaseReturn',
          entityId: id,
          previousValue: { total: existing.total },
          newValue: { total },
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  async remove(companyId: string, type: ReturnType, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'deleted');
      await tx.delete(returns).where(eq(returns.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE_OF[type],
          entityType: type === 'SALES' ? 'SalesReturn' : 'PurchaseReturn',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
  }

  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    type: ReturnType,
    id: string,
  ): Promise<ReturnDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'approved');
      const authority = await this.authority.assert(
        tx,
        actor,
        type === 'SALES' ? P['sales-return.approve'] : P['purchase-return.approve'],
        {
          companyId,
          amount: existing.total,
          currency: existing.currency,
          documentType: 'ORDER',
          documentId: id,
          documentNumber: existing.documentNumber,
          createdBy: existing.createdBy,
          action: type === 'SALES' ? 'Approved sales return' : 'Approved purchase return',
        },
      );
      await tx
        .update(returns)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(returns.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE_OF[type],
          entityType: type === 'SALES' ? 'SalesReturn' : 'PurchaseReturn',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: existing.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  /**
   * Issues the credit note (draft, to be approved and posted through the
   * subledger) and records the returned quantities on the order.
   */
  async credit(
    companyId: string,
    actor: AuthenticatedUser,
    type: ReturnType,
    id: string,
    input: CreditReturnInput,
  ): Promise<ReturnDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['APPROVED'], 'credited');
      const lines = await tx
        .select()
        .from(returnLines)
        .where(eq(returnLines.returnId, id))
        .orderBy(asc(returnLines.lineNumber));
      const { order } = await this.fulfillment.consume(
        tx,
        companyId,
        existing.orderId,
        'RETURN',
        lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })),
        { expectedType: ORDER_TYPE[type] },
      );
      const documentDate = input.documentDate ?? existing.returnDate;
      const base = {
        documentType: 'CREDIT_NOTE' as const,
        documentDate,
        reference: existing.documentNumber,
        description: `Return ${existing.documentNumber} against ${order.documentNumber}${existing.reason ? ` - ${existing.reason}` : ''}`,
        branchId: order.branchId,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPercent: '0',
          accountId: l.accountId,
          productId: l.productId,
          warehouseId: l.warehouseId,
          lotNumber: l.lotNumber ?? undefined,
          serialNumbers: l.serialNumbers,
        })),
        idempotencyKey: `return:${existing.id}`,
      };
      const creditNoteId =
        type === 'SALES'
          ? (
              await this.invoicesService.createInTx(tx, companyId, actor, {
                ...base,
                customerId: existing.customerId!,
              })
            ).id
          : (
              await this.billsService.createInTx(tx, companyId, actor, {
                ...base,
                vendorId: existing.vendorId!,
              })
            ).id;
      await tx
        .update(returns)
        .set({ status: 'CREDITED', creditNoteId, creditedAt: new Date() })
        .where(eq(returns.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE_OF[type],
          entityType: type === 'SALES' ? 'SalesReturn' : 'PurchaseReturn',
          entityId: id,
          previousValue: { status: 'APPROVED' },
          newValue: { status: 'CREDITED', creditNoteId },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    type: ReturnType,
    id: string,
    input: CancelOrderInput,
  ): Promise<ReturnDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT', 'APPROVED'], 'cancelled');
      await tx
        .update(returns)
        .set({ status: 'CANCELLED', cancelReason: input.reason })
        .where(eq(returns.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE_OF[type],
          entityType: type === 'SALES' ? 'SalesReturn' : 'PurchaseReturn',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'CANCELLED' },
          metadata: {
            documentNumber: existing.documentNumber,
            reason: input.reason,
            actor: actor.email,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  // ----------------------------------------------------------------- helpers

  private computeLines(
    currency: string,
    orderRows: Array<{
      id: string;
      lineNumber: number;
      description: string;
      unitPrice: string;
      discountPercent: string;
      accountId: string;
      productId: string | null;
      warehouseId: string | null;
      billedQuantity: string;
      receivedQuantity: string;
      returnedQuantity: string;
    }>,
    input: Array<{
      orderLineId: string;
      quantity: string;
      reason?: string;
      lotNumber?: string;
      serialNumbers?: string[];
    }>,
  ) {
    const byId = new Map(orderRows.map((l) => [l.id, l]));
    const seen = new Set<string>();
    let total = Money.zero(currency);
    const lines = input.map((l, index) => {
      if (seen.has(l.orderLineId))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'An order line can only appear once per return.',
        );
      seen.add(l.orderLineId);
      const source = byId.get(l.orderLineId);
      if (!source)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A return line does not belong to this order.',
        );
      const unitPrice = netUnitPrice(source.unitPrice, source.discountPercent, currency);
      const amount = unitPrice.multiply(l.quantity);
      total = total.add(amount);
      return {
        lineNumber: index + 1,
        orderLineId: l.orderLineId,
        description: source.description,
        quantity: Money.of(l.quantity, currency).toString(),
        unitPrice: unitPrice.toString(),
        amount: amount.toString(),
        accountId: source.accountId,
        reason: l.reason ?? null,
        productId: source.productId,
        warehouseId: source.warehouseId,
        lotNumber: l.lotNumber ?? null,
        serialNumbers: l.serialNumbers ?? [],
      };
    });
    if (total.isZero())
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The return total must be greater than zero.',
      );
    return { lines, total };
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(returns),
        orderNumber: orders.documentNumber,
        partyId: sql<string>`coalesce(${returns.customerId}, ${returns.vendorId})`,
        partyCode: sql<string>`coalesce(${customers.code}, ${vendors.code})`,
        partyName: sql<string>`coalesce(${customers.name}, ${vendors.name})`,
        creditNoteNumber: sql<string | null>`coalesce(
          (select i.document_number from invoices i where i.id = ${returns.creditNoteId}),
          (select b.document_number from vendor_bills b where b.id = ${returns.creditNoteId})
        )`,
      })
      .from(returns)
      .innerJoin(orders, eq(orders.id, returns.orderId))
      .leftJoin(customers, eq(customers.id, returns.customerId))
      .leftJoin(vendors, eq(vendors.id, returns.vendorId))
      .$dynamic();
  }

  private async lines(id: string): Promise<ReturnLineView[]> {
    const rows = await this.db
      .select({ line: returnLines, accountCode: accounts.code, accountName: accounts.name })
      .from(returnLines)
      .innerJoin(accounts, eq(accounts.id, returnLines.accountId))
      .where(eq(returnLines.returnId, id))
      .orderBy(asc(returnLines.lineNumber));
    return rows.map((r) => ({ ...r.line, accountCode: r.accountCode, accountName: r.accountName }));
  }

  private async lock(
    tx: DbExecutor,
    companyId: string,
    type: ReturnType,
    id: string,
  ): Promise<Return> {
    const [row] = await tx
      .select()
      .from(returns)
      .where(
        and(eq(returns.id, id), eq(returns.companyId, companyId), eq(returns.returnType, type)),
      )
      .for('update');
    if (!row) throw new NotFoundError('Return', id);
    return row;
  }

  private assertStatus(doc: Return, allowed: Return['status'][], verb: string): void {
    if (!allowed.includes(doc.status)) {
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${doc.documentNumber} cannot be ${verb} from status ${doc.status}.`,
        { status: doc.status, allowed },
      );
    }
  }
}
