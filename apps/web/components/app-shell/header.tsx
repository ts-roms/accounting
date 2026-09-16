'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  Check,
  ChevronsUpDown,
  Keyboard,
  KeyRound,
  LogOut,
  Menu,
  Search,
} from 'lucide-react';
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Dialog,
  SheetContent,
  DialogTitle,
  Kbd,
  ThemeToggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@accounting/ui';
import { useSession } from '@/lib/auth/session';
import { findNavItem } from '@/lib/navigation';
import { initials } from '@/lib/format';
import { Sidebar, useSidebar } from './sidebar';
import { CommandMenu } from './command-menu';
import { NotificationsMenu } from './notifications-menu';
import { ChangePasswordDialog } from './change-password-dialog';
import { KeyboardShortcutsDialog, useGlobalShortcuts } from './shortcuts';

export function Header() {
  const pathname = usePathname();
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandMode, setCommandMode] = React.useState<'commands' | 'search'>('commands');
  const [mobileNav, setMobileNav] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);
  const { toggle } = useSidebar();
  const crumb = findNavItem(pathname);

  const openCommands = React.useCallback(() => {
    setCommandMode('commands');
    setCommandOpen((o) => !o);
  }, []);
  const openSearch = React.useCallback(() => {
    setCommandMode('search');
    setCommandOpen(true);
  }, []);
  const showShortcuts = React.useCallback(() => setShortcuts(true), []);
  useGlobalShortcuts({
    onCommandPalette: openCommands,
    onSearch: openSearch,
    onToggleSidebar: toggle,
    onShowShortcuts: showShortcuts,
  });

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setMobileNav(true)}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-60 p-0">
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <Sidebar variant="mobile" className="w-full border-r-0" />
        </SheetContent>
      </Dialog>

      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm md:flex">
        <Link
          href="/dashboard"
          className="text-muted-foreground transition-colors duration-fast hover:text-foreground"
        >
          Home
        </Link>
        {crumb ? (
          <>
            <Crumb>{crumb.section.title}</Crumb>
            {crumb.item.group ? <Crumb>{crumb.item.group}</Crumb> : null}
            <span className="text-subtle-foreground" aria-hidden>
              /
            </span>
            <span className="truncate font-medium" aria-current="page">
              {crumb.item.title}
            </span>
          </>
        ) : null}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="hidden w-60 justify-start font-normal text-muted-foreground md:inline-flex"
          onClick={openSearch}
          data-testid="global-search"
        >
          <Search />
          <span className="flex-1 text-left">Search invoices, journals, accounts...</span>
          <Kbd>Ctrl K</Kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          onClick={openSearch}
          aria-label="Search"
        >
          <Search />
        </Button>
        <CompanySwitcher />
        <NotificationsMenu />
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <ThemeToggle />
            </span>
          </TooltipTrigger>
          <TooltipContent>Theme</TooltipContent>
        </Tooltip>
        <UserMenu onShortcuts={showShortcuts} />
      </div>
      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} mode={commandMode} />
      <KeyboardShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </header>
  );
}

function Crumb({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="text-subtle-foreground" aria-hidden>
        /
      </span>
      <span className="truncate text-muted-foreground">{children}</span>
    </>
  );
}

function CompanySwitcher() {
  const { me, activeCompany, setActiveCompany } = useSession();
  if (me.companies.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-56 justify-between gap-2 font-normal"
          data-testid="company-switcher"
        >
          <Building2 className="text-muted-foreground" />
          <span className="truncate">
            {activeCompany ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">
                  {activeCompany.code}
                </span>{' '}
                <span className="hidden sm:inline">{activeCompany.name}</span>
              </>
            ) : (
              'Select company'
            )}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Active company</DropdownMenuLabel>
        {me.companies.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => setActiveCompany(c.id)}>
            <span className="w-4">{c.id === activeCompany?.id ? <Check /> : null}</span>
            <span className="flex-1 truncate">
              <span className="font-mono text-xs text-muted-foreground">{c.code}</span> {c.name}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{c.baseCurrency}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const { me, logout } = useSession();
  const router = useRouter();
  const [changePassword, setChangePassword] = React.useState(false);
  const { user } = me;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label="Account menu"
            data-testid="user-menu"
          >
            <Avatar>
              <AvatarFallback>{initials(user.firstName, user.lastName)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <div className="text-sm font-medium text-foreground">
              {user.firstName} {user.lastName}
            </div>
            <div className="truncate text-xs">{user.email}</div>
            <div className="mt-1 type-label">{me.roleKeys.join(', ') || 'No roles'}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push('/admin/audit-logs?userId=' + user.id)}>
            <Search /> My activity
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setChangePassword(true)}>
            <KeyRound /> Change password
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onShortcuts}>
            <Keyboard /> Keyboard shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void logout()}>
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={changePassword} onOpenChange={setChangePassword} />
    </>
  );
}
