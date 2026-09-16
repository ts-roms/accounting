import Decimal from 'decimal.js';

/**
 * Exact-decimal monetary value. Immutable.
 *
 * - Backed by decimal.js (arbitrary precision); never a JS float.
 * - Scale defaults to 4 fractional digits, matching NUMERIC(19,4) storage.
 * - Serialises to a plain decimal string ("1250.0000"); the API never emits
 *   JSON numbers for amounts.
 * - Arithmetic between different currencies throws.
 */
const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export const DEFAULT_SCALE = 4;

export type MoneyInput = Money | Decimal | string | number | bigint;

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
    readonly scale: number,
  ) {}

  static of(amount: MoneyInput, currency: string, scale = DEFAULT_SCALE): Money {
    if (amount instanceof Money) {
      if (amount.currency !== currency) throw new CurrencyMismatchError(amount.currency, currency);
      return amount.scale === scale
        ? amount
        : new Money(amount.value.toDecimalPlaces(scale), currency, scale);
    }
    if (typeof amount === 'number' && !Number.isFinite(amount))
      throw new InvalidAmountError(String(amount));
    let dec: Decimal;
    try {
      dec = new MoneyDecimal(typeof amount === 'bigint' ? amount.toString() : amount);
    } catch {
      throw new InvalidAmountError(String(amount));
    }
    if (dec.isNaN()) throw new InvalidAmountError(String(amount));
    return new Money(
      dec.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN),
      currency.toUpperCase(),
      scale,
    );
  }

  static zero(currency: string, scale = DEFAULT_SCALE): Money {
    return new Money(new MoneyDecimal(0), currency.toUpperCase(), scale);
  }

  /** Parses a decimal string strictly (no exponent, no whitespace, at most `scale` decimals). */
  static parse(text: string, currency: string, scale = DEFAULT_SCALE): Money {
    if (!Money.isValidDecimalString(text, scale)) throw new InvalidAmountError(text);
    return Money.of(text, currency, scale);
  }

  static isValidDecimalString(text: unknown, scale = DEFAULT_SCALE): text is string {
    if (typeof text !== 'string') return false;
    return new RegExp(`^-?\\d{1,15}(\\.\\d{1,${scale}})?$`).test(text);
  }

  static sum(items: readonly Money[], currency: string, scale = DEFAULT_SCALE): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero(currency, scale));
  }

  // ------------------------------------------------------------ arithmetic

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency, this.scale);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency, this.scale);
  }

  /** Multiplies by an exact factor (rate, quantity) and rounds half-even to scale. */
  multiply(factor: string | number | Decimal): Money {
    const result = this.value
      .times(new MoneyDecimal(factor))
      .toDecimalPlaces(this.scale, Decimal.ROUND_HALF_EVEN);
    return new Money(result, this.currency, this.scale);
  }

  /**
   * Converts into another currency at an exact rate (1 unit of this currency =
   * `rate` units of `toCurrency`), half-even to the target scale. Same-currency
   * conversion at rate 1 is the identity.
   */
  convert(toCurrency: string, rate: string | number | Decimal, scale = this.scale): Money {
    const r = new MoneyDecimal(rate);
    if (r.lte(0)) throw new InvalidAmountError('exchange rate must be positive');
    return new Money(
      this.value.times(r).toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN),
      toCurrency,
      scale,
    );
  }

  divide(divisor: string | number | Decimal): Money {
    const d = new MoneyDecimal(divisor);
    if (d.isZero()) throw new InvalidAmountError('division by zero');
    return new Money(
      this.value.div(d).toDecimalPlaces(this.scale, Decimal.ROUND_HALF_EVEN),
      this.currency,
      this.scale,
    );
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency, this.scale);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency, this.scale);
  }

  /**
   * Splits the amount by integer ratios without losing a single minor unit;
   * remainders go to the earliest parts (largest-remainder method).
   */
  allocate(ratios: readonly number[]): Money[] {
    if (ratios.length === 0) throw new InvalidAmountError('allocate requires at least one ratio');
    const total = ratios.reduce((a, b) => a + b, 0);
    if (total <= 0 || ratios.some((r) => r < 0))
      throw new InvalidAmountError('ratios must be non-negative and sum > 0');
    const unit = new MoneyDecimal(10).pow(-this.scale);
    const parts: Decimal[] = ratios.map((r) =>
      this.value.times(r).div(total).toDecimalPlaces(this.scale, Decimal.ROUND_DOWN),
    );
    let remainder = this.value.minus(parts.reduce((a, b) => a.plus(b), new MoneyDecimal(0)));
    for (let i = 0; !remainder.isZero() && i < parts.length; i += 1) {
      const step = remainder.isNegative() ? unit.negated() : unit;
      parts[i] = parts[i]!.plus(step);
      remainder = remainder.minus(step);
    }
    return parts.map((p) => new Money(p, this.currency, this.scale));
  }

  // ------------------------------------------------------------ comparison

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  // ------------------------------------------------------------ conversion

  /** Fixed-scale decimal string, e.g. "1250.0000". Safe for NUMERIC columns and JSON. */
  toString(): string {
    return this.value.toFixed(this.scale);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Lossy - only for display/charting, never for accounting arithmetic. */
  toNumber(): number {
    return this.value.toNumber();
  }

  toDecimal(): Decimal {
    return new MoneyDecimal(this.value);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidAmountError extends Error {
  constructor(input: string) {
    super(`Invalid monetary amount: ${input}`);
    this.name = 'InvalidAmountError';
  }
}
