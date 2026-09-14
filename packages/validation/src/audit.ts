import { z } from 'zod';
import { AUDIT_ACTIONS } from '@accounting/types';
import { paginationQuerySchema, uuidSchema } from './primitives';

export const listAuditLogsQuerySchema = paginationQuerySchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  module: z.string().trim().max(64).optional(),
  entityType: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(64).optional(),
  userId: uuidSchema.optional(),
  companyId: uuidSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
