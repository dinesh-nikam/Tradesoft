# 08 — Implementation Plan

Status: **APPROVED BASELINE (Phase 0)**. This document sequences the work that `00`–`07` specify. It does
not introduce behaviour; where a phase below names a behaviour, the owning section is cited and is
authoritative.

---

## 1. Purpose and how to use this document

This plan answers four questions:

1. **In what order is TradeSoft built**, and why that order (§2, §3).
2. **What exactly must be true for each phase to be finished** — exit criteria that a reviewer can check
   without trusting the author (§4).
3. **How much effort and calendar time it takes** with a stated team, compared with the 95-working-day
   reference estimate in the source specification (§5).
4. **What can go wrong** and what is already done about it (§6), and which phase proves or disproves each
   architectural assumption (§7).

A phase is finished when its exit criteria are evidenced in a completion note (§8), not when its code is
merged. The production-readiness gate (`07` §13) consumes these completion notes as PRG-01.

---

## 2. Sequencing principles

| # | Principle | Consequence for the order |
|---|---|---|
| S1 | **Correct data before visible data.** A chart over unvalidated bars is a liability that looks like progress. | Ingestion, validation and reconciliation (Phase 5) and canonical time-series (Phase 6) precede every analytical surface. |
| S2 | **Security is a foundation, not a late retrofit.** Every route written after Phase 3 is born with a permission, audit and rate limit. | Phase 3 precedes all business endpoints. The boot-time route enforcement of `06` §7.2 is live from the first business route. |
| S3 | **Engines before screens.** Engines are pure functions with golden vectors (`04` §1.1, §11.1); a screen is a projection of persisted engine output. | Each analytical phase delivers engine, job, persistence and API before its UI; the UI work runs in parallel against the typed contract. |
| S4 | **Dependencies follow the data.** Indicators need canonical bars; Renko needs canonical bars; breadth needs Renko; RS needs adjusted closes and corporate actions; scanners need the indicator snapshot and 52-week statistics. | The order 6 → 7/8 → 10/11 → 12 is forced by `04` §1.5, not chosen. |
| S5 | **Elapsed-time evidence starts early.** The gate needs 20 trading days of parallel ingestion and 10 days of clean invariants (`07` PRG-04, PRG-05). Those days cannot be compressed by adding people. | The production host is commissioned in pre-production mode at Phase 5 exit, and each later engine is deployed to it as it lands. |
| S6 | **Each phase ends deployable.** No phase leaves `main` in a state that cannot be released to staging. | Every phase's definition of done includes CI stages 1–7 green and a staging deploy (§8). |

---

## 3. Plan at a glance

| Phase | Name | Depends on | Primary spec sections | Effort (eng-days) | Calendar weeks (§5.3) |
|---|---|---|---|---|---|
| 1 | Architecture and domain model | — | `00`, `01`, DIAGRAMS | 8 | 1–2 |
| 2 | Database and migrations | 1 | `02` | 10 | 2–3 |
| 3 | Authentication, authorization, audit, job runtime | 2 | `06` §4–§8, §14; `05` §10; `03` §5 | 15 | 4–5 |
| 4 | Market reference data | 2, 3 | `01` §1.2; `02` §5.2; `05` §11.4 | 12 | 4–5 |
| 5 | CSV/EOD ingestion, validation, reconciliation | 3, 4 | `03` §1–§4, §7; `05` §12.11–§12.13 | 20 | 6–7 |
| 6 | Canonical time-series storage | 5 | `04` §1–§2, §3.10; `02` §5.3 | 11 | 8 |
| 7 | Indicator engine | 6 | `04` §3–§4 | 10 | 9–10 |
| 8 | Renko engine | 6 | `04` §5 | 9 | 9–10 |
| 9 | Chart APIs and UI | 6, 7, 8 | `05` §12.2–§12.4; ADR-011 | 18 | 9–11 |
| 10 | Sector and breadth engine, dynamic groups | 4, 8 | `04` §6 | 11 | 11–12 |
| 11 | RS Matrix | 4, 6 | `04` §7 | 11 | 11–12 |
| 12 | Scanner engine | 6, 7 | `04` §8 | 17 | 12–13 |
| 13 | Dashboard | 6, 7, 10, 11 | `05` §11.9 | 9 | 14 |
| 14 | Observability, performance, hardening | 1–13 | `07` §4, §6, §8; `06` §17 | 14 | 14–15 |
| 15 | Production deployment | 14 | `07` §7, §13; `00` §8 | 11 | 16–17 |
| | **Total** | | | **186** | **17 + contingency** |

---

## 4. Phases

Each phase lists its goal, deliverables (with the repository paths of `00` §7), exit criteria, and what is
deliberately not in it. Exit criteria are numbered `E<phase>.<n>` so that completion notes and the gate can
cite them.

### Phase 1 — Architecture and domain model

**Goal.** The specification is approved, and the domain model exists as compiled, tested code that every
later phase imports.

**Deliverables.**

- This specification set (`00`–`08`, DIAGRAMS) reviewed and approved.
- Monorepo scaffold per `00` §7: pnpm workspace, `tsconfig.base.json`, ESLint with the package-boundary
  rule and the decimal-discipline rule, Prettier, Vitest, `.env.example`.
