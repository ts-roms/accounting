import { formatNumber } from './document-numbering.service';

describe('formatNumber', () => {
  const base = { prefix: 'INV', branch: 'MNL', year: 2026, sequence: 7, padding: 6 };

  it('renders the default company-wide format', () => {
    expect(formatNumber('{PREFIX}-{YEAR}-{SEQ}', base)).toBe('INV-2026-000007');
  });

  it('renders branch-specific formats and two-digit years', () => {
    expect(formatNumber('{PREFIX}-{BRANCH}-{YEAR}-{SEQ}', base)).toBe('INV-MNL-2026-000007');
    expect(formatNumber('{PREFIX}{YY}/{SEQ}', { ...base, padding: 4 })).toBe('INV26/0007');
  });

  it('collapses the separator when a branch token has no branch', () => {
    expect(formatNumber('{PREFIX}-{BRANCH}-{YEAR}-{SEQ}', { ...base, branch: '' })).toBe(
      'INV-2026-000007',
    );
  });

  it('never truncates a sequence longer than the padding', () => {
    expect(formatNumber('{PREFIX}-{SEQ}', { ...base, sequence: 12345678, padding: 4 })).toBe(
      'INV-12345678',
    );
  });
});
