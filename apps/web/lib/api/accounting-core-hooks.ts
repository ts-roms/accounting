'use client';
/* TanStack Query hooks for the accounting core extensions (recurring journals,
 * prepayments, posting rules, dimension rules, cash flow, suspense). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CashFlowQuery,
  DimensionRuleInput,
  ListPrepaymentsQuery,
  ListRecurringJournalsQuery,
  OpeningBalancesInput,
  PostingRuleInput,
  PrepaymentInput,
  RecognizePrepaymentsInput,
  RecurringJournalInput,
  RunRecurringJournalsInput,
  SimulatePostingRuleInput,
  UpdateDimensionRuleInput,
  UpdatePostingRuleInput,
  UpdateRecurringJournalInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  CashFlowStatement,
  DimensionRule,
  JournalEntryDetail,
  PaginatedResult,
  PostingRule,
  Prepayment,
  PrepaymentDetail,
  RecognitionResult,
  RecurringJournal,
  RecurringJournalDetail,
  RecurringRunResult,
  ResolvedPostingRule,
  SuspenseMonitor,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';

export const coreKeys = {
  cashFlow: (q: Partial<CashFlowQuery>) => ['cash-flow', company(), q] as const,
  recurring: (q: Partial<ListRecurringJournalsQuery>) =>
    ['recurring-journals', company(), q] as const,
  recurringOne: (id: string) => ['recurring-journal', company(), id] as const,
  prepayments: (q: Partial<ListPrepaymentsQuery>) => ['prepayments', company(), q] as const,
  prepayment: (id: string) => ['prepayment', company(), id] as const,
  postingRules: () => ['posting-rules', company()] as const,
  dimensionRules: () => ['dimension-rules', company()] as const,
  suspense: (asOf: string) => ['suspense', company(), asOf] as const,
};

const invalidate = (qc: ReturnType<typeof useQueryClient>, keys: string[]) => {
  for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
};
const LEDGER_KEYS = [
  'journal-entries',
  'journal-entry',
  'general-ledger',
  'trial-balance',
  'income-statement',
  'balance-sheet',
  'cash-flow',
  'suspense',
];

// ------------------------------------------------------------------ reports

export const useCashFlow = (query: CashFlowQuery, enabled = true) =>
  useQuery({
    queryKey: coreKeys.cashFlow(query),
    queryFn: () => api.get<CashFlowStatement>('/reports/cash-flow', { query }),
    enabled,
  });

export const useSuspenseMonitor = (asOf: string) =>
  useQuery({
    queryKey: coreKeys.suspense(asOf),
    queryFn: () => api.get<SuspenseMonitor>('/accounting/suspense', { query: { asOf } }),
  });

// --------------------------------------------------------- opening balances

export const useCreateOpeningBalances = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpeningBalancesInput) =>
      api.post<JournalEntryDetail>('/journal-entries/opening-balances', input),
    onSuccess: () => invalidate(qc, LEDGER_KEYS),
  });
};

// -------------------------------------------------------- recurring journals

export const useRecurringJournals = (query: Partial<ListRecurringJournalsQuery>) =>
  useQuery({
    queryKey: coreKeys.recurring(query),
    queryFn: () =>
      api.get<PaginatedResult<RecurringJournal>>('/accounting/recurring-journals', { query }),
    placeholderData: (prev) => prev,
  });

export const useRecurringJournal = (id: string | null) =>
  useQuery({
    queryKey: coreKeys.recurringOne(id ?? ''),
    queryFn: () => api.get<RecurringJournalDetail>(`/accounting/recurring-journals/${id}`),
    enabled: Boolean(id),
  });

export const useCreateRecurringJournal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecurringJournalInput) =>
      api.post<RecurringJournalDetail>('/accounting/recurring-journals', input),
    onSuccess: () => invalidate(qc, ['recurring-journals']),
  });
};

export const useUpdateRecurringJournal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateRecurringJournalInput & { id: string }) =>
      api.patch<RecurringJournalDetail>(`/accounting/recurring-journals/${id}`, input),
    onSuccess: () => invalidate(qc, ['recurring-journals', 'recurring-journal']),
  });
};

export const useRunRecurringJournals = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RunRecurringJournalsInput) =>
      api.post<RecurringRunResult>('/accounting/recurring-journals/run', input),
    onSuccess: () => invalidate(qc, ['recurring-journals', 'recurring-journal', ...LEDGER_KEYS]),
  });
};

// ---------------------------------------------------------------- prepayments

export const usePrepayments = (query: Partial<ListPrepaymentsQuery>) =>
  useQuery({
    queryKey: coreKeys.prepayments(query),
    queryFn: () => api.get<PaginatedResult<Prepayment>>('/accounting/prepayments', { query }),
    placeholderData: (prev) => prev,
  });

export const usePrepayment = (id: string | null) =>
  useQuery({
    queryKey: coreKeys.prepayment(id ?? ''),
    queryFn: () => api.get<PrepaymentDetail>(`/accounting/prepayments/${id}`),
    enabled: Boolean(id),
  });

export const useCreatePrepayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PrepaymentInput) =>
      api.post<PrepaymentDetail>('/accounting/prepayments', input),
    onSuccess: () => invalidate(qc, ['prepayments']),
  });
};

export const usePrepaymentAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'activate' | 'cancel';
      reason?: string;
    }) =>
      api.post<PrepaymentDetail>(
        `/accounting/prepayments/${id}/${action}`,
        action === 'cancel' ? { reason } : undefined,
      ),
    onSuccess: () => invalidate(qc, ['prepayments', 'prepayment', ...LEDGER_KEYS]),
  });
};

export const useRecognizePrepayments = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecognizePrepaymentsInput) =>
      api.post<RecognitionResult>('/accounting/prepayments/recognize', input),
    onSuccess: () => invalidate(qc, ['prepayments', 'prepayment', ...LEDGER_KEYS]),
  });
};

// -------------------------------------------------------------- posting rules

export const usePostingRules = () =>
  useQuery({
    queryKey: coreKeys.postingRules(),
    queryFn: () => api.get<PostingRule[]>('/accounting/posting-rules'),
  });

export const useCreatePostingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PostingRuleInput) =>
      api.post<PostingRule>('/accounting/posting-rules', input),
    onSuccess: () => invalidate(qc, ['posting-rules']),
  });
};

export const useUpdatePostingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePostingRuleInput & { id: string }) =>
      api.patch<PostingRule>(`/accounting/posting-rules/${id}`, input),
    onSuccess: () => invalidate(qc, ['posting-rules']),
  });
};

export const useSimulatePostingRule = () =>
  useMutation({
    mutationFn: ({ id, ...input }: SimulatePostingRuleInput & { id: string }) =>
      api.post<ResolvedPostingRule>(`/accounting/posting-rules/${id}/simulate`, input),
  });

// ------------------------------------------------------------ dimension rules

export const useDimensionRules = () =>
  useQuery({
    queryKey: coreKeys.dimensionRules(),
    queryFn: () => api.get<DimensionRule[]>('/accounting/dimension-rules'),
  });

export const useCreateDimensionRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DimensionRuleInput) =>
      api.post<DimensionRule>('/accounting/dimension-rules', input),
    onSuccess: () => invalidate(qc, ['dimension-rules']),
  });
};

export const useUpdateDimensionRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateDimensionRuleInput & { id: string }) =>
      api.patch<DimensionRule>(`/accounting/dimension-rules/${id}`, input),
    onSuccess: () => invalidate(qc, ['dimension-rules']),
  });
};
