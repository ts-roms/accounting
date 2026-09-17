import { Money } from '@accounting/money';
import type { PayBracket, PayItemCalculation, PayItemType } from '@accounting/types';

/*
 * Pure payroll arithmetic (Prompt #11): how one employee's payslip is built
 * from the base salary, the pay items that apply and the run's one-off
 * inputs. No database, no dates beyond the period passed in.
 */

export interface PayItemDef {
  id: string;
  code: string;
  name: string;
  type: PayItemType;
  calculation: PayItemCalculation;
  amount: string | null;
  rate: string | null;
  maxBase: string | null;
  brackets: PayBracket[];
  taxable: boolean;
  sortOrder: number;
}

/** What applies to the employee for this run, in priority order INPUT > ASSIGNMENT > COMPANY. */
export interface AppliedItem {
  item: PayItemDef;
  source: 'BASE' | 'ASSIGNMENT' | 'COMPANY' | 'INPUT';
  /** Amount override (FIXED items and every INPUT). */
  amount?: string | null;
  /** Rate override (PERCENT_OF_GROSS items). */
  rate?: string | null;
  note?: string | null;
}

export interface ReimbursementDef {
  expenseClaimId: string;
  claimNumber: string;
  amount: string;
}

export interface PayslipLineDraft {
  sequence: number;
  payItemId: string | null;
  expenseClaimId: string | null;
  type: PayItemType;
  code: string;
  description: string;
  amount: string;
  taxable: boolean;
  source: string;
}

export interface PayslipDraft {
  gross: string;
  taxable: string;
  withholding: string;
  deductions: string;
  employerContributions: string;
  reimbursements: string;
  net: string;
  lines: PayslipLineDraft[];
}

/** Progressive tax: the bracket whose `over` is the highest not above the taxable amount. */
export function bracketTax(
  taxable: Money,
  brackets: readonly PayBracket[],
  currency: string,
): Money {
  if (!taxable.isPositive() || brackets.length === 0) return Money.zero(currency);
  let chosen: PayBracket | null = null;
  for (const b of brackets) {
    if (!taxable.lessThan(Money.parse(b.over, currency))) chosen = b;
    else break;
  }
  if (!chosen) return Money.zero(currency);
  const excess = taxable.subtract(Money.parse(chosen.over, currency));
  return Money.parse(chosen.base, currency).add(excess.multiply(chosen.rate).multiply('0.01'));
}

/** Percent-of-gross with an optional cap on the base (statutory contributions). */
export function percentOf(
  gross: Money,
  rate: string,
  maxBase: string | null,
  currency: string,
): Money {
  const base =
    maxBase && gross.greaterThan(Money.parse(maxBase, currency))
      ? Money.parse(maxBase, currency)
      : gross;
  return base.multiply(rate).multiply('0.01');
}

function amountFor(applied: AppliedItem, base: Money, gross: Money, currency: string): Money {
  const { item } = applied;
  if (applied.source === 'INPUT') return Money.parse(applied.amount ?? '0', currency);
  switch (item.calculation) {
    case 'BASE_SALARY':
      return base;
    case 'FIXED':
      return Money.parse(applied.amount ?? item.amount ?? '0', currency);
    case 'PERCENT_OF_GROSS':
      return percentOf(gross, applied.rate ?? item.rate ?? '0', item.maxBase, currency);
    case 'BRACKET':
      // Brackets apply to taxable pay, resolved by the caller after earnings are known.
      return Money.zero(currency);
  }
}

/**
 * Builds a payslip: earnings first (base salary, then the rest), which fix
 * gross and taxable pay; then deductions and employer contributions from
 * gross; then withholding from taxable pay less pre-tax deductions; then
 * reimbursements, which are neither gross nor taxable. Net = gross -
 * deductions - withholding + reimbursements.
 */
