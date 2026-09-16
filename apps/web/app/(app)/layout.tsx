import { Skeleton } from '@accounting/ui';
import { SessionProvider } from '@/lib/auth/session';
import { AppShell } from '@/components/app-shell/app-shell';

function ShellSkeleton() {
  return (
    <div className="flex min-h-screen" aria-busy aria-label="Loading application">
      <div className="hidden w-60 border-r bg-sidebar lg:block" />
      <div className="flex-1">
        <div className="h-14 border-b bg-surface" />
        <div className="space-y-4 p-6">
          <Skeleton className="h-6 w-48" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider fallback={<ShellSkeleton />}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