- `packages/domain`: identifiers and value objects (`InstrumentId`, `Timeframe`, `Instant`, `IsoDate`,
  `Decimal`), the state machines of `01` §3 as transition tables,
  invariants of `01` §5 that are checkable on values as pure predicates, domain errors. Entity row types are
  not hand-written: they are inferred from the Drizzle schema in Phase 2, so the DDL stays the single source.
- `packages/contracts`: the error-code registry and RFC 9457 problem schema (`05` §5), the decimal-string
  schema (`05` §4.1), the collection envelope and cursor schema (`05` §6).
- CI stages 1–3 (`07` §6.13) running on every commit.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E1.1 | Every state machine in `01` §3 is a transition table, and a test enumerates every (state, event) pair and asserts it is allowed or rejected exactly as the spec states. |
| E1.2 | A fixture containing a deep import (`@tradesoft/db/internal/...`) fails the build; a fixture typing a price field as `number` in `packages/contracts` fails the decimal-discipline rule. |
| E1.3 | Methodology sign-off: the system owner has approved, in writing, the worked examples of Renko (`04` §5.10), breadth (`04` §6.7), RS (`04` §7.7) and the system scanner definitions (`04` §8.7), with the commit hash of `04`. These are product decisions expressed as mathematics and are the costliest to change after Phase 8. |
| E1.4 | Assumptions A1–A11 (`00` §2) are reviewed with the system owner; a rejected assumption produces an ADR amendment before Phase 2 starts. |
| E1.5 | The data-source decision is recorded: for each exchange (NSE, BSE, MCX, NCDEX, NFO) and each inter-market proxy (gold, silver, USD-INR, bonds), which source supplies EOD bars, under which licence, and whether it arrives by manual CSV or a licensed API (input to R-03, R-09 and PRG-21). |

**Not in this phase.** Any database access, any HTTP route.

### Phase 2 — Database and migrations

**Goal.** The full schema of `02` §5 applies to an empty PostgreSQL 16 cluster through the production
migration runner and passes the schema test suite.

**Deliverables.**

- `packages/db`: forward-only migration runner with checksum immutability and an advisory lock (`02` §8),
  writing `ops.schema_migration`.
- DDL for all seven schemas (`iam`, `ref`, `md`, `an`, `scan`, `ops`, `audit`), including the partitioned
  tables and their initial partition runway (`02` §6), functions and triggers (`02` §7).
- Structural seed inside the migrations (`02` §9).
- `infra/scripts/seed-dev.ts`: the deterministic development seed with its injected defects (`02` §9).
- `packages/testing`: Testcontainers harness, factories with seeded PRNG (`07` §6.12).
- `infra/compose/docker-compose.dev.yml`.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E2.1 | Migrations apply to an empty cluster; the schema hash matches the committed expectation. |
| E2.2 | `07` §6.10 tests 1–6 pass. Test 2 ("from the previous release") has no previous release yet; it is wired and skipped with the reason recorded in the completion note. |
| E2.3 | Every `CHECK`, `UNIQUE` and foreign-key constraint on `md.market_bar`, `md.import_batch` and `ref.instrument` has a negative test that inserts a violating row and asserts the named constraint rejects it. |
| E2.4 | Running the development seed twice on two machines produces byte-identical `pg_dump --data-only` output. |
| E2.5 | The expected plans of `02` §11 are captured on the seeded database as regression baselines for CI stage 8. |

**Not in this phase.** Repositories for business use cases beyond what the tests need.

### Phase 3 — Authentication, authorization, audit and job runtime

**Goal.** Every later route is born authenticated, authorized, audited and rate-limited; the job runtime that
ingestion depends on exists.

**Deliverables.**

- `apps/api` composition root (Fastify, ADR-002) with: typed config loader (`packages/config`), pino logging
  with redaction and correlation IDs (`packages/observability`), RFC 9457 error mapping, security headers and
  CSP (`06` §9), CORS, request limits (`05` §3.5), rate limiting (ADR-016, `05` §9).
- Identity: Argon2id hashing (`06` §4.4), invitation, login, password change and reset, lockout and
  anti-enumeration (`06` §4.6), JWT access token and rotating refresh token with family revocation and grace
  window (`06` §5), CSRF (`05` §10.2), TOTP MFA mandatory for `ADMIN` (`06` §6), API keys for `INGEST_SERVICE`
  (`06` §8).
- Authorization: `authorize()` (`06` §7.3), boot-time route enforcement (`06` §7.2), object-level rules
  (`06` §7.4), the permission matrix as structural seed (`00` §4).
- Audit: `audit.audit_event` with hash chain and `audit.security_event` (`06` §14), verification script and
  endpoint, nightly anchor export.
- Job runtime (`03` §5): `ops.job` claim with `FOR UPDATE SKIP LOCKED`, retry with exponential backoff and
  jitter, dead-letter, stale-job reaper and outbox dispatcher loops (ADR-019), `apps/scheduler` with its
  advisory lock, `ops.send_email`.
- Endpoints of `05` §11.2, §11.3, and the user, role, API-key, audit and security-event parts of §11.10.
- SPA shell (`apps/web`): login, MFA enrolment and challenge, silent refresh, permission-driven navigation
  (`05` §15), user administration screen.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E3.1 | SEC-T-01…SEC-T-17 (`06` §17.2) pass, except those whose subject lands in a later phase; each exception is listed in the completion note with its phase. |
