import { z } from 'zod';
import {
  AP_ACCRUAL_SOURCES,
  AP_ACCRUAL_STATUSES,
  BILL_HOLD_REASONS,
  BILL_HOLD_STATUSES,
  ENTITY_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_RUN_SELECTION_MODES,
  PAYMENT_RUN_STATUSES,
  REMITTANCE_FORMATS,
  VENDOR_ADDRESS_TYPES,
  VENDOR_HOLD_REASONS,
  VENDOR_RISK_RATINGS,
  VENDOR_STATUSES,
  VENDOR_TYPES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting.js';
import { dimensionRefsSchema } from './dimensions.js';
import {
  addressSchema,
  codeSchema,
  emailSchema,
  nameSchema,
  optionalCurrencyCodeSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives.js';
import { agingBucketSchema } from './receivables.js';

// -------------------------------------------------------------- vendor groups

export const createVendorGroupSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  /** Payment term applied to vendors of the group without their own. */
  defaultPaymentTermId: uuidSchema.nullable().optional(),
  /** Withholding tax code applied by default to bills of the group's vendors. */
  defaultWithholdingTaxCodeId: uuidSchema.nullable().optional(),
  defaultExpenseAccountId: uuidSchema.nullable().optional(),
  /** Bills from this group require an explicit approval before posting. */
  requireBillApproval: z.boolean().default(false),
});
export type CreateVendorGroupInput = z.infer<typeof createVendorGroupSchema>;
export const updateVendorGroupSchema = createVendorGroupSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateVendorGroupInput = z.infer<typeof updateVendorGroupSchema>;

// ------------------------------------------------------------ vendor master

export const vendorContactSchema = z.object({
  name: nameSchema,
  title: optionalText(80),
  role: optionalText(80),
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  phone: optionalText(40),
  isPrimary: z.boolean().default(false),
  /** Receives remittance advices. */
  receivesRemittance: z.boolean().default(false),
  notes: optionalText(500),
});
export type VendorContactInput = z.infer<typeof vendorContactSchema>;

export const vendorAddressSchema = addressSchema.extend({
  addressType: z.enum(VENDOR_ADDRESS_TYPES),
  label: optionalText(80),
  attention: optionalText(120),
  isDefault: z.boolean().default(false),
});
export type VendorAddressInput = z.infer<typeof vendorAddressSchema>;

export const vendorBankAccountSchema = z.object({
  bankName: nameSchema,
  /** Human label, e.g. "Main operating account". */
  label: optionalText(80),
  accountName: nameSchema,
  /** Kept in full for payment files; the API only ever returns the masked form. */
  accountNumber: z.string().trim().min(4).max(34),
  /** Bank / branch routing identifier (BRSTN, SWIFT, IBAN ...). */
  routingCode: optionalText(34),
  currency: optionalCurrencyCodeSchema,
  isPrimary: z.boolean().default(false),
  notes: optionalText(500),
});
export type VendorBankAccountInput = z.infer<typeof vendorBankAccountSchema>;

export const vendorProfileSchema = z.object({
  riskRating: z.enum(VENDOR_RISK_RATINGS).optional(),
  /** Preferred settlement method for payment runs. */
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  /** Minimum amount before a payment run pays this vendor (small balances accumulate). */
  minimumPaymentAmount: amountSchema.nullable().optional(),
  /** Bills from this vendor always require an explicit approval before posting. */
  requireBillApproval: z.boolean().optional(),
  /** Bills from this vendor may be paid without a purchase order. */
  allowBillsWithoutPo: z.boolean().optional(),
  /** Next compliance / performance review. */
  reviewDate: isoDateSchema.nullable().optional(),
  notes: optionalText(1000),
});
export type VendorProfileInput = z.infer<typeof vendorProfileSchema>;

export const vendorHoldSchema = z.object({
  hold: z.boolean(),
  reason: z.enum(VENDOR_HOLD_REASONS).optional(),
  note: optionalText(500),
});
export type VendorHoldInput = z.infer<typeof vendorHoldSchema>;

