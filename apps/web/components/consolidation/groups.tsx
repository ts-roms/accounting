'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Building2, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import type {
  ConsolidationMethod,
  EliminationRuleType,
  TranslationMethod,
} from '@accounting/types';
import {
  CONSOLIDATION_METHODS,
  ELIMINATION_RULE_TYPES,
  P,
  TRANSLATION_METHODS,
} from '@accounting/types';
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
  Switch,
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
  useAddGroupMember,
  useConsolidationGroup,
  useConsolidationGroups,
  useConsolidationRuns,
  useCreateConsolidationGroup,
  useCreateConsolidationRun,
  useCreateEliminationRule,
  useGroupReadiness,
  useRemoveGroupMember,
  useSeedDefaultRules,
  useUpdateConsolidationGroup,
  useUpdateEliminationRule,
} from '@/lib/api/consolidation-hooks';
import type {
  ConsolidationGroup,
  EliminationRule,
  GroupMember,
} from '@/lib/api/consolidation-types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { DescriptionList, Field, Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

const RULE_LABEL: Record<EliminationRuleType, string> = {
  INTERCOMPANY_BALANCES: 'Intercompany balances',
  INTERCOMPANY_PROFIT_LOSS: 'Intercompany revenue / expense',
  INVESTMENT_EQUITY: 'Investment vs equity, goodwill, NCI',
  UNREALIZED_PROFIT: 'Unrealized profit in inventory',
  CUSTOM: 'Custom template',
};

// ------------------------------------------------------------------- list

export function ConsolidationGroupsPage() {
  const router = useRouter();
  const groups = useConsolidationGroups();
  const [create, setCreate] = React.useState(false);
  return (
    <>
      <PageHeader
        title="Consolidation Groups"
        description="A group is a parent entity plus the members it consolidates - fully, proportionally or by the equity method - into a presentation currency, with the elimination rules that run every group close."
        actions={
          <Can permissions={[P['consolidation.manage']]}>
            <Button size="sm" onClick={() => setCreate(true)}>
              <Plus /> New group
            </Button>
          </Can>
        }
      />
      <QueryState query={groups}>
        {(list) =>
          list.length ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((g) => (
                <Card
                  key={g.id}
                  className="cursor-pointer transition-colors duration-fast hover:bg-muted/40"
                  onClick={() => router.push(`/consolidation/groups/${g.id}`)}
                >
                  <CardHeader className="flex-row items-start justify-between space-y-0">
                    <div>
                      <CardTitle className="text-sm">
                        {g.code} {g.name}
                      </CardTitle>
                      <CardDescription>
                        Parent {g.parentCompanyCode} - {g.presentationCurrency} -{' '}
                        {titleCase(g.translationMethod)}
                      </CardDescription>
                    </div>
                    <StatusBadge status={g.status} />
                  </CardHeader>
                  <CardContent>
                    <DescriptionList
                      items={[
                        [
                          'Members',
                          g.members
                            .map((m) => `${m.companyCode} ${Number(m.ownershipPercent)}%`)
                            .join(', '),
                        ],
                        ['Rules', `${g.rules.filter((r) => r.active).length} active`],
                        ['Runs', String(g.runCount)],
                      ]}
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Building2}
              title="No consolidation groups"
              description="Create a group around the parent entity, then add the subsidiaries."
            />
          )
        }
      </QueryState>
      <NewGroupDialog
        open={create}
        onOpenChange={setCreate}
        onCreated={(id) => router.push(`/consolidation/groups/${id}`)}
      />
    </>
  );
}

function NewGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { me } = useSession();
  const create = useCreateConsolidationGroup();
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [parentCompanyId, setParent] = React.useState('');
  const [currency, setCurrency] = React.useState('');
  const [method, setMethod] = React.useState<TranslationMethod>('CURRENT_RATE');
  const [tolerance, setTolerance] = React.useState('0');
  const [requireClosed, setRequireClosed] = React.useState(true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New consolidation group</DialogTitle>
          <DialogDescription>
            The parent&apos;s chart of accounts presents the group; its account mappings
            (investment, goodwill, NCI, CTA...) supply the posting codes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ACME-GROUP"
              aria-label="Group code"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
          </Field>
          <Field label="Parent entity">
            <Select value={parentCompanyId} onValueChange={setParent}>
              <SelectTrigger aria-label="Parent entity">
                <SelectValue placeholder="Company" />
              </SelectTrigger>
              <SelectContent>
                {me.companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Presentation currency" hint="Blank = the parent's base currency">
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="PHP"
            />
          </Field>
          <Field label="Translation method">
            <Select value={method} onValueChange={(v) => setMethod(v as TranslationMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSLATION_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {titleCase(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Intercompany tolerance">
            <Input
              inputMode="decimal"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox
              checked={requireClosed}
              onCheckedChange={(v) => setRequireClosed(v === true)}
            />{' '}
            Members&apos; fiscal periods must be closed before finalizing
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!code || !name || !parentCompanyId || create.isPending}
            onClick={async () => {
              try {
                const g = await create.mutateAsync({
                  code,
                  name,
                  parentCompanyId,
                  presentationCurrency: currency || undefined,
                  translationMethod: method,
                  intercompanyTolerance: tolerance || undefined,
                  requirePeriodsClosed: requireClosed,
                });
                toast.success(`Group ${g.code} created.`);
                onOpenChange(false);
                onCreated(g.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------- detail

export function ConsolidationGroupDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const group = useConsolidationGroup(id);
  const runs = useConsolidationRuns({ groupId: id, pageSize: 25 });
  const update = useUpdateConsolidationGroup();
  const createRun = useCreateConsolidationRun();
  const seed = useSeedDefaultRules();
  const [addMember, setAddMember] = React.useState(false);
  const [addRule, setAddRule] = React.useState(false);
  const [periodEnd, setPeriodEnd] = React.useState(today());
  const readiness = useGroupReadiness(id, `${periodEnd.slice(0, 4)}-01-01`, periodEnd);
  return (
    <QueryState query={group}>
      {(g) => (
        <>
          <PageHeader
            title={`${g.code} ${g.name}`}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={g.status} /> Parent {g.parentCompanyCode} - presented in{' '}
                {g.presentationCurrency} - {titleCase(g.translationMethod)}
              </span>
            }
            actions={
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/consolidation/groups">
                    <ArrowLeft /> Groups
                  </Link>
                </Button>
                <Can permissions={[P['consolidation.run']]}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="date"
                      value={periodEnd}
                      onChange={(e) => setPeriodEnd(e.target.value)}
                      className="w-40"
                      aria-label="Period end"
                    />
                    <Button
                      size="sm"
                      disabled={createRun.isPending || g.status !== 'ACTIVE'}
                      onClick={async () => {
                        try {
                          const run = await createRun.mutateAsync({ groupId: g.id, periodEnd });
                          toast.success(`${run.documentNumber} prepared from the member ledgers.`);
                          router.push(`/consolidation/runs/${run.id}`);
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      <Plus /> New run
                    </Button>
                  </div>
                </Can>
              </>
            }
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Members"
              value={g.members.length}
              hint={g.members.map((m) => m.companyCode).join(', ')}
            />
            <Kpi
              label="Active rules"
              value={g.rules.filter((r) => r.active).length}
              hint={`${g.rules.length} defined`}
            />
            <Kpi
              label="Runs"
              value={g.runCount}
              hint={
                runs.data?.items[0]
                  ? `latest ${runs.data.items[0].documentNumber} (${runs.data.items[0].status.toLowerCase()})`
                  : 'none yet'
              }
            />
            <Kpi
              label="Close readiness"
              value={readiness.data ? (readiness.data.ready ? 'Ready' : 'Blocked') : '-'}
              raw
              tone={readiness.data ? (readiness.data.ready ? 'success' : 'danger') : undefined}
              hint={`year to ${periodEnd}`}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">Members</CardTitle>
                  <CardDescription>
                    Method, ownership and acquisition data drive eliminations and non-controlling
                    interest.
                  </CardDescription>
                </div>
                <Can permissions={[P['consolidation.manage']]}>
                  <Button size="sm" variant="outline" onClick={() => setAddMember(true)}>
                    <Plus /> Member
                  </Button>
                </Can>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Entity</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Owned</TableHead>
                      <TableHead>Acquired</TableHead>
                      <TableHead className="text-right">Investment</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.members.map((m) => (
                      <MemberRow key={m.id} group={g} member={m} />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">Elimination rules</CardTitle>
                  <CardDescription>
                    Applied automatically when a run is prepared; switch a rule off to keep it for
                    later.
                  </CardDescription>
                </div>
                <Can permissions={[P['consolidation.manage']]}>
                  <div className="flex gap-2">
                    {!g.rules.length ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={seed.isPending}
                        onClick={async () => {
                          try {
                            await seed.mutateAsync(g.id);
                            toast.success('Default rules added.');
                          } catch (err) {
                            toast.error(describeError(err));
                          }
                        }}
                      >
                        <Sparkles /> Defaults
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={() => setAddRule(true)}>
                      <Plus /> Rule
                    </Button>
                  </div>
                </Can>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Rule</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Active</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.rules.map((r) => (
                      <RuleRow key={r.id} group={g} rule={r} />
                    ))}
                    {!g.rules.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          No rules: runs will only translate and combine.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Group close readiness</CardTitle>
                <CardDescription>
                  What must hold before a run to {periodEnd} can be finalized.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {(readiness.data?.items ?? []).map((i) => (
                      <TableRow key={i.key}>
                        <TableCell>
                          <div className="text-sm">{i.label}</div>
                          {i.detail ? (
                            <div className="text-xs text-muted-foreground">{i.detail}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <StatusBadge status={i.ok ? 'OK' : i.blocking ? 'CRITICAL' : 'WARNING'} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Policy and accounts</CardTitle>
                <CardDescription>
                  Group accounts come from the parent chart; policy is stored, never coded.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <DescriptionList
                  items={[
                    [
                      'Intercompany tolerance',
                      formatMoney(g.intercompanyTolerance, g.presentationCurrency),
                    ],
                    ['Investment', g.accounts.investment],
                    ['Goodwill', g.accounts.goodwill],
                    ['Non-controlling interest', g.accounts.nonControllingInterest],
                    ['Translation adjustment', g.accounts.cumulativeTranslationAdjustment],
                    ['Retained earnings', g.accounts.retainedEarnings],
                    ['Intercompany difference', g.accounts.intercompanyDifference],
                    ['Share of associate profit', g.accounts.shareOfAssociateProfit],
                  ]}
                />
                <Can permissions={[P['consolidation.manage']]}>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={g.requirePeriodsClosed}
                      onCheckedChange={async (v) => {
                        try {
                          await update.mutateAsync({ id: g.id, requirePeriodsClosed: v });
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                      aria-label="Require closed periods"
                    />
                    Require members&apos; periods closed before finalizing
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={g.status === 'ACTIVE'}
                      onCheckedChange={async (v) => {
                        try {
                          await update.mutateAsync({ id: g.id, status: v ? 'ACTIVE' : 'INACTIVE' });
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                      aria-label="Group active"
                    />
                    Group active
                  </label>
                </Can>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Consolidation runs</CardTitle>
              <CardDescription>Fiscal-year-to-date closes of this group.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Run</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Adjustments</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runs.data?.items ?? []).map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/consolidation/runs/${r.id}`)}
                    >
                      <TableCell className="font-mono text-sm">{r.documentNumber}</TableCell>
                      <TableCell>
                        {r.periodStart} to {r.periodEnd}
                      </TableCell>
                      <TableCell>{r.adjustmentCount}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {!runs.data?.items.length ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        No runs yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <AddMemberDialog group={g} open={addMember} onOpenChange={setAddMember} />
          <AddRuleDialog group={g} open={addRule} onOpenChange={setAddRule} />
        </>
      )}
    </QueryState>
  );
}

function MemberRow({ group, member: m }: { group: ConsolidationGroup; member: GroupMember }) {
  const remove = useRemoveGroupMember();
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">
          {m.companyCode}{' '}
          {m.isParent ? <span className="ml-1 text-xs text-muted-foreground">parent</span> : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {m.companyName} - {m.currency}
        </div>
      </TableCell>
      <TableCell className="text-xs">{titleCase(m.method)}</TableCell>
      <TableCell className="text-right">{Number(m.ownershipPercent)}%</TableCell>
      <TableCell className="text-xs">{m.acquisitionDate ?? '-'}</TableCell>
      <TableCell>
        <Amount value={m.investmentCost} zeroAsDash />
      </TableCell>
      <TableCell className="text-right">
        {!m.isParent ? (
          <Can permissions={[P['consolidation.manage']]}>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ groupId: group.id, memberId: m.id });
                  toast.success(`${m.companyCode} removed from the group.`);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Remove
            </Button>
          </Can>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function RuleRow({ group, rule: r }: { group: ConsolidationGroup; rule: EliminationRule }) {
  const update = useUpdateEliminationRule();
  return (
    <TableRow className={r.active ? undefined : 'opacity-60'}>
      <TableCell>
        <div className="font-medium">
          {r.code} {r.name}
        </div>
        <div className="text-xs text-muted-foreground">{r.description ?? ''}</div>
      </TableCell>
      <TableCell className="text-xs">{RULE_LABEL[r.type]}</TableCell>
      <TableCell>
        <Can
          permissions={[P['consolidation.manage']]}
          fallback={<span className="text-xs">{r.active ? 'Yes' : 'No'}</span>}
        >
          <Switch
            checked={r.active}
            onCheckedChange={async (v) => {
              try {
                await update.mutateAsync({ groupId: group.id, ruleId: r.id, active: v });
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
            aria-label={`Toggle ${r.code}`}
          />
        </Can>
      </TableCell>
    </TableRow>
  );
}

function AddMemberDialog({
  group,
  open,
  onOpenChange,
}: {
  group: ConsolidationGroup;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { me } = useSession();
  const add = useAddGroupMember();
  const [companyId, setCompany] = React.useState('');
  const [method, setMethod] = React.useState<ConsolidationMethod>('FULL');
  const [percent, setPercent] = React.useState('100');
  const [acquisitionDate, setAcquisitionDate] = React.useState('');
  const [equity, setEquity] = React.useState('');
  const [investment, setInvestment] = React.useState('');
  const candidates = me.companies.filter((c) => !group.members.some((m) => m.companyId === c.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a member</DialogTitle>
          <DialogDescription>
            Full and proportional members bring their trial balance; equity-accounted members
            contribute the group&apos;s share of their result.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Entity">
              <Select value={companyId} onValueChange={setCompany}>
                <SelectTrigger aria-label="Member entity">
                  <SelectValue placeholder="Company" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Method">
            <Select value={method} onValueChange={(v) => setMethod(v as ConsolidationMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONSOLIDATION_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {titleCase(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Ownership %">
            <Input
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              aria-label="Ownership percent"
            />
          </Field>
          <Field label="Acquisition date">
            <Input
              type="date"
              value={acquisitionDate}
              onChange={(e) => setAcquisitionDate(e.target.value)}
            />
          </Field>
          <Field label="Equity at acquisition" hint="Member currency">
            <Input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} />
          </Field>
          <Field label="Investment cost" hint={`${group.parentCompanyCode} currency`}>
            <Input
              inputMode="decimal"
              value={investment}
              onChange={(e) => setInvestment(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!companyId || !percent || add.isPending}
            onClick={async () => {
              try {
                await add.mutateAsync({
                  groupId: group.id,
                  companyId,
                  method,
                  ownershipPercent: percent,
                  acquisitionDate: acquisitionDate || null,
                  acquisitionEquity: equity || undefined,
                  investmentCost: investment || undefined,
                });
                toast.success('Member added.');
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddRuleDialog({
  group,
  open,
  onOpenChange,
}: {
  group: ConsolidationGroup;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateEliminationRule();
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<EliminationRuleType>('INTERCOMPANY_PROFIT_LOSS');
  const [revenue, setRevenue] = React.useState('');
  const [expense, setExpense] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [inventory, setInventory] = React.useState('');
  const [cogs, setCogs] = React.useState('');
  const [lines, setLines] = React.useState('');
  const [description, setDescription] = React.useState('');
  const codes = (v: string) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New elimination rule</DialogTitle>
          <DialogDescription>
            Rules are data: account codes and amounts live here, the engine only applies them.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-label="Rule code"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Rule name" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Type">
              <Select value={type} onValueChange={(v) => setType(v as EliminationRuleType)}>
                <SelectTrigger aria-label="Rule type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ELIMINATION_RULE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {RULE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {type === 'INTERCOMPANY_PROFIT_LOSS' ? (
            <>
              <Field label="Revenue codes" hint="Comma-separated, in the selling entity">
                <Input
                  value={revenue}
                  onChange={(e) => setRevenue(e.target.value)}
                  placeholder="4980"
                />
              </Field>
              <Field label="Expense codes" hint="In the buying entity">
                <Input
                  value={expense}
                  onChange={(e) => setExpense(e.target.value)}
                  placeholder="6970"
                />
              </Field>
            </>
          ) : null}
          {type === 'UNREALIZED_PROFIT' ? (
            <>
              <Field label="Amount" hint={group.presentationCurrency}>
                <Input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label="Inventory code">
                <Input
                  value={inventory}
                  onChange={(e) => setInventory(e.target.value)}
                  placeholder="1300"
                />
              </Field>
              <Field label="Cost of sales code">
                <Input value={cogs} onChange={(e) => setCogs(e.target.value)} placeholder="5100" />
              </Field>
            </>
          ) : null}
          {type === 'CUSTOM' ? (
            <div className="sm:col-span-2">
              <Field label="Lines" hint="One per line: code, debit, credit (e.g. 6900,100,0)">
                <Textarea rows={3} value={lines} onChange={(e) => setLines(e.target.value)} />
              </Field>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!code || !name || create.isPending}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  groupId: group.id,
                  code,
                  name,
                  type,
                  description: description || undefined,
                  autoApply: true,
                  config: {
                    revenueCodes: type === 'INTERCOMPANY_PROFIT_LOSS' ? codes(revenue) : undefined,
                    expenseCodes: type === 'INTERCOMPANY_PROFIT_LOSS' ? codes(expense) : undefined,
                    amount: type === 'UNREALIZED_PROFIT' ? amount : undefined,
                    inventoryCode: type === 'UNREALIZED_PROFIT' ? inventory : undefined,
                    costOfSalesCode: type === 'UNREALIZED_PROFIT' ? cogs : undefined,
                    lines:
                      type === 'CUSTOM'
                        ? lines
                            .split('\n')
                            .map((l) => l.split(',').map((x) => x.trim()))
                            .filter((p) => p[0])
                            .map((p) => ({
                              accountCode: p[0]!,
                              debit: p[1] && Number(p[1]) ? p[1] : undefined,
                              credit: p[2] && Number(p[2]) ? p[2] : undefined,
                            }))
                        : undefined,
                  },
                });
                toast.success(`Rule ${code} added.`);
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
