'use client';
/* TanStack Query hooks for integrations, API keys, webhooks, logs and notifications (Prompt #4). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateApiKeyInput,
  CreateIntegrationInput,
  CreateWebhookInput,
  ListIntegrationLogsQuery,
  ListIntegrationsQuery,
  ListSyncJobsQuery,
  ListWebhookDeliveriesQuery,
  PreviewMappingInput,
  TriggerSyncInput,
  UpdateIntegrationInput,
  UpdateWebhookInput,
  UpsertMappingInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  ApiKeyView,
  CreatedApiKey,
  CreatedWebhook,
  ExternalReferenceView,
  InboundEventView,
  IntegrationHealthView,
  IntegrationLogView,
  IntegrationMappingView,
  IntegrationView,
  MappingPreview,
  MappingsResponse,
  NotificationView,
  ProviderDescriptor,
  ScopeCatalogEntry,
  SyncJobView,
  WebhookDeliveryView,
  WebhookView,
} from './integrations-types';
import type { PaginatedResult } from './types';

const ROOT = 'integrations';
const key = (...rest: unknown[]) => [ROOT, getActiveCompanyId() ?? 'none', ...rest] as const;
const invalidate = (qc: ReturnType<typeof useQueryClient>, ...roots: string[]) => {
  for (const r of [ROOT, ...roots]) void qc.invalidateQueries({ queryKey: [r] });
};

// ------------------------------------------------------------- integrations

export const useProviders = () =>
  useQuery({
    queryKey: [ROOT, 'providers'],
    queryFn: () => api.get<ProviderDescriptor[]>('/integrations/providers'),
    staleTime: 5 * 60_000,
  });

export const useIntegrations = (query: Partial<ListIntegrationsQuery>) =>
  useQuery({
    queryKey: key('list', query),
    queryFn: () => api.get<PaginatedResult<IntegrationView>>('/integrations', { query }),
    placeholderData: (p) => p,
  });

export const useIntegration = (id: string | null) =>
  useQuery({
    queryKey: key('detail', id),
    queryFn: () => api.get<IntegrationView>(`/integrations/${id}`),
    enabled: Boolean(id),
  });

export const useIntegrationHealth = (id: string | null) =>
  useQuery({
    queryKey: key('health', id),
    queryFn: () => api.get<IntegrationHealthView>(`/integrations/${id}/health`),
    enabled: Boolean(id),
    refetchInterval: 60_000,
  });

export const useSyncJobs = (id: string | null, query: Partial<ListSyncJobsQuery>) =>
  useQuery({
    queryKey: key('sync-jobs', id, query),
    queryFn: () =>
      api.get<PaginatedResult<SyncJobView>>(`/integrations/${id}/sync-jobs`, { query }),
    enabled: Boolean(id),
    refetchInterval: (q) =>
      q.state.data?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING')
        ? 2000
        : false,
  });

export const useIntegrationLogs = (id: string | null, query: Partial<ListIntegrationLogsQuery>) =>
  useQuery({
    queryKey: key('logs', id, query),
    queryFn: () =>
      api.get<PaginatedResult<IntegrationLogView>>(`/integrations/${id}/logs`, { query }),
    enabled: Boolean(id),
    placeholderData: (p) => p,
  });

export const useAllIntegrationLogs = (query: Partial<ListIntegrationLogsQuery>) =>
  useQuery({
    queryKey: key('all-logs', query),
    queryFn: () => api.get<PaginatedResult<IntegrationLogView>>('/integration-logs', { query }),
    placeholderData: (p) => p,
  });

export const useIntegrationMappings = (id: string | null) =>
  useQuery({
    queryKey: key('mappings', id),
    queryFn: () => api.get<MappingsResponse>(`/integrations/${id}/mappings`),
    enabled: Boolean(id),
  });

export const useExternalReferences = (id: string | null, entityType?: string) =>
  useQuery({
    queryKey: key('refs', id, entityType),
    queryFn: () =>
      api.get<ExternalReferenceView[]>(`/integrations/${id}/external-references`, {
        query: { entityType },
      }),
    enabled: Boolean(id),
  });

export const useInboundEvents = (id: string | null) =>
  useQuery({
    queryKey: key('events', id),
    queryFn: () => api.get<InboundEventView[]>(`/integrations/${id}/events`),
    enabled: Boolean(id),
  });

export const useCreateIntegration = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIntegrationInput) =>
      api.post<IntegrationView>('/integrations', input),
    onSuccess: () => invalidate(qc),
  });
};

export const useUpdateIntegration = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateIntegrationInput & { id: string }) =>
      api.patch<IntegrationView>(`/integrations/${id}`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useIntegrationAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'connect' | 'disconnect' | 'test' | 'oauth/refresh' | 'oauth/disconnect';
      body?: unknown;
    }) =>
      api.post<IntegrationView | { ok: boolean; latencyMs: number; message: string }>(
        `/integrations/${id}/${action}`,
        body ?? {},
      ),
    onSuccess: () => invalidate(qc),
  });
};

export const useDeleteIntegration = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/integrations/${id}`),
    onSuccess: () => invalidate(qc),
  });
};

export const useTriggerSync = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<TriggerSyncInput> & { id: string }) =>
      api.post<SyncJobView>(`/integrations/${id}/sync`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useTriggerPush = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<TriggerSyncInput> & { id: string }) =>
      api.post<SyncJobView>(`/integrations/${id}/push`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useCancelSync = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, jobId }: { id: string; jobId: string }) =>
      api.post<SyncJobView>(`/integrations/${id}/sync-jobs/${jobId}/cancel`),
    onSuccess: () => invalidate(qc),
  });
};

export const useOAuthStart = () =>
  useMutation({
    mutationFn: ({ id, returnTo }: { id: string; returnTo?: string }) =>
      api.post<{ authorizationUrl: string }>(`/integrations/${id}/oauth/start`, { returnTo }),
  });

export const useUpsertMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpsertMappingInput & { id: string }) =>
      api.post<IntegrationMappingView>(`/integrations/${id}/mappings`, input),
    onSuccess: () => invalidate(qc),
  });
};

export const useDeleteMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mappingId }: { id: string; mappingId: string }) =>
      api.delete<void>(`/integrations/${id}/mappings/${mappingId}`),
    onSuccess: () => invalidate(qc),
  });
};

export const usePreviewMapping = () =>
  useMutation({
    mutationFn: ({ id, ...input }: PreviewMappingInput & { id: string }) =>
      api.post<MappingPreview>(`/integrations/${id}/mappings/preview`, input),
  });

// ----------------------------------------------------------------- API keys

export const useApiKeys = () =>
  useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<ApiKeyView[]>('/api-keys') });

export const useScopeCatalog = () =>
  useQuery({
    queryKey: ['api-keys', 'scopes'],
    queryFn: () => api.get<ScopeCatalogEntry[]>('/api-keys/scopes'),
    staleTime: 5 * 60_000,
  });

export const useCreateApiKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) => api.post<CreatedApiKey>('/api-keys', input),
    onSuccess: () => invalidate(qc, 'api-keys'),
  });
};

export const useRotateApiKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, graceMinutes }: { id: string; graceMinutes: number }) =>
      api.post<CreatedApiKey>(`/api-keys/${id}/rotate`, { graceMinutes }),
    onSuccess: () => invalidate(qc, 'api-keys'),
  });
};

export const useRevokeApiKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.delete<ApiKeyView>(`/api-keys/${id}`, { body: { reason } }),
    onSuccess: () => invalidate(qc, 'api-keys'),
  });
};

// ----------------------------------------------------------------- webhooks

export const useWebhooks = () =>
  useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<WebhookView[]>('/webhooks') });

export const useWebhookEventTypes = () =>
  useQuery({
    queryKey: ['webhooks', 'event-types'],
    queryFn: () => api.get<string[]>('/webhooks/event-types'),
    staleTime: 5 * 60_000,
  });

export const useWebhookDeliveries = (query: Partial<ListWebhookDeliveriesQuery>) =>
  useQuery({
    queryKey: ['webhooks', 'deliveries', query],
    queryFn: () => api.get<PaginatedResult<WebhookDeliveryView>>('/webhooks/deliveries', { query }),
    placeholderData: (p) => p,
  });

export const useCreateWebhook = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWebhookInput) => api.post<CreatedWebhook>('/webhooks', input),
    onSuccess: () => invalidate(qc, 'webhooks'),
  });
};

export const useUpdateWebhook = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateWebhookInput & { id: string }) =>
      api.patch<WebhookView>(`/webhooks/${id}`, input),
    onSuccess: () => invalidate(qc, 'webhooks'),
  });
};

export const useWebhookAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'test' | 'replay' | 'rotate-secret';
      body?: unknown;
    }) =>
      api.post<WebhookDeliveryView & { replayed?: number; secret?: string }>(
        `/webhooks/${id}/${action}`,
        body ?? {},
      ),
    onSuccess: () => invalidate(qc, 'webhooks'),
  });
};

export const useDeleteWebhook = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/webhooks/${id}`),
    onSuccess: () => invalidate(qc, 'webhooks'),
  });
};

// ------------------------------------------------------------ notifications

export const useNotifications = (unreadOnly = false) =>
  useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () =>
      api.get<PaginatedResult<NotificationView>>('/notifications', {
        query: { pageSize: 20, unreadOnly },
      }),
    refetchInterval: 60_000,
  });

export const useUnreadCount = () =>
  useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 60_000,
  });

export const useMarkNotificationsRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id?: string): Promise<void> => {
      if (id) await api.post<void>(`/notifications/${id}/read`);
      else await api.post<{ updated: number }>('/notifications/read-all');
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
};