| E3.2 | `tradesoft_authz_unprotected_routes` is 0, and a test that registers a route without a permission makes boot fail. |
| E3.3 | Replaying a rotated refresh token outside the grace window revokes the whole family and writes a security event (test). |
| E3.4 | The audit chain verifies over 10,000 synthetic events, and altering any single row's payload makes verification report that row's id as the first break. |
| E3.5 | Job-runtime concurrency scenarios from `03` §7.1 — scheduler double-start, worker crash with a reclaimed job, duplicate enqueue with the same idempotency key — pass. |
| E3.6 | SEC-T-14 passes: no password, token, API key or MFA secret appears in any log output. |

**Not in this phase.** Market data, ingestion handlers, analytics.

### Phase 4 — Market reference data

**Goal.** Exchanges, calendars, instruments, symbols, sectors, indices, groups and corporate actions exist as
effective-dated, audited reference data, and the corporate-action feed for the covered universe is loaded.

**Deliverables.**

- `ref.exchange`, `ref.trading_calendar` with special and shortened sessions (A8), `ref.instrument` with its
  lifecycle (`01` §3.5), `ref.symbol_alias` with effective dating for symbol changes, `ref.sector` hierarchy,
  `ref.instrument_sector_membership`, `ref.index_membership`, `ref.corporate_action`, `ref.market_group` and
  `ref.market_group_member` for static groups.
- The GS Composite as a synthetic instrument with its configured proxies (A11, `04` §7.8), and the gold,
  USD-INR and bond proxy instruments used by RS pairings (`04` §7.4).
- Public surface `resolveSymbol`, `tradingDays`, `sessionBounds`, `effectiveMembers`, `resolveGroup`
  (`00` §5); endpoints of `05` §11.4.
- Reference-data loading through `REFERENCE` import batches for calendars, instruments, memberships and
  corporate actions.
- SPA: Data Management screens for exchanges, calendars, instruments, sectors, groups and corporate actions.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E4.1 | Symbol resolution as of a date returns the correct instrument across a rename, a delisting, and a re-listing under a previously used symbol (tests). |
| E4.2 | `sessionBounds` returns correct bounds for a normal NSE session, an MCX extended session, a Muhurat session and an exchange holiday, driven by calendar rows rather than code constants (tests). |
| E4.3 | The trading calendar for every enabled exchange is loaded for the current and next calendar year (feeds PRG-09). |
| E4.4 | Corporate actions for the covered universe are loaded for 5 years and reconciled against the feed's own count — the Phase 4 blocker of `04` §7.2 (feeds PRG-08). |
| E4.5 | Every reference-data write produces an audit event with before and after state, and a write without the required permission returns `403` with the catalogued error code. |

**Not in this phase.** Dynamic group rules (Phase 10).

### Phase 5 — CSV/EOD ingestion, validation and reconciliation

**Goal.** Market data enters the system through exactly one path (`MarketDataPort.ingestBars`, `00` §5.1),
and nothing corrupt is ever silently accepted.

**Deliverables.**

- Content-addressed raw-file storage on the import volume (ADR-020), upload endpoint with idempotency
  (`05` §12.11, §8), batch read endpoint (`05` §12.12).
- Source adapters registered in `03` §1.1, the CSV contract (`03` §2), validation levels L1–L5 (`03` §3),
  the import-batch state machine (`01` §3.1), `md.ingestion_reject`.
- Persistence through `MarketDataPort` with revision guarding, `md.market_bar_history` for superseded rows,
  domain events through the outbox.
- Corrections endpoint with justification and audit (`05` §12.13, `03` §4), symbol-change handling.
- Jobs `ingestion.pull_source`, `ingestion.parse_validate`, `ingestion.persist_bars` and
  `ingestion.reconcile` (`03` §5.3); dead-letter operations endpoints and screen.
- SPA: Imports screen (upload, batch status, reject browser, retry), job administration screen.
- Staging environment live (`07` §3.1). **Production host commissioned in pre-production mode** and the
  parallel run of PRG-05 started (S5).
- Licence register `docs/release/data-sources.md` (PRG-21).

**Exit criteria.**

| ID | Criterion |
|---|---|
| E5.1 | Every validation rule in `03` §3 has a fixture that triggers it, and the resulting batch state or reject code matches the spec. |
| E5.2 | The ingestion-owned concurrency scenarios of `03` §7.1 pass, including the same file uploaded twice concurrently and the same `Idempotency-Key` retried after a client timeout. |
| E5.3 | Re-importing an identical file changes no row and returns the duplicate response of `05` §8.4; importing a file whose values differ for an existing bar follows the correction rules of `03` §4 and never overwrites silently. |
| E5.4 | A file with a changed header layout fails at L1 with `VALIDATION_FAILED` and the catalogued code, and no row is persisted. |
| E5.5 | A full-market EOD file of 10,000 rows (A2) is validated, persisted and reconciled on staging in under 60 seconds end to end. |
| E5.6 | Killing the worker during `persist_bars` leaves either the full batch or none of it, and the retried job completes the batch (atomicity test). |

**Not in this phase.** Derived timeframes and analytics.

### Phase 6 — Canonical time-series storage

