import { z } from 'zod';
import { dimensionRefsSchema, lineTaxSchema } from './dimensions';
import { exchangeRateValueSchema } from './enterprise';
import {
  ENTITY_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_TYPES,
  SUBLEDGER_DOCUMENT_STATUSES,
  SUBLEDGER_DOCUMENT_TYPES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import {
  addressSchema,
  codeSchema,
  optionalCurrencyCodeSchema,
  emailSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives';

// ------------------------------------------------------------------- parties

const partyBase = addressSchema.extend({
  code: codeSchema,
  name: nameSchema,
  legalName: optionalText(200),
  taxIdentificationNumber: optionalText(32),
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  phone: optionalText(40),
  contactPerson: optionalText(120),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  /** Currency the party is invoiced / billed in; defaults to the company base currency. */
  currency: optionalCurrencyCodeSchema,
  notes: optionalText(1000),
});

export const createCustomerSchema = partyBase.extend({
  creditLimit: amountSchema.nullable().optional(),
  defaultRevenueAccountId: uuidSchema.nullable().optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export const updateCustomerSchema = createCustomerSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const createVendorSchema = partyBase.extend({
  defaultExpenseAccountId: uuidSchema.nullable().optional(),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export const updateVendorSchema = createVendorSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const listPartiesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;

// ----------------------------------------------------------------- documents

export const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,4})?$/, 'Quantity must be a positive decimal');

/** Percentage 0-100 with up to 4 fractional digits. */
export const percentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Percent must be a decimal')
  .refine((v) => Number(v) <= 100, 'Percent cannot exceed 100');

/**
 * Quantity and unit price are decimals; the line amount is
 * quantity * unitPrice * (1 - discount%) rounded half-even to 4 places.
 */
export const documentLineSchema = dimensionRefsSchema.merge(lineTaxSchema).extend({
  description: z.string().trim().min(1, 'Description is required').max(300),
  quantity: quantitySchema.default('1'),
  unitPrice: amountSchema,
  discountPercent: percentSchema.default('0'),
  accountId: uuidSchema,
  branchId: uuidSchema.nullable().optional(),
  /** Set when the line fulfils a sales / purchase order line. */
  orderLineId: uuidSchema.optional(),
  /** Stocked product moved by this line (Phase 5); requires a warehouse for GOODS. */
  productId: uuidSchema.nullable().optional(),
  warehouseId: uuidSchema.nullable().optional(),
  lotNumber: optionalText(60),
  serialNumbers: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
});
export type DocumentLineInput = z.infer<typeof documentLineSchema>;

const documentBase = z.object({
  documentType: z.enum(SUBLEDGER_DOCUMENT_TYPES).default('INVOICE'),
  documentDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  reference: optionalText(100),
  description: optionalText(500),
  branchId: uuidSchema.nullable().optional(),
  /** Override of the document-currency -> base-currency rate (defaults to the rate table on the document date). */
  exchangeRate: exchangeRateValueSchema.optional(),
  lines: z.array(documentLineSchema).min(1, 'At least one line is required').max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

export const createInvoiceSchema = documentBase.extend({
  customerId: uuidSchema,
  /** Sales order being invoiced (lines must reference its lines). */
  salesOrderId: uuidSchema.optional(),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export const updateInvoiceSchema = createInvoiceSchema
  .omit({ idempotencyKey: true, documentType: true })
  .partial();
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

export const createBillSchema = documentBase.extend({
  vendorId: uuidSchema,
  /** Purchase order being billed - enables three-way matching. */
  purchaseOrderId: uuidSchema.optional(),
  /** The supplier's own invoice number - used for duplicate detection. */
  vendorInvoiceNumber: optionalText(60),
  scheduledPaymentDate: isoDateSchema.nullable().optional(),
});
export type CreateBillInput = z.infer<typeof createBillSchema>;
export const updateBillSchema = createBillSchema
  .omit({ idempotencyKey: true, documentType: true })
  .partial();
export type UpdateBillInput = z.infer<typeof updateBillSchema>;

export const voidDocumentSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
  /** Date of the reversing journal when the document was already posted. */
  reversalDate: isoDateSchema.optional(),
});
export type VoidDocumentInput = z.infer<typeof voidDocumentSchema>;

export const collectionUpdateSchema = z.object({
  promisedPaymentDate: isoDateSchema.nullable().optional(),
  collectionNotes: optionalText(1000),
});
export type CollectionUpdateInput = z.infer<typeof collectionUpdateSchema>;

export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  partyId: uuidSchema.optional(),
  documentType: z.enum(SUBLEDGER_DOCUMENT_TYPES).optional(),
  status: z.enum(SUBLEDGER_DOCUMENT_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  openOnly: queryBooleanSchema.optional(),
  overdueOnly: queryBooleanSchema.optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

// ------------------------------------------------------------------ payments

export const allocationInputSchema = z.object({
  documentId: uuidSchema,
  amount: amountSchema.refine((v) => Number(v) > 0, 'Allocation must be positive'),
});
export type AllocationInput = z.infer<typeof allocationInputSchema>;

export const createPaymentSchema = z.object({
  partyId: uuidSchema,
  paymentType: z.enum(PAYMENT_TYPES).default('PAYMENT'),
  paymentDate: isoDateSchema,
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
  /** Cash or bank GL account receiving / paying the money. */
  cashAccountId: uuidSchema,
  reference: optionalText(100),
  memo: optionalText(500),
  branchId: uuidSchema.nullable().optional(),
  /** Override of the payment-currency -> base-currency rate (defaults to the rate table on the payment date). */
  exchangeRate: exchangeRateValueSchema.optional(),
  allocations: z.array(allocationInputSchema).max(200).default([]),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export const updatePaymentSchema = createPaymentSchema.omit({ idempotencyKey: true }).partial();
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const listPaymentsQuerySchema = paginationQuerySchema.extend({
  partyId: uuidSchema.optional(),
  status: z.enum(['DRAFT', 'POSTED', 'VOID']).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

/** Apply an unallocated credit note (or on-account payment) to open documents later. */
export const allocateSchema = z.object({
  allocations: z.array(allocationInputSchema).min(1).max(200),
  /** Effective date of the allocation (defaults to today); also dates any realized FX entry. */
  allocationDate: isoDateSchema.optional(),
});
export type AllocateInput = z.infer<typeof allocateSchema>;

// ------------------------------------------------------------------- reports

export const agingQuerySchema = z.object({
  asOf: isoDateSchema,
  partyId: uuidSchema.optional(),
});
export type AgingQuery = z.infer<typeof agingQuerySchema>;

export const statementQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

export const reconciliationQuerySchema = z.object({
  asOf: isoDateSchema,
});
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;
