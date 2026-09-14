'use client';
/* TanStack Query hooks for Phase 9: AI intake, classification, anomalies, assistant, forecast. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiAnomalyScanInput,
  AiAskInput,
  AiClassifyInput,
  AiForecastQuery,
  DecideAiSuggestionInput,
  DraftFromAiDocumentInput,
  ListAiAnomaliesQuery,
  ListAiDocumentsQuery,
  UpdateAiDocumentInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  AiAccountSuggestion,
  AiAnomaly,
  AiAskResult,
  AiConversation,
  AiConversationDetail,
  AiDocument,
  AiDocumentDetail,
  AiForecast,
  AiScanResult,
  PaginatedResult,
} from './types';

const AI = 'ai';
const key = (...rest: unknown[]) => [AI, getActiveCompanyId() ?? 'none', ...rest] as const;

export const useAiStatus = () =>
  useQuery({
    queryKey: key('status'),
    queryFn: () =>
      api.get<{ provider: string; model: string | null; advisoryOnly: true }>('/ai/status'),
    staleTime: 5 * 60_000,
  });

// --------------------------------------------------------------------- intake

export const useAiDocuments = (query: Partial<ListAiDocumentsQuery>) =>
  useQuery({
    queryKey: key('intake', query),
    queryFn: () => api.get<PaginatedResult<AiDocument>>('/ai/intake', { query }),
    placeholderData: (p) => p,
  });

export const useAiDocument = (id: string | null) =>
  useQuery({
    queryKey: key('intake', id),
    queryFn: () => api.get<AiDocumentDetail>(`/ai/intake/${id}`),
    enabled: Boolean(id),
  });

export const useAiIntakeUpload = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, kind }: { file: File; kind?: string }) => {
      const form = new FormData();
      form.append('file', file, file.name);
      if (kind) form.append('kind', kind);
      return api.post<AiDocumentDetail>('/ai/intake', form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [AI] }),
  });
};

export const useUpdateAiDocument = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAiDocumentInput & { id: string }) =>
      api.patch<AiDocumentDetail>(`/ai/intake/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [AI] }),
  });
};

export const useDraftFromAiDocument = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DraftFromAiDocumentInput & { id: string }) =>
      api.post<AiDocumentDetail>(`/ai/intake/${id}/draft`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [AI] });
      void qc.invalidateQueries({ queryKey: ['AP'] });
      void qc.invalidateQueries({ queryKey: ['expense-claims'] });
    },
  });
};

export const useDismissAiDocument = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<AiDocumentDetail>(`/ai/intake/${id}/dismiss`, reason ? { reason } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [AI] }),
  });
};

// ------------------------------------------------------------- classification

export const useAiClassify = () =>
  useMutation({
    mutationFn: (input: AiClassifyInput) => api.post<AiAccountSuggestion[]>('/ai/classify', input),
  });

// ------------------------------------------------------------------ anomalies

export const useAiAnomalies = (query: Partial<ListAiAnomaliesQuery>) =>
  useQuery({
    queryKey: key('anomalies', query),
    queryFn: () => api.get<PaginatedResult<AiAnomaly>>('/ai/anomalies', { query }),
    placeholderData: (p) => p,
  });

export const useAiAnomalySummary = () =>
  useQuery({
    queryKey: key('anomalies', 'summary'),
    queryFn: () =>
      api.get<{ open: number; high: number; medium: number; low: number }>('/ai/anomalies/summary'),
  });

export const useAiScan = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AiAnomalyScanInput) => api.post<AiScanResult>('/ai/anomalies/scan', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [AI] }),
  });
};

export const useDecideAiAnomaly = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DecideAiSuggestionInput & { id: string }) =>
      api.post<AiAnomaly>(`/ai/anomalies/${id}/decide`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [AI] }),
  });
};

// ------------------------------------------------------------------ assistant

export const useAiConversations = () =>
  useQuery({
    queryKey: key('conversations'),
    queryFn: () =>
      api.get<PaginatedResult<AiConversation>>('/ai/conversations', { query: { pageSize: 50 } }),
  });

export const useAiConversation = (id: string | null) =>
  useQuery({
    queryKey: key('conversation', id),
    queryFn: () => api.get<AiConversationDetail>(`/ai/conversations/${id}`),
    enabled: Boolean(id),
  });

export const useAiAsk = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AiAskInput) => api.post<AiAskResult>('/ai/ask', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [AI] }),
  });
};

export const useAiForecast = (query: Partial<AiForecastQuery>) =>
  useQuery({
    queryKey: key('forecast', query),
    queryFn: () => api.get<AiForecast>('/ai/forecast', { query }),
    placeholderData: (p) => p,
  });
