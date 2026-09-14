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
import type { PaginatedResult } from '@accounting/types';
import type {
  CancelOrderInput,
  CreateGoodsReceiptInput,
  ListGoodsReceiptsQuery,
  UpdateGoodsReceiptInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  goodsReceiptLines,
  goodsReceipts,
  journalEntries,
  orderLines,
  orders,
  vendors,
  type GoodsReceipt,
  type GoodsReceiptLine,
} from '@/database/schema';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { DocumentStockService } from '@/modules/inventory/document-stock.service';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { AuditService } from '@/modules/audit/audit.service';
import { MatchingService } from './matching.service';
import { OrderFulfillmentService } from './order-fulfillment.service';

const MODULE = 'PURCHASING';

export interface GoodsReceiptView extends GoodsReceipt {
  purchaseOrderNumber: string;
  vendorCode: string;
  vendorName: string;
  lineCount: number;
}

export interface GoodsReceiptLineView extends GoodsReceiptLine {
  description: string;
  orderedQuantity: string;
  unitPrice: string;
}

export interface GoodsReceiptDetail extends GoodsReceiptView {
  lines: GoodsReceiptLineView[];
}

/**
 * Receiving against an approved purchase order. A draft receipt reserves
 * nothing; confirming it adds to the PO's received quantities and re-runs the
 * three-way match on the PO's bills. There is no ledger effect in this phase -
 * inventory valuation (Phase 5) will post the receipt accrual.
 */
