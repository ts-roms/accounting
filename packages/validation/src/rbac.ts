import { z } from 'zod';
import { PERMISSION_KEYS, SOD_ENFORCEMENTS, type PermissionKey } from '@accounting/types';
import { codeSchema, nameSchema, optionalText, paginationQuerySchema } from './primitives';

const permissionKeySchema = z
  .string()
  .refine((v): v is PermissionKey => (PERMISSION_KEYS as readonly string[]).includes(v), {
    message: 'Unknown permission key',
  });

export const createRoleSchema = z.object({
  key: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  permissions: z.array(permissionKeySchema).max(500).default([]),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const setRolePermissionsSchema = z.object({
  permissions: z.array(permissionKeySchema).max(500),
});
export type SetRolePermissionsInput = z.infer<typeof setRolePermissionsSchema>;

export const upsertSodPolicySchema = z
  .object({
    name: nameSchema,
    description: optionalText(500),
    permissionA: permissionKeySchema,
    permissionB: permissionKeySchema,
    enforcement: z.enum(SOD_ENFORCEMENTS),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.permissionA !== v.permissionB, {
    path: ['permissionB'],
    message: 'A policy must reference two different permissions',
  });
export type UpsertSodPolicyInput = z.infer<typeof upsertSodPolicySchema>;

export const listRolesQuerySchema = paginationQuerySchema;
