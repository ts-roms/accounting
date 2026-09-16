import { z } from 'zod';
import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  BANK_TRANSACTION_TYPES,
  COSTING_METHODS,
  PRODUCT_TYPES,
  TRACKING_MODES,
  type ImportType,
} from '@accounting/types';

/** Column documentation shown with the template and the preview. */
export interface ImportColumn {
  key: string;
  required: boolean;
  description: string;
  example: string;
}

export interface ImportSpec {
  type: ImportType;
  title: string;
  /** Whether the whole file commits in one transaction (true) or row by row (false). */
  atomic: boolean;
  columns: ImportColumn[];
  /** Cell-level validation of one row (referential checks happen in the service). */
  row: z.ZodType<Record<string, unknown>>;
}

const optional = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));
const required = (max = 200) => z.string().trim().min(1, 'Required').max(max);
const code = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, . _ - only');
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const decimal = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'Decimal with up to 4 places');
const nonNegativeDecimal = decimal.refine((v) => Number(v) >= 0, 'Cannot be negative');
const optionalNonNegative = optional(30).pipe(nonNegativeDecimal.optional());
const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .trim()
    .transform((v) => v.toUpperCase().replace(/\s+/g, '_'))
    .pipe(z.enum(values));
const optionalInt = optional(10)
  .transform((v) => (v === undefined ? undefined : Number(v)))
  .pipe(z.number().int().min(0).optional());
const yesNo = optional(10).transform((v) =>
  v === undefined ? undefined : /^(y|yes|true|1)$/i.test(v),
);

