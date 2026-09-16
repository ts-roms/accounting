'use client';
import * as React from 'react';
import { Download, FileUp, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  downloadImportTemplate,
  useCancelImport,
  useCommitImport,
  useImport,
  useImportTypes,
  useImports,
  useUploadImport,
} from '@/lib/api/data-infrastructure-hooks';
import type { ImportJob, ImportStatus, ImportType } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { today } from '@/components/accounting/primitives';

const STATUS_TONE = {
  VALIDATED: 'pending',
  COMMITTED: 'positive',
  FAILED: 'critical',
  CANCELLED: 'neutral',
} as const;

export function ImportStatusBadge({ status }: { status: ImportStatus }) {
  return (
    <StatusBadge tone={STATUS_TONE[status]} data-testid="import-status">
      {titleCase(status)}
    </StatusBadge>
  );
}

/** CSV import engine: pick a type, download the template, upload, review the preview, commit. */
export function ImportsPage() {
  const types = useImportTypes();
  const [type, setType] = React.useState<ImportType>('CUSTOMERS');
  const [asOfDate, setAsOfDate] = React.useState(today());
  const [file, setFile] = React.useState<File | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const upload = useUploadImport();
  const history = useImports({ page: 1, pageSize: 20 });
  const spec = types.data?.find((t) => t.type === type);
  const needsDate = type === 'OPENING_BALANCES';
  return (
    <>
      <PageHeader
        title="Data imports"
        description="Upload a CSV, review every row and its validation errors, then commit. Financial datasets (journals, opening balances, bank transactions) load all-or-nothing; master data loads row by row and reports each outcome. Every import is audited."
      />
      <Can permissions={[P['import.run']]}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New import</CardTitle>
            <CardDescription>
              {spec ? (
                <>
                  {spec.title} · {spec.atomic ? 'all-or-nothing' : 'row by row'} ·{' '}
                  {spec.columns.filter((c) => c.required).length} required column(s)
                </>
              ) : (
                'Choose a dataset'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label>Dataset</Label>
                <Select value={type} onValueChange={(v) => setType(v as ImportType)}>
                  <SelectTrigger data-testid="import-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(types.data ?? []).map((t) => (
                      <SelectItem key={t.type} value={t.type}>
                        {t.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {needsDate ? (
                <div className="space-y-1">
                  <Label htmlFor="import-asof">Cut-over date</Label>
                  <Input
                    id="import-asof"
                    type="date"
                    value={asOfDate}
                    onChange={(e) => setAsOfDate(e.target.value)}
                    data-testid="import-asof"
                  />
                </div>
              ) : null}
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="import-file">CSV file</Label>
                <Input
                  id="import-file"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  data-testid="import-file"
                />
              </div>
            </div>
            {spec ? (
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                {spec.columns.map((c) => (
                  <Badge
                    key={c.key}
                    variant={c.required ? 'secondary' : 'outline'}
                    title={c.description}
                  >
                    {c.key}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  void downloadImportTemplate(type).catch((e) => toast.error(describeError(e)))
                }
                data-testid="import-template"
              >
                <Download /> Template
              </Button>
              <Button
                disabled={!file}
                loading={upload.isPending}
                onClick={async () => {
                  if (!file) return;
                  try {
                    const job = await upload.mutateAsync({
                      type,
                      file,
                      asOfDate: needsDate ? asOfDate : undefined,
                    });
                    setSelected(job.id);
                    setFile(null);
                    toast.success(
                      `${job.rowCount} row(s) read, ${job.validCount} valid, ${job.errorCount} with errors.`,
                    );
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
                data-testid="import-upload"
              >
                <Upload /> Upload & validate
              </Button>
            </div>
          </CardContent>
        </Card>
      </Can>
      {selected ? <ImportPreview id={selected} onClose={() => setSelected(null)} /> : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {history.isLoading ? (
            <TableSkeleton rows={4} />
          ) : (history.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No imports yet"
              description="Uploaded files appear here with their validation and commit results."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Dataset</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Valid</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data!.items.map((j: ImportJob) => (
                  <TableRow
                    key={j.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(j.id)}
                    data-testid="import-row"
                  >
                    <TableCell className="font-medium">{j.fileName}</TableCell>
                    <TableCell>{j.spec.title}</TableCell>
                    <TableCell className="text-right">{j.rowCount}</TableCell>
                    <TableCell className="text-right">{j.validCount}</TableCell>
                    <TableCell className="text-right">{j.errorCount}</TableCell>
                    <TableCell>
                      <ImportStatusBadge status={j.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(j.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ImportPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const job = useImport(id);
  const commit = useCommitImport();
  const cancel = useCancelImport();
  const [skipInvalid, setSkipInvalid] = React.useState(false);
  const j = job.data;
  if (!j) return null;
  const columns = j.spec.columns.map((c) => c.key);
  const canCommit =
    j.status === 'VALIDATED' && (j.errorCount === 0 || (!j.spec.atomic && skipInvalid));
  return (
    <Card data-testid="import-preview">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileUp className="h-4 w-4" /> {j.fileName}
            <ImportStatusBadge status={j.status} />
          </CardTitle>
          <CardDescription>
            {j.spec.title} · {j.rowCount} row(s), {j.validCount} valid, {j.errorCount} with errors
            {j.status === 'COMMITTED' ? ` · created ${j.result.created ?? 0}` : ''}
            {j.result.error ? ` · ${j.result.error}` : ''}
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          {j.status === 'VALIDATED' && !j.spec.atomic && j.errorCount > 0 ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={skipInvalid}
                onCheckedChange={(v) => setSkipInvalid(Boolean(v))}
                data-testid="import-skip-invalid"
              />
              Skip invalid rows
            </label>
          ) : null}
          {j.status === 'VALIDATED' ? (
            <Can permissions={[P['import.run']]}>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await cancel.mutateAsync(j.id);
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                Discard
              </Button>
              <Button
                disabled={!canCommit}
                loading={commit.isPending}
                onClick={async () => {
                  try {
                    const done = await commit.mutateAsync({ id: j.id, skipInvalid });
                    toast.success(
                      `Import committed: ${done.result.created ?? 0} record(s) created.`,
                    );
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
                data-testid="import-commit"
              >
                Commit import
              </Button>
            </Can>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Line</TableHead>
              {columns.map((c) => (
                <TableHead key={c} className="font-mono text-xs">
                  {c}
                </TableHead>
              ))}
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {j.rows.slice(0, 200).map((r) => (
              <TableRow
                key={r.line}
                className={r.errors.length ? 'bg-critical/5' : ''}
                data-testid="import-preview-row"
                data-errors={r.errors.length}
              >
                <TableCell className="text-xs text-muted-foreground">{r.line}</TableCell>
                {columns.map((c) => (
                  <TableCell key={c} className="max-w-48 truncate text-xs" title={r.values[c]}>
                    {r.values[c] ?? ''}
                  </TableCell>
                ))}
                <TableCell className="text-xs">
                  {r.errors.length ? (
                    <ul className="list-disc pl-4 text-critical" data-testid="import-row-errors">
                      {r.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  ) : r.result ? (
                    <span className="font-mono">{r.result}</span>
                  ) : (
                    <span className="text-positive">valid</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {j.rows.length > 200 ? (
          <div className="p-3 text-xs text-muted-foreground">
            Showing the first 200 of {j.rows.length} rows.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
