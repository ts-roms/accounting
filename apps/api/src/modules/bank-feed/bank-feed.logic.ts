import { Money } from '@accounting/money';
import type {
  BankFeedAction,
  BankRuleDirection,
  BankRuleMatchMode,
  BankSuggestionConfidence,
  BankSuggestionPayload,
  BankSuggestionSource,
} from '@accounting/types';

/*
 * Pure bank feed logic (Prompt #12): rule matching, document matching, the
 * description normalisation behind HISTORY suggestions, and the suggestion
 * builder. Amounts are signed on the feed (in +, out -). No database.
 */

export interface FeedLine {
  id: string;
  bankAccountId: string;
  lineDate: string;
  amount: string;
  description: string;
  reference: string | null;
}

export interface RuleDef {
  id: string;
  name: string;
  priority: number;
  bankAccountId: string | null;
  direction: BankRuleDirection;
  descriptionPattern: string | null;
  descriptionMode: BankRuleMatchMode;
  referencePattern: string | null;
  referenceMode: BankRuleMatchMode;
  amountMin: string | null;
  amountMax: string | null;
  action: BankFeedAction;
  transactionType: 'DEPOSIT' | 'WITHDRAWAL' | 'BANK_FEE' | 'INTEREST' | 'TRANSFER' | null;
  counterpartyAccountId: string | null;
  partyId: string | null;
  memo: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  autoApply: boolean;
}

/** An open receivable or payable the feed could settle. */
export interface OpenDocument {
  id: string;
  documentNumber: string;
  partyId: string;
  partyName: string;
  /** Absolute open balance in the bank account's currency. */
  openAmount: string;
  documentDate: string;
  reference: string | null;
}

/** How lines with this normalized description were explained before. */
export interface HistoryEntry {
  normalized: string;
  direction: 'IN' | 'OUT';
  occurrences: number;
  payload: BankSuggestionPayload;
  lastSeen: string;
}

export interface SuggestionDraft {
  source: BankSuggestionSource;
  action: BankFeedAction;
  ruleId: string | null;
  confidence: BankSuggestionConfidence;
  payload: BankSuggestionPayload;
  explanation: string;
  /** Apply without review (rule autoApply, or a HIGH document match when the settings allow it). */
  autoApply: boolean;
}

export function textMatches(
  text: string | null | undefined,
  pattern: string,
  mode: BankRuleMatchMode,
): boolean {
  const haystack = (text ?? '').toLowerCase();
  const needle = pattern.toLowerCase();
  switch (mode) {
    case 'CONTAINS':
      return haystack.includes(needle);
    case 'STARTS_WITH':
      return haystack.startsWith(needle);
    case 'REGEX':
      try {
        return new RegExp(pattern, 'i').test(text ?? '');
      } catch {
        return false;
      }
  }
}

export function directionOf(amount: string): 'IN' | 'OUT' {
  return Number(amount) >= 0 ? 'IN' : 'OUT';
}

/** Every condition on the rule must hold (bank account, direction, patterns, amount bounds). */
export function ruleMatches(rule: RuleDef, line: FeedLine, currency: string): boolean {
  if (rule.bankAccountId && rule.bankAccountId !== line.bankAccountId) return false;
  const dir = directionOf(line.amount);
  if (rule.direction !== 'ANY' && rule.direction !== dir) return false;
  if (
    rule.descriptionPattern &&
    !textMatches(line.description, rule.descriptionPattern, rule.descriptionMode)
  )
    return false;
  if (
    rule.referencePattern &&
    !textMatches(line.reference, rule.referencePattern, rule.referenceMode)
  )
    return false;
  const abs = Money.of(line.amount, currency).abs();
  if (rule.amountMin && abs.lessThan(Money.parse(rule.amountMin, currency))) return false;
  if (rule.amountMax && abs.greaterThan(Money.parse(rule.amountMax, currency))) return false;
  // A rule that posts money in cannot explain money out and vice versa.
  if (rule.action === 'POST_TRANSACTION' && rule.transactionType) {
    const inbound = rule.transactionType === 'DEPOSIT' || rule.transactionType === 'INTEREST';
    if (inbound !== (dir === 'IN')) return false;
  }
  if (rule.action === 'RECEIVE_CUSTOMER' && dir !== 'IN') return false;
  if (rule.action === 'PAY_VENDOR' && dir !== 'OUT') return false;
  return true;
}

/**
 * Description key for HISTORY: lower case, digits / dates / long codes and
 * punctuation removed, whitespace collapsed. "GCASH PAYMENT 2026-06-01 REF
 * 88213 ACME" and "GCASH PAYMENT 2026-07-01 REF 91002 ACME" share a key.
 */
