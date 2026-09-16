'use client';
/* TanStack Query hooks for group consolidation & intercompany (Prompt #9). Organization-level: no company header needed. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConsolidationMemberInput,
  CreateConsolidationAdjustmentInput,
  CreateConsolidationGroupInput,
  CreateConsolidationRunInput,
  CreateEliminationRuleInput,
  IntercompanyReconciliationQuery,
  ListConsolidationRunsQuery,
  SettleIntercompanyInput,
  UpdateConsolidationGroupInput,
  UpdateConsolidationMemberInput,
  UpdateEliminationRuleInput,
} from '@accounting/validation';
import { api } from './client';
import type {
  ConsolidatedStatements,
  ConsolidationGroup,
  ConsolidationIntegrityReport,
  ConsolidationRun,
  ConsolidationRunSummary,
  EliminationRule,
  IntercompanyReconciliation,
  Readiness,
} from './consolidation-types';
import type { IntercompanyTransaction, PaginatedResult } from './types';

const key = (...rest: unknown[]) => ['consolidation', ...rest] as const;

/** Group figures follow every member ledger; intercompany settlements move bank balances too. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    'consolidation',
    'intercompany',
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'banking',
    'treasury',
  ])
    void qc.invalidateQueries({ queryKey: [k] });
}

// ---------------------------------------------------------------- groups

export const useConsolidationGroups = () =>
  useQuery({
    queryKey: key('groups'),
    queryFn: () => api.get<ConsolidationGroup[]>('/consolidation/groups'),
  });
export const useConsolidationGroup = (id: string | null) =>
  useQuery({
    queryKey: key('group', id),
    queryFn: () => api.get<ConsolidationGroup>(`/consolidation/groups/${id}`),
    enabled: Boolean(id),
  });
export const useGroupReadiness = (id: string | null, periodStart: string, periodEnd: string) =>
  useQuery({
    queryKey: key('readiness', id, periodStart, periodEnd),
    queryFn: () =>
      api.get<Readiness>(`/consolidation/groups/${id}/readiness`, {
        query: { periodStart, periodEnd },
      }),
    enabled: Boolean(id && periodStart && periodEnd),
  });
export const useCreateConsolidationGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConsolidationGroupInput) =>
      api.post<ConsolidationGroup>('/consolidation/groups', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateConsolidationGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateConsolidationGroupInput & { id: string }) =>
      api.patch<ConsolidationGroup>(`/consolidation/groups/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddGroupMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: ConsolidationMemberInput & { groupId: string }) =>
      api.post<ConsolidationGroup>(`/consolidation/groups/${groupId}/members`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateGroupMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      groupId,
      memberId,
      ...input
    }: UpdateConsolidationMemberInput & { groupId: string; memberId: string }) =>
      api.patch<ConsolidationGroup>(`/consolidation/groups/${groupId}/members/${memberId}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemoveGroupMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, memberId }: { groupId: string; memberId: string }) =>
      api.delete<ConsolidationGroup>(`/consolidation/groups/${groupId}/members/${memberId}`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useCreateEliminationRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: CreateEliminationRuleInput & { groupId: string }) =>
      api.post<EliminationRule>(`/consolidation/groups/${groupId}/rules`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useSeedDefaultRules = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) =>
      api.post<EliminationRule[]>(`/consolidation/groups/${groupId}/rules/defaults`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateEliminationRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      groupId,
      ruleId,
      ...input
    }: UpdateEliminationRuleInput & { groupId: string; ruleId: string }) =>
      api.patch<EliminationRule>(`/consolidation/groups/${groupId}/rules/${ruleId}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------ runs

export const useConsolidationRuns = (query: Partial<ListConsolidationRunsQuery>) =>
  useQuery({
    queryKey: key('runs', query),
    queryFn: () =>
      api.get<PaginatedResult<ConsolidationRunSummary>>('/consolidation/runs', { query }),
    placeholderData: (prev) => prev,
  });
export const useConsolidationRun = (id: string | null) =>
  useQuery({
    queryKey: key('run', id),
    queryFn: () => api.get<ConsolidationRun>(`/consolidation/runs/${id}`),
    enabled: Boolean(id),
  });
export const useConsolidatedStatements = (id: string | null) =>
  useQuery({
    queryKey: key('statements', id),
    queryFn: () => api.get<ConsolidatedStatements>(`/consolidation/runs/${id}/statements`),
    enabled: Boolean(id),
  });
export const useCreateConsolidationRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, ...input }: CreateConsolidationRunInput & { groupId: string }) =>
      api.post<ConsolidationRun>(`/consolidation/groups/${groupId}/runs`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export type ConsolidationRunAction = 'prepare' | 'finalize' | 'reopen';
export const useConsolidationRunAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: ConsolidationRunAction;
      body?: { note?: string; reason?: string };
    }) => api.post<ConsolidationRun>(`/consolidation/runs/${id}/${action}`, body ?? {}),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddConsolidationAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, ...input }: CreateConsolidationAdjustmentInput & { runId: string }) =>
      api.post<ConsolidationRun>(`/consolidation/runs/${runId}/adjustments`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useVoidConsolidationAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      adjustmentId,
      reason,
    }: {
      runId: string;
      adjustmentId: string;
      reason: string;
    }) =>
      api.post<ConsolidationRun>(`/consolidation/runs/${runId}/adjustments/${adjustmentId}/void`, {
        reason,
      }),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------ intercompany

export const useIntercompanyReconciliation = (query: IntercompanyReconciliationQuery) =>
  useQuery({
    queryKey: key('ic-reconciliation', query),
    queryFn: () =>
      api.get<IntercompanyReconciliation>('/consolidation/intercompany-reconciliation', { query }),
  });
export const useConsolidationIntegrity = (asOf?: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () =>
      api.get<ConsolidationIntegrityReport>('/consolidation/integrity', { query: { asOf } }),
  });
export const useSettleIntercompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SettleIntercompanyInput & { id: string }) =>
      api.post<IntercompanyTransaction>(`/intercompany/${id}/settle`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
