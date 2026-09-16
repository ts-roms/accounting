import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, getTableColumns, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { TaxSide } from '@accounting/types';
import type {
  CreateTaxCodeInput,
  ListTaxCodesQuery,
  TaxRateInput,
  UpdateTaxCodeInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { taxCodes, taxRates, type TaxCode, type TaxRate } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';
import { resolveRate } from './tax.logic';

const MODULE = 'TAX';

export interface TaxCodeView extends TaxCode {
  salesAccountCode: string | null;
  purchaseAccountCode: string | null;
  rates: TaxRate[];
  /** Rate in force today, for pickers. */
  currentRate: string | null;
  transactionCount: number;
}

/** Tax codes and their effective-dated rates. Rates never change history: a new rate starts a new row. */
@Injectable()
export class TaxCodesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async list(companyId: string, query: ListTaxCodesQuery): Promise<TaxCodeView[]> {
    const filters: SQL[] = [eq(taxCodes.companyId, companyId)];
    if (query.status) filters.push(eq(taxCodes.status, query.status));
    if (query.kind) filters.push(eq(taxCodes.kind, query.kind));
    if (query.side) filters.push(inArray(taxCodes.appliesTo, [query.side, 'BOTH']));
    const rows = await this.db
      .select({
        ...getTableColumns(taxCodes),
        salesAccountCode: sql<
          string | null
        >`(select a.code from accounts a where a.id = ${sql.raw('"tax_codes"."sales_account_id"')})`,
        purchaseAccountCode: sql<
          string | null
        >`(select a.code from accounts a where a.id = ${sql.raw('"tax_codes"."purchase_account_id"')})`,
        transactionCount: sql<number>`(select count(*)::int from tax_transactions t where t.tax_code_id = ${sql.raw('"tax_codes"."id"')})`,
      })
      .from(taxCodes)
      .where(and(...filters))
      .orderBy(asc(taxCodes.kind), asc(taxCodes.code));
    if (rows.length === 0) return [];
    const rates = await this.db
      .select()
      .from(taxRates)
      .where(
        inArray(
          taxRates.taxCodeId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(taxRates.effectiveFrom));
    const today = new Date().toISOString().slice(0, 10);
    return rows.map((r) => {
      const own = rates.filter((x) => x.taxCodeId === r.id);
      return { ...r, rates: own, currentRate: resolveRate(own, today)?.ratePercent ?? null };
    });
  }

  async get(companyId: string, id: string): Promise<TaxCodeView> {
    const row = (await this.list(companyId, {})).find((c) => c.id === id);
    if (!row) throw new NotFoundError('Tax code', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateTaxCodeInput,
  ): Promise<TaxCodeView> {
    const id = await this.db.transaction(async (tx) => {
      await this.assertAccounts(tx, companyId, input.salesAccountId, input.purchaseAccountId);
      assertRates(input.rates);
      try {
        const [row] = await tx
          .insert(taxCodes)
          .values({
            companyId,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            kind: input.kind,
            appliesTo: input.appliesTo,
            reportingCategory: input.reportingCategory,
            salesAccountId: input.salesAccountId ?? null,
            purchaseAccountId: input.purchaseAccountId ?? null,
            isDefaultSales: input.isDefaultSales,
            isDefaultPurchases: input.isDefaultPurchases,
          })
          .returning();
        await tx.insert(taxRates).values(
          input.rates.map((r) => ({
            taxCodeId: row!.id,
            ratePercent: r.ratePercent,
            effectiveFrom: r.effectiveFrom,
            effectiveTo: r.effectiveTo ?? null,
          })),
        );
        await this.clearOtherDefaults(
          tx,
          companyId,
          row!.id,
          input.isDefaultSales,
          input.isDefaultPurchases,
        );
        await this.audit.record(
          {
            action: 'CREATE',
            module: MODULE,
            entityType: 'TaxCode',
            entityId: row!.id,
            newValue: { code: input.code, kind: input.kind, rates: input.rates },
            metadata: { actor: actor.email },
            companyId,
          },
          tx,
        );
        return row!.id;
      } catch (err) {
        if (isUniqueViolation(err, 'tax_codes_company_code_uq'))
          throw new DuplicateError('Tax code', 'code', input.code);
        throw err;
      }
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateTaxCodeInput,
  ): Promise<TaxCodeView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(taxCodes)
        .where(and(eq(taxCodes.id, id), eq(taxCodes.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Tax code', id);
      const salesAccountId =
        input.salesAccountId === undefined ? existing.salesAccountId : input.salesAccountId;
      const purchaseAccountId =
        input.purchaseAccountId === undefined
          ? existing.purchaseAccountId
          : input.purchaseAccountId;
      if (existing.appliesTo !== 'PURCHASES' && !salesAccountId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A sales-side account is required.',
        );
      if (existing.appliesTo !== 'SALES' && !purchaseAccountId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A purchase-side account is required.',
        );
      await this.assertAccounts(tx, companyId, salesAccountId, purchaseAccountId);
      if (input.rates) {
        assertRates(input.rates);
        // Rates used by posted transactions must remain resolvable: keep history, replace the set.
        await tx.delete(taxRates).where(eq(taxRates.taxCodeId, id));
        await tx.insert(taxRates).values(
          input.rates.map((r) => ({
            taxCodeId: id,
            ratePercent: r.ratePercent,
            effectiveFrom: r.effectiveFrom,
            effectiveTo: r.effectiveTo ?? null,
          })),
        );
      }
      const isDefaultSales = input.isDefaultSales ?? existing.isDefaultSales;
      const isDefaultPurchases = input.isDefaultPurchases ?? existing.isDefaultPurchases;
      await tx
        .update(taxCodes)
        .set({
          name: input.name ?? existing.name,
          description: input.description === undefined ? existing.description : input.description,
          reportingCategory: input.reportingCategory ?? existing.reportingCategory,
          salesAccountId,
          purchaseAccountId,
          isDefaultSales,
          isDefaultPurchases,
          status: input.status ?? existing.status,
        })
        .where(eq(taxCodes.id, id));
      await this.clearOtherDefaults(tx, companyId, id, isDefaultSales, isDefaultPurchases);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'TaxCode',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email, code: existing.code },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Codes usable on one side, for pickers. */
  async forSide(companyId: string, side: TaxSide): Promise<TaxCodeView[]> {
    return this.list(companyId, { side, status: 'ACTIVE' });
  }

  private async clearOtherDefaults(
    tx: DbExecutor,
    companyId: string,
    id: string,
    sales: boolean,
    purchases: boolean,
  ): Promise<void> {
    if (sales)
      await tx
        .update(taxCodes)
        .set({ isDefaultSales: false })
        .where(
          and(
            eq(taxCodes.companyId, companyId),
            ne(taxCodes.id, id),
            eq(taxCodes.isDefaultSales, true),
          ),
        );
    if (purchases)
      await tx
        .update(taxCodes)
        .set({ isDefaultPurchases: false })
        .where(
          and(
            eq(taxCodes.companyId, companyId),
            ne(taxCodes.id, id),
            eq(taxCodes.isDefaultPurchases, true),
          ),
        );
  }

  private async assertAccounts(
    tx: DbExecutor,
    companyId: string,
    ...ids: Array<string | null | undefined>
  ): Promise<void> {
    const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (wanted.length === 0) return;
    const rows = await this.accounts.findByIds(companyId, wanted, tx);
    for (const id of wanted) {
      const account = rows.find((a) => a.id === id);
      if (!account) throw new NotFoundError('Account', id);
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be used for postings.`,
        );
    }
  }
}

/** Rate windows must not overlap and at most one may be open-ended. */
function assertRates(rates: readonly TaxRateInput[]): void {
  const sorted = [...rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.effectiveTo && r.effectiveTo < r.effectiveFrom)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'A rate cannot end before it starts.',
      );
    const next = sorted[i + 1];
    if (next && (!r.effectiveTo || r.effectiveTo >= next.effectiveFrom)) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `Rate windows overlap around ${next.effectiveFrom}.`,
      );
    }
  }
}
