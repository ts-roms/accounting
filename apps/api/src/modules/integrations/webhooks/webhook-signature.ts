import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing (both directions). Scheme: `t=<unix seconds>,v1=<hex>` where
 * `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Including the timestamp in the
 * signed payload and rejecting stale timestamps defeats replay of a captured
 * request; the event id uniqueness (integration_events) is the second net.
 */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function signPayload(secret: string, rawBody: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export interface SignatureVerification {
  ok: boolean;
  reason?: 'MALFORMED' | 'STALE' | 'MISMATCH';
  timestamp?: number;
}

export function parseSignature(header: string | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  const parts = header.split(',').map((p) => p.trim());
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === 't' && v) t = Number(v);
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !Number.isFinite(t) || v1.length === 0) return null;
  return { t, v1 };
}

export function verifySignature(
  secrets: readonly string[],
  rawBody: string,
  header: string | undefined,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): SignatureVerification {
  const parsed = parseSignature(header);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.t) > tolerance)
    return { ok: false, reason: 'STALE', timestamp: parsed.t };
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${parsed.t}.${rawBody}`).digest('hex');
    for (const candidate of parsed.v1) {
      if (candidate.length === expected.length && safeEqual(candidate, expected))
        return { ok: true, timestamp: parsed.t };
    }
  }
  return { ok: false, reason: 'MISMATCH', timestamp: parsed.t };
}

/** Plain HMAC-SHA256 hex over the raw body (providers that sign without a timestamp). */
export function hmacHex(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