**Goal.** Every timeframe of `04` §2 exists, is derived from its authoritative timeframe by exactly one writer,
is adjusted for corporate actions, and is kept current incrementally.

**Deliverables.**

- Time-series engine in `packages/engines`: `bucketFor`, `aggregate`, `alignToCalendar` (`04` §2).
- Bar-ownership enforcement INV-D1 and INV-D2 (`04` §1.4).
- Jobs `marketdata.derive_timeframes`, `marketdata.rebuild_adjustments`, `marketdata.refresh_daily_snapshot`
  and `marketdata.compute_52w_stats`; `md.bar_adjustment_factor`, `md.instrument_daily_snapshot`,
  `md.instrument_stat_52w`.
- GS Composite bar computation (A11).
- Watermarks and the invalidation cascade (`04` §1.6–§1.7), `an.analytics_watermark`.
- `GET /market-data/bars` (`05` §12.2) with `ADJUSTED` default and `RAW` opt-in.
- The nightly invariant verifier (`04` §11.3) for the invariants that exist at this phase.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E6.1 | The worked example of `04` §2.7 (NSE `240m` and `60m` from `15m`) is a passing test. |
| E6.2 | Property test: no derived bucket crosses a session boundary (`04` §2.5) for any calendar in the seed, including shortened and special sessions. |
| E6.3 | For the seed's split and bonus fixtures, adjusted closes on both sides of the ex-date are continuous, and `RAW` returns the unadjusted values. |
| E6.4 | Running derivation twice over the same inputs produces identical rows, and a correction to one `1D` bar re-derives exactly the affected `1W`, `1M`, `3M` and `1Y` buckets. |
| E6.5 | The invariant verifier reports zero violations on the seed, and reports each injected defect class when a defect is introduced directly in SQL. |

### Phase 7 — Indicator engine

**Goal.** SMA, EMA, Bollinger Bands, RSI, ADX, DMI+, DMI- and Fibonacci retracement are computed
deterministically, persisted, and proven against known answers.

**Deliverables.**

- Indicator implementations of `04` §3 (SMA, EMA, Wilder RSI, True Range and ATR, DMI+/DMI-/ADX, Bollinger
  Bands, volume averages) and the Fibonacci ZigZag and levels of `04` §4.
- Jobs `analytics.compute_indicators` and `analytics.compute_indicator_snapshot`; `an.indicator_value`,
  `an.indicator_snapshot`.
- Golden vectors in `packages/testing` (`04` §11.1); property tests (`04` §11.2).
- The scheduled external cross-check job of `04` §11.4.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E7.1 | Each indicator has golden vectors covering warm-up (leading `null`s exactly as `04` §3.2 states), a flat series, a monotonic series and a gap. |
| E7.2 | Incremental computation from a watermark produces the same values as a full recomputation (property test, `04` §1.6). |
| E7.3 | The ZigZag non-repainting guarantee (`04` §4.3) holds under a property test that appends bars one at a time. |
| E7.4 | The indicator stage's duration on the full covered universe in pre-production is recorded and extrapolated against the 60-minute nightly budget (input to R-01). |

### Phase 8 — Renko engine

**Goal.** Renko bricks for the eight configured percentages (0.1 %, 0.15 %, 0.25 %, 0.5 %, 1 %, 2 %, 3 %, 5 %)
follow the exact rules of `04` §5 and stay correct under corrections and corporate actions.

**Deliverables.**

- Renko engine per `04` §5: brick size, anchor, price source, generation loop, reversal rule, intrabar order
  under `HIGH_LOW`, timestamp assignment, synthetic OHLC.
- `an.renko_brick_set`, `an.renko_brick`; job `analytics.compute_renko`; rebuild on correction and on
  corporate action (`04` §5.12).
- `GET /instruments/{id}/renko` (`05` §12.4).

**Exit criteria.**

| ID | Criterion |
|---|---|
| E8.1 | The worked example of `04` §5.10 is a passing test. |
| E8.2 | Tests cover the reversal threshold, a gap larger than several bricks, `HIGH_LOW` intrabar ordering on both an up bar and a down bar, and timestamp assignment for several bricks formed in one bar. |
| E8.3 | Property test: incremental append over a series equals a full rebuild of the same series. |
| E8.4 | A correction to a historical bar triggers a rebuild whose result equals a fresh computation over the corrected data, and downstream breadth is invalidated (`04` §5.14). |

### Phase 9 — Chart APIs and UI

**Goal.** Analysts can read every timeframe as candlestick or Renko, with volume, overlays and indicator panes,
over large histories, without the client computing anything.

**Deliverables.**

- `GET /charts/{instrumentId}` bundle (`05` §12.3) with ETags (`05` §7).
- SPA chart workspace on TradingView Lightweight Charts v5 (ADR-011): candlestick and Renko views; volume
  pane; SMA, EMA and Bollinger overlays; RSI and ADX/DMI panes; Fibonacci levels; timeframe switcher for
  `15m`, `60m`, `75m`, `120m`, `240m`, `1D`, `1W`, `1M`, `3M`, `1Y`; zoom, crosshair, tooltips; backward
  historical loading by cursor; saved views.
- Markets screen: instrument search and per-exchange lists.
- Chart data export as CSV (`05` D-05-12).

**Exit criteria.**

