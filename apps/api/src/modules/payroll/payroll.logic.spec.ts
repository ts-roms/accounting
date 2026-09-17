import { Money } from '@accounting/money';
import {
  activeOn,
  bracketTax,
  buildPayslip,
  percentOf,
  periodEndFor,
  type AppliedItem,
  type PayItemDef,
} from './payroll.logic';

const item = (
  partial: Partial<PayItemDef> & Pick<PayItemDef, 'code' | 'type' | 'calculation'>,
): PayItemDef => ({
  id: partial.code,
  name: partial.code,
  amount: null,
  rate: null,
  maxBase: null,
  brackets: [],
  taxable: true,
  sortOrder: 100,
  ...partial,
});

const BRACKETS = [
  { over: '0', base: '0', rate: '0' },
  { over: '20833', base: '0', rate: '15' },
  { over: '33333', base: '1875', rate: '20' },
  { over: '66667', base: '8541.80', rate: '25' },
];

describe('payroll.logic', () => {
  it('computes progressive withholding from the bracket the taxable pay falls in', () => {
    expect(bracketTax(Money.of(15000, 'PHP'), BRACKETS, 'PHP').toString()).toBe('0.0000');
    expect(bracketTax(Money.of(30000, 'PHP'), BRACKETS, 'PHP').toString()).toBe('1375.0500'); // (30000-20833) x 15%
    expect(bracketTax(Money.of(50000, 'PHP'), BRACKETS, 'PHP').toString()).toBe('5208.4000'); // 1875 + (50000-33333) x 20%
    expect(bracketTax(Money.zero('PHP'), BRACKETS, 'PHP').toString()).toBe('0.0000');
  });

  it('caps percent-of-gross contributions at the maximum base', () => {
    expect(percentOf(Money.of(50000, 'PHP'), '4.5', '30000', 'PHP').toString()).toBe('1350.0000');
    expect(percentOf(Money.of(20000, 'PHP'), '4.5', '30000', 'PHP').toString()).toBe('900.0000');
    expect(percentOf(Money.of(20000, 'PHP'), '2', null, 'PHP').toString()).toBe('400.0000');
  });

  it('builds a payslip: earnings -> gross, pre-tax deductions reduce taxable, withholding, employer cost, reimbursements', () => {
    const applied: AppliedItem[] = [
      {
        item: item({ code: 'BASIC', type: 'EARNING', calculation: 'BASE_SALARY', sortOrder: 1 }),
        source: 'BASE',
      },
      {
        item: item({
          code: 'ALLOW',
          type: 'EARNING',
          calculation: 'FIXED',
          amount: '2000',
          taxable: false,
          sortOrder: 10,
        }),
        source: 'COMPANY',
      },
      {
        item: item({ code: 'OT', type: 'EARNING', calculation: 'FIXED', sortOrder: 5 }),
        source: 'INPUT',
        amount: '3000',
        note: '12 hours',
      },
      {
        item: item({
          code: 'SSS',
          type: 'DEDUCTION',
          calculation: 'PERCENT_OF_GROSS',
          rate: '4.5',
          maxBase: '30000',
          sortOrder: 20,
        }),
        source: 'COMPANY',
      },
      {
        item: item({ code: 'LOAN', type: 'DEDUCTION', calculation: 'FIXED', sortOrder: 30 }),
        source: 'ASSIGNMENT',
        amount: '1500',
      },
      {
        item: item({
          code: 'SSS-ER',
          type: 'EMPLOYER_CONTRIBUTION',
          calculation: 'PERCENT_OF_GROSS',
          rate: '9.5',
          maxBase: '30000',
          sortOrder: 40,
        }),
        source: 'COMPANY',
      },
      {
        item: item({
          code: 'WTAX',
          type: 'WITHHOLDING_TAX',
          calculation: 'BRACKET',
          brackets: BRACKETS,
          sortOrder: 50,
        }),
        source: 'COMPANY',
      },
    ];
    const slip = buildPayslip({
      currency: 'PHP',
      baseSalary: '40000',
      applied,
      reimbursements: [{ expenseClaimId: 'c1', claimNumber: 'EXP-1', amount: '800' }],
    });
    expect(slip.gross).toBe('45000.0000'); // 40,000 + 3,000 OT + 2,000 allowance
    expect(slip.deductions).toBe('2850.0000'); // 1,350 SSS (capped) + 1,500 loan
    expect(slip.taxable).toBe('41650.0000'); // 43,000 taxable earnings - 1,350 pre-tax
    expect(slip.withholding).toBe('3538.4000'); // 1875 + (41650-33333) x 20%
    expect(slip.employerContributions).toBe('2850.0000'); // 9.5% of 30,000
    expect(slip.reimbursements).toBe('800.0000');
    expect(slip.net).toBe('39411.6000'); // 45,000 - 2,850 - 3,538.40 + 800
    expect(slip.lines.map((l) => l.code)).toEqual([
      'BASIC',
      'OT',
      'ALLOW',
      'SSS',
      'LOAN',
      'SSS-ER',
      'WTAX',
      'CLAIM',
    ]);
    expect(slip.lines.find((l) => l.code === 'OT')?.description).toBe('OT - 12 hours');
    expect(slip.lines.find((l) => l.code === 'ALLOW')?.taxable).toBe(false);
  });

  it('refuses a negative net and skips zero lines', () => {
    const applied: AppliedItem[] = [
      {
        item: item({ code: 'BASIC', type: 'EARNING', calculation: 'BASE_SALARY', sortOrder: 1 }),
        source: 'BASE',
      },
      {
        item: item({ code: 'ZERO', type: 'EARNING', calculation: 'FIXED', amount: '0' }),
        source: 'COMPANY',
      },
      {
        item: item({ code: 'LOAN', type: 'DEDUCTION', calculation: 'FIXED', amount: '5000' }),
        source: 'ASSIGNMENT',
      },
    ];
    expect(
      buildPayslip({ currency: 'PHP', baseSalary: '5000', applied }).lines.map((l) => l.code),
    ).toEqual(['BASIC', 'LOAN']);
    expect(() => buildPayslip({ currency: 'PHP', baseSalary: '4000', applied })).toThrow(
      /negative/,
    );
  });

  it('resolves period ends and active windows', () => {
    expect(periodEndFor('MONTHLY', '2026-05-01')).toBe('2026-05-31');
    expect(periodEndFor('SEMI_MONTHLY', '2026-05-01')).toBe('2026-05-15');
    expect(periodEndFor('SEMI_MONTHLY', '2026-05-16')).toBe('2026-05-31');
    expect(periodEndFor('WEEKLY', '2026-05-04')).toBe('2026-05-10');
    expect(activeOn('2026-05-10', null, '2026-05-01', '2026-05-31')).toBe(true);
    expect(activeOn('2026-06-01', null, '2026-05-01', '2026-05-31')).toBe(false);
    expect(activeOn('2026-01-01', '2026-04-30', '2026-05-01', '2026-05-31')).toBe(false);
    expect(activeOn('2026-01-01', '2026-05-01', '2026-05-01', '2026-05-31')).toBe(true);
  });
});
