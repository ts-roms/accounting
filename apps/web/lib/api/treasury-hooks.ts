'use client';
/* TanStack Query hooks for cash management & treasury (Prompt #8). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_PATH, HEADERS } from '@accounting/config';
import type {
  BankAccountProfileInput,
  CashForecastQuery,
  CashPositionQuery,
  CreateBankTransferInput,
  CreateForecastItemInput,
  CreatePaymentFileInput,
  CreatePettyCashFundInput,
  CreatePettyCashVoucherInput,
  ListBankTransfersQuery,
  ListPaymentFilesQuery,
  ListPettyCashVouchersQuery,
  PaymentFileStatusInput,
  ReplenishPettyCashInput,
  SettleBankTransferInput,
  TreasurySettingsInput,
  UpdateForecastItemInput,
  UpdatePettyCashFundInput,
  UpdatePettyCashVoucherInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  BankAccountProfile,
  BankTransfer,
  CashForecast,
  CashForecastItem,
  CashForecastSnapshot,
  CashPosition,
  PaymentFile,
  PaymentFileDetail,
  PettyCashFund,
  PettyCashVoucher,
  PettyCashVoucherDetail,
  TreasuryDashboard,
  TreasuryIntegrityReport,
  TreasurySettings,
  TreasurySweepResult,
} from './treasury-types';
import type { PaginatedResult } from './types';

const company = () => getActiveCompanyId() ?? 'none';
const key = (...rest: unknown[]) => ['treasury', company(), ...rest] as const;

/** Treasury postings move bank balances, the ledger and the AP views that feed the forecast. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    'treasury',
    'banking',
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'AP',
  ])
    void qc.invalidateQueries({ queryKey: [k] });
}

// ---------------------------------------------------------------- reads

export const useTreasuryDashboard = (asOf?: string) =>
  useQuery({
    queryKey: key('dashboard', asOf),
    queryFn: () => api.get<TreasuryDashboard>('/treasury/dashboard', { query: { asOf } }),
  });

export const useCashPosition = (query: CashPositionQuery = {}) =>
  useQuery({
    queryKey: key('position', query),
    queryFn: () => api.get<CashPosition>('/treasury/position', { query }),
  });

export const useCashForecast = (query: Partial<CashForecastQuery>) =>
  useQuery({
    queryKey: key('forecast', query),
    queryFn: () => api.get<CashForecast>('/treasury/forecast', { query }),
    placeholderData: (prev) => prev,
  });

export const useForecastSnapshots = () =>
  useQuery({
    queryKey: key('forecast-snapshots'),
    queryFn: () => api.get<CashForecastSnapshot[]>('/treasury/forecast/snapshots'),
  });

export const useForecastItems = (
  query: { page?: number; pageSize?: number; activeOnly?: boolean } = {},
) =>
  useQuery({
    queryKey: key('forecast-items', query),
    queryFn: () =>
      api.get<PaginatedResult<CashForecastItem>>('/treasury/forecast/items', { query }),
    placeholderData: (prev) => prev,
  });

export const useTreasuryIntegrity = (asOf?: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () => api.get<TreasuryIntegrityReport>('/treasury/integrity', { query: { asOf } }),
  });

export const useTreasurySettings = () =>
  useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<TreasurySettings>('/treasury/settings'),
  });

export const useBankAccountProfile = (bankAccountId: string | null) =>
  useQuery({
    queryKey: key('profile', bankAccountId),
    queryFn: () => api.get<BankAccountProfile>(`/treasury/bank-accounts/${bankAccountId}/profile`),
    enabled: Boolean(bankAccountId),
  });

// ------------------------------------------------------------- mutations

export const useUpdateTreasurySettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TreasurySettingsInput) =>
      api.put<TreasurySettings>('/treasury/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateBankAccountProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      bankAccountId,
      ...input
    }: BankAccountProfileInput & { bankAccountId: string }) =>
      api.put<BankAccountProfile>(`/treasury/bank-accounts/${bankAccountId}/profile`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useRunTreasurySweep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (asOf?: string) =>
      api.post<TreasurySweepResult>('/treasury/sweep', undefined, { query: { asOf } }),
    onSuccess: () => invalidateAll(qc),
  });
};

// forecast items
export const useCreateForecastItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateForecastItemInput) =>
      api.post<CashForecastItem>('/treasury/forecast/items', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateForecastItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateForecastItemInput & { id: string }) =>
      api.patch<CashForecastItem>(`/treasury/forecast/items/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useDeleteForecastItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/treasury/forecast/items/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

// ---------------------------------------------------------------- transfers

export const useBankTransfers = (query: Partial<ListBankTransfersQuery>) =>
  useQuery({
    queryKey: key('transfers', query),
    queryFn: () => api.get<PaginatedResult<BankTransfer>>('/treasury/transfers', { query }),
    placeholderData: (prev) => prev,
  });
export const useBankTransfer = (id: string) =>
  useQuery({
    queryKey: key('transfer', id),
    queryFn: () => api.get<BankTransfer>(`/treasury/transfers/${id}`),
  });
export const useCreateBankTransfer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBankTransferInput) =>
      api.post<BankTransfer>('/treasury/transfers', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export type BankTransferAction = 'submit' | 'approve' | 'send' | 'settle' | 'cancel';
export const useBankTransferAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: BankTransferAction;
      body?: SettleBankTransferInput | { reason: string };
    }) => api.post<BankTransfer>(`/treasury/transfers/${id}/${action}`, body ?? {}),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------ payment files

export const usePaymentFiles = (query: Partial<ListPaymentFilesQuery>) =>
  useQuery({
    queryKey: key('payment-files', query),
    queryFn: () => api.get<PaginatedResult<PaymentFile>>('/treasury/payment-files', { query }),
    placeholderData: (prev) => prev,
  });
export const usePaymentFile = (id: string | null) =>
  useQuery({
    queryKey: key('payment-file', id),
    queryFn: () => api.get<PaymentFileDetail>(`/treasury/payment-files/${id}`),
    enabled: Boolean(id),
  });
export const useCreatePaymentFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentFileInput) =>
      api.post<PaymentFileDetail>('/treasury/payment-files', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useSetPaymentFileStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PaymentFileStatusInput & { id: string }) =>
      api.post<PaymentFileDetail>(`/treasury/payment-files/${id}/status`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
/** Streams the generated file to the browser (the content is never part of the JSON views). */
export const useDownloadPaymentFile = () =>
  useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${API_BASE_PATH}/treasury/payment-files/${id}/download`, {
        credentials: 'include',
        headers: { [HEADERS.COMPANY_ID]: getActiveCompanyId() ?? '' },
      });
      if (!res.ok) throw new Error('The payment file could not be downloaded.');
      const text = await res.text();
      const filename =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'payment-file.txt';
      const url = URL.createObjectURL(
        new Blob([text], { type: res.headers.get('content-type') ?? 'text/plain' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return filename;
    },
  });

// --------------------------------------------------------------- petty cash

export const usePettyCashFunds = () =>
  useQuery({
    queryKey: key('funds'),
    queryFn: () => api.get<PettyCashFund[]>('/treasury/petty-cash/funds'),
  });
export const usePettyCashFund = (id: string | null) =>
  useQuery({
    queryKey: key('fund', id),
    queryFn: () => api.get<PettyCashFund>(`/treasury/petty-cash/funds/${id}`),
    enabled: Boolean(id),
  });
export const useCreatePettyCashFund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePettyCashFundInput) =>
      api.post<PettyCashFund>('/treasury/petty-cash/funds', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdatePettyCashFund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePettyCashFundInput & { id: string }) =>
      api.patch<PettyCashFund>(`/treasury/petty-cash/funds/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useReplenishPettyCash = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReplenishPettyCashInput & { id: string }) =>
      api.post<PettyCashFund>(`/treasury/petty-cash/funds/${id}/replenish`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const usePettyCashVouchers = (query: Partial<ListPettyCashVouchersQuery>) =>
  useQuery({
    queryKey: key('vouchers', query),
    queryFn: () =>
      api.get<PaginatedResult<PettyCashVoucher>>('/treasury/petty-cash/vouchers', { query }),
    placeholderData: (prev) => prev,
  });
export const usePettyCashVoucher = (id: string | null) =>
  useQuery({
    queryKey: key('voucher', id),
    queryFn: () => api.get<PettyCashVoucherDetail>(`/treasury/petty-cash/vouchers/${id}`),
    enabled: Boolean(id),
  });
export const useCreatePettyCashVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePettyCashVoucherInput) =>
      api.post<PettyCashVoucherDetail>('/treasury/petty-cash/vouchers', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdatePettyCashVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePettyCashVoucherInput & { id: string }) =>
      api.patch<PettyCashVoucherDetail>(`/treasury/petty-cash/vouchers/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export type PettyCashVoucherAction = 'approve' | 'post' | 'void';
export const usePettyCashVoucherAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: PettyCashVoucherAction;
      body?: { reason: string; voidDate?: string };
    }) =>
      api.post<PettyCashVoucherDetail>(`/treasury/petty-cash/vouchers/${id}/${action}`, body ?? {}),
    onSuccess: () => invalidateAll(qc),
  });
};
