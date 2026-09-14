'use client';
/* TanStack Query hooks for delegated authority (Prompt #4). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDelegationInput,
  DecideDelegationInput,
  DelegationPolicyInput,
  ListDelegationsQuery,
  RevokeDelegationInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  DelegablePermission,
  DelegationPolicyView,
  DelegationUsageView,
  DelegationView,
} from './integrations-types';
import type { PaginatedResult } from './types';

const ROOT = 'delegations';
const key = (...rest: unknown[]) => [ROOT, getActiveCompanyId() ?? 'none', ...rest] as const;
const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: [ROOT] });
  // Grants ride on /auth/me and on document approvals.
  void qc.invalidateQueries({ queryKey: ['me'] });
  void qc.invalidateQueries({ queryKey: ['notifications'] });
};

export const useDelegations = (query: Partial<ListDelegationsQuery>) =>
  useQuery({
    queryKey: key('list', query),
    queryFn: () => api.get<PaginatedResult<DelegationView>>('/delegations', { query }),
    placeholderData: (p) => p,
  });

export const useDelegation = (id: string | null) =>
  useQuery({
    queryKey: key('detail', id),
    queryFn: () => api.get<DelegationView>(`/delegations/${id}`),
    enabled: Boolean(id),
  });

export const useDelegationUsage = (id: string | null) =>
  useQuery({
    queryKey: key('usage', id),
    queryFn: () => api.get<DelegationUsageView[]>(`/delegations/${id}/usage`),
    enabled: Boolean(id),
  });

export const useDelegablePermissions = () =>
  useQuery({
    queryKey: [ROOT, 'permissions'],
    queryFn: () => api.get<DelegablePermission[]>('/delegations/permissions'),
    staleTime: 10 * 60_000,
  });

export const useDelegationPolicy = () =>
  useQuery({
    queryKey: [ROOT, 'policy'],
    queryFn: () => api.get<DelegationPolicyView>('/delegations/policy'),
  });

export const useUpdateDelegationPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DelegationPolicyInput) =>
      api.put<DelegationPolicyView>('/delegations/policy', input),
    onSuccess: () => invalidate(qc),
  });
};

export const useCreateDelegation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDelegationInput) => api.post<DelegationView>('/delegations', input),
    onSuccess: () => invalidate(qc),
  });
};

export const useDecideDelegation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DecideDelegationInput & { id: string }) =>
      api.post<DelegationView>(`/delegations/${id}/approve`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useRevokeDelegation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: RevokeDelegationInput & { id: string }) =>
      api.post<DelegationView>(`/delegations/${id}/revoke`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useCancelDelegation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DelegationView>(`/delegations/${id}/cancel`),
    onSuccess: () => invalidate(qc),
  });
};
