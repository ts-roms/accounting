import { Money } from '@accounting/money';
import {
  DEFAULT_AGING_BUCKETS,
  type AgingBucketDefinition,
  type CreditRuleAction,
  type CreditRuleScope,
  type CreditRuleTrigger,
  type CreditStatus,
  type DunningStep,
  type PaymentTermBasis,
  type PromiseStatus,
  type ProvisionRates,
} from '@accounting/types';
import { addDays, daysBetween } from '@/modules/subledger/subledger.logic';

/**
 * Pure accounts-receivable rules (Prompt #6): due dates, credit status and
 * credit-rule evaluation, configurable aging, DSO, promise evaluation,
 * dunning step selection and bad-debt provisioning. No I/O - the services
 * feed these functions with data they already loaded inside a transaction.
 */

// ------------------------------------------------------------ payment terms

export interface PaymentTermLike {
  basis: PaymentTermBasis;
  days: number;
  dayOfMonth: number | null;
}

/** Due date for a document date under a named payment term. */
export function dueDateFor(documentDate: string, term: PaymentTermLike): string {
  const [y, m] = documentDate.split('-').map(Number) as [number, number, number];
  switch (term.basis) {
    case 'DUE_ON_RECEIPT':
      return documentDate;
    case 'NET_DAYS':
      return addDays(documentDate, term.days);
    case 'END_OF_MONTH': {
      // Day 0 of the next month is the last day of this month.
      const eom = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      return addDays(eom, term.days);
    }
    case 'DAY_OF_NEXT_MONTH': {
      const day = Math.min(Math.max(term.dayOfMonth ?? 1, 1), 28);
      return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
    }
  }
}

// ------------------------------------------------------------------- credit

export interface CreditPosition {
  /** Credit limit or null when the customer has none. */
  creditLimit: string | null;
  /** Posted open balance net of unapplied credit (what the subledger says). */
  netBalance: string;
  /** Unposted (draft / submitted / approved) invoices and debit notes. */
  pendingDocuments: string;
  /** Approved but not yet invoiced sales orders. */
  openOrders: string;
  overdue: string;
  /** Days the oldest overdue document is past due (0 = none). */
  oldestOverdueDays: number;
  creditHold: boolean;
}

export interface CreditSummary {
  creditLimit: string | null;
  creditUsed: string;
  availableCredit: string | null;
  overdue: string;
  status: CreditStatus;
  creditHold: boolean;
  oldestOverdueDays: number;
}

/**
 * Credit used = everything the customer owes or will owe: posted net balance
 * plus unposted documents plus open orders. Status is a policy-free summary;
 * the configurable rules decide what actually happens.
 */
export function summarizeCredit(position: CreditPosition, currency: string): CreditSummary {
  const used = Money.of(position.netBalance, currency)
    .add(Money.of(position.pendingDocuments, currency))
    .add(Money.of(position.openOrders, currency));
  const limit = position.creditLimit ? Money.of(position.creditLimit, currency) : null;
  const available = limit ? limit.subtract(used) : null;
  const overdue = Money.of(position.overdue, currency);
  let status: CreditStatus = 'GOOD';
  if (position.creditHold) status = 'ON_HOLD';
  else if (limit && used.greaterThan(limit)) status = 'OVER_LIMIT';
  else if (overdue.isPositive() || (limit && used.greaterThan(limit.multiply('0.9'))))
    status = 'WARNING';
  return {
    creditLimit: limit?.toString() ?? null,
    creditUsed: used.toString(),
    availableCredit: available?.toString() ?? null,
    overdue: overdue.toString(),
    status,
    creditHold: position.creditHold,
    oldestOverdueDays: position.oldestOverdueDays,
  };
}

export interface CreditRuleLike {
  id: string;
  name: string;
  scope: CreditRuleScope;
  trigger: CreditRuleTrigger;
  action: CreditRuleAction;
  thresholdAmount: string | null;
  thresholdPercent: string | null;
  thresholdDays: number | null;
  customerGroupId: string | null;
  priority: number;
}

