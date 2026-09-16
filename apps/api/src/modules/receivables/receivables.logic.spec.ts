import { Money } from '@accounting/money';
import { DEFAULT_AGING_BUCKETS, type DunningStep } from '@accounting/types';
import {
  agingBucketFor,
  agingProvision,
  collectionRate,
  daysSalesOutstanding,
  dueDateFor,
  dueDunningSteps,
  evaluateCreditRules,
  evaluatePromise,
  summarizeCredit,
  unappliedAge,
  type CreditPosition,
  type CreditRuleLike,
} from './receivables.logic';

const PHP = 'PHP';

describe('dueDateFor (payment terms)', () => {
  it('computes net days, due on receipt, end of month and day of next month', () => {
    expect(dueDateFor('2026-01-15', { basis: 'NET_DAYS', days: 30, dayOfMonth: null })).toBe(
      '2026-02-14',
    );
    expect(dueDateFor('2026-01-15', { basis: 'DUE_ON_RECEIPT', days: 0, dayOfMonth: null })).toBe(
      '2026-01-15',
    );
    expect(dueDateFor('2026-01-15', { basis: 'END_OF_MONTH', days: 15, dayOfMonth: null })).toBe(
      '2026-02-15',
    );
    expect(dueDateFor('2026-02-10', { basis: 'END_OF_MONTH', days: 0, dayOfMonth: null })).toBe(
      '2026-02-28',
    );
    expect(dueDateFor('2026-01-31', { basis: 'DAY_OF_NEXT_MONTH', days: 0, dayOfMonth: 15 })).toBe(
      '2026-02-15',
    );
    expect(dueDateFor('2026-12-20', { basis: 'DAY_OF_NEXT_MONTH', days: 0, dayOfMonth: 10 })).toBe(
      '2027-01-10',
    );
  });
});

describe('credit summary', () => {
  const base: CreditPosition = {
    creditLimit: '1000000',
    netBalance: '500000',
    pendingDocuments: '100000',
    openOrders: '50000',
    overdue: '0',
    oldestOverdueDays: 0,
    creditHold: false,
  };

  it('derives credit used, available credit and status', () => {
    const s = summarizeCredit(base, PHP);
    expect(s.creditUsed).toBe('650000.0000');
    expect(s.availableCredit).toBe('350000.0000');
    expect(s.status).toBe('GOOD');
  });

  it('flags WARNING near the limit or with overdue, OVER_LIMIT above it and ON_HOLD on hold', () => {
    expect(summarizeCredit({ ...base, netBalance: '800000' }, PHP).status).toBe('WARNING');
    expect(summarizeCredit({ ...base, overdue: '10' }, PHP).status).toBe('WARNING');
    expect(summarizeCredit({ ...base, netBalance: '1000000' }, PHP).status).toBe('OVER_LIMIT');
    expect(summarizeCredit({ ...base, creditHold: true, netBalance: '2000000' }, PHP).status).toBe(
      'ON_HOLD',
    );
    expect(summarizeCredit({ ...base, creditLimit: null }, PHP).availableCredit).toBeNull();
  });
});

describe('evaluateCreditRules', () => {
  const rules: CreditRuleLike[] = [
    {
      id: 'r1',
      name: 'Over limit needs approval',
      scope: 'SALES_ORDER',
      trigger: 'EXPOSURE_OVER_LIMIT',
      action: 'REQUIRE_APPROVAL',
      thresholdAmount: null,
      thresholdPercent: '0',
      thresholdDays: null,
      customerGroupId: null,
      priority: 10,
    },
    {
      id: 'r2',
      name: 'Block on overdue > 250k',
      scope: 'SALES_ORDER',
      trigger: 'OVERDUE_BALANCE',
      action: 'BLOCK',
      thresholdAmount: '250000',
      thresholdPercent: null,
      thresholdDays: null,
      customerGroupId: null,
      priority: 20,
    },
    {
      id: 'r3',
      name: 'Retail: 10% tolerance',
      scope: 'SALES_ORDER',
      trigger: 'EXPOSURE_OVER_LIMIT',
      action: 'WARN',
      thresholdAmount: null,
      thresholdPercent: '10',
      thresholdDays: null,
      customerGroupId: 'retail',
      priority: 5,
    },
    {
      id: 'r4',
      name: 'Invoice rule',
      scope: 'INVOICE',
      trigger: 'NO_CREDIT_LIMIT',
      action: 'WARN',
      thresholdAmount: null,
      thresholdPercent: null,
      thresholdDays: null,
      customerGroupId: null,
      priority: 1,
    },
    {
      id: 'r5',
      name: 'Old debt',
      scope: 'SALES_ORDER',
      trigger: 'DAYS_OVERDUE',
      action: 'REQUIRE_APPROVAL',
      thresholdAmount: null,
      thresholdPercent: null,
      thresholdDays: 90,
      customerGroupId: null,
      priority: 30,
    },
  ];
  const position: CreditPosition = {
    creditLimit: '1000000',
    netBalance: '650000',
    pendingDocuments: '0',
    openOrders: '0',
    overdue: '0',
    oldestOverdueDays: 0,
    creditHold: false,
  };

  it('passes when the order fits within the limit', () => {
    const r = evaluateCreditRules(rules, 'SALES_ORDER', position, '300000', null, PHP);
    expect(r.outcome).toBeNull();
    expect(r.findings).toEqual([]);
  });

  it('requires approval when exposure exceeds the limit and returns the worst action', () => {
    const r = evaluateCreditRules(rules, 'SALES_ORDER', position, '400000', null, PHP);
    expect(r.outcome).toBe('REQUIRE_APPROVAL');
    expect(r.findings.map((f) => f.ruleId)).toEqual(['r1']);
    const blocked = evaluateCreditRules(
      rules,
      'SALES_ORDER',
      { ...position, overdue: '300000', oldestOverdueDays: 100 },
      '1',
      null,
      PHP,
    );
    expect(blocked.outcome).toBe('BLOCK');
    expect(blocked.findings.map((f) => f.ruleId).sort()).toEqual(['r2', 'r5']);
  });

  it('applies group-scoped rules only to that group and ignores other scopes', () => {
    // Within the retail 10% tolerance only the company-wide rule fires; beyond it both do.
    const retail = evaluateCreditRules(rules, 'SALES_ORDER', position, '400000', 'retail', PHP);
    expect(retail.findings.map((f) => f.ruleId)).toEqual(['r1']);
    const beyond = evaluateCreditRules(rules, 'SALES_ORDER', position, '500000', 'retail', PHP);
    expect(beyond.findings.map((f) => f.ruleId)).toEqual(['r3', 'r1']);
    expect(beyond.outcome).toBe('REQUIRE_APPROVAL');
    const invoice = evaluateCreditRules(
      rules,
      'INVOICE',
      { ...position, creditLimit: null },
      '1',
      null,
      PHP,
    );
    expect(invoice.outcome).toBe('WARN');
    expect(invoice.findings[0]!.trigger).toBe('NO_CREDIT_LIMIT');
  });
});

