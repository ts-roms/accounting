import { DIMENSION_FIELDS, type DimensionType } from '@accounting/types';
import type { DimensionRefs } from '@accounting/validation';

/*
 * Pure matching of dimension rules against posting lines. Kept free of I/O so
 * the same function serves the posting engine, the integrity checker and the
 * unit tests.
 */

export interface RuleAccount {
  id: string;
  code: string;
  type: string;
}

export interface DimensionRuleLike {
  id: string;
  name: string;
  scope: 'ACCOUNT' | 'ACCOUNT_TYPE' | 'CODE_PREFIX';
  accountId: string | null;
  accountType: string | null;
  codePrefix: string | null;
  dimensionType: DimensionType;
  status: string;
}

export interface DimensionRuleViolation {
  line: number;
  ruleId: string;
  ruleName: string;
  accountCode: string;
  dimensionType: DimensionType;
}

/** Does a rule apply to the account? */
export function ruleApplies(rule: DimensionRuleLike, account: RuleAccount): boolean {
  if (rule.status !== 'ACTIVE') return false;
  switch (rule.scope) {
    case 'ACCOUNT':
      return rule.accountId === account.id;
    case 'ACCOUNT_TYPE':
      return rule.accountType === account.type;
    case 'CODE_PREFIX':
      return !!rule.codePrefix && account.code.startsWith(rule.codePrefix);
  }
}

/**
 * Every line whose account matches an active rule must carry the required
 * dimension. Returns one violation per (line, rule); empty = valid.
 */
export function findDimensionRuleViolations(
  rules: readonly DimensionRuleLike[],
  lines: readonly (DimensionRefs & { accountId: string })[],
  accountsById: ReadonlyMap<string, RuleAccount>,
): DimensionRuleViolation[] {
  if (rules.length === 0) return [];
  const violations: DimensionRuleViolation[] = [];
  lines.forEach((line, index) => {
    const account = accountsById.get(line.accountId);
    if (!account) return;
    for (const rule of rules) {
      if (!ruleApplies(rule, account)) continue;
      const field = DIMENSION_FIELDS[rule.dimensionType];
      if (!line[field]) {
        violations.push({
          line: index + 1,
          ruleId: rule.id,
          ruleName: rule.name,
          accountCode: account.code,
          dimensionType: rule.dimensionType,
        });
      }
    }
  });
  return violations;
}
