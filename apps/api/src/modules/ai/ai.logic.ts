/**
 * Pure, deterministic AI helpers: document extraction from text, account
 * classification by history, anomaly detectors, question parsing and a
 * simple forecaster. No I/O, no dates from the clock (callers pass `today`)
 * so every rule is unit-testable. A model provider may refine these results
 * but never replaces the checks here.
 */
import type { AiAnomalyType, AiDocumentKind, AiSeverity } from '@accounting/types';
import type { AiExtractedFieldsInput, AiExtractedLineInput } from '@accounting/validation';

// ----------------------------------------------------------------- extraction

export interface ExtractionResult {
  kind: AiDocumentKind;
  fields: AiExtractedFieldsInput;
  /** 0..1 - how many of the important fields were found. */
  confidence: number;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Parses the common date spellings found on invoices; returns YYYY-MM-DD or null. */
export function parseLooseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    // Prefer month/day; fall back to day/month when the first number cannot be a month.
    return a > 12 ? validDate(+m[3]!, b, a) : validDate(+m[3]!, a, b);
  }
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) return validDate(+m[3]!, monthIndex(m[1]!), +m[2]!);
  m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m) return validDate(+m[3]!, monthIndex(m[2]!), +m[1]!);
  return null;
}

function monthIndex(name: string): number {
  const n = name.toLowerCase();
  const i = MONTHS.findIndex((mo) => mo === n || mo.slice(0, 3) === n.slice(0, 3));
  return i + 1;
}

function validDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

const DATE_TOKEN = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})`;
const AMOUNT_TOKEN = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?)`;

/** "1,234.50" -> "1234.50" (4-dp string, never a float). */
export function normalizeAmount(raw: string): string {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return '0';
  const [whole, frac = ''] = cleaned.split('.');
  return `${whole}.${(frac + '0000').slice(0, 4)}`;
}

function findLabelled(
  text: string,
  labels: string[],
  valueToken: string,
  last = false,
  money = false,
) {
  // Money labels may be followed by a currency code or symbol ("Total PHP 1,200.00").
  const currency = money ? String.raw`(?:[A-Z]{3}\s*|[₱$€]\s*)?` : '';
  const re = new RegExp(
    String.raw`(?:^|\n|\s)(?:${labels.join('|')})\s*(?:no\.?|number|#)?\s*[:#\-]?\s*${currency}${valueToken}`,
    'gi',
  );
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;
  const hit = last ? matches[matches.length - 1]! : matches[0]!;
  return hit[1]!.trim();
}

