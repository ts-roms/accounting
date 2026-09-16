/* Response shapes of the AR / order-to-cash platform (Prompt #6). Mirrors the API views. */
import type {
  CollectionActivityType,
  CollectionCaseStatus,
  CreditRiskRating,
  CreditRuleAction,
  CreditRuleScope,
  CreditRuleTrigger,
  CreditStatus,
  CustomerAddressType,
  DeliveryStatus,
  DisputeReason,
  DisputeResolution,
  DisputeStatus,
  DunningStep,
  EntityStatus,
  PaymentMethod,
  PaymentTermBasis,
  PromiseStatus,
  ProvisionMethod,
  ProvisionStatus,
  RefundRequestStatus,
  WriteOffReason,
  WriteOffStatus,
} from '@accounting/types';
import type { StatementReport } from './types';

export interface PaymentTerm {
  id: string;
  code: string;
  name: string;
  basis: PaymentTermBasis;
  days: number;
  dayOfMonth: number | null;
  discountPercent: string;
  discountDays: number;
  description: string | null;
  status: EntityStatus;
}

export interface CustomerGroup {
  id: string;
  code: string;
  name: string;
  description: string | null;
  paymentTermId: string | null;
  defaultCreditLimit: string | null;
  taxCodeId: string | null;
  priceDiscountPercent: string;
  dunningPolicyId: string | null;
  status: EntityStatus;
}

export interface CreditRule {
  id: string;
  name: string;
  description: string | null;
  scope: CreditRuleScope;
  trigger: CreditRuleTrigger;
  action: CreditRuleAction;
  thresholdAmount: string | null;
  thresholdPercent: string | null;
  thresholdDays: number | null;
  customerGroupId: string | null;
  priority: number;
  status: EntityStatus;
}

export interface DunningPolicy {
  id: string;
  name: string;
  description: string | null;
  steps: DunningStep[];
  minimumAmount: string;
  isDefault: boolean;
  status: EntityStatus;
}

export interface ArSettings {
  companyId: string;
  agingBuckets: Array<{ key: string; label: string; from: number; to: number | null }>;
  dsoWindowDays: number;
  unappliedCashWarnDays: number;
  smallBalanceThreshold: string;
  autoCaseDaysOverdue: number;
  requirePaymentApproval: boolean;
  useAllowanceForBadDebt: boolean;
  provisionRates: Record<string, string>;
  creditCheckOnSalesOrder: boolean;
  creditCheckOnInvoice: boolean;
  defaultDunningPolicyId: string | null;
  defaultPaymentTermId: string | null;
}

export interface CustomerContact {
  id: string;
  customerId: string;
  name: string;
  title: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  notes: string | null;
}

