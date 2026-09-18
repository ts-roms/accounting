import { Money } from '@accounting/money';
import type { PostingLine } from './posting.service';

/*
 * Foreign-currency manual journals. Lines are entered in the transaction
 * currency; the ledger only ever holds base-currency amounts, so every line is
 * converted at one rate and the foreign amounts are kept beside them for the
 * audit trail. Pure - no I/O - so the rounding policy is unit-testable.
 */

export interface ForeignLineInput {
  accountId: string;
  debit: string;
  credit: string;
  description?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}

export class ForeignJournalUnbalancedError extends Error {
  constructor(
    readonly totalDebit: string,
    readonly totalCredit: string,
  ) {
    super(`Foreign-currency lines are out of balance: ${totalDebit} vs ${totalCredit}`);
  }
}

/**
 * Converts foreign lines to base at `rate` (1 foreign unit = rate base units).
 * The lines must balance in the foreign currency. Because each line rounds on
 * its own, base totals can differ by a few minor units; that residue is
 * absorbed by the last line of the side that is short, so the base entry
 * balances exactly and no extra "rounding" line is invented.
 */
export function convertForeignLines(
  lines: readonly ForeignLineInput[],
  transactionCurrency: string,
  baseCurrency: string,
  rate: string,
): PostingLine[] {
  let foreignDebit = Money.zero(transactionCurrency);
  let foreignCredit = Money.zero(transactionCurrency);
  const out: PostingLine[] = lines.map((line) => {
    const fd = Money.parse(line.debit, transactionCurrency);
    const fc = Money.parse(line.credit, transactionCurrency);
    foreignDebit = foreignDebit.add(fd);
    foreignCredit = foreignCredit.add(fc);
    return {
      accountId: line.accountId,
      description: line.description ?? null,
      branchId: line.branchId ?? null,
      departmentId: line.departmentId ?? null,
      costCenterId: line.costCenterId ?? null,
      projectId: line.projectId ?? null,
      debit: fd.convert(baseCurrency, rate).toString(),
      credit: fc.convert(baseCurrency, rate).toString(),
      foreignDebit: fd.toString(),
      foreignCredit: fc.toString(),
      foreignCurrency: transactionCurrency,
      exchangeRate: rate,
    };
  });
  if (!foreignDebit.equals(foreignCredit)) {
    throw new ForeignJournalUnbalancedError(foreignDebit.toString(), foreignCredit.toString());
  }

  const sum = (side: 'debit' | 'credit') =>
    out.reduce((acc, l) => acc.add(Money.of(l[side], baseCurrency)), Money.zero(baseCurrency));
  const diff = sum('debit').subtract(sum('credit'));
  if (diff.isZero()) return out;

  // Debits exceed credits -> add the residue to the last credit line, and vice versa.
  const short: 'debit' | 'credit' = diff.isPositive() ? 'credit' : 'debit';
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const line = out[i]!;
    if (Money.of(line[short], baseCurrency).isZero()) continue;
    line[short] = Money.of(line[short], baseCurrency).add(diff.abs()).toString();
    return out;
  }
  return out;
}
