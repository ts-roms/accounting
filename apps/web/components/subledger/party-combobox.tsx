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
  cn,
} from '@accounting/ui';
import { useParties, useParty } from '@/lib/api/subledger-hooks';
import type { Party } from '@/lib/api/types';
import type { SubledgerConfig } from '@/lib/subledger/config';

/** Searchable customer / vendor picker (active parties only). */
export function PartyCombobox({
  cfg,
  value,
  onChange,
  disabled,
  className,
}: {
  cfg: SubledgerConfig;
  value: string | null | undefined;
  onChange: (id: string, party: Party) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const parties = useParties(cfg, {
    status: 'ACTIVE',
    search: search || undefined,
    pageSize: 50,
    sortBy: 'name',
    sortDir: 'asc',
  });
  // Filter client-side too so the visible list matches the typed text before the server responds.
  const needle = search.trim().toLowerCase();
  const options = (parties.data?.items ?? []).filter(
    (p) =>
      !needle || p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
  );
  const current = useParty(cfg, value ?? null);
  const selected = options.find((p) => p.id === value) ?? current.data;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          data-testid="party-combobox"
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
              `Select ${cfg.party.singular.toLowerCase()}`
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by code or name..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {parties.isLoading ? 'Loading…' : `No ${cfg.party.singular.toLowerCase()} found.`}
            </CommandEmpty>
            <CommandGroup>
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
                  <span className="w-20 font-mono text-xs text-muted-foreground">{p.code}</span>
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {p.paymentTermsDays}d
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
