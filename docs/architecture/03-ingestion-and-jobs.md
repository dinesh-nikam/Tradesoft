# 03 — Ingestion, Jobs, Concurrency and Idempotency

Status: **APPROVED BASELINE (Phase 0)**.

Market-data correctness outranks every other property of this system. The rules here are therefore
written as rejections, not as best-effort repairs: **nothing is silently fixed.** A row that cannot be
proven correct is quarantined with a code, and a human decides.

---

## 1. Ingestion architecture

```
            ┌─────────────────────────────────────────────────────────────┐
            │                    Ingestion module                         │
            │                                                             │
  CSV  ────►│ CsvFileSourceAdapter ─┐                                     │
            │                       ├─► RowMapper ─► Validator ─► Reconciler│
  API  ────►│ RestApiSourceAdapter ─┘        │            │           │    │
            │                               │            │           │    │
            │                        canonical rows   rejections  differences
            └───────────────────────────────┼────────────┼───────────┼────┘
                                            ▼            ▼           ▼
                                    MarketDataPort  ingestion_   bar_quality
                                      .ingestBars    reject       _issue
```

Three ports, all declared in `packages/domain`:

```ts
export interface MarketDataSourceAdapter {
  readonly sourceCode: string;
  readonly kind: 'CSV' | 'API';
  fetch(request: SourceFetchRequest): Promise<SourcePayload>;   // API only; CSV adapter throws
  parse(payload: SourcePayload): AsyncIterable<RawRow>;
  map(raw: RawRow, ctx: MappingContext): MappedRow | RejectedRow;
}

export interface MarketDataPort {
  ingestBars(batch: CanonicalBarBatch, tx?: Transaction): Promise<IngestOutcome>;
  getBars(query: BarQuery): Promise<BarSeries>;
  subscribeBars(sub: BarSubscription, sink: BarSink): Promise<Unsubscribe>;
}

export interface BarValidator {
  validate(row: CanonicalBar, ctx: ValidationContext): ValidationVerdict;
}
```

The adapter is responsible for *shape* (headers, delimiters, encodings, vendor quirks). The validator is
responsible for *truth* and is shared by every adapter. A vendor adapter therefore cannot weaken
validation; it can only fail to produce rows.

### 1.1 Registered adapters (v1)

| Code | Kind | Scope | Notes |
|---|---|---|---|
| `csv.generic.eod` | CSV | any exchange | Canonical header contract (§2). The default path. |
| `csv.nse.bhavcopy` | CSV | NSE | Maps NSE bhavcopy column names to canonical fields; ignores columns we do not use |
| `csv.bse.bhavcopy` | CSV | BSE | Same, BSE naming |
| `csv.mcx.eod` | CSV | MCX | Adds open interest; no delivery volume |
| `csv.ncdex.eod` | CSV | NCDEX | Adds open interest; no delivery volume |
| `api.vendor.rest` | API | configured | Generic authenticated JSON pull with a declarative field map in `md.data_source.config` |

Vendor-specific field maps live in `md.data_source.config`, **not** in code, with the exception of the
four bhavcopy adapters whose column names are structural. Credentials are never in `config`; the config
stores the *name* of an environment variable (`"authEnvVar": "VENDOR_X_API_KEY"`) and the worker resolves
it at call time. A `CHECK` constraint on `md.data_source` rejects configs containing `password`, `apiKey`
or `token` keys.

Adding a new exchange or vendor therefore requires a row, not a deployment. Adding a genuinely new file
*layout* requires an adapter.

---

## 2. CSV contract

### 2.1 Canonical headers

UTF-8, comma-delimited, one header row, CRLF or LF, optional UTF-8 BOM (stripped). Maximum 200 MB and
2,000,000 data rows per file. Header names are matched case-insensitively after trimming and collapsing
internal whitespace.

