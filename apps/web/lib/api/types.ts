/* API response shapes used by the web client (mirrors the NestJS views). */
import type { ReportLayoutInput } from '@accounting/validation';
import type {
  AssetEventType,
  AssetStatus,
  AuditAction,
  BankTransactionStatus,
  BankTransactionType,
  DepreciationMethod,
  DepreciationRunStatus,
  ApprovalDecision,
  ApprovalRequestStatus,
  AttachmentEntityType,
  BudgetStatus,
  BudgetVersionStatus,
  ExchangeRateSource,
  FxSide,
  IntercompanyStatus,
  WorkflowDocumentType,
  DimensionType,
  EntityStatus,
  ExpenseClaimStatus,
  MatchKind,
  TaxAppliesTo,
  TaxKind,
  TaxReportingCategory,
  TaxSide,
  TaxSourceType,
  ReconciliationStatus,
  StatementLineStatus,
  StatementStatus,
  PaginatedResult,
  SodEnforcement,
  UserStatus,
  DelegatedGrant,
} from '@accounting/types';

export type { PaginatedResult };

export interface UserView {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanySummary {
  id: string;
  code: string;
  name: string;
  baseCurrency: string;
}

export interface MeResponse {
  user: UserView;
  organization: { id: string; name: string; baseCurrency: string; timezone: string };
  permissions: string[];
  roleKeys: string[];
  activeCompanyId: string | null;
  /** Active delegations lending approval authority in the active company (Prompt #4). */
  delegations: DelegatedGrant[];
  companies: CompanySummary[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  baseCurrency: string;
  timezone: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Company extends CompanySummary {
  organizationId: string;
  legalName: string | null;
  taxIdentificationNumber: string | null;
  fiscalYearStartMonth: number;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Branch {
  id: string;
  companyId: string;
  code: string;
  name: string;
  isHeadOffice: boolean;
  city: string | null;
  province: string | null;
  country: string;
  status: EntityStatus;
}

export interface Permission {
  id: string;
  key: string;
  module: string;
  description: string;
}

export interface Role {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

export interface UserRoleView {
  id: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  companyId: string | null;
  companyName: string | null;
}

export interface SodConflict {
  policyId: string;
  policyName: string;
  permissionA: string;
  permissionB: string;
  enforcement: SodEnforcement;
}

export interface SodPolicy {
  id: string;
  name: string;
  description: string | null;
  permissionA: string;
  permissionB: string;
  enforcement: SodEnforcement;
  isActive: boolean;
}

export interface AuditLog {
  id: number;
  organizationId: string | null;
  companyId: string | null;
  userId: string | null;
  userEmail: string | null;
  action: AuditAction;
  module: string;
  entityType: string;
  entityId: string | null;
  previousValue: unknown;
  newValue: unknown;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  occurredAt: string;
}

// ------------------------------------------------------------------ accounting

import type {
  AccountMappingKey,
  AccountSubtype,
  AccountType,
  CashFlowActivity,
  CashFlowActivity as CashFlowSectionKey,
  DimensionRuleScope,
  FiscalPeriodStatus,
  PostingRuleAccountSource,
  PostingSide,
  PrepaymentScheduleStatus,
  PrepaymentStatus,
  RecurringFrequency,
  RecurringJournalMode,
  RecurringJournalStatus,
  FiscalYearStatus,
  JournalStatus,
  JournalType,
  NormalBalance,
} from '@accounting/types';

export interface Account {
  id: string;
  companyId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  normalBalance: NormalBalance;
  parentId: string | null;
  isHeader: boolean;
  isSystem: boolean;
  currency: string | null;
  isReconciliation: boolean;
  cashFlowActivity: CashFlowActivity | null;
  ownerUserId: string | null;
  allowedBranchIds: string[];
  description: string | null;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AccountNode extends Account {
  level: number;
  hasChildren: boolean;
}

export interface AccountMappingView {
  key: AccountMappingKey;
  accountId: string;
  accountCode: string;
  accountName: string;
}

export interface FiscalPeriod {
  id: string;
  fiscalYearId: string;
  periodNumber: number;
  name: string;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
  closedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  lockedAt: string | null;
}

export interface FiscalYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: FiscalYearStatus;
  closedAt: string | null;
  periods: FiscalPeriod[];
}

export interface JournalLineView {
  id: string;
  lineNumber: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: string;
  credit: string;
  branchId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  foreignDebit: string | null;
  foreignCredit: string | null;
  exchangeRate: string | null;
}

export interface JournalEntryView {
  id: string;
  companyId: string;
  branchId: string | null;
  fiscalPeriodId: string;
  documentNumber: string;
  journalType: JournalType;
  status: JournalStatus;
  entryDate: string;
  postingDate: string | null;
  documentDate: string | null;
  autoReverseDate: string | null;
  description: string;
  reference: string | null;
  currency: string;
  transactionCurrency: string | null;
  exchangeRate: string | null;
  totalDebit: string;
  totalCredit: string;
  sourceType: string | null;
  sourceId: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  createdBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  postedAt: string | null;
  createdAt: string;
  periodName: string;
  periodStatus: FiscalPeriodStatus;
  branchCode: string | null;
  createdByEmail: string | null;
  approvedByEmail: string | null;
  postedByEmail: string | null;
  reversalOfNumber: string | null;
  reversedByNumber: string | null;
  correctionOfId: string | null;
  correctionOfNumber: string | null;
}

export interface RelatedJournalEntry {
  id: string;
  documentNumber: string;
  status: JournalStatus;
  entryDate: string;
  relation: 'ORIGINAL' | 'REVERSAL' | 'REVERSED' | 'CORRECTION' | 'CORRECTS';
}

export interface JournalEntryDetail extends JournalEntryView {
  lines: JournalLineView[];
  related: RelatedJournalEntry[];
  sodWarnings?: SodConflict[];
}

export interface JournalCorrectionResult {
  original: JournalEntryDetail;
  reversal: JournalEntryDetail;
  correction: JournalEntryDetail;
}

export interface LedgerLine {
  journalEntryId: string;
  documentNumber: string;
  entryDate: string;
  journalType: JournalType;
  status: JournalStatus;
  entryDescription: string;
  reference: string | null;
  lineDescription: string | null;
  debit: string;
  credit: string;
  balance: string;
  branchId: string | null;
}

export interface LedgerResult {
  account: Pick<Account, 'id' | 'code' | 'name' | 'type' | 'normalBalance'>;
  currency: string;
  from: string;
  to: string;
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  closingBalance: string;
  lines: LedgerLine[];
  page: number;
  pageSize: number;
  total: number;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceReport {
  from: string;
  to: string;
  currency: string;
  rows: TrialBalanceRow[];
  totals: Omit<TrialBalanceRow, 'accountId' | 'code' | 'name' | 'type'>;
  balanced: boolean;
}

export interface StatementRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  level: number;
  isHeader: boolean;
  amount: string;
  drill: { accountId: string; from: string | null; to: string };
}

export interface StatementSection {
  key: string;
  title: string;
  rows: StatementRow[];
  total: string;
}

export interface IncomeStatementReport {
  from: string;
  to: string;
  currency: string;
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfit: string;
  expenses: StatementSection;
  operatingIncome: string;
  otherIncome: StatementSection;
  otherExpenses: StatementSection;
  netIncome: string;
  comparative?: Omit<IncomeStatementReport, 'comparative'>;
}

export interface BalanceSheetReport {
  asOf: string;
  currency: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  currentEarnings: string;
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

// ------------------------------------------------------------------ subledgers

import type {
  AccountingStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  SubledgerDocumentStatus,
  SubledgerDocumentType,
} from '@accounting/types';

export interface PartyBalance {
  outstanding: string;
  overdue: string;
  unappliedCredit: string;
  net: string;
}

export interface Party {
  id: string;
  companyId: string;
  code: string;
  name: string;
  legalName: string | null;
  taxIdentificationNumber: string | null;
  email: string | null;
  phone: string | null;
  contactPerson: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string;
  paymentTermsDays: number;
  currency: string;
  notes: string | null;
  status: EntityStatus;
  creditLimit?: string | null;
  defaultRevenueAccountId?: string | null;
  defaultExpenseAccountId?: string | null;
  balance: PartyBalance;
  createdAt: string;
  /** Customer master (Prompt #6). */
  customerType?: 'INDIVIDUAL' | 'BUSINESS' | 'GOVERNMENT' | 'OTHER';
  displayName?: string | null;
  customerGroupId?: string | null;
  customerGroupName?: string | null;
  paymentTermId?: string | null;
  paymentTermName?: string | null;
  salespersonId?: string | null;
  salespersonName?: string | null;
  industry?: string | null;
  region?: string | null;
  branchId?: string | null;
  taxExempt?: boolean;
  creditHold?: boolean;
  riskRating?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Vendor master (Prompt #7). */
  vendorType?: string;
  vendorStatus?: 'PENDING' | 'APPROVED' | 'ON_HOLD' | 'BLOCKED' | 'INACTIVE';
  vendorGroupId?: string | null;
  vendorGroupName?: string | null;
  withholdingTaxCode?: string | null;
  buyerName?: string | null;
  onHold?: boolean;
  contacts?: Array<{
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    isPrimary: boolean;
  }>;
  addresses?: Array<{
    id: string;
    addressType: 'BILLING' | 'SHIPPING';
    label: string | null;
    addressLine1: string | null;
    city: string | null;
    province: string | null;
    country: string;
    isDefault: boolean;
  }>;
}

export interface DocumentLine {
  id: string;
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  orderLineId: string | null;
  productId: string | null;
  warehouseId: string | null;
  lotNumber: string | null;
  serialNumbers: string[];
  costAmount: string | null;
  amount: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  branchId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  taxCodeId: string | null;
  taxRate: string;
  taxAmount: string;
  withholdingTaxCodeId: string | null;
  withholdingRate: string;
  withholdingAmount: string;
}

export interface AllocationView {
  id: string;
  amount: string;
  allocationDate: string;
  paymentId: string | null;
  paymentNumber: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  invoiceId?: string;
  invoiceNumber?: string;
  billId?: string;
  billNumber?: string;
}

export interface DocumentWarning {
  code: string;
  message: string;
  details: Record<string, string>;
}

export interface SubledgerDocument {
  id: string;
  companyId: string;
  branchId: string | null;
  documentType: SubledgerDocumentType;
  documentNumber: string;
  status: SubledgerDocumentStatus;
  accountingStatus: AccountingStatus;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  documentDate: string;
  dueDate: string;
  reference: string | null;
  description: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  withholdingTotal: string;
  /** Document currency -> company base (Phase 8). */
  exchangeRate: string;
  baseTotal: string;
  total: string;
  allocatedAmount: string;
  voidReason: string | null;
  voidedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  createdAt: string;
  customerId?: string;
  customerCode?: string;
  customerName?: string;
  vendorId?: string;
  vendorCode?: string;
  vendorName?: string;
  vendorInvoiceNumber?: string | null;
  scheduledPaymentDate?: string | null;
  promisedPaymentDate?: string | null;
  collectionNotes?: string | null;
  /** Phase 4 links and three-way match (bills). */
  salesOrderId?: string | null;
  purchaseOrderId?: string | null;
  matchStatus?: MatchStatus;
  matchExceptions?: MatchException[];
  matchReviewedAt?: string | null;
  matchReviewNote?: string | null;
  journalNumber: string | null;
  balance: string;
  daysOverdue: number;
  /** AR platform (Prompt #6). */
  deliveryId?: string | null;
  deliveryNumber?: string | null;
  salesOrderNumber?: string | null;
  openDisputes?: number;
  writtenOffAmount?: string;
  submittedAt?: string | null;
  /** AP platform (Prompt #7). */
  paymentTermId?: string | null;
  discountDate?: string | null;
  discountAmount?: string;
  discountTakenAmount?: string;
  discountAvailableToday?: string;
  onHold?: boolean;
  activeHoldReason?: string | null;
  purchaseOrderNumber?: string | null;
  goodsReceiptId?: string | null;
}

export interface SubledgerDocumentDetail extends SubledgerDocument {
  lines: DocumentLine[];
  allocations: AllocationView[];
  warnings?: DocumentWarning[];
}

export interface SubledgerPayment {
  id: string;
  documentNumber: string;
  paymentType: PaymentType;
  status: PaymentStatus;
  paymentDate: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  method: PaymentMethod;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountName: string;
  reference: string | null;
  externalReference?: string | null;
  memo: string | null;
  currency: string;
  exchangeRate: string;
  baseAmount: string;
  controlBaseAmount: string;
  allocationStatus?: 'UNALLOCATED' | 'PARTIALLY_ALLOCATED' | 'ALLOCATED' | null;
  approvedAt?: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  voidReason: string | null;
  postedAt: string | null;
  createdAt: string;
  customerId?: string;
  customerCode?: string;
  customerName?: string;
  vendorId?: string;
  vendorCode?: string;
  vendorName?: string;
}

export interface SubledgerPaymentDetail extends SubledgerPayment {
  allocations: AllocationView[];
}

export interface AgingRow {
  partyId: string;
  code: string;
  name: string;
  buckets: Record<string, string>;
  outstanding: string;
  unappliedCredit: string;
  net: string;
  oldestDueDate: string | null;
  documents: number;
}

export interface AgingReport {
  asOf: string;
  currency: string;
  buckets: Array<{ key: string; label: string }>;
  rows: AgingRow[];
  totals: Record<string, string> & {
    outstanding: string;
    unappliedCredit: string;
    net: string;
  };
}

export interface StatementLine {
  date: string;
  kind:
    | 'INVOICE'
    | 'CREDIT_NOTE'
    | 'DEBIT_NOTE'
    | 'PAYMENT'
    | 'REFUND'
    | 'WRITE_OFF'
    | 'WRITE_OFF_RECOVERY'
    | 'DISCOUNT';
  documentId: string;
  documentNumber: string;
  reference: string | null;
  description: string | null;
  dueDate: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface StatementReport {
  party: { id: string; code: string; name: string; email: string | null };
  from: string;
  to: string;
  currency: string;
  openingBalance: string;
  lines: StatementLine[];
  closingBalance: string;
}

export interface ReconciliationReport {
  asOf: string;
  currency: string;
  controlAccount: { id: string; code: string; name: string };
  subledgerBalance: string;
  ledgerBalance: string;
  difference: string;
  reconciled: boolean;
  breakdown: Record<string, string>;
}

export interface ScheduleReport {
  to: string;
  currency: string;
  total: string;
  items: Array<{
    id: string;
    documentNumber: string;
    vendorId: string;
    vendorName: string;
    vendorInvoiceNumber: string | null;
    documentDate: string;
    dueDate: string;
    scheduledPaymentDate: string | null;
    total: string;
    balance: string;
    payOn: string;
  }>;
}

// ------------------------------------------------------------------ Phase 4

import type {
  FulfillmentStatus,
  GoodsReceiptStatus,
  MatchException,
  MatchStatus,
  OrderStatus,
  OrderType,
  ReturnStatus,
  ReturnType,
} from '@accounting/types';

export type { MatchException };

export interface Order {
  id: string;
  companyId: string;
  branchId: string | null;
  orderType: OrderType;
  documentNumber: string;
  status: OrderStatus;
  customerId: string | null;
  vendorId: string | null;
  partyId: string | null;
  partyCode: string | null;
  partyName: string | null;
  orderDate: string;
  expectedDate: string | null;
  reference: string | null;
  description: string | null;
  notes: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  total: string;
  receiptStatus: FulfillmentStatus;
  billingStatus: FulfillmentStatus;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  convertedOrderId: string | null;
  convertedOrderNumber: string | null;
  rejectionReason: string | null;
  cancelReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface OrderLine {
  id: string;
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  amount: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  branchId: string | null;
  productId: string | null;
  warehouseId: string | null;
  receivedQuantity: string;
  billedQuantity: string;
  returnedQuantity: string;
  remainingToReceive: string;
  remainingToBill: string;
  remainingToReturn: string;
}

export interface OrderDocumentRef {
  id: string;
  documentNumber: string;
  documentType: string;
  status: string;
  documentDate: string;
  total: string;
  matchStatus?: MatchStatus;
}

export interface OrderDetail extends Order {
  lines: OrderLine[];
  documents: OrderDocumentRef[];
  sodWarnings?: SodConflict[];
}

export interface FulfilResult {
  documentId: string;
  documentNumber: string;
  warnings: DocumentWarning[];
}

export interface GoodsReceipt {
  id: string;
  documentNumber: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  status: GoodsReceiptStatus;
  receiptDate: string;
  reference: string | null;
  notes: string | null;
  cancelReason: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  confirmedAt: string | null;
  createdAt: string;
  lineCount: number;
}

export interface GoodsReceiptLine {
  id: string;
  lineNumber: number;
  orderLineId: string;
  description: string;
  orderedQuantity: string;
  unitPrice: string;
  quantity: string;
  notes: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  serialNumbers: string[];
  unitCost: string | null;
}

export interface GoodsReceiptDetail extends GoodsReceipt {
  lines: GoodsReceiptLine[];
}

export interface ReturnDocument {
  id: string;
  returnType: ReturnType;
  documentNumber: string;
  status: ReturnStatus;
  orderId: string;
  orderNumber: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  returnDate: string;
  reference: string | null;
  reason: string | null;
  currency: string;
  total: string;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  cancelReason: string | null;
  approvedAt: string | null;
  creditedAt: string | null;
  createdAt: string;
}

export interface ReturnLine {
  id: string;
  lineNumber: number;
  orderLineId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  reason: string | null;
}

export interface ReturnDetail extends ReturnDocument {
  lines: ReturnLine[];
}

export interface PurchasingSettings {
  companyId: string;
  priceTolerancePercent: string;
  quantityTolerancePercent: string;
  overReceiptTolerancePercent: string;
  requirePurchaseOrder: boolean;
  requireReceiptBeforeBill: boolean;
}

// ------------------------------------------------------------------ Phase 5

import type {
  AdjustmentReason,
  CostingMethod,
  MovementType,
  ProductType,
  StockDirection,
  StockDocumentStatus,
  StockDocumentType,
  TrackingMode,
} from '@accounting/types';

export interface ProductCategory {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
  status: EntityStatus;
  productCount: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  productType: ProductType;
  trackingMode: TrackingMode;
  costingMethod: CostingMethod | null;
  unitOfMeasure: string;
  barcode: string | null;
  salePrice: string | null;
  purchasePrice: string | null;
  standardCost: string | null;
  reorderLevel: string | null;
  reorderQuantity: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
  status: EntityStatus;
  quantityOnHand: string;
  stockValue: string;
  createdAt: string;
}

export interface WarehouseLocation {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  status: EntityStatus;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  addressLine1: string | null;
  city: string | null;
  notes: string | null;
  status: EntityStatus;
  stockValue: string;
  locations: WarehouseLocation[];
}

export interface InventorySettings {
  companyId: string;
  defaultCostingMethod: CostingMethod;
  allowNegativeStock: boolean;
}

export interface StockOnHandRow {
  productId: string;
  sku: string;
  productName: string;
  unitOfMeasure: string;
  categoryName: string | null;
  warehouseId: string;
  warehouseCode: string;
  lotId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  quantityOnHand: string;
  totalCost: string;
  averageCost: string;
  reorderLevel: string | null;
  belowReorder: boolean;
}

export interface StockOnHandReport {
  currency: string;
  rows: StockOnHandRow[];
  totals: { quantity: string; value: string };
}

export interface StockCardRow {
  id: string;
  movementDate: string;
  movementType: MovementType;
  warehouseCode: string;
  lotNumber: string | null;
  quantityIn: string;
  quantityOut: string;
  unitCost: string;
  totalCost: string;
  balanceAfter: string;
  sourceType: string;
  sourceId: string;
  journalNumber: string | null;
  createdAt: string;
}

export interface InventoryValuationReport {
  asOf: string;
  currency: string;
  accounts: Array<{
    accountId: string;
    code: string;
    name: string;
    subledgerValue: string;
    ledgerBalance: string;
    difference: string;
    reconciled: boolean;
  }>;
  totalSubledger: string;
  totalLedger: string;
  reconciled: boolean;
  byWarehouse: Array<{
    warehouseId: string;
    code: string;
    name: string;
    value: string;
    quantity: string;
  }>;
}

export interface StockDocument {
  id: string;
  documentType: StockDocumentType;
  documentNumber: string;
  status: StockDocumentStatus;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  toWarehouseId: string | null;
  toWarehouseCode: string | null;
  toWarehouseName: string | null;
  documentDate: string;
  reason: AdjustmentReason | null;
  reference: string | null;
  notes: string | null;
  currency: string;
  totalCost: string;
  journalEntryId: string | null;
  journalNumber: string | null;
  cancelReason: string | null;
  postedAt: string | null;
  createdAt: string;
  lineCount: number;
}

export interface StockDocumentLine {
  id: string;
  lineNumber: number;
  productId: string;
  sku: string;
  productName: string;
  unitOfMeasure: string;
  lotNumber: string | null;
  expiryDate: string | null;
  serialNumbers: string[];
  direction: StockDirection;
  quantity: string;
  expectedQuantity: string | null;
  countedQuantity: string | null;
  unitCost: string | null;
  totalCost: string | null;
  notes: string | null;
}

export interface StockDocumentDetail extends StockDocument {
  lines: StockDocumentLine[];
}

// ---------------------------------------------------------------- Phase 6: fixed assets

export interface AssetCategory {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  usefulLifeMonths: number;
  depreciationMethod: DepreciationMethod;
  decliningRatePercent: string | null;
  assetAccountId: string | null;
  accumulatedDepreciationAccountId: string | null;
  depreciationExpenseAccountId: string | null;
  status: EntityStatus;
  assetCount: number;
}

export interface FixedAsset {
  id: string;
  assetNumber: string;
  name: string;
  description: string | null;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  status: AssetStatus;
  acquisitionDate: string;
  inServiceDate: string;
  acquisitionCost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  depreciationMethod: DepreciationMethod;
  decliningRatePercent: string | null;
  cost: string;
  accumulatedDepreciation: string;
  bookValue: string;
  depreciatedMonths: number;
  location: string | null;
  branchId: string | null;
  serialNumber: string | null;
  vendorId: string | null;
  reference: string | null;
  currency: string;
  capitalizationJournalEntryId: string | null;
  capitalizationJournalNumber: string | null;
  capitalizedAt: string | null;
  disposalDate: string | null;
  disposalProceeds: string | null;
  disposalGainLoss: string | null;
  disposalJournalEntryId: string | null;
  disposalJournalNumber: string | null;
  createdAt: string;
}

export interface AssetEvent {
  id: string;
  assetId: string;
  eventType: AssetEventType;
  eventDate: string;
  amount: string;
  bookValueAfter: string;
  depreciationRunId: string | null;
  fiscalPeriodId: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  notes: string | null;
  createdAt: string;
}

export interface FixedAssetDetail extends FixedAsset {
  events: AssetEvent[];
  nextDepreciation: string;
  remainingSchedule: string[];
}

export interface DepreciationRunLine {
  assetId: string;
  assetNumber: string;
  name: string;
  amount: string;
  accumulatedAfter: string;
  bookValueAfter: string;
  fullyDepreciated: boolean;
}

export interface DepreciationRun {
  id: string;
  runNumber: string;
  fiscalPeriodId: string;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  runDate: string;
  status: DepreciationRunStatus;
  totalAmount: string;
  assetCount: number;
  currency: string;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  postedAt: string | null;
  createdAt: string;
}

export interface DepreciationRunDetail extends DepreciationRun {
  lines: DepreciationRunLine[];
}

export interface FixedAssetSettings {
  companyId: string;
  autoPostDepreciation: boolean;
}

// -------------------------------------------------------------------- Phase 6: banking

export interface BankAccount {
  id: string;
  code: string;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  currency: string;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
  branchId: string | null;
  notes: string | null;
  status: EntityStatus;
  ledgerBalance: string;
  unreconciledCount: number;
  lastStatementDate: string | null;
}

export interface BankTransaction {
  id: string;
  documentNumber: string;
  bankAccountId: string;
  bankAccountCode: string;
  bankAccountName: string;
  transactionType: BankTransactionType;
  status: BankTransactionStatus;
  transactionDate: string;
  amount: string;
  currency: string;
  counterpartyAccountId: string | null;
  counterpartyCode: string | null;
  counterpartyName: string | null;
  toBankAccountId: string | null;
  toBankAccountCode: string | null;
  reference: string | null;
  memo: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  voidReason: string | null;
  postedAt: string | null;
  createdAt: string;
}

export interface BankStatement {
  id: string;
  statementNumber: string;
  bankAccountId: string;
  bankAccountCode: string;
  bankAccountName: string;
  statementDate: string;
  openingBalance: string;
  closingBalance: string;
  status: StatementStatus;
  fileName: string | null;
  lineCount: number;
  matchedCount: number;
  unmatchedCount: number;
  exceptionCount: number;
  createdAt: string;
}

export interface BankStatementLine {
  id: string;
  statementId: string;
  lineNumber: number;
  lineDate: string;
  description: string;
  reference: string | null;
  amount: string;
  balance: string | null;
  status: StatementLineStatus;
  matchNote: string | null;
  matchedJournalLineId: string | null;
  matchedJournalNumber: string | null;
  matchedEntryDate: string | null;
  matchedDescription: string | null;
  matchKind: MatchKind | null;
}

export interface BankLedgerLine {
  journalLineId: string;
  journalEntryId: string;
  journalNumber: string;
  entryDate: string;
  description: string | null;
  reference: string | null;
  debit: string;
  credit: string;
  matchedStatementLineId: string | null;
}

export interface BankReconciliation {
  id: string;
  statementId: string;
  status: ReconciliationStatus;
  statementDate: string;
  statementBalance: string;
  ledgerBalance: string;
  depositsInTransit: string;
  outstandingPayments: string;
  unrecordedCredits: string;
  unrecordedDebits: string;
  difference: string;
  completedAt: string | null;
  notes: string | null;
}

export interface ReconciliationView {
  statement: BankStatement;
  reconciliation: BankReconciliation | null;
  figures: {
    statementBalance: string;
    ledgerBalance: string;
    depositsInTransit: string;
    outstandingPayments: string;
    unrecordedCredits: string;
    unrecordedDebits: string;
    difference: string;
  };
  canComplete: boolean;
}

export interface BankingSettings {
  companyId: string;
  matchDateToleranceDays: number;
  autoMatchMinConfidence: 'HIGH' | 'MEDIUM';
}

// ---------------------------------------------------------------- Phase 7: dimensions

export interface Dimension {
  id: string;
  dimensionType: DimensionType;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentCode: string | null;
  startDate: string | null;
  endDate: string | null;
  managerUserId: string | null;
  status: EntityStatus;
  usageCount: number;
}

export interface DimensionRefs {
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}

// ---------------------------------------------------------------------- Phase 7: tax

export interface TaxRate {
  id: string;
  taxCodeId: string;
  ratePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TaxCode {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: TaxKind;
  appliesTo: TaxAppliesTo;
  reportingCategory: TaxReportingCategory;
  salesAccountId: string | null;
  salesAccountCode: string | null;
  purchaseAccountId: string | null;
  purchaseAccountCode: string | null;
  isDefaultSales: boolean;
  isDefaultPurchases: boolean;
  status: EntityStatus;
  rates: TaxRate[];
  currentRate: string | null;
  transactionCount: number;
}

export interface TaxTransaction {
  id: string;
  taxCodeId: string;
  taxCode: string;
  taxName: string;
  kind: TaxKind;
  side: TaxSide;
  sourceType: TaxSourceType;
  sourceId: string;
  documentNumber: string;
  journalEntryId: string;
  journalNumber: string;
  partyId: string | null;
  partyName: string | null;
  partyTaxNumber: string | null;
  transactionDate: string;
  ratePercent: string;
  baseAmount: string;
  taxAmount: string;
  reversalOfId: string | null;
}

export interface TaxSummaryRow {
  taxCodeId: string;
  code: string;
  name: string;
  kind: TaxKind;
  side: TaxSide;
  reportingCategory: TaxReportingCategory;
  transactionCount: number;
  baseAmount: string;
  taxAmount: string;
}

export interface TaxSummaryReport {
  from: string;
  to: string;
  currency: string;
  rows: TaxSummaryRow[];
  totals: {
    outputTax: string;
    inputTax: string;
    netTaxPayable: string;
    withholdingReceivable: string;
    withholdingPayable: string;
  };
}

export interface WithholdingByPartyRow {
  partyId: string | null;
  partyName: string | null;
  partyTaxNumber: string | null;
  side: TaxSide;
  code: string;
  ratePercent: string;
  transactionCount: number;
  baseAmount: string;
  taxAmount: string;
}

// ------------------------------------------------------------------ Phase 7: budgets

export interface Budget {
  id: string;
  fiscalYearId: string;
  fiscalYearName: string;
  code: string;
  name: string;
  description: string | null;
  status: BudgetStatus;
  currency: string;
  versionCount: number;
  approvedVersionId: string | null;
  approvedVersionName: string | null;
  approvedTotal: string;
  createdAt: string;
}

export interface BudgetVersion {
  id: string;
  budgetId: string;
  versionNumber: number;
  name: string;
  notes: string | null;
  status: BudgetVersionStatus;
  approvedAt: string | null;
  createdBy: string | null;
  lineCount: number;
  total: string;
  createdAt: string;
}

export interface BudgetPeriod {
  id: string;
  name: string;
  periodNumber: number;
  startDate: string;
  endDate: string;
  status: string;
}

export interface BudgetDetail extends Budget {
  versions: BudgetVersion[];
  periods: BudgetPeriod[];
}

export interface BudgetLine extends DimensionRefs {
  id: string;
  versionId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  fiscalPeriodId: string;
  periodNumber: number;
  amount: string;
  notes: string | null;
}

export interface BudgetVersionDetail extends BudgetVersion {
  lines: BudgetLine[];
}

export interface VarianceCell {
  periodId: string;
  budget: string;
  actual: string;
  variance: string;
}

export interface VarianceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  cells: VarianceCell[];
  budget: string;
  actual: string;
  variance: string;
  variancePercent: string | null;
}

export interface VarianceTotals {
  budget: string;
  actual: string;
  variance: string;
}

export interface VarianceReport {
  budgetId: string;
  versionId: string;
  versionName: string;
  currency: string;
  periods: Array<{ id: string; name: string; periodNumber: number }>;
  rows: VarianceRow[];
  totals: { revenue: VarianceTotals; expense: VarianceTotals; net: VarianceTotals };
}

// ------------------------------------------------------------ Phase 7: expense claims

export interface ExpenseClaim {
  id: string;
  claimNumber: string;
  claimantUserId: string;
  claimantName: string;
  claimantEmail: string;
  branchId: string | null;
  claimDate: string;
  purpose: string;
  notes: string | null;
  status: ExpenseClaimStatus;
  currency: string;
  total: string;
  taxTotal: string;
  journalEntryId: string | null;
  journalNumber: string | null;
  paymentJournalEntryId: string | null;
  paymentJournalNumber: string | null;
  paymentBankAccountId: string | null;
  paymentDate: string | null;
  paymentReference: string | null;
  rejectionReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  paidAt: string | null;
  lineCount: number;
  createdAt: string;
}

export interface ExpenseClaimLine extends DimensionRefs {
  id: string;
  lineNumber: number;
  expenseDate: string;
  description: string;
  merchant: string | null;
  receiptReference: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: string;
  taxCodeId: string | null;
  taxCode: string | null;
  taxRate: string;
  taxAmount: string;
}

export interface ExpenseClaimDetail extends ExpenseClaim {
  lines: ExpenseClaimLine[];
}

// ---------------------------------------------------------------- Phase 8: multi-currency

export interface ExchangeRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: string;
  rate: string;
  source: ExchangeRateSource;
  notes: string | null;
  createdAt: string;
}

export interface FxRevaluationLine {
  side: FxSide;
  documentId: string;
  documentNumber: string;
  currency: string;
  openAmount: string;
  documentRate: string;
  closingRate: string;
  adjustment: string;
}

export interface FxRevaluation {
  id: string;
  runNumber: string;
  asOfDate: string;
  reversalDate: string;
  currency: string;
  lines: FxRevaluationLine[];
  unrealizedGain: string;
  unrealizedLoss: string;
  journalEntryId: string | null;
  journalNumber: string | null;
  reversalJournalEntryId: string | null;
  reversalJournalNumber: string | null;
  notes: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- Phase 8: intercompany

export interface IntercompanyTransaction {
  id: string;
  documentNumber: string;
  fromCompanyId: string;
  fromCompanyCode: string;
  fromCompanyName: string;
  toCompanyId: string;
  toCompanyCode: string;
  toCompanyName: string;
  transactionDate: string;
  description: string;
  reference: string | null;
  currency: string;
  amount: string;
  fromAccountId: string;
  fromAccountCode: string;
  toAccountId: string;
  toAccountCode: string;
  status: IntercompanyStatus;
  fromJournalEntryId: string | null;
  fromJournalNumber: string | null;
  toJournalEntryId: string | null;
  toJournalNumber: string | null;
  postedAt: string | null;
  settlementDate: string | null;
  settlementFromJournalEntryId: string | null;
  settlementToJournalEntryId: string | null;
  settlementFromJournalNumber: string | null;
  settlementToJournalNumber: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface ConsolidatedCompany {
  id: string;
  code: string;
  name: string;
  baseCurrency: string;
  rate: string;
}

export interface ConsolidatedRow {
  code: string;
  name: string;
  type: string;
  isIntercompany: boolean;
  byCompany: Record<string, string>;
  combined: string;
  eliminations: string;
  consolidated: string;
}

export interface ConsolidationReport {
  from: string;
  to: string;
  currency: string;
  companies: ConsolidatedCompany[];
  rows: ConsolidatedRow[];
  totals: {
    assets: string;
    liabilities: string;
    equity: string;
    revenue: string;
    expenses: string;
    netIncome: string;
    eliminationCheck: string;
    balanced: boolean;
  };
}

// ---------------------------------------------------------------- Phase 8: workflows

export interface WorkflowStep {
  name: string;
  requiredPermission: string;
  minApprovers: number;
}

export interface ApprovalWorkflow {
  id: string;
  documentType: WorkflowDocumentType;
  name: string;
  description: string | null;
  minAmount: string;
  maxAmount: string | null;
  priority: number;
  allowSelfApproval: boolean;
  branchId: string | null;
  deadlineHours: number | null;
  escalationPermission: string | null;
  steps: WorkflowStep[];
  status: EntityStatus;
  openRequests: number;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  workflowId: string;
  workflowName: string;
  documentType: WorkflowDocumentType;
  documentId: string;
  documentNumber: string;
  amount: string;
  currency: string;
  steps: WorkflowStep[];
  currentStep: number;
  status: ApprovalRequestStatus;
  requestedBy: string | null;
  requestedByName: string | null;
  pendingApprovals: number;
  canDecide: boolean;
  overdue: boolean;
  escalationPermission: string | null;
  branchId: string | null;
  dueAt: string | null;
  escalatedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ApprovalRequestDetail extends ApprovalRequest {
  decisions: Array<{
    id: string;
    step: number;
    decision: ApprovalDecision;
    comment: string | null;
    decidedBy: string;
    decidedByName: string | null;
    decidedAt: string;
  }>;
}

// ---------------------------------------------------------------- Phase 8: attachments

export interface Attachment {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  description: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

// ------------------------------------------------------------------ Phase 9: AI (advisory)

import type {
  AiAnomalyType,
  AiDocumentKind,
  AiDocumentStatus,
  AiForecastMetric,
  AiMessageRole,
  AiProvider,
  AiSeverity,
  AiSuggestionStatus,
} from '@accounting/types';

export interface AiAccountSuggestion {
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCodeId: string | null;
  confidence: number;
  rationale: string;
}

export interface AiExtractedLine {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId?: string | null;
  taxCodeId?: string | null;
}

export interface AiExtractedFields {
  vendorName?: string | null;
  vendorTaxId?: string | null;
  documentDate?: string | null;
  dueDate?: string | null;
  reference?: string | null;
  currency?: string | null;
  subtotal?: string | null;
  taxAmount?: string | null;
  total?: string | null;
  lines: AiExtractedLine[];
  lineSuggestions?: (AiAccountSuggestion | null)[];
}

export interface AiDocument {
  id: string;
  status: AiDocumentStatus;
  kind: AiDocumentKind;
  fileName: string;
  mimeType: string;
  attachmentId: string | null;
  extracted: AiExtractedFields;
  confidence: string;
  provider: AiProvider;
  model: string | null;
  vendorId: string | null;
  vendorName: string | null;
  draftBillId: string | null;
  draftExpenseClaimId: string | null;
  draftNumber: string | null;
  error: string | null;
  createdBy: string | null;
  createdByName: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiDocumentDetail extends AiDocument {
  sourceText: string | null;
  warnings?: string[];
}

export interface AiAnomaly {
  id: string;
  status: AiSuggestionStatus;
  anomalyType: AiAnomalyType;
  severity: AiSeverity;
  entityType: string;
  entityId: string;
  entityNumber: string | null;
  entityDate: string | null;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  confidence: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface AiScanResult {
  from: string;
  to: string;
  scanned: { documents: number; journals: number };
  flagged: number;
  new: number;
  items: AiAnomaly[];
}

export interface AiAnswerSource {
  label: string;
  value: string;
  report: string;
  href?: string;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  role: AiMessageRole;
  content: string;
  sources: AiAnswerSource[];
  provider: AiProvider | null;
  model: string | null;
  createdAt: string;
}

export interface AiConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationDetail extends AiConversation {
  messages: AiMessage[];
}

export interface AiAskResult {
  conversationId: string;
  question: AiMessage;
  answer: AiMessage;
  intent: string;
}

export interface AiForecast {
  metric: AiForecastMetric;
  currency: string;
  asOf: string;
  note: string;
  method: string;
  history: { period: string; value: string }[];
  forecast: { period: string; value: string; low: string; high: string }[];
  slopePerMonth: string;
  r2: number;
}

// ------------------------------------------------------- Hardening: integrity

export type IntegritySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface IntegrityFinding {
  check: string;
  severity: IntegritySeverity;
  title: string;
  count: number;
  samples: Array<Record<string, unknown>>;
  detail?: string;
}

export interface IntegrityReport {
  asOf: string;
  currency: string;
  ranAt: string;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  findings: IntegrityFinding[];
}

// -------------------------------------------------- Hardening: reconciliation

import type {
  ReconciliationArea,
  ReconciliationExceptionStatus,
  SubledgerReconciliationStatus,
} from '@accounting/types';

export interface AccountingPolicy {
  companyId: string;
  reconciliationMateriality: string;
  reconciliationStaleDays: number;
  closeRequireReconciliations: boolean;
  closeRequireBankReconciliation: boolean;
  closeRequireDepreciation: boolean;
  closeRequireFxRevaluation: boolean;
  closeBlockOnUnapprovedJournals: boolean;
  closeBlockOnOpenExceptions: boolean;
  closeRequireIntegrityOk: boolean;
  closeLockOnComplete: boolean;
  closeBlockOnSuspense: boolean;
  suspenseMateriality: string;
  suspenseMaxAgeDays: number;
}

export interface ReconciliationLine {
  accountId: string;
  code: string;
  name: string;
  expected: string;
  actual: string;
  difference: string;
  note?: string;
}

export interface ReconciliationView {
  id: string;
  area: ReconciliationArea;
  asOf: string;
  controlAccountId: string;
  controlAccountCode: string;
  controlAccountName: string;
  status: SubledgerReconciliationStatus;
  expectedBalance: string;
  actualBalance: string;
  variance: string;
  materiality: string;
  computedAt: string;
  preparedBy: string | null;
  preparedByName: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  notes: string | null;
  openExceptions: number;
  explained: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationExceptionView {
  id: string;
  status: ReconciliationExceptionStatus;
  description: string;
  amount: string;
  reference: string | null;
  raisedBy: string | null;
  raisedByName: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
}

export interface ReconciliationDetail extends ReconciliationView {
  lines: ReconciliationLine[];
  exceptions: ReconciliationExceptionView[];
  unexplained: string;
}

export interface ReconciliationAreaSummary {
  area: ReconciliationArea;
  latest: ReconciliationView | null;
  live: { expected: string; actual: string; variance: string; withinMateriality: boolean };
  stale: boolean;
}

export interface BankAccountSummary {
  bankAccountId: string;
  code: string;
  name: string;
  currency: string;
  ledgerBalance: string;
  lastStatementDate: string | null;
  latestStatementId: string | null;
  reconciliationStatus: 'NONE' | 'IN_PROGRESS' | 'COMPLETED';
  unmatched: number;
  possible: number;
  exceptions: number;
}

export interface ReconciliationSummary {
  asOf: string;
  materiality: string;
  areas: ReconciliationAreaSummary[];
  banks: BankAccountSummary[];
}

// ------------------------------------------------- Hardening: financial close

import type { CloseStatus, CloseTaskKind, CloseTaskStatus, CloseType } from '@accounting/types';

export interface CloseBlocker {
  key: string;
  message: string;
  blocking: boolean;
  detail?: Record<string, unknown>;
}

export interface CloseTaskView {
  id: string;
  closeId: string;
  sequence: number;
  key: string;
  title: string;
  kind: CloseTaskKind;
  required: boolean;
  status: CloseTaskStatus;
  detail: Record<string, unknown>;
  ownerId: string | null;
  ownerName: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
  notes: string | null;
  skipReason: string | null;
}

export interface CloseView {
  id: string;
  fiscalPeriodId: string;
  closeType: CloseType;
  status: CloseStatus;
  periodName: string;
  periodStatus: FiscalPeriodStatus;
  periodStart: string;
  periodEnd: string;
  evaluatedAt: string | null;
  startedBy: string | null;
  startedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  approvalNotes: string | null;
  completedByName: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  taskCount: number;
  doneCount: number;
  progress: number;
  createdAt: string;
}

export interface CloseDetail extends CloseView {
  tasks: CloseTaskView[];
  blockers: CloseBlocker[];
}

// ------------------------------------------------------- accounting core extensions

export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
  drill: { accountId: string; from: string; to: string };
}

export interface CashFlowSection {
  key: CashFlowSectionKey;
  title: string;
  lines: CashFlowLine[];
  total: string;
}

export interface CashFlowStatement {
  method: 'INDIRECT';
  from: string;
  to: string;
  currency: string;
  netIncome: string;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangeInCash: string;
  openingCash: string;
  closingCash: string;
  balanced: boolean;
  cashAccounts: Array<{
    accountId: string;
    code: string;
    name: string;
    opening: string;
    closing: string;
  }>;
}

export interface RecurringJournalLine {
  accountId: string;
  debit: string;
  credit: string;
  description?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}

export interface RecurringJournal {
  id: string;
  companyId: string;
  name: string;
  description: string;
  reference: string | null;
  journalType: JournalType;
  frequency: RecurringFrequency;
  interval: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  nextRunDate: string | null;
  lastRunDate: string | null;
  occurrences: number;
  mode: RecurringJournalMode;
  autoReverse: boolean;
  branchId: string | null;
  lines: RecurringJournalLine[];
  status: RecurringJournalStatus;
  createdBy: string | null;
  autoPostApprovedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringJournalRun {
  id: string;
  runDate: string;
  journalEntryId: string | null;
  documentNumber: string | null;
  journalStatus: JournalStatus | null;
  createdAt: string;
}

export interface RecurringJournalDetail extends RecurringJournal {
  runs: RecurringJournalRun[];
}

export interface RecurringRunResult {
  asOf: string;
  generated: Array<{
    recurringJournalId: string;
    name: string;
    runDate: string;
    journalEntryId: string;
    documentNumber: string;
    status: string;
  }>;
  skipped: Array<{ recurringJournalId: string; name: string; runDate: string; reason: string }>;
}

export interface PrepaymentSchedule {
  id: string;
  sequence: number;
  recognitionDate: string;
  amount: string;
  status: PrepaymentScheduleStatus;
  journalEntryId: string | null;
  documentNumber: string | null;
  recognizedAt: string | null;
}

export interface Prepayment {
  id: string;
  name: string;
  description: string | null;
  reference: string | null;
  prepaidAccountId: string;
  expenseAccountId: string;
  creditAccountId: string | null;
  currency: string;
  amount: string;
  recognizedAmount: string;
  remainingAmount: string;
  startDate: string;
  months: number;
  status: PrepaymentStatus;
  branchId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  initialEntryId: string | null;
  prepaidAccountCode: string;
  expenseAccountCode: string;
  createdAt: string;
}

export interface PrepaymentDetail extends Prepayment {
  schedules: PrepaymentSchedule[];
  initialDocumentNumber: string | null;
}

export interface RecognitionResult {
  asOf: string;
  recognized: Array<{
    prepaymentId: string;
    name: string;
    sequence: number;
    recognitionDate: string;
    amount: string;
    journalEntryId: string;
    documentNumber: string;
  }>;
  skipped: Array<{ prepaymentId: string; reason: string }>;
}

export interface PostingRuleLine {
  side: PostingSide;
  accountSource: PostingRuleAccountSource;
  mappingKey?: AccountMappingKey | null;
  accountId?: string | null;
  accountKey?: string | null;
  amountKey: string;
  description?: string | null;
}

export interface PostingRule {
  id: string;
  transactionType: string;
  name: string;
  description: string | null;
  journalType: JournalType;
  lines: PostingRuleLine[];
  status: EntityStatus;
  requirements: { amountKeys: string[]; accountKeys: string[]; mappingKeys: string[] };
  updatedAt: string;
}

export interface ResolvedPostingRule {
  transactionType: string;
  journalType: JournalType;
  lines: Array<{ accountId: string; debit: string; credit: string; description: string | null }>;
  accounts: Array<{ accountId: string; code: string; name: string }>;
}

export interface DimensionRule {
  id: string;
  name: string;
  scope: DimensionRuleScope;
  accountId: string | null;
  accountCode: string | null;
  accountType: AccountType | null;
  codePrefix: string | null;
  dimensionType: DimensionType;
  status: EntityStatus;
}

// ---------------------------------------------------------------- Hardening H5: enterprise controls

export type ControlSeverity = 'OK' | 'INFO' | 'WARNING' | 'CRITICAL';

export interface ControlTile {
  key: string;
  title: string;
  value: string;
  kind: 'count' | 'amount' | 'percent' | 'text';
  severity: ControlSeverity;
  detail: string | null;
  href: string;
}

export interface ControlDashboard {
  asOf: string;
  currency: string;
  generatedAt: string;
  status: ControlSeverity;
  tiles: ControlTile[];
}

export type SuspenseStatus = 'CLEAR' | 'WITHIN_POLICY' | 'REQUIRES_INVESTIGATION';

export interface SuspenseAccountView {
  accountId: string;
  code: string;
  name: string;
  balance: string;
  /** Posted lines up to the date. */
  transactions: number;
  /** Lines since the balance was last zero - what still has to be explained. */
  openTransactions: number;
  openSince: string | null;
  ageDays: number;
  status: SuspenseStatus;
  reasons: string[];
  ownerUserId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  lines: SuspenseLine[];
}

export interface SuspenseLine {
  journalEntryId: string;
  documentNumber: string;
  entryDate: string;
  description: string | null;
  reference: string | null;
  sourceType: string | null;
  sourceId: string | null;
  debit: string;
  credit: string;
  ageDays: number;
}

export interface SuspenseMonitor {
  asOf: string;
  currency: string;
  materiality: string;
  maxAgeDays: number;
  totalBalance: string;
  requiresInvestigation: number;
  accounts: SuspenseAccountView[];
}

export type { CashFlowActivity };

export interface FieldChange {
  id: number;
  auditLogId: number;
  entityType: string;
  entityId: string;
  field: string;
  previousValue: unknown;
  newValue: unknown;
  changedBy: string | null;
  changedByEmail: string | null;
  reason: string | null;
  correlationId: string | null;
  changedAt: string;
}

export interface SodUserConflict {
  policyId: string;
  policyName: string;
  permissionA: string;
  permissionB: string;
  enforcement: 'BLOCK' | 'WARN';
  userId: string;
  userName: string;
  userEmail: string;
  companyId: string | null;
  companyName: string | null;
}

// ---------------------------------------------------------------- Hardening H6: data infrastructure

export interface NumberingRuleView {
  documentType: string;
  branchId: string | null;
  branchCode: string | null;
  branchName: string | null;
  prefix: string;
  format: string;
  padding: number;
  resetYearly: boolean;
  isActive: boolean;
  /** Configured rule id, or null for the built-in default. */
  ruleId: string | null;
  nextNumber: string;
}

export type ImportType =
  | 'CHART_OF_ACCOUNTS'
  | 'CUSTOMERS'
  | 'VENDORS'
  | 'PRODUCTS'
  | 'OPENING_BALANCES'
  | 'JOURNAL_ENTRIES'
  | 'BANK_TRANSACTIONS';
export type ImportStatus = 'VALIDATED' | 'COMMITTED' | 'FAILED' | 'CANCELLED';

export interface ImportColumn {
  key: string;
  required: boolean;
  description: string;
  example: string;
}

export interface ImportSpec {
  type: ImportType;
  title: string;
  atomic: boolean;
  columns: ImportColumn[];
}

export interface ImportRow {
  line: number;
  values: Record<string, string>;
  errors: string[];
  result?: string | null;
}

export interface ImportJob {
  id: string;
  type: ImportType;
  status: ImportStatus;
  fileName: string;
  options: { asOfDate?: string | null; branchId?: string | null };
  rowCount: number;
  validCount: number;
  errorCount: number;
  result: { created?: number; failed?: number; documents?: string[]; error?: string };
  spec: Pick<ImportSpec, 'title' | 'atomic' | 'columns'>;
  createdBy: string | null;
  createdByEmail: string | null;
  committedBy: string | null;
  committedAt: string | null;
  createdAt: string;
}

export interface ImportJobDetail extends ImportJob {
  rows: ImportRow[];
}

export type ExportDataset =
  | 'TRIAL_BALANCE'
  | 'GENERAL_LEDGER'
  | 'JOURNAL_ENTRIES'
  | 'CHART_OF_ACCOUNTS'
  | 'CUSTOMERS'
  | 'VENDORS'
  | 'AR_AGING'
  | 'AP_AGING'
  | 'AUDIT_LOGS';

export type OpeningBalanceArea = 'AR' | 'AP' | 'INVENTORY' | 'FIXED_ASSETS';

export interface OpeningLoadResult {
  area: OpeningBalanceArea;
  asOfDate: string;
  created: number;
  total: string;
  documents: string[];
}

export interface OpeningBalanceReport {
  asOf: string;
  currency: string;
  areas: Array<{
    area: OpeningBalanceArea;
    controlAccountId: string;
    subledger: string;
    ledger: string;
    variance: string;
    reconciled: boolean;
  }>;
  openingJournals: { count: number; posted: number; drafts: number; totalDebit: string };
  openingEquity: { accountId: string; code: string; balance: string };
  trialBalanceBalanced: boolean;
  reconciled: boolean;
}

// ------------------------------------------------------- reporting engine (H7)

export interface ReportDefinitionView {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  category: 'FINANCIAL' | 'MANAGEMENT' | 'CUSTOM';
  basis: 'PERIOD' | 'AS_OF';
  layout: ReportLayoutInput;
  isSystem: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportColumnResult {
  key: string;
  label: string;
  kind: string;
  from: string | null;
  to: string | null;
}

export interface ReportLineResult {
  key: string;
  label: string;
  kind: 'HEADER' | 'ACCOUNTS' | 'FORMULA' | 'DIMENSION_GROUP' | 'ACCOUNT' | 'DIMENSION_VALUE';
  level: number;
  bold: boolean;
  values: Record<string, string | null>;
  accountId?: string;
  dimensionId?: string;
}

export interface ReportResult {
  definition: { id: string | null; code: string; name: string; basis: 'PERIOD' | 'AS_OF' };
  currency: string;
  params: {
    from: string;
    to: string;
    branchId?: string | null;
    budgetId?: string;
    includeZero: boolean;
  };
  columns: ReportColumnResult[];
  rows: ReportLineResult[];
  generatedAt: string;
}

export interface JournalControlSummary {
  total: {
    count: number;
    totalDebit: string;
    reversals: number;
    reversed: number;
    manual: number;
    awaitingApproval: number;
    selfPosted: number;
  };
  byStatus: Array<{ status: string; count: number; totalDebit: string }>;
  bySource: Array<{ sourceType: string; count: number; posted: number; totalDebit: string }>;
}

export interface TraceActor {
  id: string | null;
  email: string | null;
  name: string | null;
}

export interface TraceJournal {
  id: string;
  documentNumber: string;
  status: string;
  entryDate: string;
  journalType: string;
  sourceType: string | null;
  totalDebit: string;
  relation: 'THIS' | 'ORIGINAL' | 'REVERSAL' | 'CORRECTED' | 'CORRECTION' | 'SAME_SOURCE';
}

export interface JournalTrace {
  journal: {
    id: string;
    documentNumber: string;
    status: string;
    journalType: string;
    entryDate: string;
    description: string;
    reference: string | null;
    totalDebit: string;
    totalCredit: string;
    sourceType: string | null;
    sourceId: string | null;
    branchId: string | null;
    createdBy: TraceActor;
    approvedBy: TraceActor;
    postedBy: TraceActor;
    createdAt: string;
    approvedAt: string | null;
    postedAt: string | null;
    lineCount: number;
    accountIds: string[];
  };
  source: {
    sourceType: string;
    event: string;
    id: string;
    documentNumber: string | null;
    status: string | null;
    amount: string | null;
    path: string;
    entityType: string;
    workflowDocumentType: string | null;
  } | null;
  party: {
    kind: 'CUSTOMER' | 'VENDOR' | 'EMPLOYEE';
    id: string;
    code: string | null;
    name: string;
    path: string;
  } | null;
  related: TraceJournal[];
  approvals: Array<{
    id: string;
    documentType: string;
    documentNumber: string;
    status: string;
    amount: string;
    createdAt: string;
  }>;
  audit: Array<{
    id: number;
    occurredAt: string;
    action: string;
    module: string;
    entityType: string;
    entityId: string | null;
    user: TraceActor;
    metadata: unknown;
  }>;
}

// ------------------------------------------------------------- operations (H8)

export interface JobRunView {
  id: string;
  jobName: string;
  trigger: 'SCHEDULED' | 'MANUAL' | 'STARTUP';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED_LOCKED';
  instanceId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: string | null;
  triggeredBy: string | null;
}

export interface JobView {
  name: string;
  description: string;
  queue: string;
  schedule: string | null;
  enabled: boolean;
  lastRun: JobRunView | null;
  failingStreak: number;
}

export interface QueueStatsView {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: boolean;
  schedulers: Array<{
    key: string;
    name: string | null;
    pattern: string | null;
    every: string | null;
    next: string | null;
  }>;
}

export interface FailedJobView {
  id: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  timestamp: string;
  finishedOn: string | null;
}

export interface RuntimeStatusView {
  version: string;
  instanceId: string;
  environment: string;
  startedAt: string;
  uptimeSeconds: number;
  draining: boolean;
  node: string;
  database: {
    ok: boolean;
    latencyMs: number | null;
    pool: { total: number; idle: number; waiting: number };
  };
  migrations: { known: number; applied: number; pending: string[] } | { error: string };
  redis: { ok: boolean; latencyMs: number | null; keyPrefix: string };
  storage: { dir: string; writable: boolean };
  queues: QueueStatsView[] | null;
  inlineJobs: boolean;
}

export interface IntegrityRunView {
  id: string;
  companyId: string;
  companyCode: string;
  asOf: string;
  status: 'OK' | 'WARNING' | 'CRITICAL' | 'FAILED';
  criticalCount: number;
  warningCount: number;
  findings: Array<{ name: string; severity: string; count: number }>;
  error: string | null;
  notified: boolean;
  jobRunId: string | null;
  triggeredBy: string | null;
  ranAt: string;
}
