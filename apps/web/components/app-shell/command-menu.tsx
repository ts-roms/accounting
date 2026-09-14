'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Cable,
  KeyRound,
  LogOut,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserCheck,
  Webhook,
  Zap,
} from 'lucide-react';
import { P } from '@accounting/types';
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
        {hasAnyPermission(
          P['integration.manage'],
          P['api-key.manage'],
          P['delegation.create'],
          P['delegation.view'],
        ) ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Integration platform">
              {hasAnyPermission(P['integration.manage']) ? (
                <>
                  <CommandItem
                    value="connect integration provider"
                    onSelect={() => go('/admin/integrations?tab=available')}
                  >
                    <Cable /> Connect integration
                  </CommandItem>
                  <CommandItem
                    value="test integration connection"
                    onSelect={() => go('/admin/integrations?filter=attention')}
                  >
                    <Zap /> Test integration
                  </CommandItem>
                  <CommandItem
                    value="sync integration now"
                    onSelect={() => go('/admin/integrations?filter=connected')}
                  >
                    <RefreshCw /> Sync integration
                  </CommandItem>
                </>
              ) : null}
              {hasAnyPermission(P['integration.view']) ? (
                <CommandItem
                  value="view integration logs"
                  onSelect={() => go('/admin/integration-logs')}
                >
                  <ScrollText /> View integration logs
                </CommandItem>
              ) : null}
              {hasAnyPermission(P['api-key.manage']) ? (
                <>
                  <CommandItem
                    value="create api key"
                    onSelect={() => go('/admin/api-keys?action=create')}
                  >
                    <KeyRound /> Create API key
                  </CommandItem>
                  <CommandItem value="rotate api key" onSelect={() => go('/admin/api-keys')}>
                    <KeyRound /> Rotate API key
                  </CommandItem>
                </>
              ) : null}
              {hasAnyPermission(P['webhook.manage']) ? (
                <CommandItem
                  value="create webhook subscription"
                  onSelect={() => go('/admin/webhooks?action=create')}
                >
                  <Webhook /> Create webhook
                </CommandItem>
              ) : null}
              {hasAnyPermission(P['delegation.create']) ? (
                <CommandItem
                  value="create delegation delegate authority"
                  onSelect={() => go('/admin/delegations?action=create')}
                >
                  <ShieldCheck /> Create delegation
                </CommandItem>
              ) : null}
              {hasAnyPermission(P['delegation.view']) ? (
                <>
                  <CommandItem
                    value="view active delegations"
                    onSelect={() => go('/admin/delegations?section=active')}
                  >
                    <UserCheck /> View active delegations
                  </CommandItem>
                  <CommandItem
                    value="revoke delegation"
                    onSelect={() => go('/admin/delegations?section=created')}
                  >
                    <UserCheck /> Revoke delegation
                  </CommandItem>
                </>
              ) : null}
            </CommandGroup>
          </>
        ) : null}
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
