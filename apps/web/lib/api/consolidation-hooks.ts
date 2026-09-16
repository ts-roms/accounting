'use client';
/* TanStack Query hooks for consolidation groups, mappings, adjustments, readiness and runs (hardening H9). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutoMapInput,
  ConsolidationWindow,
  CreateConsolidationAdjustmentInput,
  CreateConsolidationGroupInput,
  GroupAccountInput,
  GroupMappingsInput,
  UpdateConsolidationGroupInput,
} from '@accounting/validation';
import { api } from './client';
import type {
  ConsolidationAdjustmentView,
  ConsolidationGroupView,
  ConsolidationRunDetail,
  ConsolidationRunView,
  GroupAccountView,
  GroupMappingRow,
  GroupReport,
  PaginatedResult,
  ReadinessResult,
} from './types';

const ROOT = 'consolidation-groups';
const base = (id: string) => `/consolidation/groups/${id}`;

export const useConsolidationGroups = () =>
  useQuery({
    queryKey: [ROOT],
    queryFn: () => api.get<ConsolidationGroupView[]>('/consolidation/groups'),
  });

export const useConsolidationGroup = (id: string | null) =>
  useQuery({
    queryKey: [ROOT, id ?? ''],
    queryFn: () => api.get<ConsolidationGroupView>(base(id!)),
    enabled: Boolean(id),
  });

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  void qc.invalidateQueries({ queryKey: [ROOT] });

export const useCreateConsolidationGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConsolidationGroupInput) =>
      api.post<ConsolidationGroupView>('/consolidation/groups', input),
    onSuccess: () => invalidate(qc),
  });
};

export const useUpdateConsolidationGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateConsolidationGroupInput & { id: string }) =>
      api.patch<ConsolidationGroupView>(base(id), input),
    onSuccess: () => invalidate(qc),
  });
};

export const useGroupAccounts = (groupId: string | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'accounts'],
    queryFn: () => api.get<GroupAccountView[]>(`${base(groupId!)}/accounts`),
    enabled: Boolean(groupId),
  });

export const useCreateGroupAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: GroupAccountInput & { groupId: string }) =>
      api.post<GroupAccountView>(`${base(groupId)}/accounts`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useGroupMappings = (groupId: string | null, companyId: string | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'mappings', companyId ?? ''],
    queryFn: () => api.get<GroupMappingRow[]>(`${base(groupId!)}/mappings/${companyId}`),
    enabled: Boolean(groupId && companyId),
  });

export const useSaveGroupMappings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: GroupMappingsInput & { groupId: string }) =>
      api.put<{ mapped: number; unmapped: number }>(`${base(groupId)}/mappings`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useAutoMap = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: AutoMapInput & { groupId: string }) =>
      api.post<{ mapped: number; created: number; unmapped: string[] }>(
        `${base(groupId)}/mappings/auto`,
        input,
      ),
    onSuccess: () => invalidate(qc),
  });
};

export const useConsolidationAdjustments = (groupId: string | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'adjustments'],
    queryFn: () => api.get<ConsolidationAdjustmentView[]>(`${base(groupId!)}/adjustments`),
    enabled: Boolean(groupId),
  });

export const useCreateConsolidationAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: CreateConsolidationAdjustmentInput & { groupId: string }) =>
      api.post<ConsolidationAdjustmentView>(`${base(groupId)}/adjustments`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useDeleteConsolidationAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, id }: { groupId: string; id: string }) =>
      api.delete<void>(`${base(groupId)}/adjustments/${id}`),
    onSuccess: () => invalidate(qc),
  });
};

export const useGroupReport = (groupId: string | null, window: ConsolidationWindow | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'report', window],
    queryFn: () => api.get<GroupReport>(`${base(groupId!)}/report`, { query: window! }),
    enabled: Boolean(groupId && window),
    placeholderData: (prev) => prev,
  });

export const useGroupReadiness = (groupId: string | null, window: ConsolidationWindow | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'readiness', window],
    queryFn: () => api.get<ReadinessResult>(`${base(groupId!)}/readiness`, { query: window! }),
    enabled: Boolean(groupId && window),
    placeholderData: (prev) => prev,
  });

export const useConsolidationRuns = (groupId: string | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'runs'],
    queryFn: () =>
      api.get<PaginatedResult<ConsolidationRunView>>(`${base(groupId!)}/runs`, {
        query: { pageSize: 50 },
      }),
    enabled: Boolean(groupId),
  });

export const useConsolidationRun = (groupId: string | null, runId: string | null) =>
  useQuery({
    queryKey: [ROOT, groupId ?? '', 'runs', runId ?? ''],
    queryFn: () => api.get<ConsolidationRunDetail>(`${base(groupId!)}/runs/${runId}`),
    enabled: Boolean(groupId && runId),
  });

export const useCreateConsolidationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...window }: ConsolidationWindow & { groupId: string }) =>
      api.post<ConsolidationRunDetail>(`${base(groupId)}/runs`, window),
    onSuccess: () => invalidate(qc),
  });
};

export const useFinalizeConsolidationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, runId }: { groupId: string; runId: string }) =>
      api.post<ConsolidationRunDetail>(`${base(groupId)}/runs/${runId}/finalize`, {}),
    onSuccess: () => invalidate(qc),
  });
};
