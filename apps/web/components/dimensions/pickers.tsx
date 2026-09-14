'use client';
import * as React from 'react';
import { Layers } from 'lucide-react';
import type { DimensionType, TaxKind, TaxSide } from '@accounting/types';
import {
  Badge,
  Button,
  Label,
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
import { useDimensions, useTaxCodes } from '@/lib/api/budgeting-tax-hooks';
import type { DimensionRefs, TaxCode } from '@/lib/api/types';

export const DIMENSION_LABEL: Record<DimensionType, string> = {
  DEPARTMENT: 'Department',
  COST_CENTER: 'Cost center',
  PROJECT: 'Project',
};

const NONE = '__none__';

export function DimensionSelect({
  type,
  value,
  onChange,
  className,
  disabled,
  placeholder,
  testId,
}: {
  type: DimensionType;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  const dims = useDimensions(type);
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue placeholder={placeholder ?? DIMENSION_LABEL[type]} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          {placeholder ?? `No ${DIMENSION_LABEL[type].toLowerCase()}`}
        </SelectItem>
        {dims.data
          ?.filter((d) => d.status === 'ACTIVE' || d.id === value)
          .map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.code} · {d.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/** Compact per-line editor for department / cost center / project; shows a count badge when set. */
export function DimensionsPopover({
  value,
  onChange,
  disabled,
  asOf,
}: {
  value: DimensionRefs;
  onChange: (next: DimensionRefs) => void;
  disabled?: boolean;
  /** Reserved for project date hints. */
  asOf?: string;
}) {
  const count = [value.departmentId, value.costCenterId, value.projectId].filter(Boolean).length;
  void asOf;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={count ? 'secondary' : 'ghost'}
          size="sm"
          disabled={disabled}
          aria-label="Dimensions"
          className={cn('gap-1 px-2', !count && 'text-muted-foreground')}
        >
          <Layers className="h-3.5 w-3.5" />
          {count ? (
            <Badge variant="outline" className="px-1 text-[10px]">
              {count}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="text-xs text-muted-foreground">
          Cost-accounting dimensions travel to the journal line for budget variance and dimensional
          reports.
        </p>
        {(['DEPARTMENT', 'COST_CENTER', 'PROJECT'] as const).map((type) => {
          const field =
            type === 'DEPARTMENT'
              ? 'departmentId'
              : type === 'COST_CENTER'
                ? 'costCenterId'
                : 'projectId';
          return (
            <div key={type} className="space-y-1">
              <Label className="text-xs">{DIMENSION_LABEL[type]}</Label>
              <DimensionSelect
                type={type}
                value={value[field]}
                onChange={(id) => onChange({ ...value, [field]: id })}
                disabled={disabled}
                className="h-8"
              />
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export function TaxCodeSelect({
  side,
  kind,
  value,
  onChange,
  className,
  disabled,
  testId,
}: {
  side: TaxSide;
  kind: TaxKind;
  value: string | null | undefined;
  onChange: (id: string | null, code: TaxCode | null) => void;
  className?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const codes = useTaxCodes(side);
  const options = (codes.data ?? []).filter((c) => c.kind === kind);
  if (!codes.isLoading && options.length === 0) return null;
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) =>
        onChange(v === NONE ? null : v, options.find((c) => c.id === v) ?? null)
      }
      disabled={disabled}
    >
      <SelectTrigger className={cn('h-8 text-xs', className)} data-testid={testId}>
        <SelectValue placeholder={kind === 'SALES_TAX' ? 'Tax' : 'Withholding'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{kind === 'SALES_TAX' ? 'No tax' : 'No withholding'}</SelectItem>
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.code}
            {c.currentRate !== null ? ` · ${Number(c.currentRate)}%` : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Client-side estimate of a line's tax from the code's current rate; the API is authoritative. */
export function estimateRate(codes: TaxCode[] | undefined, id: string | null | undefined): string {
  if (!id) return '0';
  return codes?.find((c) => c.id === id)?.currentRate ?? '0';
}
