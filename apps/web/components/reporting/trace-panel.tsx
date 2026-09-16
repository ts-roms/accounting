'use client';
import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Route } from 'lucide-react';
import { P } from '@accounting/types';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useDocumentJournals, useJournalTrace } from '@/lib/api/reporting-engine-hooks';
import type { TraceJournal } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { CardSkeleton, ErrorState } from '@/components/ui-ext/page';
import { Amount, JournalStatusBadge } from '@/components/accounting/primitives';
import type { JournalStatus } from '@accounting/types';

const RELATION: Record<TraceJournal['relation'], string> = {
  THIS: 'This entry',
  ORIGINAL: 'Reverses',
  REVERSAL: 'Reversed by',
  CORRECTED: 'Corrects',
  CORRECTION: 'Corrected by',
  SAME_SOURCE: 'Same source',
};

/**
 * Traceability panel for one journal: the source document (and its party),
 * every linked journal, approvals and the audit trail of the journal and its
 * source - all read from `GET /trace/journal/:id`. Rendered only for users
 * holding `trace.view`; hiding it is cosmetic, the API enforces the permission.
 */
export function TracePanel({ journalId }: { journalId: string }) {
  const { hasPermission } = useSession();
  const allowed = hasPermission(P['trace.view']);
  const trace = useJournalTrace(journalId, allowed);
  if (!allowed) return null;
  if (trace.isLoading) return <CardSkeleton />;
  if (trace.isError) return <ErrorState description={describeError(trace.error)} />;
  const t = trace.data;
  if (!t) return null;
  return (
    <Card data-testid="trace-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="h-4 w-4" /> Traceability
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <div className="type-label mb-1">Source document</div>
          {t.source ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="trace-source">
              <Badge variant="outline">{titleCase(t.source.sourceType)}</Badge>
              {t.source.path ? (
                <Link
                  href={t.source.path}
                  className="font-mono hover:underline"
                  data-testid="trace-source-link"
                >
                  {t.source.documentNumber ?? t.source.id}
                </Link>
              ) : (
                <span className="font-mono">{t.source.documentNumber ?? t.source.id}</span>
              )}
              {t.source.status ? (
                <Badge variant="secondary">{titleCase(t.source.status)}</Badge>
              ) : null}
              {t.source.event !== t.source.sourceType ? (
                <span className="text-muted-foreground">({titleCase(t.source.event)})</span>
              ) : null}
              {t.source.amount ? <Amount value={t.source.amount} className="inline" /> : null}
            </div>
          ) : (
            <span className="text-muted-foreground">Manual journal - no source document.</span>
          )}
          {t.party ? (
            <div className="mt-1" data-testid="trace-party">
              <span className="text-muted-foreground">{titleCase(t.party.kind)}: </span>
              <Link href={t.party.path} className="hover:underline">
                {t.party.code ? `${t.party.code} ` : ''}
                {t.party.name}
              </Link>
            </div>
          ) : null}
        </div>
        <div>
          <div className="type-label mb-1">People</div>
          <dl className="grid grid-cols-[110px_1fr] gap-y-1">
            <dt className="text-muted-foreground">Prepared by</dt>
            <dd>{t.journal.createdBy.name ?? t.journal.createdBy.email ?? '-'}</dd>
            <dt className="text-muted-foreground">Approved by</dt>
            <dd>{t.journal.approvedBy.name ?? t.journal.approvedBy.email ?? '-'}</dd>
            <dt className="text-muted-foreground">Posted by</dt>
            <dd data-testid="trace-posted-by">
              {t.journal.postedBy.name ?? t.journal.postedBy.email ?? '-'}
            </dd>
          </dl>
        </div>
        {t.related.length ? (
          <div>
            <div className="type-label mb-1">Linked journals</div>
            <ul className="space-y-1" data-testid="trace-related">
              {t.related.map((r) => (
                <li key={`${r.relation}-${r.id}`} className="flex items-center gap-2">
                  <span className="w-28 text-muted-foreground">{RELATION[r.relation]}</span>
                  <Link
                    href={`/accounting/journal-entries/${r.id}`}
                    className="font-mono hover:underline"
                  >
                    {r.documentNumber}
                  </Link>
                  <JournalStatusBadge status={r.status as JournalStatus} />
                  <span className="text-muted-foreground">{r.entryDate}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {t.approvals.length ? (
          <div>
            <div className="type-label mb-1">Approvals</div>
            <ul className="space-y-1">
              {t.approvals.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <Badge variant="outline">{titleCase(a.documentType)}</Badge>
                  <span className="font-mono">{a.documentNumber}</span>
                  <Badge variant="secondary">{titleCase(a.status)}</Badge>
                  <Link
                    href={`/admin/approvals?id=${a.id}`}
                    className="text-muted-foreground hover:underline"
                  >
                    open
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <div className="type-label mb-1">Audit trail</div>
          {t.audit.length ? (
            <ul className="max-h-64 space-y-1 overflow-auto" data-testid="trace-audit">
              {t.audit.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <span className="whitespace-nowrap text-muted-foreground">
                    {new Date(a.occurredAt).toLocaleString()}
                  </span>
                  <Badge variant="outline">{a.action}</Badge>
                  <span>{a.entityType}</span>
                  <span className="text-muted-foreground">
                    {a.user.name ?? a.user.email ?? 'system'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">No audit events recorded.</span>
          )}
          <Button variant="link" size="sm" className="mt-1 px-0" asChild>
            <Link href={`/admin/audit-logs?entityId=${t.journal.id}`}>
              Full audit log <ExternalLink className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Journals produced by a source document (shown on document detail pages). */
export function DocumentJournalsPanel({
  sourceId,
  title = 'Ledger postings',
}: {
  sourceId: string;
  title?: string;
}) {
  const { hasPermission } = useSession();
  const allowed = hasPermission(P['trace.view']);
  const journals = useDocumentJournals(sourceId, allowed);
  if (!allowed || journals.isLoading || journals.isError || !journals.data?.length) return null;
  return (
    <Card data-testid="document-journals">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="h-4 w-4" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {journals.data.map((j) => (
            <li key={j.id} className="flex items-center gap-2">
              <Link
                href={`/accounting/journal-entries/${j.id}`}
                className="font-mono hover:underline"
              >
                {j.documentNumber}
              </Link>
              <Badge variant="outline">{titleCase(j.sourceType ?? 'MANUAL')}</Badge>
              <JournalStatusBadge status={j.status as JournalStatus} />
              <span className="text-muted-foreground">{j.entryDate}</span>
              <Amount value={j.totalDebit} className="ml-auto inline" />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
