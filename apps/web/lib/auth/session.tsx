'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { DelegatedGrant, PermissionKey } from '@accounting/types';
import { api, getActiveCompanyId, setActiveCompanyId } from '../api/client';
import { useMe } from '../api/hooks';
import type { CompanySummary, MeResponse } from '../api/types';

interface SessionContextValue {
  me: MeResponse;
  activeCompany: CompanySummary | null;
  setActiveCompany: (companyId: string | null) => void;
  hasPermission: (...keys: PermissionKey[]) => boolean;
  hasAnyPermission: (...keys: PermissionKey[]) => boolean;
  /** Own permission OR an active delegation for it in the active company. */
  hasAuthority: (key: PermissionKey) => boolean;
  /** The delegation lending `key`, when the user does not hold it natively. */
  delegationFor: (key: PermissionKey) => DelegatedGrant | null;
  logout: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

/**
 * Loads the current principal once and exposes permission helpers. The active
 * company is persisted client-side and sent as a header on every request; the
 * API re-validates access on each call, so this is purely a UX convenience.
 */
export function SessionProvider({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = React.useState<string | null>(() => getActiveCompanyId());
  const { data: me, isLoading, isError } = useMe();

  React.useEffect(() => {
    if (isError) router.replace('/login');
  }, [isError, router]);

  // Auto-select the first accessible company if none (or a stale one) is stored.
  React.useEffect(() => {
    if (!me) return;
    const valid = companyId && me.companies.some((c) => c.id === companyId);
    if (!valid) {
      const first = me.companies[0]?.id ?? null;
      setCompanyId(first);
      setActiveCompanyId(first);
      if (first) void queryClient.invalidateQueries({ queryKey: ['me'] });
    }
  }, [me, companyId, queryClient]);

  const setActiveCompany = React.useCallback(
    (id: string | null) => {
      setCompanyId(id);
      setActiveCompanyId(id);
      // Permissions can differ per company: refetch everything.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const logout = React.useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setActiveCompanyId(null);
      queryClient.clear();
      router.replace('/login');
    }
  }, [queryClient, router]);

  const value = React.useMemo<SessionContextValue | null>(() => {
    if (!me) return null;
    const granted = new Set(me.permissions);
    return {
      me,
      activeCompany: me.companies.find((c) => c.id === companyId) ?? null,
      setActiveCompany,
      hasPermission: (...keys) => keys.every((k) => granted.has(k)),
      hasAnyPermission: (...keys) => keys.length === 0 || keys.some((k) => granted.has(k)),
      hasAuthority: (key) =>
        granted.has(key) || (me.delegations ?? []).some((d) => d.permission === key),
      delegationFor: (key) =>
        granted.has(key)
          ? null
          : ((me.delegations ?? []).find((d) => d.permission === key) ?? null),
      logout,
    };
  }, [me, companyId, setActiveCompany, logout]);

  if (isLoading || !value) return <>{fallback}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
