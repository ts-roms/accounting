import { Money } from '@accounting/money';
import type { DelegatedGrant, DelegationApprovalPolicy, DelegationStatus } from '@accounting/types';

/**
 * Pure delegation rules (no I/O) so every rule in docs/integrations/delegations.md
 * is unit-tested in isolation:
 *
 *  1. A user cannot delegate permissions they do not hold.
 *  2. A delegate never receives more than the delegator holds (same check, re-run at use).
 *  3. Explicit start and end; 4. expiry is automatic; 5. revocation is immediate.
 *  6. Company / branch scope; 7. amount ceilings; 8/9. SoD and no self-approval.
 * 10. Never bypasses accounting controls: delegation only answers "may this
 *     person approve", posting rules are untouched.
 */

export interface DelegationWindow {
  startAt: Date;
  endAt: Date;
}

export function validateWindow(
  window: DelegationWindow,
  now: Date,
  maxDurationDays: number,
): string | null {
  if (!(window.endAt.getTime() > window.startAt.getTime())) return 'End must be after start.';
  if (window.endAt.getTime() <= now.getTime()) return 'End must be in the future.';
  const days = (window.endAt.getTime() - window.startAt.getTime()) / (24 * 3600 * 1000);
  if (days > maxDurationDays) return `A delegation may last at most ${maxDurationDays} days.`;
  return null;
}

/** Rule 1 / 2: every requested permission must be held by the delegator. */
export function missingDelegatorPermissions(
  requested: readonly string[],
  delegatorPermissions: ReadonlySet<string>,
): string[] {
  return [...new Set(requested)].filter((p) => !delegatorPermissions.has(p));
}

/** Rule 3 / 4 / 5: only ACTIVE delegations inside their window are usable. */
export function isUsable(
  d: { status: DelegationStatus; startAt: Date; endAt: Date },
  now: Date,
): boolean {
  return (
    d.status === 'ACTIVE' &&
    d.startAt.getTime() <= now.getTime() &&
    d.endAt.getTime() > now.getTime()
  );
}

/** PENDING/ACTIVE past their end -> EXPIRED; PENDING before its start is not yet usable. */
export function nextStatus(
  d: { status: DelegationStatus; startAt: Date; endAt: Date },
  now: Date,
): DelegationStatus {
  if (['REVOKED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(d.status)) return d.status;
  if (d.endAt.getTime() <= now.getTime()) return 'EXPIRED';
  return d.status;
}

export interface AuthorityCheckInput {
  grant: DelegatedGrant;
  now: Date;
  companyId: string;
  branchId?: string | null;
  amount?: string | null;
  currency?: string | null;
  /** Who created / submitted the document being approved. */
  documentCreatedBy?: string | null;
  actingUserId: string;
}

export type AuthorityVerdict =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'WINDOW'
        | 'COMPANY'
        | 'BRANCH'
        | 'AMOUNT'
        | 'CURRENCY'
        | 'SELF_APPROVAL'
        | 'DELEGATOR_SELF';
      message: string;
    };

/** Rules 6-9 for one grant against one document. */
export function checkGrant(input: AuthorityCheckInput): AuthorityVerdict {
  const g = input.grant;
  const start = new Date(g.startAt).getTime();
  const end = new Date(g.endAt).getTime();
  if (input.now.getTime() < start || input.now.getTime() >= end)
    return { ok: false, code: 'WINDOW', message: 'The delegation is not in effect right now.' };
  if (g.companyId !== input.companyId)
    return { ok: false, code: 'COMPANY', message: 'The delegation does not cover this company.' };
  if (g.branchId && input.branchId && g.branchId !== input.branchId)
    return { ok: false, code: 'BRANCH', message: 'The delegation does not cover this branch.' };
  if (g.branchId && !input.branchId)
    return {
      ok: false,
      code: 'BRANCH',
      message: 'The delegation is limited to one branch; this document has none.',
    };
  if (g.maxAmount !== null && input.amount) {
    const currency = g.currency ?? input.currency ?? 'XXX';
    if (g.currency && input.currency && g.currency !== input.currency)
      return {
        ok: false,
        code: 'CURRENCY',
        message: `The delegation limit is in ${g.currency}; the document is in ${input.currency}.`,
      };
    if (Money.of(input.amount, currency).greaterThan(Money.of(g.maxAmount, currency)))
      return {
        ok: false,
        code: 'AMOUNT',
        message: `Amount ${input.amount} exceeds the delegated limit of ${g.maxAmount}.`,
      };
  }
  // Rule 9: the delegate may not approve their own document, and neither may
  // the delegator's authority be used on a document the delegator created
  // (that would let A create, delegate to B, and B approve "as A" - fine - but
  // never let A approve A's own work through a delegation *to themselves*).
  if (input.documentCreatedBy && input.documentCreatedBy === input.actingUserId)
    return {
      ok: false,
      code: 'SELF_APPROVAL',
      message: 'You cannot approve a document you created, even under delegated authority.',
    };
  if (g.delegatorUserId === input.actingUserId)
    return {
      ok: false,
      code: 'DELEGATOR_SELF',
      message: 'A delegation cannot be used by its own delegator.',
    };
  return { ok: true };
}

/** Best grant for a document: the first that passes; otherwise the most specific failure. */
export function selectGrant(
  grants: readonly DelegatedGrant[],
  permission: string,
  input: Omit<AuthorityCheckInput, 'grant'>,
): { grant: DelegatedGrant; verdict: AuthorityVerdict } | null {
  const candidates = grants.filter((g) => g.permission === permission);
  if (candidates.length === 0) return null;
  let failure: { grant: DelegatedGrant; verdict: AuthorityVerdict } | null = null;
  for (const grant of candidates) {
    const verdict = checkGrant({ ...input, grant });
    if (verdict.ok) return { grant, verdict };
    if (!failure) failure = { grant, verdict };
  }
  return failure;
}

/** How many approvals a new delegation needs under the organization policy. */
export function requiredApprovals(policy: DelegationApprovalPolicy): number {
  switch (policy) {
    case 'SELF_SERVICE':
      return 0;
    case 'DUAL_APPROVAL':
      return 2;
    default:
      return 1;
  }
}

/** Who may approve under the policy (permission the approver must hold). */
export function approverPermission(
  policy: DelegationApprovalPolicy,
): 'delegation.approve' | 'delegation.manage' | null {
  switch (policy) {
    case 'SELF_SERVICE':
      return null;
    case 'ADMIN_APPROVAL':
      return 'delegation.manage';
    default:
      return 'delegation.approve';
  }
}

export function formatDelegationNumber(sequence: number): string {
  return `DLG-${String(sequence).padStart(6, '0')}`;
}
