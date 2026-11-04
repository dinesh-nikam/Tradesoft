import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  createImportBatch,
  dispatchOutbox,
  ImportFileError,
  ingestionJobs,
  jobRegistry,
  mapBars,
  migrate,
  openImportFile,
  persistBatch,
  readImportFile,
  reconcileBatch,
  runWorker,
  validateBatch,
  type StepOutcome,
} from '../src/index.ts';

const adminUrl = testDatabaseUrl();

const HEADER =
  'symbol,series,date,open,high,low,close,volume,turnover,delivery_qty,delivery_pct,open_interest';

describe.skipIf(!adminUrl)('CSV/EOD ingestion pipeline (08 Phase 5)', { timeout: 120_000 }, () => {
  let db: ScratchDatabase;
  let c: pg.Client;
  let root: string;
  let sourceId: string;
  const exchanges: Record<string, string> = {};

  const count = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;
  const tx = async <T>(fn: () => Promise<T>): Promise<T> => {
    await c.query('begin');
    try {
      const out = await fn();
      await c.query('commit');
      return out;
    } catch (error) {
      await c.query('rollback');
      throw error;
    }
  };
  const store = async (csv: string) => {
    const w = await openImportFile(root);
    await w.write(Buffer.from(csv));
    return w.close({ filename: 'eod.csv', mimeType: 'text/csv' });
  };
  const submit = async (
    csv: string,
    o: { batchType?: 'EOD_CSV' | 'INTRADAY_CSV' | 'CORRECTION'; timeframe?: string; exchange?: string } = {},
  ) => {
    const file = await store(csv);
    return (
      await tx(() =>
        createImportBatch(c, {
          file: { originalFilename: 'eod.csv', mimeType: 'text/csv', ...file },
          sourceId,
          exchangeId: exchanges[o.exchange ?? 'NSE']!,
          batchType: o.batchType ?? 'EOD_CSV',
          timeframe: o.timeframe ?? null,
          idempotencyKey: null,
          supersedesBatchId: null,
          correlationId: randomUUID(),
          requestedBy: null,
        }),
      )
    ).batchId;
  };
  const steps = [validateBatch, persistBatch, reconcileBatch];
  /** Runs every step, each in its own transaction, as the three jobs would. */
  const run = async (batchId: string) => {
    const outcomes: StepOutcome[] = [];
    for (const step of steps) outcomes.push(await tx(() => step(c, root, batchId)));
    const row = (
      await c.query<{
        status: string;
        total: number;
        accepted: number;
        rejected: number;
        inserted: number;
        updated: number;
        summary: { primaryCode?: string; checks?: { code: string; passed: boolean }[] } | null;
      }>(
        `select status, total_rows as total, accepted_rows as accepted, rejected_rows as rejected,
                inserted_bars as inserted, updated_bars as updated, error_summary as summary
           from md.import_batch where id = $1`,
        [batchId],
      )
    ).rows[0]!;
    return { outcomes, ...row };
  };
  const rejects = async (batchId: string) =>
    Object.fromEntries(
      (
        await c.query<{ n: number; code: string }>(
          'select row_number as n, error_code as code from md.ingestion_reject where import_batch_id = $1',
          [batchId],
        )
      ).rows.map((r) => [r.n, r.code]),
    );
  const bar = async (symbol: string, date: string) =>
    (
      await c.query<{ close: string; revision: number; quality: string }>(
        `select b.close::text as close, b.revision, b.quality_status as quality
           from md.market_bar b join ref.instrument i on i.id = b.instrument_id
          where i.symbol = $1 and b.timeframe = '1D' and b.session_date = $2`,
        [symbol, date],
      )
    ).rows[0];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tradesoft-imports-'));
    db = await createScratchDatabase(adminUrl!);
    c = await db.connect();
    await migrate(c);
    for (const code of ['NSE', 'BSE']) {
      exchanges[code] = (
        await c.query<{ id: string }>(
          `insert into ref.exchange (code, name, default_open_time, default_close_time)
           values ($1, $1, '09:15', '15:30') returning id::text as id`,
          [code],
        )
      ).rows[0]!.id;
      await c.query(
        `insert into ref.trading_calendar (exchange_id, calendar_date, is_trading_day, session_open_at, session_close_at)
         select $1, d::date, true, (d::date + time '09:15') at time zone 'Asia/Kolkata',
                (d::date + time '15:30') at time zone 'Asia/Kolkata'
           from generate_series(date '2026-11-02', date '2026-11-04', interval '1 day') d`,
        [exchanges[code]],
      );
      await c.query(
        `insert into ref.trading_calendar (exchange_id, calendar_date, is_trading_day)
         values ($1, '2026-11-01', false)`,
        [exchanges[code]],
      );
    }
    await c.query(
      `insert into ref.instrument (exchange_id, symbol, series, name, instrument_type, asset_class, listing_date,
                                   delisting_date, status)
       select $1::uuid, s, 'EQ', s, 'EQUITY', 'EQUITY', l::date, d::date, st
         from (values ('INFY', null, null, 'ACTIVE'), ('TCS', null, null, 'ACTIVE'),
                      ('DUAL', null, null, 'ACTIVE'), ('OTHER', null, null, 'ACTIVE'),
                      ('OLDCO', '2000-01-01', '2026-10-01', 'DELISTED')) v(s, l, d, st)
       union all
       select $1::uuid, 'A0' || g, 'EQ', 'A0' || g, 'EQUITY', 'EQUITY', null::date, null::date, 'ACTIVE'
         from generate_series(1, 8) g`,
      [exchanges['NSE']],
    );
    // SYMBOL_AMBIGUOUS: DUAL is one instrument's symbol and, in the same window, another's alias.
    await c.query(
      `insert into ref.symbol_alias (instrument_id, exchange_id, alias_symbol, valid_from)
       select id, exchange_id, 'DUAL', '2026-01-01' from ref.instrument where symbol = 'OTHER'`,
    );
    sourceId = (
      await c.query<{ id: string }>(
        `insert into md.data_source (code, name, kind, config)
         values ('EOD', 'EOD files', 'CSV', '{"adapter": "csv.generic.eod"}') returning id::text as id`,
      )
    ).rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await db?.drop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('E5.1: rejects every L2 and L3 rule with its code, and persists the rows that pass', async () => {
    const rows = [
      'INFY,EQ,2026-11-03,100,110,95,105,1000,105000,600,60,', // 1 ok
      'TCS,EQ,2026-11-03,"3,000.50",3100,2990,3050,500,,,,', // 2 ok, with a thousands separator
      'NOPE,EQ,2026-11-03,1,1,1,1,1,,,,', // 3
      'DUAL,EQ,2026-11-03,1,1,1,1,1,,,,', // 4
      'A01,EQ,2026-02-30,1,1,1,1,1,,,,', // 5
      'A01,EQ,2026-11-01,1,1,1,1,1,,,,', // 6
      'A02,EQ,2026-11-03,0,1,1,1,1,,,,', // 7
      'A03,EQ,2026-11-03,10,9,11,10,1,,,,', // 8
      'A04,EQ,2026-11-03,1,1,1,1,-5,,,,', // 9
      'A05,EQ,2026-11-03,1,1,1,1,1000,,2000,50,', // 10
      'A06,EQ,2026-11-03,1,1,1,1,1,,,,-1', // 11
      'A07,EQ,2026-11-03,1x,1,1,1,1,,,,', // 12
      `${'X'.repeat(33)},EQ,2026-11-03,1,1,1,1,1,,,,`, // 13
      'A08,EQ,2026-11-03,1,1', // 14
      'OLDCO,EQ,2026-11-03,1,1,1,1,1,,,,', // 15
      'INFY,EQ,2026-11-03,100,110,95,105,1000,,,,', // 16
      'INFY,BE,2026-11-03,100,110,95,105,1000,,,,', // 17
      'A08,EQ,2026-11-03,1,1,1,1,NA,,,,', // 18: absent is never zero
      'A07,EQ,2026-11-02,1.00001,1,1,1,1,,,,', // 19: more places than the column holds
    ];
    const id = await submit([HEADER, ...rows].join('\r\n'));
    const r = await run(id);
    expect(r.outcomes).toEqual(['VALIDATED', 'PERSISTED', 'COMPLETED']);
    expect(await rejects(id)).toEqual({
      3: 'SYMBOL_UNKNOWN',
      4: 'SYMBOL_AMBIGUOUS',
      5: 'DATE_INVALID',
      6: 'NOT_A_TRADING_DAY',
      7: 'OHLC_NON_POSITIVE',
      8: 'OHLC_INCONSISTENT',
      9: 'VOLUME_NEGATIVE',
      10: 'DELIVERY_INVALID',
      11: 'OPEN_INTEREST_INVALID',
      12: 'DECIMAL_INVALID',
      13: 'FIELD_TOO_LONG',
      14: 'ROW_MALFORMED',
      15: 'INSTRUMENT_NOT_TRADABLE_ON_DATE',
      16: 'DUPLICATE_IN_FILE',
      17: 'SERIES_CONFLICT',
      18: 'DECIMAL_INVALID',
      19: 'DECIMAL_INVALID',
    });
    expect(r).toMatchObject({ status: 'COMPLETED', total: 19, accepted: 2, rejected: 17, inserted: 2 });
    expect(r.summary?.checks?.every((x) => x.passed)).toBe(true);
    expect(await bar('TCS', '2026-11-03')).toEqual({ close: '3050.0000', revision: 1, quality: 'VALIDATED' });
    const infy = await c.query(
      `select delivery_volume::text as dv, delivery_pct::text as dp,
              bucket_start = '2026-11-03T09:15:00+05:30'::timestamptz as at_open
         from md.market_bar where import_batch_id = $1 and volume = 1000`,
      [id],
    );
    expect(infy.rows[0]).toEqual({ dv: '600', dp: '60.0000', at_open: true });
  });

  it('E5.1, E5.4: file-level rules fail the batch before any row is read, and nothing is persisted', async () => {
    const cases: [string, string][] = [
      ['symbol,series,date,open,high,low,volume\nINFY,EQ,2026-11-02,1,1,1,1', 'HEADER_MISSING_REQUIRED'],
      [`${HEADER},ClsPric\nINFY,EQ,2026-11-02,1,1,1,1,1,,,,,1`, 'HEADER_AMBIGUOUS'],
      [HEADER, 'FILE_EMPTY'],
    ];
    for (const [csv, code] of cases) {
      const id = await submit(csv);
      const r = await run(id);
      expect(r.outcomes, code).toEqual(['VALIDATION_FAILED', 'SKIPPED', 'SKIPPED']);
      expect(r.summary?.primaryCode).toBe(code);
      expect(await count('md.market_bar where import_batch_id = $1', [id])).toBe(0);
    }
    const ctx = {
      batchId: '',
      exchangeId: exchanges['NSE']!,
      exchangeCode: 'NSE',
      timezone: 'Asia/Kolkata',
      batchType: 'EOD_CSV',
      timeframe: null,
      adapter: 'csv.generic.eod' as const,
      fieldMap: {},
    };
    // ROW_COUNT_EXCEEDED, with the limit lowered so the fixture stays small.
    const two = [HEADER, 'INFY,EQ,2026-11-02,1,1,1,1,1,,,,', 'TCS,EQ,2026-11-02,1,1,1,1,1,,,,'].join('\n');
    expect(await mapBars(c, ctx, two, 1)).toMatchObject({
      kind: 'FILE_FAILED',
      primaryCode: 'ROW_COUNT_EXCEEDED',
    });
    // An adapter maps its layout: the legacy bhavcopy names and the DD-MMM-YYYY date.
    const bhavcopy = await mapBars(
      c,
      { ...ctx, adapter: 'csv.nse.bhavcopy' },
      'SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP\nINFY,EQ,1,2,1,2,10,20,02-NOV-2026',
    );
    expect(bhavcopy).toMatchObject({ kind: 'MAPPED', rejects: [] });
    expect(bhavcopy.kind === 'MAPPED' && bhavcopy.bars[0]).toMatchObject({
      sessionDate: '2026-11-02',
      volume: '10',
    });
    // A vendor field map from the source config names its own columns.
    const vendor = await mapBars(
      c,
      { ...ctx, fieldMap: { Ticker: 'symbol', Day: 'date', Px: 'close' } },
      'Ticker,series,Day,open,high,low,Px,volume\nINFY,EQ,2026-11-02,1,2,1,2,10',
    );
    expect(vendor).toMatchObject({ kind: 'MAPPED', rejects: [] });
  });

  it('E5.1: L1 file checks refuse binary, oversized, empty and wrongly typed files while they stream in', async () => {
    const refuse = async (bytes: Buffer, meta: { filename: string; mimeType: string }, max?: number) => {
      const w = await openImportFile(root, max);
      try {
        await w.write(bytes);
        await w.close(meta);
        await w.discard();
        return null;
      } catch (error) {
        await w.discard();
        return error instanceof ImportFileError ? error.code : String(error);
      }
    };
    const csv = { filename: 'a.csv', mimeType: 'text/csv' };
    expect(await refuse(Buffer.from('a,b\n1,2'), csv, 4)).toBe('FILE_TOO_LARGE');
    expect(await refuse(Buffer.from([0x61, 0x00, 0x62]), csv)).toBe('FILE_TYPE_REJECTED');
    expect(await refuse(Buffer.from([0x61, 0xff, 0xfe]), csv)).toBe('FILE_TYPE_REJECTED');
    expect(await refuse(Buffer.from('a,b'), { filename: 'a.xlsx', mimeType: 'text/csv' })).toBe(
      'FILE_TYPE_REJECTED',
    );
    expect(await refuse(Buffer.from('a,b'), { filename: 'a.csv', mimeType: 'application/pdf' })).toBe(
      'FILE_TYPE_REJECTED',
    );
    expect(await refuse(Buffer.alloc(0), csv)).toBe('FILE_EMPTY');
    expect(await refuse(Buffer.from('a,b\n1,2'), csv)).toBeNull();
  });

  it('E5.1: an intraday batch checks timeframes and session bounds', async () => {
    const id = await submit(
      [
        'symbol,series,date,timeframe,timestamp,open,high,low,close,volume',
        'INFY,EQ,2026-11-03,15m,2026-11-03T09:15:00+05:30,1,2,1,2,10',
        'INFY,EQ,2026-11-03,15m,2026-11-03T16:00:00+05:30,1,2,1,2,10',
        'INFY,EQ,2026-11-03,7m,2026-11-03T09:30:00+05:30,1,2,1,2,10',
        'INFY,EQ,2026-11-03,15m,2026-11-03 09:30,1,2,1,2,10',
      ].join('\n'),
      { batchType: 'INTRADAY_CSV', timeframe: '15m' },
    );
    const r = await run(id);
    expect(await rejects(id)).toEqual({
      2: 'TIMESTAMP_OUT_OF_SESSION',
      3: 'TIMEFRAME_UNKNOWN',
      4: 'DATE_INVALID',
    });
    expect(r).toMatchObject({ status: 'COMPLETED', inserted: 1 });
  });

  it('E5.3: an identical re-import changes nothing; different values conflict and never overwrite', async () => {
    const same = await submit(`${HEADER}\nINFY,EQ,2026-11-03,100,110,95,105,1000,105000,600,60,\n`);
    expect(await run(same)).toMatchObject({ status: 'COMPLETED', accepted: 1, inserted: 0, updated: 0 });

    const conflicts = await count("md.bar_quality_issue where issue_code = 'SOURCE_CONFLICT'");
    const conflict = await submit(
      `${HEADER}\nINFY,EQ,2026-11-03,100,110,95,104,1000,,,,\nTCS,EQ,2026-11-03,3000.5,3100,2990,3050,500,,,,`,
    );
    const r = await run(conflict);
    expect(await rejects(conflict)).toEqual({ 1: 'CONFLICTING_VALUES' });
    expect(r).toMatchObject({ status: 'COMPLETED', accepted: 1, rejected: 1, inserted: 0, updated: 0 });
    expect(await bar('INFY', '2026-11-03')).toMatchObject({ close: '105.0000', revision: 1 });
    expect(
      await count("md.bar_quality_issue where issue_code = 'SOURCE_CONFLICT' and severity = 'ERROR'"),
    ).toBe(conflicts + 1);
  });

  it('03 §4: a correction raises the revision and keeps the superseded row; a lower revision is refused', async () => {
    const fix = await submit(`${HEADER}\nINFY,EQ,2026-11-03,100,110,95,106,1000,106000,600,60,`, {
      batchType: 'CORRECTION',
    });
    expect(await run(fix)).toMatchObject({ status: 'COMPLETED', updated: 1 });
    expect(await bar('INFY', '2026-11-03')).toEqual({ close: '106.0000', revision: 2, quality: 'CORRECTED' });
    const history = await c.query(
      'select close::text as close, revision, superseded_by::text as by from md.market_bar_history',
    );
    expect(history.rows).toEqual([{ close: '105.0000', revision: 1, by: fix }]);

    const stale = await submit(`${HEADER}\nINFY,EQ,2026-11-03,100,110,95,105,1000,,,,`);
    await run(stale);
    expect(await rejects(stale)).toEqual({ 1: 'STALE_REVISION' });
    expect(await bar('INFY', '2026-11-03')).toMatchObject({ close: '106.0000', revision: 2 });
  });

  it('L5: turnover drift and an incomplete universe fail reconciliation without rolling bars back', async () => {
    // Same prices with a turnover far from the stored one: not material, so unchanged, but L5 catches it.
    const drift = await submit(`${HEADER}\nINFY,EQ,2026-11-03,100,110,95,106,1000,999999,600,60,`);
    expect(await run(drift)).toMatchObject({
      status: 'RECONCILIATION_FAILED',
      summary: { primaryCode: 'RECON_TURNOVER_DRIFT' },
    });

    // A01 traded on 2 Nov and not on 3 Nov: a gap warning. INFY and TCS traded on 3 Nov and miss 4 Nov.
    await run(await submit(`${HEADER}\nA01,EQ,2026-11-02,1,1,1,1,1,,,,`));
    const gap = await submit(`${HEADER}\nA01,EQ,2026-11-04,1,1,1,1,1,,,,`);
    expect(await run(gap)).toMatchObject({
      status: 'RECONCILIATION_FAILED',
      inserted: 1,
      summary: { primaryCode: 'RECON_INCOMPLETE_UNIVERSE' },
    });
    expect(await count('md.market_bar where import_batch_id = $1', [gap])).toBe(1);
    expect(
      await count(
        "md.bar_quality_issue where import_batch_id = $1 and issue_code = 'GAP_DETECTED' and severity = 'WARN'",
        [gap],
      ),
    ).toBe(1);
  });

  it('E5.6: a persist killed mid-way leaves no bar, and the retried step completes the batch', async () => {
    const id = await submit(`${HEADER}\nA02,EQ,2026-11-02,1,1,1,1,1,,,,\nA03,EQ,2026-11-02,1,1,1,1,1,,,,`);
    await tx(() => validateBatch(c, root, id));
    expect(await tx(() => validateBatch(c, root, id))).toBe('SKIPPED');
    // The worker dies after the bars are written and before the commit.
    await c.query('begin');
    expect(await persistBatch(c, root, id)).toBe('PERSISTED');
    expect(await count('md.market_bar where import_batch_id = $1', [id])).toBe(2);
    await c.query('rollback');
    expect(await count('md.market_bar where import_batch_id = $1', [id])).toBe(0);
    expect((await c.query('select status from md.import_batch where id = $1', [id])).rows[0]).toEqual({
      status: 'VALIDATED',
    });
    expect(await tx(() => persistBatch(c, root, id))).toBe('PERSISTED');
    expect(await tx(() => persistBatch(c, root, id))).toBe('SKIPPED');
    expect(await tx(() => reconcileBatch(c, root, id))).toBe('COMPLETED');
    expect(await count('md.market_bar where import_batch_id = $1', [id])).toBe(2);
  });

  it('runs end to end through the outbox and the worker', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 4 });
    const ingestion = ingestionJobs({ importRoot: root });
    const id = await submit(`${HEADER}\nA04,EQ,2026-11-02,1,1,1,1,1,,,,`);
    const stop = new AbortController();
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const worker = runWorker({
      pool,
      registry: jobRegistry(...ingestion.jobs),
      queues: ['ingestion'],
      workerId: 'test',
      concurrency: 2,
      log,
      signal: stop.signal,
      pollMs: 50,
    });
    let status = '';
    for (let i = 0; i < 200 && status !== 'COMPLETED'; i++) {
      const client = await pool.connect();
      try {
        await dispatchOutbox(client, ingestion.routes);
      } finally {
        client.release();
      }
      status = (await c.query<{ status: string }>('select status from md.import_batch where id = $1', [id]))
        .rows[0]!.status;
      await new Promise((r) => setTimeout(r, 50));
    }
    stop.abort();
    await worker;
    await pool.end();
    expect(status).toBe('COMPLETED');
    const jobs = await c.query<{ type: string; status: string }>(
      `select job_type as type, status from ops.job
        where idempotency_key = any(array['parse:' || $1, 'persist:' || $1, 'reconcile:' || $1])
        order by created_at`,
      [id],
    );
    expect(jobs.rows.map((j) => [j.type, j.status])).toEqual([
      ['ingestion.parse_validate', 'COMPLETED'],
      ['ingestion.persist_bars', 'COMPLETED'],
      ['ingestion.reconcile', 'COMPLETED'],
    ]);
  });

  it('E5.5: a 10,000-row full-market file is validated, persisted and reconciled in under 60 seconds', async () => {
    await c.query(
      `insert into ref.instrument (exchange_id, symbol, series, name, instrument_type, asset_class)
       select $1, 'S' || lpad(g::text, 5, '0'), 'EQ', 'Stock ' || g, 'EQUITY', 'EQUITY'
         from generate_series(1, 10000) g`,
      [exchanges['BSE']],
    );
    const lines = [HEADER];
    for (let g = 1; g <= 10_000; g++)
      lines.push(
        `S${String(g).padStart(5, '0')},EQ,2026-11-03,100,105,99,${100 + (g % 5)},${g * 10},${g * 1000},,,`,
      );
    const id = await submit(lines.join('\n'), { exchange: 'BSE' });
    const started = Date.now();
    const r = await run(id);
    const seconds = (Date.now() - started) / 1000;
    expect(r).toMatchObject({ status: 'COMPLETED', accepted: 10_000, inserted: 10_000 });
    expect(seconds).toBeLessThan(60);
    // The file on the import volume is the provenance of every bar.
    const file = await c.query<{ path: string }>(
      'select f.stored_path as path from md.import_batch b join md.import_file f on f.id = b.file_id where b.id = $1',
      [id],
    );
    expect((await readImportFile(root, file.rows[0]!.path)).split('\n')).toHaveLength(10_001);
  });
});
