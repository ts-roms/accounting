'use client';
import * as React from 'react';
import { Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { RevenueRecognitionMethod } from '@accounting/types';
import { P, REVENUE_RECOGNITION_METHODS } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateRevenuePolicy,
  useRevenuePolicies,
  useRevenueSettings,
  useUpdateRevenuePolicy,
  useUpdateRevenueSettings,
} from '@/lib/api/revenue-hooks';
import type { RevenuePolicy } from '@/lib/api/revenue-types';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Field, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

export const METHOD_LABEL: Record<RevenueRecognitionMethod, string> = {
  POINT_IN_TIME: 'Point in time',
  RATABLE: 'Ratable over service period',
  MILESTONE: 'Milestone',
};

const METHOD_HINT: Record<RevenueRecognitionMethod, string> = {
  POINT_IN_TIME: 'Earned when the invoice posts - no deferral.',
  RATABLE: 'Deferred and released evenly by day over the service window, at each month end.',
  MILESTONE: 'Deferred and released by percentage as each milestone is marked complete.',
};

/** Revenue policies and settings: which lines defer, how they are released, and whether month-end runs post by themselves. */
export function RevenuePoliciesPage() {
  const policies = useRevenuePolicies();
  const settings = useRevenueSettings();
  const updateSettings = useUpdateRevenueSettings();
  const [editing, setEditing] = React.useState<RevenuePolicy | 'new' | null>(null);
  const [form, setForm] = React.useState({
    autoRecognize: false,
    overdueGraceDays: '0',
    defaultPolicyId: 'NONE',
  });
  React.useEffect(() => {
    if (!settings.data) return;
    setForm({
      autoRecognize: settings.data.autoRecognize,
      overdueGraceDays: String(settings.data.overdueGraceDays),
      defaultPolicyId: settings.data.defaultPolicyId ?? 'NONE',
    });
  }, [settings.data]);

  return (
    <>
      <PageHeader
        title="Revenue Policies"
        description="Policy is data: a policy says whether an invoice line earns its revenue at posting, evenly over a service period, or per milestone. Lines take their policy from the line, else the product, else the company default."
        actions={
          <Can permissions={[P['revenue.manage']]}>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> New policy
            </Button>
          </Can>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Policies</CardTitle>
            <CardDescription>
              Inactive policies stay on the schedules they created but cannot be picked for new
              lines.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <QueryState query={policies}>
              {(rows) => (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Default term</TableHead>
                      <TableHead>Auto</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                          No policies yet - every invoice line earns its revenue when it posts.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((p) => (
                        <TableRow key={p.id} data-testid="revenue-policy-row">
                          <TableCell className="font-mono text-sm">{p.code}</TableCell>
                          <TableCell>
                            <div>{p.name}</div>
                            {p.description ? (
                              <div className="text-xs text-muted-foreground">{p.description}</div>
                            ) : null}
                          </TableCell>
                          <TableCell>{METHOD_LABEL[p.method]}</TableCell>
                          <TableCell>
                            {p.defaultTermMonths ? `${p.defaultTermMonths} months` : '-'}
                          </TableCell>
                          <TableCell>{p.autoRecognize ? 'Yes' : 'No'}</TableCell>
                          <TableCell>
                            <StatusBadge status={p.status} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Can permissions={[P['revenue.manage']]}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${p.code}`}
                                onClick={() => setEditing(p)}
                              >
                                <Pencil />
                              </Button>
                            </Can>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </QueryState>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Settings</CardTitle>
            <CardDescription>
              Automatic recognition lets the scheduled job post due lines; otherwise a person runs
              month-end recognition.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QueryState query={settings}>
              {() => (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.autoRecognize}
                      onCheckedChange={(v) => setForm((f) => ({ ...f, autoRecognize: v === true }))}
                      aria-label="Automatic recognition"
                    />
                    Post due revenue automatically (scheduled job)
                  </label>
                  <Field
                    label="Overdue grace (days)"
                    hint="Pending lines older than this are flagged overdue"
                  >
                    <Input
                      inputMode="numeric"
                      value={form.overdueGraceDays}
                      onChange={(e) => setForm((f) => ({ ...f, overdueGraceDays: e.target.value }))}
                    />
                  </Field>
                  <Field label="Default policy" hint="Applied to lines whose product has no policy">
                    <Select
                      value={form.defaultPolicyId}
                      onValueChange={(v) => setForm((f) => ({ ...f, defaultPolicyId: v }))}
                    >
                      <SelectTrigger aria-label="Default policy">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">None - recognize at invoice</SelectItem>
                        {(policies.data ?? [])
                          .filter((p) => p.status === 'ACTIVE')
                          .map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.code} - {p.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Can permissions={[P['revenue.manage']]}>
                    <Button
                      size="sm"
                      disabled={updateSettings.isPending}
                      onClick={async () => {
                        try {
                          await updateSettings.mutateAsync({
                            autoRecognize: form.autoRecognize,
                            overdueGraceDays: Number(form.overdueGraceDays || 0),
                            defaultPolicyId:
                              form.defaultPolicyId === 'NONE' ? null : form.defaultPolicyId,
                          });
                          toast.success('Revenue settings saved');
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Save settings
                    </Button>
                  </Can>
                </>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>
      <PolicyDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function PolicyDialog({
  editing,
  onClose,
}: {
  editing: RevenuePolicy | 'new' | null;
  onClose: () => void;
}) {
  const create = useCreateRevenuePolicy();
  const update = useUpdateRevenuePolicy();
  const isNew = editing === 'new';
  const existing = editing && editing !== 'new' ? editing : null;
  const [form, setForm] = React.useState({
    code: '',
    name: '',
    method: 'RATABLE' as RevenueRecognitionMethod,
    description: '',
    defaultTermMonths: '',
    autoRecognize: true,
    status: 'ACTIVE',
  });
  React.useEffect(() => {
    if (!editing) return;
    setForm({
      code: existing?.code ?? '',
      name: existing?.name ?? '',
      method: existing?.method ?? 'RATABLE',
      description: existing?.description ?? '',
      defaultTermMonths: existing?.defaultTermMonths ? String(existing.defaultTermMonths) : '',
      autoRecognize: existing?.autoRecognize ?? true,
      status: existing?.status ?? 'ACTIVE',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const pending = create.isPending || update.isPending;
  const submit = async () => {
    try {
      const term =
        form.method === 'RATABLE' && form.defaultTermMonths ? Number(form.defaultTermMonths) : null;
      if (isNew)
        await create.mutateAsync({
          code: form.code,
          name: form.name,
          method: form.method,
          description: form.description || undefined,
          defaultTermMonths: term,
          autoRecognize: form.autoRecognize,
        });
      else if (existing)
        await update.mutateAsync({
          id: existing.id,
          name: form.name,
          description: form.description || undefined,
          defaultTermMonths: existing.method === 'RATABLE' ? term : undefined,
          autoRecognize: form.autoRecognize,
          status: form.status as RevenuePolicy['status'],
        });
      toast.success(isNew ? 'Policy created' : 'Policy updated');
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={Boolean(editing)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'New revenue policy' : `Edit ${existing?.code}`}</DialogTitle>
          <DialogDescription>{METHOD_HINT[form.method]}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={form.code}
              disabled={!isNew}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              data-testid="policy-code"
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              data-testid="policy-name"
            />
          </Field>
          <Field label="Method">
            <Select
              value={form.method}
              disabled={!isNew}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, method: v as RevenueRecognitionMethod }))
              }
            >
              <SelectTrigger aria-label="Method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REVENUE_RECOGNITION_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {form.method === 'RATABLE' ? (
            <Field label="Default term (months)" hint="Used when a line has no service end date">
              <Input
                inputMode="numeric"
                value={form.defaultTermMonths}
                onChange={(e) => setForm((f) => ({ ...f, defaultTermMonths: e.target.value }))}
                data-testid="policy-term"
              />
            </Field>
          ) : null}
          {!isNew ? (
            <Field label="Status">
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Description">
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox
              checked={form.autoRecognize}
              onCheckedChange={(v) => setForm((f) => ({ ...f, autoRecognize: v === true }))}
            />
            Include in automatic month-end recognition
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !form.name || (isNew && !form.code)}
            data-testid="policy-save"
          >
            {isNew ? 'Create policy' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
