'use client';
/* TanStack Query hooks for numbering, imports, exports and opening balances (hardening H6). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommitImportInput,
  NumberingRuleInput,
  OpeningAssetsInput,
  OpeningInventoryInput,
  OpeningSubledgerInput,
} from '@accounting/validation';
import { API_BASE_PATH, HEADERS, REQUESTED_WITH_VALUE } from '@accounting/config';
import { api, getActiveCompanyId } from './client';
import type {
  ExportDataset,
  ImportJob,
  ImportJobDetail,
  ImportSpec,
  ImportType,
  NumberingRuleView,
  OpeningBalanceReport,
  OpeningLoadResult,
  PaginatedResult,
} from './types';

const key = (root: string, ...rest: unknown[]) =>
  [root, getActiveCompanyId() ?? 'none', ...rest] as const;

// ------------------------------------------------------------------ numbering

export const useNumberingRules = (year?: number) =>
  useQuery({
    queryKey: key('numbering', year ?? 'current'),
    queryFn: () =>
      api.get<NumberingRuleView[]>('/numbering-rules', { query: year ? { year } : undefined }),
  });

export const useUpsertNumberingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NumberingRuleInput) =>
      api.put<NumberingRuleView>('/numbering-rules', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['numbering'] }),
  });
};

export const useDeleteNumberingRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/numbering-rules/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['numbering'] }),
  });
};

// -------------------------------------------------------------------- imports

export const useImportTypes = () =>
  useQuery({ queryKey: ['import-types'], queryFn: () => api.get<ImportSpec[]>('/imports/types') });

export const useImports = (query: { page?: number; pageSize?: number; type?: ImportType }) =>
  useQuery({
    queryKey: key('imports', query),
    queryFn: () => api.get<PaginatedResult<ImportJob>>('/imports', { query }),
    placeholderData: (p) => p,
  });

export const useImport = (id: string | null) =>
  useQuery({
    queryKey: key('imports', 'detail', id),
    queryFn: () => api.get<ImportJobDetail>(`/imports/${id}`),
    enabled: Boolean(id),
  });

export const useUploadImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      type,
      file,
      asOfDate,
      branchId,
    }: {
      type: ImportType;
      file: File;
      asOfDate?: string;
      branchId?: string | null;
    }) => {
      const form = new FormData();
      form.append('type', type);
      form.append('file', file, file.name);
      if (asOfDate) form.append('asOfDate', asOfDate);
      if (branchId) form.append('branchId', branchId);
      return api.post<ImportJobDetail>('/imports', form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });
};

export const useCommitImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CommitImportInput & { id: string }) =>
      api.post<ImportJobDetail>(`/imports/${id}/commit`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void qc.invalidateQueries({ queryKey: ['accounting'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['vendors'] });
    },
  });
};

export const useCancelImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ImportJobDetail>(`/imports/${id}/cancel`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });
};

// -------------------------------------------------------------------- exports

/**
 * Downloads a CSV (export or import template) through the authenticated API
 * (cookie session + company header) and hands the blob to the browser.
 */
export async function downloadCsv(
  path: string,
  query: Record<string, string | undefined> = {},
  fallbackName = 'export.csv',
): Promise<void> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  const headers: Record<string, string> = { [HEADERS.REQUESTED_WITH]: REQUESTED_WITH_VALUE };
  const companyId = getActiveCompanyId();
  if (companyId) headers[HEADERS.COMPANY_ID] = companyId;
  const qs = params.toString();
  const res = await fetch(`${API_BASE_PATH}${path}${qs ? `?${qs}` : ''}`, {
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Download failed (${res.status})`);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const downloadExport = (
  dataset: ExportDataset,
  query: Record<string, string | undefined> = {},
) => downloadCsv('/exports', { dataset, ...query }, `${dataset.toLowerCase()}.csv`);

export const downloadImportTemplate = (type: ImportType) =>
  downloadCsv(`/imports/templates/${type}`, {}, `${type.toLowerCase()}-template.csv`);

// ----------------------------------------------------------- opening balances

export const useOpeningBalanceReport = (asOf: string) =>
  useQuery({
    queryKey: key('opening-balances', asOf),
    queryFn: () => api.get<OpeningBalanceReport>('/opening-balances/report', { query: { asOf } }),
  });

export const useLoadOpeningBalances = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | { kind: 'subledger'; body: OpeningSubledgerInput }
        | { kind: 'inventory'; body: OpeningInventoryInput }
        | { kind: 'assets'; body: OpeningAssetsInput },
    ) => api.post<OpeningLoadResult>(`/opening-balances/${input.kind}`, input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['opening-balances'] });
      void qc.invalidateQueries({ queryKey: ['accounting'] });
    },
  });
};
