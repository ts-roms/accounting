'use client';
import * as React from 'react';
import { Hash, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { DEFAULT_NUMBERING_FORMAT, DOCUMENT_TYPES, P } from '@accounting/types';
import { numberingRuleSchema, type NumberingRuleInput } from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
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
} from '@accounting/ui';
import { describeError, getActiveCompanyId } from '@/lib/api/client';
import {
  useDeleteNumberingRule,
  useNumberingRules,
  useUpsertNumberingRule,
} from '@/lib/api/data-infrastructure-hooks';
import { useBranches } from '@/lib/api/hooks';
import type { NumberingRuleView } from '@/lib/api/types';
import { Can, ConfirmDialog, PageHeader, TableSkeleton } from '@/components/ui-ext/page';

type FormInput = z.input<typeof numberingRuleSchema>;

/** Document numbering rules: one effective rule per document type plus branch overrides. */
export function NumberingPage() {
  const year = new Date().getUTCFullYear();
  const rules = useNumberingRules(year);
  const remove = useDeleteNumberingRule();
  const [editing, setEditing] = React.useState<NumberingRuleView | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<NumberingRuleView | null>(null);
  return (
    <>
      <PageHeader
        title="Document numbering"
        description="How every document type is numbered: prefix, format template, padding and whether the sequence restarts each fiscal year. Branch rules override the company rule. Numbers are allocated atomically inside the document's transaction and are never reused."
        actions={
          <Can permissions={[P['numbering.manage']]}>
            <Button onClick={() => setAdding(true)} data-testid="numbering-add-branch">
              <Hash /> Branch rule
            </Button>
          </Can>
        }
      />
      <Card>
        <CardContent className="p-0">
          {rules.isLoading ? (
            <TableSkeleton rows={8} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead className="text-right">Padding</TableHead>
                  <TableHead>Reset</TableHead>
                  <TableHead>Next number ({year})</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(rules.data ?? []).map((r) => (
                  <TableRow
                    key={`${r.documentType}-${r.branchId ?? 'company'}`}
                    data-testid="numbering-rule"
                    data-type={r.documentType}
                    data-scope={r.branchCode ?? 'company'}
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      {r.documentType}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.branchCode ? (
                        <Badge variant="secondary">{r.branchCode}</Badge>
                      ) : r.ruleId ? (
                        'Company'
                      ) : (
                        <span className="text-muted-foreground">Company (default)</span>
                      )}
                      {!r.isActive ? (
                        <Badge variant="outline" className="ml-2">
                          inactive
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.prefix}</TableCell>
                    <TableCell className="font-mono text-xs">{r.format}</TableCell>
                    <TableCell className="text-right">{r.padding}</TableCell>
                    <TableCell className="text-xs">{r.resetYearly ? 'Yearly' : 'Never'}</TableCell>
                    <TableCell className="font-mono text-xs" data-testid="numbering-next">
                      {r.nextNumber}
                    </TableCell>
                    <TableCell className="text-right">
                      <Can permissions={[P['numbering.manage']]}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(r)}
                          data-testid="numbering-edit"
                        >
                          <Pencil />
                        </Button>
                        {r.ruleId ? (
                          <Button variant="ghost" size="sm" onClick={() => setDeleting(r)}>
                            <Trash2 />
                          </Button>
                        ) : null}
                      </Can>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <RuleDialog
        open={editing !== null || adding}
        rule={editing}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setAdding(false);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this rule?"
        description="Documents of this type fall back to the company rule or the built-in default. Numbers already issued are kept."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!deleting?.ruleId) return;
          try {
            await remove.mutateAsync(deleting.ruleId);
            toast.success('Rule removed.');
          } catch (err) {
            toast.error(describeError(err));
          } finally {
            setDeleting(null);
          }
        }}
      />
    </>
  );
}

function RuleDialog({
  open,
  rule,
  onOpenChange,
}: {
  open: boolean;
  rule: NumberingRuleView | null;
  onOpenChange: (o: boolean) => void;
}) {
  const upsert = useUpsertNumberingRule();
  const branches = useBranches(getActiveCompanyId() ?? undefined);
  const defaults = React.useCallback(
    (): FormInput => ({
      documentType: (rule?.documentType as FormInput['documentType']) ?? 'INV',
      branchId: rule?.branchId ?? null,
      prefix: rule?.prefix ?? 'INV',
      format: rule?.format ?? DEFAULT_NUMBERING_FORMAT,
      padding: rule?.padding ?? 6,
      resetYearly: rule?.resetYearly ?? true,
      isActive: rule?.isActive ?? true,
    }),
    [rule],
  );
  const form = useForm<FormInput, unknown, NumberingRuleInput>({
    resolver: zodResolver(numberingRuleSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const values = form.watch();
  const preview = String(values.format ?? '')
    .replaceAll('{PREFIX}', values.prefix ?? '')
    .replaceAll('{BRANCH}', branches.data?.find((b) => b.id === values.branchId)?.code ?? 'BR')
    .replaceAll('{YEAR}', String(new Date().getUTCFullYear()))
    .replaceAll('{YY}', String(new Date().getUTCFullYear()).slice(-2))
    .replaceAll('{SEQ}', '1'.padStart(Number(values.padding ?? 6), '0'))
    .replace(/--+/g, '-');
  const submit = form.handleSubmit(async (v) => {
    try {
      await upsert.mutateAsync(v);
      toast.success('Numbering rule saved.');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {rule ? `Numbering for ${rule.documentType}` : 'Branch numbering rule'}
          </DialogTitle>
          <DialogDescription>
            Tokens: {'{PREFIX}'} {'{BRANCH}'} {'{YEAR}'} {'{YY}'} {'{SEQ}'} (required). Preview:{' '}
            <span className="font-mono" data-testid="numbering-preview">
              {preview}
            </span>
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="documentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Document type</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={Boolean(rule)}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="numbering-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DOCUMENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className="font-mono text-xs">
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="branchId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Scope</FormLabel>
                    <Select
                      value={field.value ?? '__company__'}
                      onValueChange={(v) => field.onChange(v === '__company__' ? null : v)}
                      disabled={Boolean(rule)}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="numbering-scope">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__company__">Company-wide</SelectItem>
                        {(branches.data ?? []).map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.code} {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="prefix"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prefix</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        className="font-mono uppercase"
                        data-testid="numbering-prefix"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="padding"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Padding</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={3}
                        max={12}
                        {...field}
                        value={String(field.value ?? '')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="format"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Format</FormLabel>
                  <FormControl>
                    <Input {...field} className="font-mono" data-testid="numbering-format" />
                  </FormControl>
                  <FormDescription>
                    Upper-case letters, digits, - _ / . and the tokens above.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-6">
              <FormField
                control={form.control}
                name="resetYearly"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={Boolean(field.value)}
                        onCheckedChange={(v) => field.onChange(Boolean(v))}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0 font-normal">Restart every fiscal year</FormLabel>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={Boolean(field.value)}
                        onCheckedChange={(v) => field.onChange(Boolean(v))}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0 font-normal">Active</FormLabel>
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={upsert.isPending} data-testid="numbering-save">
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
