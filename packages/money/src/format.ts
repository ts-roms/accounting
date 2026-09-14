import type { Money } from './money';

/**
 * Display formatting for the UI. Accounting convention: negatives in parentheses
 * when `accounting` is true; grouping separators; currency-aware fraction digits
 * (display precision, not storage precision).
 */
export interface FormatOptions {
  locale?: string;
  fractionDigits?: number;
  accounting?: boolean;
  showCurrency?: boolean;
}

export function formatMoney(
  money: Money | string,
  currency = 'PHP',
  options: FormatOptions = {},
): string {
  const { locale = 'en-PH', fractionDigits = 2, accounting = true, showCurrency = false } = options;
  const text = typeof money === 'string' ? money : money.toString();
  const cur = typeof money === 'string' ? currency : money.currency;
  const negative = text.startsWith('-');
  const [intPart = '0', fracPart = ''] = text.replace('-', '').split('.');

  // Round the string representation to the display precision (half-up on the
  // decimal digits) without going through binary floating point.
  let digits = intPart + fracPart.padEnd(fractionDigits + 1, '0').slice(0, fractionDigits + 1);
  let carry = Number(digits[digits.length - 1]) >= 5 ? 1 : 0;
  digits = digits.slice(0, -1);
  let rounded = '';
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = Number(digits[i]) + carry;
    rounded = String(d % 10) + rounded;
    carry = d >= 10 ? 1 : 0;
  }
  if (carry) rounded = '1' + rounded;
  const whole = rounded.slice(0, rounded.length - fractionDigits) || '0';
  const frac = rounded.slice(rounded.length - fractionDigits);

  const groupedWhole = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(Number(whole));
  const body = fractionDigits > 0 ? `${groupedWhole}.${frac}` : groupedWhole;
  const withCurrency = showCurrency ? `${cur} ${body}` : body;
  if (!negative || body.replace(/[0,.]/g, '') === '') return withCurrency;
  return accounting ? `(${withCurrency})` : `-${withCurrency}`;
}
