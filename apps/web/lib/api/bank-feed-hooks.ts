'use client';
/* TanStack Query hooks for bank feed auto-reconciliation (Prompt #12). Company-scoped. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplyBankSuggestionInput,
  BankFeedQueueQuery,
  CreateBankMatchingRuleInput,
  ExplainBankLineInput,
  SuggestBankFeedInput,
  TestBankMatchingRuleInput,
  UpdateBankFeedSettingsInput,
  UpdateBankMatchingRuleInput,
} from '@accounting/validation';
import type {
  BankFeedIntegrityReport,
  BankFeedSettings,
  BankMatchingRule,
  BankSuggestion,
  FeedDashboard,
  FeedQueueLine,
  RuleTestResult,
  SuggestSummary,
} from './bank-feed-types';
import { api } from './client';
import type { PaginatedResult } from './types';

const key = (...rest: unknown[]) => ['bank-feed', ...rest] as const;

/** Applying a suggestion posts documents and matches statement lines. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    'bank-feed',
    'banking',
    'bank-statements',
    'bank-transactions',
    'journal-entries',
    'general-ledger',
    'invoices',
    'bills',
    'treasury',
  ])
    void qc.invalidateQueries({ queryKey: [k] });
}

export const useBankFeedSettings = () =>
  useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<BankFeedSettings>('/banking/feed/settings'),
  });
export const useUpdateBankFeedSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBankFeedSettingsInput) =>
      api.put<BankFeedSettings>('/banking/feed/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useBankMatchingRules = () =>
  useQuery({
    queryKey: key('rules'),
    queryFn: () => api.get<BankMatchingRule[]>('/banking/feed/rules'),
  });
export const useCreateBankMatchingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBankMatchingRuleInput) =>
      api.post<BankMatchingRule>('/banking/feed/rules', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateBankMatchingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBankMatchingRuleInput & { id: string }) =>
      api.patch<BankMatchingRule>(`/banking/feed/rules/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useDeleteBankMatchingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/banking/feed/rules/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useTestBankMatchingRule = () =>
  useMutation({
    mutationFn: (input: TestBankMatchingRuleInput) =>
      api.post<RuleTestResult>('/banking/feed/rules/test', input),
  });

export const useBankFeedQueue = (query: Partial<BankFeedQueueQuery> = {}) =>
  useQuery({
    queryKey: key('queue', query),
    queryFn: () =>
      api.get<PaginatedResult<FeedQueueLine>>('/banking/feed/queue', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useSuggestBankFeed = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SuggestBankFeedInput = {}) =>
      api.post<SuggestSummary>('/banking/feed/suggest', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useApplyBankSuggestion = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ApplyBankSuggestionInput & { id: string }) =>
      api.post<BankSuggestion>(`/banking/feed/suggestions/${id}/apply`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useDismissBankSuggestion = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<BankSuggestion>(`/banking/feed/suggestions/${id}/dismiss`, {}),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useExplainBankLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, ...input }: ExplainBankLineInput & { lineId: string }) =>
      api.post<BankSuggestion>(`/banking/feed/lines/${lineId}/explain`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useBankFeedDashboard = (asOf: string, days = 30) =>
  useQuery({
    queryKey: key('dashboard', asOf, days),
    queryFn: () => api.get<FeedDashboard>('/banking/feed/dashboard', { query: { asOf, days } }),
  });
export const useBankFeedIntegrity = (asOf: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () => api.get<BankFeedIntegrityReport>('/banking/feed/integrity', { query: { asOf } }),
  });
