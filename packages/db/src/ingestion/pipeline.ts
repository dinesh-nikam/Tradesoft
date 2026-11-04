import type pg from 'pg';
import { emitEvent } from '../jobs.ts';
import {
  BAR_ADAPTERS,
  mapBars,
  type BarAdapter,
  type BarReject,
  type BatchContext,
  type CanonicalBar,
} from './bars.ts';
import { readImportFile } from './storage.ts';

/**
 * The import-batch lifecycle of 01 §3.1, one step per job (03 §5.3). Each step runs inside its job's
 * transaction, starts by locking the batch row, and does nothing when the batch has already moved past it,
 * so a re-run job is a no-op (03 §5.1).
 */

export type StepOutcome =
  | 'SKIPPED'
  | 'VALIDATED'
  | 'VALIDATION_FAILED'
  | 'PERSISTED'
  | 'PROCESSING_FAILED'
  | 'COMPLETED'
  | 'RECONCILIATION_FAILED';

interface BatchRow {
  status: string;
  batchType: string;
  exchangeId: string;
  exchangeCode: string;
  timezone: string;
  timeframe: string | null;
  storedPath: string | null;
  config: { adapter?: string; fieldMap?: Record<string, string> };
  acceptedRows: number;
  insertedBars: number;
  updatedBars: number;
  correlationId: string;
}

async function lockBatch(c: pg.ClientBase, batchId: string): Promise<BatchRow> {
  const { rows } = await c.query<BatchRow>(
    `select b.status, b.batch_type as "batchType", b.exchange_id::text as "exchangeId", e.code as "exchangeCode",
            e.timezone, b.timeframe, f.stored_path as "storedPath", s.config, b.accepted_rows as "acceptedRows",
            b.inserted_bars as "insertedBars", b.updated_bars as "updatedBars", b.correlation_id::text as "correlationId"
       from md.import_batch b
       join ref.exchange e on e.id = b.exchange_id
       join md.data_source s on s.id = b.source_id
       left join md.import_file f on f.id = b.file_id
      where b.id = $1
        for update of b`,
    [batchId],
  );
  if (!rows[0]) throw new Error(`import batch ${batchId} does not exist`);
  return rows[0];
}

function contextOf(batchId: string, b: BatchRow): BatchContext {
  const adapter = (BAR_ADAPTERS as readonly string[]).includes(b.config.adapter ?? '')
    ? (b.config.adapter as BarAdapter)
    : 'csv.generic.eod';
  return {
    batchId,
    exchangeId: b.exchangeId,
    exchangeCode: b.exchangeCode,
    timezone: b.timezone,
    batchType: b.batchType,
    timeframe: b.timeframe,
    adapter,
    fieldMap: b.config.fieldMap ?? {},
  };
}

const setStatus = (c: pg.ClientBase, batchId: string, status: string) =>
  c.query('update md.import_batch set status = $2, updated_at = now() where id = $1', [batchId, status]);

async function terminate(
  c: pg.ClientBase,
  batchId: string,
  status: 'VALIDATION_FAILED' | 'PROCESSING_FAILED' | 'RECONCILIATION_FAILED' | 'COMPLETED',
  summary: object | null,
) {
  await c.query(
    `update md.import_batch set status = $2, error_summary = $3::jsonb, completed_at = now(), updated_at = now()
      where id = $1`,
    [batchId, status, summary ? JSON.stringify(summary) : null],
  );
}

const CHUNK = 5_000;
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

async function storeRejects(c: pg.ClientBase, batchId: string, rejects: BarReject[]) {
  for (const part of chunks(rejects))
    await c.query(
      `insert into md.ingestion_reject (import_batch_id, row_number, raw_row, error_code, error_message, field_name)
       select $1, * from unnest($2::int[], $3::jsonb[], $4::text[], $5::text[], $6::text[])`,
      [
        batchId,
        part.map((r) => r.rowNumber),
        part.map((r) => JSON.stringify(r.raw)),
        part.map((r) => r.code),
        part.map((r) => r.message),
        part.map((r) => r.field),
      ],
    );
}