| ID | Criterion |
|---|---|
| E9.1 | Both chart budgets of `04` §10.1 are met at p95 on staging. |
| E9.2 | E2E: open a chart, change timeframe, add an overlay, open the Renko view, change brick size, load older history. |
| E9.3 | A component test asserts that a price shown in a tooltip equals the API's decimal string exactly (no binary floating-point rounding on display). |
| E9.4 | Requesting `RAW` prices together with indicators returns the catalogued validation error (`05` D-05-15). |
| E9.5 | A 2,000-bar `15m` chart with three overlays pans and zooms at 60 frames per second on the reference workstation (Chrome performance trace). |

### Phase 10 — Sector and breadth engine, dynamic groups

**Goal.** Breadth — the percentage of eligible group members whose latest Renko brick is positive (`04` §6.1) —
is computed daily, weekly and monthly per brick size, with its 5-day SMA, for sector, index and dynamic groups.

**Deliverables.**

- Dynamic group rules resolving membership as of a date; group builder screen.
- Breadth eligibility, computation and moving average (`04` §6); `an.breadth_snapshot`; job
  `analytics.compute_breadth`; `GET /breadth` (`05` §12.5).
- Sector performance read model; Sectors and Breadth screens.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E10.1 | The worked example of `04` §6.7 is a passing test. |
| E10.2 | Eligibility edge cases of `04` §6.2 (insufficient history, suspended or delisted member, member joining mid-window) each have a test. |
| E10.3 | A dynamic group resolved twice for the same date returns the same members, and membership changes are visible only from their effective date. |

### Phase 11 — RS Matrix

**Goal.** Relative strength is the ratio-of-returns methodology of `04` §7, computed for every supported pairing,
ranked, with leaders and laggards identified by the stated rule.

**Deliverables.**

- RS methodology (`04` §7.1–§7.3); pairings of `04` §7.4 (index vs index, stock vs index, index or stock vs
  gold, vs GS Composite, vs USD-INR, vs bonds, intra-group); ranking, percentile, leaders and laggards
  (`04` §7.5); trend of the RS line (`04` §7.6).
- `an.rs_snapshot`, `an.rs_value`; job `analytics.compute_rs`; `GET /rs/matrix` (`05` §12.6).
- RS Matrix screen.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E11.1 | The worked example of `04` §7.7 is a passing test. |
| E11.2 | Each pairing type of `04` §7.4 has a test with a hand-computed expected score. |
| E11.3 | The corporate-action gate of `04` §7.2 is enforced: an instrument with an unexplained price discontinuity is reported through the data-quality finding rather than silently ranked as a laggard. |
| E11.4 | The RS budget of `04` §10.1 is met at p95 for 500 members × 4 windows. |

### Phase 12 — Scanner engine

**Goal.** Scanners are stored, versioned definitions compiled from a condition registry to parameterised SQL,
never hardcoded in controllers (`04` §8.1).

**Deliverables.**

- Condition registry (`04` §8.3) including 52-week high, 52-week low, volume spike, Golden Cross, Open = Low,
  Open = High, and multi-timeframe conditions across `15m`, `60m`, `75m`, `1D`, `1W`, `1M`.
- Definition schema and validation (`04` §8.2, §8.8), universe resolution (`04` §8.4), SQL compilation
  (`04` §8.5), null semantics (`04` §8.6), system scanners (`04` §8.7) seeded from a versioned file.
- `scan.scanner_definition`, `scan.scanner_run`, `scan.scanner_run_result`; job `scanner.execute`; endpoints
  of `05` §12.7–§12.10; results export.
- Scanner builder screen generated from `GET /scanner-conditions`; results screen.

**Exit criteria.**

| ID | Criterion |
|---|---|
| E12.1 | Each system scanner has a deterministic dataset with a known match set, and the run returns exactly that set. |
| E12.2 | A fuzz test over definition trees proves the compiler never interpolates a client-supplied string into SQL: every value is a bind parameter and every identifier comes from the registry. |
| E12.3 | A multi-timeframe definition (`1D` Golden Cross and `60m` volume spike) returns the result that `04` §8.5–§8.6 specify for combined conditions. |
| E12.4 | A run that exceeds the statement timeout ends `FAILED` with the catalogued code and no partial result set. |
| E12.5 | Two concurrent edits to one definition: the second, without a current `If-Match`, receives `412` (`05` D-05-13). |
| E12.6 | The scanner budget of `04` §10.1 is met at p95. |

### Phase 13 — Dashboard

**Goal.** One page answers "what did the market do today": Nifty, Bank Nifty, sector performance, top 10 gainers
and losers, market summary, filters and quick chart access, entirely from precomputed aggregates.

**Deliverables.**

- `summary(date)` read model; dashboard endpoints of `05` §11.9; dashboard screen with filters by exchange,
  sector and group; quick links into Charts.
- The UAT script covering every navigation surface (used by PRG-26).

**Exit criteria.**

| ID | Criterion |
|---|---|
| E13.1 | The dashboard module imports no engine; a boundary test fails if it does (ADR-008). |
| E13.2 | The dashboard response carries one `asOf`, and every widget agrees with it (`05` Q-05-02 default). |
| E13.3 | Top 10 gainers and losers for a seed session equal a hand-computed list, including tie-breaking. |

### Phase 14 — Observability, performance and hardening

**Goal.** Everything that the gate (`07` §13) measures exists and has been exercised.