| Canonical field | Required | Type | Alias examples accepted |
|---|---|---|---|
| `symbol` | yes | string | `SYMBOL`, `TckrSymb`, `Scrip Code` |
| `series` | no | string | `SERIES`, `SctySrs` |
| `date` | yes | `YYYY-MM-DD` | `DATE`, `TradDt`, `Date1` |
| `open` | yes | decimal | `OPEN`, `OpnPric` |
| `high` | yes | decimal | `HIGH`, `HghPric` |
| `low` | yes | decimal | `LOW`, `LwPric` |
| `close` | yes | decimal | `CLOSE`, `ClsPric` |
| `prev_close` | no | decimal | `PREVCLOSE`, `PrvsClsgPric` |
| `volume` | yes | integer | `VOLUME`, `TtlTradgVol` |
| `turnover` | no | decimal | `TURNOVER`, `TtlTrfVal` |
| `delivery_qty` | no | integer | `DELIV_QTY`, `DelivQty` |
| `delivery_pct` | no | decimal | `DELIV_PER`, `DelivPct` |
| `open_interest` | no | integer | `OPEN_INT`, `OpnIntrst` |
| `timeframe` | no | enum | `TIMEFRAME` — absent means `1D` |
| `timestamp` | conditional | ISO 8601 with offset | `TIMESTAMP`, `bucket_start` — required when `timeframe` is intraday |

Two header modes are supported and must be declared per batch: **canonical** (above) and **vendor**
(declared `fieldMap` in `data_source.config`).

### 2.2 Parsing rules

- Numbers may contain thousands separators (`,` or ` `) and a currency prefix; these are stripped before
  `numeric` conversion and the original string is preserved in `ingestion_reject.raw_row`.
- `-`, empty, `NA`, `N/A`, `NULL` are treated as *absent*, never as zero.
- A quoted field may contain the delimiter. The parser is a real CSV parser (RFC 4180), not `split(',')`.
- A row with a different column count from the header is rejected, never padded.
- Row numbers in rejections are **1-based data row numbers**, not file line numbers, and the header line
  number is recorded separately on the batch, so an operator can locate the row.

### 2.3 Encoding and safety

- Reject files whose extension is not `.csv` or `.txt`, whose declared MIME is not in
  `{text/csv, text/plain, application/csv, application/vnd.ms-excel}`, or whose first 512 bytes contain a
  null byte.
- Filenames are never used as paths. Storage path is `data/imports/{yyyy}/{mm}/{uuid}.csv`; the original
  name is metadata only.
- Files are streamed to disk. They are never fully buffered in memory, and never written inside the web
  root.

---

## 3. Validation

Five layers, each with its own failure semantics.

### 3.1 L1 — file level (fails the batch before any parse)

| Code | Condition |
|---|---|
| `FILE_TOO_LARGE` | > 200 MB |
| `FILE_EMPTY` | 0 bytes or header only |
| `FILE_TYPE_REJECTED` | extension, MIME or magic-byte check failed |
| `IMPORT_DUPLICATE_FILE` | `sha256` already present in `md.import_file` |
| `HEADER_MISSING_REQUIRED` | a required canonical field is absent after mapping |
| `HEADER_AMBIGUOUS` | two source columns map to the same canonical field |
| `ROW_COUNT_EXCEEDED` | > 2,000,000 rows |
| `EXCHANGE_UNRESOLVED` | batch declares an exchange code that does not exist |

### 3.2 L2 — row level (rejects the row)

