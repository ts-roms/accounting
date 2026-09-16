import { Money } from '@accounting/money';
import {
  columnWindow,
  evaluateFormula,
  evaluationOrder,
  present,
  priorPeriod,
  selectAccounts,
  variancePct,
} from './report-engine.logic';

const PHP = (v: string | number) => Money.of(v, 'PHP');

describe('report engine logic', () => {
  const input = { from: '2026-06-01', to: '2026-06-30', fiscalYearStart: '2026-01-01' };

  it('resolves prior period for whole months, quarters and arbitrary spans', () => {
    expect(priorPeriod('2026-06-01', '2026-06-30')).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(priorPeriod('2026-04-01', '2026-06-30')).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });
    expect(priorPeriod('2026-03-01', '2026-03-31')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(priorPeriod('2026-06-10', '2026-06-19')).toEqual({
      from: '2026-05-31',
      to: '2026-06-09',
    });
  });

  it('resolves column windows per kind and basis', () => {
    expect(columnWindow({ kind: 'CURRENT' }, input, 'PERIOD')).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(columnWindow({ kind: 'YEAR_TO_DATE' }, input, 'PERIOD')).toEqual({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(columnWindow({ kind: 'PRIOR_YEAR' }, input, 'PERIOD')).toEqual({
      from: '2025-06-01',
      to: '2025-06-30',
    });
    expect(columnWindow({ kind: 'CURRENT' }, input, 'AS_OF')).toEqual({ to: '2026-06-30' });
    expect(columnWindow({ kind: 'PRIOR_PERIOD' }, input, 'AS_OF')).toEqual({ to: '2026-05-31' });
    expect(
      columnWindow({ kind: 'CUSTOM_RANGE', from: '2026-01-01', to: '2026-03-31' }, input, 'PERIOD'),
    ).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });
    expect(columnWindow({ kind: 'VARIANCE' }, input, 'PERIOD')).toBeNull();
  });

  it('selects accounts by id, code, range, type, subtype and mapping key, never headers', () => {
    const accounts = [
      {
        id: 'h',
        code: '4000',
        type: 'REVENUE',
        subtype: null,
        normalBalance: 'CREDIT' as const,
        isHeader: true,
      },
      {
        id: 'a',
        code: '4100',
        type: 'REVENUE',
        subtype: 'SALES',
        normalBalance: 'CREDIT' as const,
        isHeader: false,
      },
      {
        id: 'b',
        code: '4200',
        type: 'REVENUE',
        subtype: 'OTHER_INCOME',
        normalBalance: 'CREDIT' as const,
        isHeader: false,
      },
      {
        id: 'c',
        code: '6400',
        type: 'EXPENSE',
        subtype: null,
        normalBalance: 'DEBIT' as const,
        isHeader: false,
      },
    ];
    const mapped = new Map([['SALES_REVENUE', 'a']]);
    const ids = (s: Parameters<typeof selectAccounts>[1]) =>
      selectAccounts(accounts, s, mapped).map((a) => a.id);
    expect(ids({ types: ['REVENUE'] })).toEqual(['a', 'b']);
    expect(ids({ codeFrom: '4100', codeTo: '4150' })).toEqual(['a']);
    expect(ids({ subtypes: ['OTHER_INCOME'] })).toEqual(['b']);
    expect(ids({ mappingKeys: ['SALES_REVENUE'], codes: ['6400'] })).toEqual(['a', 'c']);
  });

  it('presents on the natural side and honours sign overrides', () => {
    expect(present(PHP(0), PHP(1000), 'CREDIT', 'NATURAL').toString()).toBe('1000.0000');
    expect(present(PHP(0), PHP(1000), 'CREDIT', 'DEBIT').toString()).toBe('-1000.0000');
    expect(present(PHP(300), PHP(0), 'DEBIT', 'NATURAL').toString()).toBe('300.0000');
  });

  it('evaluates formulas over row values and orders dependent rows after their inputs', () => {
    const values = new Map([
      ['REVENUE', PHP(1000)],
      ['COGS', PHP(400)],
      ['OPEX', PHP(250)],
    ]);
    expect(evaluateFormula('REVENUE - COGS', values, 'PHP').toString()).toBe('600.0000');
    expect(evaluateFormula('REVENUE - COGS - OPEX + MISSING', values, 'PHP').toString()).toBe(
      '350.0000',
    );
    const rows = [
      {
        key: 'NET',
        kind: 'FORMULA',
        formula: 'GROSS - OPEX',
        label: 'Net',
        sign: 'NATURAL',
        showAccounts: false,
        bold: true,
        hidden: false,
      },
      {
        key: 'GROSS',
        kind: 'FORMULA',
        formula: 'REVENUE - COGS',
        label: 'Gross',
        sign: 'NATURAL',
        showAccounts: false,
        bold: false,
        hidden: false,
      },
      {
        key: 'REVENUE',
        kind: 'ACCOUNTS',
        label: 'Revenue',
        sign: 'NATURAL',
        showAccounts: false,
        bold: false,
        hidden: false,
      },
      {
        key: 'COGS',
        kind: 'ACCOUNTS',
        label: 'COGS',
        sign: 'NATURAL',
        showAccounts: false,
        bold: false,
        hidden: false,
      },
      {
        key: 'OPEX',
        kind: 'ACCOUNTS',
        label: 'Opex',
        sign: 'NATURAL',
        showAccounts: false,
        bold: false,
        hidden: false,
      },
    ] as const;
    expect(evaluationOrder(rows as never)).toEqual(['REVENUE', 'COGS', 'OPEX', 'GROSS', 'NET']);
  });

  it('computes percentage variance and yields null against zero', () => {
    expect(variancePct(PHP(1200), PHP(1000))).toBe('20.00');
    expect(variancePct(PHP(800), PHP(-1000))).toBe('180.00');
    expect(variancePct(PHP(5), PHP(0))).toBeNull();
  });
});
