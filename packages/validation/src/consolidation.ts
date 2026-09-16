import { z } from 'zod';
import {
  CONSOLIDATION_ADJUSTMENT_TYPES,
  CONSOLIDATION_GROUP_STATUSES,
  CONSOLIDATION_METHODS,
  CONSOLIDATION_RUN_STATUSES,
  ELIMINATION_RULE_TYPES,
  TRANSLATION_METHODS,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import { exchangeRateValueSchema } from './enterprise';
import {
  codeSchema,
  nameSchema,
  optionalCurrencyCodeSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives';
import { percentSchema } from './subledger';

const accountCode = z.string().trim().min(1).max(40);

// ------------------------------------------------------------------- groups

/** Account codes the group posts consolidation entries to; blank = the parent's mapped account. */
export const consolidationGroupAccountsSchema = z.object({
  cumulativeTranslationAdjustment: accountCode.optional(),
  nonControllingInterest: accountCode.optional(),
  goodwill: accountCode.optional(),
  retainedEarnings: accountCode.optional(),
  intercompanyDifference: accountCode.optional(),
  shareOfAssociateProfit: accountCode.optional(),
  investment: accountCode.optional(),
});

export const createConsolidationGroupSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  /** The parent entity whose chart of accounts presents the group and whose mappings supply default accounts. */
  parentCompanyId: uuidSchema,
  presentationCurrency: optionalCurrencyCodeSchema,
  translationMethod: z.enum(TRANSLATION_METHODS).default('CURRENT_RATE'),
  /** Intercompany pairs may differ by up to this much (presentation currency) before the group close is blocked. */
  intercompanyTolerance: amountSchema.optional(),
  /** Every member's fiscal period must be closed before a run can be finalized. */
  requirePeriodsClosed: z.boolean().default(true),
  accounts: consolidationGroupAccountsSchema.optional(),
  notes: optionalText(1000),
});
export type CreateConsolidationGroupInput = z.infer<typeof createConsolidationGroupSchema>;

export const updateConsolidationGroupSchema = createConsolidationGroupSchema
  .omit({ code: true, parentCompanyId: true })
  .partial()
  .extend({ status: z.enum(CONSOLIDATION_GROUP_STATUSES).optional() });
export type UpdateConsolidationGroupInput = z.infer<typeof updateConsolidationGroupSchema>;

export const consolidationMemberSchema = z
  .object({
    companyId: uuidSchema,
    method: z.enum(CONSOLIDATION_METHODS).default('FULL'),
    ownershipPercent: percentSchema,
    acquisitionDate: isoDateSchema.nullable().optional(),
    disposalDate: isoDateSchema.nullable().optional(),
    /** Subsidiary equity at acquisition, in the subsidiary's currency (share capital + pre-acquisition reserves). */
    acquisitionEquity: amountSchema.optional(),
    /** Cost of the parent's investment, in the parent's currency. */
    investmentCost: amountSchema.optional(),
    /** Historical rate (member currency -> presentation) for equity and the investment; defaults to the rate on the acquisition date. */
    historicalRate: exchangeRateValueSchema.nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    notes: optionalText(500),
  })
  .refine((m) => !(m.disposalDate && m.acquisitionDate && m.disposalDate < m.acquisitionDate), {
    message: 'Disposal cannot precede acquisition',
    path: ['disposalDate'],
  });
export type ConsolidationMemberInput = z.infer<typeof consolidationMemberSchema>;

export const updateConsolidationMemberSchema = z.object({
  method: z.enum(CONSOLIDATION_METHODS).optional(),
  ownershipPercent: percentSchema.optional(),
  acquisitionDate: isoDateSchema.nullable().optional(),
  disposalDate: isoDateSchema.nullable().optional(),
  acquisitionEquity: amountSchema.nullable().optional(),
  investmentCost: amountSchema.nullable().optional(),
  historicalRate: exchangeRateValueSchema.nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  notes: optionalText(500),
});
export type UpdateConsolidationMemberInput = z.infer<typeof updateConsolidationMemberSchema>;

// -------------------------------------------------------------------- rules

const ruleLineSchema = z
  .object({
    accountCode,
    debit: amountSchema.optional(),
    credit: amountSchema.optional(),
    description: optionalText(200),
    companyId: uuidSchema.nullable().optional(),
  })
  .refine((l) => Boolean(Number(l.debit ?? 0)) !== Boolean(Number(l.credit ?? 0)), {
    message: 'A line is either a debit or a credit',
    path: ['debit'],
  });

export const eliminationRuleConfigSchema = z.object({
  revenueCodes: z.array(accountCode).max(50).optional(),
  expenseCodes: z.array(accountCode).max(50).optional(),
  amount: amountSchema.optional(),
  inventoryCode: accountCode.optional(),
  costOfSalesCode: accountCode.optional(),
  lines: z.array(ruleLineSchema).max(50).optional(),
});

