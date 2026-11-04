# Phase 2 completion note — Database and migrations

Status: **ENGINEERING COMPLETE, CI NOT YET RUN**. E2.1–E2.5 are evidenced on a local PostgreSQL 18 cluster.
`08` targets PostgreSQL 16, and the CI stage-4 job that runs the same suite on PostgreSQL 16 has not run yet,
because the repository has no remote. Phase 1 is still open on its owner sign-offs (E1.3–E1.5); this phase was
started on request before they were given.

## Delivered

| Deliverable (`08` §4, Phase 2) | Location |
|---|---|
| Forward-only migration runner: checksums, advisory lock, refusal on edited, missing or out-of-order files, self-created ledger | `packages/db/src/migrate.ts`, CLI `pnpm db:migrate` |
| DDL of `02` §5 for all seven schemas, generated from the specification's SQL blocks | `packages/db/migrations/0001`–`0009` |
| Functions of `02` §7 | `0002_functions.sql` |
| Trigger attachments of `02` §7, the deferred session check (INV-19, BR-011, BR-012), INV-13 | `0010_integrity.sql` |
| Monthly partitions with three months of runway; history from January 2015 for bars and indicators | `0011_partitions.sql` (`ops.ensure_monthly_partitions`) |
| Structural seed: 10 timeframes, 41 permissions, 4 system roles, 86 role grants (`00` §4.2), 7 settings | `0012_structural_seed.sql` |
| Least-privilege grants (`02` §2, INV-14) | `0013_grants.sql`; roles in `infra/postgres/roles.sql` |
| Deterministic development seed | `packages/db/src/seed-dev.ts`, CLI `pnpm db:seed:dev` |
| Scratch-database test harness | `packages/testing` |
| Local PostgreSQL 16 | `infra/compose/docker-compose.dev.yml` (not run: Docker is not installed here) |
| CI stage 4 on a PostgreSQL 16 service container | `.github/workflows/ci.yml` |

## Exit criteria

| ID | Status | Evidence |
|---|---|---|
| E2.1 | **Met locally** | `migrate.integration.test.ts`: after migrating an empty database, every table and column (name, type, nullability) equals the DDL parsed from `02` §5, and `ops.schema_migration` holds each version once. |
| E2.2 | **Met locally** | Same file: tests 1 and 3–6 of `07` §6.10 pass, including two concurrent runners applying each migration exactly once and a refused run after an applied file was edited. Test 2 is skipped because no previous release exists. |
| E2.3 | **Met locally** | `constraints.integration.test.ts`: each of the 37 constraints and unique indexes on `md.market_bar`, `md.import_batch` and `ref.instrument` is violated once and rejected under its own name. A coverage test compares this list with the catalogue, so a new constraint without a negative test fails. |
| E2.4 | **Met locally** | `seed.integration.test.ts`: two seeds into separate databases produce identical per-table fingerprints over 15 tables. |
| E2.5 | **Met locally, partially** | Daily and 15-minute bar reads for one instrument use only primary-key indexes, no sequential scan, and only the partitions of the requested range. The other `02` §11 queries need production-scale data; they move to Phase 14. |

Local run (Windows 11, PostgreSQL 18.6 in a throwaway cluster, Node 24.19.0):

| Stage | Result |
|---|---|
| 1. Static | typecheck, lint, format clean |
| 2. Unit | 48 passed |
| 3. Contract | 3 passed |
| 4. Integration | 51 passed, 1 skipped (`07` §6.10 test 2), from two runs: the full suite, where one case failed only because a partition reports its own PK index name; then the constraint and migration suites again after that expectation was corrected. The full run took **8.8 minutes**, over the 6-minute budget of `07` §6.13. |

## Specification defects found and fixed

| Defect | Fix |
|---|---|
| `ops.domain_event` was range-partitioned but declared `uq_domain_event` without the partition key, which PostgreSQL rejects | Unpartitioned, with retention by batched delete (`02` §5.6, §6; DIAGRAM 6a; `07` RB-06) |
| `ops.schema_migration` was DDL in a numbered migration, but the runner must record the first migration | The runner creates it (`02` §8) |
| `02` §8 said exchanges are structural seed; §9 seeds them by script with dev-only sessions | Exchanges are script-seeded (`02` §8) |
| `02` §9 dev seed: 3 years of calendar cannot hold 800 sessions | 4 years |
| `02` §9 dev seed listed scanner codes that differ from `04` §8.7, which seeds system scanners in Phase 12 | No scanners in the dev seed |
| `02` §9 dev seed: duplicate, invalid-OHLC and negative-volume rows cannot exist in `md.market_bar` | Moved to a Phase 5 ingestion CSV fixture; the missing trading day stays in the database |
| `02` §11: "2,000 daily bars … 1 partition" is impossible with monthly partitions | Pruned to the requested range |
| ADR-004 said Drizzle drives migrations; `02` §8 specifies numbered SQL files | ADR-004 reworded |
| `08` E2.1 "schema hash" and E2.4 "byte-identical dump" were unattainable (a hash varies by major version; password salts are random) | Reworded to what the tests prove |

## Decisions recorded

- The deferred session-check trigger and the INV-13 trigger are this phase's authored SQL; `02` §7 described them
  in prose only.
- `breadth.min_history_bars` defaults to 1, matching `04` §6.2. The specification gives no value.
- `ingestion.max_file_bytes` defaults to 200 MB per `03` §3.1. It still conflicts with `UPLOAD_MAX_BYTES` (20 MiB)
  in `07` §3.4; this must be resolved before Phase 5.
- Dev-seed users get Argon2id hashes with `06` §4.4 parameters through Node's built-in `crypto.argon2Sync`.
  Phase 3 owns password hashing.
- No Testcontainers: the harness takes `TEST_DATABASE_URL`. It skips locally when that is unset and fails in CI.

## Open

- **CI on PostgreSQL 16 has not run.** A constraint trigger on a partitioned table, `pg_constraint` contents and
  plan shapes are the likeliest version differences.
- **Stage 4 is 8.8 minutes locally.** The seed takes 165 s per run and runs twice; about 30 s of that is the
  deferred session check, and most of the rest is the bulk insert with foreign-key checks over about 800,000 bars.
  If CI is also over budget, move the double-seed comparison (E2.4) to the nightly stage 8.
- `docker-compose.dev.yml` is untested.
