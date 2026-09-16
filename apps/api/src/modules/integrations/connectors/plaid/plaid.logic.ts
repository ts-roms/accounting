import { createHash, createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import type { IntegrationErrorCode } from '@accounting/types';
import type { ExternalRecord } from '../../core/connector';

/**
 * Pure Plaid logic: amount normalisation, statement building from
 * `/transactions/sync` pages, cursor handling, error classification and
 * webhook JWT verification. No I/O - the connector supplies the data.
 */

// ------------------------------------------------------------------ types

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances?: {
    current?: number | null;
    available?: number | null;
    iso_currency_code?: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid convention: positive = money leaving the account. */
  amount: number;
  iso_currency_code?: string | null;
  /** Posted date (YYYY-MM-DD). */
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  payment_channel?: string;
  check_number?: string | null;
}

export interface PlaidSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string; account_id?: string }>;
  next_cursor: string;
  has_more: boolean;
  accounts?: PlaidAccount[];
  request_id?: string;
}

export interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
  request_id?: string;
}

/** Statement built from a page: what the bank-transactions mapping receives. */
export interface PlaidStatement {
  statement_id: string;
  account_id: string;
  statement_date: string;
  opening_balance: string;
  closing_balance: string;
  currency: string | null;
  transactions: Array<{
    transaction_id: string;
    date: string;
    description: string;
    reference: string;
    amount: string;
    channel: string | null;
  }>;
}

// ---------------------------------------------------------------- amounts

/** Plaid sends floats with two decimals; keep them as exact decimal strings. */
export function decimalFromNumber(n: number, scale = 2): string {
  if (!Number.isFinite(n)) throw new Error(`Not a finite amount: ${String(n)}`);
  const factor = 10 ** scale;
  const minor = Math.round(Math.abs(n) * factor);
  const whole = Math.floor(minor / factor);
  const frac = String(minor % factor).padStart(scale, '0');
  const sign = n < 0 && minor !== 0 ? '-' : '';
  return `${sign}${whole}.${frac}`;
}

/** Signed statement amount (positive = money in), the opposite of Plaid's sign. */
export function statementAmount(plaidAmount: number): string {
  return decimalFromNumber(-plaidAmount);
}

function addDecimal(a: string, b: string): string {
  // Two-decimal arithmetic on integers; balances and amounts are always 2 dp here.
  const toMinor = (v: string) => Math.round(Number(v) * 100);
  return decimalFromNumber((toMinor(a) + toMinor(b)) / 100);
}

// ----------------------------------------------------------------- cursor

/** Plaid's opaque sync cursor plus the running balance the next statement opens with. */
export interface PlaidCursor {
  cursor: string | null;
  balance: string;
}

export function decodeCursor(raw: string | null | undefined, openingBalance: string): PlaidCursor {
  if (!raw) return { cursor: null, balance: openingBalance };
  try {
    const parsed = JSON.parse(raw) as Partial<PlaidCursor>;
    return {
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : null,
      balance: typeof parsed.balance === 'string' ? parsed.balance : openingBalance,
    };
  } catch {
    return { cursor: null, balance: openingBalance };
  }
}

export function encodeCursor(c: PlaidCursor): string {
  return JSON.stringify(c);
}

// ------------------------------------------------------------- statements

export function pickAccount(
  accounts: PlaidAccount[],
  configured: string | undefined,
): { account: PlaidAccount | null; reason?: string } {
  if (configured) {
    const account = accounts.find((a) => a.account_id === configured) ?? null;
    return account
      ? { account }
      : { account: null, reason: `Account ${configured} is not part of this Plaid item.` };
  }
  const depository = accounts.filter((a) => a.type === 'depository');
  if (depository.length === 1) return { account: depository[0]! };
  if (!accounts.length) return { account: null, reason: 'The Plaid item exposes no accounts.' };
  return {
    account: null,
    reason: `The Plaid item has ${accounts.length} accounts; set config.plaidAccountId to choose one.`,
  };
}

