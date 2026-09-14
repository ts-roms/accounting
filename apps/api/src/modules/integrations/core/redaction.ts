/**
 * Redacts secrets before anything is logged or stored in `integration_logs`.
 * Key-based (any key that smells like a credential) plus value-based (bearer
 * tokens, our own API keys, long hex/base64 blobs following `secret`-like keys).
 */
const SENSITIVE_KEY =
  /(authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|apikey|private[-_]?key|client[-_]?secret|refresh|access[-_]?token|signature|credential|x-webhook-signature)/i;
const BEARER_VALUE = /^(bearer|basic)\s+\S+/i;
const OUR_API_KEY = /\bak_[A-Za-z0-9_-]{8,}/g;

export const REDACTED = '[REDACTED]';

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return REDACTED as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  if (typeof value === 'string') return redactString(value) as unknown as T;
  return value;
}

export function redactString(value: string): string {
  if (BEARER_VALUE.test(value)) return REDACTED;
  return value.replace(OUR_API_KEY, 'ak_' + REDACTED);
}

/** Headers safe to keep in a log entry (allow-list, then redaction as a second net). */
const HEADER_ALLOW = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'x-correlation-id',
  'x-request-id',
  'x-webhook-event-id',
  'x-webhook-event',
  'x-webhook-delivery-id',
  'retry-after',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
]);

export function safeHeaders(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Array<[string, string]> =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (HEADER_ALLOW.has(key)) out[key] = redactString(v);
  }
  return out;
}
