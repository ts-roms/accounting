import { splitWindow } from './general-ledger.service';

describe('splitWindow', () => {
  it('serves whole months from balances and nothing from the lines', () => {
    expect(splitWindow('2026-01-01', '2026-03-31')).toEqual({
      months: { from: '2026-01-01', to: '2026-03-01' },
      days: [],
    });
  });

  it('serves partial edge months from the lines', () => {
    expect(splitWindow('2026-01-15', '2026-04-10')).toEqual({
      months: { from: '2026-02-01', to: '2026-03-01' },
      days: [
        { from: '2026-01-15', to: '2026-01-31' },
        { from: '2026-04-01', to: '2026-04-10' },
      ],
    });
  });

  it('falls back to the lines when the window holds no whole month', () => {
    expect(splitWindow('2026-02-02', '2026-03-30')).toEqual({
      months: null,
      days: [{ from: '2026-02-02', to: '2026-03-30' }],
    });
    expect(splitWindow('2026-02-01', '2026-02-27')).toEqual({
      months: null,
      days: [{ from: '2026-02-01', to: '2026-02-27' }],
    });
  });

  it('treats a missing start as all history', () => {
    expect(splitWindow(undefined, '2026-06-30')).toEqual({
      months: { from: '0001-01-01', to: '2026-06-01' },
      days: [],
    });
    expect(splitWindow(undefined, '2026-06-15')).toEqual({
      months: { from: '0001-01-01', to: '2026-05-01' },
      days: [{ from: '2026-06-01', to: '2026-06-15' }],
    });
  });

  it('handles leap years and year boundaries', () => {
    expect(splitWindow('2024-02-01', '2024-02-29')).toEqual({
      months: { from: '2024-02-01', to: '2024-02-01' },
      days: [],
    });
    expect(splitWindow('2025-12-15', '2026-01-31')).toEqual({
      months: { from: '2026-01-01', to: '2026-01-01' },
      days: [{ from: '2025-12-15', to: '2025-12-31' }],
    });
  });
});

describe('splitWindow sentinels', () => {
  it('handles the all-history window without overflowing the calendar', () => {
    expect(splitWindow('1900-01-01', '9999-12-31')).toEqual({
      months: { from: '1900-01-01', to: '9999-12-01' },
      days: [],
    });
    expect(splitWindow(undefined, '9999-12-30')).toEqual({
      months: { from: '0001-01-01', to: '9999-11-01' },
      days: [{ from: '9999-12-01', to: '9999-12-30' }],
    });
  });
});
