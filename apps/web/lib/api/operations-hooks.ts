'use client';
/* TanStack Query hooks for the operations console (hardening H8). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ListIntegrityRunsQuery,
  ListJobRunsQuery,
  StatementsQuery,
} from '@accounting/validation';
import { api } from './client';
import type {
  FailedJobView,
  IntegrityRunView,
  JobRunView,
  JobView,
  PaginatedResult,
  QueueStatsView,
  RuntimeStatusView,
  StatementsView,
} from './types';

const OPS = 'operations';

export const useRuntimeStatus = () =>
  useQuery({
    queryKey: [OPS, 'status'],
    queryFn: () => api.get<RuntimeStatusView>('/operations/status'),
    refetchInterval: 30_000,
  });

export const useJobs = () =>
  useQuery({
    queryKey: [OPS, 'jobs'],
    queryFn: () => api.get<JobView[]>('/operations/jobs'),
    refetchInterval: 30_000,
  });

export const useJobRuns = (query: Partial<ListJobRunsQuery>) =>
  useQuery({
    queryKey: [OPS, 'job-runs', query],
    queryFn: () => api.get<PaginatedResult<JobRunView>>('/operations/job-runs', { query }),
    placeholderData: (prev) => prev,
  });

export const useRunJob = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<JobRunView>(`/operations/jobs/${name}/run`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [OPS] }),
  });
};

export const useQueueStats = () =>
  useQuery({
    queryKey: [OPS, 'queues'],
    queryFn: () =>
      api.get<{ keyPrefix: string; queues: QueueStatsView[] | null }>('/operations/queues'),
    refetchInterval: 30_000,
  });

export const useFailedJobs = (queue: string | null) =>
  useQuery({
    queryKey: [OPS, 'failed', queue ?? ''],
    queryFn: () => api.get<FailedJobView[]>(`/operations/queues/${queue}/failed`),
    enabled: Boolean(queue),
  });

export const useRetryFailed = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queue, id }: { queue: string; id?: string }) =>
      api.post<{ retried: number }>(
        id
          ? `/operations/queues/${queue}/failed/${id}/retry`
          : `/operations/queues/${queue}/failed/retry`,
        {},
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [OPS] }),
  });
};

export const useDiscardFailed = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ queue, id }: { queue: string; id: string }) =>
      api.delete<void>(`/operations/queues/${queue}/failed/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [OPS] }),
  });
};

export const useIntegrityRuns = (query: Partial<ListIntegrityRunsQuery>) =>
  useQuery({
    queryKey: [OPS, 'integrity-runs', query],
    queryFn: () =>
      api.get<PaginatedResult<IntegrityRunView>>('/operations/integrity-runs', { query }),
    placeholderData: (prev) => prev,
  });

export const useStatementStats = (query: Partial<StatementsQuery>) =>
  useQuery({
    queryKey: [OPS, 'statements', query],
    queryFn: () => api.get<StatementsView>('/operations/statements', { query }),
    placeholderData: (prev) => prev,
  });

export const useResetStatementStats = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/operations/statements/reset'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [OPS, 'statements'] }),
  });
};

export const useRunIntegrityCheck = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (companyId: string) =>
      api.post<IntegrityRunView>('/operations/integrity-runs', { companyId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [OPS] }),
  });
};