export function normalizeDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d[\d\-/.:]*/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\b[a-z]{1,2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** History key: the first three significant words of the normalized description ("pos purchase eleven" for any 7-Eleven branch). */
export function historyKey(text: string): string {
  return normalizeDescription(text).split(' ').filter(Boolean).slice(0, 3).join(' ');
}

/** Document numbers cited in the line text (e.g. INV-2026-000012, BILL-2026-000003). */
export function citedDocuments(line: FeedLine, docs: readonly OpenDocument[]): OpenDocument[] {
  const text = `${line.description} ${line.reference ?? ''}`.toUpperCase();
  return docs.filter((d) => text.includes(d.documentNumber.toUpperCase()));
}

/** Documents whose open balance (alone) equals the line amount. */
export function amountMatches(
  line: FeedLine,
  docs: readonly OpenDocument[],
  currency: string,
): OpenDocument[] {
  const abs = Money.of(line.amount, currency).abs();
  return docs.filter((d) => Money.of(d.openAmount, currency).equals(abs));
}

function partyMentioned(line: FeedLine, partyName: string): boolean {
  const words = partyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  const text = `${line.description} ${line.reference ?? ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * Suggestions for one line, best first:
 * 1. the first matching rule by priority (HIGH when it auto-applies, else MEDIUM);
 * 2. open documents: cited numbers whose open balances sum to the amount
 *    (HIGH), a unique open balance equal to the amount (MEDIUM, HIGH when the
 *    party name is in the text);
 * 3. history: the same normalized description explained before (MEDIUM from
 *    `historyMinOccurrences`, else LOW).
 */
export function suggestForLine(
  line: FeedLine,
  ctx: {
    currency: string;
    rules: readonly RuleDef[];
    openInvoices: readonly OpenDocument[];
    openBills: readonly OpenDocument[];
    history: readonly HistoryEntry[];
    autoApplyRules: boolean;
    autoApplyDocumentMatches: boolean;
    historyMinOccurrences: number;
  },
): SuggestionDraft[] {
  const out: SuggestionDraft[] = [];
  const c = ctx.currency;
  const dir = directionOf(line.amount);
  const abs = Money.of(line.amount, c).abs();

  const rule = [...ctx.rules]
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .find((r) => ruleMatches(r, line, c));
  if (rule) {
    out.push({
      source: 'RULE',
      action: rule.action,
      ruleId: rule.id,
      confidence: rule.autoApply ? 'HIGH' : 'MEDIUM',
      payload: {
        action: rule.action,
        transactionType:
          rule.transactionType && rule.transactionType !== 'TRANSFER'
            ? rule.transactionType
            : undefined,
        counterpartyAccountId: rule.counterpartyAccountId,
        memo: rule.memo,
        departmentId: rule.departmentId,
        costCenterId: rule.costCenterId,
        projectId: rule.projectId,
        partyId: rule.partyId,
      },
      explanation: `Rule "${rule.name}" matched.`,
      autoApply: rule.autoApply && ctx.autoApplyRules,
    });
  }

  const docs = dir === 'IN' ? ctx.openInvoices : ctx.openBills;
  const action: BankFeedAction = dir === 'IN' ? 'RECEIVE_CUSTOMER' : 'PAY_VENDOR';
  const cited = citedDocuments(line, docs);
  const citedTotal = Money.sum(
    cited.map((d) => Money.of(d.openAmount, c)),
    c,
  );
  const sameParty = cited.length > 0 && cited.every((d) => d.partyId === cited[0]!.partyId);
  if (
    cited.length > 0 &&
    sameParty &&
    (citedTotal.equals(abs) || (cited.length === 1 && abs.lessThan(citedTotal)))
  ) {
    const partial = !citedTotal.equals(abs);
    out.push({
      source: 'DOCUMENT',
      action,
      ruleId: null,
      confidence: 'HIGH',
      payload: {
        action,
        partyId: cited[0]!.partyId,
        partyName: cited[0]!.partyName,
        allocations: cited.map((d) => ({
          documentId: d.id,
          documentNumber: d.documentNumber,
          amount: partial ? abs.toString() : d.openAmount,
        })),
      },
      explanation: partial
        ? `${cited[0]!.documentNumber} is cited; the amount settles it partially.`
        : `${cited.map((d) => d.documentNumber).join(', ')} cited in the line text.`,
      autoApply: ctx.autoApplyDocumentMatches && !partial,
    });
  } else {
    const byAmount = amountMatches(line, docs, c);
    const named = byAmount.filter((d) => partyMentioned(line, d.partyName));
    const chosen = named.length === 1 ? named[0]! : byAmount.length === 1 ? byAmount[0]! : null;
    if (chosen) {
      const strong = named.length === 1;
      out.push({
        source: 'DOCUMENT',
        action,
        ruleId: null,
        confidence: strong ? 'HIGH' : 'MEDIUM',
        payload: {
          action,
          partyId: chosen.partyId,
          partyName: chosen.partyName,
          allocations: [
            {
              documentId: chosen.id,
              documentNumber: chosen.documentNumber,
              amount: chosen.openAmount,
            },
          ],
        },
        explanation: strong
          ? `${chosen.documentNumber} (${chosen.partyName}) has this open balance and the party is named.`
          : `${chosen.documentNumber} (${chosen.partyName}) is the only open document with this balance.`,
        autoApply: strong && ctx.autoApplyDocumentMatches,
      });
    }
  }

  const key = historyKey(line.description);
  const hist = key
    ? ctx.history.find((h) => h.normalized === key && h.direction === dir)
    : undefined;
  if (
    hist &&
    !out.some(
      (s) =>
        s.action === hist.payload.action &&
        s.payload.counterpartyAccountId === hist.payload.counterpartyAccountId &&
        s.payload.partyId === hist.payload.partyId,
    )
  ) {
    out.push({
      source: 'HISTORY',
      action: hist.payload.action,
      ruleId: null,
      confidence: hist.occurrences >= ctx.historyMinOccurrences ? 'MEDIUM' : 'LOW',
      payload: { ...hist.payload, allocations: undefined },
      explanation: `${hist.occurrences} earlier line(s) like "${line.description}" were explained this way (last ${hist.lastSeen}).`,
      autoApply: false,
    });
  }
  return out;
}

/** The bank transaction type a signed feed amount implies when a rule / history leaves it open. */
export function defaultTransactionType(amount: string): 'DEPOSIT' | 'WITHDRAWAL' {
  return directionOf(amount) === 'IN' ? 'DEPOSIT' : 'WITHDRAWAL';
}
