import { isUniqueViolation, unwrapPgError } from './pg-errors';

describe('pg-errors', () => {
  const pgError = Object.assign(new Error('dup'), { code: '23505', constraint: 'users_email_uq' });

  it('detects a direct unique violation', () => {
    expect(isUniqueViolation(pgError)).toBe(true);
    expect(isUniqueViolation(pgError, 'users_email_uq')).toBe(true);
    expect(isUniqueViolation(pgError, 'other')).toBe(false);
  });

  it('unwraps DrizzleQueryError-style wrappers via cause', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgError });
    expect(unwrapPgError(wrapped)).toBe(pgError);
    expect(isUniqueViolation(wrapped, 'users_email_uq')).toBe(true);
  });

  it('returns false for non-pg errors', () => {
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