**Deliverables.**

- The metrics catalogue (`07` §4.4), alerts AL-01…AL-24 (`07` §4.7), the four dashboards (`07` §4.8), SLO
  reporting (`07` §4.9), tracing (`07` §4.6).
- Performance suite at production scale in pre-production (`07` §6.9), plan-regression checks, load test at
  the A3 profile.
- Nightly security stage (ZAP, Trivy, dependency audit, fuzzing) and the manual matrix M-01…M-12 (`06` §17.4);
  external penetration test executed and remediated (booked in week 10, R-16).
- Runbook exercises (`07` §8).

**Exit criteria.** PRG-10, PRG-11, PRG-12, PRG-13, PRG-14, PRG-17, PRG-19 and PRG-23 are evidenced, and the
10-day invariant window of PRG-04 has started on the full engine set.

### Phase 15 — Production deployment

**Goal.** The system is in production and the gate is passed in both of its passes (`07` §13.6).

**Deliverables.**

- Production compose file, reverse proxy with TLS and HSTS, secrets in `/run/secrets` (`07` §3.1), WAL
  archiving and nightly encrypted backups, off-host anchor export.
- Host hardening (`07` §7.9), two administrators with MFA, the ownership matrix signed.
- Deploy and rollback rehearsal on staging; first production deploy (`07` §7.10).
- Gate record `docs/release/gate-<version>.md` (`07` §14.2).
- Tauri v2 desktop wrapper loading the same bundle (ADR-012). Not gate-blocking.

**Exit criteria.** The pre-cut-over pass of `07` §13 is complete; cut-over has happened; the post-cut-over pass
is complete. Only then is the word "production-ready" permitted (`07` §1.3).

---

## 5. Effort, staffing and schedule

### 5.1 Team assumption

| Role | Allocation | Phases |
|---|---|---|
| Backend engineer A | 1.0 | All; leads engines (7, 8, 11) |
| Backend engineer B | 1.0 | All; leads the data path (2, 5, 6) and scanners (12) |
| Frontend engineer | 1.0 | From Phase 3; leads 9, 13 and every screen |
| QA / DevOps engineer | 0.5 | Golden datasets, E2E, CI, environments, Phases 14–15 |
| System owner (business) | Reviews | E1.3, E1.4, E1.5, phase demos, PRG-26, PRG-27 |

### 5.2 Effort by phase (engineer-days)

| Phase | Backend | Frontend | QA/DevOps | Total |
|---|---|---|---|---|
| 1 Architecture and domain model | 6 | 1 | 1 | 8 |
| 2 Database and migrations | 9 | 0 | 1 | 10 |
| 3 Auth, authorization, audit, jobs | 10 | 3 | 2 | 15 |
| 4 Reference data | 8 | 3 | 1 | 12 |
| 5 Ingestion | 13 | 4 | 3 | 20 |
| 6 Canonical time-series | 9 | 0 | 2 | 11 |
| 7 Indicators | 8 | 0 | 2 | 10 |
| 8 Renko | 7 | 0 | 2 | 9 |
| 9 Charts | 4 | 12 | 2 | 18 |
| 10 Breadth and dynamic groups | 6 | 4 | 1 | 11 |
| 11 RS Matrix | 6 | 4 | 1 | 11 |
| 12 Scanners | 9 | 6 | 2 | 17 |
| 13 Dashboard | 3 | 5 | 1 | 9 |
| 14 Hardening | 9 | 2 | 3 | 14 |
| 15 Production deployment | 6 | 3 | 2 | 11 |
| **Total** | **113** | **47** | **26** | **186** |

The 186 engineer-days are build effort. Review, rework from review, meetings and defect fixing are not
itemised; they are why the calendar below assumes roughly 65 % productive utilisation of the 3.5-person team.

### 5.3 Calendar

| Weeks | Backend A | Backend B | Frontend | Elapsed-time evidence |
|---|---|---|---|---|
| 1–2 | Phase 1 | Phase 1 | Phase 1 review | |
| 2–3 | Phase 2 | Phase 2 | SPA scaffold against contracts | |
| 4–5 | Phase 3 | Phase 4, then Phase 3 job runtime | Phase 3–4 screens | |
| 6–7 | Phase 5 | Phase 5 | Imports and job screens | Pre-production host live; PRG-05 parallel run starts (end of week 7) |
| 8 | Phase 6 | Phase 6 | Markets screen | |
| 9–10 | Phase 7 | Phase 8 | Phase 9 chart workspace | Penetration test booked (week 10) |
| 11–12 | Phase 9 API, then Phase 11 | Phase 10 | Phase 9, then Phase 10–11 screens | PRG-05 reaches 20 trading days (about week 11–12) |
| 12–13 | Phase 12 | Phase 12 | Scanner builder | PRG-04 10-day window starts when Phase 12 lands |
| 14 | Phase 14 | Phase 13, then Phase 14 | Phase 13 | Penetration test executed |
| 15 | Phase 14 | Phase 14 | Fixes, performance | PRG-04 window completes |
| 16 | Phase 15 | Phase 15 | Desktop wrapper | Cut-over at end of week 16 (about day 80) |
| 17 | Post-cut-over pass | Post-cut-over pass | UAT fixes | First production nightly; second weekly drill; gate closes (about day 85) |
| 18–19 | Contingency | Contingency | Contingency | About 10 working days (about 12 %) to day 95 |

