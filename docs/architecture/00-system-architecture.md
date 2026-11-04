# 00 — System Architecture

Status: **APPROVED BASELINE (Phase 0)**. Changes require an ADR amendment in §6.

---

## 1. Purpose and scope

TradeSoft is an end-of-day-first market analysis platform for Indian exchanges. It ingests daily and
intraday OHLCV plus delivery and open-interest data, normalises it into a canonical bar store, derives
timeframes, computes indicators, Renko brick series, breadth and relative-strength matrices, runs
configurable multi-timeframe scanners, and serves charts and dashboards over a versioned REST API.

**In scope for v1:** NSE, BSE, MCX, NCDEX, NFO instruments; EOD and intraday CSV ingestion; vendor REST
ingestion where a licensed source exists; all analytical features listed in the product brief;
single-tenant deployment.

**Explicitly out of scope for v1** (architected for, not built): real-time streaming, order execution,
portfolio accounting, broker integration, multi-tenant SaaS, mobile native apps, options analytics
beyond storing contract bars, automated trading signals delivery to third parties.

---

## 2. Assumptions

Every assumption below is a decision, not a question. If one is later proven wrong, the affected section
is revised and the change is recorded as an ADR amendment.

| ID | Assumption | Consequence if wrong |
|---|---|---|
| A1 | Single-tenant: one deploying organisation, one logical `workspace`. No `tenant_id` columns. | Adding tenancy means a schema-wide column plus Postgres RLS. Deferred deliberately; speculative tenancy columns are worse than a later migration. |
| A2 | ~10,000 active instruments, ~250 trading days/year, 10 years of daily history, 3 years of 15-minute history. | Storage and partition sizing in `02` §12 and §9.1 below revise; partitioning is already in place so growth is additive. |
| A3 | 50 named users, ≤20 concurrent, ≤50 API requests/second sustained. | Vertical scaling first; the horizontal path is documented and does not require redesign. |
| A4 | Indian exchanges only. Asia/Kolkata is UTC+05:30 with **no DST**, permanently. | Session-date logic stays correct, but any future market with DST requires the timezone-aware session resolver that already exists in `trading_calendar`. |
| A5 | EOD is the correctness anchor. Intraday is derived or separately sourced and may be incomplete. | Daily bars are the only timeframe guaranteed complete; every analytics job declares whether it tolerates gaps. |
| A6 | No licensed real-time feed in v1. A broker feed may be added later. | The `MarketDataPort` abstraction and the `domain_event` outbox already accommodate it (DIAGRAM 12). |
| A7 | Corporate actions are supplied as reference data (CSV or manual entry), not inferred. | Inferred actions would require a heuristic detector; deliberately excluded because silent inference corrupts history. |
| A8 | Exchange session times, holidays and special sessions are **data**, maintained in `trading_calendar`, never hardcoded. | No code change for a Muhurat session or an exchange circular. |
| A9 | A single-region deployment in India is acceptable; RPO 15 min, RTO 2 h. | Cross-region replication changes the deployment doc, not the architecture. |
| A10 | Users are trusted staff, not anonymous public internet users. Authorisation is still enforced server-side without exception. | Public exposure would require WAF, CAPTCHA, per-IP quotas and abuse review — noted as a hardening increment. |
| A11 | The **GS Composite** used in the RS matrix is a synthetic instrument: an equal-weighted index of configured gold and silver proxy instruments, held as a `ref.instrument` row with `is_synthetic = true`. Its bars are computed by the analytics engine and never imported. | If a vendor supplies a composite series instead, its bars become ingestion-written and the single exception in INV-D2 disappears; the RS matrix reads it through the same instrument key either way, so nothing downstream changes. Definition and membership handling: `04` §7.8. |

**A5 is operationalised by a rule, not by convention.** Which timeframe is authoritative for which source is
fixed by the **bar ownership matrix** in `04` §1.4: `15m` and `1D` are ingestion-written and authoritative,
`60m`/`75m`/`120m`/`240m` are derived from `15m`, and `1W`/`1M`/`3M`/`1Y` are derived from `1D`. Two invariants
protect it: **INV-D1** — every derived bar has `import_batch_id IS NULL`, so a derived row can never be mistaken
for imported data; **INV-D2** — only the engine may write a `1D` bar, and only for an instrument with
`is_synthetic = true` (A11). `04` §1.4 states the enforcement points.

---

## 3. Actors

| Actor | Type | Description | Primary surfaces |
|---|---|---|---|
| Anonymous visitor | Human, unauthenticated | Reaches only the login page and `/healthz`. | Login |
| Viewer | Human, authenticated | Read-only consumption of dashboards, charts, sectors, breadth, RS matrices, published scanners. Owns private saved views. | Dashboard, Markets, Charts, Renko, Sectors, Breadth, RS Matrix, Scanners (read) |
| Analyst | Human, authenticated | Everything a Viewer can do, plus authoring scanner definitions, dynamic groups, running ad-hoc scans, submitting imports, correcting reference data. | All analytical surfaces, Data Management |
| Administrator | Human, authenticated | Full control: users, roles, settings, audit, job operations, ingestion approval, destructive reference-data changes. | Admin, Audit, Jobs, Settings |
| Ingestion service | Machine principal | API-key holder used by scheduled vendor pulls or an external scheduler. Narrow scope: submit and read imports. | `POST /ingestion/*` |
| Scheduler | System actor | Singleton process that converts due `job_schedule` rows into queued jobs. Holds a Postgres advisory lock so only one instance is active. | Internal only |
| Worker | System actor | Claims and executes jobs. Scale-out safe via `FOR UPDATE SKIP LOCKED`. | Internal only |
| Operations engineer | Human, privileged | Deploys, migrates, inspects metrics and logs. Interacts with the host and the admin job API; does not read market data through privileged SQL in normal operation. | Host, `/metrics`, `/admin/jobs` |

