'use client';
import * as React from 'react';
import { History } from 'lucide-react';
import { P } from '@accounting/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useFieldHistory } from '@/lib/api/controls-hooks';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Field-level change history of one record (hardening H5): who changed which
 * field from what to what, when and why. Derived from the audit trail; not the
 * audit trail itself, which lists actions rather than fields.
 */
export function HistoryPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { hasPermission } = useSession();
  const history = useFieldHistory(entityType, hasPermission(P['history.view']) ? entityId : null);
  if (!hasPermission(P['history.view'])) return null;
  const rows = history.data ?? [];
  return (
    <Card data-testid="history-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" /> Change history
        </CardTitle>
        <CardDescription>
          Every edit of a financial field, with the reason given. Actions (submit, approve, post)
          live in the audit trail.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No field changes recorded.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Changed by</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} data-testid="history-row" data-field={r.field}>
                  <TableCell className="font-medium">{titleCase(r.field)}</TableCell>
                  <TableCell className="font-mono text-xs">{show(r.previousValue)}</TableCell>
                  <TableCell className="font-mono text-xs">{show(r.newValue)}</TableCell>
                  <TableCell className="text-xs">
                    {r.changedByEmail ?? 'system'}
                    <div className="text-muted-foreground">{formatDateTime(r.changedAt)}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.reason ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
