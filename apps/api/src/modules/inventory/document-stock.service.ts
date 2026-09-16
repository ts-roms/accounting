import { Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { MovementSourceType } from '@accounting/types';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import type { DbExecutor } from '@/database/database.types';
import { orderLines, products, type OrderLine } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type { PostingLine } from '@/modules/accounting/journals/posting.service';
import { lineAmounts } from '@/modules/subledger/subledger.logic';
import { InventoryService } from './inventory.service';

/** The subset of an invoice / bill / credit-note line the stock engine needs. */
export interface StockDocumentLineRef {
  id: string;
  description: string;
  quantity: string;
  amount: string;
  accountId: string;
  branchId: string | null;
  productId: string | null;
  warehouseId: string | null;
  lotNumber: string | null;
  serialNumbers: string[];
  orderLineId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}

export interface StockPostingResult {
  /** Journal lines to add to (or replace in) the document's entry. */
  postingLines: PostingLine[];
  movementIds: string[];
  /** Cost relieved / received per document line id. */
  costByLine: Map<string, Money>;
}

/**
 * Bridges AR / AP documents and goods receipts to the stock engine: validates
 * product lines, moves the stock and returns the journal lines that carry the
 * inventory effect (COGS / inventory, inventory / GRNI, GRNI / PPV). The
 * calling service posts those lines in the same entry as the document.
 */
@Injectable()
export class DocumentStockService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly accounts: AccountsService,
  ) {}

  /** Product lines need an active product; goods need a warehouse. Returns the product ids that carry stock. */
  async validateLines(
    tx: DbExecutor,
    companyId: string,
    lines: Array<{ productId?: string | null; warehouseId?: string | null }>,
  ): Promise<void> {
    for (const [i, line] of lines.entries()) {
      if (!line.productId) continue;
      const product = await this.inventory.resolveProduct(companyId, line.productId, tx);
      if (product.productType === 'GOODS') {
        if (!line.warehouseId) {
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Line ${i + 1}: ${product.sku} is a stocked product - choose a warehouse.`,
          );
        }
        await this.inventory.resolveWarehouse(companyId, line.warehouseId, tx);
      }
    }
  }

  /**
   * Sales side. Invoices / debit notes issue stock (Dr COGS / Cr inventory);
   * credit notes take it back at the current cost (Dr inventory / Cr COGS).
   */
  async postSalesLines(
    tx: DbExecutor,
    input: {
      companyId: string;
      sourceId: string;
      movementDate: string;
      actorId: string;
      currency: string;
      isCreditNote: boolean;
      lines: StockDocumentLineRef[];
      /** Deliveries (Prompt #6) issue stock under their own source identity. */
      sourceType?: MovementSourceType;
    },
  ): Promise<StockPostingResult> {
    const result = empty();
    const stocked = await this.stockedLines(tx, input.companyId, input.lines);
    for (const { line, product } of stocked) {
      const base = {
        companyId: input.companyId,
        productId: product.id,
        warehouseId: line.warehouseId!,
        lotNumber: line.lotNumber,
        serialNumbers: line.serialNumbers,
        quantity: line.quantity,
        movementDate: input.movementDate,
        sourceType: (input.sourceType ?? 'AR_DOCUMENT') as MovementSourceType,
        sourceId: input.sourceId,
        sourceLineId: line.id,
        actorId: input.actorId,
        notes: line.description,
      };
      if (input.isCreditNote) {
        const unitCost = await this.inventory.currentCost(
          tx,
          product,
          line.warehouseId!,
          input.currency,
        );
        const m = await this.inventory.receive(tx, {
          ...base,
          movementType: 'RETURN_IN',
          unitCost,
        });
        result.movementIds.push(m.movementId);
        result.costByLine.set(line.id, m.totalCost);
        if (m.totalCost.isPositive()) {
          result.postingLines.push(
            {
              accountId: product.accounts.inventory,
              debit: m.totalCost.toString(),
              credit: '0',
              description: `${product.sku} returned to stock`,
              branchId: line.branchId,
              departmentId: line.departmentId ?? null,
              costCenterId: line.costCenterId ?? null,
              projectId: line.projectId ?? null,
            },
            {
              accountId: product.accounts.cogs,
              debit: '0',
              credit: m.totalCost.toString(),
              description: `${product.sku} cost of goods returned`,
              branchId: line.branchId,
              departmentId: line.departmentId ?? null,
              costCenterId: line.costCenterId ?? null,
              projectId: line.projectId ?? null,
            },
          );
        }
      } else {
        const m = await this.inventory.issue(tx, {
          ...base,
          movementType: 'ISSUE',
          currency: input.currency,
        });
        result.movementIds.push(m.movementId);
        result.costByLine.set(line.id, m.totalCost);
        if (m.totalCost.isPositive()) {
          result.postingLines.push(
            {
              accountId: product.accounts.cogs,
              debit: m.totalCost.toString(),
              credit: '0',
              description: `${product.sku} cost of goods sold`,
              branchId: line.branchId,
              departmentId: line.departmentId ?? null,
              costCenterId: line.costCenterId ?? null,
              projectId: line.projectId ?? null,
            },
            {
              accountId: product.accounts.inventory,
              debit: '0',
              credit: m.totalCost.toString(),
              description: `${product.sku} issued from stock`,
              branchId: line.branchId,
              departmentId: line.departmentId ?? null,
              costCenterId: line.costCenterId ?? null,
              projectId: line.projectId ?? null,
            },
          );
        }
      }
    }
    return result;
  }

  /**
   * Purchase side. Returns the journal lines that replace the plain expense
   * line for every stocked product line:
   *  - PO line already received (accrued): Dr GRNI at the receipt cost, variance to PPV
   *  - direct purchase (no PO): stock received now, Dr inventory at cost, rounding to PPV
   *  - vendor credit note: stock issued back (RETURN_OUT), Cr inventory at cost, variance to PPV
   * Non-stock lines are returned unchanged.
   */
  async postPurchaseLines(
    tx: DbExecutor,
    input: {
      companyId: string;
      sourceId: string;
      movementDate: string;
      actorId: string;
      currency: string;
      isCreditNote: boolean;
      lines: StockDocumentLineRef[];
    },
  ): Promise<StockPostingResult> {
    const result = empty();
    const currency = input.currency;
    const stocked = await this.stockedLines(tx, input.companyId, input.lines);
    const stockedIds = new Set(stocked.map((s) => s.line.id));
    const grni = stocked.length
      ? await this.accounts.resolveMapped(input.companyId, 'GOODS_RECEIVED_NOT_INVOICED', tx)
      : null;
    const ppv = stocked.length
      ? await this.accounts.resolveMapped(input.companyId, 'PURCHASE_PRICE_VARIANCE', tx)
      : null;
    const poLineIds = stocked.map((s) => s.line.orderLineId).filter((x): x is string => Boolean(x));
    const poLines = new Map<string, OrderLine>(
      poLineIds.length
        ? (await tx.select().from(orderLines).where(inArray(orderLines.id, poLineIds))).map((l) => [
            l.id,
            l,
          ])
        : [],
    );

    for (const line of input.lines) {
      if (!stockedIds.has(line.id)) {
        // Services and non-product lines keep their expense / income account.
        result.postingLines.push({
          accountId: line.accountId,
          debit: input.isCreditNote ? '0' : line.amount,
          credit: input.isCreditNote ? line.amount : '0',
          description: line.description,
          branchId: line.branchId,
          departmentId: line.departmentId ?? null,
          costCenterId: line.costCenterId ?? null,
          projectId: line.projectId ?? null,
        });
        continue;
      }
      const { product } = stocked.find((s) => s.line.id === line.id)!;
      const amount = Money.of(line.amount, currency);
      const base = {
        companyId: input.companyId,
        productId: product.id,
        warehouseId: line.warehouseId!,
        lotNumber: line.lotNumber,
        serialNumbers: line.serialNumbers,
        quantity: line.quantity,
        movementDate: input.movementDate,
        sourceType: 'AP_DOCUMENT' as MovementSourceType,
        sourceId: input.sourceId,
        sourceLineId: line.id,
        actorId: input.actorId,
        notes: line.description,
      };
      const poLine = line.orderLineId ? poLines.get(line.orderLineId) : undefined;

      if (input.isCreditNote) {
        // Goods going back to the vendor: relieve stock at cost; price difference is a purchase variance.
        const m = await this.inventory.issue(tx, { ...base, movementType: 'RETURN_OUT', currency });
        result.movementIds.push(m.movementId);
        result.costByLine.set(line.id, m.totalCost);
        this.pushValue(
          result,
          product.accounts.inventory,
          m.totalCost.negate(),
          `${product.sku} returned to vendor`,
          line.branchId,
        );
        this.pushValue(
          result,
          ppv!.id,
          m.totalCost.subtract(amount),
          `${product.sku} purchase price variance`,
          line.branchId,
        );
      } else if (poLine?.productId) {
        // Received against the purchase order: the receipt already debited inventory and credited GRNI.
        const accrued = lineAmounts(
          line.quantity,
          poLine.unitPrice,
          poLine.discountPercent,
          currency,
        ).net;
        result.costByLine.set(line.id, accrued);
        this.pushValue(
          result,
          grni!.id,
          accrued,
          `${product.sku} goods received not invoiced`,
          line.branchId,
        );
        this.pushValue(
          result,
          ppv!.id,
          amount.subtract(accrued),
          `${product.sku} purchase price variance`,
          line.branchId,
        );
      } else {
        // Direct purchase: stock arrives with the bill.
        const unitCost = amount.divide(line.quantity);
        const m = await this.inventory.receive(tx, { ...base, movementType: 'RECEIPT', unitCost });
        result.movementIds.push(m.movementId);
        result.costByLine.set(line.id, m.totalCost);
        this.pushValue(
          result,
          product.accounts.inventory,
          m.totalCost,
          `${product.sku} received into stock`,
          line.branchId,
        );
        this.pushValue(
          result,
          ppv!.id,
          amount.subtract(m.totalCost),
          `${product.sku} rounding variance`,
          line.branchId,
        );
      }
    }
    return result;
  }

  /** Goods receipt confirmation: stock in at the PO net price, Dr inventory / Cr GRNI. */
  async postReceiptLines(
    tx: DbExecutor,
    input: {
      companyId: string;
      sourceId: string;
      movementDate: string;
      actorId: string;
      currency: string;
      lines: Array<{
        id: string;
        orderLine: OrderLine;
        quantity: string;
        lotNumber: string | null;
        expiryDate: string | null;
        serialNumbers: string[];
      }>;
    },
  ): Promise<StockPostingResult> {
    const result = empty();
    const stockedLines = input.lines.filter((l) => l.orderLine.productId);
    if (stockedLines.length === 0) return result;
    const grni = await this.accounts.resolveMapped(
      input.companyId,
      'GOODS_RECEIVED_NOT_INVOICED',
      tx,
    );
    for (const line of stockedLines) {
      const product = await this.inventory.resolveProduct(
        input.companyId,
        line.orderLine.productId!,
        tx,
      );
      if (product.productType !== 'GOODS') continue;
      if (!line.orderLine.warehouseId) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `PO line ${line.orderLine.lineNumber} (${product.sku}) has no warehouse to receive into.`,
        );
      }
      const unitCost = lineAmounts(
        '1',
        line.orderLine.unitPrice,
        line.orderLine.discountPercent,
        input.currency,
      ).net;
      const m = await this.inventory.receive(tx, {
        companyId: input.companyId,
        productId: product.id,
        warehouseId: line.orderLine.warehouseId,
        lotNumber: line.lotNumber,
        expiryDate: line.expiryDate,
        serialNumbers: line.serialNumbers,
        quantity: line.quantity,
        movementDate: input.movementDate,
        movementType: 'RECEIPT',
        sourceType: 'GOODS_RECEIPT',
        sourceId: input.sourceId,
        sourceLineId: line.id,
        actorId: input.actorId,
        unitCost,
      });
      result.movementIds.push(m.movementId);
      result.costByLine.set(line.id, m.totalCost);
      this.pushValue(
        result,
        product.accounts.inventory,
        m.totalCost,
        `${product.sku} received`,
        line.orderLine.branchId,
      );
      this.pushValue(
        result,
        grni.id,
        m.totalCost.negate(),
        `${product.sku} goods received not invoiced`,
        line.orderLine.branchId,
      );
    }
    return result;
  }

  // ----------------------------------------------------------------- helpers

  private async stockedLines(tx: DbExecutor, companyId: string, lines: StockDocumentLineRef[]) {
    const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: products.id, type: products.productType })
      .from(products)
      .where(inArray(products.id, ids));
    const goods = new Set(rows.filter((r) => r.type === 'GOODS').map((r) => r.id));
    const out = [];
    for (const line of lines) {
      if (!line.productId || !goods.has(line.productId)) continue;
      if (!line.warehouseId) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${line.description}: a warehouse is required for stocked products.`,
        );
      }
      const product = await this.inventory.resolveProduct(companyId, line.productId, tx, {
        allowInactive: true,
      });
      out.push({ line, product });
    }
    return out;
  }

  /** Signed value -> debit (positive) or credit (negative) line; zero is skipped. */
  private pushValue(
    result: StockPostingResult,
    accountId: string,
    value: Money,
    description: string,
    branchId: string | null,
  ): void {
    if (value.isZero()) return;
    result.postingLines.push({
      accountId,
      debit: value.isPositive() ? value.toString() : '0',
      credit: value.isNegative() ? value.abs().toString() : '0',
      description,
      branchId,
    });
  }
}

function empty(): StockPostingResult {
  return { postingLines: [], movementIds: [], costByLine: new Map() };
}
