'use client';
import * as React from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_TYPES,
  DIMENSION_RULE_SCOPES,
  DIMENSION_TYPES,
  P,
  POSTING_RULE_ACCOUNT_SOURCES,
  POSTING_SIDES,
} from '@accounting/types';
import {
  dimensionRuleSchema,
  postingRuleSchema,
  type DimensionRuleInput,
  type PostingRuleInput,
} from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateDimensionRule,
  useCreatePostingRule,
  useDimensionRules,
  usePostingRules,
  useSimulatePostingRule,
  useUpdateDimensionRule,
  useUpdatePostingRule,
} from '@/lib/api/accounting-core-hooks';
import type { PostingRule, ResolvedPostingRule } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { AccountCombobox, Amount } from '@/components/accounting/primitives';
import { DIMENSION_LABEL } from '@/components/dimensions/pickers';

type RuleFormInput = z.input<typeof postingRuleSchema>;
type DimRuleFormInput = z.input<typeof dimensionRuleSchema>;

const emptyRuleLine = (): RuleFormInput['lines'][number] => ({
  side: 'DEBIT',
  accountSource: 'MAPPING',
  mappingKey: 'ACCOUNTS_RECEIVABLE',
  accountId: null,
  accountKey: '',
  amountKey: 'GROSS',
  description: '',
});

