'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@accounting/ui';
import { NAVIGATION } from '@/lib/navigation';
import { useSession } from '@/lib/auth/session';

/**
 * Global command palette (Ctrl/Cmd+K). Phase 1 offers navigation and session
 * actions; global record search (customers, invoices, journals...) plugs in
 * here as those modules ship.
 */
export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { hasAnyPermission, logout, me, setActiveCompany } = useSession();

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command menu">
      <CommandInput placeholder="Type a page name or command..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {NAVIGATION.map((section) => {
          const items = section.items.filter((i) => hasAnyPermission(...(i.permissions ?? [])));
          if (items.length === 0) return null;
          return (
            <CommandGroup key={section.title} heading={section.title}>
              {items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`${section.title} ${item.title}`}
                  onSelect={() => go(item.href)}
                >
                  {item.icon ? <item.icon /> : null}
                  {item.title}
                  {item.phase ? (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Phase {item.phase}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
        {me.companies.length > 1 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch company">
              {me.companies.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`company ${c.code} ${c.name}`}
                  onSelect={() => {
                    setActiveCompany(c.id);
                    onOpenChange(false);
                  }}
                >
                  <span className="font-mono text-xs text-muted-foreground">{c.code}</span> {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
        <CommandSeparator />
        <CommandGroup heading="Session">
          <CommandItem value="sign out logout" onSelect={() => void logout()}>
            <LogOut /> Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
