import { z } from 'zod';
import { USER_STATUSES } from '@accounting/types';
import {
  emailSchema,
  nameSchema,
  passwordSchema,
  paginationQuerySchema,
  uuidSchema,
} from './primitives';

export const createUserSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  password: passwordSchema,
  /** Role ids to assign at creation (organization-wide scope). */
  roleIds: z.array(uuidSchema).max(20).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  email: emailSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setUserStatusSchema = z.object({
  status: z.enum(USER_STATUSES),
  reason: z.string().trim().max(500).optional(),
});
export type SetUserStatusInput = z.infer<typeof setUserStatusSchema>;

export const assignUserRoleSchema = z.object({
  roleId: uuidSchema,
  /** null / omitted = organization-wide assignment. */
  companyId: uuidSchema.nullable().optional(),
});
export type AssignUserRoleInput = z.infer<typeof assignUserRoleSchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
