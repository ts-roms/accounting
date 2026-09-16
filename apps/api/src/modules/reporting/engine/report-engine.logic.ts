import { Money } from '@accounting/money';
import type { ReportBasis, ReportColumnKind, ReportSign } from '@accounting/types';
import type { AccountSelector, ReportColumnInput, ReportRowInput } from '@accounting/validation';

/**
 * Pure reporting-engine arithmetic: date windows per column kind, account
 * selection, natural-sign presentation, formula evaluation and variances.
 * No I/O - the service feeds it ledger activity and budget figures.
 */

export interface DateWindow {
  /** Inclusive lower bound; undefined = all history (AS_OF basis). */
  from?: string;
  to: string;
}

export interface WindowInput {
  from: string;
  to: string;
  /** Start of the fiscal year containing `to` (YYYY-MM-DD). */
  fiscalYearStart: string;
}

const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (isoDate: string, n: number): string => {
  const d = day(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const addMonths = (isoDate: string, n: number): string => {
  const d = day(isoDate);
  const dayOfMonth = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, last));
  return iso(d);
};
const isMonthStart = (isoDate: string) => isoDate.endsWith('-01');
const isMonthEnd = (isoDate: string) => {
  const d = day(isoDate);
  return (
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() === d.getUTCDate()
  );
};
const monthsBetween = (from: string, to: string): number => {
  const a = day(from);
  const b = day(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
};

/**
 * The prior period of a window: whole months shift by the same number of
 * months (a month becomes the previous month, a quarter the previous quarter);
 * anything else shifts by its length in days.
 */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months = monthsBetween(from, to);
    const pf = addMonths(from, -months);
    const pt = addDays(from, -1);
    return { from: pf, to: pt };
  }
  const length = Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000) + 1;
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

export function priorYear(from: string, to: string): { from: string; to: string } {
  return { from: addMonths(from, -12), to: addMonths(to, -12) };
}

/** Resolves the ledger window a column reads, honouring the report basis. */
export function columnWindow(
  column: Pick<ReportColumnInput, 'kind' | 'from' | 'to'>,
  input: WindowInput,
  basis: ReportBasis,
): DateWindow | null {
  let range: { from: string; to: string };
  switch (column.kind) {
    case 'CURRENT':
    case 'BUDGET':
      range = { from: input.from, to: input.to };
      break;
    case 'PRIOR_PERIOD':
      range = priorPeriod(input.from, input.to);
      break;
    case 'YEAR_TO_DATE':
      range = { from: input.fiscalYearStart, to: input.to };
      break;
    case 'PRIOR_YEAR':
      range = priorYear(input.from, input.to);
      break;
    case 'CUSTOM_RANGE':
      range = { from: column.from!, to: column.to! };
      break;
    default:
      return null; // variance columns derive from other columns
  }
  return basis === 'AS_OF' ? { to: range.to } : range;
}

export interface AccountLike {
  id: string;
  code: string;
  type: string;
  subtype: string | null;
  normalBalance: 'DEBIT' | 'CREDIT';
  isHeader: boolean;
}

/** Accounts matched by a selector (union of criteria); header accounts never carry balances. */
export function selectAccounts<T extends AccountLike>(
  accounts: readonly T[],
  selector: AccountSelector,
  mappedIds: ReadonlyMap<string, string>,
): T[] {
  const ids = new Set(selector.accountIds ?? []);
  for (const key of selector.mappingKeys ?? []) {
    const id = mappedIds.get(key);
    if (id) ids.add(id);
  }
  const codes = new Set(selector.codes ?? []);
  const types = new Set<string>(selector.types ?? []);
  const subtypes = new Set<string>(selector.subtypes ?? []);
  return accounts.filter((a) => {
    if (a.isHeader) return false;
    if (ids.has(a.id) || codes.has(a.code)) return true;
    if (types.has(a.type) || (a.subtype && subtypes.has(a.subtype))) return true;
    if (selector.codeFrom && selector.codeTo)
      return a.code >= selector.codeFrom && a.code <= selector.codeTo;
    return false;
  });
}

/** Debit-minus-credit activity presented on the requested side. */
export function present(
  debit: Money,
  credit: Money,
  normalBalance: 'DEBIT' | 'CREDIT',
  sign: ReportSign,
): Money {
  const net = debit.subtract(credit);
  const side = sign === 'NATURAL' ? normalBalance : sign;
  return side === 'DEBIT' ? net : net.negate();
}

/** Evaluates `KEY [+|- KEY]...` over already computed row values. */
export function evaluateFormula(
  formula: string,
  values: ReadonlyMap<string, Money>,
  currency: string,
): Money {
  const tokens = formula.replace(/\s+/g, '').match(/[+-]|[A-Z][A-Z0-9_]*/g) ?? [];
  let total = Money.zero(currency);
  let op: '+' | '-' = '+';
  for (const t of tokens) {
    if (t === '+' || t === '-') op = t;
    else {
      const v = values.get(t) ?? Money.zero(currency);
      total = op === '+' ? total.add(v) : total.subtract(v);
    }
  }
  return total;
}

export function variance(base: Money, against: Money): Money {
  return base.subtract(against);
}

/** Percentage variance to 2 decimals, or null when the comparison figure is zero. */
export function variancePct(base: Money, against: Money): string | null {
  if (against.isZero()) return null;
  const pct =
    (Number(base.subtract(against).toString()) / Math.abs(Number(against.toString()))) * 100;
  return pct.toFixed(2);
}

/** Column kinds whose figure comes from the ledger / budget rather than other columns. */
export const SOURCE_COLUMN_KINDS: readonly ReportColumnKind[] = [
  'CURRENT',
  'PRIOR_PERIOD',
  'YEAR_TO_DATE',
  'PRIOR_YEAR',
  'BUDGET',
  'CUSTOM_RANGE',
];

/** Rows whose value is computed from other rows must come after them; returns keys in evaluation order. */
export function evaluationOrder(rows: readonly ReportRowInput[]): string[] {
  const keys = rows.map((r) => r.key);
  const formulas = new Map(rows.filter((r) => r.formula).map((r) => [r.key, r.formula!]));
  const done = new Set<string>(keys.filter((k) => !formulas.has(k)));
  const order = [...done];
  let progressed = true;
  while (progressed && done.size < keys.length) {
    progressed = false;
    for (const [key, formula] of formulas) {
      if (done.has(key)) continue;
      const refs = formula.replace(/\s+/g, '').split(/[-+]/);
      if (refs.every((r) => done.has(r))) {
        done.add(key);
        order.push(key);
        progressed = true;
      }
    }
  }
  // Circular references: append in declaration order so they evaluate to zero-ish rather than hang.
  for (const k of keys) if (!done.has(k)) order.push(k);
  return order;
}
