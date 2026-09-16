import { Money } from '@accounting/money';
import type { AgingBucketDefinition, PaymentRunSelectionMode } from '@accounting/types';
import { addDays, daysBetween } from '@/modules/subledger/subledger.logic';
import { dueDateFor, type PaymentTermLike } from '@/modules/receivables/receivables.logic';

/**
 * Pure accounts-payable rules (Prompt #7): early-payment discount windows,
 * payment-run proposal, cash requirements, DPO, received-not-billed aging and
 * remittance formatting. No I/O - the services feed these functions with data
 * they loaded inside a transaction.
 */

// ---------------------------------------------------------- discount terms

export interface DiscountTermLike extends PaymentTermLike {
  discountPercent: string | null;
  discountDays: number | null;
}

export interface DiscountWindow {
  dueDate: string;
  /** Last day the discount may be taken, or null when the term has none. */
  discountDate: string | null;
  /** Discount on `settleAmount` (the total less withholding), '0' without a discount. */
  discountAmount: string;
}

/**
 * Due date and early-payment window for a bill under a named term
 * (e.g. "2/10 net 30": 2% off when settled within 10 days).
 */
export function discountWindowFor(
  documentDate: string,
  settleAmount: string,
  currency: string,
  term: DiscountTermLike,
): DiscountWindow {
  const dueDate = dueDateFor(documentDate, term);
  const percent = Number(term.discountPercent ?? 0);
  if (!(percent > 0) || term.discountDays === null || term.discountDays === undefined) {
    return { dueDate, discountDate: null, discountAmount: '0' };
  }
  const discountDate = addDays(documentDate, term.discountDays);
  const discountAmount = Money.of(settleAmount, currency).multiply(percent / 100);
  return { dueDate, discountDate, discountAmount: discountAmount.toString() };
}

/** Discount still available on `payDate`, taking what was already consumed into account. */
export function discountAvailable(
  bill: {
    discountDate: string | null;
    discountAmount: string;
    discountTakenAmount: string;
    total: string;
    allocatedAmount: string;
  },
  payDate: string,
  currency: string,
): Money {
  const zero = Money.zero(currency);
  if (!bill.discountDate || payDate > bill.discountDate) return zero;
  const remaining = Money.of(bill.discountAmount, currency).subtract(
    Money.of(bill.discountTakenAmount, currency),
  );
  if (!remaining.isPositive()) return zero;
  // The discount can never exceed what is still open on the bill.
  const open = Money.of(bill.total, currency).subtract(Money.of(bill.allocatedAmount, currency));
  return remaining.greaterThan(open) ? open : remaining;
}

// ------------------------------------------------------------ payment runs

export interface RunCandidate {
  billId: string;
  vendorId: string;
  dueDate: string;
  discountDate: string | null;
  /** Open balance (total - allocated). */
  openAmount: string;
  /** Discount available on the run's payment date. */
  discountAvailable: string;
  onHold: boolean;
  vendorOnHold: boolean;
  /** Vendor minimum payment amount, if any. */
  minimumPaymentAmount: string | null;
}

export interface RunProposalLine {
  billId: string;
  vendorId: string;
  dueDate: string;
  discountDate: string | null;
  openAmount: string;
  discountAvailable: string;
  discountTaken: string;
  amount: string;
  /** Why the bill was left out (undefined when selected). */
  skipped?: 'ON_HOLD' | 'VENDOR_ON_HOLD' | 'NOT_DUE' | 'BELOW_MINIMUM' | 'OVER_MAXIMUM';
}

/**
 * Proposal rules: holds always exclude; DUE takes bills due on or before the
 * pay-through date; DUE_OR_DISCOUNT also takes bills whose discount is still
 * available; MANUAL takes every candidate handed in. Bills are ordered oldest
 * due first and the optional maximum caps the cash total. Vendors whose
 * selected total stays under their minimum are dropped as a group.
 */
