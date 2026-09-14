/**
 * Computes a shallow before/after diff limited to changed keys, used to keep
 * audit payloads small and readable. Keys listed in `redact` are replaced.
 */
export function shallowDiff<T extends Record<string, unknown>>(
  before: T | undefined,
  after: T | undefined,
  redact: readonly string[] = ['passwordHash', 'refreshTokenHash'],
): { previous: Record<string, unknown>; next: Record<string, unknown> } {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const key of keys) {
    const b = before?.[key];
    const a = after?.[key];
    if (isEqual(a, b)) continue;
    previous[key] = redact.includes(key) ? '[REDACTED]' : normalise(b);
    next[key] = redact.includes(key) ? '[REDACTED]' : normalise(a);
  }
  return { previous, next };
}

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  if (typeof a === 'object' && typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
