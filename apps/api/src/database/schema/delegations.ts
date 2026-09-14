import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  DELEGATION_APPROVAL_POLICIES,
  DELEGATION_DECISIONS,
  DELEGATION_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { money } from './accounting';
import { branches, companies, organizations } from './organizations';
import { users } from './users';

/*
 * Delegated authority (Prompt #4). A delegation is temporary, scoped and
 * auditable; it lends approval permissions the delegator actually holds and
 * every use is recorded in `delegation_usage` beside the audit trail.
 */

export const delegationStatusEnum = pgEnum('delegation_status', DELEGATION_STATUSES);
export const delegationDecisionEnum = pgEnum('delegation_decision', DELEGATION_DECISIONS);
export const delegationApprovalPolicyEnum = pgEnum(
  'delegation_approval_policy',
  DELEGATION_APPROVAL_POLICIES,
);

export const delegations = pgTable(
  'delegations',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Human reference DLG-000123, sequential per organization. */
    delegationNumber: text('delegation_number').notNull(),
    delegatorUserId: uuid('delegator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    delegateUserId: uuid('delegate_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    status: delegationStatusEnum('status').notNull().default('PENDING'),
    reason: text('reason').notNull(),
    /** Policy snapshot: approvals still needed before ACTIVE (0 for self-service). */
    requiredApprovals: integer('required_approvals').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    expiryNotifiedAt: timestamp('expiry_notified_at', { withTimezone: true }),
    usageCount: integer('usage_count').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('delegations_number_uq').on(t.organizationId, t.delegationNumber),
    index('delegations_delegate_idx').on(t.delegateUserId, t.status, t.companyId),
    index('delegations_delegator_idx').on(t.delegatorUserId, t.status),
    index('delegations_window_idx').on(t.status, t.endAt),
    check('delegations_window_chk', sql`${t.endAt} > ${t.startAt}`),
    check('delegations_self_chk', sql`${t.delegatorUserId} <> ${t.delegateUserId}`),
  ],
);

export const delegationScopes = pgTable(
  'delegation_scopes',
  {
    id: primaryId(),
    delegationId: uuid('delegation_id')
      .notNull()
      .references(() => delegations.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    maxAmount: money('max_amount'),
    currency: char('currency', { length: 3 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('delegation_scopes_uq').on(t.delegationId, t.permission, t.branchId),
    check('delegation_scopes_amount_chk', sql`${t.maxAmount} IS NULL OR ${t.maxAmount} > 0`),
  ],
);

export const delegationApprovals = pgTable(
  'delegation_approvals',
  {
    id: primaryId(),
    delegationId: uuid('delegation_id')
      .notNull()
      .references(() => delegations.id, { onDelete: 'cascade' }),
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decision: delegationDecisionEnum('decision').notNull(),
    comment: text('comment'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('delegation_approvals_uq').on(t.delegationId, t.approverUserId)],
);

/** Every exercise of delegated authority: who acted, for whom, on what. */
export const delegationUsage = pgTable(
  'delegation_usage',
  {
    id: primaryId(),
    delegationId: uuid('delegation_id')
      .notNull()
      .references(() => delegations.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    delegateUserId: uuid('delegate_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    delegatorUserId: uuid('delegator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    permission: text('permission').notNull(),
    action: text('action').notNull(),
    documentType: text('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    documentNumber: text('document_number'),
    amount: money('amount'),
    currency: char('currency', { length: 3 }),
    correlationId: text('correlation_id'),
    usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('delegation_usage_delegation_idx').on(t.delegationId, t.usedAt),
    index('delegation_usage_document_idx').on(t.documentType, t.documentId),
  ],
);

export const delegationPolicies = pgTable(
  'delegation_policies',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    approvalPolicy: delegationApprovalPolicyEnum('approval_policy')
      .notNull()
      .default('MANAGER_APPROVAL'),
    maxDurationDays: integer('max_duration_days').notNull().default(90),
    expiryWarningDays: integer('expiry_warning_days').notNull().default(2),
    revalidateAtUse: boolean('revalidate_at_use').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('delegation_policies_org_uq').on(t.organizationId)],
);

export type Delegation = typeof delegations.$inferSelect;
export type DelegationScope = typeof delegationScopes.$inferSelect;
export type DelegationApproval = typeof delegationApprovals.$inferSelect;
export type DelegationUsage = typeof delegationUsage.$inferSelect;
export type DelegationPolicy = typeof delegationPolicies.$inferSelect;