describe('aging buckets', () => {
  it('uses configurable buckets and falls back to the last open-ended one', () => {
    expect(agingBucketFor('2026-09-14', '2026-10-01')).toBe('current');
    expect(agingBucketFor('2026-09-14', '2026-09-14')).toBe('current');
    expect(agingBucketFor('2026-09-14', '2026-09-01')).toBe('days1to30');
    expect(agingBucketFor('2026-09-14', '2026-07-20')).toBe('days31to60');
    expect(agingBucketFor('2026-09-14', '2026-05-31')).toBe('days91to120');
    expect(agingBucketFor('2026-09-14', '2026-03-16')).toBe('over120');
    const custom = [
      { key: 'current', label: 'Current', from: -1_000_000, to: 0 },
      { key: 'late', label: '1-15', from: 1, to: 15 },
      { key: 'verylate', label: '16+', from: 16, to: null },
    ];
    expect(agingBucketFor('2026-09-14', '2026-09-01', custom)).toBe('late');
    expect(agingBucketFor('2026-09-14', '2026-01-01', custom)).toBe('verylate');
    expect(DEFAULT_AGING_BUCKETS[DEFAULT_AGING_BUCKETS.length - 1]!.to).toBeNull();
  });
});

describe('DSO and collection rate', () => {
  it('computes countback DSO and clamps the collection rate', () => {
    expect(daysSalesOutstanding('300000', '900000', 90, PHP)).toBe(30);
    expect(daysSalesOutstanding('1000', '0', 90, PHP)).toBe(0);
    expect(collectionRate('80000', '100000', PHP)).toBe(0.8);
    expect(collectionRate('150000', '100000', PHP)).toBe(1);
    expect(collectionRate('0', '0', PHP)).toBe(1);
  });
});

describe('promises to pay', () => {
  const promise = { amount: '500000', promiseDate: '2026-09-30', status: 'PENDING' as const };
  it('is KEPT when cash covers it, BROKEN after the date, PENDING before', () => {
    expect(evaluatePromise(promise, '500000', '2026-09-20', PHP)).toBe('KEPT');
    expect(evaluatePromise(promise, '100000', '2026-09-20', PHP)).toBe('PENDING');
    expect(evaluatePromise(promise, '100000', '2026-10-01', PHP)).toBe('BROKEN');
    expect(evaluatePromise({ ...promise, status: 'CANCELLED' }, '0', '2026-10-01', PHP)).toBe(
      'CANCELLED',
    );
  });
});

describe('dunning steps', () => {
  const steps: DunningStep[] = [
    { daysOverdue: 0, action: 'REMINDER', label: 'Due' },
    { daysOverdue: 7, action: 'REMINDER', label: 'First reminder' },
    { daysOverdue: 30, action: 'ESCALATION', label: 'Escalate' },
    { daysOverdue: 60, action: 'CREDIT_HOLD', label: 'Hold' },
  ];
  it('returns the steps that are due and not yet executed, in order', () => {
    expect(dueDunningSteps(steps, 10, new Set()).map((s) => s.index)).toEqual([0, 1]);
    expect(dueDunningSteps(steps, 10, new Set([0])).map((s) => s.index)).toEqual([1]);
    expect(dueDunningSteps(steps, 65, new Set([0, 1, 2])).map((s) => s.step.action)).toEqual([
      'CREDIT_HOLD',
    ]);
    expect(dueDunningSteps(steps, -3, new Set())).toEqual([]);
  });
});

describe('bad-debt provisioning', () => {
  it('applies configurable rates per bucket', () => {
    const r = agingProvision(
      [
        { key: 'current', balance: '100000' },
        { key: 'days1to30', balance: '50000' },
        { key: 'over120', balance: '20000' },
      ],
      { days1to30: '2', over120: '50' },
      PHP,
    );
    expect(r.required.equals(Money.of('11000', PHP))).toBe(true);
    expect(r.byBucket.find((b) => b.key === 'current')!.allowance).toBe('0.0000');
    expect(r.byBucket.find((b) => b.key === 'over120')!.allowance).toBe('10000.0000');
  });
});

describe('unapplied cash age', () => {
  it('never goes negative', () => {
    expect(unappliedAge('2026-08-01', '2026-09-14')).toBe(44);
    expect(unappliedAge('2026-09-20', '2026-09-14')).toBe(0);
  });
});
