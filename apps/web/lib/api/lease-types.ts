/* API response shapes for lease accounting & fixed-asset extensions (Prompt #13). */
import type {
  LeaseClassification,
  LeaseEventType,
  LeaseLineStatus,
  LeasePaymentFrequency,
  LeasePaymentTiming,
  LeaseRunStatus,
  LeaseStatus,
} from '@accounting/types';
import type { IntegrityReport } from './types';

export interface LeaseSettings {
  companyId: string;
  shortTermThresholdMonths: number;
  lowValueThreshold: string;
  autoPostRuns: boolean;
  defaultDiscountRate: string;
}

export interface Lease {
  id: string;
  companyId: string;
  leaseNumber: string;
  name: string;
  description: string | null;
  vendorId: string | null;
  vendorName: string | null;
  assetCategoryId: string | null;
  categoryName: string | null;
  status: LeaseStatus;
  classification: LeaseClassification;
  classificationOverride: LeaseClassification | null;
  commencementDate: string;
  endDate: string;
  termMonths: number;
  paymentAmount: string;
  paymentFrequency: LeasePaymentFrequency;
  paymentTiming: LeasePaymentTiming;
  annualDiscountRate: string | null;
  initialDirectCosts: string;
  leaseIncentives: string;
  underlyingAssetValue: string | null;
  /** Contract currency; the schedule and carrying figures are in it. */
  currency: string;
  /** Commencement rate (1 for base-currency leases). */
  exchangeRate: string;
  initialLiability: string;
  liabilityBalance: string;
  rouCost: string;
  rouAccumulatedDepreciation: string;
  rouCarrying: string;
  /** Base-currency carrying figures - what the ledger holds. */
  liabilityBalanceBase: string;
  rouCostBase: string;
  rouAccumulatedDepreciationBase: string;
  bankAccountId: string | null;
  bankAccountCode: string | null;
  branchId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  location: string | null;
  reference: string | null;
  commencementJournalEntryId: string | null;
  commencementJournalNumber: string | null;
  commencedAt: string | null;
  terminationDate: string | null;
  terminationGainLoss: string | null;
  terminationJournalEntryId: string | null;
  terminationJournalNumber: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaseLine {
  id: string;
  leaseId: string;
  sequence: number;
  periodStart: string;
  periodEnd: string;
  openingLiability: string;
  interest: string;
  depreciation: string;
  payment: string;
  paymentDate: string | null;
  closingLiability: string;
  status: LeaseLineStatus;
  runId: string | null;
  runNumber: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  postedAt: string | null;
  paidAt: string | null;
  paidDate: string | null;
  paidBankAccountId: string | null;
  paymentJournalEntryId: string | null;
  paymentJournalNumber: string | null;
}

export interface LeaseEvent {
  id: string;
  leaseId: string;
  eventType: LeaseEventType;
  eventDate: string;
  liabilityChange: string;
  rouChange: string;
  liabilityAfter: string;
  rouCarryingAfter: string;
  runId: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  notes: string | null;
  createdAt: string;
}

export interface LeaseScheduleLinePreview {
  sequence: number;
  periodStart: string;
  periodEnd: string;
  openingLiability: string;
  payment: string;
  paymentDate: string | null;
  interest: string;
  depreciation: string;
  closingLiability: string;
}

export interface LeaseSchedulePreview {
  initialLiability: string;
  rouCost: string;
  totalPayments: string;
  totalInterest: string;
  lines: LeaseScheduleLinePreview[];
}

export interface LeaseDetail extends Lease {
  lines: LeaseLine[];
  events: LeaseEvent[];
  nextPayment: { lineId: string; date: string; amount: string } | null;
  remainingMonths: number;
  paidTotal: string;
  remainingPayments: string;
  preview: LeaseSchedulePreview | null;
}

export interface LeaseRun {
  id: string;
  documentNumber: string;
  periodEnd: string;
  description: string | null;
  status: LeaseRunStatus;
  currency: string;
  interestTotal: string;
  depreciationTotal: string;
  lineCount: number;
  leaseCount: number;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  reversalJournalNumber: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface LeaseRunDetail extends LeaseRun {
  lines: Array<{
    leaseId: string;
    leaseNumber: string;
    leaseName: string;
    lineId: string;
    sequence: number;
    periodStart: string;
    periodEnd: string;
    interest: string;
    depreciation: string;
    closingLiability: string;
  }>;
}

export interface LeaseRunPreview {
  periodEnd: string;
  currency: string;
  leases: number;
  lines: number;
  interest: string;
  depreciation: string;
  byLease: Array<{
    leaseId: string;
    leaseNumber: string;
    leaseName: string;
    months: number;
    interest: string;
    depreciation: string;
  }>;
}

export interface LeaseRegisterRow {
  leaseId: string;
  leaseNumber: string;
  name: string;
  vendorName: string | null;
  classification: LeaseClassification;
  status: LeaseStatus;
  commencementDate: string;
  endDate: string;
  termMonths: number;
  paymentAmount: string;
  paymentFrequency: string;
  annualDiscountRate: string | null;
  initialLiability: string;
  currency: string;
  liabilityBalance: string;
  rouCost: string;
  rouAccumulatedDepreciation: string;
  rouCarrying: string;
  liabilityBalanceBase: string;
  rouCarryingBase: string;
  remainingMonths: number;
  remainingPayments: string;
  nextPaymentDate: string | null;
}

export interface LeaseRegister {
  asOf: string;
  currency: string;
  rows: LeaseRegisterRow[];
  totals: {
    leases: number;
    finance: number;
    exempt: number;
    liability: string;
    rouCost: string;
    rouAccumulatedDepreciation: string;
    rouCarrying: string;
    remainingPayments: string;
  };
}

export interface LeaseMaturity {
  asOf: string;
  currency: string;
  buckets: Array<{ label: string; from: string; to: string; amount: string }>;
  undiscountedTotal: string;
  liability: string;
  currentPortion: string;
  nonCurrentPortion: string;
  unaccruedInterest: string;
  byLease: Array<{
    leaseId: string;
    leaseNumber: string;
    name: string;
    liability: string;
    currentPortion: string;
    nonCurrentPortion: string;
    remainingPayments: string;
  }>;
}

export interface LeaseDashboard {
  asOf: string;
  currency: string;
  activeLeases: number;
  draftLeases: number;
  liability: string;
  rouCarrying: string;
  monthsAwaitingRun: number;
  overduePayments: number;
  overduePaymentAmount: string;
  next30DaysPayments: string;
  integrity: IntegrityReport;
}

export interface RollforwardSide {
  opening: string;
  additions: string;
  depreciation: string;
  impairment: string;
  revaluation: string;
  disposals: string;
  closing: string;
}

export interface RollforwardGroup {
  categoryId: string | null;
  categoryCode: string;
  categoryName: string;
  counts: { opening: number; additions: number; disposals: number; closing: number };
  cost: RollforwardSide;
  accumulated: RollforwardSide;
  bookValue: { opening: string; closing: string };
}

export interface AssetRollforward {
  from: string;
  to: string;
  currency: string;
  groups: RollforwardGroup[];
  totals: Omit<RollforwardGroup, 'categoryId' | 'categoryCode' | 'categoryName'>;
}
