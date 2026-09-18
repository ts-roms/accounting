import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { IntercompanyMatchStatus } from '@accounting/types';
import type { IntercompanyReconciliationQuery } from '@accounting/validation';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  consolidationGroupMembers,
  intercompanyTransactions,
  journalEntries,
  organizations,
} from '@/database/schema';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { naturalBalance } from './consolidation.logic';

export interface IntercompanyPair {
  fromCompanyId: string;
  fromCompanyCode: string;
  toCompanyId: string;
  toCompanyCode: string;
  /** Posted, unsettled transactions. */
  count: number;
  /** What the originating company owes, in its currency. */
  owed: string;
  owedCurrency: string;
  /** What the receiving company booked as receivable, in its currency. */
  receivable: string;
  receivableCurrency: string;
  /** Both sides in the presentation currency and their difference. */
  owedPresentation: string;
  receivablePresentation: string;
  difference: string;
  status: IntercompanyMatchStatus;
}

export interface IntercompanyEntity {
  companyId: string;
  companyCode: string;
  currency: string;
  /** GL balance of the accounts flagged intercompany (receivable side / payable side), company currency. */
  receivableLedger: string;
  payableLedger: string;
  /** What the intercompany register says should be there. */
  receivableExpected: string;
  payableExpected: string;
  receivableDifference: string;
  payableDifference: string;
}

export interface IntercompanyReconciliation {
  asOf: string;
  currency: string;
  pairs: IntercompanyPair[];
  entities: IntercompanyEntity[];
  totals: { openTransactions: string; unmatchedPairs: number; entitiesWithDrift: number };
}

/**
 * Intercompany reconciliation (Prompt #9). Two views: by company pair from
 * the intercompany register (what one member owes another, mirrored on both
 * sides), and per entity: the ledger balance of the intercompany accounts
 * against what the register expects, so postings made outside the
 * intercompany module surface as drift.
 */
