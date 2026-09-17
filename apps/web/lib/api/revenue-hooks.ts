'use client';
/* TanStack Query hooks for revenue recognition & deferred revenue (Prompt #10). Company-scoped. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompleteMilestoneInput,
  CreateRevenuePolicyInput,
  CreateRevenueRunInput,
  ListRevenueRunsQuery,
  ListRevenueSchedulesQuery,
  ReverseRevenueRunInput,
  RevenueRollforwardQuery,
  RevenueWaterfallQuery,
  UpdateRevenuePolicyInput,
  UpdateRevenueSettingsInput,
} from '@accounting/validation';
import { api } from './client';
import type {
  RevenueBacklog,
  RevenueIntegrityReport,
  RevenuePolicy,
  RevenueRollforward,
  RevenueRun,
  RevenueRunDetail,
  RevenueRunPreview,
  RevenueSchedule,
  RevenueScheduleDetail,
  RevenueSettings,
  RevenueWaterfall,
} from './revenue-types';
import type { PaginatedResult } from './types';

const key = (...rest: unknown[]) => ['revenue', ...rest] as const;

/** Runs post journals; invoices create schedules - refresh the ledger views too. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['revenue', 'journal-entries', 'general-ledger', 'trial-balance', 'invoices'])
    void qc.invalidateQueries({ queryKey: [k] });
}

// -------------------------------------------------------------- settings

export const useRevenueSettings = () =>
  useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<RevenueSettings>('/revenue/settings'),
  });
export const useUpdateRevenueSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRevenueSettingsInput) =>
      api.put<RevenueSettings>('/revenue/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

// -------------------------------------------------------------- policies

export const useRevenuePolicies = () =>
  useQuery({
    queryKey: key('policies'),
    queryFn: () => api.get<RevenuePolicy[]>('/revenue/policies'),
  });
export const useCreateRevenuePolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRevenuePolicyInput) =>
      api.post<RevenuePolicy>('/revenue/policies', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateRevenuePolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateRevenuePolicyInput & { id: string }) =>
      api.patch<RevenuePolicy>(`/revenue/policies/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------- schedules

export const useRevenueSchedules = (query: Partial<ListRevenueSchedulesQuery> = {}) =>
  useQuery({
    queryKey: key('schedules', query),
    queryFn: () =>
      api.get<PaginatedResult<RevenueSchedule>>('/revenue/schedules', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useRevenueSchedule = (id: string | null) =>
  useQuery({
    queryKey: key('schedule', id),
    queryFn: () => api.get<RevenueScheduleDetail>(`/revenue/schedules/${id}`),
    enabled: Boolean(id),
  });
export const useCompleteMilestone = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scheduleId,
      lineId,
      ...input
    }: CompleteMilestoneInput & { scheduleId: string; lineId: string }) =>
      api.post<RevenueScheduleDetail>(
        `/revenue/schedules/${scheduleId}/lines/${lineId}/complete`,
        input,
      ),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------ runs

export const useRevenueRuns = (query: Partial<ListRevenueRunsQuery> = {}) =>
  useQuery({
    queryKey: key('runs', query),
    queryFn: () =>
      api.get<PaginatedResult<RevenueRun>>('/revenue/runs', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useRevenueRun = (id: string | null) =>
  useQuery({
    queryKey: key('run', id),
    queryFn: () => api.get<RevenueRunDetail>(`/revenue/runs/${id}`),
    enabled: Boolean(id),
  });
export const useRevenueRunPreview = (periodEnd: string) =>
  useQuery({
    queryKey: key('run-preview', periodEnd),
    queryFn: () => api.get<RevenueRunPreview>('/revenue/runs/preview', { query: { periodEnd } }),
    enabled: Boolean(periodEnd),
  });
export const useCreateRevenueRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRevenueRunInput) =>
      api.post<RevenueRunDetail | { run: null; message: string }>('/revenue/runs', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useReverseRevenueRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReverseRevenueRunInput & { id: string }) =>
      api.post<RevenueRunDetail>(`/revenue/runs/${id}/reverse`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// --------------------------------------------------------------- reports

export const useRevenueRollforward = (query: RevenueRollforwardQuery) =>
  useQuery({
    queryKey: key('rollforward', query),
    queryFn: () => api.get<RevenueRollforward>('/revenue/reports/rollforward', { query }),
    enabled: Boolean(query.from && query.to),
  });
export const useRevenueWaterfall = (query: Partial<RevenueWaterfallQuery>) =>
  useQuery({
    queryKey: key('waterfall', query),
    queryFn: () =>
      api.get<RevenueWaterfall>('/revenue/reports/waterfall', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useRevenueBacklog = (asOf: string) =>
  useQuery({
    queryKey: key('backlog', asOf),
    queryFn: () => api.get<RevenueBacklog>('/revenue/reports/backlog', { query: { asOf } }),
  });
export const useRevenueIntegrity = (asOf: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () => api.get<RevenueIntegrityReport>('/revenue/integrity', { query: { asOf } }),
  });
