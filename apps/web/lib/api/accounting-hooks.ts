'use client';
/* TanStack Query hooks for the accounting core. All keys include the active company. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BalanceSheetQuery,
  CreateAccountInput,
  CreateFiscalYearInput,
  CreateJournalEntryInput,
  GeneralLedgerQuery,
  IncomeStatementQuery,
  IncomeStatementTrendQuery,
  ListAccountsQuery,
  ListJournalEntriesQuery,
  RejectJournalEntryInput,
  CorrectJournalEntryInput,
  ReverseJournalEntryInput,
  SetAccountMappingInput,
  TrialBalanceQuery,
  UpdateAccountInput,
  UpdateJournalEntryInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  Account,
  AccountMappingView,
  AccountNode,
  BalanceSheetReport,
  FiscalPeriod,
  FiscalYear,
  IncomeStatementReport,
  IncomeStatementTrend,
  IntegrityReport,
  IntegrityRunView,
  JournalCorrectionResult,
  JournalEntryDetail,
  JournalEntryView,
  LedgerResult,
  PaginatedResult,
  TrialBalanceReport,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';

export const accountingKeys = {
  accounts: (query?: Partial<ListAccountsQuery>) => ['accounts', company(), query ?? {}] as const,
  mappings: () => ['account-mappings', company()] as const,
  fiscalYears: () => ['fiscal-years', company()] as const,
  journals: (query: Partial<ListJournalEntriesQuery>) =>
    ['journal-entries', company(), query] as const,
  journal: (id: string) => ['journal-entry', company(), id] as const,
  ledger: (query: Partial<GeneralLedgerQuery>) => ['general-ledger', company(), query] as const,
  trialBalance: (query: Partial<TrialBalanceQuery>) => ['trial-balance', company(), query] as const,
  incomeStatement: (query: Partial<IncomeStatementQuery>) =>
    ['income-statement', company(), query] as const,
  incomeStatementTrend: (query: Partial<IncomeStatementTrendQuery>) =>
    ['income-statement-trend', company(), query] as const,
  balanceSheet: (query: Partial<BalanceSheetQuery>) => ['balance-sheet', company(), query] as const,
};

const invalidateLedgerViews = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of [
    'journal-entries',
    'journal-entry',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'income-statement-trend',
    'balance-sheet',
    'fiscal-years',
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
};

// ----------------------------------------------------------------- accounts

export const useAccounts = (query?: Partial<ListAccountsQuery>, enabled = true) =>
  useQuery({
    queryKey: accountingKeys.accounts(query),
    queryFn: () => api.get<AccountNode[]>('/accounts', { query }),
    enabled,
    staleTime: 60_000,
  });

export const useCreateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) => api.post<Account>('/accounts', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
};

export const useUpdateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAccountInput & { id: string }) =>
      api.patch<Account>(`/accounts/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
};

export const useDeleteAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/accounts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
};

export const useAccountMappings = () =>
  useQuery({
    queryKey: accountingKeys.mappings(),
    queryFn: () => api.get<AccountMappingView[]>('/accounts/mappings'),
  });

export const useSetAccountMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetAccountMappingInput) => api.put<void>('/accounts/mappings', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['account-mappings'] }),
  });
};

// ------------------------------------------------------------ fiscal periods

export const useFiscalYears = (enabled = true) =>
  useQuery({
    queryKey: accountingKeys.fiscalYears(),
    queryFn: () => api.get<FiscalYear[]>('/fiscal-years'),
    enabled,
  });

export const useCreateFiscalYear = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFiscalYearInput) => api.post<FiscalYear>('/fiscal-years', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal-years'] }),
  });
};

export const usePeriodAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'close' | 'reopen' | 'soft-close' | 'lock';
      reason?: string;
    }) => api.post<FiscalPeriod>(`/fiscal-periods/${id}/${action}`, { reason }),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export const useCloseFiscalYear = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<FiscalYear>(`/fiscal-years/${id}/close`),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

// ----------------------------------------------------------------- journals

export const useJournalEntries = (query: Partial<ListJournalEntriesQuery>, enabled = true) =>
  useQuery({
    queryKey: accountingKeys.journals(query),
    queryFn: () => api.get<PaginatedResult<JournalEntryView>>('/journal-entries', { query }),
    placeholderData: (prev) => prev,
    enabled,
  });

export const useJournalEntry = (id: string | null) =>
  useQuery({
    queryKey: accountingKeys.journal(id ?? ''),
    queryFn: () => api.get<JournalEntryDetail>(`/journal-entries/${id}`),
    enabled: Boolean(id),
  });

export const useCreateJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJournalEntryInput) =>
      api.post<JournalEntryDetail>('/journal-entries', input),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export const useUpdateJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateJournalEntryInput & { id: string }) =>
      api.patch<JournalEntryDetail>(`/journal-entries/${id}`, input),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export const useDeleteJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/journal-entries/${id}`),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export type JournalAction = 'submit' | 'approve' | 'post';

export const useJournalAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: JournalAction }) =>
      api.post<JournalEntryDetail>(`/journal-entries/${id}/${action}`),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export const useRejectJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: RejectJournalEntryInput & { id: string }) =>
      api.post<JournalEntryDetail>(`/journal-entries/${id}/reject`, input),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export const useReverseJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReverseJournalEntryInput & { id: string }) =>
      api.post<JournalEntryDetail>(`/journal-entries/${id}/reverse`, input),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

export const useCorrectJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CorrectJournalEntryInput & { id: string }) =>
      api.post<JournalCorrectionResult>(`/journal-entries/${id}/correct`, input),
    onSuccess: () => invalidateLedgerViews(qc),
  });
};

// ------------------------------------------------------------------ reports

export const useGeneralLedger = (query: Partial<GeneralLedgerQuery>, enabled: boolean) =>
  useQuery({
    queryKey: accountingKeys.ledger(query),
    queryFn: () => api.get<LedgerResult>('/general-ledger', { query }),
    enabled,
    placeholderData: (prev) => prev,
  });

export const useTrialBalance = (query: TrialBalanceQuery, enabled = true) =>
  useQuery({
    queryKey: accountingKeys.trialBalance(query),
    queryFn: () => api.get<TrialBalanceReport>('/reports/trial-balance', { query }),
    enabled,
    placeholderData: (p) => p,
  });

export const useIncomeStatement = (query: IncomeStatementQuery, enabled = true) =>
  useQuery({
    queryKey: accountingKeys.incomeStatement(query),
    queryFn: () => api.get<IncomeStatementReport>('/reports/income-statement', { query }),
    enabled,
    placeholderData: (p) => p,
  });

/** Monthly section totals in one request (the dashboard trend and MTD tiles). */
export const useIncomeStatementTrend = (query: IncomeStatementTrendQuery, enabled = true) =>
  useQuery({
    queryKey: accountingKeys.incomeStatementTrend(query),
    queryFn: () => api.get<IncomeStatementTrend>('/reports/income-statement/trend', { query }),
    enabled,
    staleTime: 60_000,
    placeholderData: (p) => p,
  });

