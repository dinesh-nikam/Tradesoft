import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import { migrate } from '../src/index.ts';

// E2.3: every CHECK, UNIQUE, primary-key and foreign-key constraint on md.market_bar, md.import_batch and
// ref.instrument has a negative test, and a constraint added later without one fails the coverage test.
const adminUrl = testDatabaseUrl();
const TABLES = ['md.market_bar', 'md.import_batch', 'ref.instrument'] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, string | number | null>;

interface Case {
  table: Table;
  constraint: string;
  /** Overrides applied to the table's valid base row; `id: null` lets the column default generate it. */
  row?: Row;
  /** When set, the row is inserted a second time with these overrides. */
  second?: Row;
  /** Matched against the message when a trigger, not a named constraint, raises the violation. */
  message?: RegExp;
  /** The name PostgreSQL reports, when it differs: a partition reports its own copy of the parent's index. */
  reported?: RegExp;
}

const missing = randomUUID();
const CASES: Case[] = [
  {
    table: 'md.market_bar',
    constraint: 'ck_market_bar_delivery',
    row: { delivery_volume: 2000, delivery_pct: '10' },
  },
  { table: 'md.market_bar', constraint: 'ck_market_bar_high', row: { high: '98' } },
  { table: 'md.market_bar', constraint: 'ck_market_bar_low', row: { low: '101' } },
  { table: 'md.market_bar', constraint: 'ck_market_bar_ohlc_positive', row: { open: '0', low: '0' } },
  { table: 'md.market_bar', constraint: 'ck_market_bar_oi', row: { open_interest: -1 } },
  { table: 'md.market_bar', constraint: 'ck_market_bar_quality', row: { quality_status: 'UNKNOWN' } },
  { table: 'md.market_bar', constraint: 'ck_market_bar_revision', row: { revision: 0 } },
  { table: 'md.market_bar', constraint: 'ck_market_bar_volume', row: { volume: -1 } },
  {
    table: 'md.market_bar',
    constraint: 'market_bar_import_batch_id_fkey',
    row: { import_batch_id: missing },
  },
  { table: 'md.market_bar', constraint: 'market_bar_instrument_id_fkey', row: { instrument_id: missing } },
  { table: 'md.market_bar', constraint: 'market_bar_timeframe_fkey', row: { timeframe: '7m' } },
  {
    table: 'md.market_bar',
    constraint: 'market_bar_pkey',
    second: {},
    reported: /^market_bar_y\d{4}m\d{2}_pkey$/,
  },
  {
    table: 'md.market_bar',
    constraint: 'trg_market_bar_session',
    row: { session_date: '2026-03-14' },
    message: /not a trading day/,
  },
  { table: 'md.import_batch', constraint: 'ck_import_batch_counts', row: { total_rows: 1 } },
  { table: 'md.import_batch', constraint: 'ck_import_batch_status', row: { status: 'UNKNOWN' } },
  { table: 'md.import_batch', constraint: 'ck_import_batch_terminal', row: { status: 'COMPLETED' } },
  { table: 'md.import_batch', constraint: 'ck_import_batch_type', row: { batch_type: 'UNKNOWN' } },
  { table: 'md.import_batch', constraint: 'ck_import_batch_timeframe', row: { batch_type: 'INTRADAY_CSV' } },
  {
    table: 'md.import_batch',
    constraint: 'import_batch_timeframe_fkey',
    row: { batch_type: 'INTRADAY_CSV', timeframe: '7m' },
  },
  { table: 'md.import_batch', constraint: 'import_batch_exchange_id_fkey', row: { exchange_id: missing } },
  { table: 'md.import_batch', constraint: 'import_batch_file_id_fkey', row: { file_id: missing } },
  { table: 'md.import_batch', constraint: 'import_batch_requested_by_fkey', row: { requested_by: missing } },
  { table: 'md.import_batch', constraint: 'import_batch_source_id_fkey', row: { source_id: missing } },
  {
    table: 'md.import_batch',
    constraint: 'import_batch_supersedes_batch_id_fkey',
    row: { supersedes_batch_id: missing },
  },
  { table: 'md.import_batch', constraint: 'import_batch_pkey', second: {} },
  {
    table: 'md.import_batch',
    constraint: 'uq_import_batch_idem',
    row: { id: null, idempotency_key: 'k1' },
    second: {},
  },
  { table: 'ref.instrument', constraint: 'ck_instrument_asset_class', row: { asset_class: 'UNKNOWN' } },
  { table: 'ref.instrument', constraint: 'ck_instrument_delisted', row: { status: 'DELISTED' } },
  { table: 'ref.instrument', constraint: 'ck_instrument_lot', row: { lot_size: 0 } },
  { table: 'ref.instrument', constraint: 'ck_instrument_option', row: { strike_price: '100' } },
  {
    table: 'ref.instrument',
    constraint: 'ck_instrument_option_type',
    row: { instrument_type: 'OPTION', option_type: 'X' },
  },
  { table: 'ref.instrument', constraint: 'ck_instrument_precision', row: { price_precision: 7 } },
  { table: 'ref.instrument', constraint: 'ck_instrument_status', row: { status: 'UNKNOWN' } },
  { table: 'ref.instrument', constraint: 'ck_instrument_tick', row: { tick_size: '0' } },
  { table: 'ref.instrument', constraint: 'ck_instrument_type', row: { instrument_type: 'UNKNOWN' } },
  { table: 'ref.instrument', constraint: 'instrument_exchange_id_fkey', row: { exchange_id: missing } },
  { table: 'ref.instrument', constraint: 'instrument_underlying_id_fkey', row: { underlying_id: missing } },
  { table: 'ref.instrument', constraint: 'instrument_pkey', second: { symbol: 'OTHER' } },
  { table: 'ref.instrument', constraint: 'uq_instrument_symbol', row: { id: null }, second: {} },
];

