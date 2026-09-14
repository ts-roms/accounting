'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Building2, Check, ChevronsUpDown, KeyRound, LogOut, Menu, Search } from 'lucide-react';
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  SheetContent,
  DialogTitle,
} from '@accounting/ui';
import { useSession } from '@/lib/auth/session';
import { findNavItem } from '@/lib/navigation';
import { initials } from '@/lib/format';
import { Sidebar } from './sidebar';
import { CommandMenu } from './command-menu';
import { ChangePasswordDialog } from './change-password-dialog';

export function Header() {
  const pathname = usePathname();
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [mobileNav, setMobileNav] = React.useState(false);
  const crumb = findNavItem(pathname);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="flex h-14 items-center gap-3 border-b bg-background px-4">
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
        <SheetContent className="left-0 right-auto w-60 border-l-0 border-r p-0">
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <Sidebar className="w-full border-r-0" />
        </SheetContent>
      </Dialog>

      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm md:flex">
        <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
          Home
        </Link>
        {crumb ? (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">{crumb.section.title}</span>
            <span className="text-muted-foreground">/</span>
            <span className="truncate font-medium">{crumb.item.title}</span>
          </>
        ) : null}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="hidden w-56 justify-start text-muted-foreground md:inline-flex"
          onClick={() => setCommandOpen(true)}
        >
          <Search />
          <span className="flex-1 text-left">Search or jump to...</span>
          <kbd className="pointer-events-none rounded border bg-muted px-1.5 font-mono text-[10px]">
            Ctrl K
          </kbd>
        </Button>
        <CompanySwitcher />
        <UserMenu />
      </div>
      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </header>
  );
}

function CompanySwitcher() {
  const { me, activeCompany, setActiveCompany } = useSession();
  if (me.companies.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-56 justify-between gap-2">
          <Building2 className="text-muted-foreground" />
          <span className="truncate">
            {activeCompany ? `${activeCompany.code} - ${activeCompany.name}` : 'Select company'}
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
            <span className="text-xs text-muted-foreground">{c.baseCurrency}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { me, logout } = useSession();
  const router = useRouter();
  const [changePassword, setChangePassword] = React.useState(false);
  const { user } = me;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
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
            <div className="mt-1 text-[11px] uppercase tracking-wide">
              {me.roleKeys.join(', ') || 'No roles'}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push('/admin/audit-logs?userId=' + user.id)}>
            <Search /> My activity
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setChangePassword(true)}>
            <KeyRound /> Change password
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
