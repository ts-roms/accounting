'use client';
import * as React from 'react';
import Link from 'next/link';
import { BookOpenText, Lock, MoreHorizontal, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { ACCOUNT_MAPPING_KEYS, ACCOUNT_TYPES, P, type AccountType } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  cn,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAccountMappings,
  useAccounts,
  useDeleteAccount,
  useSetAccountMapping,
  useUpdateAccount,
} from '@/lib/api/accounting-hooks';
import type { AccountNode } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import {
  Can,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  TableSkeleton,
} from '@/components/ui-ext/page';
import { AccountCombobox } from '@/components/accounting/primitives';
import { AccountDialog } from './account-dialog';

const TYPE_VARIANT: Record<
  AccountType,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  ASSET: 'default',
  LIABILITY: 'warning',
  EQUITY: 'secondary',
  REVENUE: 'success',
  COST_OF_SALES: 'destructive',
  EXPENSE: 'destructive',
};

export default function ChartOfAccountsPage() {
  const { hasPermission } = useSession();
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState<string>('ALL');
  const [status, setStatus] = React.useState<string>('ACTIVE');
  const accounts = useAccounts({
    search: search || undefined,
    type: type === 'ALL' ? undefined : (type as AccountType),
    status: status === 'ALL' ? undefined : (status as 'ACTIVE' | 'INACTIVE'),
  });
  const update = useUpdateAccount();
  const remove = useDeleteAccount();
  const [dialog, setDialog] = React.useState<{
    open: boolean;
    account?: AccountNode;
    parent?: AccountNode;
  }>({ open: false });
  const [confirm, setConfirm] = React.useState<{
    account: AccountNode;
    action: 'deactivate' | 'activate' | 'delete';
  } | null>(null);
  const canManage = hasPermission(P['account.manage']);

  const onConfirm = async () => {
    if (!confirm) return;
    try {
      if (confirm.action === 'delete') {
        await remove.mutateAsync(confirm.account.id);
        toast.success(`Account ${confirm.account.code} deleted.`);
      } else {
        await update.mutateAsync({
          id: confirm.account.id,
          status: confirm.action === 'deactivate' ? 'INACTIVE' : 'ACTIVE',
        });
        toast.success(`Account ${confirm.account.code} ${confirm.action}d.`);
      }
      setConfirm(null);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="Hierarchical ledger accounts. Header accounts group their children and cannot be posted to."
        actions={
          <Can permissions={[P['account.manage']]}>
            <Button onClick={() => setDialog({ open: true })}>
              <Plus /> New account
            </Button>
          </Can>
        }
      />
      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="mappings">Account mappings</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code or name"
                className="w-64 pl-8"
              />
            </div>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types</SelectItem>
                {ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md border bg-card">
            {accounts.isLoading ? (
              <TableSkeleton columns={5} rows={10} />
            ) : accounts.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-28">Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-32">Type</TableHead>
                    <TableHead className="w-44">Subtype</TableHead>
                    <TableHead className="w-24">Balance</TableHead>
                    <TableHead className="w-24">Status</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.data.map((a) => (
                    <TableRow key={a.id} className={cn(a.isHeader && 'bg-muted/30')}>
                      <TableCell className="font-mono text-xs">{a.code}</TableCell>
                      <TableCell>
                        <div
                          className="flex items-center gap-1.5"
                          style={{ paddingLeft: `${a.level * 16}px` }}
                        >
                          {a.isHeader ? (
                            <BookOpenText className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : null}
                          <span className={cn(a.isHeader && 'font-semibold')}>{a.name}</span>
                          {a.isSystem ? (
                            <Lock
                              className="h-3 w-3 text-muted-foreground"
                              aria-label="System account"
                            />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={TYPE_VARIANT[a.type]}>{titleCase(a.type)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.subtype ? titleCase(a.subtype) : '-'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {a.normalBalance === 'DEBIT' ? 'Dr' : 'Cr'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.status === 'ACTIVE' ? 'success' : 'secondary'}>
                          {a.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label="Account actions">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!a.isHeader ? (
                              <DropdownMenuItem asChild>
                                <Link href={`/accounting/general-ledger?accountId=${a.id}`}>
                                  View ledger
                                </Link>
                              </DropdownMenuItem>
                            ) : null}
                            {canManage ? (
                              <>
                                <DropdownMenuItem
                                  onSelect={() => setDialog({ open: true, account: a })}
                                >
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => setDialog({ open: true, parent: a })}
                                >
                                  Add child account
                                </DropdownMenuItem>
                                {!a.isSystem ? (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      setConfirm({
                                        account: a,
                                        action: a.status === 'ACTIVE' ? 'deactivate' : 'activate',
                                      })
                                    }
                                  >
                                    {a.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                                  </DropdownMenuItem>
                                ) : null}
                                {!a.isSystem ? (
                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onSelect={() => setConfirm({ account: a, action: 'delete' })}
                                  >
                                    Delete (unused only)
                                  </DropdownMenuItem>
                                ) : null}
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                className="border-0"
                title="No accounts"
                description="Create the first account or adjust the filters."
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="mappings">
          <MappingsCard editable={canManage} />
        </TabsContent>
      </Tabs>

      <AccountDialog
        open={dialog.open}
        account={dialog.account}
        parent={dialog.parent}
        onOpenChange={(open) => setDialog({ open })}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm
            ? `${titleCase(confirm.action)} ${confirm.account.code} ${confirm.account.name}?`
            : ''
        }
        description={
          confirm?.action === 'delete'
            ? 'Only accounts without any journal activity can be deleted. Otherwise deactivate the account to keep history intact.'
            : confirm?.action === 'deactivate'
              ? 'Inactive accounts cannot receive new postings. Existing history is preserved.'
              : 'The account will accept postings again.'
        }
        confirmLabel={confirm ? titleCase(confirm.action) : 'Confirm'}
        destructive={confirm?.action !== 'activate'}
        loading={update.isPending || remove.isPending}
        onConfirm={onConfirm}
      />
    </>
  );
}

function MappingsCard({ editable }: { editable: boolean }) {
  const mappings = useAccountMappings();
  const setMapping = useSetAccountMapping();
  const byKey = new Map((mappings.data ?? []).map((m) => [m.key, m]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account mappings</CardTitle>
        <CardDescription>
          Business modules resolve ledger accounts through these keys instead of hard-coded ids.
          Retained earnings is required for year-end closing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-72">Mapping</TableHead>
              <TableHead>Account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ACCOUNT_MAPPING_KEYS.map((key) => {
              const current = byKey.get(key);
              return (
                <TableRow key={key}>
                  <TableCell>
                    <div className="font-medium">{titleCase(key)}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{key}</div>
                  </TableCell>
                  <TableCell>
                    {editable ? (
                      <AccountCombobox
                        value={current?.accountId ?? null}
                        placeholder="Not mapped"
                        className="max-w-md"
                        onChange={async (accountId) => {
                          try {
                            await setMapping.mutateAsync({ key, accountId });
                            toast.success(`${titleCase(key)} mapped.`);
                          } catch (err) {
                            toast.error(describeError(err));
                          }
                        }}
                      />
                    ) : current ? (
                      <span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {current.accountCode}
                        </span>{' '}
                        {current.accountName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not mapped</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
