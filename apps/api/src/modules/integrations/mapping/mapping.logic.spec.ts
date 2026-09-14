import { applyMapping, applyTransform, evaluateCondition, getPath, setPath } from './mapping.logic';

describe('mapping.logic', () => {
  it('reads and writes dotted paths, including array indexes', () => {
    const src = { a: { b: [{ c: 'x' }, { c: 'y' }] } };
    expect(getPath(src, 'a.b.1.c')).toBe('y');
    expect(getPath(src, 'a.missing.c')).toBeUndefined();
    const out: Record<string, unknown> = {};
    setPath(out, 'party.address.city', 'Davao');
    expect(out).toEqual({ party: { address: { city: 'Davao' } } });
  });

  it('applies rules with defaults, transforms, lookups and conditions', () => {
    const result = applyMapping(
      [
        { target: 'name', source: 'customer.name', transforms: [{ name: 'trim' }], required: true },
        { target: 'email', source: 'customer.email', transforms: [{ name: 'lower' }] },
        {
          target: 'code',
          source: 'customer.id',
          transforms: [{ name: 'template', arg: 'EC-{value}' }],
        },
        { target: 'currency', default: 'PHP' },
        {
          target: 'paymentStatus',
          source: 'status',
          transforms: [{ name: 'lookup', arg: 'status' }],
        },
        { target: 'amount', source: 'total', transforms: [{ name: 'toDecimal', arg: 4 }] },
        { target: 'vip', when: { path: 'tier', op: 'eq', value: 'gold' }, default: true },
        { target: 'never', when: { path: 'tier', op: 'eq', value: 'silver' }, default: true },
      ],
      {
        customer: { name: '  Acme ', email: 'A@B.CO', id: 42 },
        status: 'paid',
        total: 1234.5,
        tier: 'gold',
      },
      { lookups: { status: { paid: 'PAID', open: 'OPEN' } } },
    );
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual({
      name: 'Acme',
      email: 'a@b.co',
      code: 'EC-42',
      currency: 'PHP',
      paymentStatus: 'PAID',
      amount: '1234.5000',
      vip: true,
    });
  });

  it('collects every problem instead of failing on the first', () => {
    const result = applyMapping(
      [
        { target: 'name', source: 'name', required: true },
        { target: 'qty', source: 'qty', transforms: [{ name: 'toInteger' }] },
        { target: 'status', source: 'status', transforms: [{ name: 'lookup', arg: 'status' }] },
      ],
      { qty: '1.5', status: 'weird' },
      { lookups: { status: { paid: 'PAID' } } },
    );
    expect(result.errors.map((e) => e.target).sort()).toEqual(['name', 'qty', 'status']);
    expect(result.output).toEqual({});
  });

  it('never converts currency without an explicit rate', () => {
    expect(() =>
      applyTransform('100', { name: 'convertCurrency', arg: { from: 'USD', to: 'PHP' } }, {}),
    ).toThrow(/no explicit rate/);
    expect(
      applyTransform(
        '100',
        { name: 'convertCurrency', arg: { from: 'USD', to: 'PHP' } },
        { rates: { 'USD->PHP': '56.5' } },
      ),
    ).toBe('5650.0000');
  });

  it('keeps decimals as strings and handles signs', () => {
    expect(applyTransform('1,250.5', { name: 'toDecimal' }, {})).toBe('1250.5000');
    expect(applyTransform(-3, { name: 'toDecimal', arg: 2 }, {})).toBe('-3.00');
    expect(applyTransform('12.34', { name: 'negate' }, {})).toBe('-12.34');
    expect(applyTransform('-12.34', { name: 'abs' }, {})).toBe('12.34');
    expect(applyTransform('10', { name: 'multiply', arg: '1.12' }, {})).toBe('11.2000');
    expect(() => applyTransform('abc', { name: 'toDecimal' }, {})).toThrow(/not a decimal/);
  });

  it('maps nested arrays with mapEach', () => {
    const result = applyMapping(
      [
        {
          target: 'lines',
          source: 'items',
          transforms: [
            {
              name: 'mapEach',
              arg: [
                { target: 'description', source: 'title', required: true },
                { target: 'unitPrice', source: 'price', transforms: [{ name: 'toDecimal' }] },
              ],
            },
          ],
        },
      ],
      {
        items: [
          { title: 'A', price: 10 },
          { title: 'B', price: '2.5' },
        ],
      },
    );
    expect(result.output).toEqual({
      lines: [
        { description: 'A', unitPrice: '10.0000' },
        { description: 'B', unitPrice: '2.5000' },
      ],
    });
  });

  it('evaluates conditions', () => {
    const input = { status: 'paid', amount: '150', tags: ['a'] };
    expect(evaluateCondition(input, { path: 'status', op: 'in', value: ['paid', 'settled'] })).toBe(
      true,
    );
    expect(evaluateCondition(input, { path: 'amount', op: 'gt', value: 100 })).toBe(true);
    expect(evaluateCondition(input, { path: 'missing', op: 'exists' })).toBe(false);
    expect(evaluateCondition(input, { path: 'status', op: 'matches', value: '^pa' })).toBe(true);
  });
});
