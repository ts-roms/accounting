'use client';
/* TanStack Query hooks for the reconciliation center (hardening H2/H3). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignReconciliationInput,
  CreateReconciliationExceptionInput,
  ListReconciliationsQuery,
  ReconciliationNotesInput,
  ResolveReconciliationExceptionInput,
  RunReconciliationInput,
  UpdateAccountingPolicyInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  AccountingPolicy,
  PaginatedResult,
  ReconciliationDetail,
  ReconciliationSummary,
  ReconciliationView,
} from './types';

const ROOT = 'reconciliations';
const key = (...rest: unknown[]) => [ROOT, getActiveCompanyId() ?? 'none', ...rest] as const;

export const useReconciliationSummary = (asOf: string, enabled = true) =>
  useQuery({
    queryKey: key('summary', asOf),
    queryFn: () => api.get<ReconciliationSummary>('/reconciliations/summary', { query: { asOf } }),
    enabled,
  });

export const useReconciliations = (query: Partial<ListReconciliationsQuery>) =>
  useQuery({
    queryKey: key('list', query),
    queryFn: () => api.get<PaginatedResult<ReconciliationView>>('/reconciliations', { query }),
    placeholderData: (p) => p,
  });

export const useReconciliation = (id: string | null) =>
  useQuery({
    queryKey: key('detail', id),
    queryFn: () => api.get<ReconciliationDetail>(`/reconciliations/${id}`),
    enabled: Boolean(id),
  });

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  void qc.invalidateQueries({ queryKey: [ROOT] });

export const useRunReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RunReconciliationInput) =>
      api.post<ReconciliationDetail>('/reconciliations', input),
    onSuccess: () => invalidate(qc),
  });
};

export const useAssignReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: AssignReconciliationInput & { id: string }) =>
      api.post<ReconciliationDetail>(`/reconciliations/${id}/assign`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useReconciliationNotes = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReconciliationNotesInput & { id: string }) =>
      api.post<ReconciliationDetail>(`/reconciliations/${id}/notes`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useAddReconciliationException = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CreateReconciliationExceptionInput & { id: string }) =>
      api.post<ReconciliationDetail>(`/reconciliations/${id}/exceptions`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useResolveReconciliationException = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      exceptionId,
      ...input
    }: ResolveReconciliationExceptionInput & { id: string; exceptionId: string }) =>
      api.post<ReconciliationDetail>(
        `/reconciliations/${id}/exceptions/${exceptionId}/resolve`,
        input,
      ),
    onSuccess: () => invalidate(qc),
  });
};

export const useApproveReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      api.post<ReconciliationDetail>(`/reconciliations/${id}/approve`, notes ? { notes } : {}),
    onSuccess: () => invalidate(qc),
  });
};

export const useAccountingPolicy = () =>
  useQuery({
    queryKey: key('policy'),
    queryFn: () => api.get<AccountingPolicy>('/accounting-policies'),
  });

export const useUpdateAccountingPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAccountingPolicyInput) =>
      api.patch<AccountingPolicy>('/accounting-policies', input),
    onSuccess: () => invalidate(qc),
  });
};