A user may hold multiple roles; effective permissions are the union. There is no implicit superuser: the
`ADMIN` role is granted `*` explicitly through `role_permission` rows so the matrix is auditable.

---

## 4. Roles and permissions

Permission codes are `resource:action[:qualifier]`. They are seeded rows, never string literals in
handlers. Handlers declare a required permission; a central guard resolves it from the authenticated
principal's cached role set.

### 4.1 Permission catalogue

| Code | Meaning |
|---|---|
| `auth:self:manage` | Change own password, list and revoke own sessions |
| `user:read` / `user:write` / `user:deactivate` | User administration |
| `role:read` / `role:write` | Role and permission administration |
| `apikey:manage` | Issue and revoke machine credentials |
| `exchange:read` | Exchange and calendar read |
| `calendar:write` | Maintain trading calendar and special sessions |
| `instrument:read` / `instrument:write` | Instrument reference data |
| `sector:read` / `sector:write` | Sector and industry hierarchy |
| `group:read` / `group:write` / `group:share` | Market groups, including dynamic groups |
| `marketdata:read` | Bars, snapshots, 52-week statistics |
| `marketdata:correct` | Apply a correction batch; requires justification text, always audited |
| `ingestion:read` / `ingestion:submit` / `ingestion:retry` / `ingestion:reconcile` | Import lifecycle |
| `analytics:read` | Indicator and derived-series reads |
| `analytics:recompute` | Enqueue a scoped recompute of derived analytics; always audited, never granted to read-only roles |
| `breadth:read` | Breadth series |
| `rs:read` | RS matrix and rankings |
| `chart:read` | Chart data endpoints |
| `dashboard:read` | Dashboard aggregates |
| `scanner:read` / `scanner:write` / `scanner:execute` / `scanner:share` | Scanner lifecycle |
| `job:read` / `job:retry` / `job:cancel` | Job operations |
| `audit:read` | Business audit trail |
| `security:read` | Security event trail |
| `settings:read` / `settings:write` | Runtime configuration |
| `dataquality:read` | Data-quality findings |
| `dataquality:write` | Resolve or waive a finding; always audited. Deliberately separate from `marketdata:correct` so that acknowledging a warning does not require price-mutation rights. |

### 4.2 Role matrix

| Permission group | VIEWER | ANALYST | ADMIN | INGEST_SERVICE |
|---|---|---|---|---|
| `auth:self:manage` | yes | yes | yes | no |
| `user:*`, `role:*`, `apikey:manage` | no | no | yes | no |
| `exchange:read`, `instrument:read`, `sector:read`, `group:read` | yes | yes | yes | yes |
| `calendar:write`, `instrument:write`, `sector:write` | no | yes | yes | no |
| `group:write` | no | yes | yes | no |
| `group:share` | no | yes | yes | no |
| `marketdata:read`, `analytics:read`, `breadth:read`, `rs:read`, `chart:read`, `dashboard:read`, `dataquality:read` | yes | yes | yes | no |
| `marketdata:correct` | no | no | yes | no |
| `dataquality:write` | no | yes | yes | no |
| `analytics:recompute` | no | no | yes | no |
| `ingestion:read` | no | yes | yes | yes |
| `ingestion:submit` | no | yes | yes | yes |
| `ingestion:retry`, `ingestion:reconcile` | no | yes | yes | no |
| `scanner:read` | yes | yes | yes | no |
| `scanner:write`, `scanner:execute`, `scanner:share` | no | yes | yes | no |
| `job:read` | no | no | yes | no |
| `job:retry`, `job:cancel` | no | no | yes | no |
| `audit:read`, `security:read`, `settings:read`, `settings:write` | no | no | yes | no |

`INGEST_SERVICE` is only ever attached to an API-key principal, never to a human login. A human account
with a password may not hold it.

Two cells in this matrix are deliberate and worth defending. `dataquality:write` sits with `ANALYST`
because investigating a finding *is* analytical work, and waiving a `WARN` is a judgement an analyst is
qualified to make; it does not confer any ability to change a price. `analytics:recompute` sits with
`ADMIN` only, because a rebuild is expensive, can invalidate published derived series for everyone, and is
the kind of operation whose misuse is measured in hours of worker time rather than a bad number in one
report.

### 4.3 Resource-level authorization

Role permission is necessary but not sufficient:

- `saved_view` and `scanner_definition` rows carry `owner_user_id`. Owners may modify and delete; others
  may read only when `is_shared = true` or `is_system = true`.
- `scanner_run` inherits the visibility of its definition at run time.
- `marketdata:correct` additionally requires a non-empty `justification` and writes an audit event with
  the before/after price rows.
