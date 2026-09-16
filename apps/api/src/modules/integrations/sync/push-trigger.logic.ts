import type { SyncEntity } from '@accounting/types';

/**
 * Which outbound push entities a domain event touches. Pure: the service
 * intersects the answer with each PUSH-capable integration's entities.
 * Draft-only events (invoice.created, bill.created, ...) are ignored on
 * purpose - the document exporters only ever send what left UNPOSTED, so a
 * push for a draft would find nothing to do.
 */
export function entitiesForEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
): SyncEntity[] {
  switch (eventType) {
    case 'customer.created':
    case 'customer.updated':
    case 'customer.credit_hold':
    case 'customer.credit_released':
      return ['customers'];
    case 'vendor.created':
    case 'vendor.updated':
      return ['vendors'];
    case 'product.created':
    case 'product.updated':
      return ['products'];
    case 'invoice.posted':
    case 'invoice.voided':
    case 'invoice.paid':
    case 'credit_note.posted':
    case 'debit_note.posted':
      return ['invoices'];
    case 'bill.posted':
    case 'bill.voided':
    case 'vendor_credit.posted':
      return ['bills'];
    case 'journal.posted':
    case 'journal.reversed': {
      // The posting engine's event: only the source document type says what changed.
      const source = typeof payload.sourceType === 'string' ? payload.sourceType : '';
      if (source.startsWith('AR_DOCUMENT')) return ['invoices'];
      if (source.startsWith('AP_DOCUMENT')) return ['bills'];
      return [];
    }
    default:
      return [];
  }
}

/** Stable queue id so bursts of events collapse into one delayed push per integration + entity. */
export function pushTriggerJobId(integrationId: string, entity: SyncEntity): string {
  return `push-on-event:${integrationId}:${entity}`;
}

/** Retry cadence when a push is already running: wait for it, then push again. */
export function pushRetryDelayMs(attempt: number, base = 5_000): number {
  return Math.min(base * 2 ** Math.max(attempt - 1, 0), 120_000);
}

export const PUSH_DEBOUNCE_MS = 5_000;
export const PUSH_MAX_WAIT_ATTEMPTS = 20;
