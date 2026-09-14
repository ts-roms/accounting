import {
  advanceCursor,
  decodeCursor,
  encodeCursor,
  isSettledCharge,
  isStripeEvent,
  keyMode,
  listParams,
  minorToDecimal,
  normalizeCharge,
  normalizeCheckoutSession,
  normalizeCustomer,
  normalizeEventType,
  normalizePaymentIntent,
} from './stripe.logic';

describe('stripe.logic', () => {
  it('converts minor units to exact decimal strings per currency', () => {
    expect(minorToDecimal(2400, 'usd')).toBe('24.00');
    expect(minorToDecimal(5, 'PHP')).toBe('0.05');
    expect(minorToDecimal(0, 'eur')).toBe('0.00');
    expect(minorToDecimal(-150, 'usd')).toBe('-1.50');
    expect(minorToDecimal(500, 'jpy')).toBe('500');
    expect(minorToDecimal(12345, 'kwd')).toBe('12.345');
    expect(minorToDecimal('99999999', 'php')).toBe('999999.99');
    expect(() => minorToDecimal(12.5, 'usd')).toThrow(/integer/);
  });

  it('detects the key mode', () => {
    expect(keyMode('sk_test_abc')).toBe('test');
    expect(keyMode('rk_live_abc')).toBe('live');
    expect(keyMode('demo')).toBe('unknown');
    expect(keyMode(undefined)).toBe('unknown');
  });

  it('pages newest-first with starting_after, then narrows the next run with created[gt]', () => {
    const start = decodeCursor(null);
    expect(listParams(start, 100, 'INCREMENTAL').toString()).toBe('limit=100');
    const afterPage1 = advanceCursor(start, {
      lastId: 'ch_10',
      hasMore: true,
      maxCreated: 1_700_000_100,
    });
    expect(afterPage1).toEqual({
      next: { startingAfter: 'ch_10', maxCreated: 1_700_000_100 },
      hasMore: true,
    });
    const p = listParams(afterPage1.next, 100, 'INCREMENTAL');
    expect(p.get('starting_after')).toBe('ch_10');
    expect(p.get('created[gt]')).toBeNull();
    const done = advanceCursor(afterPage1.next, {
      lastId: 'ch_20',
      hasMore: false,
      maxCreated: 1_700_000_050,
    });
    expect(done).toEqual({ next: { createdGt: 1_700_000_100 }, hasMore: false });
    // Next incremental run: bounded, no starting_after; FULL ignores the bound.
    const resumed = decodeCursor(encodeCursor(done.next));
    expect(listParams(resumed, 50, 'INCREMENTAL').get('created[gt]')).toBe('1700000100');
    expect(listParams(resumed, 50, 'FULL').get('created[gt]')).toBeNull();
    // Mid-run resume keeps the bound and the page position.
    const mid = advanceCursor(
      { createdGt: 1_700_000_000 },
      { lastId: 'ch_5', hasMore: true, maxCreated: 1_700_000_300 },
    );
    expect(decodeCursor(encodeCursor(mid.next))).toEqual({
      createdGt: 1_700_000_000,
      startingAfter: 'ch_5',
      maxCreated: 1_700_000_300,
    });
    expect(decodeCursor('not json')).toEqual({});
    expect(encodeCursor({})).toBeNull();
    expect(listParams(start, 500, 'FULL').get('limit')).toBe('100');
  });

  it('normalises customers with a display name fallback', () => {
    expect(
      normalizeCustomer({
        id: 'cus_1',
        name: ' Acme ',
        email: 'A@B.CO',
        address: { line1: '1 Way', country: 'ph' },
        currency: 'php',
        created: 1_700_000_000,
      }),
    ).toMatchObject({
      id: 'cus_1',
      display_name: 'Acme',
      currency: 'PHP',
      created_at: '2023-11-14T22:13:20.000Z',
      address: { line1: '1 Way', country: 'ph' },
    });
    expect(normalizeCustomer({ id: 'cus_2', email: 'x@y.z' }).display_name).toBe('x@y.z');
    expect(normalizeCustomer({ id: 'cus_3' }).display_name).toBe('cus_3');
  });

  it('only settles succeeded, paid, unrefunded charges and nets partial refunds out', () => {
    const base = {
      id: 'ch_1',
      amount: 2400,
      currency: 'usd',
      status: 'succeeded',
      paid: true,
      created: 1_700_000_000,
      customer: 'cus_1',
    };
    expect(isSettledCharge(base)).toBe(true);
    expect(isSettledCharge({ ...base, status: 'pending' })).toBe(false);
    expect(isSettledCharge({ ...base, refunded: true })).toBe(false);
    expect(isSettledCharge({ ...base, amount_refunded: 100 })).toBe(false);
    expect(normalizeCharge(base)).toMatchObject({
      amount: '24.00',
      currency: 'USD',
      customer: 'cus_1',
      customer_code: null,
      status: 'SUCCEEDED',
      created_at: '2023-11-14T22:13:20.000Z',
    });
    expect(normalizeCharge({ ...base, customer: null }, 'WALK-IN')).toMatchObject({
      customer: null,
      customer_code: 'WALK-IN',
    });
    expect(
      normalizeCharge({ ...base, customer: { id: 'cus_9' }, status: 'failed', paid: false }).status,
    ).toBe('FAILED');
  });

  it('normalises payment intents and checkout sessions', () => {
    expect(
      normalizePaymentIntent({
        id: 'pi_1',
        amount: 1000,
        amount_received: 1000,
        currency: 'php',
        status: 'succeeded',
        latest_charge: 'ch_9',
        customer: 'cus_1',
      }),
    ).toMatchObject({
      amount: '10.00',
      status: 'SUCCEEDED',
      latest_charge: 'ch_9',
      payment_intent: 'pi_1',
    });
    expect(
      normalizeCheckoutSession({
        id: 'cs_1',
        amount_total: 2500,
        currency: 'usd',
        payment_status: 'paid',
        customer_details: { email: 'g@x.io' },
        client_reference_id: 'WEB-7',
      }),
    ).toMatchObject({
      amount: '25.00',
      status: 'SUCCEEDED',
      payer_email: 'g@x.io',
      metadata: { client_reference_id: 'WEB-7' },
    });
    expect(normalizeCheckoutSession({ id: 'cs_2', payment_status: 'unpaid' }).amount).toBeNull();
  });

  it('recognises event envelopes and maps their types', () => {
    expect(isStripeEvent({ id: 'evt_1', type: 'charge.succeeded', data: { object: {} } })).toBe(
      true,
    );
    expect(isStripeEvent({ id: 'ch_1', type: 'x', data: {} })).toBe(false);
    expect(isStripeEvent(null)).toBe(false);
    expect(normalizeEventType('charge.succeeded')).toBe('payment.received');
    expect(normalizeEventType('customer.created')).toBe('customer.updated');
    expect(normalizeEventType('charge.refunded')).toBe('charge.refunded');
  });
});
