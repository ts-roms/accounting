'use client';
/* TanStack Query hooks for Phase 8: exchange rates / FX, intercompany + consolidation, workflows, attachments. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttachmentEntityType } from '@accounting/types';
import type {
  ConsolidationQuery,
  CreateFxRevaluationInput,
  CreateIntercompanyInput,
  CreateWorkflowInput,
  DecideApprovalInput,
  ListApprovalsQuery,
  ListExchangeRatesQuery,
  ListIntercompanyQuery,
  UpdateWorkflowInput,
  UpsertExchangeRateInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  ApprovalRequest,
  ApprovalRequestDetail,
  ApprovalWorkflow,
  ApproverOptions,
  Attachment,
  MatrixRow,
  ConsolidationReport,
  ExchangeRate,
  FxRevaluation,
  FxRevaluationLine,
  IntercompanyTransaction,
  PaginatedResult,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';
const FX = 'fx';
const ICT = 'intercompany';
const WF = 'workflows';
const ATT = 'attachments';
const key = (root: string, ...rest: unknown[]) => [root, company(), ...rest] as const;

function invalidateLedger(qc: ReturnType<typeof useQueryClient>, root: string) {
  for (const k of [
    root,
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'balance-sheet',
    'dashboard',
    'AR',
    'AP',
  ]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

// ------------------------------------------------------------ exchange rates

export const useExchangeRates = (query: Partial<ListExchangeRatesQuery> = {}) =>
  useQuery({
    queryKey: [FX, 'rates', query] as const,
    queryFn: () => api.get<ExchangeRate[]>('/exchange-rates', { query }),
  });

/** Rate in force for a pair on a date; disabled for same-currency pairs. */
export const useResolvedRate = (
  fromCurrency: string | null | undefined,
  toCurrency: string,
  onDate: string,
) =>
  useQuery({
    queryKey: [FX, 'resolve', fromCurrency, toCurrency, onDate] as const,
    queryFn: () =>
      api.get<{ rate: string }>('/exchange-rates/resolve', {
        query: { fromCurrency, toCurrency, onDate },
      }),
    enabled: Boolean(fromCurrency && onDate && fromCurrency !== toCurrency),
    retry: false,
    staleTime: 60_000,
  });

export const useUpsertExchangeRate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertExchangeRateInput) => api.put<ExchangeRate>('/exchange-rates', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FX] }),
  });
};

export const useDeleteExchangeRate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/exchange-rates/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [FX] }),
  });
};

export const useFxRevaluations = (page = 1, pageSize = 25) =>
  useQuery({
    queryKey: key(FX, 'revaluations', page, pageSize),
    queryFn: () =>
      api.get<PaginatedResult<FxRevaluation>>('/fx/revaluations', { query: { page, pageSize } }),
    placeholderData: (p) => p,
  });

export const useFxRevaluationPreview = (asOfDate: string | null) =>
  useQuery({
    queryKey: key(FX, 'revaluation-preview', asOfDate),
    queryFn: () =>
      api.get<{ baseCurrency: string; lines: FxRevaluationLine[] }>('/fx/revaluations/preview', {
        query: { asOfDate },
      }),
    enabled: Boolean(asOfDate),
    retry: false,
  });

export const useCreateFxRevaluation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFxRevaluationInput) =>
      api.post<FxRevaluation>('/fx/revaluations', input),
    onSuccess: () => invalidateLedger(qc, FX),
  });
};

// -------------------------------------------------------------- intercompany

export const useIntercompany = (query: Partial<ListIntercompanyQuery>) =>
  useQuery({
    queryKey: [ICT, 'list', query] as const,
    queryFn: () => api.get<PaginatedResult<IntercompanyTransaction>>('/intercompany', { query }),
    placeholderData: (p) => p,
  });

export const useCreateIntercompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIntercompanyInput) =>
      api.post<IntercompanyTransaction>('/intercompany', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [ICT] }),
  });
};

export const useIntercompanyAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'post' | 'reverse';
      reason?: string;
    }) =>
      api.post<IntercompanyTransaction>(
        `/intercompany/${id}/${action}`,
        reason ? { reason } : undefined,
      ),
    onSuccess: () => invalidateLedger(qc, ICT),
  });
};

export const useDeleteIntercompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/intercompany/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [ICT] }),
  });
};

export const useConsolidation = (
  query: Partial<ConsolidationQuery> & { from: string; to: string },
) =>
  useQuery({
    queryKey: ['consolidation', query] as const,
    queryFn: () =>
      api.get<ConsolidationReport>('/consolidation/trial-balance', {
        query: {
          from: query.from,
          to: query.to,
          currency: query.currency,
          companyIds: query.companyIds?.join(',') || undefined,
        },
      }),
    placeholderData: (p) => p,
  });

// ----------------------------------------------------------------- workflows

export const useWorkflows = () =>
  useQuery({
    queryKey: key(WF, 'workflows'),
    queryFn: () => api.get<ApprovalWorkflow[]>('/approval-workflows'),
  });

export const useCreateWorkflow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkflowInput) =>
      api.post<ApprovalWorkflow>('/approval-workflows', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [WF] }),
  });
};

export const useUpdateWorkflow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateWorkflowInput & { id: string }) =>
      api.patch<ApprovalWorkflow>(`/approval-workflows/${id}`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [WF] }),
  });
};

export const useApprovalMatrix = () =>
  useQuery({
    queryKey: key(WF, 'matrix'),
    queryFn: () => api.get<MatrixRow[]>('/approval-workflows/matrix'),
  });

export const useApproverOptions = () =>
  useQuery({
    queryKey: key(WF, 'approver-options'),
    queryFn: () => api.get<ApproverOptions>('/approval-workflows/approver-options'),
    staleTime: 60_000,
  });

export const useApprovals = (query: Partial<ListApprovalsQuery>) =>
  useQuery({
    queryKey: key(WF, 'approvals', query),
    queryFn: () => api.get<PaginatedResult<ApprovalRequest>>('/approvals', { query }),
    placeholderData: (p) => p,
  });

export const useApproval = (id: string | null) =>
  useQuery({
    queryKey: key(WF, 'approval', id),
    queryFn: () => api.get<ApprovalRequestDetail>(`/approvals/${id}`),
    enabled: Boolean(id),
  });

export const useDecideApproval = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DecideApprovalInput & { id: string }) =>
      api.post<ApprovalRequestDetail>(`/approvals/${id}/decide`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [WF] });
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
  });
};

// --------------------------------------------------------------- attachments

export const useAttachments = (entityType: AttachmentEntityType, entityId: string | null) =>
  useQuery({
    queryKey: key(ATT, entityType, entityId),
    queryFn: () => api.get<Attachment[]>(`/attachments/${entityType}/${entityId}`),
    enabled: Boolean(entityId),
  });

export const useUploadAttachment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      entityType,
      entityId,
      file,
      description,
    }: {
      entityType: AttachmentEntityType;
      entityId: string;
      file: File;
      description?: string;
    }) => {
      const form = new FormData();
      form.append('file', file, file.name);
      if (description) form.append('description', description);
      return api.post<Attachment>(`/attachments/${entityType}/${entityId}`, form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [ATT] }),
  });
};

export const useDeleteAttachment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/attachments/file/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [ATT] }),
  });
};

export const attachmentDownloadUrl = (id: string) => `/api/v1/attachments/file/${id}`;
