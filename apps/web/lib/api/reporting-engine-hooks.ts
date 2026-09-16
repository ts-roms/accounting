'use client';
/* TanStack Query hooks for the reporting engine, journal control center and traceability (hardening H7). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CopyReportDefinitionInput,
  CreateReportDefinitionInput,
  ListJournalEntriesQuery,
  ListReportDefinitionsQuery,
  RunAdHocReportInput,
  RunReportInput,
  UpdateReportDefinitionInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  JournalControlSummary,
  JournalTrace,
  PaginatedResult,
  ReportDefinitionView,
  ReportResult,
  TraceJournal,
} from './types';

const key = (root: string, ...rest: unknown[]) =>
  [root, getActiveCompanyId() ?? 'none', ...rest] as const;

// ---------------------------------------------------------------- definitions

export const useReportDefinitions = (query: Partial<ListReportDefinitionsQuery> = {}) =>
  useQuery({
    queryKey: key('report-definitions', query),
    queryFn: () =>
      api.get<PaginatedResult<ReportDefinitionView>>('/report-definitions', {
        query: { pageSize: 100, ...query },
      }),
  });

export const useReportDefinition = (id: string | null) =>
  useQuery({
    queryKey: key('report-definition', id ?? ''),
    queryFn: () => api.get<ReportDefinitionView>(`/report-definitions/${id}`),
    enabled: Boolean(id),
  });

export const useCreateReportDefinition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReportDefinitionInput) =>
      api.post<ReportDefinitionView>('/report-definitions', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['report-definitions'] }),
  });
};

export const useUpdateReportDefinition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateReportDefinitionInput & { id: string }) =>
      api.patch<ReportDefinitionView>(`/report-definitions/${id}`, input),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['report-definitions'] });
      void qc.invalidateQueries({ queryKey: key('report-definition', v.id) });
      void qc.invalidateQueries({ queryKey: ['report-run'] });
    },
  });
};

export const useCopyReportDefinition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CopyReportDefinitionInput & { id: string }) =>
      api.post<ReportDefinitionView>(`/report-definitions/${id}/copy`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['report-definitions'] }),
  });
};

// ----------------------------------------------------------------------- runs

/** Runs a saved definition; the result is cached per (definition, params) like a query. */
export const useReportRun = (id: string | null, params: RunReportInput | null) =>
  useQuery({
    queryKey: key('report-run', id ?? '', params),
    queryFn: () => api.post<ReportResult>(`/report-definitions/${id}/run`, params),
    enabled: Boolean(id && params),
    placeholderData: (prev) => prev,
  });

export const useRunAdHocReport = () =>
  useMutation({
    mutationFn: (input: RunAdHocReportInput) => api.post<ReportResult>('/reports/run', input),
  });

// ------------------------------------------------------- journal control center

export const useJournalControlSummary = (query: Partial<ListJournalEntriesQuery>) =>
  useQuery({
    queryKey: key('journal-control-summary', query),
    queryFn: () => api.get<JournalControlSummary>('/journal-entries/summary', { query }),
    placeholderData: (prev) => prev,
  });

// ---------------------------------------------------------------------- trace

export const useJournalTrace = (id: string | null, enabled = true) =>
  useQuery({
    queryKey: key('trace-journal', id ?? ''),
    queryFn: () => api.get<JournalTrace>(`/trace/journal/${id}`),
    enabled: Boolean(id) && enabled,
  });

export const useDocumentJournals = (sourceId: string | null, enabled = true) =>
  useQuery({
    queryKey: key('trace-document', sourceId ?? ''),
    queryFn: () => api.get<TraceJournal[]>(`/trace/document/${sourceId}`),
    enabled: Boolean(sourceId) && enabled,
  });