describe.skipIf(!adminUrl)('E2.3 constraint negative tests', () => {
  let db: ScratchDatabase;
  let client: pg.Client;
  const base = {} as Record<Table, () => Row>;

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    client = await db.connect();
    await migrate(client);
    const one = async (sql: string, params: unknown[] = []) =>
      (await client.query<{ id: string }>(sql, params)).rows[0]!.id;
    const exchange = await one(
      "insert into ref.exchange (code, name, default_open_time, default_close_time) values ('TST', 'Test', '09:15', '15:30') returning id",
    );
    await client.query(
      `insert into ref.trading_calendar (exchange_id, calendar_date, is_trading_day, session_open_at, session_close_at)
       values ($1, '2026-03-13', true, '2026-03-13T03:45:00Z', '2026-03-13T10:00:00Z')`,
      [exchange],
    );
    const instrument = await one(
      "insert into ref.instrument (exchange_id, symbol, name, instrument_type, asset_class) values ($1, 'BASE', 'Base', 'EQUITY', 'EQUITY') returning id",
      [exchange],
    );
    const source = await one(
      "insert into md.data_source (code, name, kind) values ('T', 'T', 'CSV') returning id",
    );
    const batch = await one(
      "insert into md.import_batch (source_id, exchange_id, batch_type, correlation_id) values ($1, $2, 'EOD_CSV', gen_random_uuid()) returning id",
      [source, exchange],
    );
    let symbol = 0;
    base['ref.instrument'] = () => ({
      id: randomUUID(),
      exchange_id: exchange,
      symbol: `S${symbol++}`,
      name: 'Case',
      instrument_type: 'EQUITY',
      asset_class: 'EQUITY',
    });
    base['md.import_batch'] = () => ({
      id: randomUUID(),
      source_id: source,
      exchange_id: exchange,
      batch_type: 'EOD_CSV',
      correlation_id: randomUUID(),
    });
    base['md.market_bar'] = () => ({
      instrument_id: instrument,
      timeframe: '1D',
      bucket_start: '2026-03-13T03:45:00Z',
      session_date: '2026-03-13',
      open: '100',
      high: '105',
      low: '99',
      close: '104',
      volume: 1000,
      import_batch_id: batch,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  }, 60_000);

  it('covers every constraint and unique index on the three tables', async () => {
    const { rows } = await client.query<{ name: string }>(
      `select conname as name from pg_constraint where conrelid = any($1::regclass[]) and contype <> 'n'
       union
       select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = any($1::regclass[]) and i.indisunique`,
      [TABLES],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...new Set(CASES.map((c) => c.constraint))].sort());
  });

  const insert = (table: Table, row: Row) => {
    const columns = Object.keys(row).filter((k) => !(k === 'id' && row[k] === null));
    return client.query(
      `insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((k) => row[k]),
    );
  };

  it.each(CASES.map((c) => [c.constraint, c] as const))('rejects a row that violates %s', async (_, c) => {
    const row = { ...base[c.table](), ...c.row };
    await client.query('begin');
    try {
      const error = await (async () => {
        await insert(c.table, row);
        if (c.second) await insert(c.table, { ...row, ...c.second });
        await client.query('commit');
      })().then(
        () => null,
        (e: Error & { constraint?: string }) => e,
      );
      expect(error, `${c.constraint} was not enforced`).not.toBeNull();
      if (c.message) expect(error!.message).toMatch(c.message);
      else if (c.reported) expect(error!.constraint).toMatch(c.reported);
      else expect(error!.constraint).toBe(c.constraint);
    } finally {
      await client.query('rollback');
    }
  });
});
