import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Landmark } from 'lucide-react';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen">
      {/* Brand panel stays on the dark palette in both themes (scoped `dark`). */}
      <aside className="dark hidden w-[440px] flex-col justify-between border-r border-border bg-background p-10 text-foreground lg:flex">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="flex size-7 items-center justify-center rounded-sm bg-primary text-primary-foreground">
            <Landmark className="size-4" />
          </span>
          Enterprise Accounting
        </div>
        <div className="space-y-4 animate-enter-medium fade-in slide-in-up-2">
          <p className="type-display max-w-sm">The general ledger is the single source of truth.</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Double-entry accounting, immutable audit trail, fiscal-period controls and segregation
            of duties - built for finance teams that need to trust their numbers.
          </p>
        </div>
        <p className="type-label">Executive Finance</p>
      </aside>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6 animate-enter fade-in slide-in-up-1">
          <div className="space-y-1">
            <h1 className="type-h1">Sign in</h1>
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
