import {
  bigint,
  bigserial,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditActionEnum } from './_shared';
import { companies, organizations } from './organizations';
import { users } from './users';

/**
 * Append-only audit trail. A database trigger (see migration
 * `0001_audit_log_immutability`) rejects UPDATE and DELETE on this table so the
 * history cannot be casually edited even by the application role.
 *
 * `bigserial` gives a monotonically increasing sequence which is convenient for
 * incremental export and ordering; the `id` is never exposed as a public key.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalised so the trail stays readable if the user record changes. */
    userEmail: text('user_email'),
    action: auditActionEnum('action').notNull(),
    module: text('module').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    previousValue: jsonb('previous_value'),
    newValue: jsonb('new_value'),
    metadata: jsonb('metadata'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    correlationId: text('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_occurred_idx').on(t.organizationId, t.occurredAt),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_user_idx').on(t.userId),
    index('audit_logs_correlation_idx').on(t.correlationId),
  ],
);

/**
 * Field-level change history of financial records, derived from audit events
 * that carry a before / after value: one row per changed field. Immutable like
 * the audit trail (trigger in migration `0015_enterprise_controls`).
 */
export const fieldChanges = pgTable(
  'field_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    auditLogId: bigint('audit_log_id', { mode: 'number' })
      .notNull()
      .references(() => auditLogs.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    previousValue: jsonb('previous_value'),
    newValue: jsonb('new_value'),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    changedByEmail: text('changed_by_email'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('field_changes_entity_idx').on(t.entityType, t.entityId, t.changedAt),
    index('field_changes_company_idx').on(t.companyId, t.changedAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type FieldChange = typeof fieldChanges.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
