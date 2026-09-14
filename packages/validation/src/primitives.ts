import { z } from 'zod';

export const uuidSchema = z.uuid({ message: 'Must be a valid UUID' });
export const emailSchema = z
  .email({ message: 'Must be a valid email address' })
  .max(254)
  .transform((v) => v.trim().toLowerCase());
export const currencyCodeSchema = z
  .string()
  .length(3, 'Currency must be a 3-letter ISO-4217 code')
  .regex(/^[A-Z]{3}$/, 'Currency must be uppercase letters')
  .default('PHP');

/** Currency that may be omitted: unlike `currencyCodeSchema`, absence stays `undefined` (no PHP default). */
export const optionalCurrencyCodeSchema = z
  .string()
  .length(3, 'Currency must be a 3-letter ISO-4217 code')
  .regex(/^[A-Z]{3}$/, 'Currency must be uppercase letters')
  .optional();

/** Short human-facing codes (company codes, branch codes, role keys...). */
export const codeSchema = z
  .string()
  .trim()
  .min(1, 'Code is required')
  .max(32, 'Code must be at most 32 characters')
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use uppercase letters, digits, "-" or "_"');

export const nameSchema = z.string().trim().min(1, 'Name is required').max(150);
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal('').transform(() => undefined));

/**
 * Passwords: minimum 10 chars with mixed classes. Kept deliberately simple - the
 * server additionally rate-limits and locks accounts after repeated failures.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v), {
    message: 'Password must contain upper-case, lower-case and numeric characters',
  });

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(200).optional(),
  sortBy: z.string().trim().max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const addressSchema = z.object({
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  province: optionalText(100),
  postalCode: optionalText(20),
  country: z.string().trim().length(2).toUpperCase().default('PH'),
});

/** Boolean from a query string: "true"/"1" are true, anything else false (z.coerce.boolean would make "false" true). */
export const queryBooleanSchema = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');
