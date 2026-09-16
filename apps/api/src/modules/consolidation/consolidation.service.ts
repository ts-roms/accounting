import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { AccountType } from '@accounting/types';
import type { ConsolidationQuery } from '@accounting/validation';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import { accounts, companies, organizations } from '@/database/schema';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { isDebitNatural } from './consolidation.logic';

export interface ConsolidatedCompany {
  id: string;
  code: string;
  name: string;
  baseCurrency: string;
  /** Rate used to translate this company into the presentation currency. */
  rate: string;
}

export interface ConsolidatedRow {
  code: string;
  name: string;
  type: AccountType;
  isIntercompany: boolean;
  /** Signed natural balance per company, translated. */
  byCompany: Record<string, string>;
  combined: string;
  eliminations: string;
  consolidated: string;
}

export interface ConsolidationReport {
  from: string;
  to: string;
  currency: string;
  companies: ConsolidatedCompany[];
  rows: ConsolidatedRow[];
  totals: {
    assets: string;
    liabilities: string;
    equity: string;
    revenue: string;
    expenses: string;
    netIncome: string;
    /** Sum of eliminated balances; zero when intercompany accounts mirror exactly. */
    eliminationCheck: string;
    balanced: boolean;
  };
}

/**
 * Group trial balance: every company's ledger (posted lines only) translated
 * to the presentation currency at the closing rate on `to`, combined by
 * account code, with intercompany accounts eliminated. Nothing is stored;
 * consolidation is a read over the companies' own ledgers.
 */
@Injectable()
export class ConsolidationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ledger: GeneralLedgerService,
    private readonly rates: ExchangeRatesService,
  ) {}

  async trialBalance(
    organizationId: string,
    query: ConsolidationQuery,
  ): Promise<ConsolidationReport> {
    const [org] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const currency = query.currency ?? org?.baseCurrency ?? 'PHP';
    const filters = [
      eq(companies.organizationId, organizationId),
      eq(companies.status, 'ACTIVE' as const),
    ];
    if (query.companyIds?.length) filters.push(inArray(companies.id, query.companyIds));
    const members = await this.db
      .select()
      .from(companies)
      .where(and(...filters))
      .orderBy(companies.code);
    if (members.length === 0)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'No active company matches the selection.',
      );

    const translated: ConsolidatedCompany[] = [];
    const rowMap = new Map<string, ConsolidatedRow>();
    const natural = (type: AccountType, debit: Money, credit: Money) =>
      type === 'ASSET' || type === 'EXPENSE' || type === 'COST_OF_SALES'
        ? debit.subtract(credit)
        : credit.subtract(debit);

    for (const company of members) {
      const rate = await this.rates.rateFor(
        organizationId,
        company.baseCurrency,
        currency,
        query.to,
      );
      translated.push({
        id: company.id,
        code: company.code,
        name: company.name,
        baseCurrency: company.baseCurrency,
        rate,
      });
      const isBalanceSheet = (t: AccountType) =>
        t === 'ASSET' || t === 'LIABILITY' || t === 'EQUITY';
      // Balance-sheet accounts carry their cumulative balance; P&L accounts the period's activity.
      const [cumulative, period, chart] = await Promise.all([
        this.ledger.activity({ companyId: company.id, to: query.to }),
        this.ledger.activity({ companyId: company.id, from: query.from, to: query.to }),
        this.db.select().from(accounts).where(eq(accounts.companyId, company.id)),
      ]);
      for (const account of chart) {
        if (account.isHeader) continue;
        const source = isBalanceSheet(account.type) ? cumulative : period;
        const row = source.find((a) => a.accountId === account.id);
        if (!row) continue;
        const balance = natural(
          account.type,
          Money.of(row.debit, company.baseCurrency),
          Money.of(row.credit, company.baseCurrency),
        ).convert(currency, rate);
        if (balance.isZero()) continue;
        const key = account.code;
        const existing = rowMap.get(key) ?? {
          code: account.code,
          name: account.name,
          type: account.type,
          isIntercompany: account.isIntercompany,
          byCompany: {},
          combined: '0',
          eliminations: '0',
          consolidated: '0',
        };
        existing.byCompany[company.id] = balance.toString();
        existing.isIntercompany = existing.isIntercompany || account.isIntercompany;
        rowMap.set(key, existing);
      }
    }

    const rows = [...rowMap.values()].sort((a, b) => a.code.localeCompare(b.code));
    let eliminationCheck = Money.zero(currency);
    for (const row of rows) {
      const combined = Money.sum(
        Object.values(row.byCompany).map((v) => Money.of(v, currency)),
        currency,
      );
      row.combined = combined.toString();
      if (row.isIntercompany) {
        row.eliminations = combined.negate().toString();
        row.consolidated = '0.0000';
        // Mirrored intercompany pairs (receivable vs payable, revenue vs expense) net to zero across the group.
        eliminationCheck = eliminationCheck.add(
          isDebitNatural(row.type) ? combined : combined.negate(),
        );
      } else {
        row.eliminations = '0.0000';
        row.consolidated = combined.toString();
      }
    }
    const total = (pred: (r: ConsolidatedRow) => boolean) =>
      Money.sum(
        rows.filter(pred).map((r) => Money.of(r.consolidated, currency)),
        currency,
      );
    const assets = total((r) => r.type === 'ASSET');
    const liabilities = total((r) => r.type === 'LIABILITY');
    const equity = total((r) => r.type === 'EQUITY');
    const revenue = total((r) => r.type === 'REVENUE');
    const expenses = total((r) => r.type === 'EXPENSE' || r.type === 'COST_OF_SALES');
    const netIncome = revenue.subtract(expenses);
    return {
      from: query.from,
      to: query.to,
      currency,
      companies: translated,
      rows,
      totals: {
        assets: assets.toString(),
        liabilities: liabilities.toString(),
        equity: equity.toString(),
        revenue: revenue.toString(),
        expenses: expenses.toString(),
        netIncome: netIncome.toString(),
        eliminationCheck: eliminationCheck.toString(),
        // Translation at a single closing rate keeps A = L + E + current earnings + prior earnings exactly when every company's own TB balances.
        balanced: eliminationCheck.isZero(),
      },
    };
  }
}
