/*
 * Workflow timelines for accounting documents. Each builder turns a document
 * into StepTimeline steps so journals, invoices/bills, payments and period
 * close share one visual (docs/design-system/accounting-ux.md).
 */
import type { TimelineStep } from '@accounting/ui';
import type { JournalEntryDetail, SubledgerDocument, SubledgerPayment } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';

const meta = (when: string | null | undefined, who?: string | null) =>
  when ? `${formatDateTime(when)}${who ? ` · ${who}` : ''}` : undefined;

/** Created -> Submitted -> Approved -> Posted (with Rejected / Reversed branches). */
export function journalTimeline(e: JournalEntryDetail): TimelineStep[] {
  const posted = Boolean(e.postedAt);
  const approved = Boolean(e.approvedAt);
  const submitted = Boolean(e.submittedAt);
  const rejected = e.status === 'REJECTED';
  const reversed = e.status === 'REVERSED';
  const steps: TimelineStep[] = [
    {
      key: 'created',
      label: 'Created',
      state: 'complete',
      meta: meta(e.createdAt, e.createdByEmail),
    },
    {
      key: 'submitted',
      label: 'Submitted',
      state: submitted ? 'complete' : e.status === 'DRAFT' ? 'current' : 'upcoming',
      meta: meta(e.submittedAt),
    },
  ];
  if (rejected) {
    steps.push({
      key: 'rejected',
      label: 'Rejected',
      state: 'failed',
      meta: meta(e.rejectedAt),
      description: e.rejectionReason ?? undefined,
    });
    return steps;
  }
  steps.push(
    {
      key: 'approved',
      label: 'Approved',
      state: approved ? 'complete' : e.status === 'SUBMITTED' ? 'current' : 'upcoming',
      meta: meta(e.approvedAt, e.approvedByEmail),
    },
    {
      key: 'posted',
      label: 'Posted',
      state: posted ? 'complete' : e.status === 'APPROVED' ? 'current' : 'upcoming',
      meta: meta(e.postedAt, e.postedByEmail),
    },
  );
  if (reversed) {
    steps.push({
      key: 'reversed',
      label: 'Reversed',
      state: 'complete',
      meta: e.reversedByNumber ? `by ${e.reversedByNumber}` : undefined,
    });
  }
  return steps;
}

/** Draft -> Approved -> Posted -> Partially paid -> Paid (Void branch). */
export function documentTimeline(d: SubledgerDocument): TimelineStep[] {
  const isVoid = d.status === 'VOID';
  const approved = Boolean(d.approvedAt) || d.status !== 'DRAFT';
  const posted = d.accountingStatus === 'POSTED' || d.accountingStatus === 'REVERSED';
  const partially = d.status === 'PARTIALLY_PAID';
  const paid = d.status === 'PAID';
  const steps: TimelineStep[] = [
    { key: 'draft', label: 'Draft', state: 'complete', meta: meta(d.createdAt) },
    {
      key: 'approved',
      label: 'Approved',
      state: approved ? 'complete' : d.status === 'DRAFT' ? 'current' : 'upcoming',
      meta: meta(d.approvedAt),
    },
    {
      key: 'posted',
      label: 'Posted',
      state: posted ? 'complete' : approved && !isVoid ? 'current' : 'upcoming',
      meta: meta(d.postedAt),
    },
  ];
  if (isVoid) {
    steps.push({
      key: 'void',
      label: 'Voided',
      state: 'failed',
      meta: meta(d.voidedAt),
      description: d.voidReason ?? undefined,
    });
    return steps;
  }
  steps.push(
    {
      key: 'partial',
      label: 'Partially paid',
      state: paid || partially ? 'complete' : posted ? 'current' : 'upcoming',
    },
    { key: 'paid', label: 'Paid', state: paid ? 'complete' : 'upcoming' },
  );
  return steps;
}

/** Draft -> Posted (Void branch). */
export function paymentTimeline(p: SubledgerPayment): TimelineStep[] {
  const steps: TimelineStep[] = [
    { key: 'draft', label: 'Draft', state: 'complete', meta: meta(p.createdAt) },
  ];
  if (p.status === 'VOID') {
    steps.push(
      { key: 'posted', label: 'Posted', state: 'complete', meta: meta(p.postedAt) },
      { key: 'void', label: 'Voided', state: 'failed' },
    );
    return steps;
  }
  steps.push({
    key: 'posted',
    label: 'Posted',
    state: p.status === 'POSTED' ? 'complete' : 'current',
    meta: meta(p.postedAt),
  });
  return steps;
}
