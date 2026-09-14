import { toTree } from './accounts.service';
import type { Account } from '@/database/schema';

const a = (id: string, code: string, parentId: string | null): Account =>
  ({
    id,
    code,
    parentId,
    name: code,
    companyId: 'c',
    type: 'ASSET',
    subtype: null,
    normalBalance: 'DEBIT',
    isHeader: false,
    isSystem: false,
    currency: null,
    description: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as Account;

describe('toTree', () => {
  it('orders depth-first by code and assigns levels', () => {
    const rows = [
      a('c', '1110', 'b'),
      a('a', '1000', null),
      a('b', '1100', 'a'),
      a('d', '2000', null),
      a('e', '1120', 'b'),
    ];
    const tree = toTree(rows);
    expect(tree.map((t) => `${t.level}:${t.code}`)).toEqual([
      '0:1000',
      '1:1100',
      '2:1110',
      '2:1120',
      '0:2000',
    ]);
    expect(tree.find((t) => t.code === '1100')?.hasChildren).toBe(true);
    expect(tree.find((t) => t.code === '2000')?.hasChildren).toBe(false);
  });

  it('treats orphans (filtered-out parents) as roots', () => {
    const tree = toTree([a('x', '1110', 'missing')]);
    expect(tree[0]?.level).toBe(0);
  });
});
