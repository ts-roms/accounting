/* Response shapes of the cash management & treasury platform (Prompt #8). Mirrors the API views. */
import type {
  BankAccountType,
  BankTransferPurpose,
  BankTransferStatus,
  CollectionProbabilities,
  ForecastGranularity,
  ForecastItemDirection,
  ForecastItemFrequency,
  ForecastScenario,
  PaymentFileFormat,
  PaymentFileStatus,
  PettyCashFundStatus,
  PettyCashVoucherStatus,
  ScenarioAdjustments,
} from '@accounting/types';
import type { IntegrityFinding } from './receivables-types';

// ------------------------------------------------------------------ settings

export interface TreasurySettings {
  companyId: string;
  forecastHorizonDays: number;
  forecastGranularity: ForecastGranularity;
  collectionProbabilities: CollectionProbabilities;
  scenarios: Record<ForecastScenario, ScenarioAdjustments>;
  minimumDaysCashOnHand: number;
  burnWindowDays: number;
  transferApprovalThreshold: string | null;
  unsettledTransferWarnDays: number;
  defaultPaymentFileFormat: PaymentFileFormat;
  originatorName: string | null;
  pettyCashVoucherLimit: string | null;
}

export interface BankAccountProfile {
  bankAccountId: string;
  accountType: BankAccountType;
  purpose: string | null;
  minimumBalance: string | null;
  targetBalance: string | null;
  overdraftLimit: string | null;
  routingCode: string | null;
  paymentFileFormat: PaymentFileFormat | null;
  originatorId: string | null;
  isDefaultReceipts: boolean;
  isDefaultPayments: boolean;
  signatories: string | null;
  excludeFromPosition: boolean;
}

// ------------------------------------------------------------------ position

export interface CashPositionAccount {
  bankAccountId: string;
  code: string;
  name: string;
  bankName: string | null;
  currency: string;
  accountType: BankAccountType;
  purpose: string | null;
  bookBalance: string;
  statementBalance: string | null;
  statementDate: string | null;
  unreconciledIn: string;
  unreconciledOut: string;
  unreconciledCount: number;
  inTransitOut: string;
  inTransitIn: string;
  minimumBalance: string | null;
  targetBalance: string | null;
  overdraftLimit: string | null;
  availableBalance: string;
  headroom: string | null;
  belowMinimum: boolean;
  baseBalance: string;
  exchangeRate: string;
  excludeFromPosition: boolean;
}

export interface CashPosition {
  asOf: string;
  baseCurrency: string;
  accounts: CashPositionAccount[];
  byCurrency: Array<{ currency: string; balance: string; baseBalance: string; accounts: number }>;
  byBank: Array<{ bankName: string; baseBalance: string; accounts: number }>;
  totals: {
    bookBalance: string;
    availableBalance: string;
    inTransit: string;
    pettyCash: string;
    unreconciledCount: number;
    belowMinimum: number;
    excluded: number;
  };
}

// ------------------------------------------------------------------ forecast

export interface ForecastBucket {
  key: string;
  label: string;
  start: string;
  end: string;
  opening: string;
  inflows: string;
  outflows: string;
  net: string;
  closing: string;
  /** Keyed `DIRECTION:SOURCE`, e.g. `INFLOW:AR_INVOICES`. */
  bySource: Record<string, string>;
  breach: boolean;
}

export interface ForecastFlow {
  date: string;
  amount: string;
  direction: ForecastItemDirection;
  source: string;
  reference: string;
  label: string;
  bankAccountId: string | null;
  probability?: number;
}

export interface CashForecast {
  asOf: string;
  currency: string;
  horizonDays: number;
  granularity: ForecastGranularity;
  scenario: ForecastScenario;
  openingCash: string;
  minimumCash: string;
  buckets: ForecastBucket[];
  totals: {
    inflows: string;
    outflows: string;
    closing: string;
    minimumClosing: string;
    breaches: number;
  };
  bySource: Array<{
    source: string;
    direction: ForecastItemDirection;
    amount: string;
    items: number;
  }>;
  topFlows: ForecastFlow[];
  snapshotId: string | null;
}

export interface CashForecastSnapshot {
  id: string;
  asOf: string;
  horizonDays: number;
  granularity: ForecastGranularity;
  scenario: ForecastScenario;
  currency: string;
  openingCash: string;
  closingCash: string;
  minimumCash: string;
  totalInflows: string;
  totalOutflows: string;
  breaches: number;
  createdAt: string;
}

