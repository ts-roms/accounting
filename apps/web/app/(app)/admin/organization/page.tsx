'use client';
import * as React from 'react';
import { Building2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { P } from '@accounting/types';
import { updateOrganizationSchema, type UpdateOrganizationInput } from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBranches, useCompanies, useOrganization, useUpdateOrganization } from '@/lib/api/hooks';
import type { Company } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { CompanyDialog } from './company-dialog';
import { BranchDialog } from './branch-dialog';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function OrganizationPage() {
  const { hasPermission } = useSession();
  const companies = useCompanies();
  const branches = useBranches();
  const [companyDialog, setCompanyDialog] = React.useState<{ open: boolean; company?: Company }>({
    open: false,
  });
  const [branchDialog, setBranchDialog] = React.useState<{ open: boolean; companyId?: string }>({
    open: false,
  });

  return (
    <>
      <PageHeader
        title="Organization"
        description="Tenant settings, legal entities (companies) and their branches."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Can permissions={[P['organization.view']]}>
          <OrganizationCard />
        </Can>
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Companies</CardTitle>
              <CardDescription>
                Each company keeps its own ledger, fiscal calendar and functional currency.
              </CardDescription>
            </div>
            <Can permissions={[P['company.manage']]}>
              <Button size="sm" onClick={() => setCompanyDialog({ open: true })}>
                <Plus /> New company
              </Button>
            </Can>
          </CardHeader>
          <CardContent>
            {companies.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>TIN</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>Fiscal year</TableHead>
                    <TableHead>Branches</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companies.data.map((c) => {
                    const count = branches.data?.filter((b) => b.companyId === c.id).length ?? 0;
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono text-xs">{c.code}</TableCell>
                        <TableCell>
                          <div className="font-medium">{c.name}</div>
                          {c.legalName && c.legalName !== c.name ? (
                            <div className="text-xs text-muted-foreground">{c.legalName}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {c.taxIdentificationNumber ?? '-'}
                        </TableCell>
                        <TableCell>{c.baseCurrency}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          starts {MONTHS[c.fiscalYearStartMonth - 1]}
                        </TableCell>
                        <TableCell className="tabular">{count}</TableCell>
                        <TableCell>
                          <Badge variant={c.status === 'ACTIVE' ? 'success' : 'secondary'}>
                            {c.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {hasPermission(P['company.manage']) ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setCompanyDialog({ open: true, company: c })}
                            >
                              Edit
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon={Building2}
                title="No companies yet"
                description="Create the first legal entity to start configuring accounting."
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle>Branches</CardTitle>
            <CardDescription>
              Operational locations within a company. Transactions can be attributed to a branch for
              reporting.
            </CardDescription>
          </div>
          <Can permissions={[P['branch.manage']]}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBranchDialog({ open: true })}
              disabled={!companies.data?.length}
            >
              <Plus /> New branch
            </Button>
          </Can>
        </CardHeader>
        <CardContent>
          {branches.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {branches.data.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">
                      {companies.data?.find((c) => c.id === b.companyId)?.code ?? '-'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{b.code}</TableCell>
                    <TableCell>
                      {b.name}{' '}
                      {b.isHeadOffice ? (
                        <Badge variant="outline" className="ml-1">
                          Head office
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {[b.city, b.province].filter(Boolean).join(', ') || '-'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={b.status === 'ACTIVE' ? 'success' : 'secondary'}>
                        {b.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              title="No branches"
              description="Add a head office and any regional branches."
            />
          )}
        </CardContent>
      </Card>

      <CompanyDialog
        open={companyDialog.open}
        company={companyDialog.company}
        onOpenChange={(open) => setCompanyDialog({ open })}
      />
      <BranchDialog
        open={branchDialog.open}
        companies={companies.data ?? []}
        onOpenChange={(open) => setBranchDialog({ open })}
      />
    </>
  );
}

function OrganizationCard() {
  const { hasPermission } = useSession();
  const org = useOrganization();
  const update = useUpdateOrganization();
  const form = useForm<UpdateOrganizationInput>({
    resolver: zodResolver(updateOrganizationSchema),
    values: org.data
      ? { name: org.data.name, baseCurrency: org.data.baseCurrency, timezone: org.data.timezone }
      : undefined,
  });
  const editable = hasPermission(P['organization.manage']);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync(values);
      toast.success('Organization updated.');
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          Reporting currency is used for future consolidation across companies.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} disabled={!editable} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="baseCurrency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reporting currency</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      disabled={!editable}
                      maxLength={3}
                      className="uppercase"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Timezone</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} disabled={!editable} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {editable ? (
              <Button
                type="submit"
                size="sm"
                loading={form.formState.isSubmitting}
                disabled={!form.formState.isDirty}
              >
                Save
              </Button>
            ) : null}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
