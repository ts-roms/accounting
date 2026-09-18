'use client';
/* TanStack Query hooks for fixed assets, depreciation runs, bank accounts, transactions and statements. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BankingSettingsInput,
  CapitalizeAssetInput,
  CreateAssetCategoryInput,
  CreateAssetInput,
  CreateBankAccountInput,
  CreateBankTransactionInput,
  CreateDepreciationRunInput,
  DisposeAssetInput,
  FixedAssetSettingsInput,
  ImpairAssetInput,
  ImportStatementInput,
  ListAssetsQuery,
  ListBankTransactionsQuery,
  ListDepreciationRunsQuery,
  ListStatementsQuery,
  RevalueAssetInput,
  TransferAssetInput,
  UpdateAssetCategoryInput,
  UpdateAssetInput,
  UpdateBankAccountInput,
  UpdateBankTransactionInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  AssetCategory,
  BankAccount,
  BankLedgerLine,
  BankStatement,
  BankStatementLine,
  BankTransaction,
  BankingSettings,
  DepreciationRun,
  DepreciationRunDetail,
  DepreciationRunLine,
  FixedAsset,
  FixedAssetDetail,
  FixedAssetSettings,
  PaginatedResult,
  ReconciliationView,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';
const FA = 'fixed-assets';
const BK = 'banking';
const faKey = (...rest: unknown[]) => [FA, company(), ...rest] as const;
const bkKey = (...rest: unknown[]) => [BK, company(), ...rest] as const;

function invalidateLedger(qc: ReturnType<typeof useQueryClient>, root: string) {
  for (const k of [
    root,
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'balance-sheet',
    'dashboard',
  ]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

// ---------------------------------------------------------------- fixed assets

export const useAssetCategories = () =>
  useQuery({
    queryKey: faKey('categories'),
    queryFn: () => api.get<AssetCategory[]>('/asset-categories'),
  });

export const useCreateAssetCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAssetCategoryInput) =>
      api.post<AssetCategory>('/asset-categories', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

export const useUpdateAssetCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAssetCategoryInput & { id: string }) =>
      api.patch<AssetCategory>(`/asset-categories/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

export const useFixedAssets = (query: Partial<ListAssetsQuery>) =>
  useQuery({
    queryKey: faKey('assets', query),
    queryFn: () => api.get<PaginatedResult<FixedAsset>>('/fixed-assets', { query }),
    placeholderData: (p) => p,
  });

export const useFixedAsset = (id: string | null) =>
  useQuery({
    queryKey: faKey('asset', id),
    queryFn: () => api.get<FixedAssetDetail>(`/fixed-assets/${id}`),
    enabled: Boolean(id),
  });

export const useCreateFixedAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAssetInput) => api.post<FixedAssetDetail>('/fixed-assets', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

export const useUpdateFixedAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAssetInput & { id: string }) =>
      api.patch<FixedAssetDetail>(`/fixed-assets/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

export const useDeleteFixedAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/fixed-assets/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

/** Lifecycle actions: capitalize / transfer / impair / revalue / dispose. */
export type AssetAction = 'capitalize' | 'transfer' | 'impair' | 'revalue' | 'dispose';
export type AssetActionInput =
  | { action: 'capitalize'; input: CapitalizeAssetInput }
  | { action: 'transfer'; input: TransferAssetInput }
  | { action: 'impair'; input: ImpairAssetInput }
  | { action: 'revalue'; input: RevalueAssetInput }
  | { action: 'dispose'; input: DisposeAssetInput };

export const useAssetAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, input }: AssetActionInput & { id: string }) =>
      api.post<FixedAssetDetail>(`/fixed-assets/${id}/${action}`, input),
    onSuccess: () => invalidateLedger(qc, FA),
  });
};

export const useFixedAssetSettings = () =>
  useQuery({
    queryKey: faKey('settings'),
    queryFn: () => api.get<FixedAssetSettings>('/fixed-assets/settings'),
  });

export const useUpdateFixedAssetSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FixedAssetSettingsInput) =>
      api.put<FixedAssetSettings>('/fixed-assets/settings', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: faKey('settings') }),
  });
};

// ---------------------------------------------------------- depreciation runs

export const useDepreciationRuns = (query: Partial<ListDepreciationRunsQuery>) =>
  useQuery({
    queryKey: faKey('runs', query),
    queryFn: () => api.get<PaginatedResult<DepreciationRun>>('/depreciation-runs', { query }),
    placeholderData: (p) => p,
  });

export const useDepreciationRun = (id: string | null) =>
  useQuery({
    queryKey: faKey('run', id),
    queryFn: () => api.get<DepreciationRunDetail>(`/depreciation-runs/${id}`),
    enabled: Boolean(id),
  });

export const useDepreciationPreview = (fiscalPeriodId: string | null) =>
  useQuery({
    queryKey: faKey('preview', fiscalPeriodId),
    queryFn: () =>
      api.get<DepreciationRunLine[]>('/depreciation-runs/preview', { query: { fiscalPeriodId } }),
    enabled: Boolean(fiscalPeriodId),
  });

export const useCreateDepreciationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDepreciationRunInput) =>
      api.post<DepreciationRunDetail>('/depreciation-runs', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

export const useDeleteDepreciationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/depreciation-runs/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FA] }),
  });
};

export const usePostDepreciationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DepreciationRunDetail>(`/depreciation-runs/${id}/post`),
    onSuccess: () => invalidateLedger(qc, FA),
  });
};

