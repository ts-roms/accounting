import { shallowDiff } from './diff';

describe('shallowDiff', () => {
  it('returns only changed keys', () => {
    const { previous, next } = shallowDiff({ a: 1, b: 'x', c: true }, { a: 1, b: 'y', c: true });
    expect(previous).toEqual({ b: 'x' });
    expect(next).toEqual({ b: 'y' });
  });

  it('redacts sensitive keys', () => {
    const { previous, next } = shallowDiff({ passwordHash: 'old' }, { passwordHash: 'new' });
    expect(previous).toEqual({ passwordHash: '[REDACTED]' });
    expect(next).toEqual({ passwordHash: '[REDACTED]' });
  });

  it('treats equal dates as unchanged and serialises changed dates', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(shallowDiff({ d }, { d: new Date(d) }).next).toEqual({});
    expect(shallowDiff({ d }, { d: new Date('2026-02-01T00:00:00Z') }).next).toEqual({
      d: '2026-02-01T00:00:00.000Z',
    });
  });

  it('handles creation (no previous) and deletion (no next)', () => {
    expect(shallowDiff(undefined, { a: 1 })).toEqual({
      previous: { a: undefined },
      next: { a: 1 },
    });
    expect(shallowDiff({ a: 1 }, undefined)).toEqual({
      previous: { a: 1 },
      next: { a: undefined },
    });
  });
});
