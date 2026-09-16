import { Money } from '@accounting/money';
import { convertForeignLines, ForeignJournalUnbalancedError } from './fx-lines.logic';

describe('foreign-currency journal lines', () => {
  it('converts every line at the rate and keeps the foreign amounts', () => {
    const lines = convertForeignLines(
      [
        { accountId: 'ar', debit: '100', credit: '0' },
        { accountId: 'rev', debit: '0', credit: '100' },
      ],
      'USD',
      'PHP',
      '56.5',
    );
    expect(lines[0]).toEqual(
      expect.objectContaining({
        debit: '5650.0000',
        credit: '0.0000',
        foreignDebit: '100.0000',
        foreignCredit: '0.0000',
        exchangeRate: '56.5',
      }),
    );
    expect(lines[1]?.credit).toBe('5650.0000');
  });

  it('absorbs per-line rounding so the base entry balances exactly', () => {
    // 3 x 33.33 = 99.99 USD each side; at 56.123457 each line rounds independently.
    const lines = convertForeignLines(
      [
        { accountId: 'a', debit: '33.33', credit: '0' },
        { accountId: 'b', debit: '33.33', credit: '0' },
        { accountId: 'c', debit: '33.33', credit: '0' },
        { accountId: 'd', debit: '0', credit: '99.99' },
      ],
      'USD',
      'PHP',
      '56.12345678',
    );
    const sum = (side: 'debit' | 'credit') =>
      lines.reduce((acc, l) => acc.add(Money.of(l[side], 'PHP')), Money.zero('PHP'));
    expect(sum('debit').equals(sum('credit'))).toBe(true);
    // Foreign amounts are untouched by the rounding fix-up.
    expect(lines[3]?.foreignCredit).toBe('99.9900');
  });

  it('rejects lines that do not balance in the transaction currency', () => {
    expect(() =>
      convertForeignLines(
        [
          { accountId: 'a', debit: '10', credit: '0' },
          { accountId: 'b', debit: '0', credit: '9' },
        ],
        'USD',
        'PHP',
        '56',
      ),
    ).toThrow(ForeignJournalUnbalancedError);
  });
});