| Code | Condition |
|---|---|
| `SYMBOL_UNKNOWN` | no instrument and no alias match for the batch's exchange and date |
| `SYMBOL_AMBIGUOUS` | alias resolves to more than one instrument in the effective window |
| `DATE_INVALID` | unparseable, or not a valid calendar date |
| `NOT_A_TRADING_DAY` | no `trading_calendar` row, or `is_trading_day = false` |
| `TIMESTAMP_OUT_OF_SESSION` | `bucket_start` outside `[session_open, session_close]` for that date |
| `TIMEFRAME_UNKNOWN` | not in `ref.timeframe` |
| `OHLC_NON_POSITIVE` | any of open/high/low/close ≤ 0 |
| `OHLC_INCONSISTENT` | `high < low`, `high < max(open,close)`, or `low > min(open,close)` |
| `VOLUME_NEGATIVE` | volume < 0 |
| `DELIVERY_INVALID` | `delivery_qty < 0` or `delivery_qty > volume` or `delivery_pct` outside [0,100] |
| `OPEN_INTEREST_INVALID` | open interest < 0 |
| `DECIMAL_INVALID` | numeric field not parseable after separator stripping |
| `FIELD_TOO_LONG` | any string field exceeds its column's documented maximum |
| `ROW_MALFORMED` | wrong column count, or unparseable quoting |
| `INSTRUMENT_NOT_TRADABLE_ON_DATE` | listing date after, or delisting date before, `session_date` |

### 3.3 L3 — cross-row within the batch (rejects the later row)

| Code | Condition |
|---|---|
| `DUPLICATE_IN_FILE` | same (`symbol`,`series`,`timeframe`,`bucket_start`) appears twice; the first occurrence wins and the second is rejected |
| `SERIES_CONFLICT` | two rows for the same symbol and date with different `series` where the instrument is unambiguous |

### 3.4 L4 — cross-batch against stored data

| Code | Condition | Effect |
|---|---|---|
| `CONFLICTING_VALUES` | same key, **same revision basis**, materially different OHLCV | Row rejected, `bar_quality_issue SOURCE_CONFLICT` raised at `ERROR` severity, operator resolves |
| `STALE_REVISION` | incoming `revision` lower than stored | Row rejected as a no-op, counted, logged at `INFO` |
| `IDENTICAL_ROW` | same key and identical payload | Counted as `unchanged`, not an error |
| `MISSING_PREVIOUS_SESSION` | the instrument has no bar for the previous trading session and no suspension record | `bar_quality_issue GAP_DETECTED` at `WARN`; row is accepted |

`CONFLICTING_VALUES` is the rule that prevents the most dangerous failure mode: two sources disagreeing
about a price and the system silently picking whichever arrived second. "Materially different" means any
OHLC difference greater than `0` at `numeric(18,4)` precision, or a volume difference greater than 0.

### 3.5 L5 — reconciliation (fails the batch)

Runs after persist, comparing what the batch *claimed* against what the database *now holds*.

| Check | Failure code |
|---|---|
| `accepted_rows` equals inserted + updated + unchanged | `RECON_ROW_COUNT` |
| Every accepted row's key is present in `md.market_bar` | `RECON_MISSING_BAR` |
| No bar in the batch's date range has `quality_status='QUARANTINED'` as a result of this batch | `RECON_QUARANTINED` |
| For a full-day batch, every active instrument that traded has a bar | `RECON_INCOMPLETE_UNIVERSE` |
| Aggregate turnover differs from source total by ≤ 0.01 % | `RECON_TURNOVER_DRIFT` |
| No bar exists on a non-trading day | `RECON_CALENDAR_VIOLATION` |

Reconciliation failure moves the batch to `RECONCILIATION_FAILED` **without rolling back the bars** — the
bars are already committed and may be correct. The batch is marked failed so that downstream analytics do
not treat its output as trustworthy until a human inspects the differences. The operator either accepts
(via a new `CORRECTION` batch that re-validates the flagged rows) or fixes the source and re-uploads.

---

## 4. Corrections, re-imports and symbol changes