@Injectable()
export class IntercompanyReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ledger: GeneralLedgerService,
    private readonly rates: ExchangeRatesService,
  ) {}

  async reconcile(
    organizationId: string,
    query: IntercompanyReconciliationQuery,
    executor: DbExecutor = this.db,
  ): Promise<IntercompanyReconciliation> {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const [org] = await executor
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const currency = query.currency ?? org?.baseCurrency ?? 'PHP';
    let members = await executor
      .select()
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.status, 'ACTIVE')));
    if (query.groupId) {
      const ids = (
        await executor
          .select({ companyId: consolidationGroupMembers.companyId })
          .from(consolidationGroupMembers)
          .where(eq(consolidationGroupMembers.groupId, query.groupId))
      ).map((r) => r.companyId);
      members = members.filter((c) => ids.includes(c.id));
    }
    const memberIds = members.map((c) => c.id);
    const byId = new Map(members.map((c) => [c.id, c]));
    if (!memberIds.length)
      return {
        asOf,
        currency,
        pairs: [],
        entities: [],
        totals: { openTransactions: '0.0000', unmatchedPairs: 0, entitiesWithDrift: 0 },
      };

    // Open register: posted, not yet settled, dated on or before asOf.
    const open = await executor
      .select({ tx: intercompanyTransactions, toTotal: journalEntries.totalDebit })
      .from(intercompanyTransactions)
      .leftJoin(journalEntries, eq(journalEntries.id, intercompanyTransactions.toJournalEntryId))
      .where(
        and(
          eq(intercompanyTransactions.organizationId, organizationId),
          eq(intercompanyTransactions.status, 'POSTED'),
          lte(intercompanyTransactions.transactionDate, asOf),
          inArray(intercompanyTransactions.fromCompanyId, memberIds),
          inArray(intercompanyTransactions.toCompanyId, memberIds),
        ),
      );

    const pairMap = new Map<string, IntercompanyPair & { owedM: Money; recM: Money }>();
    const expectedPayable = new Map<string, Money>();
    const expectedReceivable = new Map<string, Money>();
    for (const { tx, toTotal } of open) {
      const from = byId.get(tx.fromCompanyId)!;
      const to = byId.get(tx.toCompanyId)!;
      const key = `${tx.fromCompanyId}:${tx.toCompanyId}`;
      const owed = Money.of(tx.amount, from.baseCurrency);
      const rec = Money.of(toTotal ?? tx.amount, to.baseCurrency);
      const pair = pairMap.get(key) ?? {
        fromCompanyId: tx.fromCompanyId,
        fromCompanyCode: from.code,
        toCompanyId: tx.toCompanyId,
        toCompanyCode: to.code,
        count: 0,
        owed: '0',
        owedCurrency: from.baseCurrency,
        receivable: '0',
        receivableCurrency: to.baseCurrency,
        owedPresentation: '0',
        receivablePresentation: '0',
        difference: '0',
        status: 'MATCHED' as IntercompanyMatchStatus,
        owedM: Money.zero(from.baseCurrency),
        recM: Money.zero(to.baseCurrency),
      };
      pair.count += 1;
      pair.owedM = pair.owedM.add(owed);
      pair.recM = pair.recM.add(rec);
      pairMap.set(key, pair);
      expectedPayable.set(
        tx.fromCompanyId,
        (expectedPayable.get(tx.fromCompanyId) ?? Money.zero(from.baseCurrency)).add(owed),
      );
      expectedReceivable.set(
        tx.toCompanyId,
        (expectedReceivable.get(tx.toCompanyId) ?? Money.zero(to.baseCurrency)).add(rec),
      );
    }
    const pairs: IntercompanyPair[] = [];
    let openTotal = Money.zero(currency);
    for (const p of pairMap.values()) {
      const owedP = p.owedM.convert(
        currency,
        await this.rates.rateFor(organizationId, p.owedCurrency, currency, asOf, executor),
      );
      const recP = p.recM.convert(
        currency,
        await this.rates.rateFor(organizationId, p.receivableCurrency, currency, asOf, executor),
      );
      const difference = recP.subtract(owedP);
      openTotal = openTotal.add(owedP);
      pairs.push({
        ...p,
        owed: p.owedM.toString(),
        receivable: p.recM.toString(),
        owedPresentation: owedP.toString(),
        receivablePresentation: recP.toString(),
        difference: difference.toString(),
        status: difference.isZero()
          ? 'MATCHED'
          : p.owedM.isZero() || p.recM.isZero()
            ? 'ONE_SIDED'
            : 'DIFFERENCE',
      });
    }

    // Per entity: ledger balance of the intercompany accounts vs the register.
    const entities: IntercompanyEntity[] = [];
    for (const c of members) {
      const icAccounts = await executor
        .select({ id: accounts.id, type: accounts.type })
        .from(accounts)
        .where(and(eq(accounts.companyId, c.id), eq(accounts.isIntercompany, true)));
      const activity = icAccounts.length
        ? await this.ledger.activity(
            { companyId: c.id, to: asOf, accountIds: icAccounts.map((a) => a.id) },
            executor,
          )
        : [];
      let receivable = Money.zero(c.baseCurrency);
      let payable = Money.zero(c.baseCurrency);
      for (const a of icAccounts) {
        const row = activity.find((x) => x.accountId === a.id);
        if (!row) continue;
        const bal = naturalBalance(
          a.type,
          Money.of(row.debit, c.baseCurrency),
          Money.of(row.credit, c.baseCurrency),
        );
        if (a.type === 'ASSET') receivable = receivable.add(bal);
        else if (a.type === 'LIABILITY') payable = payable.add(bal);
      }
      const expRec = expectedReceivable.get(c.id) ?? Money.zero(c.baseCurrency);
      const expPay = expectedPayable.get(c.id) ?? Money.zero(c.baseCurrency);
      entities.push({
        companyId: c.id,
        companyCode: c.code,
        currency: c.baseCurrency,
        receivableLedger: receivable.toString(),
        payableLedger: payable.toString(),
        receivableExpected: expRec.toString(),
        payableExpected: expPay.toString(),
        receivableDifference: receivable.subtract(expRec).toString(),
        payableDifference: payable.subtract(expPay).toString(),
      });
    }
    return {
      asOf,
      currency,
      pairs: pairs.sort(
        (a, b) =>
          a.fromCompanyCode.localeCompare(b.fromCompanyCode) ||
          a.toCompanyCode.localeCompare(b.toCompanyCode),
      ),
      entities,
      totals: {
        openTransactions: openTotal.toString(),
        unmatchedPairs: pairs.filter((p) => p.status !== 'MATCHED').length,
        entitiesWithDrift: entities.filter(
          (e) => e.receivableDifference !== '0.0000' || e.payableDifference !== '0.0000',
        ).length,
      },
    };
  }
}
