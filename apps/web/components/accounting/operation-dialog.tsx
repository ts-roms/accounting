'use client';
/*
 * Confirmation dialog for atomic accounting operations (post / approve /
 * reverse). Shows what the server validates as a checklist; the request is a
 * single transaction, so results are revealed together - honest progress, no
 * invented timing. On failure the error code points at the failing check.
 */
import * as React from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  OperationProgress,
} from '@accounting/ui';
import { ApiError, describeError } from '@/lib/api/client';

export interface OperationStepDef {
  key: string;
  label: string;
  /** Error-code prefixes / names that indicate this step failed. */
  codes?: string[];
}

/** Gateway checks performed when a journal (or any document) is posted. */
export const POSTING_STEPS: OperationStepDef[] = [
  {
    key: 'validate',
    label: 'Validating document',
    codes: ['VALIDATION', 'JOURNAL_INVALID_STATE', 'NOT_FOUND'],
  },
  { key: 'balance', label: 'Checking debits and credits', codes: ['JOURNAL_UNBALANCED'] },
  { key: 'period', label: 'Checking accounting period', codes: ['ACCOUNTING_PERIOD', 'PERIOD_'] },
  {
    key: 'accounts',
    label: 'Checking account status',
    codes: ['ACCOUNT_', 'GL_ACCOUNT', 'DIMENSION'],
  },
  {
    key: 'authority',
    label: 'Checking authorization',
    codes: ['FORBIDDEN', 'SOD_', 'DELEGATION', 'AUTHORITY', 'APPROVAL'],
  },
  { key: 'post', label: 'Posting to the general ledger' },
];

export const APPROVAL_STEPS: OperationStepDef[] = [
  {
    key: 'validate',
    label: 'Validating document',
    codes: ['VALIDATION', 'INVALID_STATE', 'NOT_FOUND'],
  },
  { key: 'workflow', label: 'Checking approval workflow', codes: ['APPROVAL', 'WORKFLOW'] },
  {
    key: 'authority',
    label: 'Checking authorization',
    codes: ['FORBIDDEN', 'SOD_', 'DELEGATION', 'AUTHORITY'],
  },
  { key: 'approve', label: 'Recording approval' },
];

export function failedStepFor(err: unknown, steps: OperationStepDef[]): string | undefined {
  const code = err instanceof ApiError ? err.code : '';
  if (!code) return steps[steps.length - 1]?.key;
  const hit = steps.find((s) => s.codes?.some((c) => code.startsWith(c) || code.includes(c)));
  return hit?.key ?? steps[steps.length - 1]?.key;
}

export function OperationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  loadingLabel,
  resultLabel,
  steps,
  run,
  onDone,
  destructive = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  loadingLabel: string;
  /** Shown under the checklist on success, e.g. "POSTED". */
  resultLabel: string;
  steps: OperationStepDef[];
  /** Performs the operation; resolves on success, throws on failure. */
  run: () => Promise<unknown>;
  /** Called after the success state has been shown (dialog closes itself). */
  onDone?: () => void;
  destructive?: boolean;
  /** Extra body content (e.g. a delegated-authority notice). */
  children?: React.ReactNode;
}) {
  const [phase, setPhase] = React.useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [failed, setFailed] = React.useState<string | undefined>();
  const [message, setMessage] = React.useState<string>('');

  React.useEffect(() => {
    if (!open) {
      setPhase('idle');
      setFailed(undefined);
      setMessage('');
    }
  }, [open]);

  const confirm = async () => {
    setPhase('running');
    setFailed(undefined);
    try {
      await run();
      setPhase('done');
      // Let the checklist settle before closing so the confirmation is legible.
      window.setTimeout(() => {
        onOpenChange(false);
        onDone?.();
      }, 900);
    } catch (err) {
      setFailed(failedStepFor(err, steps));
      setMessage(describeError(err));
      setPhase('failed');
    }
  };

  const busy = phase === 'running' || phase === 'done';
  return (
    <Dialog open={open} onOpenChange={(o) => (!o && busy ? undefined : onOpenChange(o))}>
      <DialogContent size="sm" data-testid="operation-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <OperationProgress
          steps={steps}
          phase={phase}
          failedStep={failed}
          failureDetail={message || undefined}
          result={resultLabel}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {phase === 'failed' ? 'Close' : 'Cancel'}
          </Button>
          {phase !== 'done' ? (
            <Button
              variant={destructive ? 'destructive' : 'default'}
              onClick={() => void confirm()}
              loading={phase === 'running'}
              loadingText={loadingLabel}
              autoFocus
              data-testid="operation-confirm"
            >
              {phase === 'failed' ? 'Retry' : confirmLabel}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
