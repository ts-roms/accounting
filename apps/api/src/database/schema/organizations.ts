import { relations } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entityStatusEnum, primaryId, timestamps } from './_shared';

/**
 * Organization = tenant. Owns users, roles and one or more legal entities
 * (companies). Consolidation (Phase 8) happens at this level.
 */
export const organizations = pgTable('organizations', {
  id: primaryId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Reporting currency used for future consolidation. */
  baseCurrency: char('base_currency', { length: 3 }).notNull().default('PHP'),
  timezone: text('timezone').notNull().default('Asia/Manila'),
  status: entityStatusEnum('status').notNull().default('ACTIVE'),
  ...timestamps,
});

/**
 * Company = legal entity. Every accounting record (accounts, journals, periods,
 * invoices, ...) is scoped to exactly one company.
 */
export const companies = pgTable(
  'companies',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    /** Philippine TIN or equivalent registration number. */
    taxIdentificationNumber: text('tax_identification_number'),
    /** Functional currency of this legal entity's ledger. */
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('PHP'),
    /** 1 = January. Drives fiscal-year generation. */
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    province: text('province'),
    postalCode: text('postal_code'),
    country: char('country', { length: 2 }).notNull().default('PH'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('companies_org_code_uq').on(t.organizationId, t.code),
    index('companies_org_idx').on(t.organizationId),
    check('companies_fiscal_month_chk', sql`${t.fiscalYearStartMonth} BETWEEN 1 AND 12`),
    check('companies_currency_chk', sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isHeadOffice: boolean('is_head_office').notNull().default(false),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    province: text('province'),
    postalCode: text('postal_code'),
    country: char('country', { length: 2 }).notNull().default('PH'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('branches_company_code_uq').on(t.companyId, t.code),
    index('branches_company_idx').on(t.companyId),
  ],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  companies: many(companies),
}));

export const companiesRelations = relations(companies, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [companies.organizationId],
    references: [organizations.id],
  }),
  branches: many(branches),
}));

export const branchesRelations = relations(branches, ({ one }) => ({
  company: one(companies, { fields: [branches.companyId], references: [companies.id] }),
}));

export type Organization = typeof organizations.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
