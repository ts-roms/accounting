import {
  entitiesForEvent,
  pushRetryDelayMs,
  pushTriggerJobId,
  PUSH_MAX_WAIT_ATTEMPTS,
} from './push-trigger.logic';

describe('entitiesForEvent', () => {
  it('maps master-data events to their entity', () => {
    expect(entitiesForEvent('customer.created')).toEqual(['customers']);
    expect(entitiesForEvent('customer.updated')).toEqual(['customers']);
    expect(entitiesForEvent('vendor.updated')).toEqual(['vendors']);
    expect(entitiesForEvent('product.created')).toEqual(['products']);
  });

  it('maps only posted / voided document events, never drafts', () => {
    expect(entitiesForEvent('invoice.posted')).toEqual(['invoices']);
    expect(entitiesForEvent('credit_note.posted')).toEqual(['invoices']);
    expect(entitiesForEvent('invoice.voided')).toEqual(['invoices']);
    expect(entitiesForEvent('bill.posted')).toEqual(['bills']);
    expect(entitiesForEvent('vendor_credit.posted')).toEqual(['bills']);
    expect(entitiesForEvent('bill.voided')).toEqual(['bills']);
    expect(entitiesForEvent('invoice.created')).toEqual([]);
    expect(entitiesForEvent('invoice.approved')).toEqual([]);
    expect(entitiesForEvent('bill.created')).toEqual([]);
    expect(entitiesForEvent('bill.approved')).toEqual([]);
  });

  it('reads the source document type of ledger events and ignores the rest', () => {
    expect(entitiesForEvent('journal.posted', { sourceType: 'AR_DOCUMENT' })).toEqual(['invoices']);
    expect(entitiesForEvent('journal.reversed', { sourceType: 'AR_DOCUMENT_VOID' })).toEqual([
      'invoices',
    ]);
    expect(entitiesForEvent('journal.posted', { sourceType: 'AP_DOCUMENT' })).toEqual(['bills']);
    expect(entitiesForEvent('journal.posted', { sourceType: 'AR_PAYMENT' })).toEqual([]);
    expect(entitiesForEvent('journal.posted', {})).toEqual([]);
    expect(entitiesForEvent('payment.completed')).toEqual([]);
    expect(entitiesForEvent('period.closed')).toEqual([]);
    expect(entitiesForEvent('webhook.test')).toEqual([]);
  });
});

describe('push trigger scheduling', () => {
  it('uses one stable job id per integration and entity so bursts collapse', () => {
    expect(pushTriggerJobId('int-1', 'invoices')).toBe('push-on-event:int-1:invoices');
    expect(pushTriggerJobId('int-1', 'invoices')).toBe(pushTriggerJobId('int-1', 'invoices'));
    expect(pushTriggerJobId('int-1', 'customers')).not.toBe(pushTriggerJobId('int-1', 'invoices'));
  });

  it('backs off while a running job holds the integration, capped at two minutes', () => {
    expect(pushRetryDelayMs(1)).toBe(5_000);
    expect(pushRetryDelayMs(2)).toBe(10_000);
    expect(pushRetryDelayMs(4)).toBe(40_000);
    expect(pushRetryDelayMs(10)).toBe(120_000);
    expect(PUSH_MAX_WAIT_ATTEMPTS).toBeGreaterThan(5);
  });
});
