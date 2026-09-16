import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { IMPORT_STATUSES, IMPORT_TYPES } from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { branches, companies } from './organizations';
import { users } from './users';

export const importTypeEnum = pgEnum('import_type', IMPORT_TYPES);
export const importStatusEnum = pgEnum('import_status', IMPORT_STATUSES);

/** One validated row of an import: the parsed values, its errors and the record it created. */
export interface ImportRow {
  line: number;
  values: Record<string, string>;
  errors: string[];
  /** Id of the record created by the commit (master data) or the document number. */
  result?: string | null;
}

/**
 * A CSV import: parsed and validated on upload (rows + errors are stored so
 * the preview is what gets committed), then committed once. Financial types
 * (journals, opening balances, bank transactions) commit atomically; master
 * data commits row by row and reports per-row outcomes.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    type: importTypeEnum('type').notNull(),
    status: importStatusEnum('status').notNull().default('VALIDATED'),
    fileName: text('file_name').notNull(),
    /** Options given at upload (asOfDate, branchId). */
    options: jsonb('options').notNull().default({}),
    rowCount: integer('row_count').notNull().default(0),
    validCount: integer('valid_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    rows: jsonb('rows').$type<ImportRow[]>().notNull().default([]),
    /** Commit outcome: counts, created ids, failure message. */
    result: jsonb('result').notNull().default({}),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    committedBy: uuid('committed_by').references(() => users.id, { onDelete: 'set null' }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('import_jobs_company_idx').on(t.companyId, t.createdAt)],
);

export type ImportJob = typeof importJobs.$inferSelect;
