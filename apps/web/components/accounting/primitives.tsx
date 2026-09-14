'use client';
import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { formatMoney } from '@accounting/money';
import type { AccountSubtype, AccountType, JournalStatus } from '@accounting/types';
import {
  Badge,
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@accounting/ui';
import { useAccounts } from '@/lib/api/accounting-hooks';
import type { AccountNode } from '@/lib/api/types';

/** Right-aligned tabular money cell. Zero renders muted; negatives in parentheses. */
export function Amount({
  value,
  currency,
  className,
  zeroAsDash = false,
}: {
  value: string;
  currency?: string;
  className?: string;
  zeroAsDash?: boolean;
}) {
  const zero = /^-?0(\.0+)?$/.test(value);
  return (
    <span className={cn('tabular block text-right', zero && 'text-muted-foreground', className)}>
      {zero && zeroAsDash ? '-' : formatMoney(value, currency)}
    </span>
  );
}

const STATUS_VARIANT: Record<
  JournalStatus,
  'secondary' | 'warning' | 'success' | 'destructive' | 'outline' | 'default'
> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  APPROVED: 'default',
  POSTED: 'success',
  LOCKED: 'success',
  REJECTED: 'destructive',
  REVERSED: 'outline',
};

export function JournalStatusBadge({ status }: { status: JournalStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

/** Searchable account picker (postable accounts by default). */
export function AccountCombobox({
  value,
  onChange,
  postableOnly = true,
  placeholder = 'Select account',
  className,
  disabled,
  excludeIds,
  types,
  subtypes,
}: {
  value: string | null | undefined;
  onChange: (accountId: string, account: AccountNode) => void;
  postableOnly?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  excludeIds?: string[];
  /** Restrict the options to these account types (e.g. revenue accounts on an invoice line). */
  types?: AccountType[];
  /** Further restrict to these subtypes (e.g. CASH / BANK for a payment). */
  subtypes?: AccountSubtype[];
}) {
  const [open, setOpen] = React.useState(false);
  const accounts = useAccounts({ status: 'ACTIVE' });
  const options = React.useMemo(
    () =>
      (accounts.data ?? []).filter(
        (a) =>
          (!postableOnly || !a.isHeader) &&
          !(excludeIds ?? []).includes(a.id) &&
          (!types || types.includes(a.type)) &&
          (!subtypes || (a.subtype !== null && subtypes.includes(a.subtype))),
      ),
    [accounts.data, postableOnly, excludeIds, types, subtypes],
  );
  const selected =
    options.find((a) => a.id === value) ?? accounts.data?.find((a) => a.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          data-testid="account-combobox"
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
                <span className="font-mono text-xs text-muted-foreground">{selected.code}</span>{' '}
                {selected.name}
              </>
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search by code or name..." />
          <CommandList>
            <CommandEmpty>No account found.</CommandEmpty>
            <CommandGroup>
              {options.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.code} ${a.name}`}
                  onSelect={() => {
                    onChange(a.id, a);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('h-4 w-4', value === a.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="w-14 font-mono text-xs text-muted-foreground">{a.code}</span>
                  <span className="truncate" style={{ paddingLeft: `${a.level * 8}px` }}>
                    {a.name}
                  </span>
                  <span className="ml-auto text-[10px] uppercase text-muted-foreground">
                    {a.type.replace('_', ' ')}
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

/** Two native date inputs bound to ISO strings. */
export function DateRange({
  from,
  to,
  onChange,
  labels = ['From', 'To'],
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  labels?: [string, string];
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{labels[0]}</Label>
        <Input
          type="date"
          value={from}
          onChange={(e) => onChange({ from: e.target.value, to })}
          className="w-40"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{labels[1]}</Label>
        <Input
          type="date"
          value={to}
          onChange={(e) => onChange({ from, to: e.target.value })}
          className="w-40"
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ dates

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfMonth(iso = today()): string {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso = today()): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function startOfYear(iso = today()): string {
  return `${iso.slice(0, 4)}-01-01`;
}
