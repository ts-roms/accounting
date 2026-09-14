'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Landmark } from 'lucide-react';
import { cn } from '@accounting/ui';
import { NAVIGATION, type NavSection } from '@/lib/navigation';
import { useSession } from '@/lib/auth/session';

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const { hasAnyPermission, me } = useSession();

  const sections = React.useMemo(
    () =>
      NAVIGATION.map((section) => ({
        ...section,
        items: section.items.filter((item) => hasAnyPermission(...(item.permissions ?? []))),
      })).filter((s) => s.items.length > 0),
    [hasAnyPermission],
  );

  return (
    <aside
      className={cn(
        'flex h-full w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        className,
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <Landmark className="h-5 w-5" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">{me.organization.name}</div>
          <div className="truncate text-[11px] text-sidebar-muted">Enterprise Accounting</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3 text-sm">
        {sections.map((section) => (
          <SidebarSection key={section.title} section={section} pathname={pathname} />
        ))}
      </nav>
    </aside>
  );
}

function SidebarSection({ section, pathname }: { section: NavSection; pathname: string }) {
  const active = section.items.some((i) => pathname.startsWith(i.href));
  const [open, setOpen] = React.useState(active || section.title === 'Overview');
  React.useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  const single = section.items.length === 1 && section.title === 'Overview';
  if (single) {
    const item = section.items[0]!;
    return (
      <div className="mb-2">
        <NavLink
          href={item.href}
          active={pathname.startsWith(item.href)}
          icon={item.icon}
          label={item.title}
        />
      </div>
    );
  }

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted hover:text-sidebar-foreground"
        aria-expanded={open}
      >
        {section.title}
        <ChevronDown
          className={cn('h-3.5 w-3.5 transition-transform', open ? 'rotate-0' : '-rotate-90')}
        />
      </button>
      {open ? (
        <div className="mt-0.5 space-y-0.5">
          {section.items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
              icon={item.icon}
              label={item.title}
              phase={item.phase}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NavLink({
  href,
  active,
  icon: Icon,
  label,
  phase,
}: {
  href: string;
  active: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  phase?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0 opacity-80" /> : null}
      <span className="flex-1 truncate">{label}</span>
      {phase ? (
        <span className="rounded bg-sidebar-border px-1 text-[10px] text-sidebar-muted">
          P{phase}
        </span>
      ) : null}
    </Link>
  );
}
