import { Money } from '@accounting/money';
import type { PostingRuleLine } from '@/database/schema';
import type { PostingLine } from '../journals/posting.service';

/*
 * Pure resolution of a posting rule into ledger lines. The service supplies
 * the mapped accounts; the calling module supplies amounts and any context
 * accounts (e.g. the revenue account of a product category). No I/O here.
 */

export interface RuleContext {
  /** Amounts keyed by the rule's `amountKey` (NET, TAX, GROSS, ...), decimal strings. */
  amounts: Readonly<Record<string, string>>;
  /** Account ids keyed by the rule's `accountKey` for CONTEXT lines. */
  accounts?: Readonly<Record<string, string>>;
  /** Mapping key -> account id, resolved by the service for MAPPING lines. */
  mapped: ReadonlyMap<string, string>;
  description?: string | null;
  dimensions?: {
    branchId?: string | null;
    departmentId?: string | null;
    costCenterId?: string | null;
    projectId?: string | null;
  };
}

export class PostingRuleResolutionError extends Error {
  constructor(
    readonly reason: 'MISSING_AMOUNT' | 'MISSING_ACCOUNT' | 'UNBALANCED' | 'EMPTY',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Keys a rule needs from its caller - shown in the UI and checked by tests. */
export function ruleRequirements(lines: readonly PostingRuleLine[]): {
  amountKeys: string[];
  accountKeys: string[];
  mappingKeys: string[];
} {
  const amountKeys = new Set<string>();
  const accountKeys = new Set<string>();
  const mappingKeys = new Set<string>();
  for (const line of lines) {
    amountKeys.add(line.amountKey);
    if (line.accountSource === 'CONTEXT' && line.accountKey) accountKeys.add(line.accountKey);
    if (line.accountSource === 'MAPPING' && line.mappingKey) mappingKeys.add(line.mappingKey);
  }
  return {
    amountKeys: [...amountKeys],
    accountKeys: [...accountKeys],
    mappingKeys: [...mappingKeys],
  };
}

/**
 * Turns rule lines into posting lines. Lines whose amount is zero are dropped
 * (an invoice without tax simply has no tax line); a missing amount key is an
 * error, as is an unbalanced result - a rule can never produce a lopsided
 * entry that the engine would reject later with less context.
 */
export function resolvePostingRule(
  lines: readonly PostingRuleLine[],
  currency: string,
  ctx: RuleContext,
): PostingLine[] {
  const out: PostingLine[] = [];
  let debit = Money.zero(currency);
  let credit = Money.zero(currency);
  lines.forEach((line, index) => {
    const raw = ctx.amounts[line.amountKey];
    if (raw === undefined) {
      throw new PostingRuleResolutionError(
        'MISSING_AMOUNT',
        `Rule line ${index + 1} needs amount "${line.amountKey}".`,
        { line: index + 1, amountKey: line.amountKey },
      );
    }
    const amount = Money.parse(raw, currency);
    if (amount.isZero()) return;
    // A negative amount flips the side (credit notes reuse the invoice rule).
    const side = amount.isNegative() ? (line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT') : line.side;
    const magnitude = amount.abs();

    let accountId: string | undefined;
    switch (line.accountSource) {
      case 'ACCOUNT':
        accountId = line.accountId ?? undefined;
        break;
      case 'MAPPING':
        accountId = line.mappingKey ? ctx.mapped.get(line.mappingKey) : undefined;
        break;
      case 'CONTEXT':
        accountId = line.accountKey ? ctx.accounts?.[line.accountKey] : undefined;
        break;
    }
    if (!accountId) {
      throw new PostingRuleResolutionError(
        'MISSING_ACCOUNT',
        `Rule line ${index + 1} could not resolve its account (${line.accountSource} ${line.mappingKey ?? line.accountKey ?? ''}).`,
        { line: index + 1, accountSource: line.accountSource },
      );
    }
    if (side === 'DEBIT') debit = debit.add(magnitude);
    else credit = credit.add(magnitude);
    out.push({
      accountId,
      debit: side === 'DEBIT' ? magnitude.toString() : '0',
      credit: side === 'CREDIT' ? magnitude.toString() : '0',
      description: line.description ?? ctx.description ?? null,
      branchId: ctx.dimensions?.branchId ?? null,
      departmentId: ctx.dimensions?.departmentId ?? null,
      costCenterId: ctx.dimensions?.costCenterId ?? null,
      projectId: ctx.dimensions?.projectId ?? null,
    });
  });
  if (out.length === 0) {
    throw new PostingRuleResolutionError('EMPTY', 'Every amount is zero; nothing to post.');
  }
  if (!debit.equals(credit)) {
    throw new PostingRuleResolutionError(
      'UNBALANCED',
      `The rule resolves to an unbalanced entry: debits ${debit.toString()} vs credits ${credit.toString()}.`,
      { totalDebit: debit.toString(), totalCredit: credit.toString() },
    );
  }
  return out;
}
