'use client';
/* TanStack Query hooks for inventory: catalog, warehouses, stock documents, reports. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StockDocumentType } from '@accounting/types';
import type {
  CancelOrderInput,
  CreateAdjustmentInput,
  CreateCountInput,
  CreateLocationInput,
  CreateProductCategoryInput,
  CreateProductInput,
  CreateTransferInput,
  CreateWarehouseInput,
  InventorySettingsInput,
  ListProductsQuery,
  ListStockDocumentsQuery,
  StockCardQuery,
  StockOnHandQuery,
  UpdateProductCategoryInput,
  UpdateProductInput,
  UpdateStockDocumentInput,
  UpdateWarehouseInput,
} from '@accounting/validation';
import { api, getActiveCompanyId } from './client';
import type {
  InventorySettings,
  InventoryValuationReport,
  PaginatedResult,
  Product,
  ProductCategory,
  StockCardRow,
  StockDocument,
  StockDocumentDetail,
  StockOnHandReport,
  Warehouse,
  WarehouseLocation,
} from './types';

const company = () => getActiveCompanyId() ?? 'none';
const INV = 'inventory';
const key = (...rest: unknown[]) => [INV, company(), ...rest] as const;

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    INV,
    'AR',
    'AP',
    'orders',
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'balance-sheet',
  ]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

export const STOCK_DOCUMENT_API: Record<StockDocumentType, string> = {
  ADJUSTMENT: '/stock-adjustments',
  TRANSFER: '/stock-transfers',
  COUNT: '/stock-counts',
};

// ------------------------------------------------------------------ products

export const useProducts = (query: Partial<ListProductsQuery>, enabled = true) =>
  useQuery({
    queryKey: key('products', query),
    queryFn: () => api.get<PaginatedResult<Product>>('/products', { query }),
    placeholderData: (p) => p,
    enabled,
  });

export const useProduct = (id: string | null) =>
  useQuery({
    queryKey: key('product', id),
    queryFn: () => api.get<Product>(`/products/${id}`),
    enabled: Boolean(id),
  });

export const useCreateProduct = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProductInput) => api.post<Product>('/products', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateProduct = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateProductInput & { id: string }) =>
      api.patch<Product>(`/products/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useStockCard = (
  productId: string | null,
  query: Partial<Omit<StockCardQuery, 'productId'>>,
) =>
  useQuery({
    queryKey: key('stock-card', productId, query),
    queryFn: () =>
      api.get<PaginatedResult<StockCardRow>>(`/products/${productId}/stock-card`, { query }),
    enabled: Boolean(productId),
    placeholderData: (p) => p,
  });

export const useProductCategories = () =>
  useQuery({
    queryKey: key('categories'),
    queryFn: () => api.get<ProductCategory[]>('/product-categories'),
  });

export const useCreateCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProductCategoryInput) =>
      api.post<ProductCategory>('/product-categories', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateProductCategoryInput & { id: string }) =>
      api.patch<ProductCategory>(`/product-categories/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ---------------------------------------------------------------- warehouses

export const useWarehouses = () =>
  useQuery({ queryKey: key('warehouses'), queryFn: () => api.get<Warehouse[]>('/warehouses') });

export const useCreateWarehouse = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWarehouseInput) => api.post<Warehouse>('/warehouses', input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateWarehouse = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateWarehouseInput & { id: string }) =>
      api.patch<Warehouse>(`/warehouses/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useAddLocation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ warehouseId, ...input }: CreateLocationInput & { warehouseId: string }) =>
      api.post<WarehouseLocation>(`/warehouses/${warehouseId}/locations`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------ settings

export const useInventorySettings = () =>
  useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<InventorySettings>('/inventory/settings'),
  });

export const useUpdateInventorySettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InventorySettingsInput) =>
      api.put<InventorySettings>('/inventory/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ------------------------------------------------------------------- reports

export const useStockOnHand = (query: Partial<StockOnHandQuery>, enabled = true) =>
  useQuery({
    queryKey: key('stock-on-hand', query),
    queryFn: () => api.get<StockOnHandReport>('/inventory/stock-on-hand', { query }),
    placeholderData: (p) => p,
    enabled,
  });

export const useInventoryValuation = (asOf: string, enabled = true) =>
  useQuery({
    queryKey: key('valuation', asOf),
    queryFn: () => api.get<InventoryValuationReport>('/inventory/valuation', { query: { asOf } }),
    enabled,
  });

// ----------------------------------------------------------- stock documents

export const useStockDocuments = (
  type: StockDocumentType,
  query: Partial<ListStockDocumentsQuery>,
) =>
  useQuery({
    queryKey: key('stock-documents', type, query),
    queryFn: () => api.get<PaginatedResult<StockDocument>>(STOCK_DOCUMENT_API[type], { query }),
    placeholderData: (p) => p,
  });

export const useStockDocument = (type: StockDocumentType, id: string | null) =>
  useQuery({
    queryKey: key('stock-document', type, id),
    queryFn: () => api.get<StockDocumentDetail>(`${STOCK_DOCUMENT_API[type]}/${id}`),
    enabled: Boolean(id),
  });

export type CreateStockDocumentInput =
  CreateAdjustmentInput | CreateTransferInput | CreateCountInput;

export const useCreateStockDocument = (type: StockDocumentType) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStockDocumentInput) =>
      api.post<StockDocumentDetail>(STOCK_DOCUMENT_API[type], input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUpdateStockDocument = (type: StockDocumentType) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateStockDocumentInput & { id: string }) =>
      api.patch<StockDocumentDetail>(`${STOCK_DOCUMENT_API[type]}/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDeleteStockDocument = (type: StockDocumentType) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`${STOCK_DOCUMENT_API[type]}/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useStockDocumentAction = (type: StockDocumentType) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: 'post' | 'cancel';
      reason?: string;
    }) =>
      api.post<StockDocumentDetail>(
        `${STOCK_DOCUMENT_API[type]}/${id}/${action}`,
        action === 'cancel' ? ({ reason } satisfies Partial<CancelOrderInput>) : undefined,
      ),
    onSuccess: () => invalidateAll(qc),
  });
};
