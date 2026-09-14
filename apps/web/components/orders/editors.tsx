'use client';
/* New / edit screens for orders. Route files under /sales and /purchasing wrap these. */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Skeleton } from '@accounting/ui';
import { toast } from 'sonner';
import { describeError } from '@/lib/api/client';
import { useCreateOrder, useOrder, useUpdateOrder } from '@/lib/api/orders-hooks';
import { useSession } from '@/lib/auth/session';
import type { OrderConfig } from '@/lib/orders/config';
import { PageHeader } from '@/components/ui-ext/page';
import { OrderForm } from './order-form';

function useCurrency() {
  const { activeCompany } = useSession();
  return activeCompany?.baseCurrency ?? 'PHP';
}

export function NewOrderScreen({ cfg }: { cfg: OrderConfig }) {
  const router = useRouter();
  const params = useSearchParams();
  const currency = useCurrency();
  const create = useCreateOrder(cfg);
  const initialPartyId =
    params.get(cfg.subledger.side === 'AR' ? 'customerId' : 'vendorId') ?? undefined;
  return (
    <>
      <PageHeader
        title={`New ${cfg.singular.toLowerCase()}`}
        description={`Amounts in ${currency}. Saved as a draft; no ledger effect.`}
      />
      <OrderForm
        cfg={cfg}
        initialPartyId={initialPartyId}
        currency={currency}
        submitting={create.isPending}
        onCancel={() => router.push(cfg.path)}
        onSubmit={async (values) => {
          try {
            const created = await create.mutateAsync({
              ...values,
              idempotencyKey: crypto.randomUUID(),
            });
            toast.success(`${created.documentNumber} saved as draft.`);
            router.push(`${cfg.path}/${created.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

export function EditOrderScreen({ cfg, id }: { cfg: OrderConfig; id: string }) {
  const router = useRouter();
  const currency = useCurrency();
  const order = useOrder(cfg, id);
  const update = useUpdateOrder(cfg);
  const locked = order.data && order.data.status !== 'DRAFT' && order.data.status !== 'REJECTED';
  React.useEffect(() => {
    if (locked) router.replace(`${cfg.path}/${id}`);
  }, [locked, router, cfg.path, id]);
  if (order.isLoading || !order.data || locked) return <Skeleton className="h-96" />;
  const o = order.data;
  return (
    <>
      <PageHeader
        title={`Edit ${o.documentNumber}`}
        description="Only drafts (and rejected requests) can be edited."
      />
      <OrderForm
        cfg={cfg}
        order={o}
        currency={currency}
        submitting={update.isPending}
        onCancel={() => router.push(`${cfg.path}/${o.id}`)}
        onSubmit={async (values) => {
          try {
            await update.mutateAsync({ id: o.id, ...values });
            toast.success(`${o.documentNumber} updated.`);
            router.push(`${cfg.path}/${o.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
