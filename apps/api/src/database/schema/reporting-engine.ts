import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { REPORT_BASES, REPORT_CATEGORIES } from '@accounting/types';
import type { ReportLayoutInput } from '@accounting/validation';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { companies } from './organizations';
import { users } from './users';

export const reportBasisEnum = pgEnum('report_basis', REPORT_BASES);
export const reportCategoryEnum = pgEnum('report_category', REPORT_CATEGORIES);

/**
 * Report definitions for the reporting engine (hardening H7): rows (account
 * selectors, formulas, dimension groups), columns (current / prior / YTD /
 * prior year / budget / variance) and default filters, stored as validated
 * JSON. System definitions are seeded per company and can be copied; every
 * run reads the ledger through the report services - nothing is stored.
 */
export const reportDefinitions = pgTable(
  'report_definitions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: reportCategoryEnum('category').notNull().default('CUSTOM'),
    basis: reportBasisEnum('basis').notNull().default('PERIOD'),
    layout: jsonb('layout').$type<ReportLayoutInput>().notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('report_definitions_company_code_uq').on(t.companyId, t.code),
    index('report_definitions_company_idx').on(t.companyId, t.category, t.status),
  ],
);

export type ReportDefinition = typeof reportDefinitions.$inferSelect;