const mostFrequent = (rejects: { code: string }[]) => {
  const tally = new Map<string, number>();
  for (const r of rejects) tally.set(r.code, (tally.get(r.code) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1])[0]![0];
};

/** Re-reads the batch's file and returns the rows that survived L1–L4. */
async function acceptedBars(c: pg.ClientBase, root: string, batchId: string, b: BatchRow) {
  const mapped = await mapBars(c, contextOf(batchId, b), await readImportFile(root, b.storedPath!));
  if (mapped.kind === 'FILE_FAILED')
    throw new Error(`batch ${batchId} no longer passes L1: ${mapped.primaryCode}`);
  const rejected = new Set(
    (
      await c.query<{ n: number }>(
        'select row_number as n from md.ingestion_reject where import_batch_id = $1',
        [batchId],
      )
    ).rows.map((r) => r.n),
  );
  return {
    bars: mapped.bars.filter((bar) => !rejected.has(bar.rowNumber)),
    rejects: mapped.rejects,
    rejected,
  };
}

// -------------------------------------------------------------------------- ingestion.parse_validate

/** L1–L3 (03 §3.1–§3.3): RECEIVED → VALIDATING → VALIDATED or VALIDATION_FAILED. */
export async function validateBatch(c: pg.ClientBase, root: string, batchId: string): Promise<StepOutcome> {
  const b = await lockBatch(c, batchId);
  if (b.status !== 'RECEIVED') return 'SKIPPED';
  await c.query(
    `update md.import_batch set status = 'VALIDATING', started_at = now(), header_line = 1, updated_at = now()
      where id = $1`,
    [batchId],
  );
  const mapped = await mapBars(c, contextOf(batchId, b), await readImportFile(root, b.storedPath!));
  if (mapped.kind === 'FILE_FAILED') {
    await c.query('update md.import_batch set total_rows = $2, rejected_rows = $2 where id = $1', [
      batchId,
      mapped.totalRows,
    ]);
    await terminate(c, batchId, 'VALIDATION_FAILED', {
      primaryCode: mapped.primaryCode,
      message: mapped.message,
    });
    return 'VALIDATION_FAILED';
  }
  await storeRejects(c, batchId, mapped.rejects);
  await c.query(
    'update md.import_batch set total_rows = $2, accepted_rows = $3, rejected_rows = $4 where id = $1',
    [batchId, mapped.totalRows, mapped.bars.length, mapped.rejects.length],
  );
  if (mapped.bars.length === 0) {
    await terminate(c, batchId, 'VALIDATION_FAILED', {
      primaryCode: b.batchType === 'CORRECTION' ? 'CORRECTION_NO_ROWS' : mostFrequent(mapped.rejects),
      message: `Every one of the ${mapped.totalRows} rows was rejected`,
    });
    return 'VALIDATION_FAILED';
  }
  await setStatus(c, batchId, 'VALIDATED');
  await emitEvent(c, {
    type: 'batch.validated',
    aggregateType: 'import_batch',
    aggregateId: batchId,
    payload: { batchId },
    correlationId: b.correlationId,
  });
  return 'VALIDATED';
}

// --------------------------------------------------------------------------- MarketDataPort.ingestBars

export interface IngestOutcome {
  inserted: number;
  updated: number;
  unchanged: number;
  /** L4 rejects (03 §3.4), already stored in md.ingestion_reject. */
  rejected: number;
}

/**
 * The only writer of md.market_bar (03 §9). Bars go through a per-transaction staging table into one
 * insert and one update. The L4 checks of 03 §3.4 are decided against the stored rows under a per-exchange
 * lock, so two batches cannot classify the same bar at once. A correction raises the revision and the
 * history trigger keeps the superseded row; any other batch never changes a stored price.
 *
 * shortcut: rows reach the staging table through `unnest` in chunks of 5,000 rather than `COPY` (03 §7.4),
 * because no COPY client is installed; switch when batches above ~100,000 rows become routine.
 */