- Machine principals are restricted to their key's `scopes` array, intersected with `INGEST_SERVICE`.

---

## 5. Domain modules

Modules are packages with an explicit public entrypoint. Cross-module access happens only through that
entrypoint and only in the direction shown in DIAGRAM 3. A package may not import another package's
`/internal/*` path; ESLint `no-restricted-imports` plus a CI graph check enforce this.

| Module | Owns | Public surface | Must not |
|---|---|---|---|
| **Identity & Access** | `app_user`, `role`, `permission`, `user_role`, `role_permission`, `auth_session`, `one_time_token`, `api_key` | `authenticate`, `issueSession`, `rotateSession`, `revokeFamily`, `authorize(principal, permission)`, `effectivePermissions` | Know about market data or charts |
| **Audit** | `audit_event`, `security_event`, hash chain | `record(event)`, `query(filter)`, `recordSecurity(event)` | Be bypassable: writes are fire-and-forget with at-least-once delivery to the DB |
| **Market Reference** | `exchange`, `trading_calendar`, `instrument`, `symbol_alias`, `sector`, `instrument_sector_membership`, `index_membership`, `corporate_action`, `market_group`, `market_group_member` | `resolveSymbol`, `getInstrument`, `tradingDays`, `sessionBounds`, `effectiveMembers`, `resolveGroup` | Store prices |
| **Market Data** | `market_bar`, `market_bar_history`, `bar_quality_issue`, `bar_adjustment_factor`, `instrument_daily_snapshot`, `instrument_stat_52w` | `MarketDataPort` (§5.1), `readBars`, `latestSnapshot`, `statistics52w` | Parse files; compute indicators |
| **Data Ingestion** | `data_source`, `import_file`, `import_batch`, `ingestion_reject` | `submitFile`, `pullSource`, `validateBatch`, `persistBatch`, `reconcileBatch` | Own bar storage schema; it writes through `MarketDataPort` |
| **Time-Series Engine** | Timeframe algebra, session bucketing, aggregation rules | `bucketFor(timeframe, instant)`, `aggregate(bars, timeframe)`, `alignToCalendar` | Touch the database |
| **Indicator Engine** | Pure mathematics | `compute(series, indicator, params) → (number \| null)[]` | Read clocks, files or DB |
| **Renko Engine** | Pure brick generation | `generate(bars, config) → Brick[]` | Persist anything |
| **Sector & Breadth** | Group resolution, eligibility, breadth aggregation | `resolveUniverse`, `computeBreadth` | Emit Renko bricks itself |
| **RS Matrix** | Ratio mathematics, ranking | `computeMatrix(input) → Matrix` | Fetch data itself |
| **Scanner** | Condition registry, JSON tree validation, SQL compilation | `compile(definition) → SqlFragment`, `run(...)` | Accept raw identifiers from clients |
| **Charting** | Series assembly, downsampling policy, overlay composition | `buildChartPayload(query)` | Compute indicators inline; it reads precomputed values |
| **Dashboard** | Aggregate read models | `summary(date)` | Recompute analytics |
| **Jobs** | `job`, `job_attempt`, `job_schedule` | `enqueue`, `claim`, `complete`, `fail`, `retry` | Contain domain logic |
| **Platform** | Config, logging, metrics, tracing, error mapping, correlation | Cross-cutting primitives | Import domain modules |

### 5.1 `MarketDataPort` — the seam that prevents a rewrite

```ts
export interface CanonicalBar {
  instrumentId: InstrumentId;
  timeframe: Timeframe;          // '15m' | '60m' | '75m' | '120m' | '240m' | '1D' | '1W' | '1M' | '3M' | '1Y'
  bucketStart: Instant;          // UTC
  sessionDate: IsoDate;          // exchange-local trading date
  open: Decimal; high: Decimal; low: Decimal; close: Decimal;
  volume: bigint;
  deliveryVolume: bigint | null;
  openInterest: bigint | null;
  turnover: Decimal | null;
  isPartial: boolean;
  sourceId: SourceId;
  revision: number;
}

export interface MarketDataPort {
  ingestBars(batch: CanonicalBarBatch, tx?: Transaction): Promise<IngestOutcome>; // idempotent, transactional
  getBars(query: BarQuery): Promise<BarSeries>;
  subscribeBars(sub: BarSubscription, sink: BarSink): Promise<Unsubscribe>; // v1: throws NotImplemented; v2: live
}
```

Every writer — CSV, vendor REST, future WebSocket — calls `ingestBars`. There is exactly one insert path
into `market_bar`, therefore exactly one place where validation, revision guarding, event emission and
audit apply. `subscribeBars` exists in v1 as a declared, typed, unimplemented capability so that the
live-data increment is additive.

---

## 6. Technology decisions

Format: **Why needed — Problem solved — Operational cost — Scaling — Failure — Alternative rejected.**
Only choices that are non-obvious or contested are recorded; universally obvious defaults are folded in.

### ADR-001 — Modular monolith, three processes, one codebase

- **Why:** the domain is heavily interconnected (a scanner reads indicators, which read bars, which
  depend on calendar and corporate actions). Distributing that across services in v1 buys nothing and
  costs distributed transactions.
