import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import {
  buildStatements,
  classifyPlaidError,
  decimalFromNumber,
  decodeCursor,
  encodeCursor,
  parsePlaidJwt,
  pickAccount,
  statementAmount,
  statementId,
  verifyPlaidJwt,
  wantsSync,
  type PlaidTransaction,
} from './plaid.logic';

function tx(partial: Partial<PlaidTransaction> & { transaction_id: string }): PlaidTransaction {
  return {
    account_id: 'acc_1',
    amount: 10,
    date: '2026-03-02',
    name: 'Coffee',
    pending: false,
    iso_currency_code: 'PHP',
    ...partial,
  };
}

describe('Plaid amounts', () => {
  it('turns Plaid floats into exact 2dp strings and flips the sign for statements', () => {
    expect(decimalFromNumber(12.34)).toBe('12.34');
    expect(decimalFromNumber(0.1 + 0.2)).toBe('0.30');
    expect(decimalFromNumber(-1234.5)).toBe('-1234.50');
    expect(decimalFromNumber(-0)).toBe('0.00');
    expect(statementAmount(250)).toBe('-250.00'); // Plaid positive = money out
    expect(statementAmount(-1500.25)).toBe('1500.25'); // deposit
  });
});

describe('Plaid statements', () => {
  it('groups posted transactions of the chosen account by date with continuous running balances', () => {
    const page = {
      added: [
        tx({ transaction_id: 't3', date: '2026-03-03', amount: 40 }),
        tx({ transaction_id: 't1', date: '2026-03-02', amount: -1000, name: 'Payroll credit' }),
        tx({ transaction_id: 't2', date: '2026-03-02', amount: 250.5, merchant_name: ' Grab ' }),
        tx({ transaction_id: 'p1', date: '2026-03-03', amount: 5, pending: true }),
        tx({ transaction_id: 'o1', date: '2026-03-03', amount: 5, account_id: 'acc_other' }),
      ],
    };
    const built = buildStatements(page, { accountId: 'acc_1', runningBalance: '100.00' });
    expect(built.skippedPending).toBe(1);
    expect(built.records.map((r) => r.data.statement_date)).toEqual(['2026-03-02', '2026-03-03']);
    const [d1, d2] = built.records.map((r) => r.data as Record<string, unknown>);
    expect(d1).toMatchObject({ opening_balance: '100.00', closing_balance: '849.50' });
    expect(d2).toMatchObject({ opening_balance: '849.50', closing_balance: '809.50' });
    expect(built.runningBalance).toBe('809.50');
    const lines = d1!.transactions as Array<Record<string, unknown>>;
    expect(lines).toEqual([
      expect.objectContaining({
        transaction_id: 't1',
        amount: '1000.00',
        description: 'Payroll credit',
        reference: 't1',
      }),
      expect.objectContaining({ transaction_id: 't2', amount: '-250.50', description: 'Grab' }),
    ]);
    // Deterministic ids: replaying the same page produces the same statement ids.
    const again = buildStatements(page, { accountId: 'acc_1', runningBalance: '100.00' });
    expect(again.records.map((r) => r.externalId)).toEqual(built.records.map((r) => r.externalId));
    expect(statementId('acc_1', '2026-03-02', ['t2', 't1'])).toBe(built.records[0]!.externalId);
  });

  it('includes pending lines only when asked and keeps check numbers as references', () => {
    const built = buildStatements(
      { added: [tx({ transaction_id: 'p', pending: true, check_number: '1042', amount: 99 })] },
      { accountId: 'acc_1', runningBalance: '0', includePending: true },
    );
    expect(built.records).toHaveLength(1);
    const line = (built.records[0]!.data.transactions as Array<Record<string, unknown>>)[0]!;
    expect(line.reference).toBe('CHK 1042');
    expect(built.runningBalance).toBe('-99.00');
  });

  it('round-trips the cursor and falls back to the configured opening balance', () => {
    expect(decodeCursor(null, '50.00')).toEqual({ cursor: null, balance: '50.00' });
    expect(decodeCursor('garbage', '50.00')).toEqual({ cursor: null, balance: '50.00' });
    const enc = encodeCursor({ cursor: 'CAESJ...', balance: '12.00' });
    expect(decodeCursor(enc, '0')).toEqual({ cursor: 'CAESJ...', balance: '12.00' });
  });

  it('picks the single depository account unless one is configured', () => {
    const accounts = [
      { account_id: 'a', name: 'Checking', type: 'depository' },
      { account_id: 'b', name: 'Card', type: 'credit' },
    ];
    expect(pickAccount(accounts, undefined).account?.account_id).toBe('a');
    expect(pickAccount(accounts, 'b').account?.account_id).toBe('b');
    expect(pickAccount(accounts, 'zzz').account).toBeNull();
    expect(
      pickAccount(
        [...accounts, { account_id: 'c', name: 'Savings', type: 'depository' }],
        undefined,
      ).reason,
    ).toMatch(/plaidAccountId/);
  });
});

