'use client';
/* TanStack Query hooks for the enterprise controls (hardening H5). */
import { useQuery } from '@tanstack/react-query';
import { api, getActiveCompanyId } from './client';
import type { ControlDashboard, FieldChange, SodUserConflict } from './types';

const ROOT = 'controls';
const key = (...rest: unknown[]) => [ROOT, getActiveCompanyId() ?? 'none', ...rest] as const;

export const useControlDashboard = (asOf?: string) =>
  useQuery({
    queryKey: key('dashboard', asOf ?? 'today'),
    queryFn: () =>
      api.get<ControlDashboard>('/controls/dashboard', { query: asOf ? { asOf } : undefined }),
  });

/** Field-level history of one record; disabled until an id is known. */
export const useFieldHistory = (entityType: string, entityId: string | null) =>
  useQuery({
    queryKey: key('history', entityType, entityId),
    queryFn: () => api.get<FieldChange[]>('/history', { query: { entityType, entityId } }),
    enabled: Boolean(entityId),
    // Edits happen on other screens; always refetch when the panel mounts.
    staleTime: 0,
    refetchOnMount: 'always',
  });

export const useSodConflicts = () =>
  useQuery({
    queryKey: ['sod-conflicts'],
    queryFn: () => api.get<SodUserConflict[]>('/sod-policies/conflicts'),
  });