export const useBalanceSheet = (query: BalanceSheetQuery, enabled = true) =>
  useQuery({
    queryKey: accountingKeys.balanceSheet(query),
    queryFn: () => api.get<BalanceSheetReport>('/reports/balance-sheet', { query }),
    enabled,
    placeholderData: (p) => p,
  });

// ---------------------------------------------------------------- integrity

const integrityRunKey = () => ['integrity-run', company()] as const;

/** Latest stored integrity run (the scheduled job or "Run now"); null before the first run. */
export const useLatestIntegrityRun = (enabled = true) =>
  useQuery({
    queryKey: integrityRunKey(),
    queryFn: () => api.get<IntegrityRunView | null>('/integrity/runs/latest'),
    staleTime: 60_000,
    enabled,
  });

export const useRunIntegrityNow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<IntegrityRunView>('/integrity/runs', {}),
    onSuccess: (run) => {
      qc.setQueryData(integrityRunKey(), run);
      void qc.invalidateQueries({ queryKey: ['integrity'] });
    },
  });
};

export const useIntegrityReport = (asOf: string, enabled = true) =>
  useQuery({
    queryKey: ['integrity', getActiveCompanyId() ?? 'none', asOf] as const,
    queryFn: () => api.get<IntegrityReport>('/integrity', { query: { asOf } }),
    staleTime: 30_000,
    enabled,
  });
