import { describe, expect, it } from 'vitest';
import {
  barViolations,
  breadthCountViolations,
  brickSeqViolations,
  brickSizeViolations,
  expectedBrickSize,
  parseDecimal as d,
  queuedJobViolations,
  rankViolations,
  revisionViolations,
} from '../src';

const bar = {
  open: d('100'),
  high: d('105'),
  low: d('99'),
  close: d('104'),
  volume: 1000n,
  deliveryVolume: 400n,
};

describe('bar invariants', () => {
  it('accepts a valid bar, including open = low', () => {
    expect(barViolations(bar)).toEqual([]);
    expect(barViolations({ ...bar, open: d('99') })).toEqual([]);
  });

  it('INV-01 rejects a high below the close', () => {
    expect(barViolations({ ...bar, high: d('103.9999') })).toEqual(['INV-01']);
  });

  it('INV-02 rejects a zero price', () => {
    expect(barViolations({ ...bar, low: d('0') })).toEqual(['INV-02']);
  });

  it('INV-03 rejects negative volume and delivery above volume', () => {
    expect(barViolations({ ...bar, volume: -1n, deliveryVolume: null })).toEqual(['INV-03']);
    expect(barViolations({ ...bar, deliveryVolume: 1001n })).toEqual(['INV-03']);
  });

  it('compares exactly, not in binary floating point', () => {
    const p = d('0.3');
    expect(barViolations({ ...bar, open: p, low: d('0.1').plus(d('0.2')), high: p, close: p })).toEqual([]);
  });
});

describe('other invariants', () => {
  it('INV-05 revision starts at 1 and never decreases', () => {
    expect(revisionViolations(null, 1)).toEqual([]);
    expect(revisionViolations(2, 2)).toEqual([]);
    expect(revisionViolations(3, 2)).toEqual(['INV-05']);
    expect(revisionViolations(null, 0)).toEqual(['INV-05']);
  });

  it('INV-08 brick seq is dense from 1', () => {
    expect(brickSeqViolations([3n, 1n, 2n])).toEqual([]);
    expect(brickSeqViolations([1n, 3n])).toEqual(['INV-08']);
    expect(brickSeqViolations([0n, 1n])).toEqual(['INV-08']);
  });

  it('INV-10 brick size follows 04 §5.2, including the one-tick floor', () => {
    // 04 §5.2 example: ₹1,234.55 at 0.25 % with a 0.05 tick is ₹3.10, not ₹3.09.
    expect(expectedBrickSize(d('1234.55'), d('0.25'), d('0.05')).toFixed(2)).toBe('3.10');
    // ₹10 at 0.1 % is ₹0.01, which floors to one tick.
    expect(expectedBrickSize(d('10'), d('0.1'), d('0.05')).toFixed(2)).toBe('0.05');
    expect(brickSizeViolations(d('3.10'), d('1234.55'), d('0.25'), d('0.05'))).toEqual([]);
    expect(brickSizeViolations(d('3.05'), d('1234.55'), d('0.25'), d('0.05'))).toEqual(['INV-10']);
  });

  it('INV-11 ranks are a permutation of 1..N', () => {
    expect(rankViolations([2, 1, 3])).toEqual([]);
    expect(rankViolations([1, 1, 3])).toEqual(['INV-11']);
  });

  it('INV-12 positive plus negative bricks never exceed members', () => {
    expect(breadthCountViolations({ positive: 3, negative: 2, total: 5 })).toEqual([]);
    expect(breadthCountViolations({ positive: 4, negative: 2, total: 5 })).toEqual(['INV-12']);
  });

  it('INV-17 a queued job has run_after and no lock holder', () => {
    expect(queuedJobViolations({ status: 'QUEUED', runAfter: 't', lockedBy: null })).toEqual([]);
    expect(queuedJobViolations({ status: 'QUEUED', runAfter: 't', lockedBy: 'w1' })).toEqual(['INV-17']);
    expect(queuedJobViolations({ status: 'RUNNING', runAfter: null, lockedBy: 'w1' })).toEqual([]);
  });
});
