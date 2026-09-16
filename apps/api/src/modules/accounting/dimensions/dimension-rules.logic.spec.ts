import { findDimensionRuleViolations, type DimensionRuleLike } from './dimension-rules.logic';

const rules: DimensionRuleLike[] = [
  {
    id: 'r1',
    name: 'Salaries need a department',
    scope: 'ACCOUNT',
    accountId: 'sal',
    accountType: null,
    codePrefix: null,
    dimensionType: 'DEPARTMENT',
    status: 'ACTIVE',
  },
  {
    id: 'r2',
    name: 'Every expense needs a cost center',
    scope: 'ACCOUNT_TYPE',
    accountId: null,
    accountType: 'EXPENSE',
    codePrefix: null,
    dimensionType: 'COST_CENTER',
    status: 'ACTIVE',
  },
  {
    id: 'r3',
    name: 'Project revenue needs a project',
    scope: 'CODE_PREFIX',
    accountId: null,
    accountType: null,
    codePrefix: '42',
    dimensionType: 'PROJECT',
    status: 'ACTIVE',
  },
  {
    id: 'r4',
    name: 'Inactive rule',
    scope: 'ACCOUNT_TYPE',
    accountId: null,
    accountType: 'ASSET',
    codePrefix: null,
    dimensionType: 'PROJECT',
    status: 'INACTIVE',
  },
];

const accounts = new Map([
  ['sal', { id: 'sal', code: '6100', type: 'EXPENSE' }],
  ['rev', { id: 'rev', code: '4200', type: 'REVENUE' }],
  ['cash', { id: 'cash', code: '1110', type: 'ASSET' }],
]);

describe('dimension rules', () => {
  it('reports every missing dimension per line and rule', () => {
    const violations = findDimensionRuleViolations(
      rules,
      [
        { accountId: 'sal' },
        { accountId: 'rev', projectId: 'p1' },
        { accountId: 'cash' },
      ],
      accounts,
    );
    expect(violations).toEqual([
      expect.objectContaining({ line: 1, ruleId: 'r1', dimensionType: 'DEPARTMENT' }),
      expect.objectContaining({ line: 1, ruleId: 'r2', dimensionType: 'COST_CENTER' }),
    ]);
  });

  it('passes when the required dimensions are present and ignores inactive rules', () => {
    const violations = findDimensionRuleViolations(
      rules,
      [
        { accountId: 'sal', departmentId: 'd', costCenterId: 'c' },
        { accountId: 'cash' },
      ],
      accounts,
    );
    expect(violations).toEqual([]);
  });
});