- **Problem solved:** keeps every analytical read inside one Postgres transaction and one process,
  eliminating partial-failure states across a network boundary.
- **Operational cost:** one deployable artefact, three process roles, one database. Lowest possible.
- **Scaling:** `api` scales horizontally behind the proxy (stateless except in-process caches keyed by
  version). `worker` scales horizontally by job-claim contention. `scheduler` is a singleton guarded by
  an advisory lock. Vertical scaling covers the first ~10× of projected load.
- **Failure:** a crash affects one process role. `api` crash = requests fail over; `worker` crash = jobs
  are reclaimed on lock expiry; `scheduler` crash = new instance takes the advisory lock.
- **Alternative rejected:** microservices. Rejected because the only genuinely separable workloads
  (ingestion, analytics batch) are already separate *processes* with separate resource profiles; a
  network boundary would add failure modes and distributed-transaction complexity without adding
  isolation. Extraction triggers are documented in §9.3.

### ADR-002 — Node.js 24 LTS + TypeScript 5.x + Fastify

- **Why:** the same language for engines and UI contracts; the engines are numeric and CPU-light at EOD
  scale; a single `packages/contracts` package removes the API/UI type drift that dominates maintenance
  cost in trading dashboards.
- **Problem solved:** end-to-end type safety from SQL row → domain → JSON → React props, enforced at
  compile time and at runtime by the same Zod schemas.
- **Operational cost:** one runtime; no JVM warm-up; modest memory footprint (~250–400 MB per process).
- **Scaling:** Node is single-threaded per process. CPU-bound indicator batch work is partitioned by
  instrument ranges across worker processes, not by threads. Documented threshold: when a single
  analytics job exceeds ~60 s of CPU, split the job by instrument shard rather than reaching for workers.
- **Failure:** unhandled rejection policy is `process.exit(1)` with graceful drain; supervised restart.
  No request-level state survives a crash, by design.
- **Alternative rejected:** Laravel/PHP (present in the source brief) — would duplicate contract types
  across two languages and loses the shared-schema advantage; NestJS — DI container and decorator
  metadata add indirection without solving a problem we have, and its module system encourages anemic
  service classes rather than explicit composition; Go — better raw throughput, worse iteration speed
  for a numeric-heavy, schema-heavy product, and no shared contract layer with the React UI.

### ADR-003 — PostgreSQL 16 as the only stateful dependency

- **Why:** the workload is relational, transactional, and analytical. Postgres provides exact `numeric`,
  window functions, range partitioning, advisory locks, `FOR UPDATE SKIP LOCKED`, JSONB, full-text
  search, and `citext` — each of which removes a separate piece of infrastructure.
- **Problem solved:** eliminates Redis (job queue and rate limiting), a document store (scanner
  definitions as JSONB), and a search cluster (instrument search via trigram/`tsvector`).
- **Operational cost:** one service to back up, tune, monitor and upgrade.
- **Scaling:** vertical first (the projected dataset ~200M bars fits comfortably on a 16 GB instance with
  partitioning and a warm cache). Read replicas for chart traffic are the first horizontal step.
  Partition pruning keeps analytical scans bounded.
- **Failure:** single point of failure until a replica exists. Mitigated by 15-minute WAL archiving,
  nightly logical backups, and a rehearsed restore procedure. This is stated as a known risk (R-02).
- **Alternative rejected:** MongoDB — wrong for exact-decimal price arithmetic and multi-table
  transactional analysis; Redis as primary store — no durability guarantees we can defend; a separate
  time-series database (TimescaleDB/ClickHouse) — premature at this volume, and Postgres partitioning
  already delivers the required scan behaviour. TimescaleDB remains the documented escape hatch if bar
  volume grows 20×.

### ADR-004 — Two-lane data access: Drizzle for schema and CRUD, raw SQL for analytics

- **Why:** ORMs optimise for entity graphs; this product's hot path is `INSERT ... ON CONFLICT` batches,
  window functions, `DISTINCT ON` and partition-aware range scans. Forcing those through an ORM produces
  unreadable generated SQL and hides plan regressions.
- **Problem solved:** one typed schema definition (Drizzle, generated from the migrated database) drives simple
  queries, while migrations are the numbered SQL files of `02` §8, because partitions, triggers and deferred
  constraints are outside what a schema-diff generator expresses; and
  analytical SQL is written explicitly, reviewed, and `EXPLAIN`-checked in CI.
- **Operational cost:** two idioms. Contained by a written policy: any query with a window function, a
  CTE, or a `DISTINCT ON` is raw SQL and lives in `packages/db/sql/`; everything else uses the typed
  builder.
- **Scaling:** raw SQL is where index and plan control matter, so the important queries are the
  controllable ones.
- **Failure:** schema drift between Drizzle definitions and hand-written SQL. Mitigated by a CI test that
  runs every raw SQL file against a migrated database and fails on unknown columns.
- **Alternative rejected:** Prisma — its query engine binary, weak partitioning support, and awkward raw
  SQL make it a poor fit for this workload; full manual SQL everywhere — loses typed schema
  single-sourcing and migration generation.

### ADR-005 — Exact decimals in storage, decimal strings on the wire

- **Why:** `0.1 + 0.2 !== 0.3` in IEEE-754. A platform that compares highs, lows and adjusted prices must
  not accumulate binary floating-point error.