export async function ingestBars(
  c: pg.ClientBase,
  batch: { batchId: string; exchangeId: string; correction: boolean },
  bars: CanonicalBar[],
): Promise<IngestOutcome> {
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`tradesoft:persist:${batch.exchangeId}`]);
  await c.query('drop table if exists bar_stage');
  await c.query(
    `create temp table bar_stage (
       row_number int primary key, instrument_id uuid not null, timeframe text not null,
       bucket_start timestamptz not null, session_date date not null, open numeric(18,4) not null,
       high numeric(18,4) not null, low numeric(18,4) not null, close numeric(18,4) not null,
       volume bigint not null, delivery_volume bigint, delivery_pct numeric(9,4), open_interest bigint,
       turnover numeric(24,4), raw jsonb not null, action text, stored jsonb
     ) on commit drop`,
  );
  for (const part of chunks(bars))
    await c.query(
      `insert into bar_stage (row_number, instrument_id, timeframe, bucket_start, session_date, open, high, low,
                              close, volume, delivery_volume, delivery_pct, open_interest, turnover, raw)
       select * from unnest($1::int[], $2::uuid[], $3::text[], $4::timestamptz[], $5::date[], $6::numeric[],
                            $7::numeric[], $8::numeric[], $9::numeric[], $10::bigint[], $11::bigint[],
                            $12::numeric[], $13::bigint[], $14::numeric[], $15::jsonb[])`,
      [
        part.map((b) => b.rowNumber),
        part.map((b) => b.instrumentId),
        part.map((b) => b.timeframe),
        part.map((b) => b.bucketStart),
        part.map((b) => b.sessionDate),
        part.map((b) => b.open),
        part.map((b) => b.high),
        part.map((b) => b.low),
        part.map((b) => b.close),
        part.map((b) => b.volume),
        part.map((b) => b.deliveryVolume),
        part.map((b) => b.deliveryPct),
        part.map((b) => b.openInterest),
        part.map((b) => b.turnover),
        part.map((b) => JSON.stringify(b.raw)),
      ],
    );
  await c.query('analyze bar_stage');

  // 03 §3.4. "Materially different" is any OHLC or volume difference. Turnover, delivery and open interest
  // are not material: a non-correction leaves the stored row alone, and L5 reports any turnover drift.
  await c.query(
    `update bar_stage s set action = x.action, stored = x.stored
       from (select s.row_number,
                    case when b.instrument_id is null then 'INSERT'
                         when (s.open, s.high, s.low, s.close, s.volume) = (b.open, b.high, b.low, b.close, b.volume)
                              and (not $1 or (s.delivery_volume, s.delivery_pct, s.open_interest, s.turnover)
                                   is not distinct from (b.delivery_volume, b.delivery_pct, b.open_interest, b.turnover))
                           then 'UNCHANGED'
                         when $1 then 'UPDATE'
                         when b.revision > 1 then 'STALE_REVISION'
                         else 'CONFLICTING_VALUES' end as action,
                    case when b.instrument_id is not null then
                      jsonb_build_object('open', b.open, 'high', b.high, 'low', b.low, 'close', b.close,
                                         'volume', b.volume, 'revision', b.revision,
                                         'importBatchId', b.import_batch_id)
                    end as stored
               from bar_stage s
               left join md.market_bar b on b.instrument_id = s.instrument_id and b.timeframe = s.timeframe
                                         and b.bucket_start = s.bucket_start) x
      where x.row_number = s.row_number`,
    [batch.correction],
  );

  const inserted = await c.query(
    `insert into md.market_bar (instrument_id, timeframe, bucket_start, session_date, open, high, low, close,
                                volume, delivery_volume, delivery_pct, open_interest, turnover, quality_status,
                                revision, import_batch_id, validated_at)
     select instrument_id, timeframe, bucket_start, session_date, open, high, low, close, volume, delivery_volume,
            delivery_pct, open_interest, turnover, 'VALIDATED', 1, $1, now()
       from bar_stage where action = 'INSERT'`,
    [batch.batchId],
  );
  const updated = await c.query(
    `update md.market_bar b
        set open = s.open, high = s.high, low = s.low, close = s.close, volume = s.volume,
            delivery_volume = s.delivery_volume, delivery_pct = s.delivery_pct, open_interest = s.open_interest,
            turnover = s.turnover, revision = b.revision + 1, quality_status = 'CORRECTED',
            import_batch_id = $1, validated_at = now(), updated_at = now()
       from bar_stage s
      where s.action = 'UPDATE' and b.instrument_id = s.instrument_id and b.timeframe = s.timeframe
        and b.bucket_start = s.bucket_start`,
    [batch.batchId],
  );
  const rejected = await c.query(
    `insert into md.ingestion_reject (import_batch_id, row_number, raw_row, error_code, error_message, field_name)
     select $1, row_number, raw, action,
            case action
              when 'CONFLICTING_VALUES'
                then format('The stored bar (revision %s) has different prices or volume; submit a correction to change it',
                            stored->>'revision')
              else format('The stored bar is at revision %s, above this batch''s revision', stored->>'revision')
            end,
            null
       from bar_stage where action in ('CONFLICTING_VALUES', 'STALE_REVISION')`,
    [batch.batchId],
  );
  // CONFLICTING_VALUES is an operator decision, not a log line (03 §3.4).
  await c.query(
    `insert into md.bar_quality_issue (instrument_id, timeframe, bucket_start, session_date, issue_code, severity,
                                       details, import_batch_id)
     select instrument_id, timeframe, bucket_start, session_date, 'SOURCE_CONFLICT', 'ERROR',
            jsonb_build_object('rowNumber', row_number, 'stored', stored,
              'incoming', jsonb_build_object('open', open, 'high', high, 'low', low, 'close', close,
                                             'volume', volume)),
            $1
       from bar_stage where action = 'CONFLICTING_VALUES'`,
    [batch.batchId],
  );
  // MISSING_PREVIOUS_SESSION: a new daily bar of an instrument that has history but no bar for the previous
  // trading session, and is not suspended, is accepted with a warning. A first-ever bar is not a gap.
  await c.query(
    `insert into md.bar_quality_issue (instrument_id, timeframe, bucket_start, session_date, issue_code, severity,
                                       details, import_batch_id)
     select s.instrument_id, s.timeframe, s.bucket_start, s.session_date, 'GAP_DETECTED', 'WARN',
            jsonb_build_object('missingSession', p.prev, 'code', 'MISSING_PREVIOUS_SESSION'), $1
       from bar_stage s
       join ref.instrument i on i.id = s.instrument_id
       cross join lateral (select max(calendar_date) as prev from ref.trading_calendar
                            where exchange_id = $2 and is_trading_day and calendar_date < s.session_date) p
      where s.action = 'INSERT' and s.timeframe = '1D' and p.prev is not null and i.status <> 'SUSPENDED'
        and exists (select 1 from md.market_bar b where b.instrument_id = s.instrument_id and b.timeframe = '1D'
                       and b.session_date < p.prev)
        and not exists (select 1 from md.market_bar b where b.instrument_id = s.instrument_id
                           and b.timeframe = '1D' and b.session_date = p.prev)`,
    [batch.batchId, batch.exchangeId],
  );
  // The session trigger is deferred to commit; checking now lets a violation fail this step, not the commit.
  await c.query('set constraints all immediate');
  const n = (r: pg.QueryResult) => r.rowCount ?? 0;
  return {
    inserted: n(inserted),
    updated: n(updated),
    rejected: n(rejected),
    unchanged: bars.length - n(inserted) - n(updated) - n(rejected),
  };
}