export interface CreditFinding {
  ruleId: string;
  rule: string;
  trigger: CreditRuleTrigger;
  action: CreditRuleAction;
  message: string;
  details: Record<string, string | number | null>;
}

export interface CreditCheckResult {
  /** Worst action among the findings: BLOCK > REQUIRE_APPROVAL > WARN; null when nothing fired. */
  outcome: CreditRuleAction | null;
  findings: CreditFinding[];
  summary: CreditSummary;
}

const ACTION_RANK: Record<CreditRuleAction, number> = { WARN: 1, REQUIRE_APPROVAL: 2, BLOCK: 3 };

/**
 * Evaluates the active rules for a scope against the customer's position plus
 * the document being checked. Rules restricted to a group only apply to that
 * group; every matching rule contributes a finding so the approver sees why.
 */
export function evaluateCreditRules(
  rules: CreditRuleLike[],
  scope: CreditRuleScope,
  position: CreditPosition,
  documentAmount: string,
  customerGroupId: string | null,
  currency: string,
): CreditCheckResult {
  const summary = summarizeCredit(position, currency);
  const exposure = Money.of(summary.creditUsed, currency).add(Money.of(documentAmount, currency));
  const limit = position.creditLimit ? Money.of(position.creditLimit, currency) : null;
  const overdue = Money.of(position.overdue, currency);
  const findings: CreditFinding[] = [];
  const applicable = rules
    .filter((r) => r.scope === scope)
    .filter((r) => !r.customerGroupId || r.customerGroupId === customerGroupId)
    .sort((a, b) => a.priority - b.priority);
  for (const rule of applicable) {
    let fired = false;
    const details: CreditFinding['details'] = {};
    switch (rule.trigger) {
      case 'EXPOSURE_OVER_LIMIT': {
        if (!limit) break;
        const allowed = limit.add(limit.multiply(rule.thresholdPercent ?? '0').multiply('0.01'));
        fired = exposure.greaterThan(allowed);
        details.exposure = exposure.toString();
        details.creditLimit = limit.toString();
        details.allowed = allowed.toString();
        break;
      }
      case 'OVERDUE_BALANCE': {
        const threshold = Money.of(rule.thresholdAmount ?? '0', currency);
        fired = overdue.isPositive() && overdue.greaterThan(threshold);
        details.overdue = overdue.toString();
        details.threshold = threshold.toString();
        break;
      }
      case 'DAYS_OVERDUE':
        fired = position.oldestOverdueDays > (rule.thresholdDays ?? 0);
        details.oldestOverdueDays = position.oldestOverdueDays;
        details.thresholdDays = rule.thresholdDays ?? 0;
        break;
      case 'CREDIT_HOLD':
        fired = position.creditHold;
        break;
      case 'NO_CREDIT_LIMIT':
        fired = !limit;
        break;
    }
    if (fired)
      findings.push({
        ruleId: rule.id,
        rule: rule.name,
        trigger: rule.trigger,
        action: rule.action,
        message: describeFinding(rule, details),
        details,
      });
  }
  const outcome = findings.reduce<CreditRuleAction | null>(
    (worst, f) => (!worst || ACTION_RANK[f.action] > ACTION_RANK[worst] ? f.action : worst),
    null,
  );
  return { outcome, findings, summary };
}

function describeFinding(rule: CreditRuleLike, d: CreditFinding['details']): string {
  switch (rule.trigger) {
    case 'EXPOSURE_OVER_LIMIT':
      return `Exposure ${d.exposure} exceeds the allowed ${d.allowed} (limit ${d.creditLimit}).`;
    case 'OVERDUE_BALANCE':
      return `Overdue balance ${d.overdue} exceeds ${d.threshold}.`;
    case 'DAYS_OVERDUE':
      return `Oldest overdue document is ${d.oldestOverdueDays} days past due (limit ${d.thresholdDays}).`;
    case 'CREDIT_HOLD':
      return 'The customer is on credit hold.';
    case 'NO_CREDIT_LIMIT':
      return 'The customer has no credit limit.';
  }
}

