'use client';
import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import type {
  IntegrationHealthStatus,
  IntegrationStatus,
  SyncJobStatus,
  WebhookDeliveryStatus,
} from '@accounting/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatusBadge,
} from '@accounting/ui';
import { titleCase } from '@/lib/format';
import { toneOf } from '@/components/status';

type Variant = 'secondary' | 'warning' | 'success' | 'outline' | 'destructive' | 'default';

const STATUS_VARIANT: Record<IntegrationStatus, Variant> = {
  CONNECTED: 'success',
  DISCONNECTED: 'outline',
  CONNECTING: 'secondary',
  SYNCING: 'default',
  ERROR: 'destructive',
  DISABLED: 'outline',
};
const HEALTH_VARIANT: Record<IntegrationHealthStatus, Variant> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  UNHEALTHY: 'destructive',
  UNKNOWN: 'outline',
};
const JOB_VARIANT: Record<SyncJobStatus, Variant> = {
  QUEUED: 'secondary',
  RUNNING: 'default',
  COMPLETED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'outline',
  PAUSED: 'warning',
};
const DELIVERY_VARIANT: Record<WebhookDeliveryStatus, Variant> = {
  PENDING: 'secondary',
  DELIVERED: 'success',
  FAILED: 'destructive',
  RETRYING: 'warning',
  EXHAUSTED: 'destructive',
  DISABLED: 'outline',
};

export function IntegrationStatusBadge({ status }: { status: IntegrationStatus }) {
  return (
    <StatusBadge
      tone={toneOf(STATUS_VARIANT[status])}
      active={status === 'SYNCING' || status === 'CONNECTING'}
      data-testid="integration-status"
    >
      {titleCase(status)}
    </StatusBadge>
  );
}
export function HealthBadge({
  status,
  score,
}: {
  status: IntegrationHealthStatus;
  score?: number | null;
}) {
  return (
    <StatusBadge tone={toneOf(HEALTH_VARIANT[status])}>
      {titleCase(status)}
      {score !== null && score !== undefined ? (
        <span className="ml-1 font-mono">{score}</span>
      ) : null}
    </StatusBadge>
  );
}
export function JobStatusBadge({ status }: { status: SyncJobStatus }) {
  return <StatusBadge tone={toneOf(JOB_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}
export function DeliveryStatusBadge({ status }: { status: WebhookDeliveryStatus }) {
  return <StatusBadge tone={toneOf(DELIVERY_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

/** Copy-to-clipboard with a brief confirmation (the only animation the secret dialog uses). */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error('Clipboard is not available');
        }
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />} {copied ? 'Copied' : label}
    </Button>
  );
}

/** Shown exactly once after minting an API key or webhook secret. */
export function SecretRevealDialog({
  secret,
  title,
  description,
  onClose,
}: {
  secret: string | null;
  title: string;
  description: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
          <code className="flex-1 break-all font-mono text-xs" data-testid="secret-value">
            {secret}
          </code>
          {secret ? <CopyButton value={secret} /> : null}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I have stored it safely</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function KeyValue({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? '-'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
