import { sql } from 'drizzle-orm';
import { pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';
import { AUDIT_ACTIONS, ENTITY_STATUSES, SOD_ENFORCEMENTS, USER_STATUSES } from '@accounting/types';

/**
 * Column fragments reused by every table. `timestamptz` everywhere for system
 * events; business dates (transaction_date, posting_date, ...) will use `date`
 * columns in the accounting schema (Phase 2).
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const entityStatusEnum = pgEnum('entity_status', ENTITY_STATUSES);
export const userStatusEnum = pgEnum('user_status', USER_STATUSES);
export const auditActionEnum = pgEnum('audit_action', AUDIT_ACTIONS);
export const sodEnforcementEnum = pgEnum('sod_enforcement', SOD_ENFORCEMENTS);