// -------------------------------------------------------------------- aging

/** Bucket key for a due date as of a date under configurable buckets. */
export function agingBucketFor(
  asOf: string,
  dueDate: string,
  buckets: readonly AgingBucketDefinition[] = DEFAULT_AGING_BUCKETS,
): string {
  const overdue = daysBetween(dueDate, asOf);
  for (const b of buckets)
    if (overdue >= b.from && (b.to === null || overdue <= b.to)) return b.key;
  return buckets[buckets.length - 1]!.key;
}

// --------------------------------------------------------------------- DSO

/**
 * Countback DSO: open receivables consumed backwards through daily revenue of
 * the window. `revenueInWindow` is credit sales (posted invoices less credit
 * notes) over `windowDays`; result is days, rounded to one decimal.
 */
export function daysSalesOutstanding(
  openReceivables: string,
  revenueInWindow: string,
  windowDays: number,
  currency: string,
): number {
  const revenue = Money.of(revenueInWindow, currency);
  if (!revenue.isPositive() || windowDays <= 0) return 0;
  const open = Number(Money.of(openReceivables, currency).toString());
  const perDay = Number(revenue.toString()) / windowDays;
  return Math.round((open / perDay) * 10) / 10;
}

/** Share of what fell due in the window that was collected (0-1, two decimals). */
export function collectionRate(collected: string, due: string, currency: string): number {
  const d = Money.of(due, currency);
  if (!d.isPositive()) return 1;
  const rate = Number(Money.of(collected, currency).toString()) / Number(d.toString());
  return Math.round(Math.min(Math.max(rate, 0), 1) * 100) / 100;
}

// ----------------------------------------------------------------- promises

/**
 * A promise is KEPT when receipts from the customer between its creation and
 * `promiseDate` (inclusive) cover the amount; BROKEN once the date has passed
 * without enough cash; otherwise still PENDING.
 */
export function evaluatePromise(
  promise: { amount: string; promiseDate: string; status: PromiseStatus },
  settledAmount: string,
  today: string,
  currency: string,
): PromiseStatus {
  if (promise.status !== 'PENDING') return promise.status;
  const settled = Money.of(settledAmount, currency);
  if (!settled.lessThan(Money.of(promise.amount, currency))) return 'KEPT';
  return today > promise.promiseDate ? 'BROKEN' : 'PENDING';
}

// ------------------------------------------------------------------ dunning

/**
 * Steps of a policy that are due for an invoice `daysOverdue` past its due
 * date and have not run yet (indexes already executed are skipped). Returns
 * them in order so the job can run every missed step, oldest first.
 */
export function dueDunningSteps(
  steps: readonly DunningStep[],
  daysOverdue: number,
  executed: ReadonlySet<number>,
): Array<{ index: number; step: DunningStep }> {
  return steps
    .map((step, index) => ({ index, step }))
    .filter(({ index, step }) => step.daysOverdue <= daysOverdue && !executed.has(index));
}

// ------------------------------------------------------------- provisioning

export interface BucketBalance {
  key: string;
  balance: string;
}

/** Required allowance under AGING_PERCENT: sum(bucket balance x rate). Buckets without a rate contribute zero. */
export function agingProvision(
  buckets: readonly BucketBalance[],
  rates: ProvisionRates,
  currency: string,
): {
  required: Money;
  byBucket: Array<{ key: string; balance: string; rate: string; allowance: string }>;
} {
  let required = Money.zero(currency);
  const byBucket = buckets.map((b) => {
    const rate = rates[b.key] ?? '0';
    const allowance = Money.of(b.balance, currency).multiply(rate).multiply('0.01');
    required = required.add(allowance);
    return { key: b.key, balance: b.balance, rate, allowance: allowance.toString() };
  });
  return { required, byBucket };
}

// ------------------------------------------------------------ unapplied cash

/** Age in days of an unapplied receipt as of a date. */
export function unappliedAge(paymentDate: string, asOf: string): number {
  return Math.max(0, daysBetween(paymentDate, asOf));
}
