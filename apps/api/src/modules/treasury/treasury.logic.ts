import { createHash } from 'node:crypto';
import { Money } from '@accounting/money';
import type {
  CollectionProbabilities,
  ForecastGranularity,
  ForecastItemFrequency,
  ForecastSource,
  ScenarioAdjustments,
} from '@accounting/types';
import { addDays, daysBetween } from '@/modules/subledger/subledger.logic';

/**
 * Pure cash management rules (Prompt #8): forecast bucketing, planned item
 * expansion, collection weighting, liquidity KPIs and bank payment file
 * rendering. No I/O - the services feed these functions with data they
 * loaded inside a transaction.
 */

// ------------------------------------------------------------------ buckets

export interface ForecastBucketDef {
  key: string;
  label: string;
  start: string;
  end: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Short axis label: `Sep 16`, `Sep 16-22` (or `Sep 30-Oct 6`), `Oct 2026`. */
export function bucketLabel(start: string, end: string, granularity: ForecastGranularity): string {
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  const [, em, ed] = end.split('-').map(Number) as [number, number, number];
  const mon = (m: number) => MONTHS[m - 1]!;
  if (granularity === 'DAY') return `${mon(sm)} ${sd}`;
  if (granularity === 'MONTH' && sd === 1 && end >= lastDayOfMonth(start))
    return `${mon(sm)} ${sy}`;
  return sm === em ? `${mon(sm)} ${sd}-${ed}` : `${mon(sm)} ${sd}-${mon(em)} ${ed}`;
}
function lastDayOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Contiguous buckets from `asOf` (exclusive of the past) covering `horizonDays`. */
export function forecastBuckets(
  asOf: string,
  horizonDays: number,
  granularity: ForecastGranularity,
): ForecastBucketDef[] {
  const out: ForecastBucketDef[] = [];
  const end = addDays(asOf, horizonDays);
  let start = asOf;
  let i = 0;
  while (start < end) {
    let next: string;
    if (granularity === 'DAY') next = addDays(start, 1);
    else if (granularity === 'WEEK') next = addDays(start, 7);
    else {
      const [y, m] = start.split('-').map(Number) as [number, number, number];
      next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    }
    if (next > end) next = end;
    const bucketEnd = addDays(next, -1);
    out.push({
      key: `b${i}`,
      label: bucketLabel(start, bucketEnd, granularity),
      start,
      end: bucketEnd,
    });
    start = next;
    i += 1;
  }
  return out;
}

/** Index of the bucket containing `date`; flows before asOf land in bucket 0, after the horizon in the last. */
export function bucketIndexFor(date: string, buckets: readonly ForecastBucketDef[]): number {
  if (!buckets.length) return -1;
  if (date < buckets[0]!.start) return 0;
  for (let i = 0; i < buckets.length; i++) if (date <= buckets[i]!.end) return i;
  return buckets.length - 1;
}

// ------------------------------------------------------------- planned items

export interface PlannedItemLike {
  amount: string;
  frequency: ForecastItemFrequency;
  startDate: string;
  endDate: string | null;
}

/** Occurrence dates of a planned item inside [from, to]; month-based items keep the start day-of-month. */
export function expandPlannedItem(item: PlannedItemLike, from: string, to: string): string[] {
  const dates: string[] = [];
  const last = item.endDate && item.endDate < to ? item.endDate : to;
  const [y, m, day] = item.startDate.split('-').map(Number) as [number, number, number];
  for (let n = 0; n < 2000; n++) {
    const d = occurrence(item.startDate, y, m, day, n, item.frequency);
    if (d > last) break;
    if (d >= from) dates.push(d);
    if (item.frequency === 'ONCE') break;
  }
  return dates;
}

/** The n-th occurrence (0-based) counted from the start date. */
function occurrence(
  start: string,
  y: number,
  m: number,
  day: number,
  n: number,
  frequency: ForecastItemFrequency,
): string {
  switch (frequency) {
    case 'WEEKLY':
      return addDays(start, 7 * n);
    case 'BIWEEKLY':
      return addDays(start, 14 * n);
    case 'MONTHLY':
      return monthsAhead(y, m, day, n);
    case 'QUARTERLY':
      return monthsAhead(y, m, day, 3 * n);
    case 'ANNUAL':
      return monthsAhead(y, m, day, 12 * n);
    default:
      return start;
  }
}

/** Same day-of-month `n` months ahead, clamped to the month length. */
function monthsAhead(y: number, m: number, day: number, n: number): string {
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// ------------------------------------------------------------- AR weighting

/** Collection probability for an invoice given how overdue it is on asOf. */
export function collectionProbabilityFor(
  asOf: string,
  dueDate: string,
  buckets: readonly { key: string; from: number; to: number | null }[],
  probabilities: CollectionProbabilities,
): number {
  const overdue = daysBetween(dueDate, asOf);
  for (const b of buckets)
    if (overdue >= b.from && (b.to === null || overdue <= b.to)) {
      const p = probabilities[b.key];
      return p === undefined ? 1 : Math.min(Math.max(Number(p), 0), 1);
    }
  return 1;
}

/** Expected receipt date: the due date (or asOf for overdue items) shifted by the scenario delay. */
export function expectedReceiptDate(
  asOf: string,
  dueDate: string,
  scenario: ScenarioAdjustments,
): string {
  const base = dueDate < asOf ? asOf : dueDate;
  return addDays(base, scenario.inflowDelayDays);
}

// -------------------------------------------------------------- aggregation

export interface ForecastFlow {
  date: string;
  source: ForecastSource;
  direction: 'INFLOW' | 'OUTFLOW';
  /** Base-currency amount, already probability-weighted. */
  amount: string;
  bankAccountId: string | null;
  reference: string;
  label: string;
}

export interface ForecastBucket extends ForecastBucketDef {
  opening: string;
  inflows: string;
  outflows: string;
  net: string;
  closing: string;
  bySource: Record<string, string>;
  /** Closing below the minimum cash requirement. */
  breach: boolean;
}

export interface ForecastResult {
  buckets: ForecastBucket[];
  totalInflows: string;
  totalOutflows: string;
  closing: string;
  minimumClosing: string;
  breaches: number;
}

/** Roll flows through the buckets applying scenario factors; `minimumCash` flags breaches. */
export function rollForecast(
  opening: string,
  flows: readonly ForecastFlow[],
  buckets: readonly ForecastBucketDef[],
  scenario: ScenarioAdjustments,
  minimumCash: string,
  currency: string,
): ForecastResult {
  const inflowFactor = Number(scenario.inflowFactor);
  const outflowFactor = Number(scenario.outflowFactor);
  const perBucket = buckets.map(() => ({
    inflows: Money.zero(currency),
    outflows: Money.zero(currency),
    bySource: new Map<string, Money>(),
  }));
  for (const f of flows) {
    const idx = bucketIndexFor(f.date, buckets);
    if (idx < 0) continue;
    const amount = Money.of(f.amount, currency).multiply(
      f.direction === 'INFLOW' ? inflowFactor : outflowFactor,
    );
    const b = perBucket[idx]!;
    if (f.direction === 'INFLOW') b.inflows = b.inflows.add(amount);
    else b.outflows = b.outflows.add(amount);
    const key = `${f.direction}:${f.source}`;
    b.bySource.set(key, (b.bySource.get(key) ?? Money.zero(currency)).add(amount));
  }
  const min = Money.of(minimumCash, currency);
  let running = Money.of(opening, currency);
  let totalIn = Money.zero(currency);
  let totalOut = Money.zero(currency);
  let minimumClosing: Money | null = null;
  let breaches = 0;
  const out: ForecastBucket[] = buckets.map((def, i) => {
    const b = perBucket[i]!;
    const openingHere = running;
    const net = b.inflows.subtract(b.outflows);
    running = running.add(net);
    totalIn = totalIn.add(b.inflows);
    totalOut = totalOut.add(b.outflows);
    if (minimumClosing === null || running.lessThan(minimumClosing)) minimumClosing = running;
    const breach = running.lessThan(min);
    if (breach) breaches += 1;
    return {
      ...def,
      opening: openingHere.toString(),
      inflows: b.inflows.toString(),
      outflows: b.outflows.toString(),
      net: net.toString(),
      closing: running.toString(),
      bySource: Object.fromEntries([...b.bySource.entries()].map(([k, v]) => [k, v.toString()])),
      breach,
    };
  });
  return {
    buckets: out,
    totalInflows: totalIn.toString(),
    totalOutflows: totalOut.toString(),
    closing: running.toString(),
    minimumClosing: (minimumClosing ?? running).toString(),
    breaches,
  };
}

// ---------------------------------------------------------------------- KPIs

/** Cash ÷ average daily outflow over the window; null when nothing was paid out. */
export function daysCashOnHand(
  cash: string,
  outflowsInWindow: string,
  windowDays: number,
  currency: string,
): number | null {
  const out = Money.of(outflowsInWindow, currency);
  if (!out.isPositive() || windowDays <= 0) return null;
  const perDay = Number(out.toString()) / windowDays;
  return Math.round((Number(Money.of(cash, currency).toString()) / perDay) * 10) / 10;
}

// ----------------------------------------------------------- payment files

export interface PaymentFileEntry {
  sequence: number;
  paymentNumber: string;
  amount: string;
  beneficiaryName: string;
  beneficiaryBank: string | null;
  beneficiaryAccount: string | null;
  beneficiaryRouting: string | null;
  remittanceInfo: string;
}

export interface PaymentFileHeader {
  fileNumber: string;
  valueDate: string;
  currency: string;
  originatorName: string;
  originatorId: string | null;
  originatorAccount: string | null;
  originatorRouting: string | null;
  totalAmount: string;
  count: number;
}

const csvEsc = (v: string | null | undefined) => {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * PESONet-style batch credit file: a header record, one detail record per
 * beneficiary and a trailer with count, total and checksum.
 */
export function renderPesonetCsv(
  header: PaymentFileHeader,
  entries: readonly PaymentFileEntry[],
): string {
  const lines = [
    [
      'H',
      header.fileNumber,
      header.valueDate.replace(/-/g, ''),
      header.currency,
      csvEsc(header.originatorName),
      header.originatorId ?? '',
      header.originatorAccount ?? '',
      header.originatorRouting ?? '',
    ].join(','),
    ...entries.map((e) =>
      [
        'D',
        String(e.sequence).padStart(6, '0'),
        e.beneficiaryRouting ?? '',
        e.beneficiaryAccount ?? '',
        csvEsc(e.beneficiaryName),
        e.amount,
        header.currency,
        csvEsc(e.remittanceInfo),
        e.paymentNumber,
      ].join(','),
    ),
  ];
  const body = lines.join('\r\n');
  const checksum = sha256(body);
  return `${body}\r\n${['T', String(entries.length).padStart(6, '0'), header.totalAmount, checksum].join(',')}\r\n`;
}

/** ISO 20022 pain.001.001.03 customer credit transfer initiation (one payment information block). */
export function renderPain001(
  header: PaymentFileHeader,
  entries: readonly PaymentFileEntry[],
): string {
  const x = (v: string | null | undefined) =>
    (v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tx = entries
    .map(
      (e) => `      <CdtTrfTxInf>
        <PmtId><InstrId>${x(e.paymentNumber)}</InstrId><EndToEndId>${x(e.paymentNumber)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${x(header.currency)}">${e.amount}</InstdAmt></Amt>
        ${e.beneficiaryRouting ? `<CdtrAgt><FinInstnId><BICFI>${x(e.beneficiaryRouting)}</BICFI></FinInstnId></CdtrAgt>` : '<CdtrAgt><FinInstnId/></CdtrAgt>'}
        <Cdtr><Nm>${x(e.beneficiaryName)}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${x(e.beneficiaryAccount)}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${x(e.remittanceInfo)}</Ustrd></RmtInf>
      </CdtTrfTxInf>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${x(header.fileNumber)}</MsgId>
      <CreDtTm>${created}</CreDtTm>
      <NbOfTxs>${header.count}</NbOfTxs>
      <CtrlSum>${header.totalAmount}</CtrlSum>
      <InitgPty><Nm>${x(header.originatorName)}</Nm>${header.originatorId ? `<Id><OrgId><Othr><Id>${x(header.originatorId)}</Id></Othr></OrgId></Id>` : ''}</InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${x(header.fileNumber)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${header.count}</NbOfTxs>
      <CtrlSum>${header.totalAmount}</CtrlSum>
      <ReqdExctnDt>${header.valueDate}</ReqdExctnDt>
      <Dbtr><Nm>${x(header.originatorName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${x(header.originatorAccount)}</Id></Othr></Id></DbtrAcct>
      ${header.originatorRouting ? `<DbtrAgt><FinInstnId><BICFI>${x(header.originatorRouting)}</BICFI></FinInstnId></DbtrAgt>` : '<DbtrAgt><FinInstnId/></DbtrAgt>'}
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

/** Positive-pay register for cheque payments: the bank honours only listed items. */
export function renderPositivePayCsv(
  header: PaymentFileHeader,
  entries: readonly PaymentFileEntry[],
): string {
  const rows = [
    ['account_number', 'cheque_number', 'issue_date', 'amount', 'payee'].join(','),
    ...entries.map((e) =>
      [
        header.originatorAccount ?? '',
        e.paymentNumber,
        header.valueDate,
        e.amount,
        csvEsc(e.beneficiaryName),
      ].join(','),
    ),
  ];
  return rows.join('\r\n') + '\r\n';
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Sum and count guard used when assembling a file. */
export function fileTotals(
  entries: readonly PaymentFileEntry[],
  currency: string,
): { total: string; count: number } {
  return {
    total: entries
      .reduce((m, e) => m.add(Money.of(e.amount, currency)), Money.zero(currency))
      .toString(),
    count: entries.length,
  };
}

// ---------------------------------------------------------------- petty cash

/** Cash the fund should hold = imprest − posted, unreplenished vouchers. */
export function pettyCashOnHand(imprest: string, openVouchers: string, currency: string): Money {
  return Money.of(imprest, currency).subtract(Money.of(openVouchers, currency));
}

/** Replenishment is due once cash on hand drops to `replenishAtPercent` of the imprest. */
export function replenishmentDue(
  imprest: string,
  cashOnHand: Money,
  replenishAtPercent: string,
  currency: string,
): boolean {
  const threshold = Money.of(imprest, currency).multiply(Number(replenishAtPercent) / 100);
  return cashOnHand.lessThan(threshold) || cashOnHand.equals(threshold);
}
