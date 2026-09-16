'use client';
/* TanStack Query hooks for the AR / order-to-cash platform (Prompt #6). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ArSettingsInput,
  CollectionActivityInput,
  CreateCollectionCaseInput,
  CreateCreditRuleInput,
  CreateCustomerGroupInput,
  CreateDeliveryInput,
  CreateDisputeInput,
  CreateDunningPolicyInput,
  CreatePaymentTermInput,
  CreatePromiseInput,
  CreateProvisionRunInput,
  CreateRefundRequestInput,
  CreateWriteOffInput,
  CreditHoldInput,
  CreditProfileInput,
  CustomerAddressInput,
  CustomerContactInput,
  ListCollectionCasesQuery,
  ListDeliveriesQuery,
  ListDisputesQuery,
  ListPromisesQuery,
  ListRefundsQuery,
  ListWriteOffsQuery,
  PayRefundInput,
  UpdateCollectionCaseInput,
  UpdateCreditRuleInput,
  UpdateCustomerGroupInput,
  UpdateDisputeInput,
  UpdateDunningPolicyInput,
  UpdatePaymentTermInput,
  UpdatePromiseInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  ArDashboard,
  ArReconciliation,
  ArSettings,
  BadDebtProvision,
  CollectionCase,
  CollectionCaseDetail,
  CreditRule,
  CreditSummary,
  CustomerAddress,
  CustomerContact,
  CustomerGroup,
  Delivery,
  DeliveryDetail,
  Dispute,
  DunningPolicy,
  GeneratedStatement,
  PaymentTerm,
  PromiseToPay,
  RefundRequest,
  StatementSnapshot,
  UnappliedCashReport,
  WriteOff,
} from './receivables-types';
import type { PaginatedResult, SubledgerDocumentDetail } from './types';

const company = () => getActiveCompanyId() ?? 'none';
const key = (...rest: unknown[]) => ['AR', company(), 'platform', ...rest] as const;

/** AR changes move ledger-derived views and the shared subledger screens too. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['AR', 'journal-entries', 'general-ledger', 'trial-balance', 'orders'])
    void qc.invalidateQueries({ queryKey: [k] });
}

// ---------------------------------------------------------------- settings

export const useArSettings = () =>
  useQuery({ queryKey: key('settings'), queryFn: () => api.get<ArSettings>('/ar-settings') });
export const useUpdateArSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ArSettingsInput) => api.patch<ArSettings>('/ar-settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const usePaymentTerms = () =>
  useQuery({
    queryKey: key('payment-terms'),
    queryFn: () => api.get<PaymentTerm[]>('/payment-terms'),
  });
export const useCreatePaymentTerm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentTermInput) => api.post<PaymentTerm>('/payment-terms', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdatePaymentTerm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePaymentTermInput & { id: string }) =>
      api.patch<PaymentTerm>(`/payment-terms/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useCustomerGroups = () =>
  useQuery({
    queryKey: key('groups'),
    queryFn: () => api.get<CustomerGroup[]>('/customer-groups'),
  });
export const useCreateCustomerGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerGroupInput) =>
      api.post<CustomerGroup>('/customer-groups', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateCustomerGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCustomerGroupInput & { id: string }) =>
      api.patch<CustomerGroup>(`/customer-groups/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useCreditRules = () =>
  useQuery({
    queryKey: key('credit-rules'),
    queryFn: () => api.get<CreditRule[]>('/credit-rules'),
  });
export const useCreateCreditRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCreditRuleInput) => api.post<CreditRule>('/credit-rules', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateCreditRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCreditRuleInput & { id: string }) =>
      api.patch<CreditRule>(`/credit-rules/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDunningPolicies = () =>
  useQuery({
    queryKey: key('dunning'),
    queryFn: () => api.get<DunningPolicy[]>('/dunning-policies'),
  });
export const useCreateDunningPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDunningPolicyInput) =>
      api.post<DunningPolicy>('/dunning-policies', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateDunningPolicy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateDunningPolicyInput & { id: string }) =>
      api.patch<DunningPolicy>(`/dunning-policies/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ---------------------------------------------------------- customer master

export const useCreditSummary = (customerId: string | null) =>
  useQuery({
    queryKey: key('credit', customerId),
    queryFn: () => api.get<CreditSummary>(`/customers/${customerId}/credit`),
    enabled: Boolean(customerId),
  });
export const useUpdateCreditProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CreditProfileInput & { id: string }) =>
      api.patch<CreditSummary>(`/customers/${id}/credit`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useCreditHold = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CreditHoldInput & { id: string }) =>
      api.post<CreditSummary>(`/customers/${id}/credit-hold`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddContact = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CustomerContactInput & { id: string }) =>
      api.post<CustomerContact>(`/customers/${id}/contacts`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemoveContact = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, contactId }: { id: string; contactId: string }) =>
      api.delete<void>(`/customers/${id}/contacts/${contactId}`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddAddress = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CustomerAddressInput & { id: string }) =>
      api.post<CustomerAddress>(`/customers/${id}/addresses`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemoveAddress = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, addressId }: { id: string; addressId: string }) =>
      api.delete<void>(`/customers/${id}/addresses/${addressId}`),
    onSuccess: () => invalidateAll(qc),
  });
};

// -------------------------------------------------------------- deliveries

export const useDeliveries = (query: Partial<ListDeliveriesQuery>) =>
  useQuery({
    queryKey: key('deliveries', query),
    queryFn: () => api.get<PaginatedResult<Delivery>>('/deliveries', { query }),
    placeholderData: (p) => p,
  });
export const useDelivery = (id: string | null) =>
  useQuery({
    queryKey: key('delivery', id),
    queryFn: () => api.get<DeliveryDetail>(`/deliveries/${id}`),
    enabled: Boolean(id),
  });
export const useCreateDelivery = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeliveryInput) => api.post<DeliveryDetail>('/deliveries', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export type DeliveryAction = 'pick' | 'ready' | 'deliver' | 'cancel';
export const useDeliveryAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
      deliveryDate,
    }: {
      id: string;
      action: DeliveryAction;
      reason?: string;
      deliveryDate?: string;
    }) => api.post<DeliveryDetail>(`/deliveries/${id}/${action}`, { reason, deliveryDate }),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useInvoiceDelivery = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SubledgerDocumentDetail>(`/deliveries/${id}/invoice`),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------- documents (submit)

export const useSubmitInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SubledgerDocumentDetail>(`/invoices/${id}/submit`),
    onSuccess: () => invalidateAll(qc),
  });
};
export const usePaymentStep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'submit' | 'approve' }) =>
      api.post<unknown>(`/customer-payments/${id}/${action}`),
    onSuccess: () => invalidateAll(qc),
  });
};

// ----------------------------------------------------------------- refunds

export const useRefunds = (query: Partial<ListRefundsQuery>) =>
  useQuery({
    queryKey: key('refunds', query),
    queryFn: () => api.get<PaginatedResult<RefundRequest>>('/refunds', { query }),
    placeholderData: (p) => p,
  });
export const useRefund = (id: string | null) =>
  useQuery({
    queryKey: key('refund', id),
    queryFn: () => api.get<RefundRequest>(`/refunds/${id}`),
    enabled: Boolean(id),
  });
export const useCreateRefund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRefundRequestInput) => api.post<RefundRequest>('/refunds', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRefundFromPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      paymentId,
      ...input
    }: {
      paymentId: string;
      amount?: string;
      reason: string;
      reference?: string;
    }) => api.post<RefundRequest>(`/customer-payments/${paymentId}/refund`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRefundAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      comment,
      paymentDate,
    }: {
      id: string;
      action: 'submit' | 'approve' | 'reject' | 'cancel' | 'pay';
      comment?: string;
      paymentDate?: string;
    }) =>
      api.post<RefundRequest>(
        `/refunds/${id}/${action}`,
        action === 'pay' ? ({ paymentDate } as PayRefundInput) : { comment },
      ),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------- collections

export const useCollectionCases = (query: Partial<ListCollectionCasesQuery>) =>
  useQuery({
    queryKey: key('cases', query),
    queryFn: () => api.get<PaginatedResult<CollectionCase>>('/collections', { query }),
    placeholderData: (p) => p,
  });
export const useCollectionCase = (id: string | null) =>
  useQuery({
    queryKey: key('case', id),
    queryFn: () => api.get<CollectionCaseDetail>(`/collections/${id}`),
    enabled: Boolean(id),
  });
export const useCreateCase = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCollectionCaseInput) =>
      api.post<CollectionCaseDetail>('/collections', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateCase = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCollectionCaseInput & { id: string }) =>
      api.patch<CollectionCaseDetail>(`/collections/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAddActivity = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CollectionActivityInput & { id: string }) =>
      api.post<CollectionCaseDetail>(`/collections/${id}/activities`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useCaseCreditHold = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CreditHoldInput & { id: string }) =>
      api.post<CollectionCaseDetail>(`/collections/${id}/credit-hold`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRunSweep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (asOf?: string) =>
      api.post<Record<string, number>>('/collections/run-sweep', { asOf }),
    onSuccess: () => invalidateAll(qc),
  });
};
export const usePromises = (query: Partial<ListPromisesQuery>) =>
  useQuery({
    queryKey: key('promises', query),
    queryFn: () => api.get<PaginatedResult<PromiseToPay>>('/promises-to-pay', { query }),
    placeholderData: (p) => p,
  });
export const useCreatePromise = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePromiseInput) => api.post<PromiseToPay>('/promises-to-pay', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdatePromise = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePromiseInput & { id: string }) =>
      api.patch<PromiseToPay>(`/promises-to-pay/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ---------------------------------------------------------------- disputes

export const useDisputes = (query: Partial<ListDisputesQuery>) =>
  useQuery({
    queryKey: key('disputes', query),
    queryFn: () => api.get<PaginatedResult<Dispute>>('/disputes', { query }),
    placeholderData: (p) => p,
  });
export const useDispute = (id: string | null) =>
  useQuery({
    queryKey: key('dispute', id),
    queryFn: () => api.get<Dispute>(`/disputes/${id}`),
    enabled: Boolean(id),
  });
export const useCreateDispute = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDisputeInput) => api.post<Dispute>('/disputes', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateDispute = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateDisputeInput & { id: string }) =>
      api.patch<Dispute>(`/disputes/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// -------------------------------------------------------------- write-offs

export const useWriteOffs = (query: Partial<ListWriteOffsQuery>) =>
  useQuery({
    queryKey: key('write-offs', query),
    queryFn: () => api.get<PaginatedResult<WriteOff>>('/write-offs', { query }),
    placeholderData: (p) => p,
  });
export const useWriteOff = (id: string | null) =>
  useQuery({
    queryKey: key('write-off', id),
    queryFn: () => api.get<WriteOff>(`/write-offs/${id}`),
    enabled: Boolean(id),
  });
export const useCreateWriteOff = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWriteOffInput) => api.post<WriteOff>('/write-offs', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useWriteOffAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      ...body
    }: {
      id: string;
      action: 'submit' | 'approve' | 'reject' | 'post' | 'recover';
      comment?: string;
      writeOffDate?: string;
      recoveryDate?: string;
      reason?: string;
    }) => api.post<WriteOff>(`/write-offs/${id}/${action}`, body),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useProvisions = () =>
  useQuery({
    queryKey: key('provisions'),
    queryFn: () => api.get<BadDebtProvision[]>('/bad-debt-provisions'),
  });
export const useCreateProvision = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProvisionRunInput) =>
      api.post<BadDebtProvision>('/bad-debt-provisions', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useProvisionAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      ...body
    }: {
      id: string;
      action: 'post' | 'reverse';
      reversalDate?: string;
      reason?: string;
    }) => api.post<BadDebtProvision>(`/bad-debt-provisions/${id}/${action}`, body),
    onSuccess: () => invalidateAll(qc),
  });
};

// ----------------------------------------------------------------- reports

export const useArDashboard = (asOf?: string) =>
  useQuery({
    queryKey: key('dashboard', asOf),
    queryFn: () => api.get<ArDashboard>('/ar-dashboard', { query: { asOf } }),
  });
export const useArReconciliation = (asOf: string) =>
  useQuery({
    queryKey: key('reconciliation', asOf),
    queryFn: () => api.get<ArReconciliation>('/ar-reconciliation', { query: { asOf } }),
  });
export const useUnappliedCash = (asOf?: string) =>
  useQuery({
    queryKey: key('unapplied', asOf),
    queryFn: () => api.get<UnappliedCashReport>('/unapplied-cash', { query: { asOf } }),
  });
export const useGenerateStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (query: { customerId: string; from: string; to: string; save?: boolean }) =>
      api.get<GeneratedStatement>('/customer-statements', { query }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key('statements') }),
  });
};
export const useStatementHistory = (query: {
  customerId?: string;
  page?: number;
  pageSize?: number;
}) =>
  useQuery({
    queryKey: key('statements', query),
    queryFn: () =>
      api.get<PaginatedResult<StatementSnapshot>>('/customer-statements/history', { query }),
    placeholderData: (p) => p,
  });
