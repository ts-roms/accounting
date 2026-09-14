'use client';
import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
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
  Label,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useReviewMatch } from '@/lib/api/orders-hooks';
import type { SubledgerDocumentDetail } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { PURCHASE_ORDER_CONFIG } from '@/lib/orders/config';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { MatchStatusBadge } from './badges';

/** Three-way match panel on a vendor bill: status, exceptions and the review action. */
export function MatchCard({ cfg, bill }: { cfg: SubledgerConfig; bill: SubledgerDocumentDetail }) {
  const { hasPermission } = useSession();
  const review = useReviewMatch(cfg);
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState('');
  if (!bill.matchStatus || bill.documentType !== 'INVOICE') return null;
  const exceptions = bill.matchExceptions ?? [];
  const canReview = bill.matchStatus === 'EXCEPTION' && hasPermission(P['bill.match-review']);
  return (
    <Card data-testid="match-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          Three-way match
          <MatchStatusBadge status={bill.matchStatus} />
        </CardTitle>
        <CardDescription>
          {bill.purchaseOrderId ? (
            <>
              Against{' '}
              <Link
                href={`${PURCHASE_ORDER_CONFIG.path}/${bill.purchaseOrderId}`}
                className="font-mono hover:underline"
              >
                purchase order
              </Link>{' '}
              and its confirmed receipts.
            </>
          ) : (
            'Not linked to a purchase order.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {exceptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {bill.matchStatus === 'MATCHED'
              ? 'Quantities and prices agree within the configured tolerances.'
              : 'No exceptions.'}
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {exceptions.map((e, i) => (
              <li
                key={`${e.code}-${i}`}
                className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5"
              >
                <div className="text-xs font-medium uppercase tracking-wide text-destructive">
                  {titleCase(e.code)}
                </div>
                <div>{e.message}</div>
              </li>
            ))}
          </ul>
        )}
        {bill.matchStatus === 'EXCEPTION' ? (
          <p className="text-xs text-destructive">
            Payment is on hold until an approver reviews these exceptions.
          </p>
        ) : null}
        {bill.matchStatus === 'REVIEWED' ? (
          <p className="text-xs text-muted-foreground">
            Reviewed {bill.matchReviewedAt ? formatDateTime(bill.matchReviewedAt) : ''}:{' '}
            {bill.matchReviewNote}
          </p>
        ) : null}
        {canReview ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Review exceptions
          </Button>
        ) : null}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Review match exceptions</DialogTitle>
            <DialogDescription>
              Acknowledging the exceptions lifts the payment hold. Your note is recorded in the
              audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="match-note">Review note</Label>
            <Textarea
              id="match-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why the variance is acceptable"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!note.trim()}
              loading={review.isPending}
              onClick={async () => {
                try {
                  await review.mutateAsync({ id: bill.id, note: note.trim() });
                  toast.success('Match exceptions reviewed.');
                  setOpen(false);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Mark as reviewed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
