import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  effectiveMembers,
  migrate,
  resolveGroup,
  resolveSymbol,
  sessionBounds,
  tradingDays,
} from '../src/index.ts';

const adminUrl = testDatabaseUrl();

describe.skipIf(!adminUrl)('market reference (E4.1, E4.2)', { timeout: 60_000 }, () => {
  let db: ScratchDatabase;
  let c: pg.Client;
  const ids: Record<string, string> = {};
  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
  const instrument = (exchange: string, symbol: string, listing: string, delisting: string | null = null) =>
    one(
      `insert into ref.instrument (exchange_id, symbol, name, instrument_type, asset_class, listing_date, delisting_date, status)
       values ($1, $2, $2, 'EQUITY', 'EQUITY', $3, $4, case when $4::date is null then 'ACTIVE' else 'DELISTED' end)
       returning id::text`,
      [ids[exchange], symbol, listing, delisting],
    );
  const day = (exchange: string, date: string, open: string | null, close: string | null, special = false) =>
    c.query(
      `insert into ref.trading_calendar (exchange_id, calendar_date, is_trading_day, session_open_at, session_close_at, is_special, description)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ids[exchange], date, open !== null, open, close, special, special ? 'Muhurat trading' : null],
    );

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    c = await db.connect();
    await migrate(c);
    for (const [code, open, close] of [
      ['NSE', '09:15', '15:30'],
      ['MCX', '09:00', '23:30'],
    ])
      ids[code!] = await one(
        `insert into ref.exchange (code, name, default_open_time, default_close_time) values ($1, $1, $2, $3) returning id::text`,
        [code, open, close],
      );

    // RENAMED was OLDNAME until 2024-06-30. GONE was delisted on 2022-03-31 and its symbol was re-used by a
    // new listing on 2025-01-01; the delisted row keeps its old symbol as an alias.
    ids.renamed = await instrument('NSE', 'RENAMED', '2010-01-01');
    await c.query(
      `insert into ref.symbol_alias (instrument_id, alias_symbol, exchange_id, valid_from, valid_to)
       values ($1, 'OLDNAME', $2, '2010-01-01', '2024-06-30')`,
      [ids.renamed, ids.NSE],
    );
    ids.delisted = await instrument('NSE', 'GONE~2022', '2005-01-01', '2022-03-31');
    await c.query(
      `insert into ref.symbol_alias (instrument_id, alias_symbol, exchange_id, valid_from, valid_to, reason)
       values ($1, 'GONE', $2, '2005-01-01', '2022-03-31', 'DELISTED')`,
      [ids.delisted, ids.NSE],
    );
    ids.relisted = await instrument('NSE', 'GONE', '2025-01-01');
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await db?.drop();
  }, 60_000);

  const resolve = (symbol: string, asOf: string) => resolveSymbol(c, { exchangeCode: 'NSE', symbol, asOf });

  it('resolves a renamed symbol by date', async () => {
    expect(await resolve('OLDNAME', '2024-06-30')).toEqual({ kind: 'FOUND', instrumentId: ids.renamed });
    expect(await resolve('OLDNAME', '2024-07-01')).toEqual({ kind: 'UNKNOWN' });
    expect(await resolve('RENAMED', '2024-06-30')).toEqual({ kind: 'UNKNOWN' });
    expect(await resolve('RENAMED', '2024-07-01')).toEqual({ kind: 'FOUND', instrumentId: ids.renamed });
  });

  it('resolves a delisted symbol before delisting, nothing in the gap, and the re-listing after', async () => {
    expect(await resolve('GONE', '2022-03-31')).toEqual({ kind: 'FOUND', instrumentId: ids.delisted });
    expect(await resolve('GONE', '2023-05-01')).toEqual({ kind: 'UNKNOWN' });
    expect(await resolve('GONE', '2025-01-01')).toEqual({ kind: 'FOUND', instrumentId: ids.relisted });
  });

  it('reports a symbol claimed by two instruments on one date as ambiguous', async () => {
    const other = await instrument('NSE', 'CLASH', '2020-01-01');
    await c.query(
      `insert into ref.symbol_alias (instrument_id, alias_symbol, exchange_id, valid_from) values ($1, 'CLASH', $2, '2020-01-01')`,
      [ids.renamed, ids.NSE],
    );
    expect(await resolve('CLASH', '2021-01-01')).toEqual({
      kind: 'AMBIGUOUS',
      instrumentIds: [other, ids.renamed].sort(),
    });
  });

  it('reads session bounds from calendar rows: normal, extended, Muhurat and holiday', async () => {
    await day('NSE', '2026-11-03', '2026-11-03T09:15:00+05:30', '2026-11-03T15:30:00+05:30');
    await day('MCX', '2026-11-03', '2026-11-03T09:00:00+05:30', '2026-11-03T23:55:00+05:30');
    await day('NSE', '2026-11-08', '2026-11-08T18:00:00+05:30', '2026-11-08T19:00:00+05:30', true);
    await day('NSE', '2026-11-09', null, null);

    const nse = await sessionBounds(c, 'NSE', '2026-11-03');
    expect([nse.openAt?.toISOString(), nse.closeAt?.toISOString()]).toEqual([
      '2026-11-03T03:45:00.000Z',
      '2026-11-03T10:00:00.000Z',
    ]);
    // The MCX row closes at 23:55, not the exchange default of 23:30: the row wins.
    expect((await sessionBounds(c, 'MCX', '2026-11-03')).closeAt?.toISOString()).toBe(
      '2026-11-03T18:25:00.000Z',
    );
    expect(await sessionBounds(c, 'NSE', '2026-11-08')).toMatchObject({
      isTradingDay: true,
      isSpecial: true,
      description: 'Muhurat trading',
    });
    expect(await sessionBounds(c, 'NSE', '2026-11-09')).toMatchObject({
      isTradingDay: false,
      openAt: null,
      closeAt: null,
    });
  });

  it('refuses a date without a calendar row instead of treating it as a holiday (BR-008)', async () => {
    await expect(sessionBounds(c, 'NSE', '2026-11-04')).rejects.toMatchObject({
      code: 'CALENDAR_DAY_NOT_FOUND',
    });
    await expect(tradingDays(c, 'NSE', '2026-11-03', '2026-11-05')).rejects.toMatchObject({
      code: 'CALENDAR_DAY_NOT_FOUND',
    });
    await expect(sessionBounds(c, 'XYZ', '2026-11-03')).rejects.toMatchObject({ code: 'EXCHANGE_NOT_FOUND' });
  });

  it('lists trading days over a range', async () => {
    await day('NSE', '2026-11-10', '2026-11-10T09:15:00+05:30', '2026-11-10T15:30:00+05:30');
    expect(await tradingDays(c, 'NSE', '2026-11-08', '2026-11-10')).toEqual(['2026-11-08', '2026-11-10']);
  });

  it('resolves index constituents and static group members as of a date (BR-005, BR-006)', async () => {
    const index = await one(
      `insert into ref.instrument (exchange_id, symbol, name, instrument_type, asset_class) values ($1, 'NIFTY', 'Nifty', 'INDEX', 'EQUITY') returning id::text`,
      [ids.NSE],
    );
    await c.query(
      `insert into ref.index_membership (index_instrument_id, member_instrument_id, effective_from, effective_to, weight)
       values ($1, $2, '2020-01-01', '2023-12-31', 1.5), ($1, $3, '2024-01-01', null, null)`,
      [index, ids.delisted, ids.renamed],
    );
    expect(await effectiveMembers(c, index, '2023-12-31')).toEqual([
      { instrumentId: ids.delisted, weight: '1.500000' },
    ]);
    expect(await effectiveMembers(c, index, '2024-01-01')).toEqual([
      { instrumentId: ids.renamed, weight: null },
    ]);

    const group = await one(
      `insert into ref.market_group (code, name, group_type) values ('G1', 'G1', 'CUSTOM') returning id::text`,
      [],
    );
    await c.query(
      `insert into ref.market_group_member (group_id, instrument_id, added_on, removed_on)
       values ($1, $2, '2020-01-01', null), ($1, $3, '2020-01-01', '2024-01-01')`,
      [group, ids.delisted, ids.renamed],
    );
    expect(await resolveGroup(c, group, '2021-01-01')).toEqual([ids.delisted, ids.renamed].sort());
    expect(await resolveGroup(c, group, '2024-01-01')).toEqual([]);
    expect(await resolveGroup(c, group, '2024-01-01', { includeDelisted: true })).toEqual([ids.delisted]);
  });
});