export function proposePaymentRun(
  candidates: readonly RunCandidate[],
  options: {
    mode: PaymentRunSelectionMode;
    payThroughDate: string;
    maximumAmount: string | null;
    currency: string;
  },
): RunProposalLine[] {
  const { currency } = options;
  const sorted = [...candidates].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.billId.localeCompare(b.billId),
  );
  let running = Money.zero(currency);
  const max = options.maximumAmount ? Money.of(options.maximumAmount, currency) : null;
  const lines: RunProposalLine[] = sorted.map((c) => {
    const discount = Money.of(c.discountAvailable, currency);
    const amount = Money.of(c.openAmount, currency).subtract(discount);
    const base: RunProposalLine = {
      billId: c.billId,
      vendorId: c.vendorId,
      dueDate: c.dueDate,
      discountDate: c.discountDate,
      openAmount: c.openAmount,
      discountAvailable: c.discountAvailable,
      discountTaken: discount.toString(),
      amount: amount.toString(),
    };
    if (c.vendorOnHold)
      return { ...base, skipped: 'VENDOR_ON_HOLD', discountTaken: '0', amount: '0' };
    if (c.onHold) return { ...base, skipped: 'ON_HOLD', discountTaken: '0', amount: '0' };
    const due = c.dueDate <= options.payThroughDate;
    const discountOpen = discount.isPositive();
    const wanted =
      options.mode === 'MANUAL' || due || (options.mode === 'DUE_OR_DISCOUNT' && discountOpen);
    if (!wanted) return { ...base, skipped: 'NOT_DUE', discountTaken: '0', amount: '0' };
    if (max && running.add(amount).greaterThan(max))
      return { ...base, skipped: 'OVER_MAXIMUM', discountTaken: '0', amount: '0' };
    running = running.add(amount);
    return base;
  });
  // Vendor minimums apply to the vendor's selected total, not to single bills.
  const totals = new Map<string, Money>();
  for (const l of lines)
    if (!l.skipped)
      totals.set(
        l.vendorId,
        (totals.get(l.vendorId) ?? Money.zero(currency)).add(Money.of(l.amount, currency)),
      );
  const minimums = new Map<string, string | null>();
  for (const c of candidates) minimums.set(c.vendorId, c.minimumPaymentAmount);
  return lines.map((l) => {
    if (l.skipped) return l;
    const min = minimums.get(l.vendorId);
    if (min && totals.get(l.vendorId)!.lessThan(Money.of(min, currency)))
      return { ...l, skipped: 'BELOW_MINIMUM', discountTaken: '0', amount: '0' };
    return l;
  });
}

// -------------------------------------------------------- cash requirements

export interface CashRequirementBucket {
  /** Horizon in days from asOf (0 = overdue). */
  days: number;
  label: string;
  amount: string;
  /** Discounts obtainable by paying within the horizon. */
  discountAvailable: string;
  billCount: number;
}

/**
 * Cash needed to settle open bills by each horizon: overdue first, then
 * cumulative-free bands (0-7, 8-30, 31-60 ...). Held bills are reported
 * separately by the caller and excluded here.
 */
export function cashRequirements(
  bills: readonly { dueDate: string; openAmount: string; discountAvailable: string }[],
  asOf: string,
  horizons: readonly number[],
  currency: string,
): CashRequirementBucket[] {
  const sortedHorizons = [...new Set(horizons)].sort((a, b) => a - b);
  const buckets: CashRequirementBucket[] = [
    { days: 0, label: 'Overdue', amount: '0', discountAvailable: '0', billCount: 0 },
    ...sortedHorizons.map((d, i) => ({
      days: d,
      label: i === 0 ? `Next ${d} days` : `${sortedHorizons[i - 1]! + 1}-${d} days`,
      amount: '0',
      discountAvailable: '0',
      billCount: 0,
    })),
    {
      days: Number.POSITIVE_INFINITY,
      label: `Beyond ${sortedHorizons[sortedHorizons.length - 1]} days`,
      amount: '0',
      discountAvailable: '0',
      billCount: 0,
    },
  ];
  const sums = buckets.map(() => ({
    amount: Money.zero(currency),
    discount: Money.zero(currency),
    count: 0,
  }));
  for (const b of bills) {
    const days = daysBetween(asOf, b.dueDate);
    let idx: number;
    if (days < 0) idx = 0;
    else {
      idx = buckets.length - 1;
      for (let i = 0; i < sortedHorizons.length; i++)
        if (days <= sortedHorizons[i]!) {
          idx = i + 1;
          break;
        }
    }
    sums[idx]!.amount = sums[idx]!.amount.add(Money.of(b.openAmount, currency));
    sums[idx]!.discount = sums[idx]!.discount.add(Money.of(b.discountAvailable, currency));
    sums[idx]!.count += 1;
  }
  return buckets.map((b, i) => ({
    ...b,
    amount: sums[i]!.amount.toString(),
    discountAvailable: sums[i]!.discount.toString(),
    billCount: sums[i]!.count,
  }));
}