/** Posting rules (Dr / Cr templates per transaction type) and dimension rules. */
export function PostingRulesPage() {
  const { hasPermission, activeCompany } = useSession();
  const canManage = hasPermission(P['posting-rule.manage']);
  const currency = activeCompany?.baseCurrency ?? 'PHP';
  return (
    <>
      <PageHeader
        title="Posting rules"
        description="How each transaction type hits the ledger, resolved from account mappings and the calling module's context - no account ids in code. Dimension rules say which accounts must carry a department, cost center or project."
      />
      <Tabs defaultValue="posting">
        <TabsList>
          <TabsTrigger value="posting">Posting rules</TabsTrigger>
          <TabsTrigger value="dimensions">Dimension rules</TabsTrigger>
        </TabsList>
        <TabsContent value="posting" className="space-y-3">
          <PostingRulesTab canManage={canManage} currency={currency} />
        </TabsContent>
        <TabsContent value="dimensions" className="space-y-3">
          <DimensionRulesTab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function PostingRulesTab({ canManage, currency }: { canManage: boolean; currency: string }) {
  const rules = usePostingRules();
  const update = useUpdatePostingRule();
  const [creating, setCreating] = React.useState(false);
  const [simulating, setSimulating] = React.useState<PostingRule | null>(null);
  return (
    <>
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => setCreating(true)} data-testid="posting-rule-new">
            <Plus /> New rule
          </Button>
        </div>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {rules.isLoading ? (
            <TableSkeleton columns={5} rows={4} />
          ) : !rules.data?.length ? (
            <EmptyState
              title="No posting rules"
              description="Create one per transaction type your modules post."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Transaction type</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>Needs from the caller</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.data.map((r) => (
                  <TableRow key={r.id} data-testid={`posting-rule-${r.transactionType}`}>
                    <TableCell>
                      <div className="font-mono text-xs">{r.transactionType}</div>
                      <div className="text-sm">{r.name}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.lines.map((l, i) => (
                        <div key={i}>
                          <span className={l.side === 'DEBIT' ? 'font-medium' : 'pl-4'}>
                            {l.side === 'DEBIT' ? 'Dr' : 'Cr'}
                          </span>{' '}
                          {l.accountSource === 'MAPPING'
                            ? l.mappingKey
                            : l.accountSource === 'CONTEXT'
                              ? `context:${l.accountKey}`
                              : 'fixed account'}{' '}
                          <span className="text-muted-foreground">× {l.amountKey}</span>
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      amounts: {r.requirements.amountKeys.join(', ')}
                      {r.requirements.accountKeys.length ? (
                        <div>accounts: {r.requirements.accountKeys.join(', ')}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === 'ACTIVE' ? 'success' : 'secondary'}>
                        {titleCase(r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSimulating(r)}
                          data-testid="posting-rule-simulate"
                        >
                          <FlaskConical /> Try
                        </Button>
                        {canManage ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await update.mutateAsync({
                                  id: r.id,
                                  status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                                });
                              } catch (err) {
                                toast.error(describeError(err));
                              }
                            }}
                          >
                            {r.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <PostingRuleDialog open={creating} onClose={() => setCreating(false)} />
      <SimulateDialog rule={simulating} onClose={() => setSimulating(null)} currency={currency} />
    </>
  );
}

function PostingRuleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreatePostingRule();
  const form = useForm<RuleFormInput, unknown, PostingRuleInput>({
    resolver: zodResolver(postingRuleSchema),
    defaultValues: {
      transactionType: '',
      name: '',
      description: '',
      journalType: 'GENERAL',
      status: 'ACTIVE',
      lines: [
        emptyRuleLine(),
        {
          ...emptyRuleLine(),
          side: 'CREDIT',
          accountSource: 'CONTEXT',
          accountKey: 'REVENUE',
          amountKey: 'NET',
        },
      ],
    },
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const submit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values);
      toast.success('Posting rule created.');
      form.reset();
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>New posting rule</DialogTitle>
          <DialogDescription>
            Amount keys (NET, TAX, GROSS...) and context account keys are what the calling module
            supplies at posting time.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 md:grid-cols-3">
              <FormField
                control={form.control}
                name="transactionType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Transaction type</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="CUSTOMER_INVOICE"
                        data-testid="posting-rule-type"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-24">Side</TableHead>
                  <TableHead className="w-32">Account from</TableHead>
                  <TableHead className="min-w-[220px]">Mapping / account / key</TableHead>
                  <TableHead className="w-32">Amount key</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.fields.map((f, i) => {
                  const source = form.watch(`lines.${i}.accountSource`);
                  return (
                    <TableRow key={f.id} className="hover:bg-transparent">
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`lines.${i}.side`}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {POSTING_SIDES.map((s) => (
                                  <SelectItem key={s} value={s}>
                                    {titleCase(s)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`lines.${i}.accountSource`}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {POSTING_RULE_ACCOUNT_SOURCES.map((s) => (
                                  <SelectItem key={s} value={s}>
                                    {titleCase(s)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        {source === 'MAPPING' ? (
                          <FormField
                            control={form.control}
                            name={`lines.${i}.mappingKey`}
                            render={({ field }) => (
                              <Select
                                value={field.value ?? undefined}
                                onValueChange={field.onChange}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Mapping key" />
                                </SelectTrigger>
                                <SelectContent>
                                  {ACCOUNT_MAPPING_KEYS.map((k) => (
                                    <SelectItem key={k} value={k}>
                                      {k}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        ) : source === 'ACCOUNT' ? (
                          <FormField
                            control={form.control}
                            name={`lines.${i}.accountId`}
                            render={({ field }) => (
                              <AccountCombobox
                                value={field.value}
                                onChange={(id) => field.onChange(id)}
                              />
                            )}
                          />
                        ) : (
                          <FormField
                            control={form.control}
                            name={`lines.${i}.accountKey`}
                            render={({ field }) => (
                              <Input
                                placeholder="REVENUE"
                                {...field}
                                value={field.value ?? ''}
                                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                              />
                            )}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`lines.${i}.amountKey`}
                          render={({ field }) => (
                            <Input
                              {...field}
                              onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => lines.remove(i)}
                          disabled={lines.fields.length <= 2}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {form.formState.errors.lines ? (
              <p className="text-xs text-destructive">
                Check every line has its account source filled in.
              </p>
            ) : null}
            <div className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => lines.append(emptyRuleLine())}
              >
                <Plus /> Add line
              </Button>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending} data-testid="posting-rule-save">
                  Create rule
                </Button>
              </DialogFooter>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function SimulateDialog({
  rule,
  onClose,
  currency,
}: {
  rule: PostingRule | null;
  onClose: () => void;
  currency: string;
}) {
  const simulate = useSimulatePostingRule();
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [accounts, setAccounts] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<ResolvedPostingRule | null>(null);
  React.useEffect(() => {
    setAmounts(Object.fromEntries((rule?.requirements.amountKeys ?? []).map((k) => [k, '0'])));
    setAccounts({});
    setResult(null);
  }, [rule]);
  const run = async () => {
    if (!rule) return;
    try {
      setResult(await simulate.mutateAsync({ id: rule.id, amounts, accounts }));
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={Boolean(rule)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Try {rule?.transactionType}</DialogTitle>
          <DialogDescription>
            Resolve the rule against sample amounts - nothing is posted.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          {rule?.requirements.amountKeys.map((k) => (
            <div key={k} className="space-y-1">
              <label className="text-xs text-muted-foreground">{k}</label>
              <Input
                inputMode="decimal"
                value={amounts[k] ?? '0'}
                onChange={(e) => setAmounts({ ...amounts, [k]: e.target.value })}
                data-testid={`simulate-${k}`}
              />
            </div>
          ))}
          {rule?.requirements.accountKeys.map((k) => (
            <div key={k} className="space-y-1">
              <label className="text-xs text-muted-foreground">account: {k}</label>
              <AccountCombobox
                value={accounts[k]}
                onChange={(id) => setAccounts({ ...accounts, [k]: id })}
              />
            </div>
          ))}
        </div>
        <Button onClick={() => void run()} loading={simulate.isPending} data-testid="simulate-run">
          Resolve
        </Button>
        {result ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {result.accounts[i]?.code}
                    </span>
                    {result.accounts[i]?.name}
                  </TableCell>
                  <TableCell>
                    <Amount value={l.debit} currency={currency} zeroAsDash />
                  </TableCell>
                  <TableCell>
                    <Amount value={l.credit} currency={currency} zeroAsDash />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DimensionRulesTab({ canManage }: { canManage: boolean }) {
  const rules = useDimensionRules();
  const create = useCreateDimensionRule();
  const update = useUpdateDimensionRule();
  const [open, setOpen] = React.useState(false);
  const form = useForm<DimRuleFormInput, unknown, DimensionRuleInput>({
    resolver: zodResolver(dimensionRuleSchema),
    defaultValues: {
      name: '',
      scope: 'ACCOUNT',
      accountId: null,
      accountType: null,
      codePrefix: '',
      dimensionType: 'DEPARTMENT',
      status: 'ACTIVE',
    },
  });
  const scope = form.watch('scope');
  const submit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values);
      toast.success('Dimension rule created.');
      form.reset();
      setOpen(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <>
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => setOpen(true)} data-testid="dimension-rule-new">
            <Plus /> New dimension rule
          </Button>
        </div>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {rules.isLoading ? (
            <TableSkeleton columns={4} rows={3} />
          ) : !rules.data?.length ? (
            <EmptyState
              title="No dimension rules"
              description="Rules make the posting engine reject lines that miss a required dimension."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Rule</TableHead>
                  <TableHead>Applies to</TableHead>
                  <TableHead>Requires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-sm">
                      {r.scope === 'ACCOUNT'
                        ? `Account ${r.accountCode}`
                        : r.scope === 'ACCOUNT_TYPE'
                          ? `Every ${titleCase(r.accountType ?? '')} account`
                          : `Accounts starting with ${r.codePrefix}`}
                    </TableCell>
                    <TableCell>{DIMENSION_LABEL[r.dimensionType]}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === 'ACTIVE' ? 'success' : 'secondary'}>
                        {titleCase(r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              await update.mutateAsync({
                                id: r.id,
                                status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              });
                            } catch (err) {
                              toast.error(describeError(err));
                            }
                          }}
                        >
                          {r.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New dimension rule</DialogTitle>
            <DialogDescription>
              Enforced before any ledger row is written, for manual journals and every module.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={submit} className="space-y-3" noValidate>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input data-testid="dimension-rule-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="scope"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Applies to</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DIMENSION_RULE_SCOPES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {titleCase(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {scope === 'ACCOUNT' ? (
                <FormField
                  control={form.control}
                  name="accountId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Account</FormLabel>
                      <AccountCombobox value={field.value} onChange={(id) => field.onChange(id)} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : scope === 'ACCOUNT_TYPE' ? (
                <FormField
                  control={form.control}
                  name="accountType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Account type</FormLabel>
                      <Select value={field.value ?? undefined} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ACCOUNT_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {titleCase(t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <FormField
                  control={form.control}
                  name="codePrefix"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Code prefix</FormLabel>
                      <FormControl>
                        <Input placeholder="61" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="dimensionType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Required dimension</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DIMENSION_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {DIMENSION_LABEL[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending} data-testid="dimension-rule-save">
                  Create rule
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
