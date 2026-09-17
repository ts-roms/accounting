/* API response shapes for revenue recognition & deferred revenue (Prompt #10). */
import type {
  RevenueMilestone,
  RevenuePolicyStatus,
  RevenueRecognitionMethod,
  RevenueRunStatus,
  RevenueScheduleLineStatus,
  RevenueScheduleStatus,
} from '@accounting/types';
import type { IntegrityReport } from './types';

export interface RevenuePolicy {
  id: string;
  companyId: string;
  code: string;
  name: string;
  method: RevenueRecognitionMethod;
  description: string | null;
  defaultTermMonths: number | null;
  autoRecognize: boolean;
  status: RevenuePolicyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RevenueSettings {
  companyId: string;
  autoRecognize: boolean;
  overdueGraceDays: number;
  defaultPolicyId: string | null;
}

export interface RevenueSchedule {
  id: string;
  invoiceId: string;
  invoiceLineId: string;
  customerId: string;
  policyId: string;
  method: RevenueRecognitionMethod;
  description: string;
  currency: string;
  totalAmount: string;
  recognizedAmount: string;
  remainingAmount: string;
  serviceStartDate: string | null;
  serviceEndDate: string | null;
  status: RevenueScheduleStatus;
  completedAt: string | null;
  cancelledAt: string | null;
  documentNumber: string;
  documentDate: string;
  customerCode: string;
  customerName: string;
  policyCode: string;
  policyName: string;
  deferredAccountCode: string;
  revenueAccountCode: string;
  nextRecognitionDate: string | null;
  createdAt: string;
}

export interface RevenueScheduleLine {
  id: string;
  sequence: number;
  recognitionDate: string | null;
  amount: string;
  status: RevenueScheduleLineStatus;
  milestoneName: string | null;
  milestonePercent: string | null;
  completedAt: string | null;
  completionNote: string | null;
  runId: string | null;
  runNumber: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  recognizedAt: string | null;
}

export interface RevenueScheduleDetail extends RevenueSchedule {
  lines: RevenueScheduleLine[];
}

export interface RevenueRun {
  id: string;
  documentNumber: string;
  periodEnd: string;
  description: string | null;
  status: RevenueRunStatus;
  currency: string;
  totalAmount: string;
  lineCount: number;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  reversalJournalNumber: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface RevenueRunLine {
  scheduleId: string;
  lineId: string;
  scheduleDescription: string;
  customerId: string;
  sequence: number;
  recognitionDate: string | null;
  milestoneName: string | null;
  amount: string;
}

export interface RevenueRunDetail extends RevenueRun {
  lines: RevenueRunLine[];
}

export interface RevenueRunPreview {
  periodEnd: string;
  currency: string;
  lines: number;
  amount: string;
  schedules: number;
}

export interface RevenueRollforward {
  from: string;
  to: string;
  currency: string;
  opening: string;
  additions: string;
  recognized: string;
  voided: string;
  closing: string;
  ledgerBalance: string | null;
  difference: string | null;
  byMethod: Array<{
    method: string;
    opening: string;
    additions: string;
    recognized: string;
    voided: string;
    closing: string;
  }>;
}

export interface RevenueWaterfall {
  from: string;
  months: number;
  currency: string;
  buckets: Array<{ month: string; amount: string }>;
  unscheduled: string;
  beyond: string;
  total: string;
  byCustomer: Array<{
    customerId: string;
    customerCode: string;
    customerName: string;
    buckets: string[];
    unscheduled: string;
    beyond: string;
    total: string;
  }>;
}

export interface RevenueBacklogRow {
  customerId: string;
  customerCode: string;
  customerName: string;
  schedules: number;
  deferred: string;
  dueWithin30Days: string;
  overdue: string;
  unscheduled: string;
}

export interface RevenueBacklog {
  asOf: string;
  currency: string;
  totals: Omit<RevenueBacklogRow, 'customerId' | 'customerCode' | 'customerName'>;
  rows: RevenueBacklogRow[];
}

export type RevenueIntegrityReport = IntegrityReport;

export type { RevenueMilestone };