export const vendorApprovalSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'BLOCK']),
  note: optionalText(500),
});
export type VendorApprovalInput = z.infer<typeof vendorApprovalSchema>;

export const listVendorsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ENTITY_STATUSES).optional(),
  vendorStatus: z.enum(VENDOR_STATUSES).optional(),
  vendorGroupId: uuidSchema.optional(),
  vendorType: z.enum(VENDOR_TYPES).optional(),
  onHold: queryBooleanSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type ListVendorsQuery = z.infer<typeof listVendorsQuerySchema>;

// ---------------------------------------------------------------- bill holds

export const billHoldSchema = z.object({
  reason: z.enum(BILL_HOLD_REASONS),
  note: optionalText(1000),
});
export type BillHoldInput = z.infer<typeof billHoldSchema>;

export const releaseBillHoldSchema = z.object({
  note: optionalText(1000),
});
export type ReleaseBillHoldInput = z.infer<typeof releaseBillHoldSchema>;

export const listBillHoldsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(BILL_HOLD_STATUSES).optional(),
  vendorId: uuidSchema.optional(),
  billId: uuidSchema.optional(),
});
export type ListBillHoldsQuery = z.infer<typeof listBillHoldsQuerySchema>;

// -------------------------------------------------------------- payment runs

export const createPaymentRunSchema = z.object({
  /** Cash or bank GL account the run pays from. */
  cashAccountId: uuidSchema,
  paymentDate: isoDateSchema,
  /** Bills due on or before this date are proposed (defaults to paymentDate). */
  payThroughDate: isoDateSchema.optional(),
  selectionMode: z.enum(PAYMENT_RUN_SELECTION_MODES).default('DUE_OR_DISCOUNT'),
  method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
  /** Restrict the proposal to one currency (defaults to the cash account's currency). */
  currency: optionalCurrencyCodeSchema,
  vendorIds: z.array(uuidSchema).max(200).optional(),
  vendorGroupId: uuidSchema.nullable().optional(),
  branchId: uuidSchema.nullable().optional(),
  /** MANUAL mode: the bills to pay. */
  billIds: z.array(uuidSchema).max(500).optional(),
  /** Upper bound on the run total; bills are proposed oldest-due first until it is reached. */
  maximumAmount: amountSchema.nullable().optional(),
  description: optionalText(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreatePaymentRunInput = z.infer<typeof createPaymentRunSchema>;

export const updatePaymentRunLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        billId: uuidSchema,
        /** Amount to pay on the bill; defaults to the full open balance less discount. */
        amount: amountSchema.optional(),
        /** Take the early-payment discount if it is still available. */
        takeDiscount: z.boolean().optional(),
        excluded: z.boolean().optional(),
      }),
    )
    .max(500),
});
export type UpdatePaymentRunLinesInput = z.infer<typeof updatePaymentRunLinesSchema>;

export const paymentRunDecisionSchema = z.object({
  note: optionalText(500),
});
export type PaymentRunDecisionInput = z.infer<typeof paymentRunDecisionSchema>;

export const listPaymentRunsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PAYMENT_RUN_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  cashAccountId: uuidSchema.optional(),
});
export type ListPaymentRunsQuery = z.infer<typeof listPaymentRunsQuerySchema>;

export const remittanceQuerySchema = z.object({
  format: z.enum(REMITTANCE_FORMATS).default('CSV'),
});
export type RemittanceQuery = z.infer<typeof remittanceQuerySchema>;

// ------------------------------------------------------------------ accruals

export const apAccrualLineSchema = z.object({
  vendorId: uuidSchema.nullable().optional(),
  orderId: uuidSchema.nullable().optional(),
  orderLineId: uuidSchema.nullable().optional(),
  description: z.string().trim().min(1).max(500),
  /** Expense (or asset) account debited by the accrual. */
  accountId: uuidSchema,
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  branchId: uuidSchema.nullable().optional(),
  dimensions: dimensionRefsSchema.optional(),
});
export type ApAccrualLineInput = z.infer<typeof apAccrualLineSchema>;

