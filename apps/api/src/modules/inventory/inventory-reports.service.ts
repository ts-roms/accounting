import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { PaginatedResult } from '@accounting/types';
import type { StockCardQuery, StockOnHandQuery, ValuationQuery } from '@accounting/validation';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accounts,
  inventoryBalances,
  inventoryMovements,
  journalEntries,
  productCategories,
  products,
  stockLots,
  warehouses,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { averageCost } from './valuation';

export interface StockOnHandRow {
  productId: string;
  sku: string;
  productName: string;
  unitOfMeasure: string;
  categoryName: string | null;
  warehouseId: string;
  warehouseCode: string;
  lotId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  quantityOnHand: string;
  totalCost: string;
  averageCost: string;
  reorderLevel: string | null;
  belowReorder: boolean;
}

export interface StockCardRow {
  id: string;
  movementDate: string;
  movementType: string;
  warehouseCode: string;
  lotNumber: string | null;
  quantityIn: string;
  quantityOut: string;
  unitCost: string;
  totalCost: string;
  balanceAfter: string;
  sourceType: string;
  sourceId: string;
  journalNumber: string | null;
  createdAt: Date;
}

export interface ValuationReport {
  asOf: string;
  currency: string;
  accounts: Array<{
    accountId: string;
    code: string;
    name: string;
    subledgerValue: string;
    ledgerBalance: string;
    difference: string;
    reconciled: boolean;
  }>;
  totalSubledger: string;
  totalLedger: string;
  reconciled: boolean;
  byWarehouse: Array<{
    warehouseId: string;
    code: string;
    name: string;
    value: string;
    quantity: string;
  }>;
}