// ---------------------------------------------------------------------- DPO

/**
 * Countback DPO: open payables consumed backwards through daily purchases of
 * the window (posted bills less vendor credits). Days, one decimal.
 */
export function daysPayableOutstanding(
  openPayables: string,
  purchasesInWindow: string,
  windowDays: number,
  currency: string,
): number {
  const purchases = Money.of(purchasesInWindow, currency);
  if (!purchases.isPositive() || windowDays <= 0) return 0;
  const open = Number(Money.of(openPayables, currency).toString());
  const perDay = Number(purchases.toString()) / windowDays;
  return Math.round((open / perDay) * 10) / 10;
}

/** Share of discounts offered in the window that were actually taken (0-1, two decimals). */
export function discountCaptureRate(taken: string, offered: string, currency: string): number {
  const o = Money.of(offered, currency);
  if (!o.isPositive()) return 1;
  const t = Money.of(taken, currency);
  return Math.round((Number(t.toString()) / Number(o.toString())) * 100) / 100;
}

// --------------------------------------------------------------------- GRNI

export interface GrniLine {
  orderLineId: string;
  receivedQuantity: string;
  billedQuantity: string;
  unitPrice: string;
  /** Date of the last confirmed receipt for the line. */
  lastReceiptDate: string | null;
}

/** Value of goods received but not billed on a PO line, and its age in days. */
export function grniValue(
  line: GrniLine,
  asOf: string,
  currency: string,
): { quantity: string; amount: Money; ageDays: number } {
  const qty = Math.max(Number(line.receivedQuantity) - Number(line.billedQuantity), 0);
  const amount = Money.of(line.unitPrice, currency).multiply(qty);
  const ageDays = line.lastReceiptDate ? Math.max(daysBetween(line.lastReceiptDate, asOf), 0) : 0;
  return { quantity: qty.toString(), amount, ageDays };
}

/** Aging bucket key for a bill; shared shape with AR (`agingBucketFor`) but kept here for AP callers. */
export function payableBucketFor(
  asOf: string,
  dueDate: string,
  buckets: readonly AgingBucketDefinition[],
): string {
  const overdue = daysBetween(dueDate, asOf);
  for (const b of buckets)
    if (overdue >= b.from && (b.to === null || overdue <= b.to)) return b.key;
  return buckets[buckets.length - 1]!.key;
}

// --------------------------------------------------------------- remittance

/** Last four characters visible; everything else masked. */
export function maskAccountNumber(accountNumber: string): string {
  const trimmed = accountNumber.replace(/\s+/g, '');
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length);
  return '*'.repeat(trimmed.length - 4) + trimmed.slice(-4);
}

export interface RemittanceRow {
  vendorCode: string;
  vendorName: string;
  paymentNumber: string;
  paymentDate: string;
  amount: string;
  currency: string;
  method: string;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  routingCode: string | null;
  bills: string;
}

/** RFC 4180 CSV for the bank / remittance file; account numbers are written in full. */
export function remittanceCsv(rows: readonly RemittanceRow[]): string {
  const header = [
    'vendor_code',
    'vendor_name',
    'payment_number',
    'payment_date',
    'amount',
    'currency',
    'method',
    'bank_name',
    'account_name',
    'account_number',
    'routing_code',
    'bills',
  ];
  const esc = (v: string | null) => {
    const s = v ?? '';
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.vendorCode,
      r.vendorName,
      r.paymentNumber,
      r.paymentDate,
      r.amount,
      r.currency,
      r.method,
      r.bankName,
      r.accountName,
      r.accountNumber,
      r.routingCode,
      r.bills,
    ]
      .map(esc)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
