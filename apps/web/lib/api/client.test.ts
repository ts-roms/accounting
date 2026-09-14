import { describe, expect, it } from 'vitest';
import { ApiError, describeError } from './client';

describe('describeError', () => {
  it('surfaces the first validation issue', () => {
    const err = new ApiError(400, {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
      details: { issues: [{ path: ['email'], message: 'Must be a valid email address' }] },
    });
    expect(describeError(err)).toBe('email: Must be a valid email address');
  });

  it('uses the API message for domain errors and a generic fallback otherwise', () => {
    expect(
      describeError(new ApiError(409, { code: 'DUPLICATE', message: 'Already exists.' })),
    ).toBe('Already exists.');
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(undefined)).toBe('Something went wrong.');
  });
});
