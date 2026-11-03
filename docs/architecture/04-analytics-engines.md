# 04 — Analytics Engines

Status: **APPROVED BASELINE (Phase 0)**.

This document defines every derived number the platform displays, scans, or ranks. It is normative:
an implementation that disagrees with this document is wrong, regardless of what it produces. Every
algorithm below is specified to the point where two independent engineers, given the same input bars,
must produce bit-identical output at the stored precision.

Scope: canonical bar aggregation, indicator computation, Fibonacci pivots, Renko bricks, breadth,
Relative Strength, and the scanner condition language. Out of scope: ingestion validation (document
`03`), storage layout (document `02`), transport (document `05`).

Diagrams referenced: **D-04 Data ingestion flow**, **D-08 Scanner execution flow**, **D-09 RS Matrix
flow**, **D-10 Renko generation flow**, **D-11 Failure and retry flow** — all in `DIAGRAMS.md`.

---

## 1. Engine architecture

### 1.1 The purity contract

Every engine lives in `packages/engines` and obeys five rules. These are enforced by ESLint
(`no-restricted-imports`) and by the package manifest — the package has **no runtime dependency other
than `decimal.js`**, and no access to `pg`, `fastify`, `node:fs`, `node:http`, `Date.now()`, or
`Math.random()`.

| Rule | Consequence |
|---|---|
| **P1 — Deterministic** | Same input array ⇒ same output array. No clocks, no RNG, no locale-dependent formatting. |
| **P2 — Pure** | No I/O, no mutation of inputs, no module-level mutable state. |
| **P3 — Total** | Never throws on valid domain input. Degenerate inputs (`n < warmup`, all-equal prices, zero volume, zero range) return explicit `null` or a documented sentinel, never `NaN` and never an exception. |
| **P4 — Decimal-native** | All price arithmetic uses `decimal.js` with `precision: 28`, `rounding: ROUND_HALF_UP`. `number` is permitted only for loop counters and array indices. |
| **P5 — Versioned** | Every engine exports a `VERSION` constant. Changing any formula, seed, or rounding rule changes that constant and triggers the recompute procedure in §12. |

Why `decimal.js` and not `big.js` or native `BigInt` scaled integers:

- Native `float64` is disqualified. `0.1 + 0.2 !== 0.3` is not a theoretical concern; a 200-period SMA
  over ₹ prices computed in `float64` drifts in the 12th significant digit, which is invisible until a
  scanner compares `rsi_14 > 70.000000` and gets a different answer than the chart shows. Two surfaces
  disagreeing about the same number is the single fastest way to lose operator trust in a trading
  platform.
- `BigInt` scaled integers require every call site to agree on scale. One forgotten rescale is a
  100× price error that no type system catches.
- `decimal.js` carries the scale with the value, has arbitrary precision, and produces the same result
  in Node and in tests. The cost is ~200 ns per operation; a 500-instrument × 250-bar indicator pass is
  ~2.5 M operations ≈ 0.5 s, which is far below the job budget (§10).

Precision is set to 28 significant digits, then rounded once at the persistence boundary. Intermediate
rounding is forbidden: an EMA chain that rounds to 6 dp at each step diverges from the unrounded chain
within 30 bars, and both are "correct" under a loose spec. One rounding, at the edge.

### 1.2 Rounding and persistence

| Quantity | Column type | Round to | Mode |
|---|---|---|---|
| OHLC prices, brick prices | `numeric(18,4)` | 4 dp | HALF_UP |
| Turnover | `numeric(24,4)` | 4 dp | HALF_UP |
| Percentage values (`pct_from_high`, `change_pct`, `positive_pct`, `delivery_pct`) | `numeric(9,4)` | 4 dp | HALF_UP |
| Indicator values (`sma_*`, `rsi_14`, `adx_14`, `atr_14`, `bb_*`, `extra`) | `numeric(18,6)` | 6 dp | HALF_UP |
| `rs_value.ratio`, `rs_line_slope` | `numeric(18,8)` | 8 dp | HALF_UP |
| `rs_value.score`, `percentile` | `numeric(18,6)` / `numeric(9,6)` | 6 dp | HALF_UP |
| Volume, open interest, delivery volume | `bigint` | integer | HALF_UP |
| Average volume (`avg_volume_20/50`) | `numeric(20,2)` | 2 dp | HALF_UP |

`params_hash` is `substr(sha256(canonical_json(params)), 1, 16)` — 16 lowercase hex characters,
matching `ck_indicator_value_hash` and `ck_indicator_snapshot_hash`. Canonical JSON means: keys sorted
ascending by UTF-16 code unit, no insignificant whitespace, all numbers serialised as strings in
non-exponential form with no trailing zeros (`"20"`, `"0.5"`), no `null` members. Example:
`{"period":"20","stdev":"2"}`.

### 1.3 Time contract