/** Stock on hand, stock cards, valuation vs. the inventory control account(s), reorder list. */
@Injectable()
export class InventoryReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
  ) {}

  async stockOnHand(
    companyId: string,
    query: StockOnHandQuery,
  ): Promise<{
    currency: string;
    rows: StockOnHandRow[];
    totals: { quantity: string; value: string };
  }> {
    const currency = await this.accounts.companyCurrency(companyId);
    const filters: SQL[] = [eq(inventoryBalances.companyId, companyId)];
    if (query.warehouseId) filters.push(eq(inventoryBalances.warehouseId, query.warehouseId));
    if (query.productId) filters.push(eq(inventoryBalances.productId, query.productId));
    if (query.categoryId) filters.push(eq(products.categoryId, query.categoryId));
    if (!query.includeZero) filters.push(sql`${inventoryBalances.quantityOnHand} <> 0`);
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(ilike(products.sku, term), ilike(products.name, term))!);
    }
    const rows = await this.db
      .select({
        productId: products.id,
        sku: products.sku,
        productName: products.name,
        unitOfMeasure: products.unitOfMeasure,
        categoryName: productCategories.name,
        warehouseId: warehouses.id,
        warehouseCode: warehouses.code,
        lotId: inventoryBalances.lotId,
        lotNumber: stockLots.lotNumber,
        expiryDate: stockLots.expiryDate,
        quantityOnHand: inventoryBalances.quantityOnHand,
        totalCost: inventoryBalances.totalCost,
        reorderLevel: products.reorderLevel,
        productOnHand: sql<string>`(select coalesce(sum(b2.quantity_on_hand), 0) from inventory_balances b2 where b2.product_id = ${products.id})`,
      })
      .from(inventoryBalances)
      .innerJoin(products, eq(products.id, inventoryBalances.productId))
      .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
      .innerJoin(warehouses, eq(warehouses.id, inventoryBalances.warehouseId))
      .leftJoin(stockLots, eq(stockLots.id, inventoryBalances.lotId))
      .where(and(...filters))
      .orderBy(asc(products.sku), asc(warehouses.code), asc(stockLots.lotNumber));
    let quantity = Money.zero(currency);
    let value = Money.zero(currency);
    const out = rows.map((r) => {
      quantity = quantity.add(Money.of(r.quantityOnHand, currency));
      value = value.add(Money.of(r.totalCost, currency));
      return {
        ...r,
        averageCost: averageCost(
          { quantityOnHand: r.quantityOnHand, totalCost: r.totalCost },
          currency,
        ).toString(),
        belowReorder:
          r.reorderLevel !== null &&
          Money.of(r.productOnHand, currency).compare(Money.of(r.reorderLevel, currency)) <= 0,
      };
    });
    return {
      currency,
      rows: out,
      totals: { quantity: quantity.toString(), value: value.toString() },
    };
  }

  async stockCard(
    companyId: string,
    query: StockCardQuery,
  ): Promise<PaginatedResult<StockCardRow>> {
    const filters: SQL[] = [
      eq(inventoryMovements.companyId, companyId),
      eq(inventoryMovements.productId, query.productId),
    ];
    if (query.warehouseId) filters.push(eq(inventoryMovements.warehouseId, query.warehouseId));
    if (query.from) filters.push(gte(inventoryMovements.movementDate, query.from));
    if (query.to) filters.push(lte(inventoryMovements.movementDate, query.to));
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          id: inventoryMovements.id,
          movementDate: inventoryMovements.movementDate,
          movementType: inventoryMovements.movementType,
          warehouseCode: warehouses.code,
          lotNumber: stockLots.lotNumber,
          quantity: inventoryMovements.quantity,
          unitCost: inventoryMovements.unitCost,
          totalCost: inventoryMovements.totalCost,
          balanceAfter: inventoryMovements.balanceAfter,
          sourceType: inventoryMovements.sourceType,
          sourceId: inventoryMovements.sourceId,
          journalNumber: journalEntries.documentNumber,
          createdAt: inventoryMovements.createdAt,
        })
        .from(inventoryMovements)
        .innerJoin(warehouses, eq(warehouses.id, inventoryMovements.warehouseId))
        .leftJoin(stockLots, eq(stockLots.id, inventoryMovements.lotId))
        .leftJoin(journalEntries, eq(journalEntries.id, inventoryMovements.journalEntryId))
        .where(where)
        .orderBy(desc(inventoryMovements.movementDate), desc(inventoryMovements.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(inventoryMovements)
        .where(where),
    ]);
    const inbound = new Set(['RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'RETURN_IN']);
    return toPaginatedResult(
      rows.map((r) => ({
        ...r,
        quantityIn: inbound.has(r.movementType) ? r.quantity : '0.0000',
        quantityOut: inbound.has(r.movementType) ? '0.0000' : r.quantity,
      })),
      Number(countRows[0]?.total ?? 0),
      query,
    );
  }

  /**
   * Inventory subledger vs. the general ledger, per inventory account, both as
   * of `asOf`. The subledger value is the signed sum of movement costs up to the
   * date for products posting to that account (running balances only know
   * "now"); the ledger side is the account's balance at `asOf`.
   */
  async valuation(companyId: string, query: ValuationQuery): Promise<ValuationReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const inventoryDefault = await this.accounts.resolveMapped(companyId, 'INVENTORY');
    const signedCost = sql<string>`coalesce(sum(case when ${inventoryMovements.movementType} in ('RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'RETURN_IN') then ${inventoryMovements.totalCost} else -${inventoryMovements.totalCost} end), 0)`;
    const signedQuantity = sql<string>`coalesce(sum(case when ${inventoryMovements.movementType} in ('RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'RETURN_IN') then ${inventoryMovements.quantity} else -${inventoryMovements.quantity} end), 0)`;
    const upToDate = and(
      eq(inventoryMovements.companyId, companyId),
      lte(inventoryMovements.movementDate, query.asOf),
    );
    // Effective inventory account per product: product override -> category override -> mapping.
    const rows = await this.db
      .select({
        accountId: sql<string>`coalesce(${products.inventoryAccountId}, ${productCategories.inventoryAccountId}, ${sql.raw(`'${inventoryDefault.id}'::uuid`)})`,
        value: signedCost,
      })
      .from(inventoryMovements)
      .innerJoin(products, eq(products.id, inventoryMovements.productId))
      .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
      .where(upToDate)
      .groupBy(sql`1`);
    const accountIds = [...new Set([inventoryDefault.id, ...rows.map((r) => r.accountId)])];
    const accountRows = await this.db
      .select()
      .from(accounts)
      .where(sql`${accounts.id} in ${accountIds}`);
    const result: ValuationReport['accounts'] = [];
    let totalSub = Money.zero(currency);
    let totalLedger = Money.zero(currency);
    const activity = await this.ledger.activity({
      companyId,
      to: query.asOf,
      accountIds: accountRows.map((a) => a.id),
    });
    for (const account of accountRows) {
      const sub = Money.of(rows.find((r) => r.accountId === account.id)?.value ?? '0', currency);
      const row = activity.find((a) => a.accountId === account.id);
      const ledger = Money.of(row?.debit ?? '0', currency).subtract(
        Money.of(row?.credit ?? '0', currency),
      );
      totalSub = totalSub.add(sub);
      totalLedger = totalLedger.add(ledger);
      result.push({
        accountId: account.id,
        code: account.code,
        name: account.name,
        subledgerValue: sub.toString(),
        ledgerBalance: ledger.toString(),
        difference: ledger.subtract(sub).toString(),
        reconciled: ledger.equals(sub),
      });
    }
    const byWarehouse = await this.db
      .select({
        warehouseId: warehouses.id,
        code: warehouses.code,
        name: warehouses.name,
        value: signedCost,
        quantity: signedQuantity,
      })
      .from(warehouses)
      .leftJoin(
        inventoryMovements,
        and(eq(inventoryMovements.warehouseId, warehouses.id), upToDate),
      )
      .where(eq(warehouses.companyId, companyId))
      .groupBy(warehouses.id, warehouses.code, warehouses.name)
      .orderBy(asc(warehouses.code));
    return {
      asOf: query.asOf,
      currency,
      accounts: result.sort((a, b) => a.code.localeCompare(b.code)),
      totalSubledger: totalSub.toString(),
      totalLedger: totalLedger.toString(),
      reconciled: totalSub.equals(totalLedger) && result.every((r) => r.reconciled),
      byWarehouse,
    };
  }
}