export const IMPORT_SPECS: Record<ImportType, ImportSpec> = {
  CHART_OF_ACCOUNTS: {
    type: 'CHART_OF_ACCOUNTS',
    title: 'Chart of accounts',
    atomic: false,
    columns: [
      {
        key: 'code',
        required: true,
        description: 'Account code, unique per company',
        example: '1150',
      },
      { key: 'name', required: true, description: 'Account name', example: 'Petty Cash' },
      {
        key: 'type',
        required: true,
        description: `One of ${ACCOUNT_TYPES.join(', ')}`,
        example: 'ASSET',
      },
      { key: 'subtype', required: false, description: 'Account subtype', example: 'CASH' },
      {
        key: 'parent_code',
        required: false,
        description: 'Code of the header account',
        example: '1100',
      },
      {
        key: 'is_header',
        required: false,
        description: 'yes / no - groups children, not postable',
        example: 'no',
      },
      { key: 'description', required: false, description: 'Free text', example: 'Cash float' },
    ],
    row: z.object({
      code,
      name: required(200),
      type: upperEnum(ACCOUNT_TYPES),
      subtype: optional(40).pipe(upperEnum(ACCOUNT_SUBTYPES).optional()),
      parent_code: optional(40),
      is_header: yesNo,
      description: optional(500),
    }),
  },
  CUSTOMERS: {
    type: 'CUSTOMERS',
    title: 'Customers',
    atomic: false,
    columns: [
      {
        key: 'code',
        required: true,
        description: 'Customer code, unique per company',
        example: 'CUST-010',
      },
      { key: 'name', required: true, description: 'Trading name', example: 'Northwind Traders' },
      {
        key: 'legal_name',
        required: false,
        description: 'Registered name',
        example: 'Northwind Traders Inc.',
      },
      {
        key: 'tax_id',
        required: false,
        description: 'Tax identification number',
        example: '123-456-789-000',
      },
      { key: 'email', required: false, description: 'Billing email', example: 'ap@northwind.test' },
      { key: 'phone', required: false, description: 'Phone', example: '+63 2 8888 0000' },
      { key: 'contact_person', required: false, description: 'Contact', example: 'Ana Reyes' },
      {
        key: 'payment_terms_days',
        required: false,
        description: 'Default terms (days)',
        example: '30',
      },
      {
        key: 'credit_limit',
        required: false,
        description: 'Credit limit in base currency',
        example: '500000',
      },
      {
        key: 'currency',
        required: false,
        description: 'ISO currency; blank = company base',
        example: 'PHP',
      },
      {
        key: 'address_line1',
        required: false,
        description: 'Address line 1',
        example: '12 Rizal Ave',
      },
      { key: 'city', required: false, description: 'City', example: 'Makati' },
      { key: 'country', required: false, description: 'Country', example: 'PH' },
    ],
    row: z.object({
      code,
      name: required(200),
      legal_name: optional(200),
      tax_id: optional(32),
      email: optional(200).pipe(z.string().email().optional()),
      phone: optional(40),
      contact_person: optional(120),
      payment_terms_days: optionalInt,
      credit_limit: optionalNonNegative,
      currency: optional(3).pipe(
        z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
      ),
      address_line1: optional(200),
      city: optional(100),
      country: optional(2).pipe(
        z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
      ),
    }),
  },
  VENDORS: {
    type: 'VENDORS',
    title: 'Vendors',
    atomic: false,
    columns: [
      {
        key: 'code',
        required: true,
        description: 'Vendor code, unique per company',
        example: 'VEND-010',
      },
      { key: 'name', required: true, description: 'Trading name', example: 'Metro Office Supply' },
      {
        key: 'legal_name',
        required: false,
        description: 'Registered name',
        example: 'Metro Office Supply Corp.',
      },
      {
        key: 'tax_id',
        required: false,
        description: 'Tax identification number',
        example: '987-654-321-000',
      },
      { key: 'email', required: false, description: 'AR email', example: 'billing@metro.test' },
      { key: 'phone', required: false, description: 'Phone', example: '+63 2 7777 0000' },
      { key: 'contact_person', required: false, description: 'Contact', example: 'Jose Cruz' },
      {
        key: 'payment_terms_days',
        required: false,
        description: 'Default terms (days)',
        example: '15',
      },
      {
        key: 'currency',
        required: false,
        description: 'ISO currency; blank = company base',
        example: 'PHP',
      },
      {
        key: 'address_line1',
        required: false,
        description: 'Address line 1',
        example: '8 Ayala Ave',
      },
      { key: 'city', required: false, description: 'City', example: 'Makati' },
      { key: 'country', required: false, description: 'Country', example: 'PH' },
    ],
    row: z.object({
      code,
      name: required(200),
      legal_name: optional(200),
      tax_id: optional(32),
      email: optional(200).pipe(z.string().email().optional()),
      phone: optional(40),
      contact_person: optional(120),
      payment_terms_days: optionalInt,
      currency: optional(3).pipe(
        z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
      ),
      address_line1: optional(200),
      city: optional(100),
      country: optional(2).pipe(
        z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
      ),
    }),
  },
  PRODUCTS: {
    type: 'PRODUCTS',
    title: 'Products',
    atomic: false,
    columns: [
      { key: 'sku', required: true, description: 'SKU, unique per company', example: 'WIDGET-01' },
      { key: 'name', required: true, description: 'Product name', example: 'Widget' },
      {
        key: 'product_type',
        required: false,
        description: `${PRODUCT_TYPES.join(' / ')} (default GOODS)`,
        example: 'GOODS',
      },
      {
        key: 'category_code',
        required: false,
        description: 'Existing product category code',
        example: 'MERCH',
      },
      { key: 'unit_of_measure', required: false, description: 'Unit (default pc)', example: 'pc' },
      {
        key: 'tracking_mode',
        required: false,
        description: `${TRACKING_MODES.join(' / ')}`,
        example: 'NONE',
      },
      {
        key: 'costing_method',
        required: false,
        description: `${COSTING_METHODS.join(' / ')}; blank = company default`,
        example: 'FIFO',
      },
      { key: 'sale_price', required: false, description: 'Default sale price', example: '1250.00' },
      {
        key: 'purchase_price',
        required: false,
        description: 'Default purchase price',
        example: '800.00',
      },
      { key: 'standard_cost', required: false, description: 'Standard cost', example: '790.00' },
      {
        key: 'reorder_level',
        required: false,
        description: 'Reorder level (quantity)',
        example: '10',
      },
      { key: 'barcode', required: false, description: 'Barcode', example: '4800000000012' },
      { key: 'description', required: false, description: 'Free text', example: 'Blue widget' },
    ],
    row: z.object({
      sku: code,
      name: required(200),
      product_type: optional(20).pipe(upperEnum(PRODUCT_TYPES).optional()),
      category_code: optional(40),
      unit_of_measure: optional(20),
      tracking_mode: optional(20).pipe(upperEnum(TRACKING_MODES).optional()),
      costing_method: optional(20).pipe(upperEnum(COSTING_METHODS).optional()),
      sale_price: optionalNonNegative,
      purchase_price: optionalNonNegative,
      standard_cost: optionalNonNegative,
      reorder_level: optionalNonNegative,
      barcode: optional(64),
      description: optional(1000),
    }),
  },
  OPENING_BALANCES: {
    type: 'OPENING_BALANCES',
    title: 'Opening balances (general ledger)',
    atomic: true,
    columns: [
      {
        key: 'account_code',
        required: true,
        description: 'Postable account code',
        example: '1110',
      },
      {
        key: 'debit',
        required: false,
        description: 'Debit balance (base currency)',
        example: '150000.00',
      },
      {
        key: 'credit',
        required: false,
        description: 'Credit balance (base currency)',
        example: '',
      },
      {
        key: 'description',
        required: false,
        description: 'Line description',
        example: 'Cash on hand at cut-over',
      },
    ],
    row: z
      .object({
        account_code: code,
        debit: optionalNonNegative,
        credit: optionalNonNegative,
        description: optional(500),
      })
      .refine((r) => Number(r.debit ?? 0) > 0 !== Number(r.credit ?? 0) > 0, {
        message: 'Exactly one of debit / credit must be greater than zero',
      }),
  },
  JOURNAL_ENTRIES: {
    type: 'JOURNAL_ENTRIES',
    title: 'Journal entries (drafts)',
    atomic: true,
    columns: [
      {
        key: 'entry',
        required: true,
        description: 'Groups lines into one journal (any label)',
        example: 'JAN-ACCRUAL-1',
      },
      { key: 'date', required: true, description: 'Entry date YYYY-MM-DD', example: '2026-01-31' },
      {
        key: 'description',
        required: true,
        description: 'Journal description (first line of the group wins)',
        example: 'Accrued utilities',
      },
      { key: 'reference', required: false, description: 'Journal reference', example: 'UTIL-0126' },
      {
        key: 'account_code',
        required: true,
        description: 'Postable account code',
        example: '6300',
      },
      { key: 'debit', required: false, description: 'Line debit', example: '8500.00' },
      { key: 'credit', required: false, description: 'Line credit', example: '' },
      {
        key: 'line_description',
        required: false,
        description: 'Line memo',
        example: 'January electricity',
      },
    ],
    row: z
      .object({
        entry: required(60),
        date: isoDate,
        description: required(500),
        reference: optional(100),
        account_code: code,
        debit: optionalNonNegative,
        credit: optionalNonNegative,
        line_description: optional(500),
      })
      .refine((r) => Number(r.debit ?? 0) > 0 !== Number(r.credit ?? 0) > 0, {
        message: 'Exactly one of debit / credit must be greater than zero',
      }),
  },
  BANK_TRANSACTIONS: {
    type: 'BANK_TRANSACTIONS',
    title: 'Bank transactions (drafts)',
    atomic: true,
    columns: [
      {
        key: 'bank_account_code',
        required: true,
        description: 'Bank account code',
        example: 'BDO-MAIN',
      },
      {
        key: 'type',
        required: true,
        description: `${BANK_TRANSACTION_TYPES.join(' / ')}`,
        example: 'WITHDRAWAL',
      },
      {
        key: 'date',
        required: true,
        description: 'Transaction date YYYY-MM-DD',
        example: '2026-02-03',
      },
      { key: 'amount', required: true, description: 'Positive amount', example: '4500.00' },
      {
        key: 'counterparty_account_code',
        required: false,
        description: 'GL account on the other side (not for transfers)',
        example: '6400',
      },
      {
        key: 'to_bank_account_code',
        required: false,
        description: 'Transfers: destination bank account code',
        example: 'CASH',
      },
      { key: 'reference', required: false, description: 'Reference', example: 'CHK-1001' },
      { key: 'memo', required: false, description: 'Memo', example: 'Office rent' },
    ],
    row: z
      .object({
        bank_account_code: code,
        type: upperEnum(BANK_TRANSACTION_TYPES),
        date: isoDate,
        amount: decimal.refine((v) => Number(v) > 0, 'Amount must be positive'),
        counterparty_account_code: optional(40),
        to_bank_account_code: optional(40),
        reference: optional(100),
        memo: optional(500),
      })
      .refine((r) => (r.type === 'TRANSFER' ? Boolean(r.to_bank_account_code) : true), {
        message: 'Transfers need to_bank_account_code',
      })
      .refine((r) => (r.type === 'TRANSFER' ? true : Boolean(r.counterparty_account_code)), {
        message: 'counterparty_account_code is required unless the type is TRANSFER',
      }),
  },
};

/** Template CSV: header line plus one example row. */
export function templateCsv(type: ImportType): string {
  const spec = IMPORT_SPECS[type];
  const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return (
    spec.columns.map((c) => c.key).join(',') +
    '\r\n' +
    spec.columns.map((c) => quote(c.example)).join(',') +
    '\r\n'
  );
}
