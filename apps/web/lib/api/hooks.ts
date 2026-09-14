'use client';
/* TanStack Query hooks - one place for cache keys and API calls. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignUserRoleInput,
  CreateBranchInput,
  CreateCompanyInput,
  CreateRoleInput,
  CreateUserInput,
  ListAuditLogsQuery,
  ListUsersQuery,
  SetUserStatusInput,
  UpdateBranchInput,
  UpdateCompanyInput,
  UpdateOrganizationInput,
  UpdateUserInput,
} from '@accounting/validation';
import { api, ApiError, setActiveCompanyId } from './client';
import type {
  AuditLog,
  Branch,
  Company,
  MeResponse,
  Organization,
  PaginatedResult,
  Permission,
  Role,
  SodConflict,
  SodPolicy,
  UserRoleView,
  UserView,
} from './types';

export const queryKeys = {
  me: ['me'] as const,
  organization: ['organization'] as const,
  companies: ['companies'] as const,
  branches: (companyId?: string) => ['branches', companyId ?? 'all'] as const,
  users: (query: Partial<ListUsersQuery>) => ['users', query] as const,
  userRoles: (userId: string) => ['users', userId, 'roles'] as const,
  roles: ['roles'] as const,
  permissions: ['permissions'] as const,
  sodPolicies: ['sod-policies'] as const,
  auditLogs: (query: Partial<ListAuditLogsQuery>) => ['audit-logs', query] as const,
};

// ------------------------------------------------------------------ session
/**
 * Loads the principal. A stale active-company id (e.g. after a database reset
 * or revoked access) must not lock the user out: drop it and retry once.
 */
async function fetchMe(): Promise<MeResponse> {
  try {
    return await api.get<MeResponse>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'COMPANY_NOT_ACCESSIBLE') {
      setActiveCompanyId(null);
      return api.get<MeResponse>('/auth/me');
    }
    throw err;
  }
}

export const useMe = (enabled = true) =>
  useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, enabled, retry: false, staleTime: 60_000 });

// ------------------------------------------------------------- organization
export const useOrganization = () =>
  useQuery({
    queryKey: queryKeys.organization,
    queryFn: () => api.get<Organization>('/organization'),
  });

export const useUpdateOrganization = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => api.patch<Organization>('/organization', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.organization });
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
};

export const useCompanies = () =>
  useQuery({ queryKey: queryKeys.companies, queryFn: () => api.get<Company[]>('/companies') });

export const useCreateCompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompanyInput) => api.post<Company>('/companies', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.companies });
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
};

export const useUpdateCompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCompanyInput & { id: string }) =>
      api.patch<Company>(`/companies/${id}`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.companies });
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
};

export const useBranches = (companyId?: string) =>
  useQuery({
    queryKey: queryKeys.branches(companyId),
    queryFn: () => api.get<Branch[]>('/branches', { query: { companyId } }),
  });

export const useCreateBranch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBranchInput) => api.post<Branch>('/branches', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['branches'] }),
  });
};

export const useUpdateBranch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBranchInput & { id: string }) =>
      api.patch<Branch>(`/branches/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['branches'] }),
  });
};

// -------------------------------------------------------------------- users
export const useUsers = (query: Partial<ListUsersQuery>) =>
  useQuery({
    queryKey: queryKeys.users(query),
    queryFn: () => api.get<PaginatedResult<UserView>>('/users', { query }),
    placeholderData: (prev) => prev,
  });

export const useCreateUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.post<UserView>('/users', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
};

export const useUpdateUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateUserInput & { id: string }) =>
      api.patch<UserView>(`/users/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
};

export const useSetUserStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SetUserStatusInput & { id: string }) =>
      api.patch<UserView>(`/users/${id}/status`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
};

export const useUserRoles = (userId: string | null) =>
  useQuery({
    queryKey: queryKeys.userRoles(userId ?? ''),
    queryFn: () => api.get<UserRoleView[]>(`/users/${userId}/roles`),
    enabled: Boolean(userId),
  });

export const useAssignRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...input }: AssignUserRoleInput & { userId: string }) =>
      api.post<{ assignmentId: string; warnings: SodConflict[] }>(`/users/${userId}/roles`, input),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.userRoles(vars.userId) });
      void qc.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });
};

export const useRevokeRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, assignmentId }: { userId: string; assignmentId: string }) =>
      api.delete<void>(`/users/${userId}/roles/${assignmentId}`),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.userRoles(vars.userId) });
      void qc.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });
};

// --------------------------------------------------------------------- rbac
export const useRoles = () =>
  useQuery({ queryKey: queryKeys.roles, queryFn: () => api.get<Role[]>('/roles') });
export const usePermissions = () =>
  useQuery({
    queryKey: queryKeys.permissions,
    queryFn: () => api.get<Permission[]>('/permissions'),
    staleTime: 5 * 60_000,
  });

export const useCreateRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => api.post<Role>('/roles', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.roles }),
  });
};

export const useSetRolePermissions = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: string[] }) =>
      api.put<Role>(`/roles/${id}/permissions`, { permissions }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.roles });
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
};

export const useSodPolicies = () =>
  useQuery({
    queryKey: queryKeys.sodPolicies,
    queryFn: () => api.get<SodPolicy[]>('/sod-policies'),
  });

// -------------------------------------------------------------------- audit
export const useAuditLogs = (query: Partial<ListAuditLogsQuery>) =>
  useQuery({
    queryKey: queryKeys.auditLogs(query),
    queryFn: () => api.get<PaginatedResult<AuditLog>>('/audit-logs', { query }),
    placeholderData: (prev) => prev,
  });