/** Extracts the header fields and line items of a bill / receipt from its text. */
export function extractFromText(text: string): ExtractionResult {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lower = clean.toLowerCase();

  const vendorName =
    findLabelled(
      clean,
      ['vendor', 'supplier', 'from', 'billed by', 'sold by', 'merchant'],
      '([^\\n]{2,120})',
    ) ??
    lines.find(
      (l) => /[A-Za-z]{3,}/.test(l) && !/invoice|receipt|bill|statement|date|total/i.test(l),
    ) ??
    null;
  const vendorTaxId = findLabelled(
    clean,
    ['tin', 'vat reg(?:istration)?', 'tax id', 'tax no'],
    '([A-Z0-9][A-Z0-9\\-]{5,})',
  );
  const documentDateRaw = findLabelled(
    clean,
    ['invoice date', 'bill date', 'receipt date', 'date issued', 'dated', 'date'],
    DATE_TOKEN,
  );
  const dueDateRaw = findLabelled(clean, ['due date', 'payment due', 'due on', 'due'], DATE_TOKEN);
  const reference = findLabelled(
    clean,
    ['invoice', 'inv', 'bill', 'receipt', 'reference', 'ref', 'or', 'si'],
    '([A-Z]{0,4}[-/]?\\d[A-Z0-9\\-/]{2,})',
  );
  const total = findLabelled(
    clean,
    ['total amount due', 'amount due', 'grand total', 'total due', 'balance due', 'total'],
    AMOUNT_TOKEN,
    true,
    true,
  );
  const taxAmount = findLabelled(
    clean,
    ['vat(?: \\d{1,2}%)?', 'tax(?: \\d{1,2}%)?', 'gst', 'sales tax'],
    AMOUNT_TOKEN,
    true,
    true,
  );
  const subtotal = findLabelled(
    clean,
    ['subtotal', 'sub-total', 'net amount', 'amount before tax'],
    AMOUNT_TOKEN,
    true,
    true,
  );
  const currency = /\bUSD\b|\$/.test(clean)
    ? 'USD'
    : /\bEUR\b|€/.test(clean)
      ? 'EUR'
      : /\bPHP\b|₱|\bPhp\b/.test(clean)
        ? 'PHP'
        : null;

  const items: AiExtractedLineInput[] = [];
  const lineRe = new RegExp(
    String.raw`^(.{3,120}?)\s+(\d+(?:\.\d+)?)\s*(?:x|@|pcs|units?)?\s*${AMOUNT_TOKEN}\s+${AMOUNT_TOKEN}$`,
    'i',
  );
  for (const l of lines) {
    if (/^(sub-?total|total|vat|tax|amount due|balance|grand total)/i.test(l)) continue;
    const m = lineRe.exec(l);
    if (!m) continue;
    items.push({
      description: m[1]!.replace(/[:-]+$/, '').trim(),
      quantity: normalizeAmount(m[2]!),
      unitPrice: normalizeAmount(m[3]!),
    });
    if (items.length >= 50) break;
  }

  const kind: AiDocumentKind =
    /\b(invoice|bill to|statement of account|amount due|due date)\b/.test(lower)
      ? 'BILL'
      : /\b(receipt|official receipt|cash|paid by|card ending|change due)\b/.test(lower)
        ? 'EXPENSE_CLAIM'
        : 'UNKNOWN';

  const documentDate = documentDateRaw ? parseLooseDate(documentDateRaw) : null;
  const dueDate = dueDateRaw ? parseLooseDate(dueDateRaw) : null;
  const confidence =
    (vendorName ? 0.25 : 0) +
    (documentDate ? 0.2 : 0) +
    (total ? 0.35 : 0) +
    (reference ? 0.1 : 0) +
    (items.length ? 0.1 : 0);

  return {
    kind,
    confidence: Math.round(confidence * 100) / 100,
    fields: {
      vendorName: vendorName?.slice(0, 200) ?? undefined,
      vendorTaxId: vendorTaxId ?? undefined,
      documentDate,
      dueDate,
      reference: reference ?? undefined,
      currency,
      subtotal: subtotal ? normalizeAmount(subtotal) : null,
      taxAmount: taxAmount ? normalizeAmount(taxAmount) : null,
      total: total ? normalizeAmount(total) : null,
      lines: items,
    },
  };
}

// ------------------------------------------------------------- classification

export interface HistoryRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string;
  partyId: string | null;
  taxCodeId: string | null;
  uses: number;
}

