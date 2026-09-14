/**
 * Pure helpers for the Stripe connector: amount conversion (Stripe amounts are
 * integers in the smallest currency unit), cursor encoding for incremental
 * list sync, and normalisation of Stripe objects into the records the mapping
 * engine and importers consume. No I/O.
 */

/** Currencies Stripe treats as zero-decimal (amount is already a whole unit). */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
/** Currencies Stripe sends with three decimals. */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BHD',
  'JOD',
  'KWD',
  'OMR',
  'TND',
]);

export function minorUnitScale(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3;
  return 2;
}

/** 2400 (usd) -> "24.00"; 500 (jpy) -> "500"; -150 -> "-1.50". Always a decimal string, never a float. */
export function minorToDecimal(amount: number | string, currency: string): string {
  const raw = typeof amount === 'number' ? amount.toString() : amount.trim();
  if (!/^-?\d+$/.test(raw)) throw new Error(`Stripe amount must be an integer, received "${raw}"`);
  const scale = minorUnitScale(currency);
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`;
}

export function unixToIso(seconds: number | null | undefined): string | undefined {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : undefined;
}

/** `sk_live_` / `rk_live_` keys talk to live mode; anything else is test mode. */
export function keyMode(secretKey: string | undefined): 'live' | 'test' | 'unknown' {
  if (!secretKey) return 'unknown';
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  return 'unknown';
}

// ------------------------------------------------------------------ cursors

/**
 * Stripe lists are newest-first and page with `starting_after=<last id>`.
 * Within one run the `createdGt` bound stays fixed while pages advance; when
 * the last page is reached the next incremental run starts after the newest
 * `created` seen. Stored as JSON so it survives a resume.
 */
export interface StripeCursor {
  createdGt?: number;
  startingAfter?: string;
  maxCreated?: number;
}

export function decodeCursor(cursor: string | null | undefined): StripeCursor {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as StripeCursor;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function encodeCursor(cursor: StripeCursor): string | null {
  const clean: StripeCursor = {};
  if (cursor.createdGt !== undefined) clean.createdGt = cursor.createdGt;
  if (cursor.startingAfter !== undefined) clean.startingAfter = cursor.startingAfter;
  if (cursor.maxCreated !== undefined) clean.maxCreated = cursor.maxCreated;
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/** Query string for a list call given the cursor state. */
export function listParams(
  cursor: StripeCursor,
  limit: number,
  mode: 'INCREMENTAL' | 'FULL',
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
  if (mode === 'INCREMENTAL' && cursor.createdGt !== undefined)
    params.set('created[gt]', String(cursor.createdGt));
  if (cursor.startingAfter) params.set('starting_after', cursor.startingAfter);
  return params;
}

/** Cursor to persist after a page, and the one to resume the next run from. */
export function advanceCursor(
  cursor: StripeCursor,
  page: { lastId: string | null; hasMore: boolean; maxCreated: number | undefined },
): { next: StripeCursor; hasMore: boolean } {
  const maxCreated = Math.max(cursor.maxCreated ?? 0, page.maxCreated ?? 0) || undefined;
  if (page.hasMore && page.lastId)
    return {
      next: { createdGt: cursor.createdGt, startingAfter: page.lastId, maxCreated },
      hasMore: true,
    };
  // Run complete: the next incremental run only fetches objects created after the newest one seen.
  const createdGt = maxCreated ?? cursor.createdGt;
  return { next: createdGt !== undefined ? { createdGt } : {}, hasMore: false };
}

// ------------------------------------------------------- normalisation

export interface StripeAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface StripeCustomer {
  id: string;
  object?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: StripeAddress | null;
  currency?: string | null;
  created?: number;
  metadata?: Record<string, string>;
  deleted?: boolean;
}

export interface StripeCharge {
  id: string;
  object?: string;
  amount: number;
  amount_refunded?: number;
  currency: string;
  customer?: string | { id: string } | null;
  status?: string;
  paid?: boolean;
  refunded?: boolean;
  created?: number;
  description?: string | null;
  receipt_email?: string | null;
  billing_details?: { email?: string | null; name?: string | null } | null;
  metadata?: Record<string, string>;
  payment_intent?: string | { id: string } | null;
}

export interface StripePaymentIntent {
  id: string;
  object?: string;
  amount: number;
  amount_received?: number;
  currency: string;
  customer?: string | { id: string } | null;
  status?: string;
  created?: number;
  description?: string | null;
  metadata?: Record<string, string>;
  latest_charge?: string | { id: string } | null;
}

export interface StripeCheckoutSession {
  id: string;
  object?: string;
  amount_total?: number | null;
  currency?: string | null;
  customer?: string | { id: string } | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  payment_status?: string;
  status?: string | null;
  created?: number;
  metadata?: Record<string, string>;
  payment_intent?: string | { id: string } | null;
  client_reference_id?: string | null;
}

const refId = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === 'string' ? v : v && typeof v === 'object' ? v.id : null;

/** Record shape the connector's default customer mapping expects. */
export function normalizeCustomer(c: StripeCustomer): Record<string, unknown> {
  return {
    id: c.id,
    display_name: c.name?.trim() || c.email?.trim() || c.id,
    name: c.name ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    address: c.address ?? null,
    currency: c.currency ? c.currency.toUpperCase() : null,
    created_at: unixToIso(c.created),
    metadata: c.metadata ?? {},
    deleted: Boolean(c.deleted),
  };
}

/** Only fully settled, unrefunded money becomes a receipt. */
export function isSettledCharge(c: StripeCharge): boolean {
  return (
    c.status === 'succeeded' && c.paid !== false && !c.refunded && (c.amount_refunded ?? 0) === 0
  );
}

export function normalizeCharge(
  c: StripeCharge,
  guestCustomerCode?: string,
): Record<string, unknown> {
  const customer = refId(c.customer);
  return {
    id: c.id,
    kind: 'charge',
    amount: minorToDecimal(c.amount - (c.amount_refunded ?? 0), c.currency),
    currency: c.currency.toUpperCase(),
    customer,
    customer_code: customer ? null : (guestCustomerCode ?? null),
    payer_email: c.billing_details?.email ?? c.receipt_email ?? null,
    status: isSettledCharge(c) ? 'SUCCEEDED' : (c.status ?? 'unknown').toUpperCase(),
    created_at: unixToIso(c.created),
    description: c.description ?? null,
    metadata: c.metadata ?? {},
    payment_intent: refId(c.payment_intent),
  };
}

export function normalizePaymentIntent(
  p: StripePaymentIntent,
  guestCustomerCode?: string,
): Record<string, unknown> {
  const customer = refId(p.customer);
  return {
    id: p.id,
    kind: 'payment_intent',
    amount: minorToDecimal(p.amount_received ?? p.amount, p.currency),
    currency: p.currency.toUpperCase(),
    customer,
    customer_code: customer ? null : (guestCustomerCode ?? null),
    payer_email: null,
    status: p.status === 'succeeded' ? 'SUCCEEDED' : (p.status ?? 'unknown').toUpperCase(),
    created_at: unixToIso(p.created),
    description: p.description ?? null,
    metadata: p.metadata ?? {},
    payment_intent: p.id,
    latest_charge: refId(p.latest_charge),
  };
}

export function normalizeCheckoutSession(
  s: StripeCheckoutSession,
  guestCustomerCode?: string,
): Record<string, unknown> {
  const customer = refId(s.customer);
  return {
    id: s.id,
    kind: 'checkout_session',
    amount:
      s.amount_total !== null && s.amount_total !== undefined && s.currency
        ? minorToDecimal(s.amount_total, s.currency)
        : null,
    currency: s.currency ? s.currency.toUpperCase() : null,
    customer,
    customer_code: customer ? null : (guestCustomerCode ?? null),
    payer_email: s.customer_details?.email ?? null,
    status:
      s.payment_status === 'paid' ? 'SUCCEEDED' : (s.payment_status ?? 'unknown').toUpperCase(),
    created_at: unixToIso(s.created),
    description: null,
    metadata: {
      ...(s.metadata ?? {}),
      ...(s.client_reference_id ? { client_reference_id: s.client_reference_id } : {}),
    },
    payment_intent: refId(s.payment_intent),
  };
}

/** Stripe event envelope (`{ id, type, created, livemode, data: { object } }`). */
export interface StripeEvent {
  id: string;
  object?: 'event';
  type: string;
  created?: number;
  livemode?: boolean;
  data?: { object?: unknown };
}

export function isStripeEvent(body: unknown): body is StripeEvent {
  const b = body as StripeEvent | null;
  return Boolean(
    b &&
    typeof b === 'object' &&
    typeof b.id === 'string' &&
    b.id.startsWith('evt_') &&
    typeof b.type === 'string' &&
    b.data &&
    typeof b.data === 'object',
  );
}

/** Map a Stripe event type to the platform's normalised inbound type. */
export function normalizeEventType(type: string): string {
  switch (type) {
    case 'charge.succeeded':
    case 'payment_intent.succeeded':
    case 'checkout.session.completed':
      return 'payment.received';
    case 'customer.created':
    case 'customer.updated':
      return 'customer.updated';
    case 'invoice.paid':
      return 'invoice.paid';
    default:
      return type;
  }
}
