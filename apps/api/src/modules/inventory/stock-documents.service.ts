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
import { P, type PaginatedResult, type StockDocumentType } from '@accounting/types';
import type {
  CancelOrderInput,
  CreateAdjustmentInput,
  CreateCountInput,
  CreateTransferInput,
  ListStockDocumentsQuery,
  UpdateStockDocumentInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  products,
  stockDocumentLines,
  stockDocuments,
  stockLots,
  warehouses,
  type StockDocument,
  type StockDocumentLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { InventoryService } from './inventory.service';

const MODULE = 'INVENTORY';
const NUMBER_TYPE = { ADJUSTMENT: 'ADJ', TRANSFER: 'TRF', COUNT: 'CNT' } as const;
const LABEL = {
  ADJUSTMENT: 'Stock adjustment',
  TRANSFER: 'Stock transfer',
  COUNT: 'Stock count',
} as const;

export interface StockDocumentView extends StockDocument {
  warehouseCode: string;
  warehouseName: string;
  toWarehouseCode: string | null;
  toWarehouseName: string | null;
  journalNumber: string | null;
  lineCount: number;
}

export interface StockDocumentLineView extends StockDocumentLine {
  sku: string;
  productName: string;
  unitOfMeasure: string;
}

export interface StockDocumentDetail extends StockDocumentView {
  lines: StockDocumentLineView[];
}

/**
 * Adjustments (in / out with a reason), transfers between warehouses and
 * physical counts. Drafts move nothing; posting writes the movements through
 * the InventoryService and the journal (Dr / Cr inventory vs. the adjustment
 * account) in one transaction. Posted documents are immutable - cancel a draft,
 * or post an opposite adjustment.
 */
@Injectable()
export class StockDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly inventory: InventoryService,
  ) {}

  // ----------------------------------------------------------------- queries

  async list(
    companyId: string,
    type: StockDocumentType,
    query: ListStockDocumentsQuery,
  ): Promise<PaginatedResult<StockDocumentView>> {
    const filters: SQL[] = [
      eq(stockDocuments.companyId, companyId),
      eq(stockDocuments.documentType, type),
    ];
    if (query.warehouseId)
      filters.push(
        or(
          eq(stockDocuments.warehouseId, query.warehouseId),
          eq(stockDocuments.toWarehouseId, query.warehouseId),
        )!,
      );
    if (query.status) filters.push(eq(stockDocuments.status, query.status));
    if (query.from) filters.push(gte(stockDocuments.documentDate, query.from));
    if (query.to) filters.push(lte(stockDocuments.documentDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(stockDocuments.documentNumber, term),
          ilike(stockDocuments.reference, term),
          ilike(stockDocuments.notes, term),
        )!,
      );
    }
    const where = and(...filters);
    const direction = query.sortDir === 'asc' ? asc : desc;
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(stockDocuments.documentDate), desc(stockDocuments.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(stockDocuments)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, type: StockDocumentType, id: string): Promise<StockDocumentDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(
        eq(stockDocuments.id, id),
        eq(stockDocuments.companyId, companyId),
        eq(stockDocuments.documentType, type),
      ),
    );
    if (!row) throw new NotFoundError(LABEL[type], id);
    const lines = await this.db
      .select({
        line: stockDocumentLines,
        sku: products.sku,
        productName: products.name,
        unitOfMeasure: products.unitOfMeasure,
      })
      .from(stockDocumentLines)
      .innerJoin(products, eq(products.id, stockDocumentLines.productId))
      .where(eq(stockDocumentLines.documentId, id))
      .orderBy(asc(stockDocumentLines.lineNumber));
    return {
      ...row,
      lines: lines.map((l) => ({
        ...l.line,
        sku: l.sku,
        productName: l.productName,
        unitOfMeasure: l.unitOfMeasure,
      })),
    };
  }

  // ---------------------------------------------------------------- commands

  async createAdjustment(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateAdjustmentInput,
  ): Promise<StockDocumentDetail> {
    const id = await this.create(companyId, actor, 'ADJUSTMENT', input, async (tx, currency) => {
      const lines = [];
      for (const [i, l] of input.lines.entries()) {
        const product = await this.inventory.resolveProduct(companyId, l.productId, tx);
        if (product.productType !== 'GOODS')
          throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, `${product.sku} is a service.`);
        if (l.direction === 'IN' && !l.unitCost)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Line ${i + 1}: a unit cost is required for stock coming in.`,
          );
        lines.push({
          lineNumber: i + 1,
          productId: l.productId,
          locationId: l.locationId ?? null,
          lotNumber: l.lotNumber ?? null,
          expiryDate: l.expiryDate ?? null,
          serialNumbers: l.serialNumbers ?? [],
          direction: l.direction,
          quantity: Money.of(l.quantity, currency).toString(),
          unitCost: l.direction === 'IN' ? Money.parse(l.unitCost!, currency).toString() : null,
          totalCost:
            l.direction === 'IN'
              ? Money.parse(l.unitCost!, currency).multiply(l.quantity).toString()
              : null,
          notes: l.notes ?? null,
        });
      }
      return lines;
    });
    return this.get(companyId, 'ADJUSTMENT', id);
  }

  async createTransfer(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateTransferInput,
  ): Promise<StockDocumentDetail> {
    if (input.toWarehouseId === input.warehouseId)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'Source and destination warehouses must differ.',
      );
    await this.inventory.resolveWarehouse(companyId, input.toWarehouseId);
    const id = await this.create(companyId, actor, 'TRANSFER', input, async (tx, currency) => {
      const lines = [];
      for (const [i, l] of input.lines.entries()) {
        await this.inventory.resolveProduct(companyId, l.productId, tx);
        lines.push({
          lineNumber: i + 1,
          productId: l.productId,
          locationId: null,
          lotNumber: l.lotNumber ?? null,
          expiryDate: null,
          serialNumbers: l.serialNumbers ?? [],
          direction: 'OUT' as const,
          quantity: Money.of(l.quantity, currency).toString(),
          unitCost: null,
          totalCost: null,
          notes: l.notes ?? null,
        });
      }
      return lines;
    });
    return this.get(companyId, 'TRANSFER', id);
  }

  /** A count snapshots the system quantity per line; posting adjusts the variance. */
  async createCount(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateCountInput,
  ): Promise<StockDocumentDetail> {
    const id = await this.create(companyId, actor, 'COUNT', input, async (tx, currency) => {
      const lines = [];
      for (const [i, l] of input.lines.entries()) {
        const product = await this.inventory.resolveProduct(companyId, l.productId, tx);
        let lotId: string | null = null;
        if (product.trackingMode === 'LOT') {
          if (!l.lotNumber)
            throw new BusinessRuleError(
              ErrorCodes.STOCK_IDENTITY_REQUIRED,
              `${product.sku} is lot-tracked: count per lot.`,
            );
          const [lot] = await tx
            .select()
            .from(stockLots)
            .where(and(eq(stockLots.productId, product.id), eq(stockLots.lotNumber, l.lotNumber)));
          lotId = lot?.id ?? null;
        }
        const balance =
          lotId || product.trackingMode !== 'LOT'
            ? await this.inventory.balance(tx, product.id, input.warehouseId, lotId)
            : null;
        const expected = Money.of(balance?.quantityOnHand ?? '0', currency);
        const counted = Money.of(l.countedQuantity, currency);
        const variance = counted.subtract(expected);
        lines.push({
          lineNumber: i + 1,
          productId: l.productId,
          locationId: null,
          lotNumber: l.lotNumber ?? null,
          expiryDate: null,
          serialNumbers: [],
          direction: variance.isNegative() ? ('OUT' as const) : ('IN' as const),
          quantity: variance.abs().toString(),
          expectedQuantity: expected.toString(),
          countedQuantity: counted.toString(),
          unitCost: l.unitCost ? Money.parse(l.unitCost, currency).toString() : null,
          totalCost: null,
          notes: l.notes ?? null,
        });
      }
      return lines;
    });
    return this.get(companyId, 'COUNT', id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    type: StockDocumentType,
    id: string,
    input: UpdateStockDocumentInput,
  ): Promise<StockDocumentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'edited');
      await tx
        .update(stockDocuments)
        .set({
          documentDate: input.documentDate ?? existing.documentDate,
          reference: input.reference === undefined ? existing.reference : input.reference,
          notes: input.notes === undefined ? existing.notes : input.notes,
          reason: input.reason ?? existing.reason,
        })
        .where(eq(stockDocuments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: entityType(type),
          entityId: id,
          newValue: input,
          metadata: { documentNumber: existing.documentNumber, actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  async remove(companyId: string, type: StockDocumentType, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'deleted');
      await tx.delete(stockDocuments).where(eq(stockDocuments.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: entityType(type),
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    type: StockDocumentType,
    id: string,
    input: CancelOrderInput,
  ): Promise<StockDocumentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      this.assertStatus(existing, ['DRAFT'], 'cancelled');
      await tx
        .update(stockDocuments)
        .set({ status: 'CANCELLED', cancelReason: input.reason })
        .where(eq(stockDocuments.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: entityType(type),
          entityId: id,
          previousValue: { status: 'DRAFT' },
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

  /** Moves the stock and posts the journal. Idempotent on an already posted document. */
  async post(
    companyId: string,
    actor: AuthenticatedUser,
    type: StockDocumentType,
    id: string,
  ): Promise<StockDocumentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, type, id);
      if (existing.status === 'POSTED') return;
      this.assertStatus(existing, ['DRAFT'], 'posted');
      await this.posting.resolvePeriod(tx, companyId, existing.documentDate, { draft: true });
      const currency = existing.currency;
      const lines = await tx
        .select()
        .from(stockDocumentLines)
        .where(eq(stockDocumentLines.documentId, id))
        .orderBy(asc(stockDocumentLines.lineNumber));
      // Opening stock is equity at cut-over, not an adjustment gain / loss.
      const adjustmentAccount =
        type === 'TRANSFER'
          ? null
          : await this.accounts.resolveMapped(
              companyId,
              existing.reason === 'OPENING' ? 'OPENING_BALANCE_EQUITY' : 'INVENTORY_ADJUSTMENT',
              tx,
            );
      // Signed value per inventory account: positive = stock value increased.
      const byInventoryAccount = new Map<string, Money>();
      const movementIds: string[] = [];
      let net = Money.zero(currency);
      const sourceType =
        type === 'ADJUSTMENT'
          ? 'STOCK_ADJUSTMENT'
          : type === 'TRANSFER'
            ? 'STOCK_TRANSFER'
            : 'STOCK_COUNT';

      for (const line of lines) {
        const product = await this.inventory.resolveProduct(companyId, line.productId, tx);
        const quantity = Money.of(line.quantity, currency);
        if (!quantity.isPositive()) continue; // count line with no variance
        const common = {
          companyId,
          productId: line.productId,
          locationId: line.locationId,
          lotNumber: line.lotNumber,
          expiryDate: line.expiryDate,
          serialNumbers: line.serialNumbers,
          quantity: line.quantity,
          movementDate: existing.documentDate,
          sourceId: existing.id,
          sourceLineId: line.id,
          actorId: actor.id,
          notes: line.notes,
        };
        if (type === 'TRANSFER') {
          const out = await this.inventory.issue(tx, {
            ...common,
            warehouseId: existing.warehouseId,
            movementType: 'TRANSFER_OUT',
            sourceType,
            currency,
          });
          const inbound = await this.inventory.receive(tx, {
            ...common,
            warehouseId: existing.toWarehouseId!,
            movementType: 'TRANSFER_IN',
            sourceType,
            unitCost: out.unitCost,
          });
          // The destination receives exactly the value relieved (unit cost x qty may round; align totals).
          movementIds.push(out.movementId, inbound.movementId);
          await tx
            .update(stockDocumentLines)
            .set({ unitCost: out.unitCost.toString(), totalCost: out.totalCost.toString() })
            .where(eq(stockDocumentLines.id, line.id));
          net = net.add(out.totalCost);
          continue;
        }
        if (line.direction === 'IN') {
          const unitCost = line.unitCost
            ? Money.of(line.unitCost, currency)
            : await this.inventory.currentCost(tx, product, existing.warehouseId, currency);
          const result = await this.inventory.receive(tx, {
            ...common,
            warehouseId: existing.warehouseId,
            movementType: 'ADJUSTMENT_IN',
            sourceType,
            unitCost,
          });
          movementIds.push(result.movementId);
          await tx
            .update(stockDocumentLines)
            .set({ unitCost: result.unitCost.toString(), totalCost: result.totalCost.toString() })
            .where(eq(stockDocumentLines.id, line.id));
          add(byInventoryAccount, product.accounts.inventory, result.totalCost, currency);
          net = net.add(result.totalCost);
        } else {
          const result = await this.inventory.issue(tx, {
            ...common,
            warehouseId: existing.warehouseId,
            movementType: 'ADJUSTMENT_OUT',
            sourceType,
            currency,
          });
          movementIds.push(result.movementId);
          await tx
            .update(stockDocumentLines)
            .set({ unitCost: result.unitCost.toString(), totalCost: result.totalCost.toString() })
            .where(eq(stockDocumentLines.id, line.id));
          add(byInventoryAccount, product.accounts.inventory, result.totalCost.negate(), currency);
          net = net.subtract(result.totalCost);
        }
      }

      let journalEntryId: string | null = null;
      if (type !== 'TRANSFER') {
        const postingLines: PostingLine[] = [];
        let adjustmentTotal = Money.zero(currency);
        for (const [accountId, value] of byInventoryAccount) {
          if (value.isZero()) continue;
          postingLines.push({
            accountId,
            debit: value.isPositive() ? value.toString() : '0',
            credit: value.isNegative() ? value.abs().toString() : '0',
            description: `${LABEL[type]} ${existing.documentNumber}`,
          });
          adjustmentTotal = adjustmentTotal.add(value);
        }
        if (!adjustmentTotal.isZero()) {
          postingLines.push({
            accountId: adjustmentAccount!.id,
            debit: adjustmentTotal.isNegative() ? adjustmentTotal.abs().toString() : '0',
            credit: adjustmentTotal.isPositive() ? adjustmentTotal.toString() : '0',
            description: `${LABEL[type]} ${existing.documentNumber}${existing.reason ? ` - ${existing.reason}` : ''}`,
          });
          const entry = await this.posting.postEvent(
            tx,
            {
              companyId,
              entryDate: existing.documentDate,
              description: `${LABEL[type]} ${existing.documentNumber}${existing.notes ? ` - ${existing.notes}` : ''}`,
              reference: existing.reference ?? existing.documentNumber,
              journalType: 'GENERAL',
              branchId: null,
              sourceType,
              sourceId: existing.id,
              actor,
              lines: postingLines,
            },
            { permission: P['inventory.post'] },
          );
          journalEntryId = entry.id;
          await this.inventory.setJournal(tx, movementIds, entry.id);
        }
      }
      await tx
        .update(stockDocuments)
        .set({
          status: 'POSTED',
          postedBy: actor.id,
          postedAt: new Date(),
          journalEntryId,
          totalCost: net.abs().toString(),
        })
        .where(eq(stockDocuments.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: entityType(type),
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'POSTED', journalEntryId, value: net.toString() },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, type, id);
  }

  // ----------------------------------------------------------------- helpers

  private async create(
    companyId: string,
    actor: AuthenticatedUser,
    type: StockDocumentType,
    input: {
      warehouseId: string;
      documentDate: string;
      reference?: string;
      notes?: string;
      idempotencyKey?: string;
      toWarehouseId?: string;
      reason?: string;
    },
    buildLines: (
      tx: DbExecutor,
      currency: string,
    ) => Promise<Array<Omit<typeof stockDocumentLines.$inferInsert, 'documentId'>>>,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: stockDocuments.id })
          .from(stockDocuments)
          .where(
            and(
              eq(stockDocuments.companyId, companyId),
              eq(stockDocuments.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      await this.inventory.resolveWarehouse(companyId, input.warehouseId, tx);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const lines = await buildLines(tx, currency);
      const documentNumber = await this.numbering.allocate(
        companyId,
        NUMBER_TYPE[type],
        Number(input.documentDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(stockDocuments)
        .values({
          companyId,
          documentType: type,
          documentNumber,
          warehouseId: input.warehouseId,
          toWarehouseId: input.toWarehouseId ?? null,
          documentDate: input.documentDate,
          reason:
            type === 'COUNT'
              ? 'COUNT_VARIANCE'
              : type === 'ADJUSTMENT'
                ? ((input.reason as StockDocument['reason']) ?? 'CORRECTION')
                : null,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          currency,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await tx
        .insert(stockDocumentLines)
        .values(lines.map((l) => ({ ...l, documentId: created!.id })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: entityType(type),
          entityId: created!.id,
          newValue: { documentNumber, lines: lines.length },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
  }

  private viewQuery(executor: DbExecutor) {
    const toWh = sql<
      string | null
    >`(select w2.code from warehouses w2 where w2.id = ${stockDocuments.toWarehouseId})`;
    const toWhName = sql<
      string | null
    >`(select w2.name from warehouses w2 where w2.id = ${stockDocuments.toWarehouseId})`;
    return executor
      .select({
        ...getTableColumns(stockDocuments),
        warehouseCode: warehouses.code,
        warehouseName: warehouses.name,
        toWarehouseCode: toWh,
        toWarehouseName: toWhName,
        journalNumber: sql<
          string | null
        >`(select je.document_number from journal_entries je where je.id = ${stockDocuments.journalEntryId})`,
        lineCount: sql<number>`(select count(*)::int from stock_document_lines l where l.document_id = ${stockDocuments.id})`,
      })
      .from(stockDocuments)
      .innerJoin(warehouses, eq(warehouses.id, stockDocuments.warehouseId))
      .$dynamic();
  }

  private async lock(
    tx: DbExecutor,
    companyId: string,
    type: StockDocumentType,
    id: string,
  ): Promise<StockDocument> {
    const [row] = await tx
      .select()
      .from(stockDocuments)
      .where(
        and(
          eq(stockDocuments.id, id),
          eq(stockDocuments.companyId, companyId),
          eq(stockDocuments.documentType, type),
        ),
      )
      .for('update');
    if (!row) throw new NotFoundError(LABEL[type], id);
    return row;
  }

  private assertStatus(doc: StockDocument, allowed: StockDocument['status'][], verb: string): void {
    if (!allowed.includes(doc.status)) {
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${doc.documentNumber} cannot be ${verb} from status ${doc.status}.`,
        { status: doc.status, allowed },
      );
    }
  }
}

function add(map: Map<string, Money>, key: string, value: Money, currency: string): void {
  map.set(key, (map.get(key) ?? Money.zero(currency)).add(value));
}

function entityType(type: StockDocumentType): string {
  return { ADJUSTMENT: 'StockAdjustment', TRANSFER: 'StockTransfer', COUNT: 'StockCount' }[type];
}
