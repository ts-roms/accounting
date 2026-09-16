import { z } from 'zod';
import { ACCOUNT_TYPES, CONSOLIDATION_METHODS, ENTITY_STATUSES } from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import { codeSchema, currencyCodeSchema, nameSchema, optionalText, uuidSchema } from './primitives';

// -------------------------------------------------- consolidation groups (H9)

const ownershipPctSchema = z.coerce
  .number()
  .gt(0, 'Ownership must be above 0%')
  .max(100, 'Ownership cannot exceed 100%');

export const groupMemberSchema = z.object({
  companyId: uuidSchema,
  ownershipPct: ownershipPctSchema.default(100),
  method: z.enum(CONSOLIDATION_METHODS).default('FULL'),
});
export type GroupMemberInput = z.infer<typeof groupMemberSchema>;

export const createConsolidationGroupSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  presentationCurrency: currencyCodeSchema,
  parentCompanyId: uuidSchema,
  /** The parent is always a member at 100%; list the subsidiaries here. */
  members: z.array(groupMemberSchema).max(100).default([]),
});
export type CreateConsolidationGroupInput = z.infer<typeof createConsolidationGroupSchema>;

export const updateConsolidationGroupSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  presentationCurrency: currencyCodeSchema.optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
  members: z.array(groupMemberSchema).max(100).optional(),
});
export type UpdateConsolidationGroupInput = z.infer<typeof updateConsolidationGroupSchema>;

// ------------------------------------------------------ group chart of accounts

export const groupAccountSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: nameSchema,
  type: z.enum(ACCOUNT_TYPES),
  isIntercompany: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).default(0),
});
export type GroupAccountInput = z.infer<typeof groupAccountSchema>;

export const updateGroupAccountSchema = groupAccountSchema.partial();

/** Replace the mappings of one member company: each account id -> group account id (null unmaps). */
export const groupMappingsSchema = z.object({
  companyId: uuidSchema,
  mappings: z
    .array(z.object({ accountId: uuidSchema, groupAccountId: uuidSchema.nullable() }))
    .max(2000),
});
export type GroupMappingsInput = z.infer<typeof groupMappingsSchema>;

export const autoMapSchema = z.object({
  /** Limit to one member; default every member. */
  companyId: uuidSchema.optional(),
  /** Create missing group accounts from the member's chart instead of leaving accounts unmapped. */
  createMissing: z.boolean().default(false),
});
export type AutoMapInput = z.infer<typeof autoMapSchema>;

// ------------------------------------------------------------- adjustments

export const consolidationAdjustmentLineSchema = z
  .object({
    groupAccountId: uuidSchema,
    debit: amountSchema.default('0'),
    credit: amountSchema.default('0'),
    description: optionalText(200),
  })
  .refine((l) => (Number(l.debit) > 0) !== (Number(l.credit) > 0), {
    message: 'A line is either a debit or a credit',
    path: ['debit'],
  });

export const createConsolidationAdjustmentSchema = z
  .object({
    effectiveDate: isoDateSchema,
    recurringUntil: isoDateSchema.nullable().optional(),
    reference: optionalText(60),
    description: z.string().trim().min(1).max(500),
    lines: z.array(consolidationAdjustmentLineSchema).min(2).max(200),
  })
  .refine(
    (a) => !a.recurringUntil || a.recurringUntil >= a.effectiveDate,
    { message: 'recurringUntil must not be before effectiveDate', path: ['recurringUntil'] },
  )
  .refine(
    (a) => {
      const sum = (k: 'debit' | 'credit') =>
        a.lines.reduce((n, l) => n + Math.round(Number(l[k]) * 10_000), 0);
      return sum('debit') === sum('credit');
    },
    { message: 'Adjustment lines must balance', path: ['lines'] },
  );
export type CreateConsolidationAdjustmentInput = z.infer<typeof createConsolidationAdjustmentSchema>;

// --------------------------------------------------------------- runs / reports

export const consolidationWindowSchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((w) => w.from <= w.to, { message: '"from" must not be after "to"', path: ['to'] });
export type ConsolidationWindow = z.infer<typeof consolidationWindowSchema>;

export const listConsolidationRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