export interface CustomerAddress {
  id: string;
  customerId: string;
  addressType: CustomerAddressType;
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

export interface CreditProfile {
  customerId: string;
  creditHold: boolean;
  creditHoldReason: string | null;
  creditHoldAt: string | null;
  creditHoldSource: string | null;
  riskRating: CreditRiskRating;
  reviewDate: string | null;
  reviewedAt: string | null;
  notes: string | null;
}

export interface CreditSummary {
  creditLimit: string | null;
  creditUsed: string;
  availableCredit: string | null;
  overdue: string;
  status: CreditStatus;
  creditHold: boolean;
  oldestOverdueDays: number;
  profile: CreditProfile;
}

export interface Delivery {
  id: string;
  documentNumber: string;
  salesOrderId: string;
  salesOrderNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  warehouseId: string | null;
  status: DeliveryStatus;
  deliveryDate: string;
  reference: string | null;
  notes: string | null;
  cancelReason: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  invoiceCount: number;
  deliveredAt: string | null;
  createdAt: string;
}

export interface DeliveryLine {
  id: string;
  lineNumber: number;
  orderLineId: string;
  productId: string | null;
  productSku: string | null;
  warehouseId: string | null;
  description: string;
  quantity: string;
  orderedQuantity: string;
  unitPrice: string;
  invoicedQuantity: string;
  remainingToInvoice: string;
  costAmount: string | null;
}

export interface DeliveryDetail extends Delivery {
  lines: DeliveryLine[];
}

export interface RefundRequest {
  id: string;
  documentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  paymentId: string | null;
  paymentNumber: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  status: RefundRequestStatus;
  currency: string;
  amount: string;
  reason: string;
  method: PaymentMethod;
  cashAccountId: string;
  reference: string | null;
  refundPaymentId: string | null;
  refundPaymentNumber: string | null;
  decisionComment: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface CollectionCase {
  id: string;
  documentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  status: CollectionCaseStatus;
  collectorId: string | null;
  collectorName: string | null;
  openedAt: string;
  closedAt: string | null;
  lastContactAt: string | null;
  nextActionAt: string | null;
  nextAction: string | null;
  source: string;
  escalationLevel: number;
  notes: string | null;
  outstanding: string;
  overdue: string;
  daysOverdue: number;
  openPromise: { id: string; amount: string; promiseDate: string } | null;
}

export interface CollectionActivity {
  id: string;
  caseId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  activityType: CollectionActivityType;
  summary: string;
  details: string | null;
  contactName: string | null;
  dunningStep: number | null;
  performedBy: string | null;
  performedByName: string | null;
  performedAt: string;
}

export interface PromiseToPay {
  id: string;
  customerId: string;
  customerCode?: string;
  customerName?: string;
  caseId: string | null;
  caseNumber?: string | null;
  status: PromiseStatus;
  currency: string;
  amount: string;
  promiseDate: string;
  invoiceIds: string[];
  collectorId: string | null;
  collectorName?: string | null;
  notes: string | null;
  settledAmount: string;
  evaluatedAt: string | null;
  createdAt: string;
}

export interface CollectionCaseDetail extends CollectionCase {
  activities: CollectionActivity[];
  promises: PromiseToPay[];
  invoices: Array<{
    id: string;
    documentNumber: string;
    dueDate: string;
    total: string;
    balance: string;
    daysOverdue: number;
    openDisputes: number;
  }>;
}

export interface Dispute {
  id: string;
  documentNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotal: string;
  invoiceBalance: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  caseId: string | null;
  status: DisputeStatus;
  reason: DisputeReason;
  currency: string;
  amount: string;
  description: string;
  raisedBy: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  resolution: DisputeResolution | null;
  resolutionNotes: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface WriteOff {
  id: string;
  documentNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceBalance: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  status: WriteOffStatus;
  reason: WriteOffReason;
  justification: string;
  currency: string;
  amount: string;
  baseAmount: string;
  writeOffDate: string | null;
  debitAccountCode: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  recoveryJournalEntryId: string | null;
  recoveryJournalNumber: string | null;
  recoveryDate: string | null;
  recoveryReason: string | null;
  decisionComment: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  createdAt: string;
}

export interface BadDebtProvision {
  id: string;
  documentNumber: string;
  status: ProvisionStatus;
  asOf: string;
  method: ProvisionMethod;
  currency: string;
  computation: Record<string, unknown>;
  requiredAllowance: string;
  existingAllowance: string;
  adjustment: string;
  description: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  postedAt: string | null;
  createdAt: string;
}

export interface ArDashboard {
  asOf: string;
  currency: string;
  totals: {
    totalReceivables: string;
    current: string;
    overdue: string;
    unappliedCash: string;
    unappliedCashStale: string;
    unappliedCashStaleCount: number;
    dso: number;
    dsoWindowDays: number;
    collectionRate: number;
    creditExposure: string;
    creditLimitTotal: string;
    customersOverLimit: number;
    customersOnHold: number;
    openCases: number;
    openDisputes: number;
    pendingPromises: number;
    brokenPromises: number;
  };
  aging: Array<{ key: string; label: string; amount: string }>;
  collectionsTrend: Array<{ month: string; collected: string; invoiced: string }>;
  revenueVsReceivables: Array<{ month: string; revenue: string; receivables: string }>;
  dsoTrend: Array<{ month: string; dso: number }>;
  topOverdue: Array<{
    customerId: string;
    code: string;
    name: string;
    overdue: string;
    outstanding: string;
    oldestDueDate: string | null;
  }>;
}

export interface IntegrityFinding {
  check: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  count: number;
  samples: Array<Record<string, unknown>>;
  detail?: string;
}

export interface ArReconciliation {
  asOf: string;
  currency: string;
  controlAccount: { id: string; code: string; name: string };
  subledgerBalance: string;
  ledgerBalance: string;
  difference: string;
  reconciled: boolean;
  breakdown: Record<string, string>;
  integrity: {
    status: 'OK' | 'WARNING' | 'CRITICAL';
    ranAt: string;
    findings: IntegrityFinding[];
  };
}

export interface UnappliedCashReport {
  asOf: string;
  warnDays: number;
  items: Array<{
    id: string;
    documentNumber: string;
    customerId: string;
    customerCode: string;
    customerName: string;
    paymentDate: string;
    amount: string;
    allocatedAmount: string;
    unallocated: string;
    currency: string;
    reference: string | null;
    ageDays: number;
    stale: boolean;
  }>;
}

export interface StatementSnapshot {
  id: string;
  documentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  fromDate: string;
  toDate: string;
  currency: string;
  openingBalance: string;
  closingBalance: string;
  lines: StatementReport['lines'];
  generatedAt: string;
}

export type GeneratedStatement = StatementReport & {
  snapshotId: string | null;
  snapshotNumber: string | null;
};
