import type { DelegatedGrant } from '@accounting/types';
import {
  approverPermission,
  checkGrant,
  formatDelegationNumber,
  isUsable,
  missingDelegatorPermissions,
  nextStatus,
  requiredApprovals,
  selectGrant,
  validateWindow,
} from './delegation.logic';

const now = new Date('2026-10-05T10:00:00Z');
const grant = (over: Partial<DelegatedGrant> = {}): DelegatedGrant => ({
  delegationId: 'd1',
  delegationNumber: 'DLG-000001',
  delegatorUserId: 'cfo',
  delegatorName: 'Chief Financial Officer',
  permission: 'bill.approve',
  companyId: 'co-a',
  branchId: null,
  maxAmount: '500000.0000',
  currency: 'PHP',
  startAt: '2026-10-01T00:00:00Z',
  endAt: '2026-10-15T00:00:00Z',
  ...over,
});
const doc = {
  now,
  companyId: 'co-a',
  branchId: 'br-dvo',
  amount: '250000.0000',
  currency: 'PHP',
  documentCreatedBy: 'alice',
  actingUserId: 'bob',
};

describe('delegation.logic', () => {
  it('Rule 3: windows are explicit, future and bounded by policy', () => {
    expect(
      validateWindow({ startAt: new Date('2026-10-01'), endAt: new Date('2026-10-15') }, now, 90),
    ).toBeNull();
    expect(
      validateWindow({ startAt: new Date('2026-10-15'), endAt: new Date('2026-10-01') }, now, 90),
    ).toMatch(/after start/);
    expect(
      validateWindow({ startAt: new Date('2026-09-01'), endAt: new Date('2026-09-02') }, now, 90),
    ).toMatch(/future/);
    expect(
      validateWindow({ startAt: new Date('2026-10-01'), endAt: new Date('2027-10-01') }, now, 90),
    ).toMatch(/at most 90/);
  });

  it('Rule 1 / 2: only permissions the delegator holds can be delegated', () => {
    expect(
      missingDelegatorPermissions(['bill.approve', 'journal.approve'], new Set(['bill.approve'])),
    ).toEqual(['journal.approve']);
    expect(
      missingDelegatorPermissions(['bill.approve'], new Set(['bill.approve', 'bill.post'])),
    ).toEqual([]);
  });

  it('Rule 4 / 5: expired, revoked and pending delegations are unusable', () => {
    const base = { startAt: new Date('2026-10-01'), endAt: new Date('2026-10-15') };
    expect(isUsable({ ...base, status: 'ACTIVE' }, now)).toBe(true);
    expect(isUsable({ ...base, status: 'PENDING' }, now)).toBe(false);
    expect(isUsable({ ...base, status: 'REVOKED' }, now)).toBe(false);
    expect(isUsable({ ...base, status: 'ACTIVE' }, new Date('2026-10-16'))).toBe(false);
    expect(nextStatus({ ...base, status: 'ACTIVE' }, new Date('2026-10-16'))).toBe('EXPIRED');
    expect(nextStatus({ ...base, status: 'REVOKED' }, new Date('2026-10-16'))).toBe('REVOKED');
    expect(nextStatus({ ...base, status: 'ACTIVE' }, now)).toBe('ACTIVE');
  });

  it('accepts a document inside every dimension of the scope', () => {
    expect(checkGrant({ ...doc, grant: grant() })).toEqual({ ok: true });
    expect(checkGrant({ ...doc, grant: grant({ branchId: 'br-dvo' }) })).toEqual({ ok: true });
  });

  it('Rule 6: company and branch scope', () => {
    expect(checkGrant({ ...doc, grant: grant({ companyId: 'co-b' }) })).toMatchObject({
      ok: false,
      code: 'COMPANY',
    });
    expect(checkGrant({ ...doc, grant: grant({ branchId: 'br-ceb' }) })).toMatchObject({
      ok: false,
      code: 'BRANCH',
    });
    expect(
      checkGrant({ ...doc, branchId: null, grant: grant({ branchId: 'br-dvo' }) }),
    ).toMatchObject({ ok: false, code: 'BRANCH' });
  });

  it('Rule 7: amount ceilings are exact-decimal and currency-aware', () => {
    expect(checkGrant({ ...doc, amount: '500000.0000', grant: grant() })).toEqual({ ok: true });
    expect(checkGrant({ ...doc, amount: '500000.0001', grant: grant() })).toMatchObject({
      ok: false,
      code: 'AMOUNT',
    });
    expect(checkGrant({ ...doc, currency: 'USD', grant: grant() })).toMatchObject({
      ok: false,
      code: 'CURRENCY',
    });
    expect(
      checkGrant({
        ...doc,
        amount: '9999999.0000',
        grant: grant({ maxAmount: null, currency: null }),
      }),
    ).toEqual({ ok: true });
  });

  it('Rule 8 / 9: no self-approval, and a delegator cannot use their own delegation', () => {
    expect(checkGrant({ ...doc, documentCreatedBy: 'bob', grant: grant() })).toMatchObject({
      ok: false,
      code: 'SELF_APPROVAL',
    });
    expect(
      checkGrant({ ...doc, actingUserId: 'cfo', documentCreatedBy: 'alice', grant: grant() }),
    ).toMatchObject({ ok: false, code: 'DELEGATOR_SELF' });
  });

  it('Rule 3 at use time: the window is checked against now', () => {
    expect(
      checkGrant({ ...doc, now: new Date('2026-10-16T00:00:00Z'), grant: grant() }),
    ).toMatchObject({ ok: false, code: 'WINDOW' });
    expect(
      checkGrant({ ...doc, now: new Date('2026-09-30T00:00:00Z'), grant: grant() }),
    ).toMatchObject({ ok: false, code: 'WINDOW' });
  });

  it('selects the first grant that fits, otherwise reports the failure of the first candidate', () => {
    const grants = [
      grant({ maxAmount: '100000.0000', delegationNumber: 'DLG-1' }),
      grant({ maxAmount: '1000000.0000', delegationNumber: 'DLG-2' }),
    ];
    expect(selectGrant(grants, 'bill.approve', doc)?.grant.delegationNumber).toBe('DLG-2');
    expect(selectGrant(grants, 'journal.approve', doc)).toBeNull();
    const failing = selectGrant([grants[0]!], 'bill.approve', doc);
    expect(failing?.verdict).toMatchObject({ ok: false, code: 'AMOUNT' });
  });

  it('maps organization policy to approvals and approver permission', () => {
    expect(requiredApprovals('SELF_SERVICE')).toBe(0);
    expect(requiredApprovals('MANAGER_APPROVAL')).toBe(1);
    expect(requiredApprovals('ADMIN_APPROVAL')).toBe(1);
    expect(requiredApprovals('DUAL_APPROVAL')).toBe(2);
    expect(approverPermission('SELF_SERVICE')).toBeNull();
    expect(approverPermission('ADMIN_APPROVAL')).toBe('delegation.manage');
    expect(approverPermission('DUAL_APPROVAL')).toBe('delegation.approve');
    expect(formatDelegationNumber(123)).toBe('DLG-000123');
  });
});