**Critical path:** Phase 1 → 2 → 3 → 5 → 6 → 7 → 12 → 14 → 15 → post-cut-over pass. Phases 4, 8, 9, 10, 11 and 13
run beside it. A slip on the critical path moves the gate one-for-one; a slip of up to about one week in any
side phase does not.

### 5.4 Comparison with the 95-day reference

The source specification estimates 95 working days. This plan reaches cut-over at about day 80 and a closed gate
at about day 85, leaving about 10 days of contingency within the 95. That holds **only** with the team in §5.1.

| Variation | Effect |
|---|---|
| One backend engineer instead of two | Critical path grows by roughly 35 working days; the gate closes near day 120 |
| No dedicated frontend engineer | Phases 9–13 serialise behind backend work; roughly +30 working days |
| Corporate-action feed not available at Phase 4 (R-04) | Phase 11 cannot exit (E11.3, PRG-08); RS ships last, up to +15 days |
| Data-source licence unresolved at Phase 1 (R-03) | The pre-production parallel run cannot start; the gate moves by the delay one-for-one |
| Penetration test booked late (R-16) | Typical lead time is 3–4 weeks; booking after week 10 moves the gate |

The 95-day figure is a reference, not a constraint: if a variation above occurs, the gate date moves; the gate
does not shrink.

---

## 6. Risk register

Likelihood (L) and impact (I) are `L` low, `M` medium, `H` high. "Signal" is what tells us the risk is
materialising before it has done damage.

| ID | Risk | L | I | Mitigation in the design | Signal | Owner phase |
|---|---|---|---|---|---|---|
| **R-01** | **Nightly pipeline exceeds its budget at the assumed universe.** A2 assumes about 10,000 active instruments; `04` §10.1 places the single-host ceiling near 6,000 instruments within the 60-minute budget. | H | H | Bars are stored for every instrument, but analytics (indicators across all timeframes, Renko sets, scanners) run for the **covered universe**: members of any index, sector group or market group plus F&O underlyings. If the covered universe still exceeds the ceiling, a second worker host joins the same database (workers scale through `SKIP LOCKED`, ADR-009), which is the first trigger of `00` §9.2. | E7.4 extrapolation; AL-08 in pre-production | 7, 14 |
| **R-02** | **PostgreSQL on one host is a single point of failure** (ADR-003). | M | H | WAL archiving (RPO 15 minutes), nightly encrypted base backups, weekly restore drills inside the 2-hour RTO, raw import files retained so market data is reproducible (`07` §7.7, AF-01). A streaming replica is the first horizontal step when the availability SLO is missed twice in a quarter. | AL-15; drill durations trending toward 90 minutes | 15 |
| **R-03** | **Data licensing and legitimate availability.** Exchange EOD files and vendor APIs carry terms that may restrict automated retrieval, storage or internal redistribution; MCX, NCDEX and NFO data may require a paid vendor licence; a legitimate API may not exist for a given exchange. | H | H | Manual CSV upload is the primary path; pull adapters are enabled per source only after E1.5 records the licence; no scraping, and no URL-fetching adapter without the controls of `06` DEF-05; PRG-21 blocks the gate. | E1.5 incomplete at Phase 2 start | 1, 5 |
| **R-04** | **Incomplete corporate actions** produce false Renko reversals, wrong 52-week statistics and false RS laggards. | H | H | Phase 4 blocker (`04` §7.2, E4.4); `UNEXPLAINED_JUMP` data-quality findings (`03` §8); adjusted prices by default (`05` D-05-15); PRG-08. | Rising `UNEXPLAINED_JUMP` count; RS `adjusted_instruments` below the feed's count | 4, 11 |
| **R-05** | **Source format drift** — an exchange changes a column, a date format or an encoding without notice. | H | M | L1 validation fails the whole batch loudly (`03` §3.1); adapters are versioned with golden sample files; the previous session's data stays served and marked stale (`07` AF-04). | AL-19 source staleness; L1 failures | 5 |
| **R-06** | **Indicator values disagree with users' reference tools** because of seeding, warm-up or current-bar conventions, and users lose trust. | M | M | Methodology fixed in `04` §3 and signed off (E1.3); tolerance-based cross-checks (`04` §11.4, PRG-03); engine version constants exposed and audited (`04` §12.1). | Analyst-reported discrepancies during demos and UAT | 1, 7 |
| **R-07** | **A multi-tenant requirement emerges.** | L | H | Rejected by A1; a second organisation is a second deployment (`06` DEF-12). If one deployment must serve two organisations, the change is a re-architecture — a tenant discriminator on every table, row-level security, every query reviewed — and is planned as a project, not a phase. | A contract naming shared hosting for a second organisation | — |
| **R-08** | **Renko, breadth or scanner semantics differ from the product owner's intent.** The source specification names brick sizes and scanner names but not the rules. | M | H | The rules are explicit in `04` §5, §6 and §8 and signed off with worked examples before Phase 8 (E1.3). | "Why is this brick here" questions in Phase 9 demos | 1, 8 |
| **R-09** | **Inter-market proxies unavailable or unlicensed** — gold, silver for the GS Composite, USD-INR, bond indices. | M | M | Proxies are reference-data configuration (A11, `04` §7.8); a pairing whose proxy has no data is reported as unavailable, never as a computed score; a vendor composite can replace the synthetic one without downstream change. | E1.5 shows no source for a proxy | 1, 11 |
| **R-10** | **Intraday history growth** — 15-minute bars reach about 187 million rows in three years (`00` §9.1). | M | M | Monthly partitions with runway monitoring (AL-13), the retention purge job, and the `00` §9.2 trigger to evaluate columnar storage at 500 million rows or 500 GB. | Partition sizes, vacuum lag, disk alerts | 2, 14 |
| **R-11** | **Small team and key-person dependency.** | H | M | Two-person gate (`07` §14.1), runbooks written as commands (`07` §8), ADRs for every decision, rotation of engine ownership between the two backend engineers. | One person is the only reviewer for a package | All |
| **R-12** | **The live-data increment needs latency the monolith cannot give.** | L | M | `MarketDataPort.subscribeBars` is declared in v1 (`00` §5.1); DIAGRAM 12 fixes the live path; ingestion and analytics already run as separate processes, so extraction is a transport change (`00` §9.3). | A licensed live feed is contracted | — |
| **R-13** | **Scope growth** — sharing, more indicators, options analytics, alerts and notifications. | H | M | Deferred surfaces are recorded (`05` §13); every addition needs a specification section and a phase in this plan before code (§9). | Requests arriving during UAT | All |
| **R-14** | **Session and timezone errors** — special sessions, Muhurat trading, the MCX evening session, half days. | M | H | Sessions are calendar data, never code (A8); bucketing property tests across every calendar in the seed (E6.2); E4.2. | Partial-bar or gap findings on special-session days | 4, 6 |
| **R-15** | **Charting-library licence obligation** — Lightweight Charts is Apache-2.0 and requires its attribution notice to be shown. | L | L | Attribution in the chart footer and the About screen; version pinned; licence listed in the SBOM. | Licence check in CI stage 5 | 9 |
| **R-16** | **Schedule risk from elapsed-time items** — penetration-test lead time, the 20-trading-day parallel run, exchange holidays inside the window. | M | M | Pre-production starts at Phase 5 exit (S5); penetration test booked in week 10; contingency of about 10 days (§5.4). | Parallel-run day count behind plan by more than 3 days | 5, 10, 14 |
| **R-17** | **Decimal precision lost in the browser** — a price passes through a JavaScript `number`. | M | H | Decimal strings on the wire (ADR-005, `05` §4.1), decimal-discipline lint (E1.2), contract drift test, display test (E9.3). | Any contract field typed as `number` for a price | 1, 9 |

