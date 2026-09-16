'use client';
/*
 * Global record search for the command palette. Fans out to the existing
 * list endpoints (each already supports `search`) so no new API surface is
 * needed; results are capped per category and only requested for terms of
 * two or more characters.
 */
import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import type { PaginatedResult } from '@accounting/types';
import { api } from './client';
import type { AccountNode, JournalEntryView, Party, SubledgerDocument } from './types';
import { AP_CONFIG, AR_CONFIG } from '@/lib/subledger/config';

export interface SearchHit {
  id: string;
  /** Primary label (document number, code, name). */
  title: string;
  subtitle?: string;
  href: string;
  /** Monospace rendering for numbers / codes. */
  mono?: boolean;
}

export interface SearchCategory {
  key: string;
  label: string;
  hits: SearchHit[];
}

const LIMIT = 5;

export function useDebounced<T>(value: T, delay = 200): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function useGlobalSearch(term: string, enabled: boolean) {
  const q = useDebounced(term.trim(), 200);
  const active = enabled && q.length >= 2;
  const list = { page: 1, pageSize: LIMIT, search: q };

  const results = useQueries({
    queries: [
      {
        queryKey: ['search', 'journals', q],
        queryFn: () =>
          api.get<PaginatedResult<JournalEntryView>>('/journal-entries', { query: list }),
        enabled: active,
        staleTime: 15_000,
      },
      {
        queryKey: ['search', 'invoices', q],
        queryFn: () =>
          api.get<PaginatedResult<SubledgerDocument>>(AR_CONFIG.document.api, { query: list }),
        enabled: active,
        staleTime: 15_000,
      },
      {
        queryKey: ['search', 'bills', q],
        queryFn: () =>
          api.get<PaginatedResult<SubledgerDocument>>(AP_CONFIG.document.api, { query: list }),
        enabled: active,
        staleTime: 15_000,
      },
      {
        queryKey: ['search', 'customers', q],
        queryFn: () => api.get<PaginatedResult<Party>>(AR_CONFIG.party.api, { query: list }),
        enabled: active,
        staleTime: 15_000,
      },
      {
        queryKey: ['search', 'vendors', q],
        queryFn: () => api.get<PaginatedResult<Party>>(AP_CONFIG.party.api, { query: list }),
        enabled: active,
        staleTime: 15_000,
      },
      {
        queryKey: ['search', 'accounts', q],
        queryFn: () => api.get<AccountNode[]>('/accounts', { query: { search: q } }),
        enabled: active,
        staleTime: 15_000,
      },
    ],
  });

  const [journals, invoices, bills, customers, vendors, accounts] = results;
  const categories: SearchCategory[] = [];
  const docs = (
    key: string,
    label: string,
    data: PaginatedResult<SubledgerDocument> | undefined,
    path: string,
  ) => {
    const hits = (data?.items ?? []).map((d) => ({
      id: d.id,
      title: d.documentNumber,
      subtitle: [d.customerName ?? d.vendorName, d.status].filter(Boolean).join(' · '),
      href: `${path}/${d.id}`,
      mono: true,
    }));
    if (hits.length) categories.push({ key, label, hits });
  };
  const journalHits = (journals?.data?.items ?? []).map((j) => ({
    id: j.id,
    title: j.documentNumber,
    subtitle: `${j.entryDate} · ${j.status}`,
    href: `/accounting/journal-entries/${j.id}`,
    mono: true,
  }));
  if (journalHits.length)
    categories.push({ key: 'journals', label: 'Journals', hits: journalHits });
  docs('invoices', AR_CONFIG.document.plural, invoices?.data, AR_CONFIG.document.path);
  docs('bills', AP_CONFIG.document.plural, bills?.data, AP_CONFIG.document.path);
  const parties = (
    key: string,
    label: string,
    data: PaginatedResult<Party> | undefined,
    path: string,
  ) => {
    const hits = (data?.items ?? []).map((p) => ({
      id: p.id,
      title: p.name,
      subtitle: p.code,
      href: `${path}/${p.id}`,
    }));
    if (hits.length) categories.push({ key, label, hits });
  };
  parties('customers', AR_CONFIG.party.plural, customers?.data, AR_CONFIG.party.path);
  parties('vendors', AP_CONFIG.party.plural, vendors?.data, AP_CONFIG.party.path);
  const accountHits = (accounts?.data ?? []).slice(0, LIMIT).map((a) => ({
    id: a.id,
    title: `${a.code} ${a.name}`,
    subtitle: a.type.replace('_', ' '),
    href: `/accounting/general-ledger?accountId=${a.id}`,
    mono: true,
  }));
  if (accountHits.length)
    categories.push({ key: 'accounts', label: 'Accounts', hits: accountHits });

  return {
    term: q,
    active,
    isFetching: results.some((r) => r.isFetching),
    categories,
  };
}
