'use client';
import * as React from 'react';
import { Sparkles } from 'lucide-react';
import type { AiDocumentStatus, AiSeverity, AiSuggestionStatus } from '@accounting/types';
import { StatusBadge } from '@accounting/ui';
import { useAiStatus } from '@/lib/api/ai-hooks';
import { titleCase } from '@/lib/format';
import { toneOf } from '@/components/status';

const DOC_VARIANT: Record<AiDocumentStatus, 'success' | 'warning' | 'secondary' | 'outline'> = {
  EXTRACTED: 'success',
  NEEDS_REVIEW: 'warning',
  DRAFTED: 'secondary',
  DISMISSED: 'outline',
};

export function DocStatusBadge({ status }: { status: AiDocumentStatus }) {
  return <StatusBadge tone={toneOf(DOC_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

const SEVERITY_VARIANT: Record<AiSeverity, 'destructive' | 'warning' | 'secondary'> = {
  HIGH: 'destructive',
  MEDIUM: 'warning',
  LOW: 'secondary',
};

export function SeverityBadge({ severity }: { severity: AiSeverity }) {
  return <StatusBadge tone={toneOf(SEVERITY_VARIANT[severity])}>{titleCase(severity)}</StatusBadge>;
}

export function FlagStatusBadge({ status }: { status: AiSuggestionStatus }) {
  return (
    <StatusBadge
      tone={toneOf(status === 'OPEN' ? 'warning' : status === 'ACCEPTED' ? 'success' : 'outline')}
    >
      {titleCase(status)}
    </StatusBadge>
  );
}

/** Reminder that the module is advisory, plus the active backend. */
export function AdvisoryNote() {
  const status = useAiStatus();
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="ai-advisory">
      <Sparkles className="h-3.5 w-3.5" />
      Advisory only - the assistant drafts, suggests and flags; people approve and post.
      {status.data ? (
        <span>
          Backend:{' '}
          {status.data.provider === 'ANTHROPIC'
            ? `Claude (${status.data.model})`
            : 'built-in heuristics'}
          .
        </span>
      ) : null}
    </p>
  );
}

export function ConfidenceMeter({ value }: { value: string | number }) {
  const pct = Math.round(Number(value) * 100);
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className="h-1.5 w-16 overflow-hidden rounded bg-muted">
        <span
          className={`block h-full ${pct >= 70 ? 'bg-success' : pct >= 40 ? 'bg-warning' : 'bg-destructive'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      {pct}%
    </span>
  );
}

/** Where a flagged entity lives in the app. */
export function entityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'BILL':
      return `/purchasing/bills/${entityId}`;
    case 'INVOICE':
      return `/sales/invoices/${entityId}`;
    case 'JOURNAL_ENTRY':
      return `/accounting/journal-entries/${entityId}`;
    default:
      return null;
  }
}
