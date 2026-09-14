import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { DIMENSION_TYPES } from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { companies } from './organizations';
import { users } from './users';

export const dimensionTypeEnum = pgEnum('dimension_type', DIMENSION_TYPES);

/**
 * Cost-accounting dimensions (department, cost center, project) in one table.
 * Journal and document lines reference them through typed columns; the service
 * checks that the referenced row has the matching type.
 */
export const dimensions = pgTable(
  'dimensions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    dimensionType: dimensionTypeEnum('dimension_type').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    parentId: uuid('parent_id').references((): AnyPgColumn => dimensions.id, {
      onDelete: 'restrict',
    }),
    startDate: date('start_date'),
    endDate: date('end_date'),
    managerUserId: uuid('manager_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('dimensions_company_type_code_uq').on(t.companyId, t.dimensionType, t.code),
    index('dimensions_company_type_idx').on(t.companyId, t.dimensionType, t.status),
    check('dimensions_dates_chk', sql`${t.endDate} IS NULL OR ${t.startDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);

/** Column fragment shared by journal lines, document lines, budget lines and claim lines. */
export const dimensionColumns = () => ({
  departmentId: uuid('department_id').references((): AnyPgColumn => dimensions.id, {
    onDelete: 'restrict',
  }),
  costCenterId: uuid('cost_center_id').references((): AnyPgColumn => dimensions.id, {
    onDelete: 'restrict',
  }),
  projectId: uuid('project_id').references((): AnyPgColumn => dimensions.id, {
    onDelete: 'restrict',
  }),
});

export type Dimension = typeof dimensions.$inferSelect;
export type NewDimension = typeof dimensions.$inferInsert;
