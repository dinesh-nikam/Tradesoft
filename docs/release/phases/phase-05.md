# Phase 5 — CSV/EOD ingestion, validation and reconciliation

Plan: `docs/architecture/08-implementation-plan.md` §4, Phase 5.

## What exists

**Raw files** (`packages/db/src/ingestion/storage.ts`, ADR-020, `06` §11).

- An upload is streamed to `{IMPORT_ROOT}/imports/{yyyy}/{mm}/{uuid}.csv` under a generated name.
- The same pass computes SHA-256, counts bytes against the limit, checks the first 512 bytes for a null
  byte, and checks that the file is valid UTF-8.
- The extension and the declared MIME type are checked when the file closes.
- A refused or duplicate file is deleted at once, not left for a janitor.
- `IMPORT_ROOT` (default `data`) is a new config key in `07` §3.4. `UPLOAD_MAX_BYTES` is now capped at
  200 MiB.

**Validation** (`ingestion/bars.ts`).

- **Adapters:** `csv.generic.eod` plus the four bhavcopy layouts of `03` §1.1. They map headers by alias;
  a source's `config.fieldMap` overrides them (vendor header mode), and the NSE legacy `DD-MMM-YYYY` date is
  read.
- **L1 (file):** `FILE_EMPTY`, `ROW_COUNT_EXCEEDED`, `HEADER_MISSING_REQUIRED`, `HEADER_AMBIGUOUS`.
- **L2 (row):** every code in `03` §3.2.
- **L3 (across rows):** `DUPLICATE_IN_FILE` and `SERIES_CONFLICT`. A row's identity is read before its
  values, so a repeat is a duplicate whatever else is wrong with either row.
- **No silent fixes:**
  - An absent value is never zero.
  - A price with more than four decimal places is refused rather than rounded.
  - Comparisons use exact fixed-point arithmetic.
- **Symbol lookup:** all symbols are resolved in one query (`resolveSymbols`). `resolveSymbol` now calls the
  same query, so the two cannot drift apart.

**Persistence** (`ingestion/pipeline.ts` `ingestBars`, the `MarketDataPort.ingestBars` of `03` §1).

- **Single writer:** it is the only code that writes `md.market_bar`.
- **One transaction per batch:** bars pass through a temporary staging table into one insert and one update.
- **L4 checks:** decided under the new per-exchange lock `tradesoft:persist:{exchangeId}` (`03` §7.2):
  - `CONFLICTING_VALUES` also raises an `ERROR` `SOURCE_CONFLICT` quality issue.
  - `STALE_REVISION`.
  - `IDENTICAL_ROW` is counted as unchanged.
  - A missing previous session raises a `WARN` `GAP_DETECTED` quality issue.
- **Corrections:** a correction raises the revision and marks the bar `CORRECTED`; the history trigger keeps
  the old row. Any other batch never changes a stored price.
- **Domain events:** `batch.persisted` and `bars.changed`.

**Reconciliation** (`reconcileBatch`). Runs the six L5 checks of `03` §3.5:

- **What it compares:** the file is re-read and compared with what is stored.
- **On failure:** the batch moves to `RECONCILIATION_FAILED` without rolling back its bars, and
  `errorSummary.checks` lists every check.

**Jobs** (`ingestion/handlers.ts`).

- The three jobs are `ingestion.parse_validate`, `ingestion.persist_bars` and `ingestion.reconcile`, with
  the attempts, delays and keys of `03` §5.3.
- They are chained by the outbox events `import.received`, `batch.validated` and `batch.persisted`, and the
  worker registers them.
- **Re-runs:** each step locks its batch, and a re-run of a finished step does nothing.
- **Failures:**
  - A refusal by the database is deterministic and ends the batch in `PROCESSING_FAILED`.
  - Anything else is retried with backoff.
  - A missing file dead-letters.

**API** (`apps/api/src/routes-ingestion.ts`, `05` §11.6, §12.11–12.13).

- **Sources:** `GET` and `POST /ingestion/sources`, `PATCH /ingestion/sources/{id}`. The config schema is
  strict, so secret keys are refused before the database check.
- **Uploads:** `POST /ingestion/uploads` reads multipart with a streaming reader of its own
  (`multipart.ts`), because no multipart library is installed.
  - **Idempotency:** `Idempotency-Key` is required. A retry with the same key and the same file replays with
    `200` and `Idempotent-Replay: true`; the same key with another file returns `IDEMPOTENCY_KEY_REUSED`.
  - **Duplicates:** the same file under a new key returns `409 IMPORT_DUPLICATE_FILE` with
    `existingBatchId` and `Location`.
  - **Other refusals:** `IMPORT_FILE_INVALID`, `PAYLOAD_TOO_LARGE`, `IMPORT_SOURCE_INACTIVE`,
    `INGESTION_CONCURRENCY_LIMIT`.
  - **REFERENCE uploads:** `batchType=REFERENCE` with `referenceKind` runs the Phase 4 importer on the
    stored file and links the file to its batch. This closes a Phase 4 open item.
- **Corrections:** `POST /market-data/corrections` needs `marketdata:correct` and a justification of 20 to
  1,000 characters.
  - The file is checked before the batch is created: a file whose every row is refused returns
    `CORRECTION_NO_ROWS`.
  - The audit row carries the justification, the file hash and the rows per instrument.
