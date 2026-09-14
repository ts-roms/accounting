import { Skeleton } from '@accounting/ui';
import { SessionProvider } from '@/lib/auth/session';
import { Sidebar } from '@/components/app-shell/sidebar';
import { Header } from '@/components/app-shell/header';

function ShellSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-60 border-r bg-sidebar lg:block" />
      <div className="flex-1">
        <div className="h-14 border-b" />
        <div className="space-y-4 p-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider fallback={<ShellSkeleton />}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar className="hidden lg:flex" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">{children}</div>
          </main>
        </div>
      </div>
    </SessionProvider>
  );
}