- **Problem solved:** price equality (`open = low` scanner), adjustment multiplication, and turnover
  aggregation are exact.
- **Operational cost:** `numeric` arithmetic is slower than `float8` — measured, acceptable at this
  volume; JSON payloads carry strings, so clients must parse deliberately.
- **Scaling:** `numeric` index sizes are larger; mitigated by using `numeric(18,4)` (not unbounded
  `numeric`) so values are fixed-width.
- **Failure:** a client that does `Number(price)` reintroduces the problem at the edge. Mitigated by the
  contract type being `string` in `packages/contracts`, so the mistake is visible in review, and by a
  frontend lint rule banning arithmetic on price strings outside `decimal.js` helpers.
- **Alternative rejected:** `float8`/`double precision` — disqualified by correctness; integer paise —
  workable but complicates tick sizes and index levels, and every read becomes a scaling decision.

### ADR-006 — UTC `timestamptz` plus explicit `session_date`

- **Why:** a bar has two identities: an instant (for ordering and joins) and a trading day (for calendar
  logic, gaps, and aggregation). Conflating them breaks on exchange-specific sessions.
- **Problem solved:** correct daily aggregation, correct holiday-gap detection, correct MCX evening
  session handling, and immunity to server timezone configuration.
- **Operational cost:** one extra column and a rule that every bar write must resolve `session_date`
  through `trading_calendar`.
- **Scaling:** `session_date` is the leading column of several analytical indexes, which is what makes
  breadth and RS queries fast.
- **Failure:** a wrong `session_date` silently mis-buckets data. Mitigated by a check constraint that
  `session_date` falls inside the bar's exchange session window, and by a reconciliation job that
  verifies every bar's `session_date` has a matching `trading_calendar` row marked trading.
- **Alternative rejected:** storing local time without offset — ambiguous and unindexable across
  exchanges; storing only UTC and deriving session date on read — makes gap detection a per-row function
  call and prevents partition pruning by trading day.

### ADR-007 — `market_bar` range-partitioned by month on `bucket_start`

- **Why:** ~200M rows projected. Chart queries always constrain an instrument and a date range, so
  partition pruning plus a composite index turns a table scan into a handful of index range scans.
- **Problem solved:** predictable query latency as history grows; cheap retention (`DROP PARTITION`
  instead of `DELETE`); cheap bulk load into the current partition.
- **Operational cost:** a monthly maintenance job must pre-create the next partition; the primary key
  must include the partition key.
- **Scaling:** adding a year of history is additive. Detaching old partitions to cold storage is a
  metadata operation.
- **Failure:** a missing future partition causes inserts to fail loudly (desired). A `maintenance`
  job pre-creates 3 months ahead and alerts if the runway drops below 30 days.
- **Alternative rejected:** no partitioning — index bloat and vacuum pressure become unmanageable past
  ~50M rows; partitioning by `instrument_id` hash — defeats date-range pruning, which is the dominant
  access pattern.

### ADR-008 — Precompute derived analytics; never compute on read

- **Why:** indicators are recursive (EMA, Wilder smoothing, ADX) and cannot be expressed as cheap SQL
  window functions; scanners must evaluate thousands of instruments against dozens of conditions in one
  statement.
- **Problem solved:** interactive latency. Reads become indexed lookups against `indicator_value` and
  the wide per-timeframe snapshot tables.
- **Operational cost:** storage for derived data (~90M indicator rows at 3-year retention) and a
  dependency graph of jobs that must run in order after ingestion.
- **Scaling:** derived tables are append-mostly and partition the same way as bars.
- **Failure:** a failed analytics job leaves stale derived data. Mitigated by a `computed_through`
  watermark per (instrument, timeframe, indicator set) exposed on `/readyz` and the data-quality
  dashboard; stale data is visibly stale, never silently mixed with fresh data.
- **Alternative rejected:** compute-on-read — a single chart request with 4 indicators over 2,000 bars
  would recompute EMA/ADX on every pan; scanner runs would take minutes.

### ADR-009 — Database-backed job queue

- **Why:** at ≤ a few thousand jobs per day, a queue table with `FOR UPDATE SKIP LOCKED` is correct,
  transactional with business writes, and observable with SQL. Redis adds a second durability domain.
- **Problem solved:** atomic "write the batch AND enqueue the follow-up job" in one transaction — the
  core reason an external broker is unnecessary here.
- **Operational cost:** none beyond the existing database. Job tables are small.
- **Scaling:** measured limit is roughly 50–100 job claims/second before contention on the queue index
  becomes visible. Migration trigger to Redis/BullMQ is documented in §9.3.
- **Failure:** if the database is down, jobs cannot be enqueued or claimed — but neither can anything
  else, so this adds no new failure domain. Stale locks are reclaimed by a reaper.
- **Alternative rejected:** BullMQ/Redis — a second stateful system for a workload that does not need
  sub-second dispatch; SQS/cloud queue — unnecessary vendor coupling for a single-VPS deployment;
  `pg_cron` alone — no retry, backoff, dead-letter, or application-level observability.

### ADR-010 — Hybrid tokens: short-lived JWT access + rotating opaque refresh

- **Why:** stateless verification on the hot path (no DB round-trip per request) while retaining genuine
  revocation (which pure JWT cannot provide).
