import { Decimal } from './values.ts';

/** Application-level forms of the invariants in 01 §5. Each returns the ids it finds violated. */
export type InvariantId = `INV-${number}`;

export interface BarValues {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: bigint;
  deliveryVolume: bigint | null;
}

// INV-01, INV-02, INV-03
export function barViolations(bar: BarValues): InvariantId[] {
  const out: InvariantId[] = [];
  const { open, high, low, close } = bar;
  if (high.lt(low) || high.lt(open) || high.lt(close) || low.gt(open) || low.gt(close)) out.push('INV-01');
  if (![open, high, low, close].every((p) => p.gt(0))) out.push('INV-02');
  const delivery = bar.deliveryVolume;
  if (bar.volume < 0n || (delivery !== null && (delivery < 0n || delivery > bar.volume))) out.push('INV-03');
  return out;
}

// INV-05: revision >= 1 and never decreases.
export function revisionViolations(previous: number | null, next: number): InvariantId[] {
  const ok = Number.isInteger(next) && next >= 1 && (previous === null || next >= previous);
  return ok ? [] : ['INV-05'];
}

// INV-08: seq is dense and starts at 1.
export function brickSeqViolations(seqs: readonly bigint[]): InvariantId[] {
  const sorted = [...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.every((s, i) => s === BigInt(i + 1)) ? [] : ['INV-08'];
}

/** round_half_up(p / tick) × tick (04 §5.2). */
export function roundToTick(price: Decimal, tick: Decimal): Decimal {
  return price.div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick);
}

/** brick_size_abs = max(tick_size, round_to_tick(anchor × brick_pct / 100)) (04 §5.2). */
export function expectedBrickSize(anchor: Decimal, brickPct: Decimal, tick: Decimal): Decimal {
  return Decimal.max(tick, roundToTick(anchor.mul(brickPct).div(100), tick));
}

// INV-10
export function brickSizeViolations(
  brickSize: Decimal,
  anchor: Decimal,
  brickPct: Decimal,
  tick: Decimal,
): InvariantId[] {
  return brickSize.gt(0) && brickSize.eq(expectedBrickSize(anchor, brickPct, tick)) ? [] : ['INV-10'];
}

// INV-11: ranks are a permutation of 1..N.
export function rankViolations(ranks: readonly number[]): InvariantId[] {
  const sorted = [...ranks].sort((a, b) => a - b);
  return sorted.every((r, i) => r === i + 1) ? [] : ['INV-11'];
}

// INV-12
export function breadthCountViolations(c: {
  positive: number;
  negative: number;
  total: number;
}): InvariantId[] {
  return c.positive >= 0 && c.negative >= 0 && c.positive + c.negative <= c.total ? [] : ['INV-12'];
}

// INV-17: a QUEUED job always has run_after and no lock holder.
export function queuedJobViolations(job: {
  status: string;
  runAfter: string | null;
  lockedBy: string | null;
}): InvariantId[] {
  return job.status !== 'QUEUED' || (job.runAfter !== null && job.lockedBy === null) ? [] : ['INV-17'];
}
