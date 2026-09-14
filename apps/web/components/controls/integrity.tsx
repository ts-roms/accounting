'use client';
import * as React from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useIntegrityReport } from '@/lib/api/accounting-hooks';
import type { IntegrityFinding } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/ui-ext/page';
import { today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';

const SEVERITY_VARIANT = {
  CRITICAL: 'destructive',
  WARNING: 'warning',
  INFO: 'secondary',
} as const;

/** Financial integrity dashboard: the accounting invariants run live, read-only. */
export function IntegrityPage() {
  const [asOf, setAsOf] = React.useState(today());
  const report = useIntegrityReport(asOf);
  const [open, setOpen] = React.useState<string | null>(null);
  const r = report.data;
  const failing = r?.findings.filter((f) => f.count > 0) ?? [];
  const critical = failing.filter((f) => f.severity === 'CRITICAL').length;
  const warnings = failing.filter((f) => f.severity === 'WARNING').length;
  return (
    <>
      <PageHeader
        title="Financial integrity"
        description="Every accounting invariant checked against live data: balanced journals, period discipline, subledger-to-control agreement, mappings and duplicate controls."
        actions={
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="integrity-asof">As of</Label>
              <Input
                id="integrity-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void report.refetch()}
              disabled={report.isFetching}
              data-testid="integrity-refresh"
            >
              <RefreshCw className={report.isFetching ? 'animate-spin' : ''} /> Re-run
            </Button>
          </div>
        }
      />
      {report.isError ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive" data-testid="integrity-error">
            {describeError(report.error)}
          </CardContent>
        </Card>
      ) : !r ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Stat
              label="Status"
              value={
                <span className="flex items-center gap-2" data-testid="integrity-status">
                  <ShieldCheck
                    className={
                      r.status === 'OK'
                        ? 'h-5 w-5 text-success'
                        : r.status === 'WARNING'
                          ? 'h-5 w-5 text-warning'
                          : 'h-5 w-5 text-destructive'
                    }
                  />
                  {r.status}
                </span>
              }
              hint={`ran ${formatDateTime(r.ranAt)}`}
              danger={r.status === 'CRITICAL'}
            />
            <Stat label="Checks" value={r.findings.length} />
            <Stat label="Critical findings" value={critical} danger={critical > 0} />
            <Stat label="Warnings" value={warnings} />
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead className="text-right">Findings</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.findings.map((f) => (
                    <React.Fragment key={f.check}>
                      <TableRow
                        className={f.count ? 'cursor-pointer' : ''}
                        onClick={() => f.count && setOpen(open === f.check ? null : f.check)}
                        data-testid="integrity-check"
                      >
                        <TableCell>
                          <div className="font-medium">{f.title}</div>
                          <div className="font-mono text-xs text-muted-foreground">{f.check}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular">{f.count}</TableCell>
                        <TableCell>
                          {f.count === 0 ? (
                            <Badge variant="success">PASS</Badge>
                          ) : (
                            <Badge variant={SEVERITY_VARIANT[f.severity]}>FAIL</Badge>
                          )}
                          {f.detail ? (
                            <div className="mt-0.5 text-xs text-muted-foreground">{f.detail}</div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {open === f.check ? (
                        <TableRow>
                          <TableCell colSpan={4} className="bg-muted/40">
                            <Samples finding={f} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

function Samples({ finding }: { finding: IntegrityFinding }) {
  const keys = Array.from(new Set(finding.samples.flatMap((s) => Object.keys(s))));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k} className="px-2 py-1 text-left font-medium text-muted-foreground">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {finding.samples.map((s, i) => (
            <tr key={i} className="border-t">
              {keys.map((k) => (
                <td key={k} className="px-2 py-1 font-mono">
                  {s[k] === null || s[k] === undefined ? '-' : String(s[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {finding.count > finding.samples.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing {finding.samples.length} of {finding.count}.
        </p>
      ) : null}
    </div>
  );
}
