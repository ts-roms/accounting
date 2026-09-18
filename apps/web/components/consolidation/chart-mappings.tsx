'use client';
import * as React from 'react';
import { Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useAccountMappings, useSetAccountMappings } from '@/lib/api/consolidation-hooks';
import type { ConsolidationGroup } from '@/lib/api/consolidation-types';
import { useSession } from '@/lib/auth/session';
import { Can } from '@/components/ui-ext/page';

const NONE = '__none__';

/**
 * Group chart mappings: for a subsidiary whose chart differs from the
 * parent's, pick the parent account each foreign code consolidates into.
 * Accounts that share the parent's code need nothing; the API validates that
 * the types agree and readiness warns about unmapped accounts with balances.
 */
export function ChartMappingsCard({ group }: { group: ConsolidationGroup }) {
  const { hasPermission } = useSession();
  const canManage = hasPermission(P['consolidation.manage']);
  const subsidiaries = group.members.filter((m) => !m.isParent);
  const [companyId, setCompanyId] = React.useState<string | null>(
    subsidiaries[0]?.companyId ?? null,
  );
  const mappings = useAccountMappings(group.id, companyId);
  const save = useSetAccountMappings();
  // Draft: member account id -> group code ('' = unmapped).
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!mappings.data) return;
    const next: Record<string, string> = {};
    for (const m of mappings.data.mappings) next[m.accountId] = m.groupAccountCode;
    setDraft(next);
  }, [mappings.data]);
  const data = mappings.data;
  const rows = React.useMemo(() => {
    if (!data) return [];
    const mapped = data.mappings.map((m) => ({
      accountId: m.accountId,
      code: m.accountCode,
      name: m.accountName,
      type: m.accountType,
    }));
    return [...mapped, ...data.unmatched].sort((a, b) => a.code.localeCompare(b.code));
  }, [data]);
  const dirty =
    data !== undefined &&
    JSON.stringify(
      Object.entries(draft)
        .filter(([, v]) => v)
        .sort(),
    ) !== JSON.stringify(data.mappings.map((m) => [m.accountId, m.groupAccountCode]).sort());
  const submit = async () => {
    if (!companyId) return;
    try {
      const result = await save.mutateAsync({
        groupId: group.id,
        companyId,
        mappings: Object.entries(draft)
          .filter(([, code]) => code)
          .map(([accountId, groupAccountCode]) => ({ accountId, groupAccountCode })),
      });
      toast.success(
        `${result.mappings.length} mapping(s) saved${result.unmatched.length ? `; ${result.unmatched.length} account(s) still unmapped` : ''}.`,
      );
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  if (subsidiaries.length === 0) return null;
  return (
    <Card data-testid="chart-mappings">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-sm">Group chart mappings</CardTitle>
          <CardDescription>
            Subsidiary accounts that are not in {group.parentCompanyCode}&apos;s chart roll into the
            parent account chosen here; matching codes need no mapping.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={companyId ?? ''} onValueChange={setCompanyId}>
            <SelectTrigger className="w-48" data-testid="chart-mappings-company">
              <SelectValue placeholder="Member" />
            </SelectTrigger>
            <SelectContent>
              {subsidiaries.map((m) => (
                <SelectItem key={m.companyId} value={m.companyId}>
                  {m.companyCode} {m.companyName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Can permissions={[P['consolidation.manage']]}>
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={submit}
              data-testid="chart-mappings-save"
            >
              <Save /> Save
            </Button>
          </Can>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {mappings.isLoading || !data ? (
          <Skeleton className="m-4 h-24" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            Every account of this member shares a code with the parent&apos;s chart.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Member account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Group account</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => {
                const value = draft[a.accountId] ?? '';
                const targets = data.targets.filter((t) => t.type === a.type);
                return (
                  <TableRow key={a.accountId} data-testid="chart-mapping-row">
                    <TableCell>
                      <span className="font-mono text-xs">{a.code}</span> {a.name}
                    </TableCell>
                    <TableCell className="text-xs">{a.type}</TableCell>
                    <TableCell>
                      {canManage ? (
                        <Select
                          value={value || NONE}
                          onValueChange={(v) =>
                            setDraft((d) => ({ ...d, [a.accountId]: v === NONE ? '' : v }))
                          }
                        >
                          <SelectTrigger className="w-72" data-testid="chart-mapping-target">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Unmapped</SelectItem>
                            {targets.map((t) => (
                              <SelectItem key={t.code} value={t.code}>
                                {t.code} {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : value ? (
                        <span className="font-mono text-xs">{value}</span>
                      ) : (
                        <StatusBadge tone="warning" size="sm">
                          Unmapped
                        </StatusBadge>
                      )}
                    </TableCell>
                    <TableCell>
                      {canManage && value ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Clear mapping"
                          onClick={() => setDraft((d) => ({ ...d, [a.accountId]: '' }))}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
