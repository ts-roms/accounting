'use client';
/* TanStack Query hooks for lease accounting & fixed-asset extensions (Prompt #13). Company-scoped. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssetRollforwardQuery,
  CommenceLeaseInput,
  CreateLeaseInput,
  CreateLeaseRunInput,
  ListLeaseRunsQuery,
  ListLeasesQuery,
  PayLeaseLineInput,
  PreviewLeaseScheduleInput,
  RemeasureLeaseInput,
  ReverseLeaseRunInput,
  SplitAssetInput,
  TerminateLeaseInput,
  UpdateLeaseInput,
  UpdateLeaseSettingsInput,
} from '@accounting/validation';
import { api } from './client';
import type {
  AssetRollforward,
  Lease,
  LeaseDashboard,
  LeaseDetail,
  LeaseMaturity,
  LeaseRegister,
  LeaseRun,
  LeaseRunDetail,
  LeaseRunPreview,
  LeaseSchedulePreview,
  LeaseSettings,
} from './lease-types';
import type { FixedAssetDetail, IntegrityReport, PaginatedResult } from './types';

const key = (...rest: unknown[]) => ['leases', ...rest] as const;

/** Lease actions post journals and bank payments. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    'leases',
    'fixed-assets',
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'treasury',
    'banking',
    'financial-close',
  ])
    void qc.invalidateQueries({ queryKey: [k] });
}

// ----------------------------------------------------------------- settings

export const useLeaseSettings = () =>
  useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<LeaseSettings>('/leases/settings'),
  });
export const useUpdateLeaseSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateLeaseSettingsInput) =>
      api.put<LeaseSettings>('/leases/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------- leases

export const useLeases = (query: Partial<ListLeasesQuery> = {}) =>
  useQuery({
    queryKey: key('list', query),
    queryFn: () =>
      api.get<PaginatedResult<Lease>>('/leases', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useLease = (id: string | null) =>
  useQuery({
    queryKey: key('detail', id),
    queryFn: () => api.get<LeaseDetail>(`/leases/${id}`),
    enabled: Boolean(id),
  });
export const usePreviewLeaseSchedule = () =>
  useMutation({
    mutationFn: (input: PreviewLeaseScheduleInput) =>
      api.post<LeaseSchedulePreview>('/leases/preview', input),
  });
export const useCreateLease = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeaseInput) => api.post<LeaseDetail>('/leases', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateLease = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateLeaseInput & { id: string }) =>
      api.patch<LeaseDetail>(`/leases/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useDeleteLease = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/leases/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

export type LeaseAction = 'commence' | 'pay' | 'remeasure' | 'terminate';
export type LeaseActionInput =
  | { action: 'commence'; input: CommenceLeaseInput }
  | { action: 'pay'; input: PayLeaseLineInput }
  | { action: 'remeasure'; input: RemeasureLeaseInput }
  | { action: 'terminate'; input: TerminateLeaseInput };
export const useLeaseAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, input }: LeaseActionInput & { id: string }) =>
      api.post<LeaseDetail>(`/leases/${id}/${action}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// --------------------------------------------------------------------- runs

export const useLeaseRuns = (query: Partial<ListLeaseRunsQuery> = {}) =>
  useQuery({
    queryKey: key('runs', query),
    queryFn: () =>
      api.get<PaginatedResult<LeaseRun>>('/leases/runs', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useLeaseRun = (id: string | null) =>
  useQuery({
    queryKey: key('run', id),
    queryFn: () => api.get<LeaseRunDetail>(`/leases/runs/${id}`),
    enabled: Boolean(id),
  });
export const useLeaseRunPreview = (periodEnd: string | null) =>
  useQuery({
    queryKey: key('run-preview', periodEnd),
    queryFn: () => api.get<LeaseRunPreview>('/leases/runs/preview', { query: { periodEnd } }),
    enabled: Boolean(periodEnd),
  });
export const useCreateLeaseRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeaseRunInput) =>
      api.post<LeaseRunDetail | { run: null; message: string }>('/leases/runs', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useReverseLeaseRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReverseLeaseRunInput & { id: string }) =>
      api.post<LeaseRunDetail>(`/leases/runs/${id}/reverse`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useSweepLeases = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (asOf?: string) =>
      api.post<Record<string, number>>('/leases/runs/sweep', undefined, { query: { asOf } }),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------ reports

export const useLeaseRegister = (asOf?: string) =>
  useQuery({
    queryKey: key('register', asOf),
    queryFn: () => api.get<LeaseRegister>('/leases/reports/register', { query: { asOf } }),
  });
export const useLeaseMaturity = (asOf?: string, years?: number) =>
  useQuery({
    queryKey: key('maturity', asOf, years),
    queryFn: () => api.get<LeaseMaturity>('/leases/reports/maturity', { query: { asOf, years } }),
  });
export const useLeaseDashboard = (asOf?: string) =>
  useQuery({
    queryKey: key('dashboard', asOf),
    queryFn: () => api.get<LeaseDashboard>('/leases/dashboard', { query: { asOf } }),
  });
export const useLeaseIntegrity = (asOf?: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () => api.get<IntegrityReport>('/leases/integrity', { query: { asOf } }),
  });

// ------------------------------------------------------------ fixed assets

export const useAssetRollforward = (query: AssetRollforwardQuery | null) =>
  useQuery({
    queryKey: ['fixed-assets', 'rollforward', query],
    queryFn: () =>
      api.get<AssetRollforward>('/fixed-assets/reports/rollforward', {
        query: query as unknown as Record<string, string | undefined>,
      }),
    enabled: Boolean(query),
  });
export const useSplitAsset = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SplitAssetInput & { id: string }) =>
      api.post<{ parent: FixedAssetDetail; children: FixedAssetDetail[] }>(
        `/fixed-assets/${id}/split`,
        input,
      ),
    onSuccess: () => invalidateAll(qc),
  });
};
