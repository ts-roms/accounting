import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Landmark } from 'lucide-react';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[420px] flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Landmark className="h-5 w-5" />
          Enterprise Accounting
        </div>
        <div className="space-y-4">
          <p className="text-2xl font-semibold leading-snug">
            The general ledger is the single source of truth.
          </p>
          <p className="text-sm text-sidebar-muted">
            Double-entry accounting, immutable audit trail, fiscal-period controls and segregation
            of duties - built for finance teams that need to trust their numbers.
          </p>
        </div>
        <p className="text-xs text-sidebar-muted">Phase 1 - Foundation</p>
      </aside>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground">
              Use your organization account to continue.
            </p>
          </div>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