describe('Plaid errors', () => {
  it('classifies by error_code rather than the HTTP 400 Plaid uses for everything', () => {
    expect(
      classifyPlaidError(400, {
        error_type: 'ITEM_ERROR',
        error_code: 'ITEM_LOGIN_REQUIRED',
        error_message: 'x',
      }),
    ).toMatchObject({ code: 'AUTHENTICATION_ERROR', plaidCode: 'ITEM_LOGIN_REQUIRED' });
    expect(
      classifyPlaidError(400, { error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN' })
        .code,
    ).toBe('AUTHENTICATION_ERROR');
    expect(
      classifyPlaidError(429, {
        error_type: 'RATE_LIMIT_EXCEEDED',
        error_code: 'RATE_LIMIT_EXCEEDED',
      }).code,
    ).toBe('RATE_LIMITED');
    expect(
      classifyPlaidError(400, { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' })
        .code,
    ).toBe('PROVIDER_ERROR');
    expect(
      classifyPlaidError(400, { error_type: 'INVALID_REQUEST', error_code: 'MISSING_FIELDS' }).code,
    ).toBe('VALIDATION_ERROR');
    expect(classifyPlaidError(502, 'bad gateway').code).toBe('PROVIDER_ERROR');
  });
});

describe('Plaid webhook verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
  const sign = (body: string, iat = Math.floor(Date.now() / 1000), alg = 'ES256') => {
    const header = b64(JSON.stringify({ alg, kid: 'kid-1', typ: 'JWT' }));
    const payload = b64(
      JSON.stringify({ iat, request_body_sha256: createHash('sha256').update(body).digest('hex') }),
    );
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${header}.${payload}.${b64(signature)}`;
  };
  const body = JSON.stringify({
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
  });

  it('accepts a fresh ES256 JWT whose body hash matches', () => {
    const jwt = parsePlaidJwt(sign(body))!;
    expect(jwt.header.kid).toBe('kid-1');
    expect(verifyPlaidJwt(jwt, jwk, body)).toEqual({ ok: true });
  });

  it('rejects tampered bodies, stale tokens, wrong keys and other algorithms', () => {
    const jwt = parsePlaidJwt(sign(body))!;
    expect(verifyPlaidJwt(jwt, jwk, body + ' ')).toEqual({ ok: false, reason: 'BODY_MISMATCH' });
    const stale = parsePlaidJwt(sign(body, Math.floor(Date.now() / 1000) - 3600))!;
    expect(verifyPlaidJwt(stale, jwk, body)).toEqual({ ok: false, reason: 'STALE' });
    const otherJwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'jwk',
    });
    expect(verifyPlaidJwt(jwt, otherJwk, body)).toEqual({ ok: false, reason: 'MISMATCH' });
    const hs = parsePlaidJwt(sign(body, undefined, 'HS256'))!;
    expect(verifyPlaidJwt(hs, jwk, body)).toEqual({ ok: false, reason: 'UNSUPPORTED_ALG' });
    expect(parsePlaidJwt('not.a.jwt.at.all')).toBeNull();
    expect(parsePlaidJwt(undefined)).toBeNull();
  });

  it('knows which webhook codes call for a sync', () => {
    expect(wantsSync('TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE')).toBe(true);
    expect(wantsSync('TRANSACTIONS', 'TRANSACTIONS_REMOVED')).toBe(false);
    expect(wantsSync('ITEM', 'ERROR')).toBe(false);
  });
});
