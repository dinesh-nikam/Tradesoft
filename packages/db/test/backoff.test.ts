import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../src/jobs.ts';

describe('backoffDelayMs (03 §5.2)', () => {
  it('doubles per attempt from the base, then caps', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffDelayMs(a, 30_000, 600_000, 1))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    expect(backoffDelayMs(6, 30_000, 600_000, 1)).toBe(600_000);
  });

  it('jitters between 50 % and 100 % of the capped value', () => {
    expect(backoffDelayMs(3, 30_000, 600_000, 0)).toBe(60_000);
    expect(backoffDelayMs(3, 30_000, 600_000, 0.5)).toBe(90_000);
  });
});
