import { Money } from '@accounting/money';
import type {
  MappingCondition,
  MappingFieldRuleInput,
  MappingTransform,
} from '@accounting/validation';

/**
 * Pure field-mapping engine: external record -> internal input.
 *
 *   rules: [{ target: 'name', source: 'customer.name', transforms: [{name:'trim'}], required: true },
 *           { target: 'status', source: 'state', transforms: [{name:'lookup', arg:'status'}] },
 *           { target: 'currency', default: 'PHP' }]
 *
 * Paths are dotted (`a.b.0.c`). Transforms run in order; `lookup` reads the
 * named table from `ctx.lookups`; `convertCurrency` only converts when the
 * caller supplies an explicit rate (never a guessed one). Errors are
 * collected per target so a bad record fails as MAPPING_ERROR with every
 * problem listed, not just the first.
 */
export interface MappingContext {
  lookups?: Record<string, Record<string, unknown>>;
  /** Explicit rates for `convertCurrency`: { 'USD->PHP': '56.1200' }. */
  rates?: Record<string, string>;
  now?: Date;
}

export interface MappingResult {
  output: Record<string, unknown>;
  errors: Array<{ target: string; message: string }>;
}

export function getPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      current = Number.isInteger(idx) ? current[idx] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return current;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    const next = current[seg];
    if (next === null || typeof next !== 'object') current[seg] = {};
    current = current[seg] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

export function evaluateCondition(input: unknown, condition: MappingCondition): boolean {
  const actual = getPath(input, condition.path);
  const expected = condition.value;
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'missing':
      return actual === undefined || actual === null;
    case 'eq':
      return looseEquals(actual, expected);
    case 'ne':
      return !looseEquals(actual, expected);
    case 'in':
      return Array.isArray(expected) && expected.some((v) => looseEquals(actual, v));
    case 'notIn':
      return Array.isArray(expected) && !expected.some((v) => looseEquals(actual, v));
    case 'gt':
      return toNumber(actual) > toNumber(expected);
    case 'gte':
      return toNumber(actual) >= toNumber(expected);
    case 'lt':
      return toNumber(actual) < toNumber(expected);
    case 'lte':
      return toNumber(actual) <= toNumber(expected);
    case 'matches':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        new RegExp(expected).test(actual)
      );
    default:
      return false;
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

export class TransformError extends Error {}

