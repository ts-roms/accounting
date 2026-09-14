'use client';
/* Config-driven TanStack Query hooks shared by the receivables and payables screens. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgingQuery,
  AllocateInput,
  CreateBillInput,
  CreateCustomerInput,
  CreateInvoiceInput,
  CreatePaymentInput,
  CreateVendorInput,
  ListDocumentsQuery,
  ListPartiesQuery,
  ListPaymentsQuery,
  StatementQuery,
  UpdateBillInput,
  UpdateCustomerInput,
  UpdateInvoiceInput,
  UpdatePaymentInput,
  UpdateVendorInput,
  VoidDocumentInput,
} from '@accounting/validation';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { api, getActiveCompanyId } from './client';
import type {
  AgingReport,
  PaginatedResult,
  Party,
  ReconciliationReport,
  ScheduleReport,
  StatementReport,
  SubledgerDocument,
  SubledgerDocumentDetail,
  SubledgerPayment,
  SubledgerPaymentDetail,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';
const key = (cfg: SubledgerConfig, ...rest: unknown[]) => [cfg.side, company(), ...rest] as const;

/** Every subledger change can move ledger-derived views too. */
function invalidateSide(qc: ReturnType<typeof useQueryClient>, cfg: SubledgerConfig) {
  void qc.invalidateQueries({ queryKey: [cfg.side] });
  for (const k of [
    'journal-entries',
    'journal-entry',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'balance-sheet',
  ]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

export type PartyInput = CreateCustomerInput | CreateVendorInput;
export type PartyUpdate = UpdateCustomerInput | UpdateVendorInput;
export type DocumentInput = CreateInvoiceInput | CreateBillInput;
export type DocumentUpdate = UpdateInvoiceInput | UpdateBillInput;

// ------------------------------------------------------------------- parties

export const useParties = (cfg: SubledgerConfig, query: Partial<ListPartiesQuery>) =>
  useQuery({
    queryKey: key(cfg, 'parties', query),
    queryFn: () => api.get<PaginatedResult<Party>>(cfg.party.api, { query }),
    placeholderData: (p) => p,
  });

export const useParty = (cfg: SubledgerConfig, id: string | null) =>
  useQuery({
    queryKey: key(cfg, 'party', id),
    queryFn: () => api.get<Party>(`${cfg.party.api}/${id}`),
    enabled: Boolean(id),
  });

export const useCreateParty = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PartyInput) => api.post<Party>(cfg.party.api, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useUpdateParty = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PartyUpdate & { id: string }) =>
      api.patch<Party>(`${cfg.party.api}/${id}`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useStatement = (cfg: SubledgerConfig, partyId: string | null, query: StatementQuery) =>
  useQuery({
    queryKey: key(cfg, 'statement', partyId, query),
    queryFn: () => api.get<StatementReport>(`${cfg.party.api}/${partyId}/statement`, { query }),
    enabled: Boolean(partyId),
  });

// ----------------------------------------------------------------- documents

export const useDocuments = (
  cfg: SubledgerConfig,
  query: Partial<ListDocumentsQuery>,
  enabled = true,
) =>
  useQuery({
    queryKey: key(cfg, 'documents', query),
    queryFn: () => api.get<PaginatedResult<SubledgerDocument>>(cfg.document.api, { query }),
    placeholderData: (p) => p,
    enabled,
  });

export const useDocument = (cfg: SubledgerConfig, id: string | null) =>
  useQuery({
    queryKey: key(cfg, 'document', id),
    queryFn: () => api.get<SubledgerDocumentDetail>(`${cfg.document.api}/${id}`),
    enabled: Boolean(id),
  });

export const useCreateDocument = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DocumentInput) =>
      api.post<SubledgerDocumentDetail>(cfg.document.api, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useUpdateDocument = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DocumentUpdate & { id: string }) =>
      api.patch<SubledgerDocumentDetail>(`${cfg.document.api}/${id}`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useDeleteDocument = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`${cfg.document.api}/${id}`),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export type DocumentAction = 'approve' | 'post';

export const useDocumentAction = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: DocumentAction }) =>
      api.post<SubledgerDocumentDetail>(`${cfg.document.api}/${id}/${action}`),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useVoidDocument = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VoidDocumentInput & { id: string }) =>
      api.post<SubledgerDocumentDetail>(`${cfg.document.api}/${id}/void`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useApplyCreditNote = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: AllocateInput & { id: string }) =>
      api.post<SubledgerDocumentDetail>(`${cfg.document.api}/${id}/apply`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useUpdateCollection = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      promisedPaymentDate?: string | null;
      collectionNotes?: string;
      scheduledPaymentDate?: string | null;
    }) =>
      cfg.side === 'AR'
        ? api.patch<SubledgerDocumentDetail>(`${cfg.document.api}/${id}/collection`, {
            promisedPaymentDate: input.promisedPaymentDate,
            collectionNotes: input.collectionNotes,
          })
        : api.patch<SubledgerDocumentDetail>(`${cfg.document.api}/${id}/schedule`, {
            scheduledPaymentDate: input.scheduledPaymentDate ?? null,
          }),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

// ------------------------------------------------------------------ payments

export const usePayments = (cfg: SubledgerConfig, query: Partial<ListPaymentsQuery>) =>
  useQuery({
    queryKey: key(cfg, 'payments', query),
    queryFn: () => api.get<PaginatedResult<SubledgerPayment>>(cfg.payment.api, { query }),
    placeholderData: (p) => p,
  });

export const usePayment = (cfg: SubledgerConfig, id: string | null) =>
  useQuery({
    queryKey: key(cfg, 'payment', id),
    queryFn: () => api.get<SubledgerPaymentDetail>(`${cfg.payment.api}/${id}`),
    enabled: Boolean(id),
  });

export const useCreatePayment = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentInput) =>
      api.post<SubledgerPaymentDetail>(cfg.payment.api, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useUpdatePayment = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePaymentInput & { id: string }) =>
      api.patch<SubledgerPaymentDetail>(`${cfg.payment.api}/${id}`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useDeletePayment = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`${cfg.payment.api}/${id}`),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const usePostPayment = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SubledgerPaymentDetail>(`${cfg.payment.api}/${id}/post`),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useAllocatePayment = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: AllocateInput & { id: string }) =>
      api.post<SubledgerPaymentDetail>(`${cfg.payment.api}/${id}/allocate`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

export const useVoidPayment = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VoidDocumentInput & { id: string }) =>
      api.post<SubledgerPaymentDetail>(`${cfg.payment.api}/${id}/void`, input),
    onSuccess: () => invalidateSide(qc, cfg),
  });
};

// ------------------------------------------------------------------- reports

export const useAging = (cfg: SubledgerConfig, query: AgingQuery, enabled = true) =>
  useQuery({
    queryKey: key(cfg, 'aging', query),
    queryFn: () => api.get<AgingReport>(cfg.reports.agingApi, { query }),
    enabled,
    placeholderData: (p) => p,
  });

export const useReconciliation = (cfg: SubledgerConfig, asOf: string, enabled = true) =>
  useQuery({
    queryKey: key(cfg, 'reconciliation', asOf),
    queryFn: () =>
      api.get<ReconciliationReport>(cfg.reports.reconciliationApi, { query: { asOf } }),
    enabled,
  });

export const useSchedule = (cfg: SubledgerConfig, to: string, enabled = true) =>
  useQuery({
    queryKey: key(cfg, 'schedule', to),
    queryFn: () => api.get<ScheduleReport>(cfg.reports.scheduleApi!, { query: { to } }),
    enabled: enabled && Boolean(cfg.reports.scheduleApi),
  });
