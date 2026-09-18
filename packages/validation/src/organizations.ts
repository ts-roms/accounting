import { z } from 'zod';
import { ENTITY_STATUSES } from '@accounting/types';
import {
  addressSchema,
  codeSchema,
  currencyCodeSchema,
  optionalCurrencyCodeSchema,
  nameSchema,
  optionalText,
  uuidSchema,
} from './primitives.js';

export const updateOrganizationSchema = z.object({
  name: nameSchema.optional(),
  baseCurrency: optionalCurrencyCodeSchema,
  timezone: z.string().trim().min(1).max(64).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const createCompanySchema = addressSchema.extend({
  code: codeSchema,
  name: nameSchema,
  legalName: optionalText(200),
  taxIdentificationNumber: optionalText(32),
  baseCurrency: currencyCodeSchema,
  /** 1 = January. Used when generating fiscal years in Phase 2. */
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(1),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const createBranchSchema = addressSchema.extend({
  companyId: uuidSchema,
  code: codeSchema,
  name: nameSchema,
  isHeadOffice: z.boolean().default(false),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = createBranchSchema
  .omit({ companyId: true })
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
