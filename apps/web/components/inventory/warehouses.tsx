'use client';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MapPin, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { P } from '@accounting/types';
import {
  createLocationSchema,
  createWarehouseSchema,
  type CreateLocationInput,
  type CreateWarehouseInput,
} from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Skeleton,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAddLocation,
  useCreateWarehouse,
  useUpdateWarehouse,
  useWarehouses,
} from '@/lib/api/inventory-hooks';
import type { Warehouse } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';

type WarehouseFormInput = z.input<typeof createWarehouseSchema>;

export function WarehousesPage() {
  const { hasPermission } = useSession();
  const warehouses = useWarehouses();
  const update = useUpdateWarehouse();
  const [dialog, setDialog] = React.useState<{ open: boolean; warehouse?: Warehouse }>({
    open: false,
  });
  const [locationFor, setLocationFor] = React.useState<Warehouse | null>(null);
  const canManage = hasPermission(P['warehouse.manage']);

  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Where stock lives. Balances are kept per product, warehouse and lot; transfers move value between warehouses without touching the ledger."
        actions={
          <Can permissions={[P['warehouse.manage']]}>
            <Button onClick={() => setDialog({ open: true })}>
              <Plus /> New warehouse
            </Button>
          </Can>
        }
      />
      {warehouses.isLoading ? (
        <Skeleton className="h-48" />
      ) : warehouses.data?.length === 0 ? (
        <EmptyState
          title="No warehouses"
          description={
            canManage ? 'Create the first warehouse to start receiving stock.' : undefined
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {warehouses.data?.map((w) => (
            <Card key={w.id} data-testid="warehouse-card">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span>
                    <span className="mr-2 font-mono text-xs text-muted-foreground">{w.code}</span>
                    {w.name}
                  </span>
                  <Badge variant={w.status === 'ACTIVE' ? 'success' : 'secondary'}>
                    {w.status}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {[w.addressLine1, w.city].filter(Boolean).join(', ') || 'No address'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-muted-foreground">Stock value</span>
                  <Amount value={w.stockValue} className="font-semibold" zeroAsDash />
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    Locations
                  </div>
                  {w.locations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No bin locations.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {w.locations.map((l) => (
                        <Badge key={l.id} variant="outline" className="font-mono text-[10px]">
                          {l.code}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                {canManage ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDialog({ open: true, warehouse: w })}
                    >
                      <Pencil /> Edit
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setLocationFor(w)}>
                      <MapPin /> Add location
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await update.mutateAsync({
                            id: w.id,
                            status: w.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                          });
                          toast.success(
                            `${w.code} ${w.status === 'ACTIVE' ? 'deactivated' : 'activated'}.`,
                          );
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      {w.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <WarehouseDialog
        open={dialog.open}
        warehouse={dialog.warehouse}
        onOpenChange={(open) => setDialog({ open })}
      />
      <LocationDialog
        warehouse={locationFor}
        onOpenChange={(open) => !open && setLocationFor(null)}
      />
    </>
  );
}

function WarehouseDialog({
  open,
  warehouse,
  onOpenChange,
}: {
  open: boolean;
  warehouse?: Warehouse;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const defaults = React.useCallback(
    (): WarehouseFormInput => ({
      code: warehouse?.code ?? '',
      name: warehouse?.name ?? '',
      addressLine1: warehouse?.addressLine1 ?? undefined,
      city: warehouse?.city ?? undefined,
      notes: warehouse?.notes ?? undefined,
    }),
    [warehouse],
  );
  const form = useForm<WarehouseFormInput, unknown, CreateWarehouseInput>({
    resolver: zodResolver(createWarehouseSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      if (warehouse) await update.mutateAsync({ id: warehouse.id, ...values });
      else await create.mutateAsync({ ...values, code: values.code.toUpperCase() });
      toast.success(warehouse ? 'Warehouse updated.' : 'Warehouse created.');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const text = (
    name: keyof WarehouseFormInput,
    label: string,
    props?: React.ComponentProps<typeof Input>,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...props}
              {...field}
              value={(field.value as string | undefined) ?? ''}
              onChange={(e) =>
                field.onChange(name === 'code' ? e.target.value.toUpperCase() : e.target.value)
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{warehouse ? `Edit ${warehouse.code}` : 'New warehouse'}</DialogTitle>
          <DialogDescription>
            A warehouse holding stock cannot be deactivated until it is emptied.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {text('code', 'Code', {
              className: 'uppercase font-mono',
              disabled: Boolean(warehouse),
              placeholder: 'MAIN',
            })}
            {text('name', 'Name')}
            {text('addressLine1', 'Address')}
            {text('city', 'City')}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                {warehouse ? 'Save changes' : 'Create warehouse'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function LocationDialog({
  warehouse,
  onOpenChange,
}: {
  warehouse: Warehouse | null;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useAddLocation();
  const form = useForm<z.input<typeof createLocationSchema>, unknown, CreateLocationInput>({
    resolver: zodResolver(createLocationSchema),
    defaultValues: { code: '', name: '' },
  });
  React.useEffect(() => {
    if (warehouse) form.reset({ code: '', name: '' });
  }, [warehouse, form]);
  return (
    <Dialog open={Boolean(warehouse)} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add location to {warehouse?.code}</DialogTitle>
          <DialogDescription>
            Bin, rack or zone inside the warehouse. Optional on movements.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-3"
            noValidate
            onSubmit={form.handleSubmit(async (values) => {
              try {
                await add.mutateAsync({
                  warehouseId: warehouse!.id,
                  ...values,
                  code: values.code.toUpperCase(),
                });
                toast.success('Location added.');
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            })}
          >
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input
                      className="uppercase font-mono"
                      placeholder="A-01"
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
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                Add location
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