| Situation | Handling |
|---|---|
| Operator re-uploads yesterday's file | `FILE_DUPLICATE` → 409 returning the original batch. Nothing is reprocessed. |
| Operator uploads a corrected version of the same day | New batch, `batch_type = 'CORRECTION'`, `revision = previous + 1`. Higher revision wins. `md.market_bar_history` preserves the superseded row. |
| Exchange re-issues a file with different content but the same name | Different `sha256`, therefore a new batch. If the batch is not declared `CORRECTION`, rows hit `CONFLICTING_VALUES` and are rejected — the operator must explicitly declare intent. |
| A corporate action is applied retroactively | `ref.corporate_action` insert → `marketdata.rebuild_adjustments` → all affected read paths change without touching `md.market_bar` |
| An instrument is renamed | `ref.symbol_alias` row with `valid_from`; future imports resolve the new symbol, historical bars keep the old identity |
| An instrument is delisted | `status='DELISTED'`, `delisting_date` set; history retained; excluded from default universes |
| A bad bar was already used in analytics | Correction batch raises revision → `bars.changed` event → indicator and Renko rebuild from the earliest affected bucket → breadth and RS recomputed for affected dates |

Corrections require `marketdata:correct` and a `justification` string, and produce an `audit_event` with
the before/after price objects.

---

## 5. Job architecture

### 5.1 Common contract

```ts
export interface JobDefinition<P> {
  type: string;
  payloadVersion: number;
  payloadSchema: ZodType<P>;
  queue: 'default' | 'ingestion' | 'analytics' | 'maintenance';
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Stable key; a second enqueue with the same key is a no-op. */
  idempotencyKey(payload: P): string;
  /** Advisory lock scope, when the job mutates a shared aggregate. */
  lockScope?(payload: P): string | null;
  handle(payload: P, ctx: JobContext): Promise<void>;
}
```

Every handler is **idempotent by construction**: re-running it with the same payload produces the same
database state. This is verified by a test that runs each handler twice against a fixture and asserts an
unchanged snapshot.

### 5.2 Retry and backoff

```
delay(attempt) = min(maxDelayMs, baseDelayMs × 2^(attempt − 1)) × (0.5 + random() × 0.5)
run_after      = now() + delay(attempt)
```

Jitter is applied to the upper half of the computed delay (the delay is uniformly random between 50 % and
100 % of the capped exponential value), deliberately: a batch of 3,000 indicator jobs failing on a database restart must not
retry in lockstep and re-create the overload that caused the failure.

`RetryableError` → requeue while `attempts < maxAttempts`. `PermanentError` → dead-letter immediately.
Any unclassified exception is treated as permanent, so a poison payload cannot consume the retry budget.

### 5.3 Job catalogue

