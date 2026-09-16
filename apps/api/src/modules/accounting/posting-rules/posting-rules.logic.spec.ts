import type { PostingRuleLine } from '@/database/schema';
import {
  PostingRuleResolutionError,
  resolvePostingRule,
  ruleRequirements,
} from './posting-rules.logic';

const INVOICE: PostingRuleLine[] = [
  {
    side: 'DEBIT',
    accountSource: 'MAPPING',
    mappingKey: 'ACCOUNTS_RECEIVABLE',
    amountKey: 'GROSS',
  },
  { side: 'CREDIT', accountSource: 'CONTEXT', accountKey: 'REVENUE', amountKey: 'NET' },
  { side: 'CREDIT', accountSource: 'MAPPING', mappingKey: 'OUTPUT_VAT', amountKey: 'TAX' },
];

const mapped = new Map([
  ['ACCOUNTS_RECEIVABLE', 'ar'],
  ['OUTPUT_VAT', 'vat'],
]);

describe('posting rule resolution', () => {
  it('lists what a rule needs from its caller', () => {
    expect(ruleRequirements(INVOICE)).toEqual({
      amountKeys: ['GROSS', 'NET', 'TAX'],
      accountKeys: ['REVENUE'],
      mappingKeys: ['ACCOUNTS_RECEIVABLE', 'OUTPUT_VAT'],
    });
  });

  it('resolves a customer invoice into balanced lines', () => {
    const lines = resolvePostingRule(INVOICE, 'PHP', {
      amounts: { GROSS: '112', NET: '100', TAX: '12' },
      accounts: { REVENUE: 'rev' },
      mapped,
      description: 'INV-1',
    });
    expect(lines).toEqual([
      expect.objectContaining({ accountId: 'ar', debit: '112.0000', credit: '0' }),
      expect.objectContaining({ accountId: 'rev', debit: '0', credit: '100.0000' }),
      expect.objectContaining({ accountId: 'vat', debit: '0', credit: '12.0000' }),
    ]);
  });

  it('drops zero-amount lines and flips sides for negative amounts (credit note)', () => {
    const lines = resolvePostingRule(INVOICE, 'PHP', {
      amounts: { GROSS: '-100', NET: '-100', TAX: '0' },
      accounts: { REVENUE: 'rev' },
      mapped,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(expect.objectContaining({ accountId: 'ar', credit: '100.0000' }));
    expect(lines[1]).toEqual(expect.objectContaining({ accountId: 'rev', debit: '100.0000' }));
  });

  it('rejects missing amounts, missing accounts and unbalanced results', () => {
    expect(() =>
      resolvePostingRule(INVOICE, 'PHP', { amounts: { GROSS: '1' }, accounts: {}, mapped }),
    ).toThrow(PostingRuleResolutionError);
    expect(() =>
      resolvePostingRule(INVOICE, 'PHP', {
        amounts: { GROSS: '112', NET: '100', TAX: '12' },
        accounts: {},
        mapped,
      }),
    ).toThrow(/could not resolve its account/);
    expect(() =>
      resolvePostingRule(INVOICE, 'PHP', {
        amounts: { GROSS: '112', NET: '100', TAX: '10' },
        accounts: { REVENUE: 'rev' },
        mapped,
      }),
    ).toThrow(/unbalanced/);
  });
});
