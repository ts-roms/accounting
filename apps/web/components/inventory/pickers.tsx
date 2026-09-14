'use client';
import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@accounting/ui';
import { useProduct, useProducts, useWarehouses } from '@/lib/api/inventory-hooks';
import type { Product } from '@/lib/api/types';

/** Searchable product picker (active products; optionally goods only). Clearable. */
export function ProductCombobox({
  value,
  onChange,
  goodsOnly = false,
  disabled,
  className,
  placeholder = 'No product',
}: {
  value: string | null | undefined;
  onChange: (id: string | null, product: Product | null) => void;
  goodsOnly?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const products = useProducts({
    status: 'ACTIVE',
    search: search || undefined,
    pageSize: 50,
    sortBy: 'sku',
    sortDir: 'asc',
    productType: goodsOnly ? 'GOODS' : undefined,
  });
  // Filter client-side too so the visible list matches the typed text before the server responds.
  const needle = search.trim().toLowerCase();
  const options = (products.data?.items ?? []).filter(
    (p) => !needle || p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
  );
  const current = useProduct(value ?? null);
  const selected = options.find((p) => p.id === value) ?? current.data;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          data-testid="product-combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">
            {selected ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{selected.sku}</span>{' '}
                {selected.name}
              </>
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[440px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by SKU or name..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{products.isLoading ? 'Loading…' : 'No product found.'}</CommandEmpty>
            <CommandGroup>
              {value ? (
                <CommandItem
                  value="__none__"
                  onSelect={() => {
                    onChange(null, null);
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">Clear product</span>
                </CommandItem>
              ) : null}
              {options.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onChange(p.id, p);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('h-4 w-4', value === p.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="w-24 font-mono text-xs text-muted-foreground">{p.sku}</span>
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-[10px] uppercase text-muted-foreground">
                    {p.productType === 'SERVICE'
                      ? 'service'
                      : `${p.quantityOnHand.replace(/\.?0+$/, '')} ${p.unitOfMeasure}`}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Warehouse select (active warehouses). */
export function WarehouseSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Warehouse',
  className,
  allowNone = false,
  excludeId,
}: {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  allowNone?: boolean;
  excludeId?: string | null;
}) {
  const warehouses = useWarehouses();
  const options = (warehouses.data ?? []).filter(
    (w) => w.status === 'ACTIVE' && w.id !== excludeId,
  );
  return (
    <Select
      value={value ?? (allowNone ? '__none__' : '')}
      onValueChange={(v) => onChange(v === '__none__' ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className={className} data-testid="warehouse-select">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone ? <SelectItem value="__none__">All warehouses</SelectItem> : null}
        {options.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            <span className="font-mono text-xs text-muted-foreground">{w.code}</span> {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Comma / newline separated serial numbers -> array. */
export function parseSerials(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