@Injectable()
export class GoodsReceiptsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly matching: MatchingService,
    private readonly posting: AccountingPostingService,
    private readonly stock: DocumentStockService,
    private readonly inventory: InventoryService,
  ) {}

  async list(
    companyId: string,
    query: ListGoodsReceiptsQuery,
  ): Promise<PaginatedResult<GoodsReceiptView>> {
    const filters: SQL[] = [eq(goodsReceipts.companyId, companyId)];
    if (query.purchaseOrderId)
      filters.push(eq(goodsReceipts.purchaseOrderId, query.purchaseOrderId));
    if (query.vendorId) filters.push(eq(goodsReceipts.vendorId, query.vendorId));
    if (query.status) filters.push(eq(goodsReceipts.status, query.status));
    if (query.from) filters.push(gte(goodsReceipts.receiptDate, query.from));
    if (query.to) filters.push(lte(goodsReceipts.receiptDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(goodsReceipts.documentNumber, term),
          ilike(goodsReceipts.reference, term),
          ilike(orders.documentNumber, term),
          ilike(vendors.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const direction = query.sortDir === 'asc' ? asc : desc;
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(goodsReceipts.receiptDate), desc(goodsReceipts.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(goodsReceipts)
        .innerJoin(orders, eq(orders.id, goodsReceipts.purchaseOrderId))
        .innerJoin(vendors, eq(vendors.id, goodsReceipts.vendorId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<GoodsReceiptDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(goodsReceipts.id, id), eq(goodsReceipts.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Goods receipt', id);
    return { ...row, lines: await this.lines(id) };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateGoodsReceiptInput,
  ): Promise<GoodsReceiptDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: goodsReceipts.id })
          .from(goodsReceipts)
          .where(
            and(
              eq(goodsReceipts.companyId, companyId),
              eq(goodsReceipts.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const { order, lines } = await this.fulfillment.lockOpenOrder(
        tx,
        companyId,
        input.purchaseOrderId,
        'PURCHASE_ORDER',
      );
      this.validateLines(lines, input.lines);
      const documentNumber = await this.numbering.allocate(
        companyId,
        'GR',
        Number(input.receiptDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(goodsReceipts)
        .values({
          companyId,
          documentNumber,
          purchaseOrderId: order.id,
          vendorId: order.vendorId!,
          receiptDate: input.receiptDate,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!created) throw new Error('Insert returned no row');
      await tx.insert(goodsReceiptLines).values(
        input.lines.map((l, i) => ({
          goodsReceiptId: created.id,
          lineNumber: i + 1,
          orderLineId: l.orderLineId,
          quantity: l.quantity,
          notes: l.notes ?? null,
          lotNumber: l.lotNumber ?? null,
          expiryDate: l.expiryDate ?? null,
          serialNumbers: l.serialNumbers ?? [],
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'GoodsReceipt',
          entityId: created.id,
          newValue: { documentNumber, purchaseOrderId: order.id, lines: input.lines.length },
          companyId,
        },
        tx,
      );
      return created.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateGoodsReceiptInput,
  ): Promise<GoodsReceiptDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'edited');
      if (input.lines) {
        const { lines } = await this.fulfillment.lockOpenOrder(
          tx,
          companyId,
          existing.purchaseOrderId,
          'PURCHASE_ORDER',
        );
        this.validateLines(lines, input.lines);
        await tx.delete(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, id));
        await tx.insert(goodsReceiptLines).values(
          input.lines.map((l, i) => ({
            goodsReceiptId: id,
            lineNumber: i + 1,
            orderLineId: l.orderLineId,
            quantity: l.quantity,
            notes: l.notes ?? null,
            lotNumber: l.lotNumber ?? null,
            expiryDate: l.expiryDate ?? null,
            serialNumbers: l.serialNumbers ?? [],
          })),
        );
      }
      await tx
        .update(goodsReceipts)
        .set({
          receiptDate: input.receiptDate ?? existing.receiptDate,
          reference: input.reference === undefined ? existing.reference : input.reference,
          notes: input.notes === undefined ? existing.notes : input.notes,
        })
        .where(eq(goodsReceipts.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'GoodsReceipt',
          entityId: id,
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
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
      await tx.delete(goodsReceipts).where(eq(goodsReceipts.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'GoodsReceipt',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
  }

  /** Confirms the receipt: PO received quantities increase and linked bills are re-matched. */
  async confirm(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<GoodsReceiptDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'confirmed');
      const lines = await tx
        .select()
        .from(goodsReceiptLines)
        .where(eq(goodsReceiptLines.goodsReceiptId, id));
      const settings = await this.matching.settings(companyId, tx);
      await this.fulfillment.consume(
        tx,
        companyId,
        existing.purchaseOrderId,
        'RECEIPT',
        lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })),
        { expectedType: 'PURCHASE_ORDER', tolerancePercent: settings.overReceiptTolerancePercent },
      );
      // Stocked PO lines: goods into stock at the PO net price, Dr inventory / Cr GRNI (Phase 5).
      const poLines = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, existing.purchaseOrderId));
      const byId = new Map(poLines.map((l) => [l.id, l]));
      const [po] = await tx
        .select({ currency: orders.currency })
        .from(orders)
        .where(eq(orders.id, existing.purchaseOrderId));
      const currency = po!.currency;
      const stock = await this.stock.postReceiptLines(tx, {
        companyId,
        sourceId: existing.id,
        movementDate: existing.receiptDate,
        actorId: actor.id,
        currency,
        lines: lines.map((l) => ({
          id: l.id,
          orderLine: byId.get(l.orderLineId)!,
          quantity: l.quantity,
          lotNumber: l.lotNumber,
          expiryDate: l.expiryDate,
          serialNumbers: l.serialNumbers,
        })),
      });
      let journalEntryId: string | null = null;
      if (stock.postingLines.length > 0) {
        await this.posting.resolvePeriod(tx, companyId, existing.receiptDate);
        const entry = await this.posting.postEvent(tx, {
          companyId,
          entryDate: existing.receiptDate,
          description: `Goods receipt ${existing.documentNumber}${existing.reference ? ` - ${existing.reference}` : ''}`,
          reference: existing.reference ?? existing.documentNumber,
          journalType: 'GENERAL',
          branchId: null,
          sourceType: 'GOODS_RECEIPT',
          sourceId: existing.id,
          actorId: actor.id,
          lines: stock.postingLines,
        });
        journalEntryId = entry.id;
        await this.inventory.setJournal(tx, stock.movementIds, entry.id);
      }
      for (const [lineId, cost] of stock.costByLine) {
        const line = lines.find((l) => l.id === lineId)!;
        await tx
          .update(goodsReceiptLines)
          .set({ unitCost: cost.divide(line.quantity).toString() })
          .where(eq(goodsReceiptLines.id, lineId));
      }
      await tx
        .update(goodsReceipts)
        .set({
          status: 'CONFIRMED',
          confirmedBy: actor.id,
          confirmedAt: new Date(),
          journalEntryId,
        })
        .where(eq(goodsReceipts.id, id));
      await this.matching.reevaluateOrder(tx, companyId, existing.purchaseOrderId);
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'GoodsReceipt',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'CONFIRMED' },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Cancels a confirmed receipt (goods refused / miscount): releases the received quantities. */
  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CancelOrderInput,
  ): Promise<GoodsReceiptDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'CONFIRMED'], 'cancelled');
      if (existing.status === 'CONFIRMED') {
        const lines = await tx
          .select()
          .from(goodsReceiptLines)
          .where(eq(goodsReceiptLines.goodsReceiptId, id));
        // The received quantity must still be there: bills already raised against it keep it.
        const poLines = await tx
          .select()
          .from(orderLines)
          .where(eq(orderLines.orderId, existing.purchaseOrderId))
          .for('update');
        const byId = new Map(poLines.map((l) => [l.id, l]));
        for (const l of lines) {
          const po = byId.get(l.orderLineId);
          if (!po) continue;
          const afterRelease = Number(po.receivedQuantity) - Number(l.quantity);
          if (afterRelease < Number(po.billedQuantity)) {
            throw new BusinessRuleError(
              ErrorCodes.ORDER_INVALID_STATE,
              `PO line ${po.lineNumber} has already been billed for the received quantity; void the bill first.`,
            );
          }
        }
        await this.fulfillment.release(
          tx,
          existing.purchaseOrderId,
          'RECEIPT',
          lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })),
        );
        await this.matching.reevaluateOrder(tx, companyId, existing.purchaseOrderId);
        // Stock back out at the received cost and the accrual reversed (Phase 5).
        if (existing.journalEntryId) {
          const currency = (
            await tx
              .select({ c: orders.currency })
              .from(orders)
              .where(eq(orders.id, existing.purchaseOrderId))
          )[0]!.c;
          const stockReversal = await this.inventory.reverseDocument(
            tx,
            companyId,
            'GOODS_RECEIPT',
            existing.id,
            'GOODS_RECEIPT_CANCEL',
            existing.receiptDate,
            actor.id,
            currency,
          );
          const originalLines = await tx.query.journalLines.findMany({
            where: (l, ops) => ops.eq(l.journalEntryId, existing.journalEntryId!),
            orderBy: (l, ops) => ops.asc(l.lineNumber),
          });
          const reversal = await this.posting.postEvent(tx, {
            companyId,
            entryDate: existing.receiptDate,
            description: `Cancel goods receipt ${existing.documentNumber}: ${input.reason}`,
            reference: existing.documentNumber,
            journalType: 'REVERSAL',
            branchId: null,
            sourceType: 'GOODS_RECEIPT_CANCEL',
            sourceId: existing.id,
            reversalOfId: existing.journalEntryId,
            actorId: actor.id,
            lines: originalLines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              description: l.description,
              branchId: l.branchId,
            })),
          });
          await tx
            .update(journalEntries)
            .set({ status: 'REVERSED', reversedById: reversal.id })
            .where(eq(journalEntries.id, existing.journalEntryId));
          await this.inventory.setJournal(tx, stockReversal.movementIds, reversal.id);
          await tx
            .update(goodsReceipts)
            .set({ reversalJournalEntryId: reversal.id })
            .where(eq(goodsReceipts.id, id));
        }
      }
      await tx
        .update(goodsReceipts)
        .set({ status: 'CANCELLED', cancelReason: input.reason })
        .where(eq(goodsReceipts.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'GoodsReceipt',
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
    return this.get(companyId, id);
  }

  // ----------------------------------------------------------------- helpers

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(goodsReceipts),
        purchaseOrderNumber: orders.documentNumber,
        vendorCode: vendors.code,
        vendorName: vendors.name,
        lineCount: sql<number>`(select count(*) from goods_receipt_lines grl where grl.goods_receipt_id = ${goodsReceipts.id})`,
      })
      .from(goodsReceipts)
      .innerJoin(orders, eq(orders.id, goodsReceipts.purchaseOrderId))
      .innerJoin(vendors, eq(vendors.id, goodsReceipts.vendorId))
      .$dynamic();
  }

  private async lines(id: string): Promise<GoodsReceiptLineView[]> {
    const rows = await this.db
      .select({
        line: goodsReceiptLines,
        description: orderLines.description,
        orderedQuantity: orderLines.quantity,
        unitPrice: orderLines.unitPrice,
      })
      .from(goodsReceiptLines)
      .innerJoin(orderLines, eq(orderLines.id, goodsReceiptLines.orderLineId))
      .where(eq(goodsReceiptLines.goodsReceiptId, id))
      .orderBy(asc(goodsReceiptLines.lineNumber));
    return rows.map((r) => ({
      ...r.line,
      description: r.description,
      orderedQuantity: r.orderedQuantity,
      unitPrice: r.unitPrice,
    }));
  }

  /** Draft validation: lines belong to the order. Quantities are enforced on confirmation. */
  private validateLines(
    poLines: Array<{ id: string }>,
    input: Array<{ orderLineId: string; quantity: string }>,
  ): void {
    const byId = new Map(poLines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const l of input) {
      if (seen.has(l.orderLineId))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'An order line can only appear once per receipt.',
        );
      seen.add(l.orderLineId);
      if (!byId.has(l.orderLineId))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A receipt line does not belong to this purchase order.',
        );
    }
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<GoodsReceipt> {
    const [row] = await tx
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.id, id), eq(goodsReceipts.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Goods receipt', id);
    return row;
  }

  private assertStatus(doc: GoodsReceipt, allowed: GoodsReceipt['status'][], verb: string): void {
    if (!allowed.includes(doc.status)) {
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${doc.documentNumber} cannot be ${verb} from status ${doc.status}.`,
        { status: doc.status, allowed },
      );
    }
  }
}
