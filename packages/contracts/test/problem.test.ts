import { describe, expect, it } from 'vitest';
import {
  collection,
  decimals,
  instant,
  isoDate,
  page,
  problem,
  problemDetails,
  uuidV7,
} from '../src/index.ts';

describe('problem', () => {
  it('builds a document that its own schema accepts', () => {
    const p = problem('SCANNER_TIMEOUT', {
      detail: 'Statement exceeded 5000 ms',
      instance: '/api/v1/scanners/x/runs',
      correlationId: 'req-1',
    });
    expect(p).toMatchObject({
      status: 504,
      retryable: true,
      type: 'urn:tradesoft:problem:v1:scanner-timeout',
    });
    expect(problemDetails.safeParse(p).success).toBe(true);
    expect('errors' in p).toBe(false);
  });

  it('rejects a status that disagrees with the code', () => {
    const p = {
      ...problem('RESOURCE_NOT_FOUND', { detail: '', instance: '/x', correlationId: 'r' }),
      status: 500,
    };
    expect(problemDetails.safeParse(p).success).toBe(false);
  });
});

describe('collection envelope', () => {
  const list = collection(decimals.price);

  it('requires nextCursor exactly when hasMore', () => {
    expect(
      list.safeParse({ data: ['1.0000'], page: { limit: 50, hasMore: false, nextCursor: null } }).success,
    ).toBe(true);
    expect(list.safeParse({ data: [], page: { limit: 50, hasMore: true, nextCursor: null } }).success).toBe(
      false,
    );
    expect(page.safeParse({ limit: 50, hasMore: true, nextCursor: 'eyJ2IjoxfQ.c2ln' }).success).toBe(true);
  });
});

describe('scalars', () => {
  it('validates UUIDv7, calendar dates and UTC instants', () => {
    expect(uuidV7.safeParse('018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70').success).toBe(true);
    expect(uuidV7.safeParse('018F2C4A-7B31-7C9E-9A1F-2B3C4D5E6F70').success).toBe(false);
    expect(uuidV7.safeParse('018f2c4a-7b31-4c9e-9a1f-2b3c4d5e6f70').success).toBe(false);
    expect(isoDate.safeParse('2026-02-28').success).toBe(true);
    expect(isoDate.safeParse('2026-02-30').success).toBe(false);
    expect(instant.safeParse('2026-03-13T09:15:00.000Z').success).toBe(true);
    expect(instant.safeParse('2026-03-13T14:45:00.000+05:30').success).toBe(false);
  });
});
