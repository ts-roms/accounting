import { z } from 'zod';
import { uuidSchema } from './primitives.js';

/** Department / cost center / project references carried by journal and document lines. */
export const dimensionRefsSchema = z.object({
  departmentId: uuidSchema.nullable().optional(),
  costCenterId: uuidSchema.nullable().optional(),
  projectId: uuidSchema.nullable().optional(),
});
export type DimensionRefs = z.infer<typeof dimensionRefsSchema>;

/** Tax fields on invoice / bill / claim lines. */
export const lineTaxSchema = z.object({
  taxCodeId: uuidSchema.nullable().optional(),
  withholdingTaxCodeId: uuidSchema.nullable().optional(),
});
export type LineTaxInput = z.infer<typeof lineTaxSchema>;
