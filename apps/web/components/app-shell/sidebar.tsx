'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Landmark, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@accounting/ui';
import { NAVIGATION, groupItems, type NavItem, type NavSection } from '@/lib/navigation';
import { useSession } from '@/lib/auth/session';

// ------------------------------------------------------------------- state
const STORAGE_KEY = 'accounting.sidebar';

interface SidebarState {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
}
const SidebarContext = React.createContext<SidebarState | null>(null);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsedState] = React.useState(false);
  React.useEffect(() => {
    try {
      setCollapsedState(localStorage.getItem(STORAGE_KEY) === 'collapsed');
    } catch {
      /* ignore */
    }
  }, []);
  const setCollapsed = React.useCallback((v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? 'collapsed' : 'expanded');
    } catch {
      /* ignore */
    }
  }, []);
  const toggle = React.useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);
  const value = React.useMemo(
    () => ({ collapsed, setCollapsed, toggle }),
    [collapsed, setCollapsed, toggle],
  );
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within <SidebarProvider>');
  return ctx;
}

// ----------------------------------------------------------------- sidebar
function useVisibleSections(): NavSection[] {
  const { hasAnyPermission } = useSession();
  return React.useMemo(
    () =>
      NAVIGATION.map((section) => ({
        ...section,
        items: section.items.filter((item) => hasAnyPermission(...(item.permissions ?? []))),
      })).filter((s) => s.items.length > 0),
    [hasAnyPermission],
  );
}

const isActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * Application sidebar. Expanded: grouped navigation tree. Collapsed (56px):
 * one icon per section that opens its items in a menu. Width animates over
 * --motion-medium; labels fade rather than reflow.
 */
export function Sidebar({
  className,
  variant = 'desktop',
}: {
  className?: string;
  /** `mobile` renders inside the navigation sheet: always expanded, no collapse control. */
  variant?: 'desktop' | 'mobile';
}) {
  const pathname = usePathname();
  const { me } = useSession();
  const sections = useVisibleSections();
  const sidebar = useSidebar();
  const collapsed = variant === 'desktop' && sidebar.collapsed;
  const navRef = React.useRef<HTMLElement>(null);

  // Arrow keys move focus between links so keyboard users can scan the menu.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? [],
    );
    const idx = links.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;
    e.preventDefault();
    const next = links[(idx + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length];
    next?.focus();
  };

  return (
    <aside
      data-collapsed={collapsed || undefined}
      data-testid="sidebar"
      className={cn(
        'group/sidebar flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-medium ease-out',
        collapsed ? 'w-14' : 'w-60',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border',
          collapsed ? 'justify-center px-0' : 'pl-4 pr-2',
        )}
      >
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground"
          aria-hidden
        >
          <Landmark className="size-4" />
        </span>
        {!collapsed ? (
          <div className="min-w-0 flex-1 animate-enter-fast fade-in">
            <div className="truncate text-sm font-semibold leading-tight">
              {me.organization.name}
            </div>
            <div className="truncate text-[11px] text-sidebar-muted">Enterprise Accounting</div>
          </div>
        ) : null}
        {variant === 'desktop' && !collapsed ? <CollapseToggle collapsed={false} /> : null}
      </div>
      {variant === 'desktop' && collapsed ? (
        <div className="flex justify-center border-b border-sidebar-border py-1.5">
          <CollapseToggle collapsed />
        </div>
      ) : null}

      <nav
        ref={navRef}
        aria-label="Main navigation"
        onKeyDown={onKeyDown}
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden py-3 text-sm',
          collapsed ? 'px-2' : 'px-2',
        )}
      >
        {sections.map((section) =>
          collapsed ? (
            <CollapsedSection key={section.title} section={section} pathname={pathname} />
          ) : (
            <SidebarSection key={section.title} section={section} pathname={pathname} />
          ),
        )}
      </nav>
    </aside>
  );
}

function CollapseToggle({ collapsed }: { collapsed: boolean }) {
  const sidebar = useSidebar();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={sidebar.toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
          className="text-sidebar-muted hover:text-sidebar-foreground"
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {collapsed ? 'Expand' : 'Collapse'} sidebar
        <span className="ml-2 font-mono text-[10px] text-muted-foreground">Ctrl B</span>
      </TooltipContent>
    </Tooltip>
  );
}

// --------------------------------------------------------- expanded section
function SidebarSection({ section, pathname }: { section: NavSection; pathname: string }) {
  const active = section.items.some((i) => isActive(pathname, i.href));
  const [open, setOpen] = React.useState(active || section.title === 'Overview');
  React.useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  if (section.items.length === 1 && section.title === 'Overview') {
    const item = section.items[0]!;
    return (
      <div className="mb-2">
        <NavLink item={item} active={isActive(pathname, item.href)} />
      </div>
    );
  }

  const id = `nav-${section.title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 type-label text-sidebar-muted transition-colors duration-fast hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={id}
      >
        <span className="flex items-center gap-2">
          <section.icon className="size-3.5" aria-hidden />
          {section.title}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform duration-normal ease-out',
            open ? 'rotate-0' : '-rotate-90',
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={id} className="mt-0.5 space-y-0.5 animate-enter-fast fade-in">
          {groupItems(section.items).map((g, gi) => (
            <div key={g.group ?? gi} className={cn(g.group && gi > 0 && 'mt-1.5')}>
              {g.group ? (
                <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-sidebar-muted/80">
                  {g.group}
                </div>
              ) : null}
              {g.items.map((item) => (
                <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      {Icon ? (
        <Icon
          className={cn('size-4 shrink-0', active ? 'text-primary' : 'opacity-70')}
          aria-hidden
        />
      ) : null}
      <span className="flex-1 truncate">{item.title}</span>
      {item.phase ? (
        <span className="rounded-xs bg-sidebar-border px-1 text-[10px] text-sidebar-muted">
          P{item.phase}
        </span>
      ) : null}
    </Link>
  );
}

// -------------------------------------------------------- collapsed section
function CollapsedSection({ section, pathname }: { section: NavSection; pathname: string }) {
  const active = section.items.some((i) => isActive(pathname, i.href));
  const Icon = section.icon;
  const single = section.items.length === 1;

  const trigger = (
    <span
      className={cn(
        'relative flex size-9 items-center justify-center rounded-sm transition-colors duration-fast',
        active
          ? 'bg-sidebar-accent text-primary before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );

  if (single) {
    const item = section.items[0]!;
    return (
      <div className="mb-1 flex justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={item.href}
              aria-label={item.title}
              aria-current={active ? 'page' : undefined}
              className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {trigger}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">{item.title}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="mb-1 flex justify-center">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={section.title}
                className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {trigger}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{section.title}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-56">
          <DropdownMenuLabel>{section.title}</DropdownMenuLabel>
          {groupItems(section.items).map((g, gi) => (
            <React.Fragment key={g.group ?? gi}>
              {gi > 0 ? <DropdownMenuSeparator /> : null}
              {g.group ? (
                <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {g.group}
                </div>
              ) : null}
              {g.items.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link
                    href={item.href}
                    aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                    className={cn(isActive(pathname, item.href) && 'bg-accent font-medium')}
                  >
                    {item.icon ? <item.icon /> : null}
                    {item.title}
                  </Link>
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