export interface AccountSuggestion {
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCodeId: string | null;
  confidence: number;
  rationale: string;
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'of',
  'to',
  'a',
  'an',
  'in',
  'on',
  'with',
  'from',
  'fee',
  'fees',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

/**
 * Scores historical postings against the description: token overlap plus a
 * bonus when the same party used the account before. Deterministic and
 * explainable - the rationale names the strongest evidence.
 */
export function classifyByHistory(
  history: HistoryRow[],
  input: { description: string; partyId?: string | null },
  limit = 3,
): AccountSuggestion[] {
  const tokens = tokenize(input.description);
  const byAccount = new Map<
    string,
    {
      row: HistoryRow;
      score: number;
      partyUses: number;
      bestOverlap: number;
      taxVotes: Map<string, number>;
    }
  >();
  for (const row of history) {
    const rowTokens = tokenize(row.description);
    let overlap = 0;
    for (const t of tokens) if (rowTokens.has(t)) overlap++;
    const union = new Set([...tokens, ...rowTokens]).size || 1;
    const similarity = overlap / union;
    const partyMatch = input.partyId && row.partyId === input.partyId ? 1 : 0;
    const score = (similarity * 2 + partyMatch) * Math.log1p(row.uses);
    if (score <= 0) continue;
    const entry = byAccount.get(row.accountId) ?? {
      row,
      score: 0,
      partyUses: 0,
      bestOverlap: 0,
      taxVotes: new Map<string, number>(),
    };
    entry.score += score;
    entry.partyUses += partyMatch ? row.uses : 0;
    entry.bestOverlap = Math.max(entry.bestOverlap, similarity);
    if (row.taxCodeId)
      entry.taxVotes.set(row.taxCodeId, (entry.taxVotes.get(row.taxCodeId) ?? 0) + row.uses);
    byAccount.set(row.accountId, entry);
  }
  const ranked = [...byAccount.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const top = ranked[0]?.score ?? 0;
  return ranked.map((e) => {
    const taxCodeId = [...e.taxVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const reasons: string[] = [];
    if (e.partyUses) reasons.push(`used ${e.partyUses}x for this party`);
    if (e.bestOverlap > 0)
      reasons.push(`similar description (${Math.round(e.bestOverlap * 100)}% overlap)`);
    return {
      accountId: e.row.accountId,
      accountCode: e.row.accountCode,
      accountName: e.row.accountName,
      taxCodeId,
      confidence:
        Math.round(
          Math.min(
            1,
            (e.score / (top || 1)) * (e.bestOverlap > 0 ? (e.partyUses ? 0.95 : 0.75) : 0.35),
          ) * 100,
        ) / 100,
      rationale: reasons.join('; ') || 'historical usage',
    };
  });
}

// ------------------------------------------------------------------ anomalies

export interface AnomalyDocument {
  entityType: 'BILL' | 'INVOICE';
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  date: string;
  total: string;
  reference: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  postedBy: string | null;
}

export interface AnomalyJournal {
  id: string;
  number: string;
  entryDate: string;
  createdAt: string;
  postedAt: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  postedBy: string | null;
  /** True when a person keyed the entry (no source document). */
  manual: boolean;
  total: string;
  controlAccountsHit: string[];
}

export interface PartyStat {
  count: number;
  mean: number;
  stddev: number;
}

export interface AnomalyFlag {
  anomalyType: AiAnomalyType;
  severity: AiSeverity;
  fingerprint: string;
  entityType: string;
  entityId: string;
  entityNumber: string;
  entityDate: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  confidence: number;
}

const daysBetween = (a: string, b: string) =>
  Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Runs every detector over the window. Each flag carries a stable fingerprint. */
export function detectAnomalies(input: {
  documents: AnomalyDocument[];
  journals: AnomalyJournal[];
  partyStats: Map<string, PartyStat>;
  roundThreshold?: number;
}): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const roundThreshold = input.roundThreshold ?? 10_000;

  // Duplicate documents: same party + same total, same reference or within a week.
  // Each document is flagged once, against the earliest document it repeats.
  const docs = [...input.documents].sort((a, b) => a.date.localeCompare(b.date));
  for (let j = 1; j < docs.length; j++) {
    const b = docs[j]!;
    for (let i = 0; i < j; i++) {
      const a = docs[i]!;
      if (a.entityType !== b.entityType || a.partyId !== b.partyId || a.total !== b.total) continue;
      const sameRef = Boolean(
        a.reference && b.reference && a.reference.toLowerCase() === b.reference.toLowerCase(),
      );
      if (!sameRef && daysBetween(a.date, b.date) > 7) continue;
      flags.push({
        anomalyType: 'DUPLICATE_DOCUMENT',
        severity: 'HIGH',
        fingerprint: `DUPLICATE_DOCUMENT:${b.entityType}:${b.id}`,
        entityType: b.entityType,
        entityId: b.id,
        entityNumber: b.number,
        entityDate: b.date,
        title: `Possible duplicate of ${a.number}`,
        detail: `${b.number} and ${a.number} are both for ${a.partyName} with total ${a.total}${sameRef ? ` and reference ${a.reference}` : ` within ${Math.round(daysBetween(a.date, b.date))} day(s)`}.`,
        payload: { otherId: a.id, otherNumber: a.number, sameReference: sameRef },
        confidence: sameRef ? 0.95 : 0.7,
      });
      break;
    }
  }

  // Unusual amounts versus the party's history.
  for (const d of input.documents) {
    const stat = input.partyStats.get(d.partyId);
    const total = Number(d.total);
    if (!stat || stat.count < 5) continue;
    const z = stat.stddev > 0 ? (total - stat.mean) / stat.stddev : total > stat.mean * 5 ? 5 : 0;
    if (z < 3 && total < stat.mean * 5) continue;
    flags.push({
      anomalyType: 'UNUSUAL_AMOUNT',
      severity: z >= 5 ? 'HIGH' : 'MEDIUM',
      fingerprint: `UNUSUAL_AMOUNT:${d.entityType}:${d.id}`,
      entityType: d.entityType,
      entityId: d.id,
      entityNumber: d.number,
      entityDate: d.date,
      title: `Amount unusual for ${d.partyName}`,
      detail: `${d.number} is ${d.total}; the party's ${stat.count} previous documents average ${stat.mean.toFixed(2)} (σ ${stat.stddev.toFixed(2)}).`,
      payload: {
        mean: stat.mean,
        stddev: stat.stddev,
        count: stat.count,
        zScore: Math.round(z * 100) / 100,
      },
      confidence: Math.min(0.95, 0.5 + z / 10),
    });
  }

  // Round amounts on sizeable manual journals and bills.
  const isRound = (v: string) => {
    const n = Number(v);
    return n >= roundThreshold && n % 1000 === 0;
  };
  for (const d of input.documents) {
    if (d.entityType !== 'BILL' || !isRound(d.total)) continue;
    flags.push(roundFlag(d.entityType, d.id, d.number, d.date, d.total));
  }
  for (const j of input.journals) {
    if (j.manual && isRound(j.total))
      flags.push(roundFlag('JOURNAL_ENTRY', j.id, j.number, j.entryDate, j.total));
  }

  for (const j of input.journals) {
    if (j.postedAt) {
      const day = new Date(j.postedAt).getUTCDay();
      if (day === 0 || day === 6)
        flags.push({
          anomalyType: 'WEEKEND_POSTING',
          severity: 'LOW',
          fingerprint: `WEEKEND_POSTING:JOURNAL_ENTRY:${j.id}`,
          entityType: 'JOURNAL_ENTRY',
          entityId: j.id,
          entityNumber: j.number,
          entityDate: j.entryDate,
          title: 'Posted on a weekend',
          detail: `${j.number} was posted on ${j.postedAt.slice(0, 10)} (${day === 0 ? 'Sunday' : 'Saturday'}).`,
          payload: { postedAt: j.postedAt },
          confidence: 0.6,
        });
    }
    const lag = (Date.parse(j.createdAt) - Date.parse(j.entryDate)) / 86_400_000;
    if (j.manual && lag > 30)
      flags.push({
        anomalyType: 'BACKDATED_ENTRY',
        severity: lag > 90 ? 'HIGH' : 'MEDIUM',
        fingerprint: `BACKDATED_ENTRY:JOURNAL_ENTRY:${j.id}`,
        entityType: 'JOURNAL_ENTRY',
        entityId: j.id,
        entityNumber: j.number,
        entityDate: j.entryDate,
        title: 'Entry dated well before it was keyed',
        detail: `${j.number} is dated ${j.entryDate} but was created ${Math.round(lag)} days later.`,
        payload: { lagDays: Math.round(lag) },
        confidence: 0.7,
      });
    if (j.manual && j.controlAccountsHit.length)
      flags.push({
        anomalyType: 'MANUAL_CONTROL_POSTING',
        severity: 'HIGH',
        fingerprint: `MANUAL_CONTROL_POSTING:JOURNAL_ENTRY:${j.id}`,
        entityType: 'JOURNAL_ENTRY',
        entityId: j.id,
        entityNumber: j.number,
        entityDate: j.entryDate,
        title: 'Manual journal on a control account',
        detail: `${j.number} posts directly to ${j.controlAccountsHit.join(', ')}; subledger control accounts should only move through their documents.`,
        payload: { accounts: j.controlAccountsHit },
        confidence: 0.9,
      });
    const sameCreatorApprover = j.createdBy && j.approvedBy && j.createdBy === j.approvedBy;
    const sameApproverPoster = j.approvedBy && j.postedBy && j.approvedBy === j.postedBy;
    if (sameCreatorApprover || sameApproverPoster)
      flags.push(
        samePersonFlag(
          'JOURNAL_ENTRY',
          j.id,
          j.number,
          j.entryDate,
          Boolean(sameCreatorApprover),
          Boolean(sameApproverPoster),
        ),
      );
  }
  for (const d of input.documents) {
    const sameCreatorApprover = d.createdBy && d.approvedBy && d.createdBy === d.approvedBy;
    const sameApproverPoster = d.approvedBy && d.postedBy && d.approvedBy === d.postedBy;
    if (sameCreatorApprover || sameApproverPoster)
      flags.push(
        samePersonFlag(
          d.entityType,
          d.id,
          d.number,
          d.date,
          Boolean(sameCreatorApprover),
          Boolean(sameApproverPoster),
        ),
      );
  }
  return flags;
}

function roundFlag(
  entityType: string,
  id: string,
  number: string,
  date: string,
  total: string,
): AnomalyFlag {
  return {
    anomalyType: 'ROUND_AMOUNT',
    severity: 'LOW',
    fingerprint: `ROUND_AMOUNT:${entityType}:${id}`,
    entityType,
    entityId: id,
    entityNumber: number,
    entityDate: date,
    title: 'Large round amount',
    detail: `${number} is exactly ${total}; round figures on sizeable entries are worth a second look.`,
    payload: { total },
    confidence: 0.4,
  };
}

function samePersonFlag(
  entityType: string,
  id: string,
  number: string,
  date: string,
  creatorApprover: boolean,
  approverPoster: boolean,
): AnomalyFlag {
  const what = [
    creatorApprover ? 'created and approved' : null,
    approverPoster ? 'approved and posted' : null,
  ]
    .filter(Boolean)
    .join(' and ');
  return {
    anomalyType: 'SAME_PERSON_LIFECYCLE',
    severity: 'MEDIUM',
    fingerprint: `SAME_PERSON_LIFECYCLE:${entityType}:${id}`,
    entityType,
    entityId: id,
    entityNumber: number,
    entityDate: date,
    title: 'One person handled several steps',
    detail: `${number} was ${what} by the same user.`,
    payload: { creatorApprover, approverPoster },
    confidence: 0.8,
  };
}

/** Mean / population standard deviation of a list of decimal strings. */
export function stats(values: string[]): PartyStat {
  const nums = values.map(Number);
  const count = nums.length;
  if (!count) return { count: 0, mean: 0, stddev: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / count;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / count;
  return { count, mean, stddev: Math.sqrt(variance) };
}

// ------------------------------------------------------------------- forecast

export interface SeriesPoint {
  period: string;
  value: string;
}

export interface ForecastPoint extends SeriesPoint {
  low: string;
  high: string;
}

export interface ForecastResult {
  method: string;
  history: SeriesPoint[];
  forecast: ForecastPoint[];
  slopePerMonth: string;
  r2: number;
}

const to4 = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : '0.0000');

/** "2026-03" + 1 -> "2026-04" */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/**
 * Least-squares trend with an additive seasonal index when two full years are
 * available; the band is one residual standard deviation. Simple on purpose -
 * finance teams want an explainable baseline, not a black box.
 */
export function forecastSeries(history: SeriesPoint[], horizon: number): ForecastResult {
  const n = history.length;
  const ys = history.map((p) => Number(p.value));
  if (n === 0) return { method: 'none', history, forecast: [], slopePerMonth: '0.0000', r2: 0 };
  const xs = ys.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
    sxx += (xs[i]! - meanX) ** 2;
    sst += (ys[i]! - meanY) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const seasonal = n >= 24 ? seasonalIndex(ys, slope, intercept) : null;
  const fitted = xs.map((x, i) => intercept + slope * x + (seasonal ? seasonal[i % 12]! : 0));
  const residuals = ys.map((y, i) => y - fitted[i]!);
  const sse = residuals.reduce((a, r) => a + r * r, 0);
  const sd = Math.sqrt(sse / Math.max(1, n - 2));
  const r2 = sst ? Math.max(0, 1 - sse / sst) : 0;
  const last = history[n - 1]!.period;
  const forecast: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const x = n - 1 + h;
    const value = intercept + slope * x + (seasonal ? seasonal[x % 12]! : 0);
    forecast.push({
      period: addMonths(last, h),
      value: to4(value),
      low: to4(value - sd),
      high: to4(value + sd),
    });
  }
  return {
    method: seasonal ? 'linear trend + seasonal index' : 'linear trend',
    history,
    forecast,
    slopePerMonth: to4(slope),
    r2: Math.round(r2 * 1000) / 1000,
  };
}

function seasonalIndex(ys: number[], slope: number, intercept: number): number[] {
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  ys.forEach((y, i) => {
    sums[i % 12] = sums[i % 12]! + (y - (intercept + slope * i));
    counts[i % 12] = counts[i % 12]! + 1;
  });
  return sums.map((s, i) => (counts[i] ? s / counts[i]! : 0));
}

// -------------------------------------------------------------- question parse

export type QuestionIntent =
  | 'REVENUE'
  | 'EXPENSES'
  | 'COST_OF_SALES'
  | 'GROSS_PROFIT'
  | 'NET_INCOME'
  | 'CASH'
  | 'AR_OUTSTANDING'
  | 'AR_OVERDUE'
  | 'AP_OUTSTANDING'
  | 'AP_OVERDUE'
  | 'TOP_CUSTOMERS'
  | 'TOP_VENDORS'
  | 'TOP_EXPENSES'
  | 'TRIAL_BALANCE'
  | 'ANOMALIES'
  | 'FORECAST'
  | 'HELP'
  | 'UNKNOWN';

export interface ParsedQuestion {
  intent: QuestionIntent;
  from: string;
  to: string;
  periodLabel: string;
  /** Balances are "as of" the end of the window. */
  pointInTime: boolean;
}

const monthEnd = (y: number, m: number) =>
  `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

/** Resolves period phrases ("last month", "Q2", "March 2026", "last 3 months") against `today`. */
export function parsePeriod(
  question: string,
  today: string,
): { from: string; to: string; label: string } {
  const q = question.toLowerCase();
  const [ty, tm] = today.split('-').map(Number) as [number, number, number];
  const thisMonth = { from: `${ty}-${pad(tm)}-01`, to: monthEnd(ty, tm), label: 'this month' };
  let m: RegExpExecArray | null;
  if (/\btoday\b/.test(q)) return { from: today, to: today, label: 'today' };
  if (/\blast month\b|\bprevious month\b/.test(q)) {
    const y = tm === 1 ? ty - 1 : ty;
    const mo = tm === 1 ? 12 : tm - 1;
    return { from: `${y}-${pad(mo)}-01`, to: monthEnd(y, mo), label: 'last month' };
  }
  if ((m = /\blast (\d{1,2}) months?\b/.exec(q))) {
    const k = Number(m[1]);
    const start = addMonths(`${ty}-${pad(tm)}`, -(k - 1));
    return { from: `${start}-01`, to: monthEnd(ty, tm), label: `the last ${k} months` };
  }
  if (/\blast year\b|\bprevious year\b/.test(q))
    return { from: `${ty - 1}-01-01`, to: `${ty - 1}-12-31`, label: `${ty - 1}` };
  if (/\bthis year\b|\bytd\b|\byear to date\b|\bso far this year\b/.test(q))
    return { from: `${ty}-01-01`, to: monthEnd(ty, tm), label: `${ty} year to date` };
  if (
    (m = /\b(?:q([1-4])|(first|second|third|fourth) quarter)\b(?:\s+(?:of\s+)?(\d{4}))?/.exec(q))
  ) {
    const qn = m[1] ? Number(m[1]) : ['first', 'second', 'third', 'fourth'].indexOf(m[2]!) + 1;
    const y = m[3] ? Number(m[3]) : ty;
    return { from: `${y}-${pad(qn * 3 - 2)}-01`, to: monthEnd(y, qn * 3), label: `Q${qn} ${y}` };
  }
  if (/\bthis quarter\b/.test(q)) {
    const qn = Math.ceil(tm / 3);
    return { from: `${ty}-${pad(qn * 3 - 2)}-01`, to: monthEnd(ty, qn * 3), label: `Q${qn} ${ty}` };
  }
  if (/\blast quarter\b/.test(q)) {
    let qn = Math.ceil(tm / 3) - 1;
    let y = ty;
    if (qn === 0) {
      qn = 4;
      y -= 1;
    }
    return { from: `${y}-${pad(qn * 3 - 2)}-01`, to: monthEnd(y, qn * 3), label: `Q${qn} ${y}` };
  }
  const monthRe = new RegExp(
    String.raw`\b(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})\b\.?(?:\s+(\d{4}))?`,
  );
  if ((m = monthRe.exec(q))) {
    const mo = monthIndex(m[1]!);
    const y = m[2] ? Number(m[2]) : ty;
    return {
      from: `${y}-${pad(mo)}-01`,
      to: monthEnd(y, mo),
      label: `${MONTHS[mo - 1]![0]!.toUpperCase()}${MONTHS[mo - 1]!.slice(1)} ${y}`,
    };
  }
  if ((m = /\b(20\d{2})\b/.exec(q)))
    return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31`, label: m[1]! };
  return thisMonth;
}

