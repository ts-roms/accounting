'use client';
import { useParams } from 'next/navigation';
import { useAppRouter } from '@/lib/navigation/progress';
import { toast } from 'sonner';
import { Skeleton } from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useJournalEntry, useUpdateJournalEntry } from '@/lib/api/accounting-hooks';
import { PageHeader } from '@/components/ui-ext/page';
import { JournalEntryForm } from '@/components/accounting/journal-entry-form';

export default function EditJournalEntryPage() {
  const params = useParams<{ id: string }>();
  const router = useAppRouter();
  const entry = useJournalEntry(params.id);
  const update = useUpdateJournalEntry();

  if (entry.isLoading || !entry.data) return <Skeleton className="h-96" />;
  const e = entry.data;
  if (e.status !== 'DRAFT' && e.status !== 'REJECTED') {
    router.replace(`/accounting/journal-entries/${e.id}`);
    return null;
  }

  return (
    <>
      <PageHeader
        title={`Edit ${e.documentNumber}`}
        description={
          e.status === 'REJECTED'
            ? `Rejected: ${e.rejectionReason ?? ''}. Saving returns the entry to draft.`
            : 'Draft entry.'
        }
      />
      <JournalEntryForm
        entry={e}
        currency={e.currency}
        submitting={update.isPending}
        onCancel={() => router.push(`/accounting/journal-entries/${e.id}`)}
        onSubmit={async (values) => {
          try {
            await update.mutateAsync({ id: e.id, ...values });
            toast.success(`${e.documentNumber} updated.`);
            router.push(`/accounting/journal-entries/${e.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
