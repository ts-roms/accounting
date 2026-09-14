'use client';
/* TanStack Query hooks for sales & purchasing (orders, goods receipts, returns, settings, matching). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CancelOrderInput,
  ConvertOrderInput,
  CreateGoodsReceiptInput,
  CreateOrderInput,
  CreateReturnInput,
  CreditReturnInput,
  FulfilOrderInput,
  ListGoodsReceiptsQuery,
  ListOrdersQuery,
  ListReturnsQuery,
  MatchReviewInput,
  PurchasingSettingsInput,
  RejectOrderInput,
  UpdateGoodsReceiptInput,
  UpdateOrderInput,
  UpdateReturnInput,
} from '@accounting/validation';
import type { OrderConfig, OrderUiAction, ReturnsConfig } from '@/lib/orders/config';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { api, getActiveCompanyId } from './client';
import type {
  FulfilResult,
  GoodsReceipt,
  GoodsReceiptDetail,
  Order,
  OrderDetail,
  PaginatedResult,
  PurchasingSettings,
  ReturnDetail,
  ReturnDocument,
  SubledgerDocumentDetail,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';
const ORDERS = 'orders';
const key = (...rest: unknown[]) => [ORDERS, company(), ...rest] as const;

/** Orders feed the subledgers and vice versa; invalidate both plus ledger views. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    ORDERS,
    'AR',
    'AP',
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'balance-sheet',
  ]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

// -------------------------------------------------------------------- orders

export const useOrders = (cfg: OrderConfig, query: Partial<ListOrdersQuery>, enabled = true) =>
  useQuery({
    queryKey: key(cfg.type, 'list', query),
    queryFn: () => api.get<PaginatedResult<Order>>(cfg.api, { query }),
    placeholderData: (p) => p,
    enabled,
  });

export const useOrder = (cfg: OrderConfig, id: string | null) =>
  useQuery({
    queryKey: key(cfg.type, 'detail', id),
    queryFn: () => api.get<OrderDetail>(`${cfg.api}/${id}`),
    enabled: Boolean(id),
  });

export const useCreateOrder = (cfg: OrderConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrderInput) => api.post<OrderDetail>(cfg.api, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateOrder = (cfg: OrderConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateOrderInput & { id: string }) =>
      api.patch<OrderDetail>(`${cfg.api}/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDeleteOrder = (cfg: OrderConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`${cfg.api}/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useOrderAction = (cfg: OrderConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: OrderUiAction; reason?: string }) =>
      api.post<OrderDetail>(
        `${cfg.api}/${id}/${action}`,
        reason !== undefined
          ? ({ reason } satisfies RejectOrderInput | CancelOrderInput)
          : undefined,
      ),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useConvertOrder = (cfg: OrderConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ConvertOrderInput & { id: string }) =>
      api.post<OrderDetail>(`${cfg.api}/${id}/convert`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useFulfilOrder = (cfg: OrderConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: FulfilOrderInput & { id: string }) =>
      api.post<FulfilResult>(`${cfg.api}/${id}/fulfil`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------ goods receipts

const GR = '/goods-receipts';

export const useGoodsReceipts = (query: Partial<ListGoodsReceiptsQuery>, enabled = true) =>
  useQuery({
    queryKey: key('receipts', 'list', query),
    queryFn: () => api.get<PaginatedResult<GoodsReceipt>>(GR, { query }),
    placeholderData: (p) => p,
    enabled,
  });

export const useGoodsReceipt = (id: string | null) =>
  useQuery({
    queryKey: key('receipts', 'detail', id),
    queryFn: () => api.get<GoodsReceiptDetail>(`${GR}/${id}`),
    enabled: Boolean(id),
  });

export const useCreateGoodsReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGoodsReceiptInput) => api.post<GoodsReceiptDetail>(GR, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateGoodsReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateGoodsReceiptInput & { id: string }) =>
      api.patch<GoodsReceiptDetail>(`${GR}/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDeleteGoodsReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`${GR}/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useGoodsReceiptAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'confirm' | 'cancel';
      reason?: string;
    }) =>
      api.post<GoodsReceiptDetail>(
        `${GR}/${id}/${action}`,
        reason !== undefined ? { reason } : undefined,
      ),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------- returns

export const useReturns = (cfg: ReturnsConfig, query: Partial<ListReturnsQuery>, enabled = true) =>
  useQuery({
    queryKey: key('returns', cfg.type, 'list', query),
    queryFn: () => api.get<PaginatedResult<ReturnDocument>>(cfg.api, { query }),
    placeholderData: (p) => p,
    enabled,
  });

export const useReturn = (cfg: ReturnsConfig, id: string | null) =>
  useQuery({
    queryKey: key('returns', cfg.type, 'detail', id),
    queryFn: () => api.get<ReturnDetail>(`${cfg.api}/${id}`),
    enabled: Boolean(id),
  });

export const useCreateReturn = (cfg: ReturnsConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReturnInput) => api.post<ReturnDetail>(cfg.api, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateReturn = (cfg: ReturnsConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateReturnInput & { id: string }) =>
      api.patch<ReturnDetail>(`${cfg.api}/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDeleteReturn = (cfg: ReturnsConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`${cfg.api}/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useReturnAction = (cfg: ReturnsConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
      documentDate,
    }: {
      id: string;
      action: 'approve' | 'credit' | 'cancel';
      reason?: string;
      documentDate?: string;
    }) =>
      api.post<ReturnDetail>(
        `${cfg.api}/${id}/${action}`,
        action === 'cancel'
          ? { reason }
          : action === 'credit'
            ? ({ documentDate } satisfies CreditReturnInput)
            : undefined,
      ),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------ purchasing settings & match

export const usePurchasingSettings = (enabled = true) =>
  useQuery({
    queryKey: key('purchasing-settings'),
    queryFn: () => api.get<PurchasingSettings>('/purchasing/settings'),
    enabled,
  });

export const useUpdatePurchasingSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PurchasingSettingsInput) =>
      api.put<PurchasingSettings>('/purchasing/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useReviewMatch = (cfg: SubledgerConfig) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: MatchReviewInput & { id: string }) =>
      api.post<SubledgerDocumentDetail>(`${cfg.document.api}/${id}/match-review`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