export interface CashForecastItem {
  id: string;
  name: string;
  direction: ForecastItemDirection;
  amount: string;
  currency: string;
  frequency: ForecastItemFrequency;
  startDate: string;
  endDate: string | null;
  bankAccountId: string | null;
  category: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

// ------------------------------------------------------------------ transfers

export interface BankTransfer {
  id: string;
  documentNumber: string;
  status: BankTransferStatus;
  purpose: BankTransferPurpose;
  fromBankAccountId: string;
  toBankAccountId: string;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  transferDate: string;
  expectedSettlementDate: string;
  settlementDate: string | null;
  amount: string;
  fromCurrency: string;
  receivedAmount: string;
  toCurrency: string;
  baseAmount: string;
  fxDifference: string;
  feeAmount: string;
  exchangeRate: string;
  reference: string | null;
  bankReference: string | null;
  memo: string | null;
  outJournalEntryId: string | null;
  inJournalEntryId: string | null;
  outJournalNumber: string | null;
  inJournalNumber: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  settledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

// -------------------------------------------------------------- payment files

export interface PaymentFile {
  id: string;
  documentNumber: string;
  status: PaymentFileStatus;
  format: PaymentFileFormat;
  bankAccountId: string;
  bankAccountCode: string;
  bankAccountName: string;
  paymentRunId: string | null;
  paymentRunNumber: string | null;
  valueDate: string;
  currency: string;
  totalAmount: string;
  paymentCount: number;
  filename: string;
  checksum: string;
  description: string | null;
  bankReference: string | null;
  statusNote: string | null;
  transmittedAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface PaymentFileLine {
  id: string;
  paymentId: string;
  paymentNumber: string;
  vendorName: string;
  sequence: number;
  amount: string;
  beneficiaryName: string;
  beneficiaryBank: string | null;
  beneficiaryAccountMasked: string | null;
  beneficiaryRouting: string | null;
  remittanceInfo: string | null;
}

export interface PaymentFileDetail extends PaymentFile {
  lines: PaymentFileLine[];
}

// ---------------------------------------------------------------- petty cash

export interface PettyCashFund {
  id: string;
  code: string;
  name: string;
  status: PettyCashFundStatus;
  glAccountId: string;
  glAccountCode: string;
  imprestAmount: string;
  custodianId: string;
  custodianName: string | null;
  branchId: string | null;
  voucherApprovalLimit: string | null;
  replenishAtPercent: string;
  notes: string | null;
  lastReplenishedAt: string | null;
  currency: string;
  bookBalance: string;
  unreplenished: string;
  unreplenishedCount: number;
  expectedCashOnHand: string;
  replenishmentDue: boolean;
  draftCount: number;
}

export interface PettyCashVoucher {
  id: string;
  fundId: string;
  fundCode: string;
  fundName: string;
  documentNumber: string;
  status: PettyCashVoucherStatus;
  voucherDate: string;
  payee: string;
  description: string | null;
  receiptReference: string | null;
  total: string;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  replenishmentId: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
}

export interface PettyCashVoucherLine {
  id: string;
  lineNumber: number;
  description: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: string;
  taxCodeId: string | null;
}

export interface PettyCashVoucherDetail extends PettyCashVoucher {
  lines: PettyCashVoucherLine[];
}

// ------------------------------------------------------------------ dashboard

export interface TreasuryDashboard {
  asOf: string;
  currency: string;
  kpis: {
    totalCash: string;
    availableCash: string;
    inTransit: string;
    pettyCash: string;
    daysCashOnHand: number | null;
    minimumDaysCashOnHand: number;
    net30: string;
    net90: string;
    minimumClosing: string;
    breaches: number;
    accountsBelowMinimum: number;
  };
  position: CashPosition;
  forecast: CashForecast;
  unreconciled: {
    count: number;
    total: string;
    aging: Array<{ bucket: string; count: number; amount: string }>;
  };
  transfers: { pendingApproval: number; inTransit: number; unsettled: BankTransfer[] };
  paymentFiles: { generated: number; transmitted: number; rejected: number };
  pettyCash: { funds: PettyCashFund[]; needingReplenishment: number; pendingVouchers: number };
}

export interface TreasuryIntegrityReport {
  asOf: string;
  currency: string;
  ranAt: string;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  findings: IntegrityFinding[];
}

export interface TreasurySweepResult {
  companyId: string;
  asOf: string;
  belowMinimum: number;
  forecastBreaches: number;
  unsettledTransfers: number;
  pettyCashLow: number;
  snapshotId: string | null;
}
