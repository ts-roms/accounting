import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { AGING_BUCKETS, type AgingBucketKey } from '@accounting/types';
import type { AgingQuery, ReconciliationQuery, StatementQuery } from '@accounting/validation';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  GeneralLedgerService,
  signedBalance,
} from '@/modules/accounting/ledger/general-ledger.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { customerPayments, customers, fxAdjustments, invoices } from '@/database/schema';
import { agingBucket, isDebitDocument } from '@/modules/subledger/subledger.logic';
import { CustomersService } from './customers.service';

/** Explicit outer-table references for correlated subqueries. */
const OUTER_DOC = sql.raw('"invoices"."id"');
const OUTER_DOC_REV = sql.raw('"invoices"."reversal_journal_entry_id"');
const OUTER_PAY = sql.raw('"customer_payments"."id"');
const OUTER_PAY_REV = sql.raw('"customer_payments"."reversal_journal_entry_id"');

export interface AgingRow {
  partyId: string;
  code: string;
  name: string;
  buckets: Record<AgingBucketKey, string>;
  outstanding: string;
  unappliedCredit: string;
  net: string;
  oldestDueDate: string | null;
  documents: number;
}

export interface AgingReport {
  asOf: string;
  currency: string;
  buckets: Array<{ key: AgingBucketKey; label: string }>;
  rows: AgingRow[];
  totals: AgingRow['buckets'] & { outstanding: string; unappliedCredit: string; net: string };
}

