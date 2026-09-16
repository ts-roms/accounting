'use client';
/* TanStack Query hooks for the AP / procure-to-pay platform (Prompt #7). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE_PATH, HEADERS } from '@accounting/config';
import type {
  ApSettingsInput,
  BillHoldInput,
  CashRequirementsQuery,
  CreateApAccrualInput,
  CreatePaymentRunInput,
  CreateVendorGroupInput,
  GrniQuery,
  ListApAccrualsQuery,
  ListBillHoldsQuery,
  ListPaymentRunsQuery,
  ListVendorsQuery,
  ReleaseBillHoldInput,
  UpdatePaymentRunLinesInput,
  UpdateVendorGroupInput,
  VendorAddressInput,
  VendorApprovalInput,
  VendorBankAccountInput,
  VendorContactInput,
  VendorHoldInput,
  VendorProfileInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  ApAccrual,
  ApAccrualDetail,
  ApDashboard,
  ApIntegrityReport,
  ApReconciliation,
  ApSettings,
  BillHold,
  CashRequirementsReport,
  GrniReport,
  PaymentRun,
  PaymentRunDetail,
  VendorAddress,
  VendorBankAccount,
  VendorContact,
  VendorDetail,
  VendorGroup,
  VendorProfile,
  VendorSummary,
} from './payables-types';
import type { PaginatedResult, StatementReport, SubledgerDocumentDetail } from './types';

const company = () => getActiveCompanyId() ?? 'none';
const key = (...rest: unknown[]) => ['AP', company(), 'platform', ...rest] as const;

/** AP changes move ledger-derived views and the shared subledger screens too. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['AP', 'journal-entries', 'general-ledger', 'trial-balance', 'orders'])
    void qc.invalidateQueries({ queryKey: [k] });
}

// ---------------------------------------------------------------- settings

export const useApSettings = () =>
  useQuery({ queryKey: key('settings'), queryFn: () => api.get<ApSettings>('/ap-settings') });
export const useUpdateApSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApSettingsInput) => api.patch<ApSettings>('/ap-settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useVendorGroups = () =>
  useQuery({
    queryKey: key('vendor-groups'),
    queryFn: () => api.get<VendorGroup[]>('/vendor-groups'),
  });
export const useCreateVendorGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVendorGroupInput) => api.post<VendorGroup>('/vendor-groups', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateVendorGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateVendorGroupInput & { id: string }) =>
      api.patch<VendorGroup>(`/vendor-groups/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------ vendor master

export const useVendorsAp = (query: Partial<ListVendorsQuery>) =>
  useQuery({
    queryKey: key('vendors', query),
    queryFn: () => api.get<PaginatedResult<VendorSummary>>('/vendors', { query }),
    placeholderData: (p) => p,
  });
export const useVendorDetail = (id: string | null) =>
  useQuery({
    queryKey: key('vendor', id),
    queryFn: () => api.get<VendorDetail>(`/vendors/${id}`),
    enabled: Boolean(id),
  });
export const useVendorDecision = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VendorApprovalInput & { id: string }) =>
      api.post<VendorDetail>(`/vendors/${id}/approve`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useVendorHold = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VendorHoldInput & { id: string }) =>
      api.post<VendorDetail>(`/vendors/${id}/hold`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateVendorProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VendorProfileInput & { id: string }) =>
      api.patch<VendorProfile>(`/vendors/${id}/profile`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddVendorContact = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VendorContactInput & { id: string }) =>
      api.post<VendorContact>(`/vendors/${id}/contacts`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemoveVendorContact = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, contactId }: { id: string; contactId: string }) =>
      api.delete<void>(`/vendors/${id}/contacts/${contactId}`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddVendorAddress = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VendorAddressInput & { id: string }) =>
      api.post<VendorAddress>(`/vendors/${id}/addresses`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemoveVendorAddress = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, addressId }: { id: string; addressId: string }) =>
      api.delete<void>(`/vendors/${id}/addresses/${addressId}`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddVendorBankAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VendorBankAccountInput & { id: string }) =>
      api.post<VendorBankAccount>(`/vendors/${id}/bank-accounts`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateVendorBankAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      bankId,
      ...input
    }: Partial<VendorBankAccountInput> & {
      id: string;
      bankId: string;
      verified?: boolean;
      status?: 'ACTIVE' | 'INACTIVE';
    }) => api.patch<VendorBankAccount>(`/vendors/${id}/bank-accounts/${bankId}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemoveVendorBankAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, bankId }: { id: string; bankId: string }) =>
      api.delete<void>(`/vendors/${id}/bank-accounts/${bankId}`),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------ bills / holds

export const useSubmitBill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SubledgerDocumentDetail>(`/bills/${id}/submit`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useVendorPaymentStep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'submit' | 'approve' }) =>
      api.post<unknown>(`/vendor-payments/${id}/${action}`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useBillHolds = (query: Partial<ListBillHoldsQuery>) =>
  useQuery({
    queryKey: key('bill-holds', query),
    queryFn: () => api.get<PaginatedResult<BillHold>>('/bill-holds', { query }),
    placeholderData: (p) => p,
  });
export const useHoldBill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ billId, ...input }: BillHoldInput & { billId: string }) =>
      api.post<BillHold>(`/bills/${billId}/hold`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useReleaseBillHold = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReleaseBillHoldInput & { id: string }) =>
      api.post<BillHold>(`/bill-holds/${id}/release`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------ payment runs

export const usePaymentRuns = (query: Partial<ListPaymentRunsQuery>) =>
  useQuery({
    queryKey: key('payment-runs', query),
    queryFn: () => api.get<PaginatedResult<PaymentRun>>('/payment-runs', { query }),
    placeholderData: (p) => p,
  });
export const usePaymentRun = (id: string | null) =>
  useQuery({
    queryKey: key('payment-run', id),
    queryFn: () => api.get<PaymentRunDetail>(`/payment-runs/${id}`),
    enabled: Boolean(id),
  });
export const useCreatePaymentRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentRunInput) =>
      api.post<PaymentRunDetail>('/payment-runs', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdatePaymentRunLines = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePaymentRunLinesInput & { id: string }) =>
      api.patch<PaymentRunDetail>(`/payment-runs/${id}/lines`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export type PaymentRunAction = 'submit' | 'approve' | 'execute' | 'cancel';
export const usePaymentRunAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      note,
      reason,
    }: {
      id: string;
      action: PaymentRunAction;
      note?: string;
      reason?: string;
    }) =>
      api.post<PaymentRunDetail>(
        `/payment-runs/${id}/${action}`,
        action === 'cancel' ? { reason } : { note },
      ),
    onSuccess: () => invalidateAll(qc),
  });
};
/** Downloads the remittance / bank file (text, not JSON - fetched directly). */
export const useDownloadRemittance = () =>
  useMutation({
    mutationFn: async ({ id, format }: { id: string; format: 'CSV' | 'REMITTANCE_ADVICE' }) => {
      const res = await fetch(`${API_BASE_PATH}/payment-runs/${id}/remittance?format=${format}`, {
        credentials: 'include',
        headers: { [HEADERS.COMPANY_ID]: getActiveCompanyId() ?? '' },
      });
      if (!res.ok) throw new Error('The remittance file could not be produced.');
      const text = await res.text();
      const disposition = res.headers.get('content-disposition') ?? '';
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ??
        `remittance.${format === 'CSV' ? 'csv' : 'txt'}`;
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

// ------------------------------------------------------------------ accruals

export const useApAccruals = (query: Partial<ListApAccrualsQuery>) =>
  useQuery({
    queryKey: key('accruals', query),
    queryFn: () => api.get<PaginatedResult<ApAccrual>>('/ap-accruals', { query }),
    placeholderData: (p) => p,
  });
export const useApAccrual = (id: string | null) =>
  useQuery({
    queryKey: key('accrual', id),
    queryFn: () => api.get<ApAccrualDetail>(`/ap-accruals/${id}`),
    enabled: Boolean(id),
  });
export const useCreateApAccrual = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApAccrualInput) => api.post<ApAccrualDetail>('/ap-accruals', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useApAccrualAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: 'post' | 'delete';
    }): Promise<ApAccrualDetail | null> =>
      action === 'post'
        ? api.post<ApAccrualDetail>(`/ap-accruals/${id}/post`)
        : api.delete<void>(`/ap-accruals/${id}`).then(() => null),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useGrni = (query: Partial<GrniQuery>) =>
  useQuery({
    queryKey: key('grni', query),
    queryFn: () => api.get<GrniReport>('/grni', { query }),
    placeholderData: (p) => p,
  });

// ------------------------------------------------------------------- reports

export const useApDashboard = (asOf?: string) =>
  useQuery({
    queryKey: key('dashboard', asOf),
    queryFn: () => api.get<ApDashboard>('/ap-dashboard', { query: { asOf } }),
  });
export const useCashRequirements = (query: Partial<CashRequirementsQuery>) =>
  useQuery({
    queryKey: key('cash-requirements', query),
    queryFn: () => api.get<CashRequirementsReport>('/cash-requirements', { query }),
    placeholderData: (p) => p,
  });
export const useApReconciliation = (asOf: string) =>
  useQuery({
    queryKey: key('reconciliation', asOf),
    queryFn: () => api.get<ApReconciliation>('/reports/ap-reconciliation', { query: { asOf } }),
  });
export const useApIntegrity = (asOf: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () => api.get<ApIntegrityReport>('/ap-integrity', { query: { asOf } }),
  });
export const useVendorStatement = (query: { vendorId: string | null; from: string; to: string }) =>
  useQuery({
    queryKey: key('vendor-statement', query),
    queryFn: () => api.get<StatementReport>('/vendor-statements', { query }),
    enabled: Boolean(query.vendorId),
  });
export const useRunPayablesSweep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (asOf?: string) =>
      api.post<{
        dueSoon: number;
        discountsExpiring: number;
        overdue: number;
        agedGrniLines: number;
      }>('/payables/sweep', undefined, { query: { asOf } }),
    onSuccess: () => invalidateAll(qc),
  });
};