// --------------------------------------------------------------------------- ingestion.persist_bars

/** A database refusal of the data itself is deterministic; anything else may pass on a retry. */
export function isDeterministicDbError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  if (typeof e.code !== 'string' || !/^2[23]/.test(e.code)) return false;
  // A missing partition is fixed by the rollover job, so it is worth retrying (03 §7.1 scenario 14).
  return !String(e.message).includes('no partition');
}

class RevalidationMismatch extends Error {
  readonly code = '22000';
}

/** VALIDATED → PROCESSING, then every bar of the batch in this one transaction (03 §7.3). */
export async function persistBatch(c: pg.ClientBase, root: string, batchId: string): Promise<StepOutcome> {
  const b = await lockBatch(c, batchId);
  if (b.status !== 'VALIDATED') return 'SKIPPED';
  await setStatus(c, batchId, 'PROCESSING');
  const { bars, rejects, rejected } = await acceptedBars(c, root, batchId, b);
  await c.query('savepoint persist');
  try {
    // Validation and persistence read the same file. If reference data changed in between, the two
    // disagree, and the batch stops rather than store a different set of rows from the one it validated.
    if (rejects.some((r) => !rejected.has(r.rowNumber)) || bars.length !== b.acceptedRows)
      throw new RevalidationMismatch('The rows validate differently now; reprocess the batch');
    const out = await ingestBars(
      c,
      { batchId, exchangeId: b.exchangeId, correction: b.batchType === 'CORRECTION' },
      bars,
    );
    await c.query(
      `update md.import_batch
          set accepted_rows = accepted_rows - $2, rejected_rows = rejected_rows + $2, inserted_bars = $3,
              updated_bars = $4, updated_at = now()
        where id = $1`,
      [batchId, out.rejected, out.inserted, out.updated],
    );
    await c.query('release savepoint persist');
    await emitEvent(c, {
      type: 'batch.persisted',
      aggregateType: 'import_batch',
      aggregateId: batchId,
      payload: { batchId, ...out },
      correlationId: b.correlationId,
    });
    if (out.inserted + out.updated > 0)
      await emitEvent(c, {
        type: 'bars.changed',
        aggregateType: 'import_batch',
        aggregateId: batchId,
        payload: { batchId },
        correlationId: b.correlationId,
      });
    return 'PERSISTED';
  } catch (error) {
    if (!isDeterministicDbError(error)) throw error;
    await c.query('rollback to savepoint persist');
    await terminate(c, batchId, 'PROCESSING_FAILED', {
      primaryCode: error instanceof RevalidationMismatch ? 'REVALIDATION_MISMATCH' : 'PERSIST_REFUSED',
      message: error instanceof Error ? error.message : String(error),
    });
    return 'PROCESSING_FAILED';
  }
}