export interface StatementLine {
  date: string;
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'PAYMENT' | 'REFUND';
  documentId: string;
  documentNumber: string;
  reference: string | null;
  description: string | null;
  dueDate: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface StatementReport {
  party: { id: string; code: string; name: string; email: string | null };
  from: string;
  to: string;
  currency: string;
  openingBalance: string;
  lines: StatementLine[];
  closingBalance: string;
}

export interface ReconciliationReport {
  asOf: string;
  currency: string;
  controlAccount: { id: string; code: string; name: string };
  /** Derived from documents and payments (the subledger). */
  subledgerBalance: string;
  /** Balance of the control account in the general ledger. */
  ledgerBalance: string;
  difference: string;
  reconciled: boolean;
  breakdown: {
    invoices: string;
    debitNotes: string;
    creditNotes: string;
    receipts: string;
    refunds: string;
    /** Realized and unrealized FX posted against the control (signed). */
    fxAdjustments: string;
  };
}

/**
 * AR reporting derived from posted documents and payments. The reconciliation
 * report proves the subledger equals the AR control account in the ledger -
 * the Phase 3 invariant.
 */
@Injectable()
export class ArReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
    private readonly customersService: CustomersService,
  ) {}

  /** A document counts in the ledger as of a date if it was posted, and not yet reversed by then. */
  private inLedgerAsOf(asOf: string) {
    return or(
      eq(invoices.accountingStatus, 'POSTED'),
      and(
        eq(invoices.accountingStatus, 'REVERSED'),
        sql`(select entry_date from journal_entries r where r.id = ${OUTER_DOC_REV}) > ${asOf}`,
      ),
    );
  }

  private paymentInLedgerAsOf(asOf: string) {
    return or(
      eq(customerPayments.status, 'POSTED'),
      and(
        eq(customerPayments.status, 'VOID'),
        sql`(select entry_date from journal_entries r where r.id = ${OUTER_PAY_REV}) > ${asOf}`,
      ),
    );
  }

  async aging(companyId: string, query: AgingQuery): Promise<AgingReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const asOf = query.asOf;
    const docFilters = [
      eq(invoices.companyId, companyId),
      lte(invoices.documentDate, asOf),
      this.inLedgerAsOf(asOf)!,
    ];
    if (query.partyId) docFilters.push(eq(invoices.customerId, query.partyId));

    const docs = await this.db
      .select({
        id: invoices.id,
        customerId: invoices.customerId,
        documentType: invoices.documentType,
        dueDate: invoices.dueDate,
        total: invoices.total,
        currency: invoices.currency,
        exchangeRate: invoices.exchangeRate,
        allocatedAsOf: sql<string>`coalesce((select sum(a.amount) from payment_allocations a where (a.invoice_id = ${OUTER_DOC} or a.credit_note_id = ${OUTER_DOC}) and a.allocation_date <= ${asOf}), 0)`,
      })
      .from(invoices)
      .where(and(...docFilters));

    const payFilters = [
      eq(customerPayments.companyId, companyId),
      lte(customerPayments.paymentDate, asOf),
      this.paymentInLedgerAsOf(asOf)!,
    ];
    if (query.partyId) payFilters.push(eq(customerPayments.customerId, query.partyId));
    const pays = await this.db
      .select({
        customerId: customerPayments.customerId,
        paymentType: customerPayments.paymentType,
        amount: customerPayments.amount,
        payCurrency: customerPayments.currency,
        exchangeRate: customerPayments.exchangeRate,
        allocatedAsOf: sql<string>`coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = ${OUTER_PAY} and a.allocation_date <= ${asOf}), 0)`,
      })
      .from(customerPayments)
      .where(and(...payFilters));

    const partyIds = [
      ...new Set([...docs.map((d) => d.customerId), ...pays.map((p) => p.customerId)]),
    ];
    const parties = partyIds.length
      ? await this.db
          .select({ id: customers.id, code: customers.code, name: customers.name })
          .from(customers)
          .where(inArray(customers.id, partyIds))
      : [];
    const partyById = new Map(parties.map((p) => [p.id, p]));

    const emptyBuckets = (): Record<AgingBucketKey, Money> =>
      Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, Money.zero(currency)])) as Record<
        AgingBucketKey,
        Money
      >;
    const acc = new Map<
      string,
      {
        buckets: Record<AgingBucketKey, Money>;
        outstanding: Money;
        credit: Money;
        oldest: string | null;
        documents: number;
      }
    >();
    const get = (id: string) => {
      let a = acc.get(id);
      if (!a) {
        a = {
          buckets: emptyBuckets(),
          outstanding: Money.zero(currency),
          credit: Money.zero(currency),
          oldest: null,
          documents: 0,
        };
        acc.set(id, a);
      }
      return a;
    };
    for (const d of docs) {
      // Open balances age in base at the document rate so the total ties to the control account.
      const remaining = Money.of(d.total, d.currency)
        .subtract(Money.of(d.allocatedAsOf, d.currency))
        .convert(currency, d.exchangeRate);
      if (remaining.isZero()) continue;
      const a = get(d.customerId);
      if (isDebitDocument(d.documentType)) {
        a.buckets[agingBucket(asOf, d.dueDate)] =
          a.buckets[agingBucket(asOf, d.dueDate)].add(remaining);
        a.outstanding = a.outstanding.add(remaining);
        a.documents += 1;
        if (d.dueDate < asOf && (!a.oldest || d.dueDate < a.oldest)) a.oldest = d.dueDate;
      } else {
        a.credit = a.credit.add(remaining);
      }
    }
    for (const p of pays) {
      const unallocated = Money.of(p.amount, p.payCurrency)
        .subtract(Money.of(p.allocatedAsOf, p.payCurrency))
        .convert(currency, p.exchangeRate);
      const a = get(p.customerId);
      a.credit =
        p.paymentType === 'PAYMENT' ? a.credit.add(unallocated) : a.credit.subtract(unallocated);
    }

    const totalsAcc = {
      buckets: emptyBuckets(),
      outstanding: Money.zero(currency),
      credit: Money.zero(currency),
    };
    const rows: AgingRow[] = [];
    for (const [id, a] of acc) {
      if (a.outstanding.isZero() && a.credit.isZero()) continue;
      const party = partyById.get(id);
      rows.push({
        partyId: id,
        code: party?.code ?? '',
        name: party?.name ?? '',
        buckets: Object.fromEntries(
          Object.entries(a.buckets).map(([k, v]) => [k, v.toString()]),
        ) as Record<AgingBucketKey, string>,
        outstanding: a.outstanding.toString(),
        unappliedCredit: a.credit.toString(),
        net: a.outstanding.subtract(a.credit).toString(),
        oldestDueDate: a.oldest,
        documents: a.documents,
      });
      for (const b of AGING_BUCKETS)
        totalsAcc.buckets[b.key] = totalsAcc.buckets[b.key].add(a.buckets[b.key]);
      totalsAcc.outstanding = totalsAcc.outstanding.add(a.outstanding);
      totalsAcc.credit = totalsAcc.credit.add(a.credit);
    }
    rows.sort(
      (x, y) => Number(y.outstanding) - Number(x.outstanding) || x.name.localeCompare(y.name),
    );
    return {
      asOf,
      currency,
      buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
      rows,
      totals: {
        ...(Object.fromEntries(
          Object.entries(totalsAcc.buckets).map(([k, v]) => [k, v.toString()]),
        ) as Record<AgingBucketKey, string>),
        outstanding: totalsAcc.outstanding.toString(),
        unappliedCredit: totalsAcc.credit.toString(),
        net: totalsAcc.outstanding.subtract(totalsAcc.credit).toString(),
      },
    };
  }

  async statement(
    companyId: string,
    customerId: string,
    query: StatementQuery,
  ): Promise<StatementReport> {
    const customer = await this.customersService.getOrThrow(companyId, customerId);
    const currency = await this.accounts.companyCurrency(companyId);
    const docs = await this.db
      .select({
        id: invoices.id,
        documentType: invoices.documentType,
        documentNumber: invoices.documentNumber,
        documentDate: invoices.documentDate,
        dueDate: invoices.dueDate,
        reference: invoices.reference,
        description: invoices.description,
        total: invoices.total,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.customerId, customerId),
          lte(invoices.documentDate, query.to),
          this.inLedgerAsOf(query.to)!,
        ),
      )
      .orderBy(asc(invoices.documentDate), asc(invoices.documentNumber));
    const pays = await this.db
      .select({
        id: customerPayments.id,
        paymentType: customerPayments.paymentType,
        documentNumber: customerPayments.documentNumber,
        paymentDate: customerPayments.paymentDate,
        reference: customerPayments.reference,
        memo: customerPayments.memo,
        amount: customerPayments.amount,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          eq(customerPayments.customerId, customerId),
          lte(customerPayments.paymentDate, query.to),
          this.paymentInLedgerAsOf(query.to)!,
        ),
      )
      .orderBy(asc(customerPayments.paymentDate), asc(customerPayments.documentNumber));

    type Movement = Omit<StatementLine, 'balance'>;
    const movements: Movement[] = [
      ...docs.map<Movement>((d) => ({
        date: d.documentDate,
        kind: d.documentType,
        documentId: d.id,
        documentNumber: d.documentNumber,
        reference: d.reference,
        description: d.description,
        dueDate: d.dueDate,
        debit: isDebitDocument(d.documentType) ? d.total : '0.0000',
        credit: isDebitDocument(d.documentType) ? '0.0000' : d.total,
      })),
      ...pays.map<Movement>((p) => ({
        date: p.paymentDate,
        kind: p.paymentType === 'PAYMENT' ? 'PAYMENT' : 'REFUND',
        documentId: p.id,
        documentNumber: p.documentNumber,
        reference: p.reference,
        description: p.memo,
        dueDate: null,
        debit: p.paymentType === 'REFUND' ? p.amount : '0.0000',
        credit: p.paymentType === 'PAYMENT' ? p.amount : '0.0000',
      })),
    ].sort(
      (a, b) => a.date.localeCompare(b.date) || a.documentNumber.localeCompare(b.documentNumber),
    );

    let balance = Money.zero(currency);
    const lines: StatementLine[] = [];
    let opening = Money.zero(currency);
    for (const m of movements) {
      balance = balance.add(Money.of(m.debit, currency)).subtract(Money.of(m.credit, currency));
      if (m.date < query.from) opening = balance;
      else lines.push({ ...m, balance: balance.toString() });
    }
    return {
      party: { id: customer.id, code: customer.code, name: customer.name, email: customer.email },
      from: query.from,
      to: query.to,
      currency,
      openingBalance: opening.toString(),
      lines,
      closingBalance: balance.toString(),
    };
  }

  async reconciliation(
    companyId: string,
    query: ReconciliationQuery,
  ): Promise<ReconciliationReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE');
    const asOf = query.asOf;

    const docTotals = await this.db
      .select({
        documentType: invoices.documentType,
        total: sql<string>`coalesce(sum(${invoices.baseTotal}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          lte(invoices.documentDate, asOf),
          this.inLedgerAsOf(asOf)!,
        ),
      )
      .groupBy(invoices.documentType);
    const payTotals = await this.db
      .select({
        paymentType: customerPayments.paymentType,
        total: sql<string>`coalesce(sum(${customerPayments.controlBaseAmount}), 0)`,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          lte(customerPayments.paymentDate, asOf),
          this.paymentInLedgerAsOf(asOf)!,
        ),
      )
      .groupBy(customerPayments.paymentType);

    const pick = <T extends { total: string }>(rows: T[], pred: (r: T) => boolean) =>
      Money.of(rows.find(pred)?.total ?? '0', currency);
    const inv = pick(docTotals, (r) => r.documentType === 'INVOICE');
    const dn = pick(docTotals, (r) => r.documentType === 'DEBIT_NOTE');
    const cn = pick(docTotals, (r) => r.documentType === 'CREDIT_NOTE');
    const receipts = pick(payTotals, (r) => r.paymentType === 'PAYMENT');
    const refunds = pick(payTotals, (r) => r.paymentType === 'REFUND');
    // Realized / unrealized FX posted against the control (signed, positive = debit).
    const [fx] = await this.db
      .select({ total: sql<string>`coalesce(sum(${fxAdjustments.amount}), 0)` })
      .from(fxAdjustments)
      .where(and(eq(fxAdjustments.companyId, companyId), eq(fxAdjustments.side, 'AR'), lte(fxAdjustments.adjustmentDate, asOf)));
    const fxAdjustment = Money.of(fx?.total ?? '0', currency);
    const subledger = inv.add(dn).subtract(cn).subtract(receipts).add(refunds).add(fxAdjustment);

    const activity = await this.ledger.activity({ companyId, to: asOf });
    const row = activity.find((a) => a.accountId === control.id);
    const ledgerBalance = signedBalance(
      Money.of(row?.debit ?? '0', currency).subtract(Money.of(row?.credit ?? '0', currency)),
      control.normalBalance,
    );
    const difference = subledger.subtract(ledgerBalance);
    return {
      asOf,
      currency,
      controlAccount: { id: control.id, code: control.code, name: control.name },
      subledgerBalance: subledger.toString(),
      ledgerBalance: ledgerBalance.toString(),
      difference: difference.toString(),
      reconciled: difference.isZero(),
      breakdown: {
        invoices: inv.toString(),
        debitNotes: dn.toString(),
        creditNotes: cn.toString(),
        receipts: receipts.toString(),
        refunds: refunds.toString(),
        fxAdjustments: fxAdjustment.toString(),
      },
    };
  }
}
