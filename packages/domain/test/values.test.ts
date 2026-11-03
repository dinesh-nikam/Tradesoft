import { describe, expect, it } from 'vitest';
import { DomainError, parseDecimal, parseId, parseInstant, parseIsoDate } from '../src';

describe('value objects', () => {
  it('parses plain decimal literals exactly', () => {
    expect(parseDecimal('0.1').plus(parseDecimal('0.2')).eq(parseDecimal('0.3'))).toBe(true);
  });

  it('rejects anything that is not a plain decimal literal', () => {
    for (const bad of ['1e3', 'NaN', 'Infinity', '', '0x10', '1,000']) {
      expect(() => parseDecimal(bad), bad).toThrow(DomainError);
    }
  });

  it('validates ids, dates and instants', () => {
    expect(parseId('018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70')).toBe('018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70');
    expect(() => parseId('not-a-uuid')).toThrow(DomainError);
    expect(parseIsoDate('2024-02-29')).toBe('2024-02-29');
    expect(() => parseIsoDate('2026-02-29')).toThrow(DomainError);
    expect(() => parseInstant('2026-03-13T09:15:00Z')).toThrow(DomainError);
  });
});
