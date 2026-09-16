/* Delegated authority (Prompt #4). */
import { z } from 'zod';
import {
  DELEGABLE_PERMISSIONS,
  DELEGATION_APPROVAL_POLICIES,
  DELEGATION_DECISIONS,
  DELEGATION_STATUSES,
} from '@accounting/types';
import { amountSchema } from './accounting';
import { optionalCurrencyCodeSchema, paginationQuerySchema, uuidSchema } from './primitives';

const isoDateTime = z.iso.datetime({ offset: true });

/** One permission lent by the delegation, optionally narrowed to a branch and capped by amount. */
export const delegationScopeSchema = z.object({
  permission: z.enum(DELEGABLE_PERMISSIONS),
  branchId: uuidSchema.nullable().optional(),
  /** Inclusive ceiling on the document amount the delegate may approve; null = delegator's own limit. */
  maxAmount: amountSchema.nullable().optional(),
  currency: optionalCurrencyCodeSchema,
});
export type DelegationScopeInput = z.infer<typeof delegationScopeSchema>;

export const createDelegationSchema = z
  .object({
    /** Defaults to the caller: administrators may create delegations on behalf of another user. */
    delegatorUserId: uuidSchema.optional(),
    delegateUserId: uuidSchema,
    companyId: uuidSchema,
    startAt: isoDateTime,
    endAt: isoDateTime,
    reason: z.string().trim().min(3, 'A reason is required').max(500),
    scopes: z.array(delegationScopeSchema).min(1, 'Delegate at least one permission').max(20),
  })
  .refine((d) => new Date(d.endAt).getTime() > new Date(d.startAt).getTime(), {
    message: 'End must be after start',
    path: ['endAt'],
  })
  .refine(
    (d) =>
      new Set(d.scopes.map((s) => `${s.permission}|${s.branchId ?? ''}`)).size === d.scopes.length,
    { message: 'Duplicate permission / branch scope', path: ['scopes'] },
  );
export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;

/** Only PENDING delegations can be edited, and only by the delegator / creator. */
export const updateDelegationSchema = z
  .object({
    startAt: isoDateTime.optional(),
    endAt: isoDateTime.optional(),
    reason: z.string().trim().min(3).max(500).optional(),
    scopes: z.array(delegationScopeSchema).min(1).max(20).optional(),
  })
  .refine(
    (d) => !d.startAt || !d.endAt || new Date(d.endAt).getTime() > new Date(d.startAt).getTime(),
    { message: 'End must be after start', path: ['endAt'] },
  );
export type UpdateDelegationInput = z.infer<typeof updateDelegationSchema>;

export const decideDelegationSchema = z.object({
  decision: z.enum(DELEGATION_DECISIONS),
  comment: z.string().trim().max(500).optional(),
});
export type DecideDelegationInput = z.infer<typeof decideDelegationSchema>;

export const revokeDelegationSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});
export type RevokeDelegationInput = z.infer<typeof revokeDelegationSchema>;

export const listDelegationsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(DELEGATION_STATUSES).optional(),
  /** 'delegate' = lent to me, 'delegator' = I lent, 'approver' = waiting for my decision. */
  role: z.enum(['delegate', 'delegator', 'approver']).optional(),
  companyId: uuidSchema.optional(),
  permission: z.enum(DELEGABLE_PERMISSIONS).optional(),
  userId: uuidSchema.optional(),
});
export type ListDelegationsQuery = z.infer<typeof listDelegationsQuerySchema>;

export const delegationPolicySchema = z.object({
  approvalPolicy: z.enum(DELEGATION_APPROVAL_POLICIES).default('MANAGER_APPROVAL'),
  /** Upper bound on a delegation's duration. */
  maxDurationDays: z.coerce.number().int().min(1).max(365).default(90),
  /** Notify the delegate / approvers this many days before expiry (0 = never). */
  expiryWarningDays: z.coerce.number().int().min(0).max(30).default(2),
  /** Whether the delegator must still hold every delegated permission at each use (recommended). */
  revalidateAtUse: z.boolean().default(true),
});
export type DelegationPolicyInput = z.infer<typeof delegationPolicySchema>;