export function applyTransform(value: unknown, t: MappingTransform, ctx: MappingContext): unknown {
  switch (t.name) {
    case 'default':
      return value === undefined || value === null || value === '' ? t.arg : value;
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'upper':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'toString':
      return value === undefined || value === null ? value : String(value);
    case 'toNumber': {
      if (value === undefined || value === null || value === '') return undefined;
      const n = toNumber(value);
      if (Number.isNaN(n)) throw new TransformError(`"${String(value)}" is not a number`);
      return n;
    }
    case 'toInteger': {
      if (value === undefined || value === null || value === '') return undefined;
      const n = toNumber(value);
      if (!Number.isInteger(n)) throw new TransformError(`"${String(value)}" is not an integer`);
      return n;
    }
    case 'toDecimal': {
      // Decimal *string* with the requested scale (default 4) - never a float.
      if (value === undefined || value === null || value === '') return undefined;
      const scale = typeof t.arg === 'number' ? t.arg : 4;
      const raw =
        typeof value === 'number' ? value.toString() : String(value).replace(/,/g, '').trim();
      if (!/^-?\d+(\.\d+)?$/.test(raw))
        throw new TransformError(`"${String(value)}" is not a decimal`);
      const [int, frac = ''] = raw.split('.');
      const negative = int!.startsWith('-');
      const digits = (negative ? int!.slice(1) : int!) + frac.padEnd(scale, '0').slice(0, scale);
      // Round half-even is unnecessary here: providers send at most 2-4 decimals; we truncate extra digits explicitly.
      const whole = digits.slice(0, digits.length - scale) || '0';
      const fraction = digits.slice(digits.length - scale);
      return `${negative ? '-' : ''}${whole.replace(/^0+(?=\d)/, '')}${scale ? `.${fraction}` : ''}`;
    }
    case 'toBoolean': {
      if (typeof value === 'boolean') return value;
      if (value === undefined || value === null) return undefined;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'n', ''].includes(s)) return false;
      throw new TransformError(`"${String(value)}" is not a boolean`);
    }
    case 'toDate': {
      if (value === undefined || value === null || value === '') return undefined;
      const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
      if (Number.isNaN(d.getTime())) throw new TransformError(`"${String(value)}" is not a date`);
      return d.toISOString().slice(0, 10);
    }
    case 'negate':
      return typeof value === 'string' && /^-?\d/.test(value)
        ? value.startsWith('-')
          ? value.slice(1)
          : `-${value}`
        : typeof value === 'number'
          ? -value
          : value;
    case 'abs':
      return typeof value === 'string'
        ? value.replace(/^-/, '')
        : typeof value === 'number'
          ? Math.abs(value)
          : value;
    case 'multiply':
    case 'divide': {
      if (value === undefined || value === null) return value;
      const factor = String(t.arg ?? '1');
      const a = Money.of(String(value), 'XXX');
      const result = t.name === 'multiply' ? a.multiply(factor) : a.divide(factor);
      return result.toString();
    }
    case 'template': {
      const template = String(t.arg ?? '');
      const scope =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)
          : { value };
      return template.replace(/\{([^}]+)\}/g, (_, path: string) => {
        const v = getPath(scope, path.trim());
        return v === undefined || v === null ? '' : String(v);
      });
    }
    case 'lookup': {
      const table = ctx.lookups?.[String(t.arg ?? '')];
      if (!table) throw new TransformError(`lookup table "${String(t.arg)}" not found`);
      if (value === undefined || value === null) return undefined;
      const key = String(value);
      if (key in table) return table[key];
      const lower = Object.keys(table).find((k) => k.toLowerCase() === key.toLowerCase());
      if (lower !== undefined) return table[lower];
      if ('*' in table) return table['*'];
      throw new TransformError(`"${key}" has no lookup entry in "${String(t.arg)}"`);
    }
    case 'convertCurrency': {
      // Explicit only: { from: 'USD', to: 'PHP' } with a rate supplied by the caller.
      if (value === undefined || value === null) return value;
      const arg = (t.arg ?? {}) as { from?: string; to?: string };
      if (!arg.from || !arg.to) throw new TransformError('convertCurrency needs from/to');
      if (arg.from === arg.to) return value;
      const rate = ctx.rates?.[`${arg.from}->${arg.to}`];
      if (!rate) throw new TransformError(`no explicit rate for ${arg.from}->${arg.to}`);
      return Money.of(String(value), arg.from).convert(arg.to, rate).toString();
    }
    case 'mapEach': {
      // Nested mapping: apply a rule set to every element of an array (invoice lines, addresses...).
      if (value === undefined || value === null) return value;
      if (!Array.isArray(value)) throw new TransformError('mapEach expects an array');
      const rules = Array.isArray(t.arg) ? (t.arg as MappingFieldRuleInput[]) : [];
      return value.map((item, index) => {
        const nested = applyMapping(
          rules,
          (item && typeof item === 'object' ? item : { value: item }) as Record<string, unknown>,
          ctx,
        );
        if (nested.errors.length)
          throw new TransformError(
            `item ${index}: ${nested.errors.map((e) => `${e.target} ${e.message}`).join(', ')}`,
          );
        return nested.output;
      });
    }
    case 'first':
      return Array.isArray(value) ? value[0] : value;
    case 'count':
      return Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
    default:
      throw new TransformError(`unknown transform ${(t as { name: string }).name}`);
  }
}

export function applyMapping(
  rules: readonly MappingFieldRuleInput[],
  input: Record<string, unknown>,
  ctx: MappingContext = {},
): MappingResult {
  const output: Record<string, unknown> = {};
  const errors: MappingResult['errors'] = [];
  for (const rule of rules) {
    if (rule.when && !evaluateCondition(input, rule.when)) continue;
    let value = rule.source ? getPath(input, rule.source) : undefined;
    if ((value === undefined || value === null || value === '') && rule.default !== undefined)
      value = rule.default;
    try {
      for (const t of rule.transforms ?? []) value = applyTransform(value, t, ctx);
    } catch (err) {
      errors.push({
        target: rule.target,
        message: err instanceof Error ? err.message : 'transform failed',
      });
      continue;
    }
    if (value === undefined || value === null) {
      if (rule.required)
        errors.push({
          target: rule.target,
          message: `required (source "${rule.source ?? '-'}" missing)`,
        });
      continue;
    }
    setPath(output, rule.target, value);
  }
  return { output, errors };
}

/** Identity-style rules for fields that already match (handy default mappings). */
export function passthroughRules(
  fields: readonly string[],
  required: readonly string[] = [],
): MappingFieldRuleInput[] {
  return fields.map((f) => ({
    target: f,
    source: f,
    transforms: [],
    required: required.includes(f),
  }));
}