The residual risks of the security architecture are in `06` §19.2; both registers are accepted together under
PRG-27.

---

## 7. Assumption validation

Each assumption of `00` §2 is proven or disproven by a named phase. A disproven assumption stops that phase until
the ADR amendment is made.

| Assumption | Proven or disproven by | Evidence |
|---|---|---|
| A1 Single tenant | Phase 1 | E1.4 sign-off |
| A2 Universe and history size | Phases 5, 7 | E5.5 throughput; E7.4 extrapolation (R-01) |
| A3 Users and load | Phase 14 | PRG-12 load test |
| A4 Indian exchanges, IST, no DST | Phases 4, 6 | E4.2, E6.2 |
| A5 EOD is the correctness anchor | Phases 5, 6 | E5.3, E6.4 |
| A6 No real-time feed in v1 | Phase 1 | E1.5 data-source decision |
| A7 Corporate actions supplied as data | Phase 4 | E4.4 |
| A8 Calendars are data | Phase 4 | E4.2 |
| A9 Single region; RPO 15 min, RTO 2 h | Phase 15 | PRG-15, PRG-16 |
| A10 Trusted staff users | Phases 3, 14 | E3.1; PRG-19 penetration test |
| A11 GS Composite is synthetic | Phases 4, 6, 11 | Proxy configuration (Phase 4), composite bars (Phase 6), E11.2 |

---

## 8. Definition of done for every phase

A phase is done when all of the following hold, and the completion note
`docs/release/phases/phase-<nn>.md` records each with a link:

1. Every exit criterion of the phase is evidenced.
2. CI stages 1–7 (`07` §6.13) are green on the merge commit; coverage floors (`07` §6.14) hold.
3. The release is deployed to staging (and, from Phase 5, to pre-production) by the procedure of `07` §7.3.
4. Where implementation diverged from the specification, the specification was changed in the same pull
   request as the code, with an ADR amendment where a decision changed.
5. Open questions owned by the phase (`05` §17) are resolved, or resolved by their default, and recorded.
6. Phases with user-visible surfaces (3, 4, 5, 9–13) have been demonstrated to the system owner.
7. No `TODO`, `FIXME` or skipped test exists without a linked issue and an owning phase.

---

## 9. Changing this plan

- The plan changes by pull request to this document, reviewed like code.
- Reordering phases requires showing that the `04` §1.5 dependencies and S1–S6 still hold.
- The estimate is re-baselined with actuals at the exits of Phase 6 and Phase 12. A variance above 15 % on the
  critical path is reported to the system owner with the revised gate date, not absorbed silently.
- A new feature is added to the plan only after its behaviour is specified in `00`–`07`.
