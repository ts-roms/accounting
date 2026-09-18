import { describe, expect, it } from 'vitest';
import {
  codeSchema,
  passwordSchema,
  paginationQuerySchema,
  currencyCodeSchema,
  queryBooleanSchema,
} from './primitives.js';

describe('validation primitives', () => {
  it('accepts well-formed codes and rejects lowercase', () => {
    expect(codeSchema.parse('HQ-01')).toBe('HQ-01');
    expect(codeSchema.safeParse('hq').success).toBe(false);
  });

  it('enforces password complexity', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('alllowercase123').success).toBe(false);
    expect(passwordSchema.safeParse('GoodPassw0rd!').success).toBe(true);
  });

  it('applies pagination defaults and caps page size', () => {
    expect(paginationQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 25,
      sortDir: 'asc',
    });
    expect(paginationQuerySchema.safeParse({ pageSize: 1000 }).success).toBe(false);
  });

  it('defaults currency to PHP', () => {
    expect(currencyCodeSchema.parse(undefined)).toBe('PHP');
    expect(currencyCodeSchema.safeParse('php').success).toBe(false);
  });
  it('parses query-string booleans strictly', () => {
    expect(queryBooleanSchema.parse('true')).toBe(true);
    expect(queryBooleanSchema.parse('false')).toBe(false);
    expect(queryBooleanSchema.parse('')).toBe(false);
    expect(queryBooleanSchema.parse(true)).toBe(true);
  });
});