export const createEliminationRuleSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    type: z.enum(ELIMINATION_RULE_TYPES),
    description: optionalText(500),
    autoApply: z.boolean().default(true),
    config: eliminationRuleConfigSchema.default({}),
  })
  .superRefine((r, ctx) => {
    if (
      r.type === 'INTERCOMPANY_PROFIT_LOSS' &&
      !(r.config.revenueCodes?.length && r.config.expenseCodes?.length)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: 'Intercompany P&L rules need revenue and expense codes',
      });
    if (r.type === 'UNREALIZED_PROFIT' && !(r.config.inventoryCode && r.config.costOfSalesCode))
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: 'Unrealized profit rules need inventory and cost of sales codes',
      });
    if (r.type === 'CUSTOM' && !r.config.lines?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: 'Custom rules need template lines',
      });
  });
export type CreateEliminationRuleInput = z.infer<typeof createEliminationRuleSchema>;

export const updateEliminationRuleSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  autoApply: z.boolean().optional(),
  active: z.boolean().optional(),
  config: eliminationRuleConfigSchema.optional(),
});
export type UpdateEliminationRuleInput = z.infer<typeof updateEliminationRuleSchema>;

// --------------------------------------------------------------------- runs

export const createConsolidationRunSchema = z
  .object({
    /** Defaults to the parent's fiscal year start (runs are year-to-date). */
    periodStart: isoDateSchema.optional(),
    periodEnd: isoDateSchema,
    description: optionalText(200),
    /** Override rates (member currency -> presentation) keyed by company id. */
    rates: z
      .record(
        uuidSchema,
        z.object({
          closing: exchangeRateValueSchema.optional(),
          average: exchangeRateValueSchema.optional(),
          historical: exchangeRateValueSchema.optional(),
        }),
      )
      .optional(),
  })
  .refine((r) => !r.periodStart || r.periodEnd >= r.periodStart, {
    message: 'Period end precedes start',
    path: ['periodEnd'],
  });
export type CreateConsolidationRunInput = z.infer<typeof createConsolidationRunSchema>;

export const listConsolidationRunsQuerySchema = paginationQuerySchema.extend({
  groupId: uuidSchema.optional(),
  status: z.enum(CONSOLIDATION_RUN_STATUSES).optional(),
});
export type ListConsolidationRunsQuery = z.infer<typeof listConsolidationRunsQuerySchema>;

export const consolidationAdjustmentLineSchema = z
  .object({
    accountCode,
    /** The member the line belongs to; null = a group-level line. */
    companyId: uuidSchema.nullable().optional(),
    debit: amountSchema.optional(),
    credit: amountSchema.optional(),
    description: optionalText(200),
  })
  .refine((l) => Boolean(Number(l.debit ?? 0)) !== Boolean(Number(l.credit ?? 0)), {
    message: 'A line is either a debit or a credit',
    path: ['debit'],
  });

export const createConsolidationAdjustmentSchema = z.object({
  type: z.enum(CONSOLIDATION_ADJUSTMENT_TYPES).default('MANUAL'),
  description: z.string().trim().min(1).max(300),
  reference: optionalText(100),
  lines: z.array(consolidationAdjustmentLineSchema).min(2).max(100),
});
export type CreateConsolidationAdjustmentInput = z.infer<
  typeof createConsolidationAdjustmentSchema
>;

export const finalizeConsolidationRunSchema = z.object({ note: optionalText(500) });
export type FinalizeConsolidationRunInput = z.infer<typeof finalizeConsolidationRunSchema>;

export const reopenConsolidationRunSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type ReopenConsolidationRunInput = z.infer<typeof reopenConsolidationRunSchema>;

export const consolidatedStatementQuerySchema = z.object({
  /** Include member columns (default true). */
  detail: queryBooleanSchema.optional(),
});
export type ConsolidatedStatementQuery = z.infer<typeof consolidatedStatementQuerySchema>;

// ------------------------------------------------------------- intercompany

export const settleIntercompanySchema = z.object({
  settlementDate: isoDateSchema,
  /** Bank account of the paying (originating) company. */
  fromBankAccountId: uuidSchema,
  /** Bank account of the receiving company. */
  toBankAccountId: uuidSchema,
  reference: optionalText(100),
});
export type SettleIntercompanyInput = z.infer<typeof settleIntercompanySchema>;

export const intercompanyReconciliationQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  groupId: uuidSchema.optional(),
  currency: optionalCurrencyCodeSchema,
});
export type IntercompanyReconciliationQuery = z.infer<typeof intercompanyReconciliationQuerySchema>;

export const groupReadinessQuerySchema = z.object({
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
});
export type GroupReadinessQuery = z.infer<typeof groupReadinessQuerySchema>;
