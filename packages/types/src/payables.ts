/**
 * Accounts payable and procure-to-pay (Prompt #7). Enumerations here are
 * mirrored as PostgreSQL enums; the shared AR/AP ones (document statuses,
 * payment statuses, payment methods) live in `subledger.ts` and the payment
 * term / aging bucket shapes are reused from `receivables.ts`.
 */

// -------------------------------------------------------------------- vendors

export const VENDOR_TYPES = [
  'SUPPLIER',
  'CONTRACTOR',
  'SERVICE_PROVIDER',
  'UTILITY',
  'GOVERNMENT',
  'EMPLOYEE',
  'OTHER',
] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

export const VENDOR_ADDRESS_TYPES = ['REMIT_TO', 'ORDER_FROM', 'RETURN_TO'] as const;
export type VendorAddressType = (typeof VENDOR_ADDRESS_TYPES)[number];

/** Vendor onboarding state; only APPROVED vendors can be ordered from or paid. */
export const VENDOR_STATUSES = ['PENDING', 'APPROVED', 'ON_HOLD', 'BLOCKED', 'INACTIVE'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const VENDOR_RISK_RATINGS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type VendorRiskRating = (typeof VENDOR_RISK_RATINGS)[number];

/** Why a vendor is on hold; a hold blocks new purchase orders, bills and payments. */
export const VENDOR_HOLD_REASONS = [
  'COMPLIANCE',
  'QUALITY',
  'DISPUTE',
  'DUPLICATE',
  'TAX_DOCUMENTS',
  'OTHER',
] as const;
export type VendorHoldReason = (typeof VENDOR_HOLD_REASONS)[number];

// ---------------------------------------------------------------- bill holds

/** Why a posted bill is excluded from payment. */
export const BILL_HOLD_REASONS = [
  'PRICE_DISCREPANCY',
  'QUANTITY_DISCREPANCY',
  'QUALITY_ISSUE',
  'MISSING_RECEIPT',
  'DUPLICATE_SUSPECTED',
  'VENDOR_DISPUTE',
  'DOCUMENTATION',
  'OTHER',
] as const;
export type BillHoldReason = (typeof BILL_HOLD_REASONS)[number];

export const BILL_HOLD_STATUSES = ['ACTIVE', 'RELEASED'] as const;
export type BillHoldStatus = (typeof BILL_HOLD_STATUSES)[number];

// -------------------------------------------------------------- payment runs

/**
 * Payment run lifecycle: a proposal selects open bills, approval locks the
 * selection, execution creates and posts one vendor payment per vendor.
 */
export const PAYMENT_RUN_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'EXECUTING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'CANCELLED',
] as const;
export type PaymentRunStatus = (typeof PAYMENT_RUN_STATUSES)[number];

export const PAYMENT_RUN_LINE_STATUSES = ['SELECTED', 'EXCLUDED', 'PAID', 'FAILED'] as const;
export type PaymentRunLineStatus = (typeof PAYMENT_RUN_LINE_STATUSES)[number];

/** How a run chooses which bills to propose. */
export const PAYMENT_RUN_SELECTION_MODES = [
  /** Every open, unheld bill due on or before the pay-through date. */
  'DUE',
  /** Due bills plus any bill whose early-payment discount is still available. */
  'DUE_OR_DISCOUNT',
  /** Only bills explicitly listed. */
  'MANUAL',
] as const;
export type PaymentRunSelectionMode = (typeof PAYMENT_RUN_SELECTION_MODES)[number];

// ----------------------------------------------------------------- accruals

/** Period-end AP accrual for goods / services received but not yet billed. */
export const AP_ACCRUAL_STATUSES = ['DRAFT', 'POSTED', 'REVERSED'] as const;
export type ApAccrualStatus = (typeof AP_ACCRUAL_STATUSES)[number];

export const AP_ACCRUAL_SOURCES = [
  /** Non-stock purchase-order lines received (confirmed) but not billed. */
  'RECEIVED_NOT_BILLED',
  /** Manually supplied accrual lines (contracts, utilities without a PO). */
  'MANUAL',
] as const;
export type ApAccrualSource = (typeof AP_ACCRUAL_SOURCES)[number];

// --------------------------------------------------------------- remittance

export const REMITTANCE_FORMATS = ['CSV', 'REMITTANCE_ADVICE'] as const;
export type RemittanceFormat = (typeof REMITTANCE_FORMATS)[number];

// ------------------------------------------------------------ AP settings

/** Default cash-requirements horizons for the AP dashboard, in days. */
export const DEFAULT_CASH_REQUIREMENT_HORIZONS = [7, 30, 60] as const;