/** Deterministic statement id: replaying the same page yields the same id, so re-imports dedupe. */
export function statementId(accountId: string, date: string, transactionIds: string[]): string {
  const digest = createHash('sha256')
    .update([...transactionIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `${accountId}:${date}:${digest}`;
}

/**
 * One page of `/transactions/sync` -> one statement per posting date for
 * the chosen account, with running balances continued from the cursor.
 * Pending transactions are skipped unless asked for: a statement is evidence
 * of what cleared, and Plaid re-delivers the posted version later.
 */
export function buildStatements(
  page: Pick<PlaidSyncResponse, 'added'>,
  options: { accountId: string; runningBalance: string; includePending?: boolean },
): { records: ExternalRecord[]; runningBalance: string; skippedPending: number } {
  const wanted = page.added.filter((t) => t.account_id === options.accountId);
  const posted = options.includePending ? wanted : wanted.filter((t) => !t.pending);
  const byDate = new Map<string, PlaidTransaction[]>();
  for (const t of posted) {
    const list = byDate.get(t.date) ?? [];
    list.push(t);
    byDate.set(t.date, list);
  }
  const dates = [...byDate.keys()].sort();
  let balance = options.runningBalance;
  const records: ExternalRecord[] = [];
  for (const date of dates) {
    const txs = byDate.get(date)!.sort((a, b) => a.transaction_id.localeCompare(b.transaction_id));
    const opening = balance;
    for (const t of txs) balance = addDecimal(balance, statementAmount(t.amount));
    const statement: PlaidStatement = {
      statement_id: statementId(
        options.accountId,
        date,
        txs.map((t) => t.transaction_id),
      ),
      account_id: options.accountId,
      statement_date: date,
      opening_balance: opening,
      closing_balance: balance,
      currency: txs[0]?.iso_currency_code ?? null,
      transactions: txs.map((t) => ({
        transaction_id: t.transaction_id,
        date: t.date,
        description: (t.merchant_name?.trim() || t.name?.trim() || 'Bank transaction').slice(
          0,
          300,
        ),
        reference: t.check_number ? `CHK ${t.check_number}` : t.transaction_id,
        amount: statementAmount(t.amount),
        channel: t.payment_channel ?? null,
      })),
    };
    records.push({
      externalId: statement.statement_id,
      data: statement as unknown as Record<string, unknown>,
      updatedAt: `${date}T00:00:00.000Z`,
    });
  }
  return { records, runningBalance: balance, skippedPending: wanted.length - posted.length };
}

// ----------------------------------------------------------------- errors

/** Plaid answers HTTP 400 for almost everything; the body says what really happened. */
export function classifyPlaidError(
  status: number,
  body: unknown,
): { code: IntegrationErrorCode; message: string; plaidCode: string | null } {
  const b = (body ?? {}) as PlaidErrorBody;
  const plaidCode = typeof b.error_code === 'string' ? b.error_code : null;
  const type = typeof b.error_type === 'string' ? b.error_type : null;
  const message =
    (typeof b.error_message === 'string' && b.error_message) ||
    (typeof b.display_message === 'string' && b.display_message) ||
    `Plaid responded with HTTP ${status}.`;
  const detail = plaidCode ? `${plaidCode}: ${message}` : message;
  if (
    plaidCode === 'ITEM_LOGIN_REQUIRED' ||
    plaidCode === 'INVALID_ACCESS_TOKEN' ||
    plaidCode === 'INVALID_API_KEYS' ||
    plaidCode === 'INVALID_PUBLIC_TOKEN' ||
    plaidCode === 'ACCESS_NOT_GRANTED'
  )
    return { code: 'AUTHENTICATION_ERROR', message: detail, plaidCode };
  if (plaidCode === 'RATE_LIMIT_EXCEEDED' || type === 'RATE_LIMIT_EXCEEDED' || status === 429)
    return { code: 'RATE_LIMITED', message: detail, plaidCode };
  if (plaidCode === 'PRODUCTS_NOT_SUPPORTED' || plaidCode === 'PRODUCT_NOT_READY')
    return { code: 'PROVIDER_ERROR', message: detail, plaidCode };
  if (type === 'API_ERROR' || type === 'INSTITUTION_ERROR' || status >= 500)
    return { code: 'PROVIDER_ERROR', message: detail, plaidCode };
  if (type === 'ITEM_ERROR') return { code: 'AUTHORIZATION_ERROR', message: detail, plaidCode };
  return { code: 'VALIDATION_ERROR', message: detail, plaidCode };
}

// --------------------------------------------------------------- webhooks

export interface PlaidJwtParts {
  header: { alg?: string; kid?: string; typ?: string };
  payload: { iat?: number; request_body_sha256?: string };
  signingInput: string;
  signature: Buffer;
}

function b64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Splits the `Plaid-Verification` JWT without trusting it yet. */
export function parsePlaidJwt(token: string | undefined): PlaidJwtParts | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64url(parts[0]!).toString('utf8')) as PlaidJwtParts['header'];
    const payload = JSON.parse(b64url(parts[1]!).toString('utf8')) as PlaidJwtParts['payload'];
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: b64url(parts[2]!),
    };
  } catch {
    return null;
  }
}

/** JOSE ES256 signatures are raw r||s (64 bytes); Node verifies DER unless told otherwise. */
export function verifyPlaidJwt(
  jwt: PlaidJwtParts,
  jwk: JsonWebKey,
  rawBody: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  if (jwt.header.alg !== 'ES256') return { ok: false, reason: 'UNSUPPORTED_ALG' };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (typeof jwt.payload.iat !== 'number' || Math.abs(now - jwt.payload.iat) > tolerance)
    return { ok: false, reason: 'STALE' };
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  if (jwt.payload.request_body_sha256 !== bodyHash) return { ok: false, reason: 'BODY_MISMATCH' };
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = createVerify('SHA256');
    verifier.update(jwt.signingInput);
    const valid = verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, jwt.signature);
    return valid ? { ok: true } : { ok: false, reason: 'MISMATCH' };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}

export function isPlaidWebhook(
  body: unknown,
): body is { webhook_type: string; webhook_code: string; item_id?: string } & Record<
  string,
  unknown
> {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { webhook_type?: unknown }).webhook_type === 'string' &&
    typeof (body as { webhook_code?: unknown }).webhook_code === 'string'
  );
}

/** Which webhook codes mean "there is something new to pull". */
export function wantsSync(webhookType: string, webhookCode: string): boolean {
  if (webhookType !== 'TRANSACTIONS') return false;
  return (
    webhookCode === 'SYNC_UPDATES_AVAILABLE' ||
    webhookCode === 'DEFAULT_UPDATE' ||
    webhookCode === 'INITIAL_UPDATE' ||
    webhookCode === 'HISTORICAL_UPDATE'
  );
}

export function environmentBaseUrl(environment: string): string {
  return environment === 'PRODUCTION'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';
}