- **Problem solved:** the tension between "don't hit the DB on every request" and "log out immediately
  on compromise".
- **Operational cost:** one extra table and a rotation path.
- **Scaling:** access verification is CPU-only and scales with the API tier; refresh is DB-bound but rare
  (once per 15 minutes per session).
- **Failure:** signing-key compromise invalidates all sessions — requires rotation with a `kid` header
  and a short overlap window.
- **Alternative rejected:** server-side sessions only — a DB write/read per request and awkward for a
  future desktop shell; long-lived JWTs — no revocation; refresh tokens in `localStorage` — XSS-exfiltratable.

### ADR-011 — TradingView Lightweight Charts v5 for price rendering

- **Why:** it is Apache-2.0, canvas-based, handles 100k+ bars with smooth zoom/pan and crosshair, and
  supports custom series and drawing primitives.
- **Problem solved:** candlestick + volume + overlay panes + crosshair + large datasets, without writing
  a rendering engine.
- **Operational cost:** ~45 KB gzipped, no server component, no licence fee.
- **Scaling:** client-side; renders only the visible range. Server sends bounded windows.
- **Failure:** a library regression is contained behind our own `<PriceChart>` adapter so a swap touches
  one file.
- **Alternative rejected:** Highcharts Stock — commercial licence cost and a heavier bundle for
  capability we do not need; Chart.js + financial plugin — poor large-dataset behaviour; D3 — months of
  custom work for parity; the full TradingView Charting Library — requires a separate licence agreement
  and is designed to be fed by a datafeed abstraction we do not want to adopt wholesale. **Known gap:**
  Lightweight Charts has no built-in Fibonacci drawing tool, so Fibonacci levels are rendered as
  horizontal price lines plus optional shaded bands using the primitives API; this is implemented, not
  deferred.

### ADR-012 — React SPA (Vite) rather than a server-rendered framework

- **Why:** every screen is behind authentication, so there is no SEO surface; server rendering would
  introduce a second data-fetching model competing with the REST contracts.
- **Problem solved:** one data path (typed REST), one cache (TanStack Query), one auth model
  (in-memory access token).
- **Operational cost:** static asset hosting; no Node rendering tier.
- **Scaling:** CDN or proxy-served static files; scales trivially.
- **Failure:** a bad bundle is a client-side outage. Mitigated by immutable hashed asset names, a
  version-check endpoint, and an explicit "new version available" reload prompt rather than silent
  breakage.
- **Alternative rejected:** Next.js — RSC and route handlers would duplicate the API layer; Vue/Flutter
  (both in the source brief) — the team's type-sharing advantage is with React + TypeScript, and Flutter
  adds a second UI stack for a web-first product.
- **Desktop capability:** the SPA is shell-agnostic. A Tauri v2 wrapper (system webview, ~5 MB) is the
  chosen desktop path over Electron (~120 MB); the wrapper only loads the same bundle and adds a native
  window. Deferred to Phase 15, and it changes nothing in the API.

### ADR-013 — Zod contracts as the single source of truth

- **Why:** request validation, response serialisation, OpenAPI generation and frontend types must not be
  four independent descriptions of the same shape.
- **Problem solved:** contract drift, and the class of bug where the API accepts a payload the UI cannot
  produce.
- **Operational cost:** schemas are code; changing a response requires touching one file.
- **Scaling:** none.
- **Failure:** an over-strict response schema can drop fields silently if serialisation strips unknowns.
  Mitigated by `strict()` on responses in tests and a contract snapshot test in CI.
- **Alternative rejected:** hand-written OpenAPI + codegen — one more artefact to keep in sync; class
  validators — no runtime-to-TypeScript inference parity.

### ADR-014 — pnpm workspaces, no build orchestrator initially

- **Why:** five to ten packages with straightforward dependencies do not need Nx or Turborepo. pnpm gives
  strict dependency isolation (a package cannot import what it did not declare), which is exactly the
  boundary enforcement this architecture depends on.
- **Problem solved:** accidental cross-package imports and phantom dependencies.
- **Operational cost:** one global tool install.
- **Scaling:** if CI build time exceeds ~10 minutes, add Turborepo for task caching; trigger documented.
- **Failure:** pnpm store corruption is recoverable with `pnpm store prune`.
- **Alternative rejected:** npm workspaces — hoisting hides undeclared dependencies, weakening the
  boundary guarantee; Nx — substantial configuration surface for a single application.

### ADR-015 — Docker Compose on a single Linux VPS; no Kubernetes

- **Why:** five containers on one host with a known capacity envelope. Kubernetes would add a control
  plane, an ingress stack, and a new failure taxonomy for zero benefit at this scale.
- **Problem solved:** reproducible deployment, pinned Postgres version, simple rollback (`docker compose
  up` with a previous image tag).
- **Operational cost:** one host to patch; Compose files are the deployment contract.
- **Scaling:** vertical resize, then move `postgres` to a managed instance, then add a second API host
  behind the proxy. Each step is independent.
- **Failure:** host loss = full outage. Mitigated by off-host backups and a documented rebuild procedure
  with a 2-hour RTO.
- **Alternative rejected:** Kubernetes — operational overhead unjustified; bare-metal systemd units —
  loses environment reproducibility.