| Job type | Queue | Producer | Consumer | Payload | Max attempts / base / cap | Idempotency key | Ordering | Failure state | Monitoring | Recovery |
|---|---|---|---|---|---|---|---|---|---|---|
| `ingestion.pull_source` | ingestion | `job_schedule`, admin | worker | `{sourceId, asOfDate, windowStart?}` | 5 / 60 s / 30 min | `pull:{sourceId}:{asOfDate}` | none | `DEAD_LETTER` + alert | `job_failures_total{type}`, source latency | `POST /admin/jobs/{id}/retry`; or upload manually as CSV |
| `ingestion.parse_validate` | ingestion | outbox `import.received` | worker | `{batchId}` | 3 / 30 s / 10 min | `parse:{batchId}` | after batch row commit | batch → `VALIDATION_FAILED` if deterministic | rows/s, reject ratio | Fix source file, new batch |
| `ingestion.persist_bars` | ingestion | outbox `batch.validated` | worker | `{batchId}` | 5 / 30 s / 15 min | `persist:{batchId}` | after validate | batch → `PROCESSING_FAILED` | bars/s, upsert conflicts | Re-run job; transaction is atomic so no partial state |
| `ingestion.reconcile` | ingestion | outbox `batch.persisted` | worker | `{batchId}` | 3 / 60 s / 20 min | `reconcile:{batchId}` | after persist | batch → `RECONCILIATION_FAILED` | recon failures by code | Operator review; correction batch |
| `marketdata.derive_timeframes` | ingestion | outbox `batch.completed` | worker | `{batchId, instrumentIds[], timeframes[]}` | 5 / 30 s / 15 min | `derive:{batchId}:{hash(timeframes)}` | after persist; per-instrument advisory lock | job dead-letters; derived bars stale and visible via watermark | derived bars/s | Re-run; derivation is a full recompute over the affected range |
| `marketdata.rebuild_adjustments` | analytics | outbox `corporate_action.applied` | worker | `{instrumentId, fromDate}` | 5 / 30 s / 15 min | `adjust:{instrumentId}:{fromDate}` | none | stale factors | factor rebuild duration | Re-run; idempotent full rebuild from `fromDate` |
| `marketdata.refresh_daily_snapshot` | analytics | outbox `batch.completed` | worker | `{sessionDate}` | 5 / 30 s / 10 min | `snapshot:{sessionDate}` | after persist | dashboard stale | snapshot rows vs expected | Re-run; upsert by key |
| `marketdata.compute_52w_stats` | analytics | outbox `batch.completed` | worker | `{sessionDate}` | 5 / 30 s / 10 min | `stats52w:{sessionDate}` | after snapshot | 52-week scanners stale | instruments computed / expected | Re-run; upsert by key |
| `analytics.compute_indicators` | analytics | outbox `bars.changed` | worker | `{instrumentId, timeframe, fromBucket, paramsHash}` | 3 / 60 s / 20 min | `ind:{instrumentId}:{timeframe}:{paramsHash}:{fromBucket}` | one job per (instrument, timeframe); advisory lock serialises | watermark stops advancing; `/readyz` reports staleness | series/s, watermark lag | Re-run from `fromBucket`; overwrite by key |
| `analytics.compute_indicator_snapshot` | analytics | outbox `indicators.computed`, `stats52w.computed` | worker | `{instrumentId, timeframe, asOfBucket, paramsHash}` | 3 / 60 s / 20 min | `snap:{instrumentId}:{timeframe}:{paramsHash}:{asOfBucket}` | after indicators and 52-week stats; advisory lock per (instrument, timeframe) | snapshot `as_of_bucket` stale; scanners report `SCANNER_SNAPSHOT_STALE` | snapshots/s, `as_of_bucket` lag | Re-run; upsert by `(instrument_id, timeframe)` |
| `analytics.compute_renko` | analytics | outbox `bars.changed`, `corporate_action.applied` | worker | `{brickSetId, fromBucket}` | 3 / 60 s / 20 min | `renko:{brickSetId}:{fromBucket}` | advisory lock per brick set | set revision unchanged; `computed_at` stale | bricks/s | Full rebuild of the set in one transaction |
| `analytics.compute_breadth` | analytics | outbox `renko.rebuilt` | worker | `{groupId, timeframe, brickPct, fromDate}` | 3 / 60 s / 20 min | `breadth:{groupId}:{timeframe}:{brickPct}:{fromDate}` | after Renko rebuild | breadth gap visible in API as `stale: true` | groups computed / expected | Re-run; upsert by key |
| `analytics.compute_rs` | analytics | `job_schedule` (post-EOD), manual | worker | `{groupId, baseInstrumentId, windowDays, asOfDate}` | 3 / 60 s / 20 min | `rs:{groupId}:{base}:{window}:{asOfDate}` | after snapshot | matrix absent for the date | snapshots/day | Re-run; unique constraint prevents duplicates |
| `scanner.execute` | default | API | worker | `{runId}` | 2 / 15 s / 2 min | `scan:{runId}` | none | run → `FAILED` with explain plan | run duration, match count | New run |
| `dataquality.scan` | maintenance | `job_schedule` (nightly) | worker | `{fromDate, toDate}` | 3 / 60 s / 20 min | `dq:{fromDate}:{toDate}` | after all derivation | findings only, never blocks | issues by code/severity | Re-run |
| `maintenance.partition_rollover` | maintenance | `job_schedule` (daily) | worker | `{monthsAhead}` | 3 / 60 s / 10 min | `rollover:{yyyy-mm}` | none | inserts fail loudly when runway exhausted; alert at 30 days | runway months | Re-run; `CREATE TABLE IF NOT EXISTS` semantics |
| `maintenance.retention_purge` | maintenance | `job_schedule` (weekly) | worker | `{dryRun}` | 2 / 300 s / 30 min | `purge:{isoWeek}` | none | disk growth | rows purged, partitions detached | Re-run with `dryRun=true` to inspect |
| `maintenance.dispatch_outbox` | maintenance | loop in `apps/worker` every 10 s, not an `ops.job` row (see below) | worker | `{limit}` | 5 / 5 s / 60 s | none (naturally idempotent) | none | downstream jobs delayed | outbox backlog age | Runs continuously; backlog alert at 5 min |
| `maintenance.reclaim_stale_jobs` | maintenance | loop in `apps/worker` every 60 s, not an `ops.job` row (see below) | worker | `{graceSeconds}` | 3 / 5 s / 60 s | none | none | stuck jobs | reclaimed count | Runs continuously |
| `ops.send_email` | default | API (password reset) | worker | `{template, to, variables}` | 5 / 30 s / 30 min | `mail:{template}:{sha256(to+variables)}` | none | dead-letter; user retries request | send failures | Retry; mail is best-effort by design |

