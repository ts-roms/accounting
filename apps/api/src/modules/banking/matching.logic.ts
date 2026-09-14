import { Money } from '@accounting/money';
import type { StatementLineStatus } from '@accounting/types';
import { daysBetween } from '@/modules/subledger/subledger.logic';

/**
 * Bank statement matching - pure. Statement lines are signed (in +, out -);
 * ledger candidates are journal lines on the bank's GL account (debit = money
 * in, credit = money out) that are not yet matched.
 */

export interface StatementLineRef {
  id: string;
  lineDate: string;
  amount: string;
  reference: string | null;
  description: string;
}

export interface LedgerCandidate {
  journalLineId: string;
  entryDate: string;
  debit: string;
  credit: string;
  reference: string | null;
  description: string | null;
}

export interface MatchOutcome {
  statementLineId: string;
  status: StatementLineStatus;
  journalLineId: string | null;
  candidates: string[];
  note: string;
}

export function signedLedgerAmount(c: LedgerCandidate, currency: string): Money {
  return Money.of(c.debit, currency).subtract(Money.of(c.credit, currency));
}

/**
 * For every statement line: exactly one ledger line with the same signed
 * amount within the date tolerance -> MATCHED (a reference hit breaks ties);
 * several -> EXCEPTION with candidates; none -> UNMATCHED. A statement line
 * identical to an earlier one in the same batch (date, amount, reference) is a
 * DUPLICATE. Each ledger line is consumed at most once.
 */
export function matchStatementLines(
  lines: readonly StatementLineRef[],
  candidates: readonly LedgerCandidate[],
  currency: string,
  toleranceDays: number,
): MatchOutcome[] {
  const used = new Set<string>();
  const seenKeys = new Set<string>();
  const outcomes: MatchOutcome[] = [];
  for (const line of lines) {
    const key = `${line.lineDate}|${Money.of(line.amount, currency).toString()}|${(line.reference ?? '').trim().toLowerCase()}`;
    if (seenKeys.has(key)) {
      outcomes.push({
        statementLineId: line.id,
        status: 'DUPLICATE',
        journalLineId: null,
        candidates: [],
        note: 'Identical line appears earlier in the statement.',
      });
      continue;
    }
    seenKeys.add(key);
    const amount = Money.of(line.amount, currency);
    const hits = candidates.filter(
      (c) =>
        !used.has(c.journalLineId) &&
        signedLedgerAmount(c, currency).equals(amount) &&
        Math.abs(daysBetween(c.entryDate, line.lineDate)) <= toleranceDays,
    );
    if (hits.length === 0) {
      outcomes.push({
        statementLineId: line.id,
        status: 'UNMATCHED',
        journalLineId: null,
        candidates: [],
        note: 'No ledger line with this amount in the date window.',
      });
      continue;
    }
    const ref = (line.reference ?? '').trim().toLowerCase();
    const byRef = ref
      ? hits.filter(
          (c) =>
            (c.reference ?? '').toLowerCase().includes(ref) ||
            (c.description ?? '').toLowerCase().includes(ref) ||
            line.description.toLowerCase().includes((c.reference ?? '').toLowerCase()),
        )
      : [];
    const chosen = hits.length === 1 ? hits[0]! : byRef.length === 1 ? byRef[0]! : null;
    if (chosen) {
      used.add(chosen.journalLineId);
      outcomes.push({
        statementLineId: line.id,
        status: 'MATCHED',
        journalLineId: chosen.journalLineId,
        candidates: [chosen.journalLineId],
        note:
          hits.length === 1
            ? 'Single amount / date match.'
            : 'Reference match among several candidates.',
      });
    } else {
      outcomes.push({
        statementLineId: line.id,
        status: 'EXCEPTION',
        journalLineId: null,
        candidates: hits.map((c) => c.journalLineId),
        note: `${hits.length} ledger lines share this amount and date window - pick one.`,
      });
    }
  }
  return outcomes;
}

export interface ReconciliationFigures {
  statementBalance: Money;
  ledgerBalance: Money;
  /** Ledger debits (money in) not yet on a statement. */
  depositsInTransit: Money;
  /** Ledger credits (money out) not yet on a statement. */
  outstandingPayments: Money;
  /** Statement money in not yet in the ledger. */
  unrecordedCredits: Money;
  /** Statement money out not yet in the ledger. */
  unrecordedDebits: Money;
}

/**
 * (statement + deposits in transit - outstanding payments)
 *   - (ledger + unrecorded credits - unrecorded debits)
 * Zero when every item is explained.
 */
export function reconciliationDifference(f: ReconciliationFigures): Money {
  const adjustedBank = f.statementBalance.add(f.depositsInTransit).subtract(f.outstandingPayments);
  const adjustedBook = f.ledgerBalance.add(f.unrecordedCredits).subtract(f.unrecordedDebits);
  return adjustedBank.subtract(adjustedBook);
}