export const useReverseDepreciationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<DepreciationRunDetail>(`/depreciation-runs/${id}/reverse`, { reason }),
    onSuccess: () => invalidateLedger(qc, FA),
  });
};

// --------------------------------------------------------------- bank accounts

export const useBankAccounts = () =>
  useQuery({
    queryKey: bkKey('accounts'),
    queryFn: () => api.get<BankAccount[]>('/bank-accounts'),
  });

export const useBankAccount = (id: string | null) =>
  useQuery({
    queryKey: bkKey('account', id),
    queryFn: () => api.get<BankAccount>(`/bank-accounts/${id}`),
    enabled: Boolean(id),
  });

export const useCreateBankAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBankAccountInput) => api.post<BankAccount>('/bank-accounts', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const useUpdateBankAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBankAccountInput & { id: string }) =>
      api.patch<BankAccount>(`/bank-accounts/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const useBankingSettings = () =>
  useQuery({
    queryKey: bkKey('settings'),
    queryFn: () => api.get<BankingSettings>('/bank-accounts/settings'),
  });

export const useUpdateBankingSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankingSettingsInput) =>
      api.put<BankingSettings>('/bank-accounts/settings', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bkKey('settings') }),
  });
};

// ----------------------------------------------------------- bank transactions

export const useBankTransactions = (query: Partial<ListBankTransactionsQuery>) =>
  useQuery({
    queryKey: bkKey('transactions', query),
    queryFn: () => api.get<PaginatedResult<BankTransaction>>('/bank-transactions', { query }),
    placeholderData: (p) => p,
  });

export const useBankTransaction = (id: string | null) =>
  useQuery({
    queryKey: bkKey('transaction', id),
    queryFn: () => api.get<BankTransaction>(`/bank-transactions/${id}`),
    enabled: Boolean(id),
  });

export const useCreateBankTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBankTransactionInput) =>
      api.post<BankTransaction>('/bank-transactions', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const useUpdateBankTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBankTransactionInput & { id: string }) =>
      api.patch<BankTransaction>(`/bank-transactions/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const useDeleteBankTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/bank-transactions/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const usePostBankTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<BankTransaction>(`/bank-transactions/${id}/post`),
    onSuccess: () => invalidateLedger(qc, BK),
  });
};

export const useVoidBankTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<BankTransaction>(`/bank-transactions/${id}/void`, { reason }),
    onSuccess: () => invalidateLedger(qc, BK),
  });
};

// ------------------------------------------------------------ bank statements

export const useBankStatements = (query: Partial<ListStatementsQuery>) =>
  useQuery({
    queryKey: bkKey('statements', query),
    queryFn: () => api.get<PaginatedResult<BankStatement>>('/bank-statements', { query }),
    placeholderData: (p) => p,
  });

export const useBankStatement = (id: string | null) =>
  useQuery({
    queryKey: bkKey('statement', id),
    queryFn: () => api.get<BankStatement>(`/bank-statements/${id}`),
    enabled: Boolean(id),
  });

export const useStatementLines = (id: string | null) =>
  useQuery({
    queryKey: bkKey('statement-lines', id),
    queryFn: () => api.get<BankStatementLine[]>(`/bank-statements/${id}/lines`),
    enabled: Boolean(id),
  });

export const useStatementLedgerLines = (id: string | null, onlyUnmatched = true) =>
  useQuery({
    queryKey: bkKey('statement-ledger', id, onlyUnmatched),
    queryFn: () =>
      api.get<BankLedgerLine[]>(`/bank-statements/${id}/ledger-lines`, {
        query: { onlyUnmatched },
      }),
    enabled: Boolean(id),
  });

export const useReconciliation = (id: string | null) =>
  useQuery({
    queryKey: bkKey('reconciliation', id),
    queryFn: () => api.get<ReconciliationView>(`/bank-statements/${id}/reconciliation`),
    enabled: Boolean(id),
  });

export interface ParsedStatementFile {
  format: 'MT940' | 'CAMT053' | 'OFX';
  accountRef: string | null;
  currency: string | null;
  statementDate: string;
  openingBalance: string;
  closingBalance: string;
  lines: Array<{ lineDate: string; description: string; reference?: string; amount: string }>;
  warnings: string[];
}

/** Server-side parse of an MT940 / camt.053 / OFX file; nothing is stored. */
export const useParseStatementFile = () =>
  useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api.post<ParsedStatementFile>('/bank-statements/parse', body);
    },
  });

export const useImportStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportStatementInput) => api.post<BankStatement>('/bank-statements', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export type StatementLineAction =
  | { action: 'match'; lineId: string; journalLineId: string }
  | { action: 'unmatch'; lineId: string }
  | { action: 'ignore'; lineId: string; note: string };

export const useStatementLineAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statementId, ...a }: StatementLineAction & { statementId: string }) =>
      api.post<BankStatementLine>(
        `/bank-statements/${statementId}/lines/${a.lineId}/${a.action}`,
        a.action === 'match'
          ? { journalLineId: a.journalLineId }
          : a.action === 'ignore'
            ? { note: a.note }
            : undefined,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const useRematchStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<BankStatement>(`/bank-statements/${id}/rematch`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [BK] }),
  });
};

export const useCompleteReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      api.post<ReconciliationView>(`/bank-statements/${id}/complete`, { notes }),
    onSuccess: () => invalidateLedger(qc, BK),
  });
};
