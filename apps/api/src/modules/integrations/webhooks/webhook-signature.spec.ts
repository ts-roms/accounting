import { hmacHex, parseSignature, signPayload, verifySignature } from './webhook-signature';

describe('webhook-signature', () => {
  const secret = 'whsec_test_secret_0123456789';
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'payment.received',
    data: { amount: '10.0000' },
  });
  const now = 1_800_000_000;

  it('signs and verifies a timestamped payload', () => {
    const header = signPayload(secret, body, now);
    expect(parseSignature(header)).toEqual({ t: now, v1: [expect.any(String)] });
    expect(verifySignature([secret], body, header, { nowSeconds: now + 10 })).toEqual({
      ok: true,
      timestamp: now,
    });
  });

  it('rejects tampered bodies, wrong secrets and malformed headers', () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature([secret], body + ' ', header, { nowSeconds: now })).toMatchObject({
      ok: false,
      reason: 'MISMATCH',
    });
    expect(verifySignature(['other'], body, header, { nowSeconds: now })).toMatchObject({
      ok: false,
      reason: 'MISMATCH',
    });
    expect(verifySignature([secret], body, 'nonsense', { nowSeconds: now })).toMatchObject({
      ok: false,
      reason: 'MALFORMED',
    });
    expect(verifySignature([secret], body, undefined, { nowSeconds: now })).toMatchObject({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects replays outside the tolerance window', () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature([secret], body, header, { nowSeconds: now + 6 * 60 })).toMatchObject({
      ok: false,
      reason: 'STALE',
    });
    expect(
      verifySignature([secret], body, header, { nowSeconds: now + 6 * 60, toleranceSeconds: 600 })
        .ok,
    ).toBe(true);
  });

  it('accepts any of several secrets (rotation grace) and plain HMAC helpers', () => {
    const header = signPayload('new-secret-0123456789', body, now);
    expect(
      verifySignature(['old-secret-0123456789', 'new-secret-0123456789'], body, header, {
        nowSeconds: now,
      }).ok,
    ).toBe(true);
    expect(hmacHex(secret, body)).toHaveLength(64);
    expect(hmacHex(secret, body)).not.toBe(hmacHex(secret, body + 'x'));
  });
});