Runtime rules fixed in Phase 3:

- A handler runs inside the job's own transaction, and the job's `COMPLETED` update commits in that same
  transaction. A handler that fails, or a worker that has lost its lock to the reaper, therefore leaves no
  partial effect (§7.1 scenario 10).
- The reaper dead-letters, rather than requeues, an expired job whose `attempts` already equals
  `max_attempts`, because claiming it again would violate `ck_job_attempts`.
- `ops.job_attempt.attempt_no` is numbered from the attempt history, not from `ops.job.attempts`, because an
  operator retry resets `attempts`.
- `ops.domain_event` has no correlation column; the correlation id travels in `payload.context.correlationId`
  and dispatched jobs inherit it (`07` §4.3).

Jobs that are **not** enqueued through `ops.job`: the scheduler tick, the outbox dispatcher and the reaper.
Those are loops inside `apps/scheduler` and `apps/worker` respectively, each guarded by an advisory lock,
because they must run even when the job table is the thing that is broken.

### 5.4 Dead-letter handling

A dead-lettered job is a **reviewable artefact**, not a log line:

- `status='DEAD_LETTER'`, `last_error` carries `{name, message, code, stack?, attempt, at}` with stack
  traces retained in the database but never returned by the API.
- `GET /api/v1/admin/jobs?status=DEAD_LETTER` lists them with type, attempts and first/last failure time.
- `POST /api/v1/admin/jobs/{id}/retry` requires `job:retry`, resets `attempts = 0`, clears
  `completed_at`, sets `run_after = now()`, and writes an audit event with the operator's identity.
- Nothing is auto-purged from `DEAD_LETTER`. Retention applies only to `COMPLETED` jobs (30 days).
- A metric `job_dead_letter_total{type}` with an alert threshold of `> 0` for ingestion job types.

---

## 6. Scheduler

`apps/scheduler` runs one loop:

1. `SELECT pg_try_advisory_lock(hashtext('tradesoft.scheduler'))`. If false, exit quietly; another
   instance owns the schedule.
2. Every 15 seconds: `SELECT * FROM ops.job_schedule WHERE is_enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED`.
3. For each due row, compute the next occurrence from the cron expression in the row's timezone, insert a
   `job` whose `idempotency_key` is the job type's catalogue key from §5.3 computed from the scheduled
   payload (for example `pull:{sourceId}:{asOfDate}`), and update `next_run_at`. A job type whose catalogue
   key is "none" is never scheduled through `ops.job_schedule`.
