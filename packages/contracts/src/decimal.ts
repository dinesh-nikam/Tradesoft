import { Decimal } from 'decimal.js';
import { z } from 'zod';

/**
 * A numeric(precision, scale) value as a JSON string (05 §4.1). Requests may omit trailing zeros;
 * responses are produced by toDecimalString and always carry the full scale.
 */
export function decimalString(precision: number, scale: number) {
  const intDigits = precision - scale;
  const fraction = scale > 0 ? `(\\.\\d{1,${scale}})?` : '';
  const pattern = new RegExp(`^-?(0|[1-9]\\d{0,${intDigits - 1}})${fraction}$`);
  return z
    .string()
    .regex(
      pattern,
      `Expected a decimal string with at most ${intDigits} integer and ${scale} fraction digits`,
    )
    .brand<'DecimalString'>();
}
export type DecimalString = z.infer<ReturnType<typeof decimalString>>;

// The column types of 05 §4.1.
export const decimals = {
  price: decimalString(18, 4),
  indicator: decimalString(18, 6),
  percent: decimalString(9, 4),
  percentile: decimalString(9, 6),
  ratio: decimalString(18, 8),
  turnover: decimalString(24, 4),
} as const;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// bigint volume and open interest (05 §4.1).
export const int64String = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,18})$/, 'Expected an integer string')
  // Zod keeps running checks after a failed regex, so the range check guards its own input.
  .refine((s) => {
    if (!/^-?\d+$/.test(s)) return true;
    const n = BigInt(s);
    return n >= INT64_MIN && n <= INT64_MAX;
  }, 'Outside the bigint range')
  .brand<'Int64String'>();

/** The single serialiser for numeric values: fixed scale, half-up, never "-0". */
export function toDecimalString(value: Decimal.Value, scale: number): string {
  const d = new Decimal(value);
  if (!d.isFinite()) throw new RangeError('Cannot serialise a non-finite decimal');
  const fixed = d.toFixed(scale, Decimal.ROUND_HALF_UP);
  return /^-0(\.0*)?$/.test(fixed) ? fixed.slice(1) : fixed;
}