// ------------------------------------------------------------------------------ ingestion.reconcile

export interface ReconCheck {
  code: string;
  passed: boolean;
  detail?: string;
}

/** L5 (03 §3.5): compares what the batch claimed with what the database now holds. */
export async function reconcileBatch(c: pg.ClientBase, root: string, batchId: string): Promise<StepOutcome> {
  const b = await lockBatch(c, batchId);
  if (b.status !== 'PROCESSING') return 'SKIPPED';
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`tradesoft:persist:${b.exchangeId}`]);
  const { bars } = await acceptedBars(c, root, batchId, b);
  await c.query('drop table if exists recon_key');
  await c.query(
    `create temp table recon_key (instrument_id uuid, timeframe text, bucket_start timestamptz,
                                  session_date date, turnover numeric(24,4)) on commit drop`,
  );
  for (const part of chunks(bars))
    await c.query(
      `insert into recon_key
       select * from unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::date[], $5::numeric[])`,
      [
        part.map((x) => x.instrumentId),
        part.map((x) => x.timeframe),
        part.map((x) => x.bucketStart),
        part.map((x) => x.sessionDate),
        part.map((x) => x.turnover),
      ],
    );
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await c.query<T>(sql, params)).rows[0]!;

  const checks: ReconCheck[] = [];
  const stored = await one<{ n: number }>(
    'select count(*)::int as n from md.market_bar where import_batch_id = $1',
    [batchId],
  );
  const unchanged = b.acceptedRows - b.insertedBars - b.updatedBars;
  checks.push({
    code: 'RECON_ROW_COUNT',
    passed: bars.length === b.acceptedRows && stored.n === b.insertedBars + b.updatedBars && unchanged >= 0,
    detail: `accepted ${b.acceptedRows}, in file ${bars.length}, inserted ${b.insertedBars}, updated ${b.updatedBars}, unchanged ${unchanged}, stored under this batch ${stored.n}`,
  });
  const missing = await one<{ n: number }>(
    `select count(*)::int as n from recon_key k
      where not exists (select 1 from md.market_bar m where m.instrument_id = k.instrument_id
                           and m.timeframe = k.timeframe and m.bucket_start = k.bucket_start)`,
  );
  checks.push({
    code: 'RECON_MISSING_BAR',
    passed: missing.n === 0,
    detail: `${missing.n} accepted rows have no bar`,
  });
  const quarantined = await one<{ n: number }>(
    `select count(*)::int as n from md.market_bar
      where import_batch_id = $1 and quality_status = 'QUARANTINED'`,
    [batchId],
  );
  checks.push({
    code: 'RECON_QUARANTINED',
    passed: quarantined.n === 0,
    detail: `${quarantined.n} bars quarantined`,
  });
  if (b.batchType === 'EOD_CSV' || b.batchType === 'EOD_API') {
    // An active instrument that traded the session before and has no bar now is a hole in a full-day file.
    const absent = await one<{ n: number; sample: string | null }>(
      `with days as (select distinct session_date from recon_key where timeframe = '1D'),
            prev as (select d.session_date,
                            (select max(calendar_date) from ref.trading_calendar
                              where exchange_id = $1 and is_trading_day and calendar_date < d.session_date) as prev
                       from days d)
       select count(*)::int as n, min(i.symbol) as sample
         from prev p
         join md.market_bar y on y.timeframe = '1D' and y.session_date = p.prev
         join ref.instrument i on i.id = y.instrument_id and i.exchange_id = $1
        where i.status = 'ACTIVE' and not i.is_synthetic
          and not exists (select 1 from md.market_bar t where t.instrument_id = i.id and t.timeframe = '1D'
                             and t.session_date = p.session_date)`,
      [b.exchangeId],
    );
    checks.push({
      code: 'RECON_INCOMPLETE_UNIVERSE',
      passed: absent.n === 0,
      detail: absent.n
        ? `${absent.n} instruments that traded the previous session have no bar, for example ${absent.sample}`
        : 'every instrument that traded the previous session has a bar',
    });
  }
  const turnover = await one<{ source: string | null; stored: string | null; drift: string | null }>(
    `select sum(k.turnover)::text as source, sum(m.turnover)::text as stored,
            (case when sum(k.turnover) > 0
                  then abs(coalesce(sum(m.turnover), 0) - sum(k.turnover)) / sum(k.turnover) * 100 end)::text as drift
       from recon_key k
       join md.market_bar m on m.instrument_id = k.instrument_id and m.timeframe = k.timeframe
                           and m.bucket_start = k.bucket_start
      where k.turnover is not null`,
  );
  const drift = turnover.drift === null ? 0 : Number(turnover.drift);
  checks.push({
    code: 'RECON_TURNOVER_DRIFT',
    passed: drift <= 0.01,
    detail:
      turnover.source === null
        ? 'the file has no turnover'
        : `source ${turnover.source}, stored ${turnover.stored ?? '0'} (${drift.toFixed(4)} %, limit 0.01 %)`,
  });
  const offCalendar = await one<{ n: number }>(
    `select count(*)::int as n from md.market_bar m
       left join ref.trading_calendar c on c.exchange_id = $2 and c.calendar_date = m.session_date
      where m.import_batch_id = $1 and c.is_trading_day is not true`,
    [batchId, b.exchangeId],
  );
  checks.push({
    code: 'RECON_CALENDAR_VIOLATION',
    passed: offCalendar.n === 0,
    detail: `${offCalendar.n} bars on non-trading days`,
  });

  const failed = checks.find((x) => !x.passed);
  if (failed) {
    await terminate(c, batchId, 'RECONCILIATION_FAILED', {
      primaryCode: failed.code,
      message: failed.detail ?? failed.code,
      checks,
    });
    return 'RECONCILIATION_FAILED';
  }
  await terminate(c, batchId, 'COMPLETED', { checks });
  await emitEvent(c, {
    type: 'batch.completed',
    aggregateType: 'import_batch',
    aggregateId: batchId,
    payload: { batchId },
    correlationId: b.correlationId,
  });
  return 'COMPLETED';
}