- Every instant is stored as `timestamptz` in UTC. No engine ever produces a local-time string.
- Every bar carries `session_date` (a `date` in the exchange's local calendar). Engines that group by
  day, week, month, quarter, or year group **by `session_date`**, never by truncating a UTC timestamp.
  Truncating UTC would put a 23:30 IST MCX bar into the previous IST day.
- Bucket arithmetic is performed on the exchange's wall clock, then converted to UTC once. IST has no
  DST, so the conversion is a fixed `+05:30`, but the engine reads the offset from
  `ref.exchange.timezone` rather than hard-coding it, because MCX/NCDEX and future venues are data.
- `bucket_start` is inclusive; the bucket ends at the next bucket's `bucket_start` (exclusive), or at
  `session_close_at` for the final bucket of a session.

### 1.4 Bar ownership — exactly one writer per timeframe

This is the most important structural rule in the analytics layer. If two components can write the
same `(instrument_id, timeframe, bucket_start)` row, they will eventually disagree, and the loser
overwrites the winner non-deterministically.

| Timeframe | Written by | Derived from | Authoritative? |
|---|---|---|---|
| `15m` | ingestion | intraday feed | yes |
| `60m` | aggregation engine | `15m` | derived |
| `75m` | aggregation engine | `15m` | derived |
| `120m` | aggregation engine | `15m` | derived |
| `240m` | aggregation engine | `15m` | derived |
| `1D` | ingestion | EOD bhavcopy | **yes — never derived** |
| `1W` | aggregation engine | `1D` | derived |
| `1M` | aggregation engine | `1D` | derived |
| `3M` | aggregation engine | `1D` | derived |
| `1Y` | aggregation engine | `1D` | derived |

The daily bar is never computed from intraday bars. It comes from the exchange's end-of-day file,
which carries the official close, official volume, delivery quantity, and open interest. A
minute-derived daily close is a *different number* from the official close — different rounding,
different trade inclusion window, occasionally different because of a closing-session auction. If both
wrote `1D`, the platform would flip between two closes on every recompute and every downstream
indicator would oscillate. One writer, one number.

Consequences:

- Derived bars always have `import_batch_id IS NULL`. Ingestion-written bars always have a non-null
  `import_batch_id`. This is invariant **INV-D1**, verified nightly:
  `select count(*) from md.market_bar where timeframe in ('60m','75m','120m','240m','1W','1M','3M','1Y') and import_batch_id is not null`
  must return `0`, and the mirror query for `('15m','1D')` must also return `0`. A violation is a
  `CRITICAL` operations alert, not a warning.
- The reconciler in document `03` only compares ingestion-owned timeframes. It never second-guesses a
  derived bar.
- If `15m` data is absent for a session, the intraday derived timeframes are absent for that session.
  The engine does not invent bars. The gap is visible and is recorded as `INCOMPLETE_SESSION` on the
  affected instrument's `md.bar_quality_issue` stream by the aggregation job's gap detector.

### 1.5 Dependency graph

```
                     md.market_bar  (15m, 1D — ingestion)
                              │
        ┌─────────────────────┴──────────────────────┐
        ▼                                            ▼
  aggregation (intraday)                       aggregation (higher)
  60m 75m 120m 240m                            1W 1M 3M 1Y
        │                                            │
        └───────────────┬────────────────────────────┘
                        ▼
              an.indicator_value        (per-bucket series, partitioned)
                        │
                        ├──────────────► an.indicator_snapshot   (latest row per instrument × timeframe)
                        ├──────────────► md.instrument_stat_52w  (daily only)
                        ▼
                  an.renko_brick_set / an.renko_brick
                        │
                        ├──────────────► an.breadth_snapshot      (per group × timeframe × brick_pct)
                        ▼
                  an.rs_snapshot / an.rs_value                    (per group × base × window)
                        │
                        ▼
                  scan.scanner_run / scan.scanner_run_result
```

Execution order is the topological order above and is not negotiable. The scheduler enforces it by
chaining job completions, not by wall-clock timers — a timer-based chain silently reorders itself on a
slow night.

### 1.6 Incremental computation and watermarks

`an.analytics_watermark` records, per `(instrument_id, timeframe, dataset, params_hash)`, the last
`bucket_start` that has been fully incorporated into that dataset. `dataset` is constrained to four
values; each maps to one producer:

| `dataset` | Producer job | Meaning of `computed_through` |
|---|---|---|
| `INDICATORS` | `analytics.compute_indicators` | Last bucket for which every row in `an.indicator_value` exists |
| `SNAPSHOT` | `analytics.compute_indicator_snapshot` | `as_of_bucket` of the current snapshot row |
| `STATS_52W` | `marketdata.compute_52w_stats` | `as_of_date` of the current 52-week row |
| `RENKO` | `analytics.compute_renko` | `source_bucket_start` of the last brick in the set |

Incremental rule: read `computed_through`, load bars with `bucket_start > computed_through` plus
`warmup_bars` bars before it (warm-up is required because a recursive indicator cannot be restarted
from a single value without the seeded state), compute, upsert, advance the watermark **in the same
transaction** as the upserts.

Two datasets have no watermark because their natural key already makes them idempotent:
`an.breadth_snapshot` (PK includes `session_date`) and `an.rs_snapshot` (unique on
group/base/date/window/version). Both are recomputed by explicit date range, and a re-run over an
already-computed date is a no-op upsert.

### 1.7 Invalidation cascade

A corrected input must invalidate everything downstream of it, or the platform will display a
consistent-looking lie. The trigger is `md.market_bar.updated_at` changing on a row with
`quality_status IN ('CORRECTED','QUARANTINED')`.

| Changed input | Invalidated | Action |
|---|---|---|
| `15m` bar | intraday aggregates for that session (`60m`,`75m`,`120m`,`240m`) | delete derived rows for `(instrument, session_date)`, recompute, reset watermark to `session_open_at - 1 tick` |
| `1D` bar | `1W`,`1M`,`3M`,`1Y` containing it | recompute containing bucket and every later bucket in the same timeframe (weekly aggregates affect later weeks only via indicators, not via OHLC, so later buckets are unaffected at the bar level) |
| Any bar | `an.indicator_value`, `an.indicator_snapshot`, `md.instrument_stat_52w`, `an.renko_brick_set`/`brick` for that instrument × timeframe | reset `computed_through` to the affected bucket minus warm-up; enqueue the four producer jobs |
| Renko bricks | `an.breadth_snapshot` for every group containing the instrument | recompute breadth for the affected dates |
| Any price | `an.rs_snapshot`/`rs_value` for every group/base/window touching the instrument | recompute for affected `as_of_date` onward |
| Scanner conditions | nothing (results are frozen) | new run with incremented `version` |

Watermark reset is a `DELETE` followed by re-insertion at the earlier timestamp, inside the
correction transaction. It is never a decrement of a running counter: the watermark is a fact about
what has been computed, and facts are replaced, not adjusted.

### 1.8 What an engine never does

- Never reads `md.market_bar` rows with `quality_status = 'QUARANTINED'`.
- Never reads rows with `is_partial = true`, except an explicitly partial-tolerant scanner
  (`scanner_definition.allow_partial = true`) and the chart API serving the in-progress bucket.
- Never writes to `md.*`. Only ingestion writes `md.market_bar`.
- Never assumes bars are contiguous. Missing bars are missing; they are not interpolated, forward
  filled, or zero-filled.
- Never uses `session_date` ordering as a proxy for `bucket_start` ordering within a day.

---

## 2. Canonical bars and timeframe bucketing

### 2.1 Session anchoring

Intraday buckets are anchored to **`ref.trading_calendar.session_open_at`**, not to wall-clock round
hours. A 60-minute bucket on NSE begins at 09:15 IST, not 09:00 IST.

Rationale: anchoring to round hours would put the first bucket at 09:00–10:00 and the last at
15:00–16:00, so the first bucket would contain only 45 minutes of trading and the last bucket would
contain 30 minutes. Every bar would then be a mixed-duration bar, and every indicator over those bars
would be computed on unequal windows. Anchoring to the session open makes the first `n−1` buckets
exactly `n` minutes and confines the anomaly to a single trailing partial bucket, which is explicitly
flagged.

Consequence: buckets from different exchanges do not align in absolute time. That is correct — a
60-minute NSE cash bar and a 60-minute MCX bar cover different real intervals because the sessions
differ. Any cross-exchange comparison must be made on `1D` or coarser.

### 2.2 Bucket width table — NSE/BSE cash, 375-minute session (09:15–15:30 IST)

`n_buckets = ceil(session_minutes / tf_minutes)`. The final bucket is partial when
`session_minutes mod tf_minutes ≠ 0`.

| TF | Width | Bucket starts (IST) | Full | Partial |
|---|---|---|---|---|
| `15m` | 15 | 09:15, 09:30, … 15:15 | 25 | 0 |
| `60m` | 60 | 09:15, 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 | 6 | 1 (15 min) |
| `75m` | 75 | 09:15, 10:30, 11:45, 13:00, 14:15 | 5 | 0 |
| `120m` | 120 | 09:15, 11:15, 13:15, 15:15 | 3 | 1 (15 min) |
| `240m` | 240 | 09:15, 13:15 | 1 | 1 (135 min) |
| `1D` | 375 | 09:15 | 1 | 0 |

`75m` is the only intraday timeframe that divides 375 exactly and is not a multiple of 15's natural
sub-multiple. It is included precisely because it produces five clean bars per session, which is why
intraday swing traders use it.

The partial-bucket rule is computed from data, not hard-coded:

```
expected_buckets(session) = ceil(minutes_between(session_open_at, session_close_at) / tf_minutes)
bucket_start(k)           = session_open_at + k * tf_minutes
bucket_end(k)             = min(session_open_at + (k+1) * tf_minutes, session_close_at)
is_partial(k)             = (bucket_end(k) - bucket_start(k)) < tf_minutes
```

For MCX (09:00–23:30, 870 minutes) the same formula yields 14 full `60m` bars plus a 30-minute partial;
for `75m` it yields 11 full bars plus a 45-minute partial. The engine never assumes 375.

### 2.3 Special and shortened sessions

`ref.trading_calendar` may record a shortened session (e.g. Muhurat trading 18:15–19:15) or a special
session on a weekend. Bucketing reads `session_open_at`/`session_close_at` per date, so a shortened
session produces a single partial bucket per intraday timeframe. Nothing special-cases it.

If `ref.trading_calendar` changes a session boundary **after** bars for that date were aggregated
(a rare but real correction), all derived intraday bars for every instrument on that exchange and date
are deleted and recomputed in one job. The invalidation trigger is a change to `session_open_at` or
`session_close_at` in `ref.trading_calendar`, captured by the same `updated_at` watcher used for
`md.market_bar`.

### 2.4 Aggregation rules

Given the ordered set of source bars `b₁ … bₖ` inside a bucket:

| Field | Rule |
|---|---|
| `open` | `b₁.open` |
| `high` | `max(bᵢ.high)` |
| `low` | `min(bᵢ.low)` |
| `close` | `bₖ.close` |
| `volume` | `Σ bᵢ.volume` |
| `turnover` | `Σ bᵢ.turnover` where any component is non-null; `null` only if every component is `null` |
| `delivery_volume` | `Σ bᵢ.delivery_volume`, `null` if every component is `null` |
| `delivery_pct` | `delivery_volume / volume × 100` rounded to 4 dp; `null` when `volume = 0` or `delivery_volume is null` |
| `open_interest` | `bₖ.open_interest` (last non-null in the bucket, scanning backwards from `bₖ`) |
| `is_partial` | `true` if the bucket's scheduled width is shorter than the timeframe (§2.2), **or** any source bar is `is_partial`, **or** the bucket end is later than the compute instant |
| `quality_status` | `VALIDATED` unless any contributing source bar is `CORRECTED`, in which case `CORRECTED` |
| `session_date` | the session date of the bucket (identical for all source bars, since buckets never cross sessions) |

`delivery_pct` is recomputed from the summed numerator and denominator rather than averaged. Averaging
percentages across bars of unequal volume is a common and silent error.

`open_interest` is the last value, not a sum or an average: open interest is a stock, not a flow.

### 2.5 Buckets never cross a session

A bucket belongs to exactly one `session_date`. `1D` is one bucket. `1W` contains only sessions from
one calendar week. A bucket that would span Friday 15:30 → Monday 09:15 does not exist; the Friday
session's last intraday bucket ends at `session_close_at`.

For `1W`/`1M`/`3M`/`1Y`:

- The bucket's session set is `{ s : s ∈ trading_calendar, s.is_trading_day, bucket_of(s) = this bucket }`.
- `bucket_start` = `session_open_at` of the **first** session in that set.
- `session_date` = `session_date` of the **last** session in that set.
- If the set is empty (a whole week of holidays), no row is written. Derived series are sparse; an
  absent week is genuinely absent, and indicators skip it rather than receiving a flat bar that would
  bias a moving average.

Calendar bucketing:

| TF | Bucket key of a `session_date` |
|---|---|
| `1W` | ISO-8601 week: Monday 00:00 of the containing week through Sunday 23:59. Monday-start is used because NSE weeks run Monday–Friday; using Sunday-start would split nothing in practice but would mis-handle the rare Saturday special session. |
| `1M` | calendar month (`YYYY-MM`) |
| `3M` | calendar quarter (`YYYY-Q1..Q4`), i.e. Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec |
| `1Y` | calendar year (`YYYY`) |

Quarterly is calendar-quarter, not fiscal-quarter. The Indian fiscal year starts 1 April, but charting
conventions and every data vendor's quarterly series use calendar quarters. Mixing the two produces
quarterly bars that disagree with every reference source. Where a fiscal view is needed, it is a
presentation concern computed from `1M` bars, not a separate stored timeframe.

### 2.6 Partial higher-timeframe bars

Weekly, monthly, quarterly, and yearly bars are **upserted after every session** while the period is
in progress, with `is_partial = true`, and rewritten as `is_partial = false` once the last session of
the period has been processed.

This exists so that a weekly chart shows the current week's developing candle instead of a chart that
mysteriously stops at last Friday. The alternative — writing the bar only at period close — makes the
UI look broken for four days out of five.

Downstream consequences, enforced in code:

- Indicator series over `1W`/`1M`/`3M`/`1Y` are only computed from `is_partial = false` bars, so a
  developing week never contributes a provisional moving-average point to history.
- The **snapshot** row for a higher timeframe is written from the latest bar regardless of
  `is_partial`, but the snapshot's derived indicators are computed on the last complete bar's series.
  In practice: the snapshot's `close`/`volume` reflect the developing bar; its `sma_*`/`rsi_*` reflect
  the last completed bar. This is stated in the API contract so the UI can label it.
- Scanners exclude partial bars by default. `allow_partial = true` includes them and sets a flag in
  `scanner_run.explain_plan`.

### 2.7 Worked example — NSE 240m and 60m from 15m

Session 09:15–15:30 IST, i.e. 03:45–10:00 UTC.

`240m` — two buckets:

| # | IST window | UTC `bucket_start` | Width | `is_partial` |
|---|---|---|---|---|
| 1 | 09:15–13:15 | 03:45 | 240 | false |
| 2 | 13:15–15:30 | 07:45 | 135 | **true** |

`60m` — seven buckets:

| # | IST window | UTC `bucket_start` | Width | `is_partial` |
|---|---|---|---|---|
| 1 | 09:15–10:15 | 03:45 | 60 | false |
| 2 | 10:15–11:15 | 04:45 | 60 | false |
| 3 | 11:15–12:15 | 05:45 | 60 | false |
| 4 | 12:15–13:15 | 06:45 | 60 | false |
| 5 | 13:15–14:15 | 07:45 | 60 | false |
| 6 | 14:15–15:15 | 08:45 | 60 | false |
| 7 | 15:15–15:30 | 09:45 | 15 | **true** |

A 60-minute chart therefore has one short bar per day. Any indicator computed over `60m` mixes 60- and
15-minute bars. This is inherent to the timeframe and the session length; it is not a defect, and it is
surfaced in the API as `is_partial: true` so the client can render the last bar distinctly and so a
scanner can exclude it. A trader comparing a 60m SMA to a 75m SMA is comparing two different sampling
schemes; the documentation says so rather than pretending otherwise.

### 2.8 Missing source bars inside a complete bucket

If a bucket that should contain `m` source bars contains `f < m`, and the session has closed:

1. The aggregate is still written, using whatever bars exist.
2. `is_partial` stays `false` — the bucket's *time window* was complete; the *data* was not.
3. The gap detector writes a `md.bar_quality_issue` row with
   `issue_code = 'INCOMPLETE_BUCKET'`, `severity = 'WARN'`, and `details = {"expected": m, "found": f, "missing": [...]}`.
4. A daily-level `INCOMPLETE_SESSION` issue is raised once per instrument per session if any intraday
   bucket was short.

If `f = 0`, no aggregate is written and no quality issue is raised at the bar level — an entirely
missing session is a feed-level failure already recorded against the import batch, and duplicating it
per instrument would generate 2,000 identical rows.

`is_partial` therefore means "this bar's window was not fully elapsed", never "this bar has holes".
Conflating the two would make it impossible to distinguish a live developing bar from a corrupted one,
which is exactly the distinction an operator needs at 15:31.

### 2.9 Authoritative `1D` and the prev-close contract

`md.market_bar` for `1D` carries the official OHLCV. `md.instrument_daily_snapshot` carries
`prev_close` and `change_pct`, populated by ingestion from the exchange's own previous-close field,
falling back to the previous `1D` bar's close when the field is absent.

`change_pct = (close − prev_close) / prev_close × 100`, rounded to 4 dp, `null` when `prev_close` is
`null` or zero. This is the only definition of `change_pct` in the system; scanners and dashboards read
the column, they never recompute it.

The `1D` bar's `prev_close` is **not** stored on `md.market_bar`; it lives on
`md.instrument_daily_snapshot`. Keeping one copy avoids the two-copies-disagree failure mode after a
corporate action.

---

## 3. Indicator framework

### 3.1 The standard indicator set

`an.indicator_snapshot` is a **wide table with a fixed column set**. That is a deliberate constraint,
not laziness: the scanner compiles to SQL over that table, so every indicator the scanner can reference
must be a real, typed, indexable column. An EAV design (`instrument, indicator, value`) would force the
scanner to self-join once per condition, and a 6-condition scan over 2,000 instruments would become six
joins over 6 million rows.

The fixed set is therefore the *contract*:

| Code | Params | Columns produced | Warm-up |
|---|---|---|---|
| `SMA` | `period=20` | `sma_20` | 20 |
| `SMA` | `period=50` | `sma_50`, `prev_sma_50` | 50 + 1 |
| `SMA` | `period=200` | `sma_200`, `prev_sma_200` | 200 + 1 |
| `EMA` | `period=20` | `ema_20`, `prev_ema_20` | 20 + 1 |
| `EMA` | `period=50` | `ema_50` | 50 |
| `RSI` | `period=14` | `rsi_14` | 15 |
| `ADX` | `period=14` | `adx_14`, `di_plus_14`, `di_minus_14` | 28 |
| `ATR` | `period=14` | `atr_14` | 15 |
| `BB` | `period=20, stdev=2` | `bb_upper_20_2`, `bb_middle_20_2`, `bb_lower_20_2` | 20 |
| `AVG_VOLUME` | `period=20` | `avg_volume_20` | 20 |
| `AVG_VOLUME` | `period=50` | `avg_volume_50` | 50 |
| `STATS_52W` | `lookback=252` | `high_252`, `low_252`, `pct_from_high_252`, `pct_from_low_252` | 252 (min 60 usable) |
| `ZIGZAG` | `threshold=3%` | `extra.zigzag` | 3 bars |

The standard parameter set has `params_hash = '1f0c9a7d34be5021'` — a literal constant computed once
from the canonical JSON of the above and asserted in a unit test. Changing any parameter above is a
**§12 change**, requiring a new hash constant, a dual-write period, and a scanner cutover.

Indicators outside this set (for example `RSI(21)`, `EMA(200)`, `Supertrend`, `VWAP`) are computed
into `an.indicator_value` with their own `params_hash` and served on charts, but they are **not
available to the scanner** until promoted into the standard set. `extra jsonb` on the snapshot is for
display-only payloads (ZigZag pivots) and is not queryable by scanners.

Why not let the scanner read `an.indicator_value` for arbitrary params: it is partitioned monthly and
PK'd on `(instrument, timeframe, bucket_start, indicator_code, params_hash)`. A point-in-time scan over
it is a range scan that reads 252 buckets per instrument; a 2,000-instrument scan reads ~500 k rows per
condition, which is 50–200× the cost of the pre-aggregated snapshot. Point-in-time scans exist (§8.9)
but they are an explicit, slower mode, not the default.

### 3.2 Warm-up and seeding

Each indicator declares `warmup` = the number of bars needed before its first output. The series is
computed over `[start − warmup, end]` and only rows in `[start, end]` are persisted. A bar whose
required lookback is incomplete produces `null`, never a partial-window value.

| Situation | Behaviour |
|---|---|
| `bars.length < warmup` | Entire series is `null`; no rows written for that instrument |
| A `null` appears mid-series (missing bar in a sparse higher timeframe) | Series continues; the window spans calendar buckets, not array positions. A weekly SMA-20 spans 20 *available* weeks, and `session_date` gaps are irrelevant because weekly bars are consecutive by construction |
| A `QUARANTINED` bar falls in the window | The instrument's series is not advanced past the first quarantined bar; the snapshot keeps its previous `as_of_bucket` and the job emits `SNAPSHOT_STALE` |

The last rule matters: computing an SMA across a hole silently invents a 20-period average over 19 real
observations plus one fabrication. Refusing to advance is the only defensible behaviour.

### 3.3 Simple moving average

```
SMA_t(n) = (1/n) · Σ_{i=0}^{n-1} close_{t−i}
```

Implemented with a rolling sum for `O(1)` per bar. The rolling sum is a `Decimal` accumulator that is
added to and subtracted from — never recomputed by summing the window — because recomputation is
`O(n)` per bar and the accumulated rounding of add/subtract at precision 28 is identical to full
recomputation at that precision (28 digits is far beyond the 6 dp stored).

First output at index `n−1` (0-based). `prev_sma_50` at index `t` is `sma_50` at index `t−1`, and is
`null` at the first output index.

**Golden vector** — closes `10, 11, 12, 13, 14`, `SMA(3)`:

| index | close | `sma_3` |
|---|---|---|
| 0 | 10 | null |
| 1 | 11 | null |
| 2 | 12 | 11 |
| 3 | 13 | 12 |
| 4 | 14 | 13 |

### 3.4 Exponential moving average

```
α = 2 / (n + 1)
EMA_{n−1} = SMA_n(0 … n−1)                    ← seed
EMA_t     = α · close_t + (1 − α) · EMA_{t−1}
```

Seeding with the SMA rather than with `close_0` is mandatory. Seeding with the first close makes the
first ~4n values depend on an arbitrary starting point; two vendors doing it differently produce EMAs
that differ by percent-level amounts for the first 50 bars and converge only after ~150. Seeding with
the SMA makes the series a function of the data alone.

`prev_ema_20` at index `t` is `ema_20` at `t−1`.

**Golden vector** — closes `10, 11, 12, 13, 14`, `EMA(3)`, `α = 0.5`:

| index | close | `ema_3` |
|---|---|---|
| 0 | 10 | null |
| 1 | 11 | null |
| 2 | 12 | 12.000000 (seed = SMA₃) |
| 3 | 13 | 12.500000 |
| 4 | 14 | 13.250000 |

### 3.5 Relative Strength Index (Wilder)

```
Δ_t   = close_t − close_{t−1}
gain_t = max(Δ_t, 0)
loss_t = max(−Δ_t, 0)

avgGain_n = (1/n) · Σ_{i=1}^{n} gain_i          ← seed over the first n changes
avgLoss_n = (1/n) · Σ_{i=1}^{n} loss_i

avgGain_t = ((n−1) · avgGain_{t−1} + gain_t) / n
avgLoss_t = ((n−1) · avgLoss_{t−1} + loss_t) / n

RS_t  = avgGain_t / avgLoss_t
RSI_t = 100 − 100 / (1 + RS_t)
```

Degenerate cases, all of which occur in Indian small-caps during circuit-locked sessions:

| Case | Result | Why |
|---|---|---|
| `avgLoss = 0` and `avgGain > 0` | `RSI = 100` | All gains, no losses |
| `avgGain = 0` and `avgLoss > 0` | `RSI = 0` | All losses, no gains |
| `avgGain = 0` and `avgLoss = 0` | `RSI = 50` | Flat series. **Not** `NaN`, not `100`. The 50 convention is universal and is what every vendor shows; returning `0` or `100` would make a flat series look like an extreme signal and fire every RSI scanner. |
| fewer than `n+1` closes | `null` | Warm-up |

Wilder smoothing (`(n−1)/n` weight) is used, not the plain EMA with `α = 2/(n+1)`. The two converge to
the same value eventually but differ by several points in the first 30 bars, and every published RSI
level (30/70) is calibrated against Wilder's recursion. Using the EMA variant would make our 70
threshold systematically different from the one traders expect.

**Golden vector** — closes `10, 11, 12, 11, 12, 13`, `RSI(3)`:

| index | close | Δ | `avgGain` | `avgLoss` | `RS` | `rsi_3` |
|---|---|---|---|---|---|---|
| 0 | 10 | — | — | — | — | null |
| 1 | 11 | +1 | — | — | — | null |
| 2 | 12 | +1 | — | — | — | null |
| 3 | 11 | −1 | 0.666667 | 0.333333 | 2.000000 | 66.666667 |
| 4 | 12 | +1 | 0.777778 | 0.222222 | 3.500000 | 77.777778 |
| 5 | 13 | +1 | 0.851852 | 0.148148 | 5.750000 | 85.185185 |

Flat-series vector: closes `10, 10, 10, 10, 10` with `RSI(3)` yields `null, null, null, 50, 50`.

### 3.6 True Range and ATR (Wilder)

```
TR_t = max( high_t − low_t,
            |high_t − close_{t−1}|,
            |low_t  − close_{t−1}| )
TR_0 = high_0 − low_0                          ← no previous close
ATR_{n−1} = (1/n) · Σ_{i=0}^{n−1} TR_i         ← seed
ATR_t     = ((n−1) · ATR_{t−1} + TR_t) / n
```

`ATR` is a price unit, not a percentage. The percentage form used by scanners is
`atr_pct = atr_14 / close × 100`, computed at query time from the snapshot columns; it is not stored,
because storing it would duplicate a value that depends on two existing columns.

**Golden vector** — bars `(H, L, C)`: `(10, 9, 9.5)`, `(11, 9.5, 10.5)`, `(10.5, 9.8, 10)`,
`(11.5, 10.2, 11.2)`, `ATR(3)`:

| index | TR | `atr_3` |
|---|---|---|
| 0 | 1.0 | null |
| 1 | 1.5 | null |
| 2 | 0.7 | 1.066667 (seed) |
| 3 | 1.5 | 1.211111 |

### 3.7 Directional movement and ADX (Wilder)

```
upMove_t   = high_t − high_{t−1}
downMove_t = low_{t−1} − low_t

+DM_t = upMove_t   if upMove_t > downMove_t   and upMove_t   > 0   else 0
−DM_t = downMove_t if downMove_t > upMove_t   and downMove_t > 0   else 0
```

Strict `>` in both comparisons is required. Using `>=` makes a bar with equal up and down moves
contribute to both directions, which double-counts volatility and inflates both DIs.

Wilder smoothing of `+DM`, `−DM`, and `TR`:

```
sum_n(X) = Σ_{i=1}^{n} X_i                      ← seed
sum_t(X) = sum_{t−1}(X) − sum_{t−1}(X)/n + X_t

+DI_t = 100 · sum_t(+DM) / sum_t(TR)
−DI_t = 100 · sum_t(−DM) / sum_t(TR)

DX_t  = 100 · |+DI_t − −DI_t| / (+DI_t + −DI_t)
ADX_t = ((n−1) · ADX_{t−1} + DX_t) / n
ADX seed = DX at the first index where DX is defined  (i.e. 2n−1)
```

Degenerate cases:

| Case | Result |
|---|---|
| `sum(TR) = 0` | `+DI = −DI = DX = 0`. Directional movement is undefined on a zero-range series; zero is the only value that does not create a spurious trend. |
| `+DI + −DI = 0` | `DX = 0` |
| fewer than `2n−1` bars for `ADX`, `n` bars for `DI` | `null` |

Note the different warm-ups: `+DI`/`−DI` are defined at index `n` (0-based, i.e. `n` completed
smoothing inputs), while `ADX` needs `n` more DX values, so `2n−1`. In `an.indicator_snapshot` this
means a 15-minute instrument needs 28 bars before `adx_14` is non-null — roughly one and a quarter NSE
sessions of 15-minute bars.

**Golden vector** — bars:

| i | H | L | C |
|---|---|---|---|
| 0 | 10.0 | 8.0 | 9.0 |
| 1 | 11.0 | 9.5 | 10.5 |
| 2 | 11.2 | 9.4 | 9.6 |
| 3 | 10.5 | 8.5 | 8.8 |
| 4 | 9.8 | 8.8 | 9.6 |

`ADX(2)` intermediates:

| i | `+DM` | `−DM` | `TR` |
|---|---|---|---|
| 1 | 0 | 1.5 | 2.0 |
| 2 | 0.2 | 0 | 1.8 |
| 3 | 0 | 0 | 2.0 |
| 4 | 0 | 0.3 | 1.0 |

| i | `sum(+DM)` | `sum(−DM)` | `sum(TR)` | `+DI` | `−DI` | `DX` | `adx_2` |
|---|---|---|---|---|---|---|---|
| 2 | 0.2 | 1.5 | 3.8 | 5.263158 | 39.473684 | 76.470588 | null |
| 3 | 0.1 | 0.75 | 3.9 | 2.564103 | 19.230769 | 76.470588 | 76.470588 |
| 4 | 0.05 | 0.675 | 2.95 | 1.694915 | 22.881356 | 86.206897 | 81.338743 |

### 3.8 Bollinger Bands

```
middle_t = SMA_t(n)
σ_t      = sqrt( (1/n) · Σ_{i=0}^{n−1} (close_{t−i} − middle_t)² )     ← population stdev
upper_t  = middle_t + k · σ_t
lower_t  = middle_t − k · σ_t
```

Population standard deviation (divide by `n`), not sample (`n−1`). The choice must be fixed because
the two differ by `sqrt(n/(n−1))` — 2.5 % at `n = 20`, which is enough to move a band by a visible
amount. Population is used because the window *is* the population of interest, and because it matches
TradingView's default, which is the reference users will compare against.

`σ` is computed in `Decimal` and square-rooted with `decimal.js`'s `sqrt()` at precision 28. Using
`Math.sqrt` on a `Decimal`-to-`Number` conversion at this point loses ~12 digits, which is irrelevant
for a 6 dp output but is needless inconsistency.

Bandwidth for the squeeze condition is computed at query time, not stored:
`bandwidth = (upper − lower) / middle`.

### 3.9 Volume averages

`avg_volume_20` and `avg_volume_50` are plain SMAs of `volume` over complete bars, rounded to 2 dp.
Volume is `bigint`, so the sum is accumulated as `Decimal` (a 50-bar sum of `bigint` can exceed
`Number.MAX_SAFE_INTEGER` only above ~1.8 × 10¹⁴ shares, which is not reachable, but the accumulation is
`Decimal` for uniformity).

`prev_volume` on the snapshot is the previous bar's volume, used by volume-spike scanners that want
"today's volume vs yesterday's" as well as "today's vs average".


### 3.10 52-week statistics

`lookback = 252` complete bars, not 365 calendar days. Indian markets have ~250 trading sessions per
year; using 365 calendar days would make the "52-week high" a 1.45-year high on a chart and would
disagree with every vendor.

```
window        = last min(252, available_complete_bars) bars ending at t
high_252      = max(high) over window
low_252       = min(low)  over window
sessions_used = |window|
pct_from_high = (close_t − high_252) / high_252 × 100      → ≤ 0
pct_from_low  = (close_t − low_252)  / low_252  × 100      → ≥ 0
```

Sign convention is fixed: `pct_from_high_252` is negative (or zero at a new high) and
`pct_from_low_252` is positive (or zero at a new low). Scanner conditions are written against this
convention, so a scanner named "within 3% of 52-week high" compiles to `pct_from_high_252 >= -3`
— and the condition is exposed to users as `NEAR_52W_HIGH { within_pct: 3 }`, never as a raw signed
comparison, because a user who sees `pct_from_high > -3` will eventually write `> 3` and get zero
results with no error.

Minimum data: the statistic is only written when `sessions_used >= 60` (roughly one quarter). Below
that, `high_252`/`low_252` are `null` and the scanner condition does not match. A newly listed stock
with 12 sessions would otherwise report its all-time high as its 52-week high, and every breakout
scanner would fire on listing day.

`md.instrument_stat_52w` stores the daily-timeframe version per `as_of_date`, for dashboards and for
"new 52-week high today" lists. `an.indicator_snapshot` carries the timeframe-specific version, so a
weekly scan gets a 252-*week* high, which is the correct meaning of "52-week high on a weekly chart" —
five years of weekly data, not 52 weeks of it. Both are correct in their own frame; the column name is
`high_252` (buckets) rather than `high_52w` precisely to keep that distinction visible.

### 3.11 Snapshot derivation

The snapshot is the scanner's working set: one row per `(instrument_id, timeframe)`, always the latest
computed state.

Write procedure per `(instrument_id, timeframe)`:

1. Read the ordered complete-bar series ending at the latest bucket.
2. Compute every standard indicator over the series with its declared warm-up.
3. Take the last element of each series as the snapshot value.
4. Take the second-to-last element of the series for `prev_sma_50`, `prev_sma_200`, `prev_ema_20`.
5. Read `close`, `volume`, `delivery_pct` from the latest bar **regardless of `is_partial`** (§2.6).
6. Read `prev_close`, `prev_volume` from the previous bar.
7. Upsert on the PK `(instrument_id, timeframe)`.

`prev_sma_50`, `prev_sma_200` and `prev_ema_20` are taken from the computed series, never from the previous snapshot row. Reading
the previous row would make the snapshot's history depend on how many times the job ran, which breaks
idempotency: two runs after a correction would produce a different `prev_*` than one run.

`extra` is populated only with `zigzag` (see §4) and is rewritten wholesale, never merged. A merge
would accumulate stale keys after a parameter change.

Snapshot staleness: `as_of_bucket` records the bucket the snapshot describes. A scanner rejects rows
whose `as_of_bucket < run.as_of − max_staleness` (configurable, default: 1 bucket for intraday, 3
sessions for daily). Rejected instruments are counted in `scanner_run.explain_plan.stale_excluded` and
are not silently treated as non-matches — an operator must be able to distinguish "did not match" from
"was not evaluated".

### 3.12 Indicator series storage

`an.indicator_value` holds the full per-bucket series, partitioned monthly on `bucket_start`. It is the
source for chart overlays and for point-in-time scans. Rows are inserted for every bucket where the
indicator is defined; `null` values are **not** stored (a wide sparse table of nulls wastes 8 bytes per
row and makes `count(*)` misleading). An indicator's first defined bucket is discoverable from
`an.analytics_watermark.computed_through` and from the first row's presence.

`on conflict (instrument_id, timeframe, bucket_start, indicator_code, params_hash) do update set value = excluded.value, computed_at = now()`
— a recompute overwrites in place. There is no history table for indicator values because an indicator
is a pure function of bars plus a versioned formula; the history that matters is the bar history, and
`md.market_bar_history` already preserves it. If a formula changes, the old values are destroyed by
design — that is the point of a version bump (§12).

---

## 4. Fibonacci ZigZag

### 4.1 Why a pivot engine exists at all

Fibonacci retracement without a defined pivot pair is decoration: any two points produce *some* levels.
The platform therefore defines pivots algorithmically and exposes the resulting levels as a
deterministic function of the bar series, so that two users looking at the same chart see the same
levels and a scanner can reference them.

### 4.2 Pivot rule

```
threshold = 3 % (default; configurable per request, 0.5 %–20 %)
```

The algorithm is a single-pass, **confirmed-pivot** ZigZag:

1. Start with `direction = NONE`, `extreme = first bar's close`, `extreme_index = 0`.
2. For each subsequent bar `i` with `close_i`:
   - If `direction == NONE`:
     - if `close_i ≥ extreme × (1 + threshold)` → `direction = UP`, emit pivot `(extreme_index, extreme, LOW)`, set `extreme = close_i`, `extreme_index = i`.
     - else if `close_i ≤ extreme × (1 − threshold)` → `direction = DOWN`, emit pivot `(extreme_index, extreme, HIGH)`, set `extreme = close_i`, `extreme_index = i`.
     - else leave `extreme` unchanged if `close_i` is between; **if `direction` is still `NONE` and `close_i` is a new running extreme in the direction of travel, update `extreme` and `extreme_index`** (see step 3).
   - If `direction == UP`:
     - if `close_i > extreme` → `extreme = close_i`, `extreme_index = i` (extend, no pivot).
     - else if `close_i ≤ extreme × (1 − threshold)` → emit pivot `(extreme_index, extreme, HIGH)`, set `direction = DOWN`, `extreme = close_i`, `extreme_index = i`.
   - If `direction == DOWN`: mirror image.
3. The first pivot is only emitted once a move of at least `threshold` occurs; before that, `extreme`
   tracks the running min or max of the initial undirected segment.

A pivot is emitted when the *opposite* move exceeds the threshold, and its index is the index of the
extreme. This means the last pivot in the returned list is always provisional until price moves
`threshold` away from it.

### 4.3 Non-repainting guarantee

The engine computes on **complete bars only** (`is_partial = false`). The API contract for ZigZag is:

- All pivots except possibly the last are final: they will never change as new bars arrive.
- The last pivot is marked `provisional: true` and may move or disappear.
- The last *segment* is marked `ongoing: true` and its endpoint equals the latest complete bar's close.

A repainting indicator that silently redraws history is worse than no indicator: a user who places an
order at a Fibonacci level and later sees the level move has been actively misled. The provisional flag
is therefore part of the response schema, not an implementation detail.

### 4.4 Levels

For a confirmed leg from `A` (start pivot) to `B` (end pivot), with `range = B.price − A.price`:

| Ratio | Level price (retracement of an UP leg) |
|---|---|
| 0.236 | `B − 0.236 · range` |
| 0.382 | `B − 0.382 · range` |
| 0.500 | `B − 0.500 · range` |
| 0.618 | `B − 0.618 · range` |
| 0.786 | `B − 0.786 · range` |
| 1.272 (extension) | `B + 0.272 · range` |
| 1.618 (extension) | `B + 0.618 · range` |

For a DOWN leg, `range` is negative and the same expressions produce the mirrored levels; no branch is
needed. Levels are rounded to the instrument's `price_precision`, not to 4 dp, because a Fibonacci
level on a ₹12 stock rounded to 4 dp is noise.

Levels are computed on request, not stored, except for the summary in `an.indicator_snapshot.extra.zigzag`
which carries the last two pivots and the current 0.382/0.5/0.618 levels for the latest timeframe.
Persisting the full pivot list would require a new table for a value that is cheap to recompute
(`O(bars)` with no recursion) and that changes on every new bar.

### 4.5 Complexity and limits

Single pass, `O(n)` time, `O(1)` extra space beyond the output list. Pivot count is bounded by
`n / 2` in the pathological alternating case; in practice a 3 % threshold yields 20–60 pivots over
2,000 daily bars. A request may specify `threshold`, `from`, `to`, and `max_pivots` (default 100,
hard cap 500); exceeding the cap truncates from the oldest end and sets `truncated: true`.

---

## 5. Renko

Renko is the platform's primary trend representation. Breadth, a class of scanners, and one of the
dashboard panels are defined on Renko bricks rather than on time bars, so the brick algorithm must be
exactly specified — two Renko implementations that disagree by one brick produce opposite breadth
readings on the same day.

Diagram: **D-10 Renko generation flow**.

### 5.1 Parameters and identity

A brick series is identified by the tuple:

```
(instrument_id, source_timeframe, brick_pct, reversal_bricks, price_source)
```

which is exactly `uq_renko_set` on `an.renko_brick_set`. `brick_pct` is constrained by
`ck_renko_brick_pct` to `{0.1, 0.15, 0.25, 0.5, 1, 2, 3, 5}` — the eight percentages required by the
product brief. `reversal_bricks` is constrained to `1..5` with default `2`. `price_source` is `CLOSE`
(default) or `HIGH_LOW`.

Two different `brick_pct` values produce two independent sets for the same instrument. They are not
nested: a 1 % brick series is not the 0.5 % series sampled every other brick, because reversals occur
at different prices. Each set is computed from source bars independently and stored independently.

### 5.2 Brick size

```
brick_size_abs = max( tick_size, round_to_tick( anchor_price × brick_pct / 100 ) )
```

`round_to_tick(p) = round_half_up(p / tick_size) × tick_size`, using the instrument's `ref.instrument.tick_size`
(default `0.05`, which is the NSE cash equity tick).

Two details that are easy to get wrong and are therefore fixed here:

- **The floor at one tick.** A 0.1 % brick on a ₹10 stock is ₹0.01, which rounds to zero ticks. A zero
  brick size makes the generator loop forever, so the size is floored at one tick. The stored
  `brick_size_abs` is the floored value, and the effective percentage is then larger than requested —
  this is visible in the API response (`effective_brick_pct`) so the user is not misled about the
  granularity they are looking at.
- **Rounding to the instrument's tick, not to 2 dp.** A ₹1,234.55 stock with a 0.25 % brick gives
  ₹3.086375, which must become ₹3.10 (62 ticks), not ₹3.09. Rounding to currency precision instead of
  tick precision makes bricks unalignable with actual traded prices, and the "brick close" then lands
  between two tradeable prices.

`brick_size_abs` is computed **once**, from the anchor, and held constant for the entire set. It does
not drift with price. A percentage-of-current-price brick size would make old and new bricks
incomparable and would make the series non-reproducible after a recompute.

### 5.3 Anchor

```
anchor_price  = close of the first eligible source bar
anchor_bucket = bucket_start of that bar
```

Eligibility: `is_partial = false`, `quality_status <> 'QUARANTINED'`, and `close > 0`.

Anchoring on the first **close** rather than the first open is deliberate: a brick can only be
confirmed at a bar close, so the series must begin from a confirmed price. Anchoring on the open would
mean the first brick could be "confirmed" by a price that was never observed at a decision point.

Consequence: extending history backwards (importing 2015 data into a set that started in 2020) changes
the anchor, changes `brick_size_abs`, and invalidates every brick. The engine detects this (`anchor_bucket`
differs from the first source bar's `bucket_start`) and performs a full rebuild with `revision + 1`
(§5.11). It never attempts a partial repair.

### 5.4 Price source

| Mode | Input per bar | Semantics |
|---|---|---|
| `CLOSE` (default) | `close` | Bricks are driven by closes only. Fully path-exact: the bar's close sequence is the complete information used, so the output is a deterministic function of the input with no ambiguity. |
| `HIGH_LOW` | `high` and `low` | Both extremes can drive bricks, producing a brick series that reacts to intra-bar range. Reacts faster, but introduces an ordering ambiguity (§5.6). |

Source prices are split- and bonus-adjusted with the factors of §7.2 (`05` §12.2.1), so a corporate action
is never a brick move; a newly applied corporate action therefore triggers a full rebuild (§5.12).

`CLOSE` is the default for breadth, RS, and all system scanners, because it is unambiguous and because
breadth across 2,000 instruments must be reproducible without knowing anything about intra-bar path.

`HIGH_LOW` is offered for discretionary chart use. It is explicitly documented as path-approximate.

### 5.5 Generation loop

State: `last_close` (the close of the most recent brick, or `anchor_price` if no brick yet),
`direction` (`NONE` | `UP` | `DOWN`), `seq` (0 initially).

For each source bar in `bucket_start` order, with `p = close` (`CLOSE` mode):

```
up_threshold   = last_close + brick_size
down_threshold = last_close − brick_size

while p >= up_threshold:
    emit brick(direction=UP, open=last_close, close=last_close + brick_size,
               source=bar, is_reversal = (previous direction was DOWN))
    last_close = last_close + brick_size
    direction  = UP
    up_threshold   += brick_size
    down_threshold += brick_size

while p <= down_threshold:
    emit brick(direction=DOWN, open=last_close, close=last_close − brick_size,
               source=bar, is_reversal = (previous direction was UP))
    last_close = last_close − brick_size
    direction  = DOWN
    up_threshold   -= brick_size
    down_threshold -= brick_size
```

Without a reversal rule (see §5.6), the two `while` loops never both fire on the same bar, because
after the up-loop exhausts, `p < last_close + brick_size`; and the down threshold moved up by the same
amount as `last_close`, so `p < down_threshold` is impossible. The loops are written as `while`, not
`if`, because a single bar can move several bricks (a gap, a circuit filter release, a result-day
move), and every intermediate brick must exist. A Renko series with gaps is not a Renko series.

Continuation bricks (same direction as the previous brick) carry `is_reversal = false`.

### 5.6 Reversal rule

```
reversal_distance = reversal_bricks × brick_size
reversal_threshold(direction=UP)   = last_close − reversal_distance
reversal_threshold(direction=DOWN) = last_close + reversal_distance
```

A reversal fires when price crosses the reversal threshold **against** the current direction, and it
emits exactly `reversal_bricks` bricks in the new direction:

```
if direction == UP and p <= last_close − reversal_distance:
    for k in 1..reversal_bricks:
        emit brick(DOWN, open=last_close, close=last_close − brick_size,
                   is_reversal = (k == 1))
        last_close -= brick_size
    direction = DOWN

if direction == DOWN and p >= last_close + reversal_distance:
    for k in 1..reversal_bricks:
        emit brick(UP, open=last_close, close=last_close + brick_size,
                   is_reversal = (k == 1))
        last_close += brick_size
    direction = UP
```

Then the continuation loop resumes from the new `last_close` for the remainder of the same bar.

With `reversal_bricks = 2`, a reversal consumes `2 × brick_size` of movement and produces 2 bricks —
which is why the classic 2-brick Renko chart shows two bricks on every trend change. `is_reversal` is
set on the **first** brick of the group only, so `where is_reversal` selects one row per trend change.
Marking both would make reversal counts double and would make "number of reversals this month"
ambiguous.

With `reversal_bricks = 1`, the series degenerates to the classic single-brick reversal and alternates
on every brick boundary. With `reversal_bricks = 3..5`, trend changes are rarer and the brick sequence
shows longer runs. All are supported without code changes; only the parameter differs.

### 5.7 Intrabar ordering under `HIGH_LOW`

A bar with `high` above the up threshold and `low` below the down threshold contains an unresolvable
ambiguity: we do not know which extreme occurred first. Two deterministic conventions exist; the
platform fixes one:

1. Compute `up_distance = high − last_close` and `down_distance = last_close − low`.
2. Process the **larger** distance first. If they are equal, process the direction of the bar
   (`close ≥ open` → up first, else down first).
3. After processing one side, re-evaluate the opposite side against the **new** `last_close`; the
   opposite side may no longer cross its threshold, in which case it is skipped.

Rationale: a bar that travelled further in one direction than the other almost certainly visited that
extreme in a way that dominated the bar's structure, and processing the dominant side first avoids
generating a reversal that the bar's own range does not actually support after the first move.
This is a heuristic and is documented as such. Every brick produced in `HIGH_LOW` mode carries the
same `source_bucket_start`; the mode is recorded on the set so a consumer always knows which
convention produced the series. `CLOSE` mode has no such ambiguity.

### 5.8 Timestamp assignment

Every brick records:

| Field | Value |
|---|---|
| `source_bucket_start` | `bucket_start` of the source bar that confirmed the brick |
| `source_session_date` | `session_date` of that bar |
| `seq` | 1-based, monotonic within the set, contiguous |
| `created_at` | write time (not part of the series identity) |

**Multiple bricks can share one `source_bucket_start`.** That is the normal case on a gap or a large
move. Brick identity is `(brick_set_id, seq)`, never `(brick_set_id, source_bucket_start)` — which is
why the PK is `(brick_set_id, seq)`.

Chart implication: a Renko chart is plotted by index, not by time. The API returns bricks with `seq`
and `source_bucket_start`; the client plots on `seq` and uses `source_bucket_start` only for tooltips
and for range selection. Plotting Renko on a time axis produces the familiar distorted chart where
three bricks stack on one date.

Range queries use `source_session_date` (indexed by `ix_renko_brick_date`) because "show me the bricks
since 1 March" is a date question, not a sequence question.

### 5.9 Synthetic OHLC

Bricks are consistently OHLC-shaped so that the same chart component and the same indicator code can
consume them:

| Direction | `open` | `close` | `high` | `low` |
|---|---|---|---|---|
| `UP` | `last_close` | `last_close + brick_size` | `close` | `open` |
| `DOWN` | `last_close` | `last_close − brick_size` | `open` | `close` |

No wicks. `brick_size` is stored per row (redundant with the set, but it makes the table self-describing
and allows a future variable-brick mode without a migration). The `ck_renko_brick_ohlc` constraint
holds by construction.

### 5.10 Worked example

Parameters: `brick_pct = 1`, `reversal_bricks = 2`, `price_source = CLOSE`, tick `0.05`.

Source closes: `100.00, 100.50, 101.20, 102.50, 101.00, 99.50, 98.00, 99.60, 101.50`.

Anchor: `anchor_price = 100.00`, `brick_size_abs = round_to_tick(100.00 × 1 / 100) = 1.00`.

| bar | close | action | bricks emitted | `last_close` after | `direction` |
|---|---|---|---|---|---|
| 1 | 100.00 | at anchor, nothing | — | 100.00 | NONE |
| 2 | 100.50 | below up threshold 101.00 | — | 100.00 | NONE |
| 3 | 101.20 | crosses 101.00 | #1 UP 100→101 | 101.00 | UP |
| 4 | 102.50 | crosses 102.00, then 102.50 < 103.00 | #2 UP 101→102 | 102.00 | UP |
| 5 | 101.00 | reversal threshold 100.00 not reached | — | 102.00 | UP |
| 6 | 99.50 | ≤ 100.00 → reversal | #3 DOWN 102→101 (`is_reversal`), #4 DOWN 101→100 | 100.00 | DOWN |
| 7 | 98.00 | continues: 99.00, then 98.00 | #5 DOWN 100→99, #6 DOWN 99→98 | 98.00 | DOWN |
| 8 | 99.60 | reversal threshold 100.00 not reached | — | 98.00 | DOWN |
| 9 | 101.50 | ≥ 100.00 → reversal, then continues | #7 UP 98→99 (`is_reversal`), #8 UP 99→100, #9 UP 100→101 | 101.00 | UP |

Nine bricks. Bar 7 produced two, bar 9 produced three. Reversal flags on `seq` 3 and 7 only. Breadth
for this instrument on bar 9's session counts "positive", because the latest brick's direction is `UP`.

### 5.11 Storage mapping and incremental update

`an.renko_brick_set` holds the header: parameters, `brick_size_abs`, `anchor_price`, `anchor_bucket`,
`revision`, `brick_count`, `last_brick_close`, `last_brick_at`, `computed_at`. `an.renko_brick` holds
the bricks. The header's `brick_count` and `last_brick_close` are maintained in the same transaction
as brick inserts, so a reader never sees a count that disagrees with the rows.

Incremental path (the common case — one new daily bar):

1. Load the set header and the last `max(reversal_bricks + 1, 2)` bricks.
2. Reconstruct generator state from `last_brick_close` and the direction of the last brick.
3. Load source bars with `bucket_start > watermark.computed_through`.
4. Run the loop, appending bricks with `seq` continuing from `max(seq)`.
5. `UPDATE` the header, advance the watermark.

Backtracking requirement: step 2 needs the **previous** brick's direction to set `is_reversal` on the
first new brick, and needs `last_close` — both available from the last brick row. No full replay.

### 5.12 Rebuild and correction

A full rebuild is triggered when any of the following is true:

| Trigger | Detection |
|---|---|
| Anchor changed (history extended backwards, or the first eligible bar was corrected) | `header.anchor_bucket <> first_eligible_bar.bucket_start` |
| Parameters changed | impossible — parameters are part of the unique key, so a change creates a new set |
| A source bar at or before `last_brick_at` was corrected or quarantined | `md.market_bar.updated_at` on a bar with `bucket_start <= header.last_brick_at` and `quality_status IN ('CORRECTED','QUARANTINED')` |
| Corporate action applied to the instrument | `corporate_action.applied` event (`03` §5.3) |
| Engine `VERSION` changed | deploy-time flag (`engine.renko.rebuild_all`) |
| Brick invariant check failed | nightly verifier (§11.4) |

Rebuild procedure, in one transaction:

```sql
-- 1. lock the set
select id, revision from an.renko_brick_set where id = $1 for update;
-- 2. discard the series
delete from an.renko_brick where brick_set_id = $1;
-- 3. bulk insert the recomputed bricks
-- 4. reset the header
update an.renko_brick_set
   set revision = revision + 1,
       brick_count = $2,
       last_brick_close = $3,
       last_brick_at = $4,
       anchor_price = $5,
       anchor_bucket = $6,
       brick_size_abs = $7,
       computed_at = now(),
       updated_at = now()
 where id = $1;
-- 5. reset the watermark
delete from an.analytics_watermark
 where instrument_id = $inst and timeframe = $tf
   and dataset = 'RENKO' and params_hash = $hash;
```

`revision` is the audit trail: a consumer that cached bricks at revision `n` can detect that `n+1`
exists. It is not used for optimistic concurrency in the API (reads are always of the current
revision), only to make a silent rewrite visible.

The transaction boundary matters: `delete` + `insert` + header update must be atomic, or a concurrent
breadth job reads a half-rebuilt series and publishes a breadth number that never existed. Breadth jobs
take `FOR SHARE` on the set header before reading bricks, which blocks against the rebuild's
`FOR UPDATE`.

Corrections upstream flow through the same mechanism: a corrected `1D` bar triggers a rebuild of every
Renko set whose `source_timeframe = '1D'` for that instrument, and then a breadth recompute for every
group containing it. There is no partial brick patch — a wrong brick early in the series changes every
subsequent brick's open, because bricks are chained through `last_close`.

### 5.13 Query patterns

| Query | Plan |
|---|---|
| Latest N bricks for one set | `Index Scan Backward` on `ix_renko_brick_latest` (`brick_set_id, seq desc`), `LIMIT n` |
| Bricks in a date range | `Index Scan` on `ix_renko_brick_date` (`brick_set_id, source_session_date desc`) |
| Latest brick for every instrument in a group (breadth input) | `LATERAL` join per instrument against `ix_renko_brick_latest`, `LIMIT 1`. 2,000 instruments × ~1 ms = ~2 s single-threaded, which is why breadth is a batch job, not a request-path query |
| Count of reversal bricks in a window | `Index Scan` on the date index with `and is_reversal`, filtered in the index heap; acceptable because reversals are ~2 % of bricks |

The API never returns an unbounded brick series. `GET /v1/instruments/:id/renko` requires `brick_pct`
and either `from`/`to` or `limit` (default 300, hard cap 2,000).

### 5.14 Invalidation of downstream consumers

`an.breadth_snapshot` rows for a group are keyed by `(group_id, timeframe, brick_pct, session_date)`.
A brick rebuild for one instrument therefore invalidates breadth only for the dates from the rebuild's
earliest affected `source_session_date` onward, for every `(group, timeframe, brick_pct)` whose set
includes that instrument. The breadth job deletes and recomputes that range; it does not recompute the
group's entire history.

`an.rs_snapshot` is unaffected by Renko: RS is computed from `1D` closes, not bricks. This is
deliberate. A Renko-derived RS would confound trend representation with relative performance and would
make the RS matrix's numbers change when a brick parameter is edited.

---

## 6. Breadth

### 6.1 Definition

Breadth answers one question per `(group, timeframe, brick_pct, session_date)`: **of the group's
eligible members, how many are currently printing up bricks?**

A member's current state is the direction of its **latest** brick in the specified set at or before the
session date. Breadth is therefore a Renko concept in this platform, not a moving-average-of-advances
concept. The choice is deliberate: "Nifty 500 breadth at 1 % bricks" is a statement about how many
constituents are in an uptrend of at least one brick, which is directly actionable. A
count-of-advances-over-declines breadth is a one-day statistic that whipsaws and is dominated by
noise around zero.

### 6.2 Eligibility

A member is eligible for `(group, brick_pct, session_date)` when **all** hold:

1. `ref.market_group_member` row is active on that date:
   `added_on <= session_date and (removed_on is null or removed_on > session_date)`.
2. `ref.instrument.status = 'ACTIVE'` and
   `(delisting_date is null or delisting_date > session_date)`. A suspended or delisted member is
   excluded from both numerator and denominator.
3. The instrument has a `1D` bar on that `session_date` (it actually traded). A member halted for the
   day is excluded — counting it as "unchanged" would dilute breadth on exactly the days when breadth
   matters most.
4. The instrument's `1D` bar on that date has `quality_status <> 'QUARANTINED'`.
5. The instrument has a Renko set matching `(source_timeframe, brick_pct)` with at least one brick
   whose `source_session_date <= session_date`.

Ineligible members are counted in `total_members − eligible_members`. `total_members` is the number of
active membership rows on that date; `eligible_members` is the subset passing 1–5.

**These rules are frozen into the stored snapshot.** A membership change made today does not rewrite
yesterday's breadth, because `breadth_snapshot` rows are computed with the membership in force on
`session_date`, and `market_group_member` rows are closed (`removed_on`) rather than deleted — document
`02` §5.2. History stays reproducible.

### 6.3 Computation

```
positive_bricks  = count(members whose latest brick.direction = 'UP')
negative_bricks  = count(members whose latest brick.direction = 'DOWN')
unchanged_bricks = eligible_members − positive_bricks − negative_bricks
positive_pct     = round_half_up(positive_bricks / eligible_members × 100, 4)
```

`unchanged_bricks` is not a count of flat members in any price sense: it is the residual. A member
whose latest brick is from three sessions ago is `unchanged` by construction — it has not printed a
brick today. That is the correct reading of "has not moved a brick".

`eligible_members = 0` (an empty or fully halted group): the row **is** written, with
`positive_pct = 0`, all counts `0`, and `sma5_positive_pct = null`. Writing the row keeps the series
gap-free for charting; `positive_pct = 0` with `eligible_members = 0` is unambiguous because the
denominator is stored alongside it. Suppressing the row would make the chart interpolate across a real
gap, which is worse.

### 6.4 Breadth moving average

```
sma5_positive_pct = SMA(positive_pct, 5) over the last 5 breadth rows
                    for the same (group_id, timeframe, brick_pct)
```

Computed over the last five **available** rows, not the last five calendar sessions. A week-long
holiday produces no rows and the SMA-5 uses the five most recent sessions with data. `null` until five
rows exist for that group.

The SMA is computed by the breadth job, not at query time, because it is displayed on a dashboard panel
that must render in one round trip. It is stored in the same row it summarises, which means a
retroactive correction to `positive_pct` on any of the five rows must recompute the SMA on all rows
whose window contains it — implemented as a bounded `UPDATE` over the affected date range
(`[affected_date, affected_date + 4 sessions]`).

### 6.5 Multiple brick sizes

Breadth is stored per `brick_pct`. The default dashboard panel uses `1 %`. A 0.5 % series is noisier
and crosses 50 % far more often; a 3 % series is smoother and sits near extremes for months. Users can
switch between them, and because each is stored, switching is a `WHERE brick_pct = ...` not a
recomputation.

### 6.6 Group types

Breadth is meaningful for any `market_group`, including `CUSTOM` and `COMPOSITE` groups. It is
**not** meaningful for a group whose members are indices (an "index of indices" breadth counts index
bricks, which is a legitimate but unusual query and is allowed). It is forbidden for dynamic groups
(`is_dynamic = true`) unless the dynamic rule has been materialised into `market_group_member` rows for
the date, because breadth must be reproducible from stored membership. The breadth job refuses to run
for a dynamic group with no materialised membership and writes a `MISSING_MEMBERSHIP` issue.

### 6.7 Worked example

Group `NIFTY500`, `brick_pct = 1`, `source_timeframe = '1D'`, session 2026-03-13.

- Active members: 500.
- Halted / no `1D` bar: 4.
- Quarantined bar: 1.
- No brick set yet (newly included, insufficient history): 2.
- `eligible_members = 493`, `total_members = 500`.

Latest bricks: 331 `UP`, 154 `DOWN`, 8 with a latest brick from an earlier session.

```
positive_bricks  = 331
negative_bricks  = 154
unchanged_bricks = 493 − 331 − 154 = 8
positive_pct     = 331 / 493 × 100 = 67.1390
```

If the previous four sessions were `64.2011, 61.8844, 58.0213, 55.9007`, then
`sma5_positive_pct = (55.9007 + 58.0213 + 61.8844 + 64.2011 + 67.1390) / 5 = 61.4293`.

---

## 7. Relative Strength Matrix

Diagram: **D-09 RS Matrix flow**.

### 7.1 Methodology

`methodology_version = 'ratio-of-returns/v1'`. Every `an.rs_snapshot` row records it, so a future
formula change does not silently mix methodologies in one matrix.

Definitions, for a member `a` and a base `b`, window `W` sessions, as of session `t`:

```
R_a = P_a(t) / P_a(t − W)                     ← simple return multiple over the window
R_b = P_b(t) / P_b(t − W)

ratio      = R_a / R_b                         ← relative performance multiple
score      = (ratio − 1) × 100                 ← percentage outperformance over the window
```

Interpretation: `score = +8.4` means the member outperformed the base by 8.4 % over the window,
compounded, on the same price basis. `score = 0` means it matched exactly.

Why ratio-of-returns rather than a ratio of raw prices:

- **Scale-free.** A ratio of raw prices is not comparable across instruments with different price
  levels or across time. `P_a / P_b` for a ₹3,000 stock against a 20,000-point index is `0.15`; six
  months later the same pair can be `0.16` and the "RS line" looks like it rose 6.7 %, when the true
  relative performance depends entirely on both starting points.
- **Zero is meaningful.** `score = 0` is exact parity. A raw ratio has no natural centre.
- **Comparable across windows.** A 21-session score and a 252-session score are both "percent
  outperformance over that window", so the matrix's columns can be read side by side. Raw-ratio levels
  across windows are different quantities entirely.
- **Additive across time.** `R(t₀→t₂) = R(t₀→t₁) × R(t₁→t₂)`, so multi-window analysis composes.

The cost: the method needs a price at exactly `t − W`, which must be a real trading session for that
instrument. §7.3 handles that.

### 7.2 Price basis and adjustment

`price_mode` is `ADJUSTED` (default) or `RAW`, stored on the snapshot.

`ADJUSTED` uses split- and bonus-adjusted closes so that a 1:10 split does not register as a −90 %
return. Back-adjustment factor, for `as_of`:

```
factor(instrument, from, to) =
    Π over corporate_action rows where
        action_type IN ('SPLIT','BONUS')
        and from < ex_date <= to
    of  (ratio_from / ratio_to)

adjusted_close(t) = close(t) × factor(instrument, t, as_of)
```

Check: a 1:2 split has `ratio_from = 1`, `ratio_to = 2`, factor `0.5`; pre-split prices are halved, so
the split day shows no artificial drop. A 1:1 bonus has `ratio_from = 1`, `ratio_to = 2`, the same
factor — a bonus is economically a split.

**Dividends are excluded from `ADJUSTED`.** Including them would make RS dependent on dividend policy
and would make an index of dividend payers systematically outperform on a total-return basis while the
displayed prices are ex-dividend. The platform's prices are price returns; RS is a price-return
measure. Where total return is wanted, that is a separate, explicitly named future methodology
(`ratio-of-returns/total/v1`), not an invisible option.

`ADJUSTED` requires the corporate-action table to be current. A split that is missing from
`ref.corporate_action` produces a score of roughly −90 % for the affected instrument and it will appear
as the worst laggard in the matrix. This is why the corporate-action feed is a **Phase 4 blocker**: the
RS matrix is not allowed to ship before corporate actions are populated for the covered universe. Each
snapshot job emits the count of instruments whose price basis required at least one adjustment factor
(`adjusted_instruments`) into its structured log line and into the `audit.audit_event` payload for the
run, so an operator can watch that number against the corporate-action feed's own count and see a
stale-feed condition forming.

`RAW` exists for debugging an adjustment discrepancy: run the same snapshot in `RAW`, diff the scores,
and the instruments that moved are the ones with a corporate action in the window.

### 7.3 Window resolution

`W ∈ {21, 63, 126, 252}` calendar-independent **trading sessions**, enforced by `ck_rs_window`.

```
t_0 = the session W trading sessions before t, for the base instrument's exchange
      = the (W+1)-th row of ref.trading_calendar where is_trading_day, counting backwards from t
```

Using stored trading sessions rather than `t − W × 7/5` days makes the window exact: 21 sessions is
one trading month, 252 is one trading year, regardless of holidays. In a year with 14 market holidays,
`t − 365 days` is 247 sessions, not 252 — a 2 % error in the denominator that silently shifts every
score.

Per-instrument price lookup:

| Situation | Behaviour |
|---|---|
| Member has a bar exactly at `t` and `t_0` | normal |
| Member listed after `t_0`, or suspended on `t_0` | `insufficient_history = true`; `ratio`, `score`, `rank` are `null`; the row is still written |
| Member's bar on `t` is `QUARANTINED` | treated as missing → `insufficient_history = true` |
| Base instrument missing a bar at either endpoint | the whole snapshot fails with `BASE_INSUFFICIENT_HISTORY`; no snapshot is written, because every score would be undefined and an empty matrix is less misleading than a matrix of nulls with no explanation |

`insufficient_history` rows participate in neither ranking nor percentile, and are excluded from
`member_count`'s *scored* subset (they are included in `member_count`'s *attempted* subset). The API
reports both counts.

### 7.4 Supported pairings

All pairings are `market_group × base_instrument`. The group supplies the members; the base is a single
instrument. Nothing in the engine special-cases pairing types — the semantics are entirely in which
instruments populate the group and which instrument is the base. The table below documents the
supported configurations and the reference data each requires.

| Pairing | Group | Base | Notes |
|---|---|---|---|
| Index vs Index | `INDEX` group of index instruments | second index | Cross-index rotation, e.g. Nifty 50 vs Nifty Midcap 150 |
| Stock vs Index | `INDEX` group (constituents) | the index | The standard RS matrix: which constituents lead the benchmark |
| Index vs Gold | `INDEX` or `CUSTOM` group of indices | gold proxy instrument | Gold proxy is an ETF (e.g. a NSE gold ETF) designated in `ref.instrument` with `instrument_type = 'ETF'` and a `GOLD_PROXY` tag in `ref.market_group` |
| Index vs GS Composite | any group | synthetic GS Composite instrument | See §7.8 |
| Index vs USD-INR | any group | `USDINR` currency instrument (`instrument_type = 'CURRENCY'`) | Requires the FX series to be ingested as a `1D` instrument on the `NSE`/`BSE` currency segment or an approved source. FX has a different session; the engine aligns on `session_date`, which is correct because both are "the Indian trading day" |
| Index vs Bonds | any group | bond proxy instrument | 10-year G-Sec yield is a rate, not a price. A bond **total-return index** or a long-duration G-Sec ETF is used as the proxy, because a yield series inverted would produce a meaningless ratio of a reciprocal. The proxy is declared in config and documented in the UI |
| Intra-group stocks | `SECTOR`/`CUSTOM`/`COMPOSITE` group | a member or an external instrument | Comparing HDFC Bank vs ICICI Bank inside `BANKNIFTY` |

Each pairing is stored as an ordinary `an.rs_snapshot` row with `group_id` and `base_instrument_id`.
There is no separate table per pairing type, and no enum of pairing types — adding a new pairing is a
configuration change (create the group, designate the base), not a migration.

### 7.5 Ranking, percentile, leaders and laggards

Scored members are ordered by:

```
ORDER BY score DESC,
         turnover DESC NULLS LAST,
         instrument.symbol ASC
```

and assigned **ordinal** ranks `1..n` with no ties. Ties must be broken deterministically because
`uq_rs_value_rank` is a unique index on `(snapshot_id, rank)` — a tie would make the insert fail, and
"two instruments at rank 7" is not representable. Ordinal ranking is the only scheme that satisfies the
constraint without an arbitrary tiebreak column in the key.

```
n          = number of scored members
percentile = (n − rank) / (n − 1)          for n > 1
percentile = 1.0                            for n = 1
```

`percentile = 1.0` for the top-ranked member, `0.0` for the last. Percentile is monotone in score and
independent of the score distribution's shape, which is what makes it usable for threshold-based
scanning across groups of very different sizes.

Leaders and laggards:

```
leader_count  = max(1, ceil(0.10 × n))
is_leader     = rank <= leader_count
is_laggard    = rank >  n − leader_count
both          = false when n < 2
```

The `max(1, …)` matters: a 6-stock sector at the 10th percentile would otherwise have zero leaders and
zero laggards, and the matrix would render an empty "leaders" column for small sectors. The
`n < 2` guard satisfies `ck_rs_value_exclusive` and avoids calling the only member both a leader and a
laggard.

For `n = 20`, `leader_count = 2`. For `n = 500`, `leader_count = 50`. The count is derived, never
configured per group.

### 7.6 Trend of the RS line

`rs_line_slope` describes whether the relative performance itself is improving or deteriorating, which
is different from whether it is currently positive.

```
x_k = k                                       for k = 0 … W   (session offset from t_0)
y_k = ln( ratio_k )                           ratio_k = R_a(k) / R_b(k) at each session in the window
slope = OLS_slope(x, y)
trend = 'UP'   if slope >  +ε
        'DOWN' if slope <  −ε
        'FLAT' otherwise
ε = 0.0005 per session
```

Computed on `ln(ratio)` rather than `ratio`: a log slope is the continuously-compounded relative growth
rate, so a slope of `0.001` means "outperforming the base by 0.1 % per session" regardless of the
ratio's level. On raw ratios the same slope means wildly different things at `ratio = 0.02` and
`ratio = 3.0`.

`ε = 0.0005` per session is ~0.05 % per session, which over 21 sessions is ~1 % — a threshold below
which the trend label would flip on rounding noise.

`trend` requires at least 20 valid `y_k` samples in the window; otherwise it is `null`. A window with
holes (a suspension) produces `null` rather than a slope fitted to a broken series.

`insufficient_history` rows have `rs_line_slope = null`, `trend = null`.

### 7.7 Worked example

Base `NIFTY50`, member `RELIANCE`, `W = 63`, `t = 2026-03-13`, `ADJUSTED`.

```
P_RELIANCE(t)      = 2 987.40
P_RELIANCE(t−63)   = 2 741.10
R_a = 2987.40 / 2741.10 = 1.089819

P_NIFTY(t)         = 24 118.75
P_NIFTY(t−63)      = 23 402.30
R_b = 24118.75 / 23402.30 = 1.030617

ratio = 1.089819 / 1.030617 = 1.057441
score = (1.057441 − 1) × 100 = +5.744100
```

If `RELIANCE` ranked 37 of 500 scored members:
`percentile = (500 − 37) / 499 = 0.927856`. `leader_count = 50`, so `is_leader = true`,
`is_laggard = false`.

### 7.8 GS Composite — assumption A11

"GS Composite" is not a standardised, exchange-published index. To avoid inventing a number and
presenting it as official, the platform defines it explicitly:

> **A11.** The GS Composite is a platform-defined, equal-weighted synthetic instrument composed of the
> instruments listed in the `market_group` with `code = 'GS_COMPOSITE'` and
> `group_type = 'COMPOSITE'`. Its price series is a synthetic `1D` bar series computed as an
> equal-weighted average of the **normalised** closes of its members:
> `index_t = 1000 × (1/n) × Σ_i ( close_i,t / close_i,base )`, rebased at `base` = the first session on
> which all current members have a bar. Membership changes take effect from the change date; the index
> is **not** retroactively rebased, so a membership change appears as a level shift in the synthetic
> series and is flagged in the UI. The group's members and the base date are stored in
> `ref.market_group` and `ref.market_group_member`, making the series reproducible.

The synthetic instrument carries `ref.instrument.is_synthetic = true` and
`instrument_type = 'INDEX'`, which excludes it from any "real instrument" listing and prevents it from
being traded, ingested, or reconciled. Its `1D` bars are written by the analytics pipeline, not by
ingestion — a documented, single exception to the ownership rule in §1.4, made explicit here and
covered by INV-D2: the only instrument allowed to have engine-written `1D` bars is one with
`is_synthetic = true`.

Membership of `GS_COMPOSITE` is configuration: the initial seed lists the gold and silver proxy
instruments available on NSE, flagged `VERIFY_BEFORE_PROD` like every other seeded market fact.

### 7.9 Matrix response shape

The API returns one row per member and one column per requested window:

```json
{
  "group": { "id": "…", "code": "NIFTY500" },
  "base":  { "id": "…", "symbol": "NIFTY50" },
  "as_of_date": "2026-03-13",
  "methodology_version": "ratio-of-returns/v1",
  "price_mode": "ADJUSTED",
  "member_count": 500,
  "scored_count": 493,
  "windows": [21, 63, 126, 252],
  "rows": [
    {
      "instrument_id": "…",
      "symbol": "RELIANCE",
      "close": "2987.4000",
      "scores": { "21": "1.842000", "63": "5.744100", "126": null, "252": "11.902000" },
      "ranks":  { "21": 44, "63": 37, "126": null, "252": 21 },
      "percentiles": { "21": "0.912000", "63": "0.927856", "126": null, "252": "0.959920" },
      "trend": "UP",
      "is_leader": true,
      "is_laggard": false,
      "insufficient_history": false
    }
  ]
}
```

Prices and scores are decimal **strings**, never JSON numbers (INV-06). A client that parses
`"5.744100"` into a float for display is free to do so; a client that receives `5.7441` cannot recover
the stored precision.

The matrix is rendered from one request, not `n` requests. `scored_count` is reported separately from
`member_count` so the UI can say "493 of 500 scored" instead of silently hiding 7 null rows.

---

## 8. Scanner engine

Diagram: **D-08 Scanner execution flow**.

### 8.1 Scanners are data, not code

A scanner is a row in `scan.scanner_definition`. Adding a screen must not require a deploy, because
screens are the part of a trading platform that changes most often — a user who wants "RSI below 40 AND
close above the 200-day AND volume at least 2× average" should not file a ticket.

The condition tree is stored as JSONB and compiled to SQL at run time against a **closed registry** of
condition types. There is no dynamic SQL constructed from user strings: every condition type has a
pre-written SQL fragment and a typed parameter set, and the compiler only concatenates those fragments
with bound parameters.

### 8.2 Definition schema

```json
{
  "schema": "scanner-conditions/v1",
  "root": {
    "op": "AND",
    "children": [
      { "type": "CLOSE_ABOVE_SMA", "period": 200 },
      { "type": "RSI_BELOW", "period": 14, "value": "40" },
      { "type": "VOLUME_SPIKE", "multiple": "2.0", "reference": "AVG_20" }
    ]
  }
}
```

The root is an **object** (required by `ck_scanner_conditions check (jsonb_typeof(conditions) = 'object')`),
not a bare array, so that the schema version travels with the tree and future nodes (weights, negation
wrappers) can be added without breaking older rows.

Companion columns on `scanner_definition`:

| Column | Role |
|---|---|
| `universe` | JSONB object: `{"type":"GROUP","code":"NIFTY500"}` or `{"type":"INSTRUMENTS","ids":[…]}` or `{"type":"ALL","exchange":"NSE","instrument_type":"EQUITY"}` |
| `timeframe` | One of `15m`, `60m`, `75m`, `1D`, `1W`, `1M` — the scanner-allowed subset |
| `logic` | `AND`/`OR`, mirrors `root.op`; kept denormalised so the UI can render a chip without parsing |
| `parameters` | JSONB defaults for parameterised conditions, merged at run time |
| `allow_partial` | Whether in-progress bars participate |
| `is_system` | System scanners are read-only; cloning creates a user-owned copy |
| `version` | Incremented on any change to `universe`, `conditions`, `parameters`, or `timeframe` |

Scanner-allowed timeframes are a strict subset of `ref.timeframe`. `120m`, `240m`, `3M`, `1Y` are
deliberately excluded: they are charting conveniences, and a screen on a 4-hour or yearly bar mixes
partial buckets with full ones in a way that produces results a user cannot explain. The restriction is
enforced in the application layer (the FK cannot express a subset), validated on create and update, and
covered by a test that enumerates the allowed set from a single shared constant.

### 8.3 Condition registry

Every entry below has: a stable `type`, a parameter schema, exactly one SQL fragment, and a null
policy. `snapshot` indicates the underlying `an.indicator_snapshot` column(s).

| `type` | Params | SQL predicate | Null policy |
|---|---|---|---|
| `CLOSE_ABOVE_SMA` | `period ∈ {20,50,200}` | `s.close > s.sma_{p}` | exclude |
| `CLOSE_BELOW_SMA` | `period` | `s.close < s.sma_{p}` | exclude |
| `SMA_CROSS_ABOVE` | `fast, slow ∈ {20,50,200}` | `s.prev_sma_{f} <= s.prev_sma_{s} and s.sma_{f} > s.sma_{s}` | exclude |
| `SMA_CROSS_BELOW` | `fast, slow` | `s.prev_sma_{f} >= s.prev_sma_{s} and s.sma_{f} < s.sma_{s}` | exclude |
| `EMA_CROSS_ABOVE` | `fast, slow ∈ {20,50}` | `s.prev_ema_{f} <= s.ema_{s} and s.ema_{f} > s.ema_{s}` | exclude |
| `PRICE_ABOVE` | `value` | `s.close > $n::numeric` | exclude |
| `PRICE_BELOW` | `value` | `s.close < $n::numeric` | exclude |
| `CHANGE_PCT_ABOVE` | `value` | `s.close > s.prev_close * (1 + $n/100)` | exclude |
| `CHANGE_PCT_BELOW` | `value` | `s.close < s.prev_close * (1 + $n/100)` | exclude |
| `RSI_ABOVE` | `period=14`, `value` | `s.rsi_14 > $n::numeric` | exclude |
| `RSI_BELOW` | `period=14`, `value` | `s.rsi_14 < $n::numeric` | exclude |
| `RSI_BETWEEN` | `low`, `high` | `s.rsi_14 between $n and $m` | exclude |
| `ADX_ABOVE` | `period=14`, `value` | `s.adx_14 > $n::numeric` | exclude |
| `DI_BULLISH` | — | `s.di_plus_14 > s.di_minus_14` | exclude |
| `DI_BEARISH` | — | `s.di_minus_14 > s.di_plus_14` | exclude |
| `ATR_PCT_ABOVE` | `value` | `s.atr_14 / s.close * 100 > $n::numeric` | exclude (`close > 0` guaranteed by `ck_market_bar_ohlc_positive`) |
| `ATR_PCT_BELOW` | `value` | `s.atr_14 / s.close * 100 < $n::numeric` | exclude |
| `BB_SQUEEZE` | `max_bandwidth_pct` | `(s.bb_upper_20_2 - s.bb_lower_20_2) / s.bb_middle_20_2 * 100 < $n` | exclude |
| `BB_BREAKOUT_UP` | — | `s.close > s.bb_upper_20_2` | exclude |
| `BB_BREAKDOWN` | — | `s.close < s.bb_lower_20_2` | exclude |
| `VOLUME_SPIKE` | `multiple`, `reference ∈ {AVG_20, AVG_50, PREV}` | `s.volume >= $n * s.avg_volume_{r}` (or `* s.prev_volume`) | exclude |
| `DELIVERY_ABOVE` | `value` | `s.delivery_pct > $n::numeric` | exclude |
| `NEAR_52W_HIGH` | `within_pct` | `s.pct_from_high_252 >= -$n::numeric` | exclude |
| `NEAR_52W_LOW` | `within_pct` | `s.pct_from_low_252 <= $n::numeric` | exclude |
| `NEW_52W_HIGH` | — | `s.close >= s.high_252` | exclude |
| `NEW_52W_LOW` | — | `s.close <= s.low_252` | exclude |
| `OPEN_EQUALS_LOW` | `tolerance_ticks` (default 0) | `s.close >= s.close`… see below | exclude |
| `OPEN_EQUALS_HIGH` | `tolerance_ticks` | see below | exclude |
| `GAP_UP` | `min_pct` | `s.prev_close is not null and (s.open - s.prev_close) / s.prev_close * 100 >= $n` | exclude |
| `GAP_DOWN` | `min_pct` | `(s.open - s.prev_close) / s.prev_close * 100 <= -$n` | exclude |
| `RENKO_REVERSAL` | `brick_pct`, `reversal_bricks`, `direction` | `lb.is_reversal and lb.direction = $d` | exclude |
| `RENKO_CONSECUTIVE` | `brick_pct`, `count`, `direction` | last `count` bricks all `$d` | exclude |
| `BREADTH_ABOVE` | `group_code`, `brick_pct`, `value` | `bs.positive_pct > $n` | exclude |
| `BREADTH_BELOW` | `group_code`, `brick_pct`, `value` | `bs.positive_pct < $n` | exclude |
| `MTF_ALIGN` | `other_timeframe`, `rule ∈ {ABOVE_SMA200, RSI_ABOVE_50, UP_TREND}` | join second snapshot | exclude |
| `ZIGZAG_RETRACE_NEAR` | `ratio`, `tolerance_pct` | `extra->'zigzag'` comparison | exclude |

Three notes on the non-obvious entries:

**`OPEN_EQUALS_LOW`, `OPEN_EQUALS_HIGH`, `GAP_UP`, `GAP_DOWN`** need `open`/`low`/`high`, which are not
on the snapshot. The compiler adds one shared `LATERAL` join per scanner (not one per condition):

```sql
join lateral (
  select b.open, b.high, b.low
  from md.market_bar b
  where b.instrument_id = s.instrument_id
    and b.timeframe = s.timeframe
    and b.bucket_start = s.as_of_bucket
) bar on true
```

resolved through the `md.market_bar` primary key, so the join is an index probe per instrument, not a
scan. The fragments are:

- `OPEN_EQUALS_LOW {tolerance_ticks}` → `bar.open <= bar.low + $n::numeric * i.tick_size`
- `OPEN_EQUALS_HIGH {tolerance_ticks}` → `bar.open >= bar.high - $n::numeric * i.tick_size`
- `GAP_UP {min_pct}` → `s.prev_close is not null and (bar.open - s.prev_close) / s.prev_close * 100 >= $n`
- `GAP_DOWN {min_pct}` → `s.prev_close is not null and (bar.open - s.prev_close) / s.prev_close * 100 <= -$n`

With `tolerance_ticks = 0` the equality is exact on `numeric(18,4)`, which is correct because `open` and
`low` come from the same feed at the same precision. The tolerance exists because some vendors publish a
low one tick below the open on a zero-range day.

**`MTF_ALIGN`** joins a second `an.indicator_snapshot` row on `(instrument_id, timeframe = $other)`.
This doubles the scan's row count and is the only condition allowed to do so. It is capped at one
`MTF_ALIGN` per scanner — two would generate a 3-way join over 6 M rows and blow the statement timeout
silently. The validator rejects a second one with `SCANNER_MTF_LIMIT_EXCEEDED`.

**`ZIGZAG_RETRACE_NEAR`** reads `extra->'zigzag'`, which §3.1 says is display-only. It is included
here because it operates on the snapshot row's own JSON, not on a join, and it is bounded by a `jsonb`
key lookup the planner resolves per row. It is the one documented exception to "extra is not queryable",
and it is not indexable — a scanner using it always performs a full universe scan, which the compiler
records in `explain_plan`.

### 8.4 Universe resolution

| `universe.type` | Resolution |
|---|---|
| `GROUP` | `join ref.market_group_member m on m.instrument_id = s.instrument_id and m.group_id = (select id from ref.market_group where code = $code) and m.added_on <= $as_of and (m.removed_on is null or m.removed_on > $as_of)` |
| `INDEX` | Same, via `ref.index_membership` on the index instrument (`effective_from` / `effective_to`) |
| `INSTRUMENTS` | `where s.instrument_id = any($ids::uuid[])`, capped at 5,000 ids |
| `ALL` | `join ref.instrument i on i.id = s.instrument_id where i.status = 'ACTIVE' and i.exchange_id = (…) and i.instrument_type = $t` |

All four apply the instrument-status filter (`ACTIVE`, not future-delisted) and exclude
`is_synthetic = true` instruments by default, because scanning the GS Composite for "RSI below 30" and
getting a synthetic row in the results is confusing. A `universe.include_synthetic = true` flag opts in.

An empty resolved universe fails the run with `SCANNER_UNIVERSE_EMPTY` rather than returning zero
matches. A user whose group code was mistyped must see an error, not "no stocks matched", which reads
as a market fact.

### 8.5 Compilation

```ts
interface CompiledScanner {
  sql: string;            // parameterised, no interpolation of user values
  params: unknown[];
  usedIndexes: string[];
  warnings: ScannerWarning[];
}
```

Compilation steps:

1. Validate the tree against the registry (types, params, ranges, nesting depth ≤ 6, node count ≤ 25).
2. Resolve the universe to a SQL fragment.
3. Walk the tree, emitting each condition's fragment with bound parameters appended to `params`.
4. Join the tree with `op` at each level, wrapping in parentheses.
5. Append the timeframe, `params_hash`, and staleness predicates.
6. Append `ORDER BY` and `LIMIT`.
7. `EXPLAIN (FORMAT JSON)` the statement once, store it in `scanner_run.explain_plan`, and warn if any
   sequential scan appears on `md.market_bar` or `an.indicator_value`.

Nesting is capped at depth 6 and 25 nodes because the compiled predicate depth directly determines
planning time, and a 200-node tree makes `EXPLAIN` itself take longer than the scan.

Identifier whitelisting: `sma_{period}` is produced by a lookup table `{20: 'sma_20', 50: 'sma_50',
200: 'sma_200'}`, never by string interpolation of a user-supplied number. A `period` outside the map
fails validation with `SCANNER_PARAM_INVALID`. This is the only place where a column name is chosen at
run time, and it is chosen from a frozen map.

### 8.6 Null semantics

SQL's three-valued logic would silently drop rows on `NULL` comparisons in `OR` branches, producing
results that look plausible and are wrong. Two rules fix that:

1. **Every leaf fragment is null-safe.** Each condition's SQL begins with an explicit
   `s.<col> is not null and …`, so a `NULL` indicator yields `false`, not `NULL`.
2. **`OR` is compiled as `(a) or (b)` over already-boolean fragments**, never as
   `coalesce(a, false) or coalesce(b, false)` — the guards in rule 1 make the coalesce unnecessary and
   the guards are cheaper.

The consequence is that an instrument with insufficient history never matches any scanner, even an `OR`
scanner where one branch is satisfiable. That is the correct behaviour: an instrument whose
`rsi_14` is unknown has not satisfied "RSI below 30", and pretending otherwise would put it in a
watchlist where the user expects a specific condition to hold.

`insufficient_history` instruments are counted in `explain_plan.null_excluded` per condition, so a
scanner that matches nothing because 80 % of the universe lacks 200 bars of history is diagnosable in
one click instead of an hour of confusion.

### 8.7 System scanners

System scanners (`is_system = true`) are seeded in Phase 12 from a versioned seed file and are
read-only. Each is defined entirely by its JSON, so a user can clone one and see exactly how it works.

| `code` | Name | Timeframe | Condition tree (root `AND`) |
|---|---|---|---|
| `SYS_52W_HIGH_BREAKOUT` | 52-week high breakout | `1D` | `NEW_52W_HIGH`, `VOLUME_SPIKE {multiple: 1.5, reference: AVG_20}` |
| `SYS_52W_LOW_BREAKDOWN` | 52-week low breakdown | `1D` | `NEW_52W_LOW`, `VOLUME_SPIKE {multiple: 1.5, reference: AVG_20}` |
| `SYS_NEAR_52W_HIGH` | Within 3 % of 52-week high | `1D` | `NEAR_52W_HIGH {within_pct: 3}` |
| `SYS_VOLUME_SPIKE` | Volume spike | `1D` | `VOLUME_SPIKE {multiple: 3.0, reference: AVG_20}`, `CLOSE_ABOVE_SMA {period: 50}` |
| `SYS_GOLDEN_CROSS` | Golden cross (50/200) | `1D` | `SMA_CROSS_ABOVE {fast: 50, slow: 200}`, `ADX_ABOVE {value: 20}` |
| `SYS_DEATH_CROSS` | Death cross (50/200) | `1D` | `SMA_CROSS_BELOW {fast: 50, slow: 200}`, `ADX_ABOVE {value: 20}` |
| `SYS_OPEN_EQ_LOW` | Open equals low | `1D` | `OPEN_EQUALS_LOW {tolerance_ticks: 0}`, `VOLUME_SPIKE {multiple: 1.2, reference: AVG_20}` |
| `SYS_OPEN_EQ_HIGH` | Open equals high | `1D` | `OPEN_EQUALS_HIGH {tolerance_ticks: 0}` |
| `SYS_OVERSOLD_UPTREND` | Oversold in an uptrend | `1D` | `CLOSE_ABOVE_SMA {period: 200}`, `RSI_BELOW {value: 35}` |
| `SYS_BREAKOUT_52W_MTF` | 52-week breakout confirmed weekly | `1D` | `NEW_52W_HIGH`, `MTF_ALIGN {other_timeframe: "1W", rule: "UP_TREND"}` |
| `SYS_RENKO_BULL_REVERSAL` | Renko bullish reversal | `1D` | `RENKO_REVERSAL {brick_pct: 1, reversal_bricks: 2, direction: "UP"}`, `CLOSE_ABOVE_SMA {period: 50}` |
| `SYS_RENKO_BEAR_REVERSAL` | Renko bearish reversal | `1D` | `RENKO_REVERSAL {brick_pct: 1, reversal_bricks: 2, direction: "DOWN"}`, `CLOSE_BELOW_SMA {period: 50}` |
| `SYS_RENKO_5_UP` | Five consecutive up bricks | `1D` | `RENKO_CONSECUTIVE {brick_pct: 1, count: 5, direction: "UP"}` |
| `SYS_SQUEEZE_EXPANSION` | Volatility squeeze | `1D` | `BB_SQUEEZE {max_bandwidth_pct: 4}`, `ATR_PCT_BELOW {value: 2}` |
| `SYS_DELIVERY_ACCUMULATION` | High-delivery accumulation | `1D` | `DELIVERY_ABOVE {value: 60}`, `CHANGE_PCT_ABOVE {value: 1}`, `VOLUME_SPIKE {multiple: 1.5, reference: AVG_20}` |
| `SYS_MTF_UPTREND` | Multi-timeframe uptrend | `1D` | `CLOSE_ABOVE_SMA {period: 200}`, `MTF_ALIGN {other_timeframe: "1W", rule: "ABOVE_SMA200"}` |
| `SYS_BREADTH_THRUST` | Breadth thrust | `1D` | `BREADTH_ABOVE {group_code: "NIFTY500", brick_pct: 1, value: 75}` |
| `SYS_INTRADAY_MOMENTUM` | Intraday momentum | `15m` | `CLOSE_ABOVE_SMA {period: 50}`, `RSI_ABOVE {value: 60}`, `VOLUME_SPIKE {multiple: 2.0, reference: AVG_20}` |

`SYS_BREADTH_THRUST` is unusual: its condition is a market-wide fact, not an instrument fact, so every
instrument in the universe matches or none does. It exists as a scanner because the dashboard's
"breadth thrust" tile is backed by a scanner run, and having one execution path for "show me the
matching instruments" avoids a second, divergent code path for a tile. The result list is the universe;
the UI renders the count, not the list.

### 8.8 Validation and error codes

| Code | When |
|---|---|
| `SCANNER_CONDITION_INVALID` | Unknown `type`, missing required param, or param outside its domain |
| `SCANNER_CONDITION_DEPTH_EXCEEDED` | Nesting deeper than 6 |
| `SCANNER_CONDITION_COUNT_EXCEEDED` | More than 25 nodes |
| `SCANNER_MTF_LIMIT_EXCEEDED` | More than one `MTF_ALIGN` |
| `SCANNER_TIMEFRAME_NOT_SCANNABLE` | `timeframe` outside `{15m,60m,75m,1D,1W,1M}` |
| `SCANNER_UNIVERSE_EMPTY` | Universe resolved to zero instruments |
| `SCANNER_UNIVERSE_TOO_LARGE` | `INSTRUMENTS` universe with more than 5,000 ids |
| `SCANNER_PARAM_INVALID` | Parameter of the right type but outside the allowed set (e.g. `period: 21`) |
| `SCANNER_TIMEOUT` | Statement exceeded `scanner.statement_timeout_ms` |
| `SCANNER_SNAPSHOT_STALE` | More than the configured fraction of the universe has a stale snapshot |

Validation happens on **write** (`POST`/`PUT` of a definition), so a broken scanner cannot be saved.
Compilation happens on **run**, because the universe may have changed. A definition that validated
yesterday can still fail to compile today if a referenced group was deleted; that is a
`SCANNER_CONDITION_INVALID` with `detail: "universe group not found"`.

### 8.9 Execution lifecycle

1. `POST /v1/scanners/:id/runs` (or the scheduler) inserts `scanner_run` with `status = 'QUEUED'`,
   `as_of = now()`, `correlation_id`, and an `idempotency_key` when supplied.
2. The worker claims the run, sets `RUNNING`, `started_at`.
3. Compile. On failure: `FAILED`, `error = {code, detail}`, `completed_at`.
4. `SET LOCAL statement_timeout = <config>`; execute.
5. Insert `scanner_run_result` rows with `rank` from the query's ordering, `values` = the predicate
   columns the user asked to display plus the matched indicator values.
6. Update `universe_count`, `matched_count`, `duration_ms`, `explain_plan`, `status = 'COMPLETED'`,
   `completed_at`.
7. Emit `scanner.run.completed` domain event.

`scanner_version` is copied onto the run so a historical result is attributable to the definition that
produced it, even after the definition is edited. Editing a definition increments `version` and never
touches past runs.

**Point-in-time limitation.** `an.indicator_snapshot` holds only the latest state, so a run at
`as_of = T` evaluates the snapshot as it exists *now*, not as it existed at `T`. `scanner_run.as_of`
records when the run happened; results are frozen in `scanner_run_result`. For a genuine historical
scan, Phase 12 exposes an internal replay mode that compiles the identical DSL against
`an.indicator_value` with `bucket_start <= T` — same registry, same compiler, different source table.
This is documented rather than pretended away: a user replaying last month's screen gets the replay
answer, clearly labelled, not a fabricated "as it would have been" from data that no longer exists.

### 8.10 Why not evaluate in TypeScript

Compiling to SQL lets PostgreSQL do the filtering over the indexed snapshot with `numeric` comparisons.
Pulling 2,000 × 13 indicator values into Node, evaluating in JS, and sending back matches would move
~26,000 values per scan and lose exact decimal comparison at the boundary — `numeric` to `number` to
`number` is where a `> 70` threshold starts disagreeing with the chart. The compiler is more code than
a JS evaluator, and it is the only version that keeps "the number the scanner used" and "the number the
chart shows" identical.

---

## 9. Pipeline orchestration

### 9.1 Job chain

The analytics pipeline is a chain of jobs. Each successor is enqueued by its predecessor's outbox event
(ADR-019), never by a wall-clock timer; the one scheduled entry point is `analytics.compute_rs`. The job
types, payloads, keys and retry policies are defined in `03` §5.3; this table states only the order.

| # | Job | Triggered by | Unit of work (one job per) | Typical duration |
|---|---|---|---|---|
| 1 | `ingestion.reconcile` | `batch.persisted` | import batch | 2–10 s |
| 2 | `marketdata.derive_timeframes` (intraday: `60m`/`75m`/`120m`/`240m` from `15m`) | `batch.completed` for an intraday batch | batch; per-instrument advisory lock inside | 20–60 s |
| 3 | `marketdata.derive_timeframes` (higher: `1W`/`1M`/`3M`/`1Y` from `1D`) | `batch.completed` for an EOD batch | batch; per-instrument advisory lock inside | 15–40 s |
| 4 | `marketdata.refresh_daily_snapshot` | `batch.completed` for an EOD batch | session date | 5–20 s |
| 5 | `marketdata.compute_52w_stats` | completion of 4 | session date | 10–30 s |
| 6 | `analytics.compute_indicators` | `bars.changed` from batch completion (`15m`, `1D`) and from 2–3 | instrument × timeframe | 20–80 ms each |
| 7 | `analytics.compute_indicator_snapshot` | `indicators.computed` and `stats52w.computed` | instrument × timeframe | 5–20 ms each |
| 8 | `analytics.compute_renko` | `bars.changed`, `corporate_action.applied` | brick set | 5–20 ms each |
| 9 | `analytics.compute_breadth` | `renko.rebuilt` | group × timeframe × brick % | 1–4 s |
| 10 | `analytics.compute_rs` | `job_schedule` post-EOD entry, after 4 | group × base × window | 0.2–2 s |
| 11 | `scanner.execute` (system scanners) | watermarks of 7, 8 and 9 current for the session | scanner run | 2–10 s each |

`marketdata.derive_timeframes` is a single job type with two payload shapes, because the derivation
code path is the same function over a different source timeframe — splitting it into two job types would
duplicate the retry policy, the idempotency key format, and the failure handling for no benefit.

Fan-out shape matters. Steps 1–5 are one job per batch or session date and process their instruments in
bounded batches inside the job. Steps 6–8 are **one job per (instrument, timeframe)** or **per brick set**,
serialised by the advisory locks of `03` §7.2, because one instrument's recompute is independent and a
failure affects one instrument rather than an exchange. Breadth (step 9) and RS (step 10) are one job per
group because they read across instruments. The unit of work is chosen so that a retry is cheap and a
failure is narrow.

### 9.2 Ordering guarantees the chain must preserve

- `1D` bars must be committed before `1W`/`1M`/`3M`/`1Y` are derived, or the weekly bar is built on a
  partial Friday.
- `indicator_value` must be complete through bucket *B* before `indicator_snapshot` is written for *B*,
  or the snapshot's `prev_*` columns are wrong.
- Renko must be rebuilt before breadth, or breadth reports yesterday's brick directions.
- `rs` has no Renko dependency and can run in parallel with 6 and 7. It depends only on `1D` closes and
  `ref.corporate_action`.
- System scanners run last, after every input they might reference is current.

A job whose predecessor failed is never enqueued, because its trigger is the predecessor's completion
event. The failed node is retried by the worker with the backoff of document `03` §5.2 and, after its
last attempt, dead-letters; the dataset's watermark stops advancing, which surfaces as pipeline lag
(AL-08, AL-14) and as staleness on `/readyz`. The chain never "runs anyway with what it has", because that is how a dashboard ends up showing today's price
next to yesterday's RSI with no indication that anything is wrong.

### 9.3 Late and out-of-order data

An EOD batch that arrives after the chain has already run for that session (a vendor correction at
11 p.m., or a re-import at 9 a.m. the next day) is handled by the **invalidation cascade** (§1.7), not
by re-running the whole chain. The corrected bars identify the affected instruments and buckets; only
those instruments' indicator series, snapshots, Renko sets, and the affected groups' breadth and RS are
recomputed.

The cascade is idempotent: running it twice for the same correction produces the same final state and
the same `revision` on Renko sets (because the rebuild is triggered by the bar's `updated_at`, which
does not change on the second run).

### 9.4 Backfill

A backfill of *n* years for *m* instruments is expressed as a normal job with a wider `from`/`to`. It is
chunked by month so that each job stays inside the statement and memory budgets, and it writes the same
watermark rows as an incremental run. Backfill and live ingestion must not overlap for the same
`(instrument, timeframe, bucket_start)` — the ingestion advisory lock namespace (document `03` §7.2)
serialises them per instrument, so a backfill of RELIANCE cannot race a live RELIANCE bar.

### 9.5 Memory and batching

| Job | Batch size | Peak memory |
|---|---|---|
| `derive-intraday` / `derive-higher` | 500 instruments × 1 session | ~8 MB |
| `indicator-series` | 200 instruments × 5,000 buckets | ~120 MB |
| `indicator-snapshot` | 500 instruments × 550 buckets (200 warm-up + 350) | ~90 MB |
| `stats-52w` | 1,000 instruments × 252 buckets | ~40 MB |
| `renko` | 1 instrument × full history | ~2 MB |
| `breadth` | 1 group × 1 session (lateral latest-brick per member) | ~15 MB |
| `rs` | 1 group × 1 window | ~6 MB |

The indicator batch size is 200, not 2,000, because a 2,000 × 5,000 `Decimal` series array is ~1.2 GB,
which exceeds the worker's heap and turns a routine run into an OOM kill at 2 a.m. Batching is capped by
a config value (`analytics.indicator_batch_size`) with a hard ceiling of 500.

---

## 10. Performance budgets and scaling

### 10.1 Budgets (single VPS, 8 vCPU / 16 GB, PostgreSQL co-located)

| Operation | p50 | p95 | Hard budget |
|---|---|---|---|
| Chart request, 500 `1D` bars + 3 overlays | 45 ms | 120 ms | 250 ms |
| Chart request, 2,000 `15m` bars + 3 overlays | 90 ms | 220 ms | 400 ms |
| Renko series, 300 bricks | 30 ms | 80 ms | 150 ms |
| RS matrix, 500 members × 4 windows | 110 ms | 260 ms | 400 ms |
| Breadth series, 250 sessions | 35 ms | 70 ms | 150 ms |
| Scanner run, 2,000-instrument universe, 3 conditions | 180 ms | 500 ms | 2 s (statement timeout 5 s) |
| Nightly full pipeline, 2,000 instruments, 11 timeframes | — | 18 min | 60 min |

The nightly budget is the constraint that decides whether this architecture survives contact with
reality: the chain must finish before the 08:00 IST market open with margin for one retry. 18 minutes
at 2,000 instruments leaves room for ~6,000 before the budget is breached, which is the documented
scale ceiling of the single-VPS deployment (`00-system-architecture.md` §9.2; `08` R-01).

### 10.2 Hot-path optimisations that are actually implemented

- **Watermark-based incremental computation.** A normal nightly run processes one new bucket per
  timeframe per instrument, not the full history. The `warmup_bars` replay is bounded by
  `max(200, 2 × longest indicator period)`, so `indicator-series` reads 550 buckets per instrument, not
  5,000.
- **`COPY` for bulk inserts.** Renko rebuilds and indicator backfills use
  `COPY … FROM STDIN` into an unlogged staging table followed by `INSERT … SELECT … ON CONFLICT`,
  which is 5–10× faster than row-by-row inserts and keeps the transaction short.
- **Snapshot as the scanner's only input.** A 3-condition scan touches one index scan on
  `ix_indicator_snapshot_scan` plus one hash join to membership, not 13 joins.
- **Pre-computed `prev_*` columns.** Cross conditions (`SMA_CROSS_ABOVE`) are a two-column comparison
  on one row instead of a window function over the series.
- **Partition pruning.** Any chart query with a `bucket_start` range prunes to the relevant monthly
  partitions; a 500-bar daily request touches 3 partitions, not 60.

### 10.3 What is deliberately not optimised

- No in-memory cache of indicator values. A cache would need invalidation on every correction, and a
  stale cache serving a wrong RSI is the failure mode this platform exists to avoid. The database is
  the cache; the snapshot table already is the pre-computed layer.
- No parallel query across workers for a single instrument's series. Indicators are recursive; splitting
  a series across processes requires communicating the seeded state, which costs more than it saves at
  these sizes.
- No columnar store. 20 M bricks and 60 M indicator values fit comfortably in PostgreSQL with the
  indexes in document `02` §10; adding a columnar engine would add an operational surface with no
  measured benefit at the documented ceiling.

### 10.4 Scaling triggers

| Symptom | Threshold | Response |
|---|---|---|
| Nightly pipeline | > 45 min for 3 consecutive nights | Raise `indicator_batch_size`, then add a second worker container |
| Snapshot scan latency | p95 > 1 s for 3 conditions | Add a partial index for the specific condition pair; if a third index is needed, consider a covering index on `(timeframe, params_hash, instrument_id)` |
| Chart query | p95 > 300 ms | Check partition pruning; the most likely cause is a missing `bucket_start` predicate |
| Renko rebuild | > 15 min for a full-universe rebuild | Batch size or `COPY` path; a full rebuild is an operational event, not routine |
| Database CPU | sustained > 70 % during market hours | Read replica for chart reads, then split `worker` onto its own host |

Adding a read replica is the first structural change, because chart reads and the analytics pipeline
contend for the same buffer cache. It is documented as the trigger for the first move away from the
single-host deployment, and it does not require a code change — the API's read lane already routes
through a single `pg.Pool` that can be pointed at a replica for read-only queries.

---

## 11. Correctness verification

Market-data correctness outranks every other property. The verification below is not optional test
coverage; each item is an acceptance gate for the phase that introduces it.

### 11.1 Golden vectors

Every indicator ships with a hand-computed vector file in `packages/engines/test/golden/`, with the
values shown in §3. Each vector asserts to 6 dp with an explicit tolerance of `0` when the arithmetic is
exact (`SMA`, `BB middle`) and `1e-9` when a square root or division is involved. A formula change that
alters any golden value fails CI, which is the point.

The vectors cover, at minimum: `SMA`, `EMA`, `RSI` (including the flat-series case), `TR`/`ATR`, `ADX`
with both DIs non-zero, `BB`, `AVG_VOLUME`, `STATS_52W` (including the 60-bar minimum), and Renko
(including multi-brick bars, reversal groups, and the one-tick floor).

### 11.2 Property tests

| Property | Test |
|---|---|
| SMA of a constant series equals the constant | random `c`, random `n` |
| EMA of a constant series equals the constant (after seed) | random `c`, random `n` |
| RSI is always in `[0, 100]` | 10,000 random walks |
| `BB lower <= middle <= upper` | 10,000 random walks |
| `ATR >= 0`, `ADX ∈ [0, 100]`, `DI ∈ [0, 100]` | 10,000 random walks |
| Aggregating `15m` → `60m` then summing to `1D` equals direct `1D` aggregation of the same `15m` bars | for `open` of first, `close` of last, `high`/`low` extremes, `volume` sum |
| Renko `seq` is contiguous `1..n` | every rebuild |
| Renko brick `close − open` equals `±brick_size` exactly | every brick |
| Renko directions never repeat after a reversal without at least `reversal_bricks` bricks | every set |
| Renko `is_reversal` implies direction change | every set |
| Rebuilding twice produces identical bricks | every rebuild (determinism gate) |
| `positive_bricks + negative_bricks + unchanged_bricks = eligible_members` | every breadth row |
| RS ranks are a permutation of `1..scored_count` | every snapshot |

The `15m` → `60m` → `1D` composition property is the one that catches the most real bugs, because it
crosses the session-anchoring and partial-bucket boundary. It is run against the deliberately defective
seed data from document `02` §9 so it exercises missing bars too.

### 11.3 Database invariants (nightly verifier)

```sql
-- INV-D1: only ingestion writes ingestion-owned timeframes, only the engine writes derived ones
-- Synthetic instruments are excluded from the second arm: their 1D series is engine-written by INV-D2,
-- so counting it here would make INV-D1 and INV-D2 contradict each other and fire every night.
select 'inv_d1a', count(*) from md.market_bar
 where timeframe in ('60m','75m','120m','240m','1W','1M','3M','1Y') and import_batch_id is not null
union all
select 'inv_d1b', count(*) from md.market_bar b
  join ref.instrument i on i.id = b.instrument_id
 where b.timeframe in ('15m','1D') and b.import_batch_id is null and not i.is_synthetic;

-- INV-D2: synthetic instruments are the only engine-written 1D series
select 'inv_d2', count(*) from md.market_bar b
  join ref.instrument i on i.id = b.instrument_id
 where b.timeframe = '1D' and b.import_batch_id is null and not i.is_synthetic;

-- INV-D3: no derived bar exists for a session with no source bars
select 'inv_d3', count(*) from md.market_bar d
 where d.timeframe = '1W'
   and not exists (select 1 from md.market_bar s
                    where s.instrument_id = d.instrument_id
                      and s.timeframe = '1D'
                      and s.session_date between d.bucket_start::date and d.session_date);

-- INV-D4: brick_count matches the row count
select 'inv_d4', count(*) from an.renko_brick_set s
 where s.brick_count <> (select count(*) from an.renko_brick b where b.brick_set_id = s.id);

-- INV-D5: snapshot as_of_bucket is never ahead of its indicator series
select 'inv_d5', count(*) from an.indicator_snapshot sn
  join an.analytics_watermark w
    on w.instrument_id = sn.instrument_id and w.timeframe = sn.timeframe and w.dataset = 'INDICATORS'
 where sn.as_of_bucket > w.computed_through;
```

A non-zero result on any of these is a `CRITICAL` alert with a runbook entry, not a log line. `INV-D4`
in particular catches the most damaging class of bug: a header that claims 412 bricks while 411 exist,
which makes every downstream reader that trusts the header disagree with every reader that counts.

### 11.4 Cross-checks against external truth

| Check | Frequency | Tolerance |
|---|---|---|
| Random 20 instruments' `1D` close vs exchange official close | nightly | exact |
| Random 20 instruments' `1D` volume vs official volume | nightly | exact |
| `pct_from_high_252` for 20 instruments vs a vendor's stated 52-week high | weekly | ≤ 0.01 % |
| `rsi_14` for 20 instruments vs a vendor's published value | weekly | ≤ 0.05 absolute |
| Breadth `1 %` for NIFTY50 vs hand-counted from 50 charts | monthly, manual | exact |

The indicator cross-checks are tolerance-based because vendors differ on seeding and on whether the
current bar is included. A difference larger than the tolerance indicates a real divergence — usually a
seed or warm-up difference — and is investigated rather than explained away.

### 11.5 Determinism gate

The pipeline is run twice against an identical database snapshot in CI, and the resulting
`an.indicator_value`, `an.indicator_snapshot`, `an.renko_brick`, `an.breadth_snapshot`, and
`an.rs_value` tables are compared row-by-row with `EXCEPT`. Any difference fails the build. This catches
accidental use of `Date.now()`, unordered iteration, and hash-map ordering leaking into output — the
three ways a pure function stops being pure.

---

## 12. Change management

### 12.1 Engine version constants

```ts
// packages/engines/src/versions.ts
export const AGGREGATION_VERSION = 'agg/v1';
export const INDICATORS_VERSION  = 'ind/v1';
export const RENKO_VERSION       = 'renko/v1';
export const BREADTH_VERSION     = 'breadth/v1';
export const RS_VERSION          = 'ratio-of-returns/v1';
export const ZIGZAG_VERSION      = 'zigzag/v1';
```

`RS_VERSION` matches `an.rs_snapshot.methodology_version`'s default and is written on every snapshot.
The others have no column of their own; they are exposed at `/healthz` in the build descriptor and
recorded in the `audit.audit_event` payload whenever a recompute run is initiated. A version mismatch
between the running code and the value recorded in the last recompute audit entry is the signal that a
deploy changed a formula without the recompute step.

### 12.2 Changing an indicator formula

1. Change the code and bump the constant.
2. Run the golden vectors. If a golden value changes and the change is intended, update the vector in
   the same commit with a note explaining the difference.
3. If the parameter set of the **standard** indicators changed, compute the new `params_hash` and add a
   migration that resets all `an.analytics_watermark` rows for `dataset = 'INDICATORS'` and
   `dataset = 'SNAPSHOT'`.
4. Deploy with the pipeline paused. The worker's startup check refuses to run analytics jobs when
   `INDICATORS_VERSION` differs from the version recorded in `ops.runtime_flag` (a one-row table, set by
   the deploy).
5. Run the full recompute: `derive-*` then `indicator-series` then `snapshot` then `renko` then
   `breadth` then `rs`.
6. Verify with §11.3 and §11.4.
7. Flip `ops.runtime_flag` and resume.

For a non-standard indicator (one only used by charts), no recompute of the standard set is needed — a
`params_hash` change produces new rows in `an.indicator_value` and the old ones are left in place until
the retention window expires, which is correct because nothing else reads them.

### 12.3 Changing the Renko algorithm

Renko has no version column, so a formula change is detected by the `RENKO_VERSION` constant and
requires the rebuild-all flag. The rebuild is a full delete-and-reinsert per set with `revision + 1`;
because `revision` is visible in the API response, a client that holds bricks across a deploy can see
that the series was rewritten.

### 12.4 Changing the RS methodology

A new `methodology_version` string (for example `ratio-of-returns/v2`) is written on all new snapshots.
Old snapshots keep their old string. The matrix API returns the version it used, and the UI shows it in
the footer. Two versions coexist in the table; there is no migration and no data loss. The default is
switched by a config value, and the switch is audited.

### 12.5 Scanner definition edits

Edits increment `version` and never rewrite history. Past runs keep their `scanner_version` and their
frozen `scanner_run_result` rows. A user comparing "what this screen returned last week" with "what it
returns now" is comparing two real things, not a mutated single thing.

---

## 13. Decisions recorded in this document

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D-04-01 | `decimal.js` at precision 28, single rounding at persistence | `float64`, scaled `BigInt` | Reproducible across surfaces; no scale-agreement bugs |
| D-04-02 | Session-anchored intraday buckets | Wall-clock round-hour buckets | Every bar would otherwise mix real durations |
| D-04-03 | `1D` is ingestion-owned, never derived | Derive `1D` from `15m` | Official close ≠ minute-derived close; two writers oscillate |
| D-04-04 | Higher-timeframe bars upserted as `is_partial` during the period | Write only at period close | A chart that stops at last Friday looks broken |
| D-04-05 | Fixed wide `indicator_snapshot` | EAV indicator store | Scanner compiles to one index scan, not N joins |
| D-04-06 | EMA seeded with SMA | Seed with first close | Removes arbitrary-start dependence |
| D-04-07 | Wilder RSI/ATR/ADX recursions | EMA-style smoothing | Matches every published threshold calibration |
| D-04-08 | RSI = 50 on a flat series | 0 or 100 | 0/100 would fire every threshold scanner on a halted, flat stock |
| D-04-09 | Bollinger population stdev | Sample stdev | Matches the reference chart users compare against |
| D-04-10 | 52-week = 252 buckets | 365 calendar days | 365 days is ~247 sessions; a 2 % window error |
| D-04-11 | 52-week minimum 60 sessions | Emit from 1 session | A 12-session-old listing would trigger every breakout |
| D-04-12 | ZigZag on complete bars, last pivot provisional | Include the developing bar | Repainting history actively misleads |
| D-04-13 | Renko brick size fixed at anchor | Percentage of current price | Otherwise the series is not reproducible |
| D-04-14 | `is_reversal` on the first brick of a reversal group only | On every brick in the group | Reversal counts must equal trend changes |
| D-04-15 | Brick identity `(set, seq)` | `(set, timestamp)` | Multiple bricks legitimately share one source bar |
| D-04-16 | Breadth from Renko brick direction | Advances/declines count | "How many constituents are in an uptrend" is actionable; daily A/D whipsaws |
| D-04-17 | Breadth excludes halted members | Count halted as unchanged | Counting them dilutes breadth on the volatile days it matters |
| D-04-18 | RS = ratio of returns | Ratio of raw prices | Scale-free, zero-parity, comparable across windows |
| D-04-19 | RS `ADJUSTED` = splits/bonus only | Include dividends | Prices are price returns; dividend adjustment is a separate methodology |
| D-04-20 | Ordinal ranking, no ties | Competition/dense ranking | `uq_rs_value_rank` cannot represent ties |
| D-04-21 | Leaders = `max(1, ceil(0.1n))` | Fixed top-10 | Small sectors would otherwise have no leaders |
| D-04-22 | GS Composite defined as an equal-weighted synthetic rebased series | Treat "GS Composite" as an external index | The term has no standard published definition; inventing a number and calling it official is worse |
| D-04-23 | Scanner conditions compiled to SQL | Evaluate in TypeScript | Keeps the number the scanner used identical to the number the chart shows |
| D-04-24 | Null-safe leaf predicates | Rely on SQL three-valued logic | `OR` branches would silently drop rows |
| D-04-25 | Scanner timeframes restricted to 6 | Allow all 10 | 4-hour and yearly bars mix partial buckets unexplainably |
| D-04-26 | Frozen scanner results + documented point-in-time replay | Claim historical reproducibility from the snapshot | The snapshot only holds the latest state; pretending otherwise is a lie |
