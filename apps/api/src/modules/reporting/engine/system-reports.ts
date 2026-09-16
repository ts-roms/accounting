import type { ReportBasis, ReportCategory } from '@accounting/types';
import type { ReportLayoutInput } from '@accounting/validation';

export interface SystemReportDefinition {
  code: string;
  name: string;
  description: string;
  category: ReportCategory;
  basis: ReportBasis;
  layout: ReportLayoutInput;
}

const row = (
  key: string,
  label: string,
  extra: Partial<ReportLayoutInput['rows'][number]> = {},
): ReportLayoutInput['rows'][number] => ({
  key,
  label,
  kind: 'ACCOUNTS',
  sign: 'NATURAL',
  showAccounts: false,
  bold: false,
  hidden: false,
  ...extra,
});

const PL_ROWS: ReportLayoutInput['rows'] = [
  row('REVENUE', 'Revenue', { accounts: { types: ['REVENUE'] }, showAccounts: true }),
  row('COST_OF_SALES', 'Cost of sales', {
    accounts: { types: ['COST_OF_SALES'] },
    showAccounts: true,
  }),
  row('GROSS_PROFIT', 'Gross profit', {
    kind: 'FORMULA',
    formula: 'REVENUE - COST_OF_SALES',
    bold: true,
  }),
  row('OPERATING_EXPENSES', 'Operating expenses', {
    accounts: { types: ['EXPENSE'] },
    showAccounts: true,
  }),
  row('OPERATING_INCOME', 'Operating income', {
    kind: 'FORMULA',
    formula: 'GROSS_PROFIT - OPERATING_EXPENSES',
    bold: true,
  }),
  row('OTHER_INCOME', 'Other income', { accounts: { types: ['OTHER_INCOME'] } }),
  row('OTHER_EXPENSES', 'Other expenses', { accounts: { types: ['OTHER_EXPENSE'] } }),
  row('NET_INCOME', 'Net income', {
    kind: 'FORMULA',
    formula: 'OPERATING_INCOME + OTHER_INCOME - OTHER_EXPENSES',
    bold: true,
  }),
];

/** Built-in definitions seeded per company; copies of these are the starting point for custom reports. */
export const SYSTEM_REPORT_DEFINITIONS: readonly SystemReportDefinition[] = [
  {
    code: 'PL_COMPARATIVE',
    name: 'Income statement - comparative',
    description: 'Current period against the prior period and year to date, with variances.',
    category: 'FINANCIAL',
    basis: 'PERIOD',
    layout: {
      rows: PL_ROWS,
      columns: [
        { key: 'CURRENT', label: 'Current', kind: 'CURRENT' },
        { key: 'PRIOR', label: 'Prior period', kind: 'PRIOR_PERIOD' },
        { key: 'VAR', label: 'Variance', kind: 'VARIANCE', base: 'CURRENT', against: 'PRIOR' },
        {
          key: 'VAR_PCT',
          label: 'Variance %',
          kind: 'VARIANCE_PCT',
          base: 'CURRENT',
          against: 'PRIOR',
        },
        { key: 'YTD', label: 'Year to date', kind: 'YEAR_TO_DATE' },
        { key: 'PRIOR_YEAR', label: 'Prior year', kind: 'PRIOR_YEAR' },
      ],
    },
  },
  {
    code: 'BUDGET_VS_ACTUAL',
    name: 'Budget vs actual',
    description:
      'Profit and loss lines against the approved budget for the period and year to date.',
    category: 'MANAGEMENT',
    basis: 'PERIOD',
    layout: {
      rows: PL_ROWS,
      columns: [
        { key: 'ACTUAL', label: 'Actual', kind: 'CURRENT' },
        { key: 'BUDGET', label: 'Budget', kind: 'BUDGET' },
        { key: 'VAR', label: 'Variance', kind: 'VARIANCE', base: 'ACTUAL', against: 'BUDGET' },
        {
          key: 'VAR_PCT',
          label: 'Variance %',
          kind: 'VARIANCE_PCT',
          base: 'ACTUAL',
          against: 'BUDGET',
        },
        { key: 'YTD', label: 'YTD actual', kind: 'YEAR_TO_DATE' },
      ],
    },
  },
  {
    code: 'BALANCE_SHEET_ASOF',
    name: 'Balance sheet - as of',
    description:
      'Financial position at the period end against the prior period end and the prior year.',
    category: 'FINANCIAL',
    basis: 'AS_OF',
    layout: {
      rows: [
        row('ASSETS', 'Assets', { accounts: { types: ['ASSET'] }, showAccounts: true, bold: true }),
        row('LIABILITIES', 'Liabilities', {
          accounts: { types: ['LIABILITY'] },
          showAccounts: true,
          bold: true,
        }),
        row('EQUITY', 'Equity', { accounts: { types: ['EQUITY'] }, showAccounts: true }),
        row('CURRENT_EARNINGS', 'Current earnings (income statement accounts)', {
          accounts: {
            types: ['REVENUE', 'OTHER_INCOME', 'COST_OF_SALES', 'EXPENSE', 'OTHER_EXPENSE'],
          },
          sign: 'CREDIT',
        }),
        row('TOTAL_EQUITY', 'Total equity', {
          kind: 'FORMULA',
          formula: 'EQUITY + CURRENT_EARNINGS',
          bold: true,
        }),
        row('LIABILITIES_AND_EQUITY', 'Liabilities and equity', {
          kind: 'FORMULA',
          formula: 'LIABILITIES + TOTAL_EQUITY',
          bold: true,
        }),
        row('CHECK', 'Assets - liabilities and equity (must be zero)', {
          kind: 'FORMULA',
          formula: 'ASSETS - LIABILITIES_AND_EQUITY',
        }),
      ],
      columns: [
        { key: 'CURRENT', label: 'As of period end', kind: 'CURRENT' },
        { key: 'PRIOR', label: 'Prior period end', kind: 'PRIOR_PERIOD' },
        { key: 'PRIOR_YEAR', label: 'Prior year', kind: 'PRIOR_YEAR' },
        { key: 'MOVEMENT', label: 'Movement', kind: 'VARIANCE', base: 'CURRENT', against: 'PRIOR' },
      ],
    },
  },
  {
    code: 'DEPARTMENT_EXPENSES',
    name: 'Operating expenses by department',
    description: 'Management view: operating expenses grouped by department against budget.',
    category: 'MANAGEMENT',
    basis: 'PERIOD',
    layout: {
      rows: [
        row('BY_DEPARTMENT', 'Operating expenses by department', {
          kind: 'DIMENSION_GROUP',
          dimensionType: 'DEPARTMENT',
          accounts: { types: ['EXPENSE'] },
          bold: true,
        }),
        row('TOTAL_EXPENSES', 'All operating expenses', { accounts: { types: ['EXPENSE'] } }),
        row('UNALLOCATED', 'Not allocated to a department', {
          kind: 'FORMULA',
          formula: 'TOTAL_EXPENSES - BY_DEPARTMENT',
        }),
      ],
      columns: [
        { key: 'ACTUAL', label: 'Actual', kind: 'CURRENT' },
        { key: 'BUDGET', label: 'Budget', kind: 'BUDGET' },
        { key: 'VAR', label: 'Variance', kind: 'VARIANCE', base: 'ACTUAL', against: 'BUDGET' },
        { key: 'YTD', label: 'YTD actual', kind: 'YEAR_TO_DATE' },
      ],
    },
  },
];
