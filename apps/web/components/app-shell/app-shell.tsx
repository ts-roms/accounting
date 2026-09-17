'use client';
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { PageTransition, cn } from '@accounting/ui';
import { useNavigationPending } from '@/lib/navigation/progress';
import { NavigationProgress } from './navigation-progress';
import { Sidebar, SidebarProvider } from './sidebar';
import { Header } from './header';

/**
 * Enterprise shell: top bar + collapsible sidebar + scrolling main region.
 * Page content enters with a 4px / 150ms fade so route changes read as a
 * state change rather than a reload.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // A route that takes longer than a beat to load dims the current page so the wait is visible.
  const pending = useNavigationPending();
  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded-sm focus:bg-popover focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-lg"
        >
          Skip to content
        </a>
        <Sidebar className="hidden lg:flex" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <React.Suspense fallback={null}>
            <NavigationProgress />
          </React.Suspense>
          <main
            id="main-content"
            className={cn(
              'flex-1 overflow-y-auto transition-opacity duration-normal',
              pending && 'pointer-events-none opacity-60',
            )}
            aria-busy={pending || undefined}
            tabIndex={-1}
          >
            <PageTransition
              routeKey={pathname}
              className="mx-auto w-full max-w-[1440px] space-y-5 p-4 md:p-6"
            >
              {children}
            </PageTransition>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
