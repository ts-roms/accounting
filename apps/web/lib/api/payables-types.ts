/* Response shapes of the AP / procure-to-pay platform (Prompt #7). Mirrors the API views. */
import type {
  ApAccrualSource,
  ApAccrualStatus,
  BillHoldReason,
  BillHoldStatus,
  EntityStatus,
  PaymentMethod,
  PaymentRunLineStatus,
  PaymentRunSelectionMode,
  PaymentRunStatus,
  VendorAddressType,
  VendorHoldReason,
  VendorRiskRating,
  VendorStatus,
  VendorType,
} from '@accounting/types';
import type { IntegrityFinding } from './receivables-types';
import type { AgingBucketDefinition } from '@accounting/types';

export interface VendorGroup {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultPaymentTermId: string | null;
  defaultWithholdingTaxCodeId: string | null;
  defaultExpenseAccountId: string | null;
  requireBillApproval: boolean;
  status: EntityStatus;
}

export interface ApSettings {
  companyId: string;
  agingBuckets: AgingBucketDefinition[];
  dpoWindowDays: number;
  cashRequirementHorizons: number[];
  dueSoonDays: number;
  discountWarnDays: number;
  grniAgeWarnDays: number;
  requirePaymentApproval: boolean;
  requireRunApproval: boolean;
  billApprovalThreshold: string | null;
  requireVendorApproval: boolean;
  requirePoForStockBills: boolean;
  blockDuplicateVendorInvoice: boolean;
  defaultPaymentTermId: string | null;
  defaultCashAccountId: string | null;
}

export interface VendorContact {
  id: string;
  vendorId: string;
  name: string;
  title: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  receivesRemittance: boolean;
  notes: string | null;
}

export interface VendorAddress {
  id: string;
  vendorId: string;
  addressType: VendorAddressType;
  label: string | null;
  attention: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string;
  isDefault: boolean;
}

export interface VendorBankAccount {
  id: string;
  vendorId: string;
  bankName: string;
  label: string | null;
  accountName: string;
  accountNumberMasked: string;
  routingCode: string | null;
  currency: string;
  isPrimary: boolean;
  verifiedAt: string | null;
  status: EntityStatus;
}

export interface VendorProfile {
  vendorId: string;
  riskRating: VendorRiskRating;
  paymentMethod: PaymentMethod;
  minimumPaymentAmount: string | null;
  requireBillApproval: boolean;
  allowBillsWithoutPo: boolean;
  holdReason: VendorHoldReason | null;
  holdNote: string | null;
  holdAt: string | null;
  approvedAt: string | null;
  reviewDate: string | null;
  notes: string | null;
}

export interface VendorBalance {
  outstanding: string;
  overdue: string;
  unappliedCredit: string;
  net: string;
  onHold: string;
}

export interface VendorSummary {
  id: string;
  code: string;
  name: string;
  displayName: string | null;
  legalName: string | null;
  vendorType: VendorType;
  vendorStatus: VendorStatus;
  vendorGroupId: string | null;
  vendorGroupName: string | null;
  paymentTermId: string | null;
  paymentTermName: string | null;
  paymentTermsDays: number;
  withholdingTaxCode: string | null;
  buyerName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  province: string | null;
  industry: string | null;
  region: string | null;
  currency: string;
  status: EntityStatus;
  riskRating: VendorRiskRating;
  onHold: boolean;
  balance: VendorBalance;
}

export interface VendorDetail extends VendorSummary {
  contacts: VendorContact[];
  addresses: VendorAddress[];
  bankAccounts: VendorBankAccount[];
  profile: VendorProfile | null;
}

export interface BillHold {
  id: string;
  billId: string;
  vendorId: string;
  status: BillHoldStatus;
  reason: BillHoldReason;
  note: string | null;
  placedAt: string;
  releasedAt: string | null;
  releaseNote: string | null;
  billNumber: string;
  vendorInvoiceNumber: string | null;
  vendorCode: string;
  vendorName: string;
  billTotal: string;
  billBalance: string;
  currency: string;
  placedByName: string | null;
}

export interface PaymentRun {
  id: string;
  documentNumber: string;
  status: PaymentRunStatus;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountName: string;
  currency: string;
  paymentDate: string;
  payThroughDate: string;
  selectionMode: PaymentRunSelectionMode;
  method: PaymentMethod;
  description: string | null;
  totalAmount: string;
  totalDiscount: string;
  lineCount: number;
  vendorCount: number;
  submittedAt: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  executedAt: string | null;
  cancelReason: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  createdAt: string;
}

