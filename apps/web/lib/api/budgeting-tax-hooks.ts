'use client';
/* TanStack Query hooks for dimensions, tax codes / reports, budgets and expense claims. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DimensionType, TaxSide } from '@accounting/types';
import type {
  CreateBudgetInput,
  CreateBudgetVersionInput,
  CreateDimensionInput,
  CreateExpenseClaimInput,
  CreateTaxCodeInput,
  ListBudgetsQuery,
  ListExpenseClaimsQuery,
  ListTaxTransactionsQuery,
  PayExpenseClaimInput,
  ReplaceBudgetLinesInput,
  TaxReportQuery,
  UpdateBudgetInput,
  UpdateDimensionInput,
  UpdateExpenseClaimInput,
  UpdateTaxCodeInput,
  VarianceQuery,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  Budget,
  BudgetDetail,
  BudgetVersionDetail,
  Dimension,
  ExpenseClaim,
  ExpenseClaimDetail,
  PaginatedResult,
  TaxCode,
  TaxSummaryReport,
  TaxTransaction,
  VarianceReport,
  WithholdingByPartyRow,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';
const DIM = 'dimensions';
const TAX = 'tax';
const BUD = 'budgets';
const EXP = 'expense-claims';
const key = (root: string, ...rest: unknown[]) => [root, company(), ...rest] as const;

function invalidateLedger(qc: ReturnType<typeof useQueryClient>, root: string) {
  for (const k of [
    root,
    TAX,
    BUD,
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'balance-sheet',
    'dashboard',
    'AP',
  ]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

// ---------------------------------------------------------------- dimensions

export const useDimensions = (dimensionType?: DimensionType, status?: 'ACTIVE' | 'INACTIVE') =>
  useQuery({
    queryKey: key(DIM, dimensionType ?? 'all', status ?? 'all'),
    queryFn: () => api.get<Dimension[]>('/dimensions', { query: { dimensionType, status } }),
  });

export const useCreateDimension = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDimensionInput) => api.post<Dimension>('/dimensions', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [DIM] }),
  });
};

export const useUpdateDimension = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateDimensionInput & { id: string }) =>
      api.patch<Dimension>(`/dimensions/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [DIM] }),
  });
};

// ----------------------------------------------------------------------- tax

export const useTaxCodes = (side?: TaxSide, status: 'ACTIVE' | 'INACTIVE' | undefined = 'ACTIVE') =>
  useQuery({
    queryKey: key(TAX, 'codes', side ?? 'all', status ?? 'all'),
    queryFn: () => api.get<TaxCode[]>('/tax/codes', { query: { side, status } }),
    staleTime: 60_000,
  });

export const useCreateTaxCode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaxCodeInput) => api.post<TaxCode>('/tax/codes', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [TAX] }),
  });
};

export const useUpdateTaxCode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTaxCodeInput & { id: string }) =>
      api.patch<TaxCode>(`/tax/codes/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [TAX] }),
  });
};

export const useTaxTransactions = (query: Partial<ListTaxTransactionsQuery>) =>
  useQuery({
    queryKey: key(TAX, 'transactions', query),
    queryFn: () => api.get<PaginatedResult<TaxTransaction>>('/tax/transactions', { query }),
    placeholderData: (p) => p,
  });

export const useTaxSummary = (query: TaxReportQuery, enabled = true) =>
  useQuery({
    queryKey: key(TAX, 'summary', query),
    queryFn: () => api.get<TaxSummaryReport>('/tax/reports/summary', { query }),
    enabled,
  });

export const useWithholdingReport = (query: TaxReportQuery, enabled = true) =>
  useQuery({
    queryKey: key(TAX, 'withholding', query),
    queryFn: () => api.get<WithholdingByPartyRow[]>('/tax/reports/withholding', { query }),
    enabled,
  });

// ------------------------------------------------------------------- budgets

export const useBudgets = (query: Partial<ListBudgetsQuery>) =>
  useQuery({
    queryKey: key(BUD, 'list', query),
    queryFn: () => api.get<PaginatedResult<Budget>>('/budgets', { query }),
    placeholderData: (p) => p,
  });

export const useBudget = (id: string | null) =>
  useQuery({
    queryKey: key(BUD, 'detail', id),
    queryFn: () => api.get<BudgetDetail>(`/budgets/${id}`),
    enabled: Boolean(id),
  });

export const useBudgetVersion = (budgetId: string | null, versionId: string | null) =>
  useQuery({
    queryKey: key(BUD, 'version', budgetId, versionId),
    queryFn: () => api.get<BudgetVersionDetail>(`/budgets/${budgetId}/versions/${versionId}`),
    enabled: Boolean(budgetId && versionId),
  });

export const useVariance = (
  budgetId: string | null,
  query: Partial<VarianceQuery> & { versionId?: string },
) =>
  useQuery({
    queryKey: key(BUD, 'variance', budgetId, query),
    queryFn: () => api.get<VarianceReport>(`/budgets/${budgetId}/variance`, { query }),
    enabled: Boolean(budgetId),
    placeholderData: (p) => p,
  });

export const useCreateBudget = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBudgetInput) => api.post<BudgetDetail>('/budgets', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

export const useUpdateBudget = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBudgetInput & { id: string }) =>
      api.patch<BudgetDetail>(`/budgets/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

export const useDeleteBudget = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/budgets/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

export const useCreateBudgetVersion = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ budgetId, ...input }: CreateBudgetVersionInput & { budgetId: string }) =>
      api.post<BudgetVersionDetail>(`/budgets/${budgetId}/versions`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

export const useReplaceBudgetLines = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      budgetId,
      versionId,
      ...input
    }: ReplaceBudgetLinesInput & { budgetId: string; versionId: string }) =>
      api.put<BudgetVersionDetail>(`/budgets/${budgetId}/versions/${versionId}/lines`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

export const useApproveBudgetVersion = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ budgetId, versionId }: { budgetId: string; versionId: string }) =>
      api.post<BudgetDetail>(`/budgets/${budgetId}/versions/${versionId}/approve`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

export const useDeleteBudgetVersion = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ budgetId, versionId }: { budgetId: string; versionId: string }) =>
      api.delete<void>(`/budgets/${budgetId}/versions/${versionId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BUD] }),
  });
};

// ------------------------------------------------------------ expense claims

export const useExpenseClaims = (query: Partial<ListExpenseClaimsQuery>) =>
  useQuery({
    queryKey: key(EXP, 'list', query),
    queryFn: () => api.get<PaginatedResult<ExpenseClaim>>('/expense-claims', { query }),
    placeholderData: (p) => p,
  });

export const useExpenseClaim = (id: string | null) =>
  useQuery({
    queryKey: key(EXP, 'detail', id),
    queryFn: () => api.get<ExpenseClaimDetail>(`/expense-claims/${id}`),
    enabled: Boolean(id),
  });

export const useCreateExpenseClaim = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseClaimInput) =>
      api.post<ExpenseClaimDetail>('/expense-claims', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [EXP] }),
  });
};

export const useUpdateExpenseClaim = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateExpenseClaimInput & { id: string }) =>
      api.patch<ExpenseClaimDetail>(`/expense-claims/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [EXP] }),
  });
};

export const useDeleteExpenseClaim = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/expense-claims/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [EXP] }),
  });
};

export type ExpenseClaimAction =
  | { action: 'submit' | 'approve' | 'post' }
  | { action: 'reject' | 'cancel'; reason: string }
  | ({ action: 'pay' } & PayExpenseClaimInput);

export const useExpenseClaimAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...a }: ExpenseClaimAction & { id: string }) => {
      const { action, ...body } = a;
      return api.post<ExpenseClaimDetail>(
        `/expense-claims/${id}/${action}`,
        Object.keys(body).length ? body : undefined,
      );
    },
    onSuccess: () => invalidateLedger(qc, EXP),
  });
};