export const createApAccrualSchema = z.object({
  /** Period end the accrual is dated on. */
  accrualDate: isoDateSchema,
  /** First day of the next period - the reversal date. */
  reversalDate: isoDateSchema,
  source: z.enum(AP_ACCRUAL_SOURCES).default('RECEIVED_NOT_BILLED'),
  /** MANUAL source: the lines to accrue. RECEIVED_NOT_BILLED computes them. */
  lines: z.array(apAccrualLineSchema).max(500).optional(),
  description: optionalText(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateApAccrualInput = z.infer<typeof createApAccrualSchema>;

export const listApAccrualsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(AP_ACCRUAL_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListApAccrualsQuery = z.infer<typeof listApAccrualsQuerySchema>;

export const grniQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  vendorId: uuidSchema.optional(),
  /** Only lines older than this many days since receipt. */
  minAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
});
export type GrniQuery = z.infer<typeof grniQuerySchema>;

// ------------------------------------------------------------------ settings

export const apSettingsSchema = z.object({
  agingBuckets: z
    .array(agingBucketSchema)
    .min(2)
    .max(12)
    .refine((b) => b[0]!.to !== null && b[b.length - 1]!.to === null, {
      message: 'The last bucket must be open-ended (to = null) and the first bounded',
    })
    .refine(
      (b) => b.every((x, i) => i === 0 || x.from === (b[i - 1]!.to ?? Infinity) + 1),
      'Buckets must be contiguous',
    )
    .optional(),
  /** Days of purchases used for DPO (countback window). */
  dpoWindowDays: z.coerce.number().int().min(30).max(365).optional(),
  /** Cash-requirement horizons shown on the dashboard, in days. */
  cashRequirementHorizons: z
    .array(z.coerce.number().int().min(1).max(365))
    .min(1)
    .max(6)
    .optional(),
  /** Warn this many days before a bill falls due. */
  dueSoonDays: z.coerce.number().int().min(0).max(90).optional(),
  /** Warn this many days before an early-payment discount lapses. */
  discountWarnDays: z.coerce.number().int().min(0).max(30).optional(),
  /** GRNI lines older than this are flagged. */
  grniAgeWarnDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Vendor payments must be approved before posting. */
  requirePaymentApproval: z.boolean().optional(),
  /** Payment runs must be approved before execution. */
  requireRunApproval: z.boolean().optional(),
  /** Bills above this amount always require an explicit approval before posting. */
  billApprovalThreshold: amountSchema.nullable().optional(),
  /** New vendors start PENDING and must be approved before use. */
  requireVendorApproval: z.boolean().optional(),
  /** Bills for stocked goods must reference a purchase order. */
  requirePoForStockBills: z.boolean().optional(),
  /** Bills are blocked (not just warned) when a duplicate vendor invoice number exists. */
  blockDuplicateVendorInvoice: z.boolean().optional(),
  defaultPaymentTermId: uuidSchema.nullable().optional(),
  defaultCashAccountId: uuidSchema.nullable().optional(),
});
export type ApSettingsInput = z.infer<typeof apSettingsSchema>;

// ------------------------------------------------------------------- reports

export const apDashboardQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
});
export type ApDashboardQuery = z.infer<typeof apDashboardQuerySchema>;

export const cashRequirementsQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  /** Horizon in days (defaults to the configured horizons). */
  days: z.coerce.number().int().min(1).max(365).optional(),
  vendorId: uuidSchema.optional(),
  currency: optionalCurrencyCodeSchema,
});
export type CashRequirementsQuery = z.infer<typeof cashRequirementsQuerySchema>;

export const vendorStatementsQuerySchema = z.object({
  vendorId: uuidSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: uuidSchema.optional(),
});
export type VendorStatementsQuery = z.infer<typeof vendorStatementsQuerySchema>;
