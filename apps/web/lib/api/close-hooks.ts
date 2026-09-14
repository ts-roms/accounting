'use client';
/* TanStack Query hooks for the financial close (hardening H4). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddCloseTaskInput,
  CloseDecisionInput,
  ListClosesQuery,
  StartCloseInput,
  UpdateCloseTaskInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type { CloseBlocker, CloseDetail, CloseView, PaginatedResult } from './types';

const ROOT = 'financial-closes';
const key = (...rest: unknown[]) => [ROOT, getActiveCompanyId() ?? 'none', ...rest] as const;
const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: [ROOT] });
  void qc.invalidateQueries({ queryKey: ['fiscal-years'] });
  void qc.invalidateQueries({ queryKey: ['accounting'] });
};

export const useCloses = (query: Partial<ListClosesQuery>) =>
  useQuery({
    queryKey: key('list', query),
    queryFn: () => api.get<PaginatedResult<CloseView>>('/financial-closes', { query }),
    placeholderData: (p) => p,
  });

export const useClose = (id: string | null) =>
  useQuery({
    queryKey: key('detail', id),
    queryFn: () => api.get<CloseDetail>(`/financial-closes/${id}`),
    enabled: Boolean(id),
  });

export const useCloseBlockers = (fiscalPeriodId: string | null) =>
  useQuery({
    queryKey: key('blockers', fiscalPeriodId),
    queryFn: () =>
      api.get<CloseBlocker[]>('/financial-closes/blockers', { query: { fiscalPeriodId } }),
    enabled: Boolean(fiscalPeriodId),
  });

export const useStartClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartCloseInput) => api.post<CloseDetail>('/financial-closes', input),
    onSuccess: () => invalidate(qc),
  });
};

export const useRefreshClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<CloseDetail>(`/financial-closes/${id}/refresh`),
    onSuccess: () => invalidate(qc),
  });
};

export const useUpdateCloseTask = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, taskId, ...input }: UpdateCloseTaskInput & { id: string; taskId: string }) =>
      api.patch<CloseDetail>(`/financial-closes/${id}/tasks/${taskId}`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useAddCloseTask = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: AddCloseTaskInput & { id: string }) =>
      api.post<CloseDetail>(`/financial-closes/${id}/tasks`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useCloseDecision = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      ...input
    }: CloseDecisionInput & { id: string; action: 'approve' | 'complete' }) =>
      api.post<CloseDetail>(`/financial-closes/${id}/${action}`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useCancelClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<CloseDetail>(`/financial-closes/${id}/cancel`, { reason }),
    onSuccess: () => invalidate(qc),
  });
};
