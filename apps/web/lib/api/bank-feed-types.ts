/* API response shapes for bank feed auto-reconciliation (Prompt #12). */
import type {
  BankFeedAction,
  BankFeedResultType,
  BankRuleDirection,
  BankRuleMatchMode,
  BankRuleStatus,
  BankSuggestionConfidence,
  BankSuggestionPayload,
  BankSuggestionSource,
  BankSuggestionStatus,
  BankTransactionType,
  StatementLineStatus,
} from '@accounting/types';
import type { IntegrityReport } from './types';

export interface BankMatchingRule {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  status: BankRuleStatus;
  bankAccountId: string | null;
  bankAccountCode: string | null;
  direction: BankRuleDirection;
  descriptionPattern: string | null;
  descriptionMode: BankRuleMatchMode;
  referencePattern: string | null;
  referenceMode: BankRuleMatchMode;
  amountMin: string | null;
  amountMax: string | null;
  action: BankFeedAction;
  transactionType: BankTransactionType | null;
  counterpartyAccountId: string | null;
  counterpartyAccountCode: string | null;
  partyId: string | null;
  partyName: string | null;
  memo: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  autoApply: boolean;
  hitCount: number;
  lastHitAt: string | null;
}

export interface BankFeedSettings {
  companyId: string;
  autoApplyRules: boolean;
  autoApplyDocumentMatches: boolean;
  staleAfterDays: number;
  historyMinOccurrences: number;
}

export interface BankSuggestion {
  id: string;
  statementLineId: string;
  source: BankSuggestionSource;
  action: BankFeedAction;
  ruleId: string | null;
  ruleName: string | null;
  confidence: BankSuggestionConfidence;
  payload: BankSuggestionPayload;
  explanation: string;
  status: BankSuggestionStatus;
  resultType: BankFeedResultType | null;
  resultId: string | null;
  resultNumber: string | null;
  appliedAt: string | null;
}

export interface FeedQueueLine {
  id: string;
  statementId: string;
  statementNumber: string;
  bankAccountId: string;
  bankAccountCode: string;
  currency: string;
  lineDate: string;
  description: string;
  reference: string | null;
  amount: string;
  status: StatementLineStatus;
  matchNote: string | null;
  ageDays: number;
  suggestions: BankSuggestion[];
}

export interface SuggestSummary {
  lines: number;
  suggested: number;
  autoApplied: number;
  failed: number;
}

export interface RuleTestResult {
  matched: number;
  total: number;
  lines: Array<{
    id: string;
    lineDate: string;
    amount: string;
    description: string;
    reference: string | null;
    statementNumber: string;
  }>;
}

export interface FeedDashboard {
  asOf: string;
  days: number;
  currency: string;
  imported: number;
  explained: number;
  autoMatched: number;
  ruleApplied: number;
  documentApplied: number;
  manual: number;
  pendingLines: number;
  pendingSuggestions: number;
  staleLines: number;
  automationRate: string;
  byBankAccount: Array<{
    bankAccountId: string;
    code: string;
    name: string;
    imported: number;
    unexplained: number;
    unexplainedIn: string;
    unexplainedOut: string;
  }>;
  topRules: Array<{ id: string; name: string; hitCount: number; lastHitAt: string | null }>;
  ageing: Array<{ bucket: string; lines: number; amount: string }>;
}

export type BankFeedIntegrityReport = IntegrityReport;