export function parseQuestion(question: string, today: string): ParsedQuestion {
  const q = question.toLowerCase();
  const period = parsePeriod(question, today);
  const has = (...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(q));
  let intent: QuestionIntent = 'UNKNOWN';
  if (has('help', 'what can you do', 'capabilities')) intent = 'HELP';
  else if (has('forecast', 'projection', 'predict', 'expect', 'next month', 'next quarter'))
    intent = 'FORECAST';
  else if (has('anomal', 'anomalies', 'anomaly', 'suspicious', 'flags', 'flagged', 'unusual'))
    intent = 'ANOMALIES';
  else if (
    has('overdue', 'past due', 'late') &&
    has('payable', 'payables', 'vendor', 'vendors', 'bills', 'owe', 'ap')
  )
    intent = 'AP_OVERDUE';
  else if (has('overdue', 'past due', 'late')) intent = 'AR_OVERDUE';
  else if (
    has('top', 'biggest', 'largest', 'highest', 'most') &&
    has('customer', 'customers', 'client', 'clients')
  )
    intent = 'TOP_CUSTOMERS';
  else if (
    has('top', 'biggest', 'largest', 'highest', 'most') &&
    has('vendor', 'vendors', 'supplier', 'suppliers')
  )
    intent = 'TOP_VENDORS';
  else if (
    has('top', 'biggest', 'largest', 'highest', 'most') &&
    has('expense', 'expenses', 'spend', 'spending', 'cost', 'costs')
  )
    intent = 'TOP_EXPENSES';
  else if (
    has(
      'receivable',
      'receivables',
      'owed to us',
      'owe us',
      'ar',
      'collect',
      'outstanding invoices',
    )
  )
    intent = 'AR_OUTSTANDING';
  else if (has('payable', 'payables', 'we owe', 'ap', 'unpaid bills', 'outstanding bills'))
    intent = 'AP_OUTSTANDING';
  else if (has('cash', 'bank', 'liquidity')) intent = 'CASH';
  else if (has('gross profit', 'gross margin')) intent = 'GROSS_PROFIT';
  else if (has('net income', 'profit', 'loss', 'bottom line', 'profitable', 'earnings'))
    intent = 'NET_INCOME';
  else if (has('cost of sales', 'cogs', 'cost of goods')) intent = 'COST_OF_SALES';
  else if (has('revenue', 'sales', 'income', 'turnover')) intent = 'REVENUE';
  else if (has('expense', 'expenses', 'spend', 'spending', 'spent', 'costs', 'opex'))
    intent = 'EXPENSES';
  else if (has('trial balance', 'balanced', 'books balance')) intent = 'TRIAL_BALANCE';
  const pointInTime = [
    'CASH',
    'AR_OUTSTANDING',
    'AR_OVERDUE',
    'AP_OUTSTANDING',
    'AP_OVERDUE',
    'TOP_CUSTOMERS',
    'TOP_VENDORS',
  ].includes(intent);
  return { intent, from: period.from, to: period.to, periodLabel: period.label, pointInTime };
}