4. The unique index on `ops.job.idempotency_key` makes a double-fire (clock skew, duplicate scheduler
   start) a no-op rather than a duplicate import.

Cron expressions are evaluated with `croner` in the row's declared timezone. A schedule whose timezone is
not `Asia/Kolkata` is allowed but flagged in the admin UI, because market jobs must follow the exchange,
not the server.

---

## 7. Concurrency and idempotency

### 7.1 Scenario matrix

| # | Scenario | Mechanism | Result |
|---|---|---|---|
| 1 | Same CSV uploaded twice concurrently | `uq_import_file_sha` on `sha256` | One insert wins; the loser receives `409 IMPORT_DUPLICATE_FILE` with the existing `batchId` |
| 2 | Same file uploaded again later | Same unique constraint | Same 409; no reprocessing, no duplicate bars |
| 3 | Two different files contain overlapping bars | `INSERT … ON CONFLICT (instrument_id, timeframe, bucket_start) DO UPDATE … WHERE excluded.revision >= market_bar.revision` | Higher revision wins; equal revision with different values is rejected as `CONFLICTING_VALUES` (§3.4) |
| 4 | Retry of a partially applied batch | Whole persist runs in one transaction | Either all bars are written or none; retry starts from a clean state |
| 5 | Two workers compute indicators for the same instrument | `pg_advisory_xact_lock(hashtext('tradesoft:ind:{instrumentId}:{timeframe}'))` | Serialised; the second run recomputes identical values |
| 6 | Two workers rebuild the same Renko set | `pg_advisory_xact_lock(hashtext('tradesoft:renko:{brickSetId}'))` | Serialised; full rebuild is deterministic |
| 7 | Duplicate job enqueue from an outbox replay | Partial unique index on `ops.job.idempotency_key` | Second insert is a no-op |
| 8 | Two scheduler instances | `pg_try_advisory_lock` + unique idempotency key per window | Only one enqueues |
| 9 | Worker dies mid-job | `lock_expires_at` (default 5 min, extended by heartbeat every 60 s); reaper sets `status='QUEUED'` and records a `RECLAIMED` attempt | Job resumes; handler idempotency makes the partial attempt harmless |
| 10 | Reaper races a slow worker | Reclaim `UPDATE` carries `WHERE status='RUNNING' AND lock_expires_at < now()` | Worker's completion `UPDATE` also carries `WHERE locked_by = $self`; only one wins; the loser logs and discards |
| 11 | Client retries `POST /scanners/{id}/run` | `Idempotency-Key` header → `uq_scanner_run_idem` | Second request returns the original run with `200`, not a new run |
| 12 | Client retries an import upload | `sha256` + optional `Idempotency-Key` on the batch | Returns the original batch |
| 13 | Correction arrives while an analytics job is reading | Analytics reads in a `REPEATABLE READ` transaction; correction raises revision and enqueues a new job | Reader sees a consistent snapshot; the newer job supersedes it |
| 14 | Partition is missing at insert time | No default partition; insert fails | Batch fails loudly, alert fires, rollover runs |
| 15 | Two corrections for the same bar | Both compute `revision = current + 1` under row lock | Second sees the updated value and computes `current + 2`; last writer with the highest revision wins |
| 16 | Scanner run started while EOD is mid-persist | Scanner pins `as_of` and reads only committed data | No dirty reads; the run records the `as_of` it used |

### 7.2 Advisory lock namespace

