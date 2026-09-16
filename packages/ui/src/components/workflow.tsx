'use client';
/*
 * Workflow visuals shared by journals, invoices, payments, approvals and
 * period close:
 *  - StepTimeline: Created -> Submitted -> Approved -> Posted with completed /
 *    current / upcoming / failed steps.
 *  - OperationProgress: a checklist that reports the outcome of one atomic
 *    server operation (post, approve, reconcile). The server performs every
 *    check in one transaction, so the client reveals the results together
 *    with a small stagger - it never invents timing or partial progress.
 */
import * as React from 'react';
import { Check, Circle, Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { STAGGER_MS } from '../theme/motion';

export type StepState = 'complete' | 'current' | 'upcoming' | 'failed' | 'skipped';

export interface TimelineStep {
  key: string;
  label: React.ReactNode;
  state: StepState;
  /** Who / when, rendered under the label. */
  meta?: React.ReactNode;
  description?: React.ReactNode;
}

const STEP_ICON: Record<StepState, React.ReactNode> = {
  complete: <Check className="size-3" strokeWidth={3} aria-hidden />,
  current: <Circle className="size-2 fill-current" aria-hidden />,
  upcoming: <Circle className="size-2" aria-hidden />,
  failed: <X className="size-3" strokeWidth={3} aria-hidden />,
  skipped: <Circle className="size-2" aria-hidden />,
};

const STEP_TEXT: Record<StepState, string> = {
  complete: 'Completed',
  current: 'Current step',
  upcoming: 'Upcoming',
  failed: 'Failed',
  skipped: 'Skipped',
};

const MARKER: Record<StepState, string> = {
  complete: 'border-positive bg-positive text-positive-foreground',
  current: 'border-primary bg-primary/10 text-primary animate-pulse-ring',
  upcoming: 'border-border bg-card text-subtle-foreground',
  failed: 'border-critical bg-critical text-critical-foreground',
  skipped: 'border-border bg-muted text-subtle-foreground',
};

/**
 * Vertical (default) or horizontal step timeline. Completed steps are
 * emphasised, the current one carries a soft ring, upcoming ones are muted.
 */
export function StepTimeline({
  steps,
  orientation = 'vertical',
  className,
  animate = true,
}: {
  steps: TimelineStep[];
  orientation?: 'vertical' | 'horizontal';
  className?: string;
  /** Stagger the reveal of completed steps on mount. */
  animate?: boolean;
}) {
  const horizontal = orientation === 'horizontal';
  return (
    <ol
      className={cn(horizontal ? 'flex items-start gap-0' : 'flex flex-col', className)}
      aria-label="Workflow progress"
    >
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const connectorDone = step.state === 'complete';
        return (
          <li
            key={step.key}
            className={cn(
              'relative flex',
              horizontal ? 'flex-1 flex-col items-center text-center' : 'gap-3 pb-4 last:pb-0',
              animate && 'animate-enter-medium fade-in',
            )}
            style={animate ? { animationDelay: `${i * STAGGER_MS}ms` } : undefined}
            aria-current={step.state === 'current' ? 'step' : undefined}
            data-state={step.state}
          >
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  'absolute transition-colors duration-medium',
                  horizontal
                    ? 'left-1/2 top-2.5 h-px w-full'
                    : 'left-[9px] top-5 h-[calc(100%-4px)] w-px',
                  connectorDone ? 'bg-positive' : 'bg-border',
                )}
              />
            ) : null}
            <span
              className={cn(
                'relative z-[1] flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-medium',
                MARKER[step.state],
              )}
            >
              {STEP_ICON[step.state]}
              <span className="sr-only">{STEP_TEXT[step.state]}</span>
            </span>
            <div className={cn('min-w-0', horizontal ? 'mt-2 px-1' : 'pt-0.5')}>
              <div
                className={cn(
                  'text-sm leading-5',
                  step.state === 'complete' || step.state === 'current'
                    ? 'font-medium text-foreground'
                    : step.state === 'failed'
                      ? 'font-medium text-critical'
                      : 'text-muted-foreground',
                )}
              >
                {step.label}
              </div>
              {step.meta ? <div className="text-xs text-muted-foreground">{step.meta}</div> : null}
              {step.description ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{step.description}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------ operation progress
export type OperationStepState = 'pending' | 'running' | 'done' | 'failed';

export interface OperationStep {
  key: string;
  label: string;
  state: OperationStepState;
  /** Failure detail shown under the step (a user-readable message, never a stack trace). */
  detail?: React.ReactNode;
}

const OP_ICON: Record<OperationStepState, React.ReactNode> = {
  pending: <Circle className="size-2 text-subtle-foreground" aria-hidden />,
  running: <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />,
  done: <Check className="size-3.5 text-positive" strokeWidth={3} aria-hidden />,
  failed: <X className="size-3.5 text-critical" strokeWidth={3} aria-hidden />,
};

/**
 * Checklist for an accounting operation. `steps` describe what the server
 * validates; `phase` drives the display:
 *  - idle:    all pending
 *  - running: every step running (the request is one transaction)
 *  - done:    steps flip to done with a small stagger, then `result` shows
 *  - failed:  the failing step (by `failedStep`) is marked, earlier ones done,
 *             later ones pending
 */
export function OperationProgress({
  title,
  steps,
  phase,
  failedStep,
  failureDetail,
  result,
  className,
}: {
  title?: string;
  steps: Array<{ key: string; label: string }>;
  phase: 'idle' | 'running' | 'done' | 'failed';
  failedStep?: string;
  failureDetail?: React.ReactNode;
  /** Rendered under the list when `phase === 'done'` (e.g. "POSTED"). */
  result?: React.ReactNode;
  className?: string;
}) {
  const failedIndex = failedStep ? steps.findIndex((s) => s.key === failedStep) : -1;
  const resolved: OperationStep[] = steps.map((s, i) => {
    let state: OperationStepState = 'pending';
    if (phase === 'running') state = 'running';
    else if (phase === 'done') state = 'done';
    else if (phase === 'failed') {
      if (failedIndex === -1) state = i === steps.length - 1 ? 'failed' : 'done';
      else state = i < failedIndex ? 'done' : i === failedIndex ? 'failed' : 'pending';
    }
    return { ...s, state, detail: state === 'failed' ? failureDetail : undefined };
  });
  const live =
    phase === 'running'
      ? `${title ?? 'Operation'} in progress`
      : phase === 'done'
        ? `${title ?? 'Operation'} completed`
        : phase === 'failed'
          ? `${title ?? 'Operation'} failed`
          : '';

  return (
    <div className={cn('space-y-3', className)} aria-busy={phase === 'running'}>
      {title ? <div className="type-label">{title}</div> : null}
      <ol className="space-y-1.5">
        {resolved.map((step, i) => (
          <li
            key={step.key}
            data-state={step.state}
            className={cn(
              'flex items-start gap-2.5 text-sm transition-colors duration-medium',
              step.state === 'pending' && 'text-muted-foreground',
              step.state === 'failed' && 'text-critical',
            )}
          >
            <span
              key={step.state}
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center',
                (step.state === 'done' || step.state === 'failed') &&
                  'animate-enter-fast fade-in scale-in-80',
              )}
              style={
                phase === 'done' || phase === 'failed'
                  ? { animationDelay: `${i * STAGGER_MS}ms` }
                  : undefined
              }
            >
              {OP_ICON[step.state]}
            </span>
            <div className="min-w-0">
              <div>{step.label}</div>
              {step.detail ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{step.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>
      {phase === 'done' && result ? (
        <div
          className="flex items-center justify-center rounded-md border border-positive/30 bg-positive/10 py-2 type-h3 uppercase tracking-wide text-positive animate-enter-medium fade-in scale-in-98"
          style={{ animationDelay: `${steps.length * STAGGER_MS}ms` }}
        >
          {result}
        </div>
      ) : null}
    </div>
  );
}
