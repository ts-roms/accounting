'use client';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { DIMENSION_TYPES, P, type DimensionType } from '@accounting/types';
import { createDimensionSchema, type CreateDimensionInput } from '@accounting/validation';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateDimension,
  useDimensions,
  useUpdateDimension,
} from '@/lib/api/budgeting-tax-hooks';
import type { Dimension } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { DIMENSION_LABEL, DimensionSelect } from './pickers';

type DimensionFormInput = z.input<typeof createDimensionSchema>;

export function DimensionsPage() {
  const { hasPermission } = useSession();
  const [type, setType] = React.useState<DimensionType>('DEPARTMENT');
  const dims = useDimensions(type);
  const update = useUpdateDimension();
  const [dialog, setDialog] = React.useState<{ open: boolean; dimension?: Dimension }>({
    open: false,
  });
  const canManage = hasPermission(P['dimension.manage']);
  return (
    <>
      <PageHeader
        title="Dimensions"
        description="Departments, cost centers and projects tag journal lines for cost accounting and budget variance. A line can carry one of each."
        actions={
          <Can permissions={[P['dimension.manage']]}>
            <Button onClick={() => setDialog({ open: true })} data-testid="new-dimension">
              <Plus /> New {DIMENSION_LABEL[type].toLowerCase()}
            </Button>
          </Can>
        }
      />
      <Tabs value={type} onValueChange={(v) => setType(v as DimensionType)}>
        <TabsList>
          {DIMENSION_TYPES.map((t) => (
            <TabsTrigger key={t} value={t}>
              {DIMENSION_LABEL[t]}s
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {dims.isLoading ? (
        <TableSkeleton columns={5} />
      ) : dims.data?.length === 0 ? (
        <EmptyState title={`No ${DIMENSION_LABEL[type].toLowerCase()}s`} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Parent</TableHead>
                  {type === 'PROJECT' ? <TableHead>Dates</TableHead> : null}
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage ? <TableHead className="w-32" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {dims.data?.map((d) => (
                  <TableRow key={d.id} data-testid="dimension-row">
                    <TableCell className="font-mono text-xs">{d.code}</TableCell>
                    <TableCell>
                      <div className="font-medium">{d.name}</div>
                      {d.description ? (
                        <div className="text-xs text-muted-foreground">{d.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.parentCode ?? '-'}</TableCell>
                    {type === 'PROJECT' ? (
                      <TableCell className="text-xs">
                        {d.startDate ?? '…'} → {d.endDate ?? '…'}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right tabular">{d.usageCount}</TableCell>
                    <TableCell>
                      <Badge variant={d.status === 'ACTIVE' ? 'success' : 'secondary'}>
                        {d.status}
                      </Badge>
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ open: true, dimension: d })}
                        >
                          <Pencil /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await update.mutateAsync({
                                id: d.id,
                                status: d.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              });
                            } catch (err) {
                              toast.error(describeError(err));
                            }
                          }}
                        >
                          {d.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <DimensionDialog
        type={type}
        open={dialog.open}
        dimension={dialog.dimension}
        onOpenChange={(open) => setDialog({ open })}
      />
    </>
  );
}

function DimensionDialog({
  type,
  open,
  dimension,
  onOpenChange,
}: {
  type: DimensionType;
  open: boolean;
  dimension?: Dimension;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateDimension();
  const update = useUpdateDimension();
  const defaults = React.useCallback(
    (): DimensionFormInput => ({
      dimensionType: type,
      code: dimension?.code ?? '',
      name: dimension?.name ?? '',
      description: dimension?.description ?? undefined,
      parentId: dimension?.parentId ?? null,
      startDate: dimension?.startDate ?? undefined,
      endDate: dimension?.endDate ?? undefined,
    }),
    [type, dimension],
  );
  const form = useForm<DimensionFormInput, unknown, CreateDimensionInput>({
    resolver: zodResolver(createDimensionSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      if (dimension) {
        const { dimensionType: _t, code: _c, ...rest } = values;
        await update.mutateAsync({ id: dimension.id, ...rest });
      } else await create.mutateAsync(values);
      toast.success(dimension ? 'Updated.' : `${DIMENSION_LABEL[type]} created.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {dimension ? `Edit ${dimension.code}` : `New ${DIMENSION_LABEL[type].toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            Codes are unique per type; a parent must be of the same type.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-[130px_1fr]">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        className="font-mono uppercase"
                        disabled={Boolean(dimension)}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        data-testid="dimension-code"
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
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="dimension-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="parentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Parent</FormLabel>
                  <DimensionSelect
                    type={type}
                    value={field.value}
                    onChange={(id) => field.onChange(id)}
                    placeholder="No parent"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            {type === 'PROJECT' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {(['startDate', 'endDate'] as const).map((name) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{name === 'startDate' ? 'Start' : 'End'}</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            {...field}
                            value={field.value ?? ''}
                            onChange={(e) => field.onChange(e.target.value || undefined)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
              </div>
            ) : null}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || update.isPending}
                data-testid="dimension-save"
              >
                {dimension ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
