import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  TAX_APPLIES_TO,
  TAX_KINDS,
  TAX_REPORTING_CATEGORIES,
  TAX_SIDES,
  TAX_SOURCE_TYPES,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { companies } from './organizations';

export const taxKindEnum = pgEnum('tax_kind', TAX_KINDS);
export const taxSideEnum = pgEnum('tax_side', TAX_SIDES);
export const taxAppliesToEnum = pgEnum('tax_applies_to', TAX_APPLIES_TO);
export const taxReportingCategoryEnum = pgEnum('tax_reporting_category', TAX_REPORTING_CATEGORIES);
export const taxSourceTypeEnum = pgEnum('tax_source_type', TAX_SOURCE_TYPES);

/**
 * Tax rules are data. A tax code names the accounts the engine posts to on each
 * side; its rates are effective-dated so a rate change never rewrites history.
 */
export const taxCodes = pgTable(
  'tax_codes',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: taxKindEnum('kind').notNull(),
    appliesTo: taxAppliesToEnum('applies_to').notNull(),
    reportingCategory: taxReportingCategoryEnum('reporting_category').notNull(),
    /** Sales side: output tax payable (sales tax) or creditable withholding receivable (withholding). */
    salesAccountId: uuid('sales_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Purchase side: input tax receivable (sales tax) or withholding tax payable (withholding). */
    purchaseAccountId: uuid('purchase_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    isDefaultSales: boolean('is_default_sales').notNull().default(false),
    isDefaultPurchases: boolean('is_default_purchases').notNull().default(false),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tax_codes_company_code_uq').on(t.companyId, t.code),
    index('tax_codes_company_idx').on(t.companyId, t.status),
    check(
      'tax_codes_accounts_chk',
      sql`(${t.appliesTo} = 'PURCHASES' OR ${t.salesAccountId} IS NOT NULL) AND (${t.appliesTo} = 'SALES' OR ${t.purchaseAccountId} IS NOT NULL)`,
    ),
  ],
);

export const taxRates = pgTable(
  'tax_rates',
  {
    id: primaryId(),
    taxCodeId: uuid('tax_code_id')
      .notNull()
      .references(() => taxCodes.id, { onDelete: 'cascade' }),
    ratePercent: money('rate_percent').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tax_rates_code_from_uq').on(t.taxCodeId, t.effectiveFrom),
    check('tax_rates_rate_chk', sql`${t.ratePercent} >= 0 AND ${t.ratePercent} <= 100`),
    check(
      'tax_rates_range_chk',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * Append-only record of every tax amount the engine posted, one row per
 * document line and tax code. Reversals insert negated rows that point back to
 * the original, so a period's return is a plain SUM over transaction dates.
 */
export const taxTransactions = pgTable(
  'tax_transactions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    taxCodeId: uuid('tax_code_id')
      .notNull()
      .references(() => taxCodes.id, { onDelete: 'restrict' }),
    side: taxSideEnum('side').notNull(),
    sourceType: taxSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceLineId: uuid('source_line_id'),
    documentNumber: text('document_number').notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    /** Customer, vendor or employee the tax relates to (no FK - polymorphic). */
    partyId: uuid('party_id'),
    partyName: text('party_name'),
    partyTaxNumber: text('party_tax_number'),
    transactionDate: date('transaction_date').notNull(),
    ratePercent: money('rate_percent').notNull(),
    /** Signed: credit notes and reversals carry negative amounts. */
    baseAmount: money('base_amount').notNull(),
    taxAmount: money('tax_amount').notNull(),
    reversalOfId: uuid('reversal_of_id'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('tax_transactions_company_date_idx').on(t.companyId, t.transactionDate),
    index('tax_transactions_code_idx').on(t.taxCodeId, t.transactionDate),
    index('tax_transactions_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export type TaxCode = typeof taxCodes.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type TaxTransaction = typeof taxTransactions.$inferSelect;
export type NewTaxTransaction = typeof taxTransactions.$inferInsert;