### ADR-016 — Rate limiting in Postgres with an in-process fast path

- **Why:** needs to be shared across API instances eventually, but must not add Redis today.
- **Problem solved:** brute-force protection and fair-use quotas without new infrastructure.
- **Operational cost:** one unlogged table, one upsert per limited request.
- **Scaling:** at ~50 rps the write cost is negligible. Trigger for moving to Redis: sustained >200 rps or
  visible contention on the counter table.
- **Failure:** if the counter table is unavailable, the limiter fails **closed** for authentication
  endpoints and **open** for read endpoints, with a metric increment. This asymmetry is deliberate:
  locking out logins is safer than locking out dashboards.
- **Alternative rejected:** in-memory only — incorrect with more than one API instance; a reverse-proxy
  limiter — coarse, cannot express per-principal quotas.

### ADR-017 — Scanner conditions compiled from a registry to SQL

- **Why:** conditions must be configurable data, not controller code, and evaluation must happen where
  the data is.
- **Problem solved:** thousands of instruments × dozens of conditions in a single statement, with exact
  `numeric` comparisons.
- **Operational cost:** a condition registry where each node type declares a Zod parameter schema and a
  SQL fragment builder.
- **Scaling:** one statement per run; the planner uses the snapshot table indexes.
- **Failure:** a compiled statement that is valid but slow. Mitigated by a compile-time row estimate and
  a per-run statement timeout, plus an `EXPLAIN` snapshot stored on `scanner_run`.
- **Alternative rejected:** evaluating in JavaScript — requires loading the universe into memory and
  loses numeric exactness; a DSL interpreted at runtime — same problem plus an injection surface.

### ADR-018 — Renko and indicators computed in TypeScript, results persisted

- **Why:** the algorithms are recursive and stateful per instrument; expressing them in SQL produces
  unmaintainable recursive CTEs and hides the exact seeding rules that determine correctness.
- **Problem solved:** testability. Every engine is a pure function with golden-vector tests, independent
  of the database.
- **Operational cost:** batch CPU time in the worker tier; results must be persisted and versioned.
- **Scaling:** shard by instrument range across workers.
- **Failure:** a bug in an engine produces wrong-but-plausible numbers. This is the highest-severity risk
  in the product, mitigated by hand-computed fixtures, independent reference cross-checks, and
  `params_hash` versioning so a corrected engine triggers a full recompute rather than mixing old and
  new results.
- **Alternative rejected:** SQL window functions — impossible for Wilder smoothing without recursive
  CTEs; a Python analytics sidecar — a second runtime, second deployment, and a serialisation boundary
  for no numerical advantage.

### ADR-019 — Transactional outbox (`domain_event`) for internal fan-out

- **Why:** "batch completed" must reliably trigger five downstream jobs. Publishing after commit can be
  lost; publishing before commit can reference a rollback.
- **Problem solved:** exactly-once *enqueue* semantics via insert-in-same-transaction plus a unique
  `(event_type, aggregate_id, aggregate_version)` constraint.
- **Operational cost:** one table and a dispatcher loop.
- **Scaling:** append-only, partitioned by month, purged after 90 days.
- **Failure:** a stuck dispatcher delays derivation but never loses it; the backlog is a metric.
- **Alternative rejected:** direct job enqueue inside the business transaction — works for simple cases
  but couples producers to consumers and makes replay impossible; an external broker — see ADR-009.

### ADR-020 — Raw import files on a mounted volume, addressed by content hash

- **Why:** files are write-once, read-rarely, and must be replayable for reconciliation.
- **Problem solved:** provenance and re-processing without re-upload.
- **Operational cost:** disk; included in the backup set.
- **Scaling:** at ~5 MB/day compressed, years fit in tens of gigabytes.
- **Failure:** volume loss loses provenance but not data (bars are in Postgres). Mitigated by including
  the volume in nightly backups.
- **Alternative rejected:** S3-compatible object storage — a second credential surface and network hop
  for a single-host deployment; storing files in Postgres `bytea` — bloats the database and its backups.

---

## 7. Repository structure

```
tradesoft/
├─ apps/
│  ├─ api/                     Fastify composition root
│  │  ├─ src/http/             routes, guards, error mapping, serialisation
│  │  ├─ src/services/         application services (one per use case)
│  │  └─ src/main.ts
│  ├─ worker/                  job consumers + handler registry
│  ├─ scheduler/               cron → job_schedule → job
│  └─ web/                     React SPA
│     ├─ src/app/              routing, providers, layout
│     ├─ src/features/         dashboard, markets, charts, renko, sectors,
│     │                        breadth, rs-matrix, scanners, data, admin
│     ├─ src/components/       design-system components only
│     └─ src/lib/              api client, decimal helpers, formatting
├─ packages/
│  ├─ contracts/               Zod schemas, DTOs, OpenAPI document, error codes
│  ├─ domain/                  entities, value objects, invariants, ports, errors
│  ├─ engines/                 indicators, renko, breadth, rs, timeframe algebra,
│  │                           scanner condition registry + SQL compiler
│  ├─ db/                      Drizzle schema, migrations, repositories, sql/
│  ├─ ingestion/               source adapters, CSV mapping, validators, reconcilers
│  ├─ observability/           logger, metrics, tracing, audit client, redaction
│  ├─ config/                  environment schema and typed loader
│  └─ testing/                 fixtures, factories, golden vectors, db harness
├─ infra/
│  ├─ compose/                 docker-compose.{dev,prod}.yml
│  ├─ postgres/                init scripts, tuning, backup and restore scripts
│  ├─ proxy/                   reverse-proxy config and TLS notes
│  └─ scripts/                 migrate, seed, partition-rollover, restore-drill
├─ docs/
│  ├─ architecture/            this specification
│  └─ runbooks/                incident, restore, backfill, key rotation
└─ package.json, pnpm-workspace.yaml, tsconfig.base.json, .env.example
```

