import { AccountingPostingService } from './posting.service';
import { BusinessRuleError } from '@/common/errors/app-error';
import type { Account } from '@/database/schema';
import type { DbExecutor } from '@/database/database.types';

const account = (overrides: Partial<Account>): Account => ({
  id: 'a',
  companyId: 'c',
  code: '1000',
  name: 'Account',
  type: 'ASSET',
  subtype: null,
  normalBalance: 'DEBIT',
  parentId: null,
  isHeader: false,
  isIntercompany: false,
  isSystem: false,
  currency: null,
  description: null,
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Minimal fake of the drizzle select chain: `tx.select().from().where()` resolves to `rows`. */
const fakeTx = (rows: Account[]): DbExecutor =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as unknown as DbExecutor;

describe('AccountingPostingService.validateLines', () => {
  const service = new AccountingPostingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { setContext: () => undefined } as never,
  );
  const cash = account({ id: 'cash', code: '1110' });
  const expense = account({ id: 'exp', code: '6400', type: 'EXPENSE' });

  it('accepts a balanced entry and totals with exact decimals', async () => {
    const result = await service.validateLines(fakeTx([cash, expense]), 'c', 'PHP', [
      { accountId: 'exp', debit: '0.1', credit: '0' },
      { accountId: 'exp', debit: '0.2', credit: '0' },
      { accountId: 'cash', debit: '0', credit: '0.3' },
    ]);
    expect(result.totalDebit.toString()).toBe('0.3000');
    expect(result.totalCredit.toString()).toBe('0.3000');
  });

  it('rejects unbalanced entries with the exact difference', async () => {
    await expect(
      service.validateLines(fakeTx([cash, expense]), 'c', 'PHP', [
        { accountId: 'exp', debit: '100', credit: '0' },
        { accountId: 'cash', debit: '0', credit: '99.9999' },
      ]),
    ).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED', details: { difference: '0.0001' } });
  });

  it('rejects header, inactive, unknown and foreign-currency accounts', async () => {
    const header = account({ id: 'h', isHeader: true });
    const inactive = account({ id: 'i', status: 'INACTIVE' });
    const usd = account({ id: 'u', currency: 'USD' });
    const lines = (id: string) => [
      { accountId: id, debit: '1', credit: '0' },
      { accountId: 'cash', debit: '0', credit: '1' },
    ];
    await expect(
      service.validateLines(fakeTx([cash, header]), 'c', 'PHP', lines('h')),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_POSTABLE' });
    await expect(
      service.validateLines(fakeTx([cash, inactive]), 'c', 'PHP', lines('i')),
    ).rejects.toMatchObject({ code: 'GL_ACCOUNT_INACTIVE' });
    await expect(
      service.validateLines(fakeTx([cash, usd]), 'c', 'PHP', lines('u')),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    await expect(
      service.validateLines(fakeTx([cash]), 'c', 'PHP', lines('missing')),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('rejects lines with both sides, zero amounts or fewer than two lines', async () => {
    await expect(
      service.validateLines(fakeTx([cash, expense]), 'c', 'PHP', [
        { accountId: 'exp', debit: '1', credit: '1' },
        { accountId: 'cash', debit: '0', credit: '0' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.validateLines(fakeTx([cash]), 'c', 'PHP', [
        { accountId: 'cash', debit: '1', credit: '0' },
      ]),
    ).rejects.toMatchObject({
      code: 'JOURNAL_UNBALANCED',
    });
  });
});