export interface PaymentRunLine {
  id: string;
  billId: string;
  vendorId: string;
  status: PaymentRunLineStatus;
  openAmount: string;
  discountAvailable: string;
  discountTaken: string;
  amount: string;
  dueDate: string;
  discountDate: string | null;
  paymentId: string | null;
  failureReason: string | null;
  note: string | null;
  billNumber: string;
  vendorInvoiceNumber: string | null;
  vendorCode: string;
  vendorName: string;
  paymentNumber: string | null;
  skipReason: string | null;
}

export interface PaymentRunDetail extends PaymentRun {
  lines: PaymentRunLine[];
  vendorTotals: Array<{
    vendorId: string;
    vendorCode: string;
    vendorName: string;
    amount: string;
    discount: string;
    bills: number;
  }>;
}

export interface ApAccrual {
  id: string;
  documentNumber: string;
  status: ApAccrualStatus;
  source: ApAccrualSource;
  accrualDate: string;
  reversalDate: string;
  description: string | null;
  totalAmount: string;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  journalNumber: string | null;
  postedAt: string | null;
}

export interface ApAccrualDetail extends ApAccrual {
  lines: Array<{
    id: string;
    lineNumber: number;
    vendorId: string | null;
    vendorName: string | null;
    orderId: string | null;
    description: string;
    accountId: string;
    accountCode: string;
    amount: string;
  }>;
}

export interface GrniRow {
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  lineNumber: number;
  description: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  stocked: boolean;
  accountCode: string;
  receivedQuantity: string;
  billedQuantity: string;
  openQuantity: string;
  unitPrice: string;
  amount: string;
  currency: string;
  lastReceiptDate: string | null;
  ageDays: number;
  aged: boolean;
}

export interface GrniReport {
  asOf: string;
  currency: string;
  rows: GrniRow[];
  totals: { stocked: string; unstocked: string; total: string; aged: string; lines: number };
  grniAccountBalance: string;
  difference: string;
}

export interface CashRequirementBucket {
  days: number;
  label: string;
  amount: string;
  discountAvailable: string;
  billCount: number;
}

export interface CashRequirementsReport {
  asOf: string;
  currency: string;
  horizons: number[];
  buckets: CashRequirementBucket[];
  onHold: string;
  bills: Array<{
    billId: string;
    documentNumber: string;
    vendorInvoiceNumber: string | null;
    vendorId: string;
    vendorName: string;
    dueDate: string;
    discountDate: string | null;
    openAmount: string;
    discountAvailable: string;
    onHold: boolean;
  }>;
}

export interface ApDashboard {
  asOf: string;
  currency: string;
  totals: {
    totalPayables: string;
    current: string;
    overdue: string;
    dueSoon: string;
    dueSoonDays: number;
    onHold: string;
    onHoldCount: number;
    unappliedCredits: string;
    discountsAvailable: string;
    discountsExpiring: string;
    discountsExpiringCount: number;
    discountCaptureRate: number;
    dpo: number;
    dpoWindowDays: number;
    grni: string;
    grniAged: string;
    vendorsOnHold: number;
    vendorsPendingApproval: number;
    billsAwaitingApproval: number;
    pendingPaymentRuns: number;
    pendingPaymentRunsAmount: string;
  };
  aging: Array<{ key: string; label: string; amount: string }>;
  cashRequirements: CashRequirementBucket[];
  paymentsTrend: Array<{ month: string; paid: string; billed: string; discountsTaken: string }>;
  dpoTrend: Array<{ month: string; dpo: number }>;
  topVendors: Array<{
    vendorId: string;
    code: string;
    name: string;
    outstanding: string;
    overdue: string;
    oldestDueDate: string | null;
  }>;
}

export interface ApReconciliation {
  asOf: string;
  currency: string;
  controlAccount: { id: string; code: string; name: string };
  subledgerBalance: string;
  ledgerBalance: string;
  difference: string;
  reconciled: boolean;
  breakdown: {
    bills: string;
    debitNotes: string;
    creditNotes: string;
    payments: string;
    refunds: string;
    fxAdjustments: string;
    discounts: string;
  };
}

export interface ApIntegrityReport {
  asOf: string;
  currency: string;
  ranAt: string;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  findings: IntegrityFinding[];
}
