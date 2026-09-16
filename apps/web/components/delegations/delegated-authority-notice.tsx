'use client';
import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { formatMoney } from '@accounting/money';
import type { PermissionKey } from '@accounting/types';
import { cn } from '@accounting/ui';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';

/**
 * Delegation banner: shown wherever the acting user holds the required
 * permission only through a delegation. It uses the informational (blue)
 * treatment so delegated actions never look like the user's own authority,
 * and switches to critical when the document exceeds the delegated limit.
 * Never hidden in metadata: the person must know they act for someone else.
 */
export function DelegatedAuthorityNotice({
  permission,
  amount,
  currency,
  className,
}: {
  permission: PermissionKey;
  /** Document amount, to warn ahead of time when it exceeds the delegated limit. */
  amount?: string | null;
  currency?: string | null;
  className?: string;
}) {
  const { delegationFor } = useSession();
  const grant = delegationFor(permission);
  if (!grant) return null;
  const overLimit =
    grant.maxAmount !== null && amount ? Number(amount) > Number(grant.maxAmount) : false;
  const cur = grant.currency ?? currency ?? 'PHP';
  const Icon = overLimit ? TriangleAlert : ShieldCheck;
  return (
    <section
      role={overLimit ? 'alert' : 'status'}
      aria-label="Acting under delegated authority"
      data-testid="delegated-authority-notice"
      data-over-limit={overLimit || undefined}
      className={cn(
        'rounded-md border-l-4 border bg-info/5 px-4 py-3 text-sm',
        overLimit
          ? 'border-critical/40 border-l-critical bg-critical/5'
          : 'border-info/30 border-l-info',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-sm',
            overLimit ? 'bg-critical/10 text-critical' : 'bg-info/10 text-info',
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="type-label mb-1 text-foreground">Acting under delegated authority</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 sm:grid-cols-[auto_1fr_auto_1fr]">
            <dt className="text-muted-foreground">Delegated from</dt>
            <dd className="font-medium">{grant.delegatorName}</dd>
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="font-mono text-xs leading-5">{permission}</dd>
            <dt className="text-muted-foreground">Approval limit</dt>
            <dd className="tabular">
              {grant.maxAmount
                ? `${cur} ${formatMoney(grant.maxAmount, cur)}`
                : 'Same as the delegator'}
            </dd>
            <dt className="text-muted-foreground">Valid until</dt>
            <dd>{formatDateTime(grant.endAt)}</dd>
          </dl>
          {overLimit ? (
            <p className="mt-2 font-medium text-critical">
              This document exceeds your delegated limit - the approval will be refused.
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Recorded under{' '}
            <Link
              href="/admin/delegations"
              className="font-mono underline-offset-2 hover:underline"
            >
              {grant.delegationNumber}
            </Link>{' '}
            with {grant.delegatorName} as the original authority and you as the acting user.
          </p>
        </div>
      </div>
    </section>
  );
}

/** Design-system name for the same component. */
export const DelegationBanner = DelegatedAuthorityNotice;