| Lock key | Scope | Holder |
|---|---|---|
| `hashtext('tradesoft.migrate')` | cluster | migration runner |
| `hashtext('tradesoft.scheduler')` | cluster | scheduler instance |
| `hashtext('tradesoft:ind:{instrumentId}:{timeframe}')` | one indicator series | indicator job |
| `hashtext('tradesoft:renko:{brickSetId}')` | one brick set | Renko job |
| `hashtext('tradesoft:breadth:{groupId}:{timeframe}:{brickPct}')` | one breadth series | breadth job |
| `hashtext('tradesoft:derive:{instrumentId}:{timeframe}')` | one derived series | derivation job |
| `hashtext('tradesoft:persist:{exchangeId}')` | bar writes of one exchange | `persist_bars` and `reconcile` (Phase 5), so two batches never decide L4 for the same bar at once |
| `hashtext('audit.chain')` | audit chain | audit insert trigger |

All locks are **transaction-scoped** (`pg_advisory_xact_lock`) except the scheduler and migrator, which
use session-scoped locks held for the process lifetime. Transaction-scoped locks cannot leak: a crashed
connection releases them.

### 7.3 Transaction boundaries

| Operation | Boundary |
|---|---|
| File upload | `md.import_file` + `md.import_batch` + outbox `import.received` in one transaction |
| Bar persist | All bars for one batch, plus outbox `batch.persisted`, in one transaction. **One transaction per batch, not per instrument** — 2,000-row batches are small enough, and atomicity is worth more than concurrency here. Batches above 100,000 rows are split into chunks of 50,000, each chunk atomic, with the batch remaining in `PROCESSING` until the final chunk commits |
| Indicator compute | Per (instrument, timeframe, paramsHash): one transaction covering delete-and-replace of the affected range plus the watermark update |
| Renko rebuild | Per brick set: one transaction, `DELETE` then bulk `INSERT`, then `revision` increment |
| Scanner run | `INSERT` run, then one read transaction for evaluation, then `INSERT` results plus status update in a second transaction. A failed evaluation leaves the run in `FAILED` with no results |
| Audit write | Same transaction as the change; if the audit insert fails, the change fails |

### 7.4 Bulk write mechanics

Bars are written with `COPY` into a per-batch `TEMP` staging table, then a single
`INSERT … SELECT … ON CONFLICT DO UPDATE`. This avoids 100,000 round trips and keeps the conflict guard in
one statement. The staging table is `ON COMMIT DROP`.

---

## 8. Data-quality job

Nightly, over the last `N` sessions (default 5) plus a full sweep on the first run of each month:

| Check | Code | Severity |
|---|---|---|
| Missing bar on a trading day for an instrument that traded the day before and the day after | `GAP_DETECTED` | WARN |
| Zero volume on an equity for a session with a non-zero price change | `ZERO_VOLUME_MOVE` | ERROR |
| Close equal to high and low for 3 consecutive sessions | `FLAT_SERIES` | WARN |
| Daily `high` lower than any intraday `high` for the same session | `INTRADAY_EXCEEDS_DAILY` | ERROR |
| Bar exists on a non-trading day | `CALENDAR_VIOLATION` | ERROR |
| Adjusted price negative or zero after factor application | `ADJUSTMENT_BREAKS_PRICE` | ERROR |
| Turnover / (close × volume) outside [0.9, 1.1] | `TURNOVER_IMPLAUSIBLE` | WARN |
| Price change greater than 25 % without a corporate action | `UNEXPLAINED_JUMP` | WARN |
| Instrument has no bars for 5 consecutive sessions while `status='ACTIVE'` | `SILENT_INSTRUMENT` | WARN |

`ERROR` findings set `quality_status='QUARANTINED'` on the affected bar and enqueue a recompute of the
dependent analytics. `WARN` findings are recorded and surfaced, but do not block analytics.

---

## 9. What ingestion never does

- Never guesses a symbol. Unresolved means rejected.
- Never fills a missing trading day with the previous close.
- Never overwrites a higher revision with a lower one.
- Never mutates a completed batch.
- Never treats a missing value as zero.
- Never writes to `md.market_bar` from any code path other than `MarketDataPort.ingestBars`.
- Never logs a raw row containing credentials — vendor payloads with auth headers are redacted before the
  reject record is written.
