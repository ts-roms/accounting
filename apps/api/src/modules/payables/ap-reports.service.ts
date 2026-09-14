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
import { fxAdjustments, vendorBills, vendorPayments, vendors } from '@/database/schema';
import { agingBucket, isDebitDocument } from '@/modules/subledger/subledger.logic';
import { VendorsService } from './vendors.service';

/** Explicit outer-table references for correlated subqueries. */
const OUTER_DOC = sql.raw('"vendor_bills"."id"');
const OUTER_DOC_REV = sql.raw('"vendor_bills"."reversal_journal_entry_id"');
const OUTER_PAY = sql.raw('"vendor_payments"."id"');
const OUTER_PAY_REV = sql.raw('"vendor_payments"."reversal_journal_entry_id"');

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
    bills: string;
    debitNotes: string;
    creditNotes: string;
    payments: string;
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
export class ApReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
    private readonly vendorsService: VendorsService,
  ) {}

  /** A document counts in the ledger as of a date if it was posted, and not yet reversed by then. */
  private inLedgerAsOf(asOf: string) {
    return or(
      eq(vendorBills.accountingStatus, 'POSTED'),
      and(
        eq(vendorBills.accountingStatus, 'REVERSED'),
        sql`(select entry_date from journal_entries r where r.id = ${OUTER_DOC_REV}) > ${asOf}`,
      ),
    );
  }

  private paymentInLedgerAsOf(asOf: string) {
    return or(
      eq(vendorPayments.status, 'POSTED'),
      and(
        eq(vendorPayments.status, 'VOID'),
        sql`(select entry_date from journal_entries r where r.id = ${OUTER_PAY_REV}) > ${asOf}`,
      ),
    );
  }

  async aging(companyId: string, query: AgingQuery): Promise<AgingReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const asOf = query.asOf;
    const docFilters = [
      eq(vendorBills.companyId, companyId),
      lte(vendorBills.documentDate, asOf),
      this.inLedgerAsOf(asOf)!,
    ];
    if (query.partyId) docFilters.push(eq(vendorBills.vendorId, query.partyId));

    const docs = await this.db
      .select({
        id: vendorBills.id,
        vendorId: vendorBills.vendorId,
        documentType: vendorBills.documentType,
        dueDate: vendorBills.dueDate,
        total: vendorBills.total,
        currency: vendorBills.currency,
        exchangeRate: vendorBills.exchangeRate,
        allocatedAsOf: sql<string>`coalesce((select sum(a.amount) from vendor_payment_allocations a where (a.bill_id = ${OUTER_DOC} or a.credit_note_id = ${OUTER_DOC}) and a.allocation_date <= ${asOf}), 0)`,
      })
      .from(vendorBills)
      .where(and(...docFilters));

    const payFilters = [
      eq(vendorPayments.companyId, companyId),
      lte(vendorPayments.paymentDate, asOf),
      this.paymentInLedgerAsOf(asOf)!,
    ];
    if (query.partyId) payFilters.push(eq(vendorPayments.vendorId, query.partyId));
    const pays = await this.db
      .select({
        vendorId: vendorPayments.vendorId,
        paymentType: vendorPayments.paymentType,
        amount: vendorPayments.amount,
        payCurrency: vendorPayments.currency,
        exchangeRate: vendorPayments.exchangeRate,
        allocatedAsOf: sql<string>`coalesce((select sum(a.amount) from vendor_payment_allocations a where a.payment_id = ${OUTER_PAY} and a.allocation_date <= ${asOf}), 0)`,
      })
      .from(vendorPayments)
      .where(and(...payFilters));

    const partyIds = [...new Set([...docs.map((d) => d.vendorId), ...pays.map((p) => p.vendorId)])];
    const parties = partyIds.length
      ? await this.db
          .select({ id: vendors.id, code: vendors.code, name: vendors.name })
          .from(vendors)
          .where(inArray(vendors.id, partyIds))
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
      const a = get(d.vendorId);
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
      const a = get(p.vendorId);
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
    vendorId: string,
    query: StatementQuery,
  ): Promise<StatementReport> {
    const vendor = await this.vendorsService.getOrThrow(companyId, vendorId);
    const currency = await this.accounts.companyCurrency(companyId);
    const docs = await this.db
      .select({
        id: vendorBills.id,
        documentType: vendorBills.documentType,
        documentNumber: vendorBills.documentNumber,
        documentDate: vendorBills.documentDate,
        dueDate: vendorBills.dueDate,
        reference: vendorBills.reference,
        description: vendorBills.description,
        total: vendorBills.total,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.vendorId, vendorId),
          lte(vendorBills.documentDate, query.to),
          this.inLedgerAsOf(query.to)!,
        ),
      )
      .orderBy(asc(vendorBills.documentDate), asc(vendorBills.documentNumber));
    const pays = await this.db
      .select({
        id: vendorPayments.id,
        paymentType: vendorPayments.paymentType,
        documentNumber: vendorPayments.documentNumber,
        paymentDate: vendorPayments.paymentDate,
        reference: vendorPayments.reference,
        memo: vendorPayments.memo,
        amount: vendorPayments.amount,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          eq(vendorPayments.vendorId, vendorId),
          lte(vendorPayments.paymentDate, query.to),
          this.paymentInLedgerAsOf(query.to)!,
        ),
      )
      .orderBy(asc(vendorPayments.paymentDate), asc(vendorPayments.documentNumber));

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
      party: { id: vendor.id, code: vendor.code, name: vendor.name, email: vendor.email },
      from: query.from,
      to: query.to,
      currency,
      openingBalance: opening.toString(),
      lines,
      closingBalance: balance.toString(),
    };
  }

  /** Open bills ordered by planned payment date (falls back to due date) up to a horizon. */
  async schedule(companyId: string, to: string) {
    const currency = await this.accounts.companyCurrency(companyId);
    const rows = await this.db
      .select({
        id: vendorBills.id,
        documentNumber: vendorBills.documentNumber,
        vendorId: vendorBills.vendorId,
        vendorName: vendors.name,
        vendorInvoiceNumber: vendorBills.vendorInvoiceNumber,
        documentDate: vendorBills.documentDate,
        dueDate: vendorBills.dueDate,
        scheduledPaymentDate: vendorBills.scheduledPaymentDate,
        total: vendorBills.total,
        allocatedAmount: vendorBills.allocatedAmount,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, ['APPROVED', 'PARTIALLY_PAID']),
          inArray(vendorBills.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`coalesce(${vendorBills.scheduledPaymentDate}, ${vendorBills.dueDate}) <= ${to}`,
        ),
      )
      .orderBy(
        asc(sql`coalesce(${vendorBills.scheduledPaymentDate}, ${vendorBills.dueDate})`),
        asc(vendorBills.documentNumber),
      );
    let total = Money.zero(currency);
    const items = rows.map((r) => {
      const balance = Money.of(r.total, currency).subtract(Money.of(r.allocatedAmount, currency));
      total = total.add(balance);
      return { ...r, balance: balance.toString(), payOn: r.scheduledPaymentDate ?? r.dueDate };
    });
    return { to, currency, items, total: total.toString() };
  }

  async reconciliation(
    companyId: string,
    query: ReconciliationQuery,
  ): Promise<ReconciliationReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_PAYABLE');
    const asOf = query.asOf;

    const docTotals = await this.db
      .select({
        documentType: vendorBills.documentType,
        total: sql<string>`coalesce(sum(${vendorBills.baseTotal}), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          lte(vendorBills.documentDate, asOf),
          this.inLedgerAsOf(asOf)!,
        ),
      )
      .groupBy(vendorBills.documentType);
    const payTotals = await this.db
      .select({
        paymentType: vendorPayments.paymentType,
        total: sql<string>`coalesce(sum(${vendorPayments.controlBaseAmount}), 0)`,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          lte(vendorPayments.paymentDate, asOf),
          this.paymentInLedgerAsOf(asOf)!,
        ),
      )
      .groupBy(vendorPayments.paymentType);

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
      .where(
        and(
          eq(fxAdjustments.companyId, companyId),
          eq(fxAdjustments.side, 'AP'),
          lte(fxAdjustments.adjustmentDate, asOf),
        ),
      );
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
        bills: inv.toString(),
        debitNotes: dn.toString(),
        creditNotes: cn.toString(),
        payments: receipts.toString(),
        refunds: refunds.toString(),
        fxAdjustments: fxAdjustment.toString(),
      },
    };
  }
}
