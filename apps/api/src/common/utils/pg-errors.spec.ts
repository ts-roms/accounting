import { isTransactionConflict, isUniqueViolation, unwrapPgError } from './pg-errors';

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

  it('recognises deadlocks and serialization failures, also when wrapped', () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const serialization = Object.assign(new Error('could not serialize'), { code: '40001' });
    expect(
      isTransactionConflict(Object.assign(new Error('Failed query'), { cause: deadlock })),
    ).toBe(true);
    expect(isTransactionConflict(serialization)).toBe(true);
    expect(isTransactionConflict(pgError)).toBe(false);
    expect(isTransactionConflict(new Error('nope'))).toBe(false);
  });
});
