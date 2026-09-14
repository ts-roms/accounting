/** Shared enumerations for the AR and AP subledgers (mirrored as PostgreSQL enums). */

/** INVOICE = customer invoice / vendor bill; credit notes reduce, debit notes increase the balance. */
export const SUBLEDGER_DOCUMENT_TYPES = ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const;
export type SubledgerDocumentType = (typeof SUBLEDGER_DOCUMENT_TYPES)[number];

/** Business status - independent of the accounting status. */
export const SUBLEDGER_DOCUMENT_STATUSES = [
  'DRAFT',
  'APPROVED',
  'PARTIALLY_PAID',
  'PAID',
  'VOID',
] as const;
export type SubledgerDocumentStatus = (typeof SUBLEDGER_DOCUMENT_STATUSES)[number];

/** Accounting status of a business document. */
export const ACCOUNTING_STATUSES = ['UNPOSTED', 'POSTED', 'REVERSED'] as const;
export type AccountingStatus = (typeof ACCOUNTING_STATUSES)[number];

export const PAYMENT_STATUSES = ['DRAFT', 'POSTED', 'VOID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** PAYMENT = money in (AR receipt) / money out (AP disbursement); REFUND is the opposite direction. */
export const PAYMENT_TYPES = ['PAYMENT', 'REFUND'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CHECK',
  'CARD',
  'ONLINE',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const AGING_BUCKETS = [
  { key: 'current', label: 'Current', from: -Infinity, to: 0 },
  { key: 'days1to30', label: '1-30', from: 1, to: 30 },
  { key: 'days31to60', label: '31-60', from: 31, to: 60 },
  { key: 'days61to90', label: '61-90', from: 61, to: 90 },
  { key: 'over90', label: '90+', from: 91, to: Infinity },
] as const;
export type AgingBucketKey = (typeof AGING_BUCKETS)[number]['key'];

/** Documents whose balances are still part of the subledger. */
export const OPEN_DOCUMENT_STATUSES: readonly SubledgerDocumentStatus[] = [
  'APPROVED',
  'PARTIALLY_PAID',
];
