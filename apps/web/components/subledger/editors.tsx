'use client';
/* New / edit screens for documents and payments. Route files under /sales and /purchasing are thin wrappers around these. */
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useAppRouter } from '@/lib/navigation/progress';
import { Skeleton } from '@accounting/ui';
import { toast } from 'sonner';
import { describeError } from '@/lib/api/client';
import {
  useCreateDocument,
  useCreatePayment,
  useDocument,
  usePayment,
  useUpdateDocument,
  useUpdatePayment,
} from '@/lib/api/subledger-hooks';
import { useSession } from '@/lib/auth/session';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { PageHeader } from '@/components/ui-ext/page';
import { DocumentForm } from './document-form';
import { WarningsAlert } from './document-detail';
import { PaymentForm } from './payment-form';

function useCurrency() {
  const { activeCompany } = useSession();
  return activeCompany?.baseCurrency ?? 'PHP';
}

export function NewDocumentScreen({ cfg }: { cfg: SubledgerConfig }) {
  const router = useAppRouter();
  const params = useSearchParams();
  const currency = useCurrency();
  const create = useCreateDocument(cfg);
  const initialPartyId = params.get(cfg.side === 'AR' ? 'customerId' : 'vendorId') ?? undefined;

  return (
    <>
      <PageHeader
        title={`New ${cfg.document.singular.toLowerCase()}`}
        description={`Amounts in ${currency}. Saved as a draft; approve and post to record it in the ledger.`}
      />
      <DocumentForm
        cfg={cfg}
        initialPartyId={initialPartyId}
        currency={currency}
        submitting={create.isPending}
        onCancel={() => router.push(cfg.document.path)}
        onSubmit={async (values) => {
          try {
            const created = await create.mutateAsync({
              ...values,
              idempotencyKey: crypto.randomUUID(),
            });
            toast.success(`${created.documentNumber} saved as draft.`);
            router.push(`${cfg.document.path}/${created.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

export function EditDocumentScreen({ cfg, id }: { cfg: SubledgerConfig; id: string }) {
  const router = useAppRouter();
  const currency = useCurrency();
  const document = useDocument(cfg, id);
  const update = useUpdateDocument(cfg);
  const locked = document.data && document.data.status !== 'DRAFT';
  React.useEffect(() => {
    if (locked) router.replace(`${cfg.document.path}/${id}`);
  }, [locked, router, cfg.document.path, id]);
  if (document.isLoading || !document.data || locked) return <Skeleton className="h-96" />;
  const d = document.data;
  return (
    <>
      <PageHeader
        title={`Edit ${d.documentNumber}`}
        description="Only drafts can be edited. Approved documents must be voided and re-issued."
      />
      <WarningsAlert warnings={d.warnings ?? []} />
      <DocumentForm
        cfg={cfg}
        document={d}
        currency={currency}
        submitting={update.isPending}
        onCancel={() => router.push(`${cfg.document.path}/${d.id}`)}
        onSubmit={async (values) => {
          try {
            await update.mutateAsync({ id: d.id, ...values });
            toast.success(`${d.documentNumber} updated.`);
            router.push(`${cfg.document.path}/${d.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

export function NewPaymentScreen({ cfg }: { cfg: SubledgerConfig }) {
  const router = useAppRouter();
  const params = useSearchParams();
  const currency = useCurrency();
  const create = useCreatePayment(cfg);
  const initialPartyId = params.get(cfg.side === 'AR' ? 'customerId' : 'vendorId') ?? undefined;

  return (
    <>
      <PageHeader
        title={`New ${cfg.payment.singular.toLowerCase()}`}
        description={`Amounts in ${currency}. Saved as a draft; posting records the cash movement and settles the allocated ${cfg.document.plural.toLowerCase()}.`}
      />
      <PaymentForm
        cfg={cfg}
        initialPartyId={initialPartyId}
        currency={currency}
        submitting={create.isPending}
        onCancel={() => router.push(cfg.payment.path)}
        onSubmit={async (values) => {
          try {
            const created = await create.mutateAsync({
              ...values,
              idempotencyKey: crypto.randomUUID(),
            });
            toast.success(`${created.documentNumber} saved as draft.`);
            router.push(`${cfg.payment.path}/${created.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

export function EditPaymentScreen({ cfg, id }: { cfg: SubledgerConfig; id: string }) {
  const router = useAppRouter();
  const currency = useCurrency();
  const payment = usePayment(cfg, id);
  const update = useUpdatePayment(cfg);
  const locked = payment.data && payment.data.status !== 'DRAFT';
  React.useEffect(() => {
    if (locked) router.replace(`${cfg.payment.path}/${id}`);
  }, [locked, router, cfg.payment.path, id]);
  if (payment.isLoading || !payment.data || locked) return <Skeleton className="h-96" />;
  const p = payment.data;
  return (
    <>
      <PageHeader
        title={`Edit ${p.documentNumber}`}
        description="Only drafts can be edited. Posted payments must be voided."
      />
      <PaymentForm
        cfg={cfg}
        payment={p}
        currency={currency}
        submitting={update.isPending}
        onCancel={() => router.push(`${cfg.payment.path}/${p.id}`)}
        onSubmit={async (values) => {
          try {
            await update.mutateAsync({ id: p.id, ...values });
            toast.success(`${p.documentNumber} updated.`);
            router.push(`${cfg.payment.path}/${p.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
