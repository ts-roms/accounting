import { SodService } from './sod.service';
import type { SodPolicy } from '@/database/schema';

const policy = (overrides: Partial<SodPolicy>): SodPolicy => ({
  id: 'p1',
  organizationId: 'org',
  name: 'test',
  description: null,
  permissionA: 'journal.create',
  permissionB: 'journal.approve',
  enforcement: 'WARN',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('SodService.evaluate', () => {
  const service = new SodService({} as never, {} as never);

  it('flags a conflict only when both permissions are held', () => {
    const result = service.evaluate(new Set(['journal.create']), [policy({})]);
    expect(result.warnings).toHaveLength(0);
    expect(result.blocking).toHaveLength(0);

    const both = service.evaluate(new Set(['journal.create', 'journal.approve']), [policy({})]);
    expect(both.warnings).toHaveLength(1);
    expect(both.blocking).toHaveLength(0);
  });

  it('separates BLOCK from WARN enforcement', () => {
    const result = service.evaluate(
      new Set(['journal.create', 'journal.approve', 'journal.post']),
      [
        policy({ id: 'a', enforcement: 'BLOCK' }),
        policy({
          id: 'b',
          permissionA: 'journal.approve',
          permissionB: 'journal.post',
          enforcement: 'WARN',
        }),
      ],
    );
    expect(result.blocking.map((c) => c.policyId)).toEqual(['a']);
    expect(result.warnings.map((c) => c.policyId)).toEqual(['b']);
  });

  it('ignores inactive policies', () => {
    const result = service.evaluate(new Set(['journal.create', 'journal.approve']), [
      policy({ isActive: false, enforcement: 'BLOCK' }),
    ]);
    expect(result.blocking).toHaveLength(0);
  });
});
