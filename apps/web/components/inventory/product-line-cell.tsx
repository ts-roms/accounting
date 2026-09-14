'use client';
import * as React from 'react';
import { Input } from '@accounting/ui';
import { useProduct } from '@/lib/api/inventory-hooks';
import type { Product } from '@/lib/api/types';
import { parseSerials, ProductCombobox, WarehouseSelect } from './pickers';

/**
 * Product + warehouse (+ lot / serials) picker for one document or order line.
 * Picking a product fills description, price and account through `onPick`.
 */
export function ProductLineCell({
  side,
  productId,
  warehouseId,
  lotNumber,
  serialNumbers,
  onProduct,
  onWarehouse,
  onLot,
  onSerials,
  disabled,
}: {
  side: 'AR' | 'AP';
  productId: string | null | undefined;
  warehouseId: string | null | undefined;
  lotNumber?: string | null;
  serialNumbers?: string[] | null;
  onProduct: (id: string | null, product: Product | null) => void;
  onWarehouse: (id: string | null) => void;
  onLot?: (lot: string) => void;
  onSerials?: (serials: string[]) => void;
  disabled?: boolean;
}) {
  const product = useProduct(productId ?? null);
  const goods = product.data?.productType === 'GOODS';
  const tracking = product.data?.trackingMode ?? 'NONE';
  const [serialText, setSerialText] = React.useState((serialNumbers ?? []).join(', '));
  React.useEffect(() => {
    setSerialText((serialNumbers ?? []).join(', '));
  }, [serialNumbers]);
  return (
    <div className="space-y-1">
      <ProductCombobox
        value={productId}
        onChange={onProduct}
        disabled={disabled}
        placeholder={side === 'AR' ? 'Product (optional)' : 'Product (optional)'}
      />
      {goods ? (
        <WarehouseSelect
          value={warehouseId}
          onChange={onWarehouse}
          disabled={disabled}
          placeholder="Warehouse"
          className="h-8 text-xs"
        />
      ) : null}
      {goods && tracking === 'LOT' && onLot ? (
        <Input
          className="h-8 text-xs"
          placeholder="Lot number"
          value={lotNumber ?? ''}
          onChange={(e) => onLot(e.target.value)}
          disabled={disabled}
          aria-label="Lot number"
        />
      ) : null}
      {goods && tracking === 'SERIAL' && onSerials ? (
        <Input
          className="h-8 font-mono text-xs"
          placeholder="Serial numbers, comma separated"
          value={serialText}
          onChange={(e) => setSerialText(e.target.value)}
          onBlur={() => onSerials(parseSerials(serialText))}
          disabled={disabled}
          aria-label="Serial numbers"
        />
      ) : null}
    </div>
  );
}

/** Values a picked product contributes to a line. */
export function productDefaults(
  product: Product | null,
  side: 'AR' | 'AP',
): { description?: string; unitPrice?: string; accountId?: string | null } {
  if (!product) return {};
  const price = side === 'AR' ? product.salePrice : product.purchasePrice;
  return {
    description: product.name,
    unitPrice: price ? price.replace(/\.?0+$/, '') || '0' : undefined,
    accountId:
      side === 'AR'
        ? product.revenueAccountId
        : product.productType === 'GOODS'
          ? product.inventoryAccountId
          : product.expenseAccountId,
  };
}
