import { describe, expect, it } from 'vitest';
import { decimals, int64String, toDecimalString } from '../src';

describe('decimalString', () => {
  it('accepts values within numeric(18,4)', () => {
    for (const ok of ['0', '2987.4', '2987.4000', '-0.05', '99999999999999.9999']) {
      expect(decimals.price.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('rejects numbers, exponents, excess digits and padding', () => {
    for (const bad of [2987.4, '1e3', '2987.40001', '100000000000000', '01.5', '.5', '5.', ' 1', 'NaN']) {
      expect(decimals.price.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('toDecimalString', () => {
  it('pads to the column scale', () => {
    expect(toDecimalString('2987.4', 4)).toBe('2987.4000');
    expect(toDecimalString('0.05', 4)).toBe('0.0500');
  });

  it('rounds half up and never emits negative zero', () => {
    expect(toDecimalString('1.00005', 4)).toBe('1.0001');
    expect(toDecimalString('-0.00001', 4)).toBe('0.0000');
  });

  it('is exact where binary floating point is not', () => {
    expect(toDecimalString('0.1', 20)).toBe('0.10000000000000000000');
  });

  it('refuses non-finite input', () => {
    expect(() => toDecimalString(Infinity, 2)).toThrow(RangeError);
  });
});

describe('int64String', () => {
  it('accepts the bigint range and nothing beyond it', () => {
    expect(int64String.safeParse('9223372036854775807').success).toBe(true);
    expect(int64String.safeParse('9223372036854775808').success).toBe(false);
    expect(int64String.safeParse('-9223372036854775808').success).toBe(true);
    expect(int64String.safeParse('12.5').success).toBe(false);
  });
});
