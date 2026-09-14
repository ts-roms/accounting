'use client';
import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { formatMoney } from '@accounting/money';
import type { PermissionKey } from '@accounting/types';
import { Alert, AlertDescription, AlertTitle } from '@accounting/ui';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';

/**
 * Highly visible banner shown on approval screens when the acting user holds
 * the required permission only through a delegation. Never hidden in
 * metadata: the person must know they are acting for someone else.
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
  return (
    <Alert
      variant={overLimit ? 'destructive' : 'warning'}
      className={className}
      data-testid="delegated-authority-notice"
    >
      <ShieldCheck />
      <AlertTitle>You are acting under delegated authority</AlertTitle>
      <AlertDescription>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
          <dt className="text-muted-foreground">Delegated from</dt>
          <dd className="font-medium">{grant.delegatorName}</dd>
          <dt className="text-muted-foreground">Delegation</dt>
          <dd>
            <Link
              href="/admin/delegations"
              className="font-mono underline-offset-2 hover:underline"
            >
              {grant.delegationNumber}
            </Link>
          </dd>
          <dt className="text-muted-foreground">Valid until</dt>
          <dd>{formatDateTime(grant.endAt)}</dd>
          <dt className="text-muted-foreground">Approval limit</dt>
          <dd>
            {grant.maxAmount
              ? `${grant.currency ?? currency ?? ''} ${formatMoney(grant.maxAmount, grant.currency ?? currency ?? 'PHP')}`
              : 'Same as the delegator'}
            {overLimit ? (
              <span className="ml-2 font-medium text-destructive">
                - this document exceeds your delegated limit
              </span>
            ) : null}
          </dd>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Every action you take with this authority is recorded against {grant.delegatorName} as the
          original authority and you as the acting user.
        </p>
      </AlertDescription>
    </Alert>
  );
}