- **Batches:**
  - `GET /ingestion/batches` (filtered list) and `GET /ingestion/batches/{id}` (the `05` §12.12 document,
    with `unchangedBars` and `supersededByBatchId`).
  - `GET .../rejects`, paged by a row-number cursor, and `GET .../rejects.csv`, which applies the
    formula-injection guard of `06` §10.4.
  - `POST .../reconcile` (a `PROCESSING` batch only; it retries a dead-lettered reconcile job) and
    `POST .../reprocess` (a new batch over the same file that supersedes the old one; a correction also
    needs `marketdata:correct`).

**SPA.**

- **Imports screen:** upload, batch list that refreshes while batches run, batch detail with the L5 checks,
  rejects (paged, CSV download), reprocess, reconcile, correction, and data sources.
- **Jobs screen** (new nav entry, `job:read`): list by status, detail with the last error and the attempt
  history, retry and cancel.

**Schema.** Migration `0016_import_batch_timeframe` adds:

- `md.import_batch.timeframe`, the timeframe an `INTRADAY_CSV` upload declares, which every row must match.
- `header_line`, which locates rows (`03` §2.2).

## Evidence

**Pipeline:** `packages/db/test/ingestion.integration.test.ts` has 10 tests, all passing against
PostgreSQL 18.

- **E5.1:** one fixture holds a row for every L2 and L3 code, each refused with its code. The L1 header
  failures, the oversized, binary, non-UTF-8, wrongly typed and empty files, and an intraday batch's
  timeframe and session rules are covered too.
- **E5.3:** an identical re-import changes no bar, and a value change is refused as `CONFLICTING_VALUES`.
  A correction moves the bar to revision 2 with history, and a later plain file is `STALE_REVISION`.
- **E5.4:** a changed header fails at L1, and no row is stored.
- **E5.5:** 10,000 rows are validated, persisted and reconciled in about 14 s on a workstation, against the
  60 s limit.
- **E5.6:** a persist rolled back before commit leaves no bar and the batch in `VALIDATED`, and the retried
  step completes it.
- **L5:** turnover drift and an incomplete universe both fail reconciliation while the bars stay.
- **End to end:** an upload goes through the outbox and a real worker to `COMPLETED`.

**API:** `apps/api/test/ingestion.integration.test.ts` has 8 tests, all passing.

- **E5.2:** a retry with the same key replays, and a reused key is refused. The same file uploaded twice at
  once yields one `202` and one `409` naming the first batch, and the losing copy is removed from disk.
- **Also covered:** sources, rejects and the CSV export, bad files and form fields, corrections with their
  audit, reprocess and reconcile, and REFERENCE uploads.

## Changes to the specification

- **Audit action names:** the audit table allows only `entity.verb`. So the action
  `marketdata.correction.submitted` is now `marketdata.correction_submitted`, and the ingestion actions are
  `ingestion.batch_retried` and `ingestion.batch_reconciled` (`05`, `06`, `07`). `import.uploaded` and
  `data_source.*` are added to `06`.
- **Lock namespace:** `03` §7.2 gains the persist lock.
- **Upload checks:** `06` §11.1 lists header and row checks before the batch insert. Here they run in
  `parse_validate` after the `202`, as `03` §5.3 and E5.4 expect: a header failure is a `VALIDATION_FAILED`
  batch, not a `422` on upload. Corrections are the exception; they are checked before the batch exists, so
  `CORRECTION_NO_ROWS` comes back synchronously.

## Shortcuts, each marked in the code

- **`unnest` instead of `COPY`:** bars reach the staging table through `unnest` in chunks of 5,000, because
  no COPY client is installed.
- **Whole-file reads:** the worker reads the whole file (at most 200 MiB) into memory to parse it, and does
  so once per step.
- **Per-process limits:** the one-upload-in-flight limit is held per API process.
- **Unverified layouts:** the bhavcopy column names are `VERIFY_BEFORE_PROD`.

## Open

- **Vendor pulls:** `POST /ingestion/pulls`, `ingestion.pull_source` and the `api.vendor.rest` adapter need a
  licensed vendor and its API, so neither the route nor the job exists yet.
- **Environments:** the staging environment and the production host in pre-production mode (`07` §3.1,
  S5) are infrastructure work outside this repository. E5.5 is therefore measured on a workstation, not on
  staging.
- **Licences:** `docs/release/data-sources.md` lists the expected sources; every licence is still
  unconfirmed (PRG-21).
- **Dead-letter state:** a `parse_validate` or `persist_bars` job that dead-letters leaves its batch where it
  was (`RECEIVED` or `VALIDATED`), so a job retry from the Jobs screen resumes it. The batch is not moved to
  a failed state, because a terminal batch could not then be resumed.
- **Janitor:** there is no janitor for files left by a crash between writing and the database insert
  (`06` §11.1).
- **`RECON_INCOMPLETE_UNIVERSE`:** "traded" is taken to mean "has a bar for the previous session". A
  partial EOD file therefore fails reconciliation by design.
- **Not tried in a browser:** the Imports and Jobs screens are checked by typecheck and build only.