export function buildPayslip(input: {
  currency: string;
  baseSalary: string;
  applied: readonly AppliedItem[];
  reimbursements?: readonly ReimbursementDef[];
}): PayslipDraft {
  const c = input.currency;
  const base = Money.parse(input.baseSalary, c);
  const lines: PayslipLineDraft[] = [];
  const ordered = [...input.applied].sort(
    (a, b) => a.item.sortOrder - b.item.sortOrder || a.item.code.localeCompare(b.item.code),
  );
  const push = (applied: AppliedItem, amount: Money) => {
    if (amount.isZero()) return;
    lines.push({
      sequence: lines.length + 1,
      payItemId: applied.item.id,
      expenseClaimId: null,
      type: applied.item.type,
      code: applied.item.code,
      description: applied.note ? `${applied.item.name} - ${applied.note}` : applied.item.name,
      amount: amount.toString(),
      taxable: applied.item.type === 'EARNING' && applied.item.taxable,
      source: applied.source,
    });
  };

  let gross = Money.zero(c);
  let taxable = Money.zero(c);
  for (const a of ordered.filter((x) => x.item.type === 'EARNING')) {
    const amount = amountFor(a, base, gross, c);
    push(a, amount);
    gross = gross.add(amount);
    if (a.item.taxable) taxable = taxable.add(amount);
  }
  let deductions = Money.zero(c);
  let preTax = Money.zero(c);
  for (const a of ordered.filter((x) => x.item.type === 'DEDUCTION')) {
    const amount = amountFor(a, base, gross, c);
    push(a, amount);
    deductions = deductions.add(amount);
    // Statutory percent-of-gross deductions reduce taxable pay; fixed ones (loans) do not.
    if (a.item.calculation === 'PERCENT_OF_GROSS') preTax = preTax.add(amount);
  }
  let employer = Money.zero(c);
  for (const a of ordered.filter((x) => x.item.type === 'EMPLOYER_CONTRIBUTION')) {
    const amount = amountFor(a, base, gross, c);
    push(a, amount);
    employer = employer.add(amount);
  }
  const taxBase = taxable.subtract(preTax);
  let withholding = Money.zero(c);
  for (const a of ordered.filter((x) => x.item.type === 'WITHHOLDING_TAX')) {
    const amount =
      a.source === 'INPUT'
        ? Money.parse(a.amount ?? '0', c)
        : a.item.calculation === 'BRACKET'
          ? bracketTax(taxBase.isNegative() ? Money.zero(c) : taxBase, a.item.brackets, c)
          : amountFor(a, base, gross, c);
    push(a, amount);
    withholding = withholding.add(amount);
  }
  let reimbursements = Money.zero(c);
  for (const r of input.reimbursements ?? []) {
    const amount = Money.parse(r.amount, c);
    if (amount.isZero()) continue;
    lines.push({
      sequence: lines.length + 1,
      payItemId: null,
      expenseClaimId: r.expenseClaimId,
      type: 'EARNING',
      code: 'CLAIM',
      description: `Expense claim ${r.claimNumber}`,
      amount: amount.toString(),
      taxable: false,
      source: 'CLAIM',
    });
    reimbursements = reimbursements.add(amount);
  }
  const net = gross.subtract(deductions).subtract(withholding).add(reimbursements);
  if (net.isNegative())
    throw new RangeError(`Net pay is negative (${net.toString()}) - deductions exceed gross`);
  return {
    gross: gross.toString(),
    taxable: taxBase.isNegative() ? Money.zero(c).toString() : taxBase.toString(),
    withholding: withholding.toString(),
    deductions: deductions.toString(),
    employerContributions: employer.toString(),
    reimbursements: reimbursements.toString(),
    net: net.toString(),
    lines,
  };
}

/** Whether a date window covers the run's period end (assignments, employment). */
export function activeOn(
  from: string,
  to: string | null | undefined,
  periodStart: string,
  periodEnd: string,
): boolean {
  return from <= periodEnd && (!to || to >= periodStart);
}

/** Period end for a run's frequency starting at `periodStart`. */
export function periodEndFor(
  frequency: 'MONTHLY' | 'SEMI_MONTHLY' | 'WEEKLY',
  periodStart: string,
): string {
  const [y, m, d] = periodStart.split('-').map(Number) as [number, number, number];
  if (frequency === 'WEEKLY') return new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
  if (frequency === 'SEMI_MONTHLY' && d <= 15)
    return new Date(Date.UTC(y, m - 1, 15)).toISOString().slice(0, 10);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
