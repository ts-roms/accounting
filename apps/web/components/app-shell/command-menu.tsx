'use client';
import * as React from 'react';
import { useAppRouter } from '@/lib/navigation/progress';
import {
  BookOpenText,
  Building2,
  Cable,
  FileText,
  KeyRound,
  Loader2,
  LogOut,
  Moon,
  PanelLeft,
  Plus,
  Receipt,
  RefreshCw,
  Scale,
  ScrollText,
  ShieldCheck,
  Sun,
  UserCheck,
  Users,
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
  CommandShortcut,
  useTheme,
} from '@accounting/ui';
import { NAVIGATION } from '@/lib/navigation';
import { useSession } from '@/lib/auth/session';
import { useGlobalSearch } from '@/lib/api/search-hooks';
import { useSidebar } from './sidebar';

/**
 * Global command palette (Ctrl/Cmd+K) and record search (Ctrl+/).
 * Commands: create actions, navigation, integration platform, session.
 * Search: invoices, bills, journals, customers, vendors, accounts by number,
 * code or name - grouped by category.
 */
export function CommandMenu({
  open,
  onOpenChange,
  mode = 'commands',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'commands' | 'search';
}) {
  const router = useAppRouter();
  const { hasAnyPermission, hasPermission, logout, me, setActiveCompany } = useSession();
  const { setTheme, resolved } = useTheme();
  const sidebar = useSidebar();
  const [term, setTerm] = React.useState('');
  const search = useGlobalSearch(term, open);

  React.useEffect(() => {
    if (!open) setTerm('');
  }, [open]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const can = (...keys: Array<keyof typeof P>) => hasAnyPermission(...keys.map((k) => P[k]));

  const createActions = [
    {
      label: 'Create journal entry',
      href: '/accounting/journal-entries/new',
      icon: FileText,
      ok: hasPermission(P['journal.create']),
    },
    {
      label: 'Create invoice',
      href: '/sales/invoices/new',
      icon: Receipt,
      ok: hasPermission(P['invoice.create']),
    },
    {
      label: 'Create bill',
      href: '/purchasing/bills/new',
      icon: FileText,
      ok: hasPermission(P['bill.create']),
    },
    {
      label: 'Create customer',
      href: '/sales/customers?action=create',
      icon: Users,
      ok: hasPermission(P['customer.manage']),
    },
    {
      label: 'Create vendor',
      href: '/purchasing/vendors?action=create',
      icon: Building2,
      ok: hasPermission(P['vendor.manage']),
    },
    {
      label: 'Create delegation',
      href: '/admin/delegations?action=create',
      icon: ShieldCheck,
      ok: hasPermission(P['delegation.create']),
    },
  ].filter((a) => a.ok);

  const quickOpen = [
    {
      label: 'Open general ledger',
      href: '/accounting/general-ledger',
      icon: BookOpenText,
      ok: can('journal.view'),
    },
    {
      label: 'Open trial balance',
      href: '/accounting/trial-balance',
      icon: Scale,
      ok: can('reports.view'),
    },
    {
      label: 'Open integrations',
      href: '/admin/integrations',
      icon: Cable,
      ok: can('integration.view'),
    },
  ].filter((a) => a.ok);

  const searching = search.active;
  const placeholder =
    mode === 'search'
      ? 'Search invoice #, journal #, customer, vendor, account...'
      : 'Type a command, page or record number...';

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command menu">
      <CommandInput
        placeholder={placeholder}
        value={term}
        onValueChange={setTerm}
        autoFocus
        data-testid="command-input"
      />
      <CommandList>
        <CommandEmpty>
          {search.isFetching ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Searching…
            </span>
          ) : (
            'No results found.'
          )}
        </CommandEmpty>

        {searching && search.categories.length > 0 ? (
          <>
            {search.categories.map((cat) => (
              <CommandGroup key={cat.key} heading={cat.label}>
                {cat.hits.map((hit) => (
                  <CommandItem
                    key={hit.id}
                    value={`${cat.label} ${hit.title} ${hit.subtitle ?? ''}`}
                    onSelect={() => go(hit.href)}
                  >
                    <span className={hit.mono ? 'font-mono text-xs' : undefined}>{hit.title}</span>
                    {hit.subtitle ? (
                      <span className="ml-auto truncate pl-4 text-xs text-muted-foreground">
                        {hit.subtitle}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandSeparator />
          </>
        ) : null}

        {createActions.length ? (
          <CommandGroup heading="Create">
            {createActions.map((a) => (
              <CommandItem key={a.href} value={a.label} onSelect={() => go(a.href)}>
                <Plus /> {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {quickOpen.length ? (
          <CommandGroup heading="Open">
            {quickOpen.map((a) => (
              <CommandItem key={a.href} value={a.label} onSelect={() => go(a.href)}>
                <a.icon /> {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {NAVIGATION.map((section) => {
          const items = section.items.filter((i) => hasAnyPermission(...(i.permissions ?? [])));
          if (items.length === 0) return null;
          return (
            <CommandGroup key={section.title} heading={section.title}>
              {items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`${section.title} ${item.group ?? ''} ${item.title}`}
                  onSelect={() => go(item.href)}
                >
                  {item.icon ? <item.icon /> : null}
                  {item.group ? (
                    <span className="text-muted-foreground">{item.group} /</span>
                  ) : null}
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

        {can('integration.manage', 'api-key.manage', 'delegation.create', 'delegation.view') ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Integration platform">
              {can('integration.manage') ? (
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
              {can('integration.view') ? (
                <CommandItem
                  value="view integration logs"
                  onSelect={() => go('/admin/integration-logs')}
                >
                  <ScrollText /> View integration logs
                </CommandItem>
              ) : null}
              {can('api-key.manage') ? (
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
              {can('webhook.manage') ? (
                <CommandItem
                  value="create webhook subscription"
                  onSelect={() => go('/admin/webhooks?action=create')}
                >
                  <Webhook /> Create webhook
                </CommandItem>
              ) : null}
              {can('delegation.view') ? (
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
        <CommandGroup heading="Preferences">
          <CommandItem
            value="toggle theme dark light"
            onSelect={() => {
              setTheme(resolved === 'dark' ? 'light' : 'dark');
              onOpenChange(false);
            }}
          >
            {resolved === 'dark' ? <Sun /> : <Moon />}
            Switch to {resolved === 'dark' ? 'light' : 'dark'} theme
          </CommandItem>
          <CommandItem
            value="toggle sidebar collapse expand"
            onSelect={() => {
              sidebar.toggle();
              onOpenChange(false);
            }}
          >
            <PanelLeft /> {sidebar.collapsed ? 'Expand' : 'Collapse'} sidebar
            <CommandShortcut>Ctrl B</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Session">
          <CommandItem value="sign out logout" onSelect={() => void logout()}>
            <LogOut /> Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
