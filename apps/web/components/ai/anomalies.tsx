'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Check, ScanSearch, X } from 'lucide-react';
import { toast } from 'sonner';
import { AI_ANOMALY_TYPES, AI_SEVERITIES, AI_SUGGESTION_STATUSES, P } from '@accounting/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAiAnomalies,
  useAiAnomalySummary,
  useAiScan,
  useDecideAiAnomaly,
} from '@/lib/api/ai-hooks';
import type { AiAnomaly } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { DateRange, startOfYear, today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';
import {
  AdvisoryNote,
  ConfidenceMeter,
  entityHref,
  FlagStatusBadge,
  SeverityBadge,
} from './shared';

const ALL = 'ALL';

export function AiAnomaliesPage({ initialSeverity }: { initialSeverity?: string }) {
  const { hasPermission } = useSession();
  const table = useTableState({ pageSize: 25 });
  const [status, setStatus] = React.useState<string>('OPEN');
  const [severity, setSeverity] = React.useState<string>(initialSeverity ?? ALL);
  const [type, setType] = React.useState<string>(ALL);
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [selected, setSelected] = React.useState<AiAnomaly | null>(null);
  const summary = useAiAnomalySummary();
  const scan = useAiScan();
  const flags = useAiAnomalies({
    ...table.query,
    status: status === ALL ? undefined : (status as AiAnomaly['status']),
    severity: severity === ALL ? undefined : (severity as AiAnomaly['severity']),
    anomalyType: type === ALL ? undefined : (type as AiAnomaly['anomalyType']),
  });
  const runScan = async () => {
    try {
      const r = await scan.mutateAsync(range);
      toast.success(
        `Scanned ${r.scanned.documents} documents and ${r.scanned.journals} journals: ${r.flagged} flag(s), ${r.new} new.`,
      );
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const columns = React.useMemo<ColumnDef<AiAnomaly>[]>(
    () => [
      {
        id: 'severity',
        header: 'Severity',
        enableSorting: false,
        cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      },
      {
        id: 'title',
        header: 'Flag',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.title}</div>
            <div className="text-xs text-muted-foreground">
              {titleCase(row.original.anomalyType)}
            </div>
          </div>
        ),
      },
      {
        id: 'entity',
        header: 'Document',
        enableSorting: false,
        cell: ({ row }) => {
          const href = entityHref(row.original.entityType, row.original.entityId);
          const label = row.original.entityNumber ?? row.original.entityId.slice(0, 8);
          return href ? (
            <Link
              href={href}
              className="font-mono text-xs hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {label}
            </Link>
          ) : (
            <span className="font-mono text-xs">{label}</span>
          );
        },
      },
      {
        id: 'date',
        header: 'Date',
        enableSorting: false,
        cell: ({ row }) => row.original.entityDate ?? '-',
      },
      {
        id: 'confidence',
        header: 'Confidence',
        enableSorting: false,
        cell: ({ row }) => <ConfidenceMeter value={row.original.confidence} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-xs">
            <FlagStatusBadge status={row.original.status} />
            {row.original.decidedByName ? (
              <div className="mt-1 text-muted-foreground">{row.original.decidedByName}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'seen',
        header: 'Last seen',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(row.original.lastSeenAt)}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Anomaly flags"
        description="Duplicates, unusual amounts, manual postings on control accounts and other patterns worth a second look. A flag never changes the books."
        actions={
          <Can permissions={[P['ai.use']]}>
            <div className="flex items-end gap-2">
              <DateRange from={range.from} to={range.to} onChange={setRange} />
              <Button onClick={runScan} disabled={scan.isPending} data-testid="anomaly-scan">
                <ScanSearch /> {scan.isPending ? 'Scanning...' : 'Scan now'}
              </Button>
            </div>
          </Can>
        }
      />
      <AdvisoryNote />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Open flags" value={summary.data?.open ?? '-'} />
        <Stat label="High" value={summary.data?.high ?? '-'} danger={Boolean(summary.data?.high)} />
        <Stat label="Medium" value={summary.data?.medium ?? '-'} />
        <Stat label="Low" value={summary.data?.low ?? '-'} />
      </div>
      <DataTable
        columns={columns}
        data={flags.data}
        isLoading={flags.isLoading}
        isFetching={flags.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => setSelected(r)}
        emptyState={
          <EmptyState
            title="No flags"
            description="Run a scan over a date range to look for anomalies in posted data."
          />
        }
        toolbar={
          <>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {AI_SUGGESTION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={severity}
              onValueChange={(v) => {
                setSeverity(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All severities</SelectItem>
                {AI_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All types</SelectItem>
                {AI_ANOMALY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <FlagDialog
        flag={selected}
        canDecide={hasPermission(P['ai.review'])}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </>
  );
}

function FlagDialog({
  flag,
  canDecide,
  onOpenChange,
}: {
  flag: AiAnomaly | null;
  canDecide: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const decide = useDecideAiAnomaly();
  const [note, setNote] = React.useState('');
  React.useEffect(() => setNote(''), [flag?.id]);
  const run = async (decision: 'ACCEPT' | 'DISMISS') => {
    if (!flag) return;
    try {
      await decide.mutateAsync({ id: flag.id, decision, note: note.trim() || undefined });
      toast.success(
        decision === 'ACCEPT' ? 'Flag confirmed - follow up on the document.' : 'Flag dismissed.',
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const href = flag ? entityHref(flag.entityType, flag.entityId) : null;
  return (
    <Dialog open={Boolean(flag)} onOpenChange={onOpenChange}>
      <DialogContent>
        {flag ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <SeverityBadge severity={flag.severity} /> {flag.title}
              </DialogTitle>
              <DialogDescription>
                {titleCase(flag.anomalyType)} · confidence{' '}
                {Math.round(Number(flag.confidence) * 100)}%
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm" data-testid="flag-detail">
              {flag.detail}
            </p>
            {href ? (
              <Link href={href} className="text-sm underline">
                Open {flag.entityNumber ?? 'document'}
              </Link>
            ) : null}
            {flag.status === 'OPEN' && canDecide ? (
              <div className="space-y-1">
                <Label>Note</Label>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            ) : flag.status !== 'OPEN' ? (
              <p className="text-xs text-muted-foreground">
                {titleCase(flag.status)} by {flag.decidedByName ?? 'someone'}{' '}
                {flag.decidedAt ? formatDateTime(flag.decidedAt) : ''}
                {flag.decisionNote ? ` · ${flag.decisionNote}` : ''}
              </p>
            ) : null}
            <DialogFooter>
              {flag.status === 'OPEN' && canDecide ? (
                <>
                  <Button
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => run('DISMISS')}
                    data-testid="flag-dismiss"
                  >
                    <X /> Dismiss
                  </Button>
                  <Button
                    disabled={decide.isPending}
                    onClick={() => run('ACCEPT')}
                    data-testid="flag-accept"
                  >
                    <Check /> Confirm issue
                  </Button>
                </>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
