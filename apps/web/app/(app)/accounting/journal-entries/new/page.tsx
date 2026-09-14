'use client';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { describeError } from '@/lib/api/client';
import { useCreateJournalEntry } from '@/lib/api/accounting-hooks';
import { useSession } from '@/lib/auth/session';
import { PageHeader } from '@/components/ui-ext/page';
import { JournalEntryForm } from '@/components/accounting/journal-entry-form';

export default function NewJournalEntryPage() {
  const router = useRouter();
  const { activeCompany } = useSession();
  const create = useCreateJournalEntry();
  const currency = activeCompany?.baseCurrency ?? 'PHP';

  return (
    <>
      <PageHeader
        title="New journal entry"
        description={`Amounts in ${currency}. The entry is saved as a draft and must be submitted for approval.`}
      />
      <JournalEntryForm
        currency={currency}
        submitting={create.isPending}
        onCancel={() => router.push('/accounting/journal-entries')}
        onSubmit={async (values) => {
          try {
            const created = await create.mutateAsync({
              ...values,
              idempotencyKey: crypto.randomUUID(),
            });
            toast.success(`${created.documentNumber} saved as draft.`);
            router.push(`/accounting/journal-entries/${created.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
