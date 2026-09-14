/**
 * Helpers for translating PostgreSQL driver errors into domain errors without
 * leaking raw database messages to API clients.
 *
 * Drizzle wraps driver failures in `DrizzleQueryError` with the original pg
 * error on `cause`, so we unwrap the cause chain before inspecting codes.
 */
export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export function isPgError(err: unknown): err is PgError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as PgError).code === 'string'
  );
}

/** Walks `cause` links (max depth 5) to find the underlying pg error. */
export function unwrapPgError(err: unknown): PgError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (isPgError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = unwrapPgError(err);
  if (!pg || pg.code !== PG_UNIQUE_VIOLATION) return false;
  return constraint ? pg.constraint === constraint : true;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return unwrapPgError(err)?.code === PG_FOREIGN_KEY_VIOLATION;
}
