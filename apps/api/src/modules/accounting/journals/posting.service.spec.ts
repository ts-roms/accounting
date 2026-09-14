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
    {} as never,
    { enqueue: async () => null } as never,
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

const periodTx = (status: string): DbExecutor =>
  ({
    select: () => ({
      from: () => ({
        where: async () => [
          {
            id: 'p1',
            name: 'Sep 2026',
            status,
            startDate: '2026-09-01',
            endDate: '2026-09-30',
          },
        ],
      }),
    }),
  }) as unknown as DbExecutor;

describe('AccountingPostingService period states and authority', () => {
  const service = new AccountingPostingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueue: async () => null } as never,
    { setContext: () => undefined } as never,
  );
  const user = (...perms: string[]) => ({ id: 'u', permissions: new Set(perms) });

  it('posts freely into OPEN periods', async () => {
    await expect(
      service.resolvePeriod(periodTx('OPEN'), 'c', '2026-09-10', {}, user()),
    ).resolves.toMatchObject({ id: 'p1' });
  });

  it('SOFT_CLOSED needs period.post-soft-closed, a system actor, or the closing routine', async () => {
    await expect(
      service.resolvePeriod(periodTx('SOFT_CLOSED'), 'c', '2026-09-10', {}, user('journal.post')),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_SOFT_CLOSED' });
    await expect(
      service.resolvePeriod(
        periodTx('SOFT_CLOSED'),
        'c',
        '2026-09-10',
        {},
        user('period.post-soft-closed'),
      ),
    ).resolves.toBeDefined();
    await expect(
      service.resolvePeriod(
        periodTx('SOFT_CLOSED'),
        'c',
        '2026-09-10',
        {},
        { id: null, system: true },
      ),
    ).resolves.toBeDefined();
    await expect(
      service.resolvePeriod(
        periodTx('SOFT_CLOSED'),
        'c',
        '2026-09-10',
        { allowClosedPeriod: true },
        user(),
      ),
    ).resolves.toBeDefined();
  });

  it('CLOSED admits only the year-end routine; LOCKED admits nobody', async () => {
    await expect(
      service.resolvePeriod(
        periodTx('CLOSED'),
        'c',
        '2026-09-10',
        {},
        user('period.post-soft-closed'),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSED' });
    await expect(
      service.resolvePeriod(
        periodTx('CLOSED'),
        'c',
        '2026-09-10',
        { allowClosedPeriod: true },
        user(),
      ),
    ).resolves.toBeDefined();
    await expect(
      service.resolvePeriod(
        periodTx('LOCKED'),
        'c',
        '2026-09-10',
        { allowClosedPeriod: true },
        { id: null, system: true },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_LOCKED' });
  });

  it('requires the posting authority named by the caller (journal.post by default)', () => {
    expect(() => service.assertAuthority(user('journal.post'))).not.toThrow();
    expect(() => service.assertAuthority(user('journal.view'))).toThrow(/permission/i);
    expect(() =>
      service.assertAuthority(user('bill.post'), { permission: 'bill.post' }),
    ).not.toThrow();
    expect(() =>
      service.assertAuthority(user('journal.post'), { permission: 'bill.post' }),
    ).toThrow(/permission/i);
    expect(() => service.assertAuthority({ id: null })).toThrow(/permission/i);
    expect(() => service.assertAuthority({ id: null, system: true })).not.toThrow();
  });
});