Rules:

1. `apps/*` may import `packages/*`; `packages/*` may not import `apps/*`.
2. `domain` and `engines` import only `contracts` and each other (engines → domain). They import no I/O.
3. `db` and `ingestion` are the only packages allowed to know both domain and infrastructure.
4. Each package exposes exactly one entrypoint (`src/index.ts`). Deep imports are a build failure.
5. One service file per use case in `apps/api/src/services`. Route handlers contain no business logic
   beyond validation, authorization, service invocation, and serialisation.

---

## 8. Deployment topology (v1)

```
                    Internet
                       │  443/TLS
              ┌────────▼─────────┐
              │  reverse proxy   │  TLS termination, HSTS, static assets,
              │  (nginx/caddy)   │  gzip/brotli, request size limits
              └───┬──────────┬───┘
        /api/v1   │          │   /
        ┌─────────▼──┐   ┌───▼──────────┐
        │ api x2     │   │ static SPA   │
        │ (stateless)│   │ bundle       │
        └─────┬──────┘   └──────────────┘
              │  5432 (private network only)
        ┌─────▼──────────────────────────┐
        │ PostgreSQL 16                  │
        │  primary, WAL archiving        │
        └─────▲──────────────────────────┘
              │
     ┌────────┴─────────┬───────────────┐
     │ worker x1..n     │ scheduler x1  │
     │ (CPU batch)      │ (advisory     │
     │                  │  lock)        │
     └──────────────────┴───────────────┘
              │
        ┌─────▼──────────┐
        │ volume:        │
        │ raw imports,   │
        │ backups        │
        └────────────────┘
```

Environments: `local`, `ci`, `staging`, `production`. `staging` runs the same images with a restored
anonymised subset. Production never receives seed data (see `02-database.md` §9).

Minimum production host: 8 vCPU, 16 GB RAM (the host class on which the `04` §10.1 budgets are stated), NVMe SSD, 100 GB plus growth headroom. Postgres is tuned
explicitly (`shared_buffers` 4 GB, `work_mem` 64 MB, `maintenance_work_mem` 1 GB, `effective_cache_size`
12 GB, `max_locks_per_transaction` 256 — monthly partitions put about 140 children under each partitioned table, and an unpruned query or the partition-creating migration takes a lock per child) rather than left at defaults.

---

## 9. Scaling and extraction path

### 9.1 Capacity model

| Dataset | Rows (year 1) | Rows (year 5) | Retention |
|---|---|---|---|
| `market_bar` daily | 2.5M | 25M | indefinite |
| `market_bar` 15m | 62M | 187M (3 yr) | 3 years hot, then archive |
| `market_bar` other intraday | 30M | 90M | 3 years |
| `indicator_value` | 30M | 90M (3 yr) | 3 years |
| `renko_brick` | 20M | 60M | 5 years for configured sets |
| `audit_event` | 5M | 25M | 7 years (regulatory-style), monthly partitions |

### 9.2 Trigger points

| Signal | Threshold | Action |
|---|---|---|
| Chart p95 latency | > 300 ms | Add read replica; route read-only endpoints to it |
| Analytics job wall time | > 60 s per instrument shard | Shard further; move to dedicated worker pool |
| Job claim contention | > 50 claims/s sustained | Move queue to Redis/BullMQ behind the same `JobQueue` port |
| Rate-limit table contention | > 200 rps or lock waits | Move limiter to Redis |
| Bar volume | > 500M rows or > 500 GB | Evaluate TimescaleDB or columnar archive for cold partitions |
| Ingestion throughput | > 2M rows per batch | Extract ingestion into its own service behind `MarketDataPort` |

### 9.3 Extraction triggers (why the monolith stays a monolith until then)

A module is extracted into a service only when **two** of the following hold: it needs an independent
scaling profile by more than 3×, it needs an independent release cadence, it has a latency budget that
the monolith's shared event loop violates, or it must be operated by a different team. Ingestion and
analytics batch are the two candidates; both already run as separate processes, so extraction is a
transport change, not a redesign.

---

## 10. What this architecture deliberately does not do

- No event sourcing of market data. Bars are state, not an event stream; `market_bar_history` preserves
  superseded values for audit without replay semantics.
- No CQRS split. Read models are materialised tables, not a separate write/read service pair.
- No generic plugin system for data sources. Adapters implement a typed interface; there are three, and a
  registry of three does not need a plugin loader.
- No GraphQL. The read patterns are known, cacheable, and benefit from HTTP semantics and per-endpoint
  rate limits.
- No client-side indicator computation. One implementation, server-side, tested once.
