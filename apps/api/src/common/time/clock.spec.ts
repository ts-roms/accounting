import { businessDateOffset, businessToday } from './clock';

describe('business clock', () => {
  const saved = process.env.APP_CLOCK_FIXED_DATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_CLOCK_FIXED_DATE;
    else process.env.APP_CLOCK_FIXED_DATE = saved;
  });

  it('follows the wall clock when nothing is pinned', () => {
    delete process.env.APP_CLOCK_FIXED_DATE;
    expect(businessToday()).toBe(new Date().toISOString().slice(0, 10));
  });

  it('returns the pinned date and offsets from it', () => {
    process.env.APP_CLOCK_FIXED_DATE = '2026-09-18';
    expect(businessToday()).toBe('2026-09-18');
    expect(businessDateOffset(-7)).toBe('2026-09-11');
    expect(businessDateOffset(13)).toBe('2026-10-01');
  });

  it('treats an empty pin as unset', () => {
    process.env.APP_CLOCK_FIXED_DATE = '';
    expect(businessToday()).toBe(new Date().toISOString().slice(0, 10));
  });
});
