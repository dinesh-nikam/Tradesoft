# TradeSoft — Operations, Testing and Production Readiness

> **Status:** specification. No application code exists yet.
> **Audience:** whoever deploys, operates and proves this system — which, for the first year, is the same
> small team that builds it (A12).
> **Position in the set:** documents `00`–`06` describe what the system *is*. This document describes how
> it is *proven* and how it is *run*, and it owns the production-readiness gate that every other document
> defers to.

---

## 1. Purpose and scope

### 1.1 What this document decides

This document is the authority for six things:

1. **Observability.** What is emitted, with which names, at which cardinality, and what each signal is
   allowed to page a human for.
2. **Audit operations.** How the three audit streams are produced, retained, verified, queried and
   archived — including the procedures `06` explicitly delegates here.
3. **Testing.** The test taxonomy, what each layer is allowed to claim, and the CI gates that block a
   merge or a release.
4. **Deployment.** How a release reaches production, how it is rolled back, and which releases cannot be
   rolled back at all.
5. **Runbooks.** The diagnosis-and-action sequences for the failures that will actually happen, written
   as commands rather than as advice.
6. **The gate.** A numbered, evidence-backed checklist that is the *only* thing that permits the word
   "production-ready" to be used about this system.

### 1.2 Relationship to the other documents

| Document | Owns | This document adds |
|---|---|---|
| `00` | Architecture, ADRs, capacity model, deployment topology | How that topology is operated, and what breaks first |
| `01` | Domain rules, state machines, invariants | How invariants are monitored rather than merely asserted |
| `02` | Physical schema, partitioning, backup/recovery | Restore drills, partition runway monitoring, migration procedure |
| `03` | Ingestion pipeline, job catalogue, retry, concurrency | Job SLOs, dead-letter operations, ingestion runbooks |
| `04` | Engine mathematics, watermarks, performance budgets | Budget enforcement in CI, freshness SLOs, recompute runbooks |
| `05` | Wire contract, error codes, rate limits | Which error codes are alertable, and what an operator does about each |
| `06` | Security controls, threat model, incident response | Host hardening runbook, audit verification schedule, readiness gate expansion |

This document does not restate the security controls. Where a control is defined in `06`, this document
says *when it is exercised* and *what evidence proves it was exercised*. A control with no scheduled
exercise is a claim, not a control.

### 1.3 The three words that are banned without evidence

| Word | Permitted only when |
|---|---|
| "works" | A test at the layer that can observe the behaviour has run on the release commit |
| "monitored" | A named metric, alert, runbook and owner exist for it (§4.4, §4.7, §8) |
| "production-ready" | Every gate item in §13 is satisfied with linked evidence, not assertion |

The third is the important one. §13 is deliberately a checklist of *artefacts*, not a checklist of
feelings. If an item cannot be evidenced, the system is not production-ready and the honest thing to say
is "Phase *n*, not launched".

---

## 2. Operating model

### 2.1 The constraint that shapes every operational decision

**A12 — Operations are run by the building team, in IST business hours, with no 24×7 rota.**

| | |
|---|---|
| **Assumption** | One to three engineers build and operate the platform. Coverage is 08:00–20:00 IST on trading days, best-effort outside it. There is no follow-the-sun rotation and no dedicated SRE. |
| **Consequence** | Overnight failures must be **self-healing or safely deferred**, never paging. The nightly pipeline must complete unattended or fail into a state that can wait until morning without corrupting data. Alerts must be actionable by one person with a laptop and the bastion, at 07:30, in under fifteen minutes. |
| **If wrong** | Alerts are re-routed and thresholds tightened; no architectural change. |

Three rules follow directly, and they explain most of the choices in this document:

1. **Prefer retry over paging.** A transient database restart must be absorbed by exponential backoff
   (`03` §5.2), not by waking someone. Anything that pages overnight must be either data-destroying or
   unrecoverable-by-retry.
2. **Fail safe, stay up, tell the truth.** A stale dashboard is acceptable; a wrong number presented as
   fresh is not. Every surface that can be stale says so (`stale: true`, watermark columns,
   `/dashboard/freshness`) instead of silently serving the last known value.
3. **No alert without a runbook and an action.** An alert whose only possible response is "look at it and
   worry" is deleted. §8 exists because §4.7 is not allowed to reference a runbook that does not exist.

### 2.2 Ownership matrix

Every component has one named owner role and one first signal. "First signal" is the thing that should
tell you the component is sick *before* a user does — if the answer is "a user complains", the
observability for that component is incomplete.

| Component | Failure that matters | First signal | Owner role | Runbook |
|---|---|---|---|---|
| `api` | 5xx, latency, auth failures | `tradesoft_http_request_duration_seconds` p95, `tradesoft_http_requests_total{status=~"5.."}` | Backend | RB-01, RB-02 |
| `worker` | Job backlog, dead letters, pipeline staleness | `tradesoft_job_queue_depth`, `tradesoft_pipeline_lag_seconds` | Backend | RB-05, RB-08 |
| `scheduler` | Missed schedules, double-fire | `tradesoft_scheduler_heartbeat_age_seconds`, `tradesoft_scheduler_fires_total{result="duplicate"}` | Backend | RB-05 |
| PostgreSQL | Connections, locks, bloat, disk, replication of WAL archive | `tradesoft_db_pool_in_use`, `pg_stat_activity` wait events, `tradesoft_pg_database_size_bytes` | Backend / DBA | RB-02, RB-07 |
| Reverse proxy | 502/504, TLS expiry, dropped uploads | `tradesoft_proxy_upstream_errors_total`, certificate `not_after` | Backend | RB-13 |
| Raw-import volume | Disk full, write failure, permission drift | `tradesoft_disk_free_bytes{mount="/data"}` | Backend | RB-07 |
| Backup pipeline | Missed base backup, WAL archive gap | `tradesoft_backup_age_seconds`, `tradesoft_wal_archive_failures_total` | Backend | RB-14 |
| Audit chain | Broken chain, missing anchor | `tradesoft_audit_chain_verify_failures_total`, `GET /admin/audit-events/verify` | Security owner | RB-10 |
| SMTP delivery | Silent reset failure | `tradesoft_mail_queue_oldest_age_seconds` | Backend | RB-15 |
| Derived analytics | Stale or inconsistent series | `tradesoft_watermark_lag_seconds{dataset}`, INV-D checks | Analytics | RB-05, RB-06 |
| Scanner engine | Slow scans, timeouts, wrong universe | `tradesoft_scanner_run_duration_seconds`, `stale_excluded` ratio | Analytics | RB-09 |

### 2.3 Alert priorities and response targets

Priority describes **what the alert demands**, not how bad the situation sounds. A single alert may be
P1 only if a human must act before the next market open.

| Priority | Meaning | Acknowledge | Act by | Notification |
|---|---|---|---|---|
| **P1** | Data correctness or availability will be violated before the next session, or is being violated now | 15 min during coverage; 4 h overnight | Before 08:00 IST | Page (push + SMS). Posts an incident record. |
| **P2** | A guarantee is degraded but the system is safe and self-healing may still work | 1 business hour | Same business day | Push notification, no SMS |
| **P3** | A trend that becomes P2 within days if unaddressed (disk, partition runway, dead-letter growth) | Next business day | Within 5 business days | Ticket |
| **P4** | Informational deviation worth a look at the next release | Next triage | Next release | Ticket |

P1 is reserved for: ingest write failures during a live session, reconciliation failures that leave
unverified bars visible, `/readyz` failing on more than one instance, audit chain verification failure,
restore unavailability, and TLS expiry inside 7 days. Everything else has a slower path, because a team
that is paged for P3 learns to ignore pages.

Incident severity is a separate ladder. `06` §18.1 defines **S1–S4** by attacker capability; §11.1 of
this document defines **INC-1…INC-4** for faults with no security cause and maps them onto S1–S4 when a
fault turns out to have one. An alert priority never *is* an incident severity: three P2 alerts can be
one INC-3, and one P1 alert can be an INC-1.

### 2.4 Change authority

| Change | Who may approve | Second person required |
|---|---|---|
| Application deploy from a green `main` | Any engineer | No |
| Forward-only migration adding tables/indexes/columns | Any engineer | No |
| Migration that rewrites or drops a column | Two engineers | Yes — reviewed diff plus a restore point |
| `maintenance.retention_purge` with `dryRun=false` | Two engineers | Yes — dry-run output attached to the ticket |
| Manual `DELETE`/`UPDATE` on `md.market_bar` | Nobody. Corrections go through the API (`05` §12.6) | n/a |
| Role or permission matrix change | Security owner | Yes — must update `packages/contracts/src/roles.ts` first |
| Break-glass database access | Two engineers, logged | Yes — `06` G-S8 rehearsal requirement |
| Changing an alert threshold | Owner of the affected component | No — but the change is a commit, not a dashboard click |

The last row matters: thresholds live in the repository (`infra/monitoring/alerts/*.yml`), not in a
monitoring UI. A threshold changed during an incident is the most common way an alert quietly stops
working, and a commit makes that visible in review.

---

## 3. Environments

### 3.1 The four environments

| | `local` | `ci` | `staging` | `production` |
|---|---|---|---|---|
| **Purpose** | Development loop | Proof per commit | Proof per release, and drills | Real use |
| **Runtime** | `docker compose` or native Node + local PG | Ephemeral containers per job | Same images as production, 1 replica each | Same images, `api` ×2, `worker` ×1–2, `scheduler` ×1 |
| **Database** | Local PG 16, disposable | Testcontainers PG 16, per job | PG 16, restored anonymised subset, refreshed weekly | PG 16 primary, WAL archiving, nightly base backup |
| **Data** | Deterministic seed (`02` §9) | Factories + golden fixtures | Anonymised subset, ≤ 50 instruments of real history where permitted, otherwise synthetic | Real |
| **Secrets** | `.env.local`, example values allowed | Generated per job, discarded | Real-shaped, distinct from production, mounted as files | `/run/secrets`, 0400, never in environment variables |
| **TLS** | None (http on localhost) | None | Self-signed or staging certificate | ACME-issued, HSTS |
| **Mail** | Console transport, no network | Captured in-memory | Real SMTP to a sink mailbox | Real SMTP |
| **Outbound network** | Vendor adapters disabled | Disabled | Disabled except SMTP | Disabled except SMTP |
| **Access** | Developer workstation | Nobody | Engineers, over VPN | Engineers, over bastion; staff via HTTPS |
| **Lifetime** | Until deleted | Minutes | Persistent | Persistent |

### 3.2 What must be identical, and why

Four things are held byte-identical between `staging` and `production`, because each has produced a class
of bug that only appears in one of them:

1. **The container image digest.** Not the tag. `staging` records the digest it validated; production
   deploys that digest or the release is void. A rebuilt image with the same tag is a different artefact.
2. **The migration set and `ops.schema_migration` checksums.** `/readyz` refuses to report ready when the
   code's expected migration head differs from the database's (`§4.5`). A staging database that was
   migrated by hand will fail this check, which is the point.
3. **The PostgreSQL major version and extensions.** `pg_stat_statements` and `pgcrypto` are required in
   both; a query plan that works on 16.2 and not 16.4 is rare but not impossible, and extension drift
   changes function behaviour.
4. **The proxy configuration.** TLS, HSTS, body limits and timeouts are properties of the edge, not of the
   application. `06` M-12 verifies them against staging; production must serve the same file.

### 3.3 Data rules per environment

- **Production data never enters `local` or `ci`.** Not a dump, not a sample, not "just the instruments
  table". Instruments are public reference data, but `market_bar` alongside `app_user` in one dump makes
  the exception unenforceable.
- **`staging` gets an anonymised subset** produced by `infra/scripts/anonymise-dump.sh`: users reduced to
  synthetic identities with hashed emails, passwords reset, MFA secrets stripped, audit tables truncated at
  a fixed boundary. The script is deterministic and its output is reviewed once per quarter.
- **`production` never receives seed data.** The seed migration (`02` §9) creates the minimum reference
  set and one admin invitation; it is guarded by `where not exists` so that running it twice is a no-op.
- **Fixtures are marked.** Every synthetic instrument created by seed or tests carries
  `ref.instrument.is_test = true` where the schema allows, and the deterministic seed uses symbol prefixes
  (`TEST-`). This is what lets a data-quality test assert that deliberate defects exist in `local` and
  cannot exist in `production`.

### 3.4 Configuration contract

Two objects with different shapes, because confusing them is a security defect rather than a style
problem (`06` §12.2).

**`config`** — validated, loggable, safe to print at boot:

| Key | Default | Used by | Meaning |
|---|---|---|---|
| `NODE_ENV` | `development` | all | `development` / `test` / `production` |
| `PORT` | `3000` | `api` | Listener port |
| `PUBLIC_ORIGIN` | — (required) | `api` | Origin used for CORS decisions in non-production and for absolute links in mail |
| `TRUST_PROXY_HOPS` | `1` | `api` | Number of proxies in front; misconfiguration breaks client IPs and rate limiting |
| `DATABASE_POOL_MAX` | `20` | `api` | Per-process pool ceiling; `worker` uses `10` |
| `LOG_LEVEL` | `info` | all | `trace`…`fatal`; `debug` is refused in production |
| `LOG_SINK` | `stdout` | all | `stdout` or a file path for the log shipper |
| `HTTP_BODY_LIMIT_BYTES` | `1048576` | `api` | JSON body ceiling |
| `UPLOAD_MAX_BYTES` | `20971520` | `api` | CSV upload ceiling (`03` §3.1) |
| `JOB_CONCURRENCY` | `4` | `worker` | Concurrent jobs per worker process |
| `SCHEDULER_TICK_MS` | `15000` | `scheduler` | Schedule poll interval (`03` §6) |
| `ANALYTICS_STALENESS_DAILY_SESSIONS` | `3` | `api` | Scanner staleness tolerance (`04` §6.2) |
| `RATE_LIMIT_READ_PER_MIN` | `300` | `api` | Read bucket (`05` §9.1) |
| `MAIL_FROM` | — (required) | `worker` | Envelope sender |
| `MAIL_HOST` | — (required) | `worker` | SMTP host |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | all | Trace export target; unset disables export but **not** span context |
| `BUILD_SHA` | injected | all | Image build commit; exposed by `/meta` and every log line |

**`secrets`** — validated, non-serialisable (`06` §12.1): `JWT_SIGNING_KEY_CURRENT`,
`JWT_SIGNING_KEY_PREVIOUS`, `MFA_ENCRYPTION_KEY`, `CURSOR_SECRET`, `DATABASE_URL`,
`MIGRATOR_DATABASE_URL`, `SMTP_PASSWORD`, `TLS_PRIVATE_KEY`, `AGE_BACKUP_IDENTITY`,
`OPS_METRICS_TOKEN`.

`OPS_METRICS_TOKEN` is added here because `05` §11.1 and `06` T-35 require `/metrics` to be
bearer-protected; it is a 32-byte CSPRNG value, rotated on operator change, and it is in the secret
inventory so that "a secret that is not in the table does not exist" remains true.

**Load rules** (`packages/config`):

1. Parse and validate in one place, at boot, before any listener binds or any job is claimed.
2. Unknown keys in production are a **warning**, not a failure — but a *missing required* key, a wrong
   type, or a secret equal to a documented placeholder exits with code `78` (`EX_CONFIG`) and a message
   naming the key, never the value.
3. `NODE_ENV=production` additionally asserts: `LOG_LEVEL` is not `debug`/`trace`; `PUBLIC_ORIGIN` is
   `https://`; `TRUST_PROXY_HOPS ≥ 1`; no secret matches the placeholder deny-list.
4. The resolved `config` is logged once at boot as a single line. The `secrets` object cannot be
   serialised — `JSON.stringify(secrets)` throws (`06` §12.2).

### 3.5 Bootstrap order for a new environment

Order matters; each step depends on the previous one being verifiable.

1. Create the cluster and the three roles (`02` §2) with the privilege migration. Verify: `tradesoft_app`
   cannot `CREATE` in any schema, cannot `UPDATE`/`DELETE` on `audit.*`.
2. Run migrations as `tradesoft_migrator` up to head. Verify: `ops.schema_migration` max version equals the
   code's expected head; `\dt+ md.*` shows current and next three months of `market_bar` partitions.
3. Run the reference seed (`02` §9): exchanges, timeframes, trading calendar for the current and next year,
   indicator definitions, the 18 system scanners, default settings, and one `ADMIN` invitation.
4. Generate and install secrets; set file modes; confirm `stat -c '%a'` is `400` on each.
5. Start `scheduler`, then `worker`, then `api`. Verify: `scheduler` logs exactly one advisory-lock
   acquisition; `worker` logs its registered handler count; `api` logs the `onRoute` authorization hook
   result and `tradesoft_authz_unprotected_routes 0`.
6. `GET /healthz` returns `200`; `GET /readyz` returns `200` with all checks green; `GET /metrics` returns
   `200` with the token.
7. Accept the admin invitation, enrol MFA, and confirm that a second `ADMIN` exists before any real work
   begins. One admin is a single point of failure on day one.

Step 7 is not ceremonial: `06` G-S8 requires two named operators for break-glass, and an environment with
one admin cannot satisfy it.

---

## 4. Observability

### 4.1 Three questions, three instruments

Observability exists to answer three questions, and each has exactly one primary instrument. Mixing them
is how teams end up grepping logs for a request rate.

| Question | Instrument | Why not the others |
|---|---|---|
| *Is it working right now, and how well?* | **Metrics** — aggregated, cheap, alertable | Logs cannot be aggregated reliably at this volume without a log platform; traces sample. |
| *Why did this specific request or job fail?* | **Logs**, found by `request_id` / `job_id` | Metrics have no identity; traces rarely carry the error payload. |
| *Who changed this, and what did they change?* | **Audit tables** (`audit.audit_event`, `audit.security_event`) | Logs rotate and are not authoritative; metrics are anonymous. |

A fourth instrument, **traces**, is present but not load-bearing (§4.6). It exists to attribute latency
inside one request to one SQL statement. Nothing pages on a trace, and no runbook depends on one.

### 4.2 Logging

Structured JSON on stdout via `pino`, one line per event, shipped by the platform's log driver.

**Baseline fields on every line** — no exceptions, because a line without them cannot be joined to
anything:

| Field | Source | Notes |
|---|---|---|
| `ts` | monotonic clock at write | ISO-8601 with milliseconds, UTC |
| `level` | pino | numeric plus label |
| `msg` | call site | Short, stable, lowercase. Never interpolated with user data |
| `service` | `api` / `worker` / `scheduler` | Set at boot |
| `build_sha` | `BUILD_SHA` | Ties a log line to a deploy |
| `request_id` | `X-Request-Id` or generated (`05` §3.7) | HTTP only |
| `correlation_id` | UUIDv7 minted at the entry point | Present on jobs and their descendants |
| `trace_id`, `span_id` | OTel context, when present | Present even when export is disabled |
| `user_id` | authenticated principal, if any | Never the email |
| `route` | Fastify route template (`/instruments/:id`) | **Never** the raw URL — that is how cardinality explodes |

**Level discipline.** The rule is not "how interesting is this" but "who acts on it":

| Level | Meaning | Action implied |
|---|---|---|
| `fatal` | The process cannot continue and is exiting | Restart will be attempted; if it repeats, RB-01 |
| `error` | A request or job failed in a way that is not the client's fault | Aggregate; alert only via a metric, never per line |
| `warn` | A degraded path was taken (retry, fallback, stale data served) | Trend it; a spike is a P2 |
| `info` | State transitions worth reconstructing later (job claimed, batch validated, session revoked) | No action |
| `debug` | Development only | **Refused in production** by config validation (§3.4) |
| `trace` | Framework internals | Refused in production |

`info` is deliberately narrow. Logging every request at `info` triples volume for data that metrics
already hold, and it buries the twenty lines a day that matter.

**What is never logged** (`06` §13.4, enforced by `packages/observability` redaction, not by discipline):
passwords and password hashes, TOTP codes and secrets, refresh tokens, `Authorization`/`Cookie` headers,
API keys, the `MFA_ENCRYPTION_KEY`, full request bodies on `/auth/*`, CSV row content from rejected uploads
(log the row *number* and the reject code, never the values), and personal data beyond `user_id`.

Redaction is applied twice: at the pino serializer (`redact: [...]`) and again by the audit client before
any `metadata` jsonb is written. A double redaction costs microseconds; a single one that is bypassed by a
new call path costs a credential.

**Sampling.** `info` and above are never sampled. `debug`/`trace` do not exist in production. This is
affordable because the baseline volume is low: at 50 rps, roughly 40 KB/s.

**Retention.** 14 days hot on the host (rotated at 200 MB per file, 10 files), 90 days in the platform's
log store if one is configured, otherwise 14 days and no more — with the caveat that audit and security
evidence lives in `audit.*` precisely so that log retention is not a compliance question.

### 4.3 Correlation and context propagation

One identifier, four hops, no manual threading:

```
browser ──X-Request-Id──▶ api ──correlation_id──▶ ops.job.payload.context
                            │                          │
                            └─ trace_id ───────────────┴─▶ worker ──▶ audit.audit_event.correlation_id
```

| Hop | Mechanism |
|---|---|
| Client → `api` | `X-Request-Id` accepted if it matches `^[A-Za-z0-9._:-]{8,64}$`, otherwise replaced and the substitution logged (`05` D-05-19) |
| `api` internal | A request-scoped `AsyncLocalStorage` context holds `request_id`, `correlation_id`, `user_id`, `trace_id`. The logger is a child of that context, so no call site passes fields by hand |
| `api` → `ops.job` | The job payload carries `{requestId, correlationId, actorUserId}`. The worker rebinds its logger to them before `handle()` runs |
| `api`/`worker` → audit | `correlation_id` is a required column on both audit tables; `request_id` is nullable because jobs have none |

Two invariants: **a job never mints a new `correlation_id`** (it would sever the link to the request that
caused it), and **an outbox-dispatched job inherits the originating event's `correlation_id`** (`03` §5.3).
This is what makes "the dashboard showed a wrong number at 10:04" traceable to the 09:58 upload that
changed a bar.

### 4.4 Metrics

Prometheus exposition on `GET /metrics`, bound to the private interface, bearer-protected, scraped every
15 s. Naming follows `tradesoft_<subsystem>_<name>_<unit>`; counters end in `_total`, durations in
`_seconds`, sizes in `_bytes`.

**Cardinality discipline.** Every label set below is closed. A label whose values are unbounded — user
id, instrument symbol, request id, raw path, error message — is a defect, not a shortcut. Where an
instrument identifier would be useful, the metric carries `timeframe` and the *count* is per-instrument;
drill-down happens through the database, not through Prometheus.

| Metric | Type | Labels | Answers |
|---|---|---|---|
| `tradesoft_http_requests_total` | counter | `method`, `route`, `status_class` | Throughput and error ratio |
| `tradesoft_http_request_duration_seconds` | histogram | `method`, `route` | Latency against the `05` §15 budgets |
| `tradesoft_http_request_body_bytes` | histogram | `route` | Upload path behaviour |
| `tradesoft_http_in_flight` | gauge | — | Saturation before latency degrades |
| `tradesoft_authz_unprotected_routes` | gauge | — | Must be `0`; `06` G-S5 |
| `tradesoft_auth_failures_total` | counter | `reason` (`BAD_CREDENTIALS`,`LOCKED`,`MFA_FAILED`,`EXPIRED`) | Credential-stuffing shape |
| `tradesoft_auth_token_reuse_total` | counter | `outcome` (`GRACE`,`REVOKED_FAMILY`) | `06` SEC-D-04 behaviour in the wild |
| `tradesoft_rate_limit_degraded_total` | counter | `bucket_class` | Fail-open events (`05` §9.3) |
| `tradesoft_db_pool_in_use` | gauge | `process` (`api`,`worker`) | Pool exhaustion (RB-02) |
| `tradesoft_db_pool_wait_seconds` | histogram | `process` | Contention before it becomes errors |
| `tradesoft_db_query_duration_seconds` | histogram | `statement` (a fixed set of ~20 named statements) | Slow-statement attribution without `pg_stat_statements` access |
| `tradesoft_db_transaction_retries_total` | counter | `reason` (`SERIALIZATION`,`DEADLOCK`) | Contention on the analytics path |
| `tradesoft_job_queue_depth` | gauge | `queue`, `status` | Backlog (RB-08) |
| `tradesoft_job_duration_seconds` | histogram | `job_type` | Per-type cost against the `03` §5.3 expectations |
| `tradesoft_job_failures_total` | counter | `job_type`, `attempt_class` | Retry pressure |
| `tradesoft_job_dead_letter_total` | counter | `job_type` | Alert at `> 0` for ingestion types (`03` §5.4) |
| `tradesoft_job_reclaimed_total` | counter | `job_type` | Lock expiry and crashed workers |
| `tradesoft_outbox_backlog_age_seconds` | gauge | — | Fan-out delay (`03` §5.3) |
| `tradesoft_scheduler_heartbeat_age_seconds` | gauge | — | Scheduler alive (RB-05) |
| `tradesoft_scheduler_fires_total` | counter | `schedule_code`, `result` (`FIRED`,`DUPLICATE`,`ERROR`) | Missed and double fires |
| `tradesoft_pipeline_lag_seconds` | gauge | `dataset` (`INDICATORS`,`RENKO`,`BREADTH`,`RS`,`SNAPSHOT`) | Freshness SLO (§4.9) |
| `tradesoft_watermark_lag_seconds` | gauge | `dataset`, `timeframe` | Per-timeframe derivation lag |
| `tradesoft_ingestion_batch_duration_seconds` | histogram | `stage` (`VALIDATE`,`PERSIST`,`RECONCILE`) | Where ingestion time goes |
| `tradesoft_ingestion_bars_total` | counter | `outcome` (`ACCEPTED`,`REJECTED`,`QUARANTINED`) | Reject ratio as a source-quality signal |
| `tradesoft_ingestion_source_age_seconds` | gauge | `source_code` | Vendor feed freshness |
| `tradesoft_reconciliation_failures_total` | counter | `code` | Which reconciliation rule is firing |
| `tradesoft_data_quality_open_issues` | gauge | `severity`, `code` | Findings that someone must resolve |
| `tradesoft_analytics_invariant_violations` | gauge | `invariant` (`INV-D1`…`INV-D5`) | Must be `0` (`04` §11.3) |
| `tradesoft_scanner_run_duration_seconds` | histogram | `outcome` (`OK`,`TIMEOUT`,`ERROR`) | RB-09 |
| `tradesoft_scanner_rows_examined` | histogram | — | Query-plan regressions before they time out |
| `tradesoft_audit_chain_verify_failures_total` | counter | `range_class` | Must be `0`; RB-10 |
| `tradesoft_audit_events_total` | counter | `action_class` | Audit volume and write failures |
| `tradesoft_disk_free_bytes` | gauge | `mount` (`/`,`/data`,`/backups`) | RB-07 |
| `tradesoft_pg_database_size_bytes` | gauge | — | Growth against `02` §12 |
| `tradesoft_pg_partition_runway_months` | gauge | `table` | RB-06 |
| `tradesoft_backup_age_seconds` | gauge | `kind` (`BASE`,`WAL_ARCHIVE`) | §13 PRG-15 |
| `tradesoft_wal_archive_failures_total` | counter | — | RPO is a lie when this is non-zero |
| `tradesoft_mail_queue_oldest_age_seconds` | gauge | — | SMTP stall (`06` §12.5) |
| `tradesoft_process_resident_memory_bytes` | gauge | — | Leak detection over days |

**Names used in earlier documents.** Several documents refer to metrics by short name before this
catalogue existed. The mapping is fixed here so both remain true:

| Short name in `03`/`04`/`06` | Exported series |
|---|---|
| `authz_unprotected_routes` | `tradesoft_authz_unprotected_routes` |
| `job_failures_total{type}` | `tradesoft_job_failures_total{job_type}` |
| `job_dead_letter_total{type}` | `tradesoft_job_dead_letter_total{job_type}` |
| `rate_limit_degraded` | `tradesoft_rate_limit_degraded_total` |
| `scanner_run` duration | `tradesoft_scanner_run_duration_seconds` |
| `bars/s`, `series/s`, `bricks/s` (throughput in `03` §5.3) | `tradesoft_ingestion_bars_total`, `tradesoft_job_duration_seconds`, `tradesoft_job_duration_seconds{job_type="analytics.compute_renko"}` |

**Histogram buckets** are declared per metric, not defaulted. HTTP latency uses
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 0.75, 1, 2.5, 5]` seconds, which brackets every budget
in `04` §10.1 and `05` §15. Job duration uses
`[0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 1800]`. A default bucket set cannot answer "how many requests
exceeded the 250 ms chart budget", which is the question the budget exists to ask.

### 4.5 Health endpoints

Three endpoints, three different questions. Conflating them is how a load balancer ends up restarting a
healthy process because the database was briefly busy.

**`GET /healthz` — liveness.** Returns `200 {"status":"ok"}` if the event loop is turning. It touches
nothing: no database, no filesystem, no cache. Its only job is to let the container runtime distinguish a
wedged process from a slow one. A check that queries the database here would convert a database blip into
a fleet-wide restart loop.

**`GET /readyz` — readiness.** Returns `200` when this instance should receive traffic, `503` when it
should not, and in both cases a body listing every check with its severity, so that an operator sees
*which* check failed without reading logs.

```json
{
  "status": "ok",
  "buildSha": "4f1c9ab",
  "checks": {
    "database":            { "ok": true,  "severity": "fatal",    "latencyMs": 2 },
    "schemaVersion":       { "ok": true,  "severity": "fatal",    "expected": 42, "actual": 42 },
    "importVolume":        { "ok": true,  "severity": "fatal",    "writable": true, "freeBytes": 42193000448 },
    "revocationPoll":      { "ok": true,  "severity": "fatal",    "ageSeconds": 4 },
    "migrationsPending":   { "ok": true,  "severity": "fatal",    "pending": 0 },
    "schedulerHeartbeat":  { "ok": true,  "severity": "degraded", "ageSeconds": 12 },
    "pipelineLag":         { "ok": true,  "severity": "degraded", "maxLagSeconds": 340 },
    "mailQueue":           { "ok": true,  "severity": "degraded", "oldestAgeSeconds": 0 }
  }
}
```

| Check | Implementation | Fatal threshold | Why this severity |
|---|---|---|---|
| `database` | `select 1` with a 1 s statement timeout, through the app pool | Connect fails, or 3 consecutive failures | Without it the process can serve nothing but errors |
| `schemaVersion` | Compare `max(version)` in `ops.schema_migration` to the head baked into the build | Any mismatch | Serving code against an unexpected schema produces wrong answers, not errors |
| `migrationsPending` | `select count(*)` of migrations the build knows and the database lacks | `> 0` | Same reason; catches a deploy that skipped the migration job |
| `importVolume` | `access(W_OK)` plus `statvfs` free space | Not writable, or `< 2 GB` free | An upload that is accepted and then lost is worse than a rejected one |
| `revocationPoll` | Age of the last successful `iam.auth_session` revocation poll (`06` §5.7) | `> 150 s` (5 failed polls), or never set | A process that cannot see revocations is honouring revoked sessions |
| `schedulerHeartbeat` | `now() - max(heartbeat_at)` from `ops.system_setting` written by the scheduler loop | `> 300 s` | Jobs stop, data goes stale, but reads still work |
| `pipelineLag` | `max(tradesoft_pipeline_lag_seconds)` across datasets | `> 6 h` | Charts serve yesterday's data; correct but stale |
| `mailQueue` | Oldest `PENDING` email job age (`06` §12.5) | `> 600 s` | Password resets silently stop; login still works |

The response is `200` when every **fatal** check passes, even if degraded checks fail — the instance is
useful and removing it from rotation would reduce capacity for no benefit. Degraded failures are surfaced
in the body and in `tradesoft_*` gauges so that monitoring alerts on them directly; the load balancer does
not need to understand them.

`/readyz` performs five short queries, each with a statement timeout under 1.5 s, and caches the result
for 2 s so a 1 s health-check interval cannot turn readiness into a query storm.

**`GET /metrics` — exposition.** Private interface only, `Authorization: Bearer $OPS_METRICS_TOKEN`,
`Cache-Control: no-store`. It returns `404` on the public interface rather than `403`, so that its
existence is not advertised to an unauthenticated scanner.

Neither `/healthz` nor `/readyz` requires authentication, and neither reveals build internals beyond
`buildSha`. `/readyz` is restricted to loopback and the private network by the proxy; it is not a public
endpoint even though the application does not authenticate it.

### 4.6 Tracing

OpenTelemetry is instrumented at three points and nowhere else:

1. **HTTP server spans** — one per request, with `route` (template, not URL), `status`, `user_id` and the
   handler's duration.
2. **Database client spans** — one per statement, with the *named* statement identifier from the fixed set
   in `04`, not the SQL text. Statement text can contain a value; names cannot.
3. **Job spans** — one per `handle()` invocation, linked to the request span that enqueued it via the
   `correlation_id` in the payload.

**Export is off by default in production.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, the SDK still
generates span context (so `trace_id` appears in logs and spans correlate within a process) but exports
nothing. This is deliberate: a tracing backend is a stateful service with its own retention, cost and
failure modes, and at 50 rps with one database the useful question — "which statement is slow" — is
answered better by `pg_stat_statements` and `auto_explain` than by a collector.

When a latency investigation needs traces, the endpoint is set on one canary instance for the duration of
the investigation, pointed at an all-in-one collector run on the operator's workstation. The findings go
into an index or a query change; the collector is then switched off. This is recorded as **D-07-03**.

`pg_stat_statements` is enabled with `track = 'all'` in every environment (it is free) and
`auto_explain` with `log_min_duration = 500ms`, `log_analyze = on`, `log_nested_statements = on` for
statements that exceed the `05` §15 budgets. `auto_explain` output goes to the PostgreSQL log, not to the
application log, and is sampled by threshold rather than by probability, because the interesting case is
rare and the threshold is known.

### 4.7 Alert catalogue

Every alert has one expression, one duration, one priority and one runbook. The `for` duration is the
difference between a useful alert and a noisy one; the values below are chosen so that a single scrape
glitch, a deploy restart or a one-minute lock never pages.

| ID | Condition | For | Pri | Runbook |
|---|---|---|---|---|
| AL-01 | `sum(rate(tradesoft_http_requests_total{status_class="5xx"}[5m])) / sum(rate(tradesoft_http_requests_total[5m])) > 0.01` | 5 m | P1 | RB-01 |
| AL-02 | `histogram_quantile(0.95, sum by (route) (rate(tradesoft_http_request_duration_seconds_bucket[5m]))) > 0.5` | 10 m | P2 | RB-01 |
| AL-03 | `tradesoft_db_pool_in_use / tradesoft_db_pool_max > 0.9` | 5 m | P1 | RB-02 |
| AL-04 | `sum(rate(tradesoft_db_pool_wait_seconds_count[5m])) > 5` and p95 wait `> 0.5 s` | 10 m | P2 | RB-02 |
| AL-05 | `tradesoft_job_queue_depth{queue="ingestion",status="QUEUED"} > 200` | 15 m | P1 | RB-08 |
| AL-06 | `increase(tradesoft_job_dead_letter_total{job_type=~"ingestion\\..*"}[15m]) > 0` | 0 m | P1 | RB-03 |
| AL-07 | `tradesoft_scheduler_heartbeat_age_seconds > 300` | 2 m | P1 | RB-05 |
| AL-08 | `tradesoft_pipeline_lag_seconds{dataset="INDICATORS"} > 7200` and within 4 h of session close | 15 m | P1 | RB-05 |
| AL-09 | `tradesoft_analytics_invariant_violations > 0` | 0 m | P1 | RB-16 |
| AL-10 | `increase(tradesoft_audit_chain_verify_failures_total[1h]) > 0` | 0 m | P1 | RB-10 |
| AL-11 | `tradesoft_reconciliation_failures_total` increases by `> 0` for a completed batch | 0 m | P1 | RB-04 |
| AL-12 | `tradesoft_disk_free_bytes{mount="/"} < 10e9` or `{mount="/data"} < 20e9` | 10 m | P3 → P1 at `< 2e9` | RB-07 |
| AL-13 | `tradesoft_pg_partition_runway_months < 3` | 1 h | P2 | RB-06 |
| AL-14 | `tradesoft_pipeline_lag_seconds{dataset="RENKO"} > 43200` | 30 m | P3 | RB-05 |
| AL-15 | `tradesoft_backup_age_seconds{kind="BASE"} > 129600` or `increase(tradesoft_wal_archive_failures_total[1h]) > 0` | 15 m | P1 | RB-14 |
| AL-16 | `tradesoft_scanner_rows_examined` p95 `> 5e6` or timeout ratio `> 0.01` | 15 m | P2 | RB-09 |
| AL-17 | `tradesoft_rate_limit_degraded_total` increases at `> 1/s` | 10 m | P2 | RB-02 |
| AL-18 | `tradesoft_mail_queue_oldest_age_seconds > 600` | 5 m | P2 | RB-15 |
| AL-19 | `tradesoft_ingestion_source_age_seconds > 90000` (25 h) during a trading week | 1 h | P2 | RB-03 |
| AL-20 | `tradesoft_authz_unprotected_routes > 0` | 0 m | P1 | RB-11 |
| AL-21 | `tradesoft_auth_token_reuse_total{outcome="REVOKED_FAMILY"}` increases `> 3` in 24 h | 0 m | P2 | `06` P3 |
| AL-22 | TLS `not_after - now < 7d` | 1 h | P1 | RB-13 |
| AL-23 | `tradesoft_process_resident_memory_bytes` grows monotonically for 24 h with no traffic growth | 1 h | P3 | RB-01 |
| AL-24 | `tradesoft_data_quality_open_issues{severity="ERROR"} > 0` for a closed session | 6 h | P2 | RB-04 |

Three deliberate omissions, each of which is a common default that would be wrong here:

- **No alert on `restart_count`.** A container that restarts once and recovers is normal; the alert is on
  the symptom (5xx, readiness), not the mechanism.
- **No alert on `cpu_usage`.** CPU is a cause, not a symptom, and a nightly pipeline is *supposed* to
  saturate the CPU. The alert is on pipeline duration (AL-08/AL-14).
- **No alert on a single `ERROR` log line.** Errors are counted by metric and alert on rate; a per-line
  alert cannot be distinguished from a retry that succeeded.

### 4.8 Dashboards

Four dashboards, each answering one question for one audience. A dashboard nobody opens during an
incident is deleted.

| Dashboard | Audience | Panels | The question it answers |
|---|---|---|---|
| **Trading day** | Everyone | Session clock, per-exchange feed age, batches in flight, bars accepted/rejected, pipeline stage progress, open data-quality issues | *Is today's data landing and usable?* |
| **API health** | Backend | Request rate/error ratio by route, latency against budget, pool saturation, top slow statements, rate-limit rejections, in-flight | *Is the API healthy, and if not, which route?* |
| **Pipeline** | Analytics | Queue depth by queue, job duration by type, dead letters, watermark lag per dataset, outbox age, nightly total duration vs 60 min budget | *Will tonight finish before the open?* |
| **Integrity** | Security + Analytics | Audit chain verification status, security events by type, invariant violations, reconciliation failures, partition runway, backup age, disk | *Is the record still trustworthy?* |

Dashboards read only from Prometheus. A panel that requires a bespoke query endpoint is a sign that the
metric is missing, not that the dashboard should query the database.

### 4.9 Service level objectives

SLOs exist to make the trade-off between shipping and stability explicit. They cover the two things users
notice — availability and freshness — and the one thing the platform exists for — correctness.

| SLI | Definition | SLO | Window | Error budget policy |
|---|---|---|---|---|
| **API availability** | Fraction of non-5xx responses to authenticated `GET` requests during coverage | 99.5 % | 30 days | Budget exhausted → no deploys except fixes until restored |
| **API latency** | Fraction of chart, RS and scanner-result requests under the hard budget in `05` §15 | 99 % | 7 days | Investigate before the second consecutive breach |
| **EOD freshness** | Fraction of trading days where `INDICATORS`, `SNAPSHOT`, `RENKO` are current by 20:30 IST | 100 % | 30 trading days | Any miss is a P1 and a written cause; 2 in a month → pipeline work pre-empts features |
| **Intraday freshness** | Fraction of 15-minute buckets whose derived timeframes and indicators are current within 10 minutes of bucket close, during 09:15–15:30 IST | 98 % | 7 days | Below 95 % → RB-05 investigation |
| **Correctness** | Zero unresolved INV-01…INV-20 and INV-D1…INV-D5 violations at session close; zero bars served that failed reconciliation | 100 % | continuous | Any violation is P1; the release that introduced it is reverted |

**Correctness has no error budget.** A 99.9 % correctness target means one wrong price a day is
acceptable, which is not a statement this platform is willing to make. The other four SLOs trade off
against each other; this one does not trade.

Alert AL-09 and the correctness SLI are the same signal expressed twice — a gauge for paging, an SLI for
the monthly review — and that duplication is intentional: the gauge proves the alert path works, the SLI
proves the trend.

---

## 5. Audit operations

### 5.1 Three streams, three authorities

`06` §14.1 establishes that business audit and security events are separate tables. This section adds the
third stream and fixes where each one is authoritative.

| Stream | Storage | Written by | Authority for | Retention | Read by |
|---|---|---|---|---|---|
| **Application log** | stdout → host log driver | pino, every process | Operational diagnosis only. **Not a system of record.** | 14 days | Engineers |
| **Security event** | `audit.security_event` | `api` on auth/authz/rate-limit/upload outcomes | *Who tried to get in, and what happened* | 24 months | `security:read` (ADMIN) |
| **Business audit** | `audit.audit_event` (hash-chained) | `api` in the same transaction as the change | *Who changed this business fact, from what, to what* | 84 months | `audit:read` (ADMIN) |

The split is not bureaucratic. A security analyst must be able to answer "how many failed logins from this
ASN today" in milliseconds without scanning a hash-chained table, and an auditor must be able to prove that
a correction was authorised without depending on a log file that rotated away.

### 5.2 The routing rule

A single question decides the stream, and it is asked at the call site, not afterwards:

> **Did the system's security posture change, or did a business fact change?**

| Event | Stream | Rationale |
|---|---|---|
| Successful login, logout, refresh, MFA verify | Security | Access posture, not a business fact |
| Failed login, locked account, MFA failure | Security | Attack signal |
| Permission denied by the authorization guard | Security | Attack signal, and the only record of a blocked attempt |
| Rate limit exceeded / limiter degraded | Security | Abuse signal / control degradation |
| Upload rejected by L1 validation | Security | `06` lists `UPLOAD_REJECTED`; a rejected file is an attack surface event |
| User created / role changed / API key issued | **Both** | Security event for the access change, audit event for the business change |
| Market-data correction submitted | Audit | Business fact with a mandatory justification (BR-044) |
| Scanner published, settings changed, job retried | Audit | Business fact |
| Job failed with a retryable error | Log only | Operational, high volume, no authority |
| Bar rejected by row validation | `md.ingestion_reject` + log | Data-quality record, not an audit or security event |

"Both" happens twice — access changes and corrections — and each write is independent. A failure to write
the security event does not roll back the audit event, because they answer different questions and one
must not be able to suppress the other.

### 5.3 Write path and failure semantics

- **Business audit is transactional.** `audit.audit_event` is inserted on the same connection, inside the
  same transaction as the change it records (BR-042). If the insert fails, the business change does not
  happen and the request returns `503 SERVICE_UNAVAILABLE`. No new error code is introduced for this:
  from the client's perspective it is indistinguishable from any other transactional failure, and naming
  it would tell an attacker which control to attack.
- **Security events are best-effort but alarmed.** They are written on a separate connection after the
  response is decided, so a failing security table cannot lock users out. A failure increments
  `tradesoft_audit_events_total{action_class="security_write_failed"}` and raises a P1: a system that
  cannot record failed logins is a system whose lockout counter is a guess.
- **The hash chain takes an advisory lock.** `audit.chain_hash()` serialises writers on
  `pg_advisory_xact_lock(hashtext('tradesoft.audit.chain'))` and reads the previous row `ORDER BY id DESC`
  at `READ COMMITTED` (`06` §14.2). The `READ COMMITTED` requirement is not incidental: under
  `REPEATABLE READ` the writer's snapshot predates the lock and the chain forks. The transaction isolation
  level for audited writes is therefore fixed at `READ COMMITTED`, and a test asserts it.
- **Audit writes never use `id` from the application.** The column is `generated by default as identity`
  solely so the `BEFORE INSERT` trigger can assign it before hashing; application code that supplies `id`
  is a defect caught by review and by the `ck_audit_action` shape check on `action`.

### 5.4 Retention, partitions and anchors

The mechanism is defined in `06` §14.4. The **schedule** is what makes it a control:

| Task | Cadence | Owner | Evidence |
|---|---|---|---|
| Pre-create next month's `audit.audit_event` partition | Monthly, 1st at 02:00 IST, by `maintenance.partition_rollover` | Automated | `tradesoft_pg_partition_runway_months{table="audit.audit_event"} ≥ 3` |
| Export + sign + store a retired partition (after 84 months) | Annually, when the 85th month exists | Two engineers | Manifest in `ops.system_setting.audit.archiveManifests`, object key in the release note |
| Off-host anchor of the last 24 h | Nightly, 02:30 IST | Automated | `tradesoft_backup_age_seconds{kind="ANCHOR"} < 129600`; object listed in the weekly review |
| Full chain verification | Weekly, Sunday 03:00 IST | Automated, then reviewed | `scripts/verify-audit-chain --full` output archived |
| Restore drill including audit verification | Weekly | Automated, reviewed monthly | Restore record with duration and chain check result |

The nightly anchor is a hash of the newest audit row plus `{lastId, terminalHash, rowCount}` signed with
the **archive** key, written to storage whose credentials are not present on the application host. The
first production release cannot satisfy G-S7 until at least one nightly anchor exists, which means the
gate cannot be passed on launch day — it is passed on launch day **plus one**.

That is the correct sequencing, and it is stated here so nobody is surprised by it: an anchor that is
created seconds before the release review proves nothing about the preceding 24 hours.

### 5.5 Verification procedure

**Continuous (daily).** `audit.verify_chain` walks the last 7 days in `id` order, recomputes each hash,
and on mismatch writes `security_event('SUSPICIOUS_INPUT', severity='CRITICAL', details={firstBreakId})`
and increments `tradesoft_audit_chain_verify_failures_total`. It records the highest verified `id` in
`ops.system_setting` under `audit.lastVerifiedId`, so the next run continues instead of rescanning.

**Weekly (full retained history).**

```bash
# Runs as tradesoft_readonly; emits checked count, first break, and the anchor comparison.
pnpm --filter @tradesoft/db exec tsx scripts/verify-audit-chain.ts --full --since=2019-01-01
```

Expected output is `checked=<n> firstBreak=none anchors=ok`. Anything else is P1 and RB-10.

**On demand (range).**

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://<host>/api/v1/admin/audit-events/verify?from=2026-10-01&to=2026-10-31"
# → {"checked":41233,"firstBreakAt":null,"firstBreakId":null}
```

Verification is O(n) sequentially by `id`; at the expected ~150k rows/year a full 7-year pass is under ten
seconds. It is affordable precisely because it never joins anything.

### 5.6 Access, break-glass, and the two-person rule

- `audit:read` and `security:read` are `ADMIN`-only and there is no per-user audit scoping (`06` §14.6).
- `tradesoft_readonly` has no grant on `iam` or `audit`. An incident responder who needs raw audit access
  connects as a superuser through the bastion, which is a deliberate, logged act.
- `tradesoft_app` holds `INSERT, SELECT` only on both audit tables; `UPDATE`/`DELETE` are revoked **and**
  a trigger raises on attempt, so an over-privileged connection still fails.
- Break-glass requires two named engineers (A12, `06` G-S8). The procedure is: open a ticket naming both,
  `psql` as `tradesoft_migrator` through the bastion with `\set VERBOSITY verbose`, and paste the session
  transcript into the ticket before closing it. There is no shared root password and no long-lived
  break-glass credential on disk.
- Queries against `audit.audit_event` are capped at a 90-day window per API call. Wider analysis uses SQL
  through the bastion, not the API.

### 5.7 Query cookbook

The queries an operator will actually need, written out so that nobody composes SQL from memory during an
incident. All run as `tradesoft_migrator` through the bastion.

```sql
-- 1. Everything that happened to one business entity, newest first.
select id, occurred_at, actor_user_id, action, before, after, correlation_id
  from audit.audit_event
 where entity_type = 'instrument' and entity_id = $1
 order by occurred_at desc, id desc
 limit 200;

-- 2. Everything one actor did in a window (insider review).
select occurred_at, action, entity_type, entity_id, metadata
  from audit.audit_event
 where actor_user_id = $1
   and occurred_at >= now() - interval '30 days'
 order by occurred_at desc, id desc;

-- 3. Login timeline for one account, including failures (security review).
select occurred_at, event_type, severity, client_ip, user_agent, details
  from audit.security_event
 where user_id = $1 or email_attempted = $2
 order by occurred_at desc
 limit 500;

-- 4. Permission denials by route, last 7 days (probing or a broken role).
select details->>'route' as route, count(*) as denials, count(distinct user_id) as users
  from audit.security_event
 where event_type = 'PERMISSION_DENIED' and occurred_at >= now() - interval '7 days'
 group by 1 order by denials desc;

-- 5. Every market-data correction in a window, with justification.
select occurred_at, actor_user_id, entity_id, after->>'justification' as justification,
       after->>'instrumentId' as instrument_id, after->>'sessionDate' as session_date
  from audit.audit_event
 where action = 'marketdata.correction.submitted'
   and occurred_at >= $1 and occurred_at < $2
 order by occurred_at;

-- 6. Token reuse and revocation, 30 days (06 SEC-D-04 behaviour).
select occurred_at, user_id, details->>'familyId' as family, details->>'reason' as reason
  from audit.security_event
 where event_type in ('TOKEN_REUSE_DETECTED','SESSION_REVOKED')
   and occurred_at >= now() - interval '30 days'
 order by occurred_at desc;

-- 7. Rate limiting, by bucket, to distinguish an attack from a client bug.
select details->>'bucket' as bucket, count(*) as hits, count(distinct client_ip) as ips
  from audit.security_event
 where event_type = 'RATE_LIMIT_EXCEEDED' and occurred_at >= now() - interval '24 hours'
 group by 1 order by hits desc;
```

Where an index is missing, add it — `ix_audit_entity`, `ix_audit_actor`, `ix_audit_action`,
`ix_audit_correlation`, `ix_security_event_time` and `ix_security_event_user` cover the seven queries
above on the expected volumes.

### 5.8 Subject access assembly procedure

`06` §13.5 states there is deliberately no one-click export, because such an endpoint is a high-value
exfiltration primitive. The manual procedure, performed by an `ADMIN` with a second engineer reviewing:

1. Open a ticket recording the request, the requester's identity check, and the two engineers involved.
2. `GET /api/v1/users/{id}` — profile, roles, status, MFA state, timestamps.
3. `GET /api/v1/admin/audit-events?actorUserId={id}&from=…&to=…` in 90-day slices — actions performed.
4. `GET /api/v1/admin/security-events?userId={id}&from=…&to=…` — authentication history.
5. `GET /api/v1/saved-views` and `GET /api/v1/scanners?ownerId={id}` — content the user created.
6. Assemble into a single JSON document, redacting nothing that the subject is entitled to see, and
   nothing that belongs to another user. A scanner shared with the team may contain another user's logic;
   the shared artefact is excluded, the subject's own definitions are included.
7. Deliver over an authenticated channel, record delivery in the ticket, and delete the assembled file
   within 7 days.

The limitation is recorded, not hidden: audit rows written before a pseudonymisation retain `actor_ip`
(AR-08), and those rows are included in the assembly because they are the subject's own data.

### 5.9 Erasure and pseudonymisation

Erasure is pseudonymisation, not deletion (`06` §4.7): the `iam.app_user` row is retained because audit
rows reference it by foreign key, and `on delete restrict` would block deletion anyway. The procedure:

1. `maintenance.anonymise_pii` runs weekly and pseudonymises users whose `deactivated_at` is older than
   `security.pii_retention_days` (default 180, stored in `ops.system_setting`, not hardcoded).
2. It replaces `display_name` with `User <short-id>`, `email` with a deterministic non-reversible alias,
   clears `totp_secret_ct`, `password_hash` (to a random non-matching value), and `last_totp_counter`, and
   writes `audit_event('user.pseudonymised')`.
3. It does **not** touch `audit.audit_event` or `audit.security_event`. Rewriting history would break the
   hash chain — which is the entire point of the chain — and would defeat the legal-obligation retention
   that justifies keeping the rows at all.
4. A manual request is executed by running the same function for one `user_id`, with a ticket, and is
   itself audited.

### 5.10 The weekly twenty-minute review

A control that nobody looks at is a control that has silently stopped working. Once a week, an `ADMIN`
opens the **Integrity** dashboard and answers five questions in writing in the ops log:

1. Did chain verification pass every day? (Any gap in the daily job is itself a finding.)
2. Did the nightly anchor exist for every night, and is the object key recorded?
3. What were the top three `security_event` types by count, and is any of them unexpected?
4. Were there `PERMISSION_DENIED` events from a user who should have had access? (A broken role is usually
   discovered by an annoyed user, not by a monitor.)
5. Are there open data-quality `ERROR` findings older than seven days?

The review produces **one line** in `docs/runbooks/audit-review-log.md` per week: date, reviewer, five
answers, any ticket opened. A month with no entries is a finding in the next quarterly review.

### 5.11 What the audit trail cannot prove

Stated plainly so that no one over-claims in an incident report:

- It cannot detect a superuser who rewrites rows **and** the off-host anchor (AR-09). It detects
  application-level and account-level misuse, not infrastructure-level misuse.
- It cannot prove that a *read* did not happen. Reads are not audited; the proxy access log is the only
  record and it rotates in 14 days.
- It cannot prove the correctness of a value, only who changed it and what it was before. Correctness is
  the job of reconciliation (`03` §3.5) and the invariants (`04` §11.3).
- It cannot reconstruct a deleted scanner definition's *content* beyond the `before` jsonb snapshot taken
  at deletion — which is complete, but only for the fields the snapshot policy includes.

---

## 6. Testing

### 6.1 The claim each layer is allowed to make

Testing is organised by **what a failing test would prove**, not by tool. A slow end-to-end test that
asserts a button exists proves less than a single property test on the compiler, and the reverse is also
true.

| Layer | Proves | Cannot prove | Runs | Blocks |
|---|---|---|---|---|
| **Type + lint** | Nothing at runtime; that the code is internally consistent | Any behaviour | Every commit, < 60 s | Merge |
| **Unit** (pure functions) | Engine mathematics matches a specification, for the cases chosen | That the database agrees | Every commit, < 20 s | Merge |
| **Property** | A stated invariant holds across the input domain, not just the examples | That the invariant is the right one | Every commit (fast set) + nightly (1 h) | Merge / release |
| **Integration** (real PostgreSQL) | SQL, constraints, triggers, transactions and concurrency behave as designed | Anything about a browser | Every commit, 4–6 min | Merge |
| **Contract** | The wire format matches `05`, and permissions match `00` §4.2 for every route × role | That a client uses it correctly | Every commit, < 60 s | Merge |
| **End-to-end** | A user journey works through the real API and the real SPA | That it works under load | Every commit on `main`, nightly on branches | Release |
| **Performance** | Latency and throughput stay inside `04` §10.1 and `05` §15 | Correctness | Nightly, and on any query change | Release |
| **Migration** | The schema reaches the expected state from empty **and** from the previous release | That data survives a rollback (there is none) | Every commit | Merge |
| **Restore** | A backup is loadable and internally consistent | That the failure will be the one you drilled | Weekly | Release (G-S9) |
| **Security** | `06` §17 — see there, not restated here | Absence of vulnerabilities | Every commit + nightly + per release | Merge / release |

The last row is deliberate. `06` §17.2 defines SEC-T-01…SEC-T-17 with their mechanisms; this document only
schedules them (§6.10) and counts them as gate evidence. Duplicating them would create two lists that drift.

### 6.2 Unit tests: the engines

`packages/engines` is the highest-value test target because it is pure, deterministic, and every number a
user sees comes from it. Its tests are not "coverage"; they are the executable form of `04`.

**Golden vectors.** For every indicator in `04` §6, a fixture
(`packages/testing/golden/indicators/<indicator>.json`) holds an input series and the expected output
series to six decimal places. The vectors were produced by a **separate reference implementation** written
directly from the formulas in Python (pandas/numpy), not by the TypeScript engine — a golden file generated
by the code under test proves only that the code is deterministic, which is a much weaker claim. The
provenance (reference script, library versions, author, date) is recorded in
`packages/testing/golden/README.md`, and the reference script is committed and re-runnable.

Consequences of that choice, stated because they are the point:

- A vector may only be regenerated when `04` changes, and the regeneration is a reviewed diff with the
  formula change cited.
- A change to an engine that changes a vector without changing `04` is a bug in the engine, by definition.
- Warm-up boundaries are part of the vector: expected values before the first valid output are `null`, not
  `0`, and the tests assert the null positions.

| Suite | What it pins | Notable cases |
|---|---|---|
| SMA/EMA/WMA | Seeding and recursion | EMA seeds from SMA, not from the first close (`04` §6.2) |
| RSI (Wilder) | Smoothing and the flat-series rule | Zero average loss → `100`; zero gain and zero loss → `50` |
| ATR/ADX | Wilder smoothing on TR and DM | A gap session does not create a false `+DM` |
| Bollinger | Population standard deviation | `n=1` is rejected by schema, not by divide-by-zero |
| 52-week stats | 252-bucket window with 60-session minimum | Insufficient history yields `null`, not a partial max |
| ZigZag | Threshold, pivot alternation | Equal highs do not produce two pivots |
| Renko | Brick geometry, reversal, timestamps | See §6.3 |
| RS | Ratio-of-returns, percentile, decile | Ties, single-member groups, zero-variance windows |
| Breadth | Classification and the `unchanged` residual | Halted/quarantined/no-brick members excluded |
| Timeframe algebra | Bucket boundaries from `trading_calendar` | 75-minute buckets are session-anchored, not wall-clock |
| Scanner compiler | SQL shape and parameter binding | See `06` §17.3; the property lives there, the examples live here |

**Determinism tests.** Every engine is called twice with the same input and the results are deep-equal.
Every engine is called with a frozen clock injected; a test asserts the module has no `Date`/`Math.random`
reference at all (AST scan), which is cheaper than discovering non-determinism in a nightly diff.

**Decimal discipline.** No engine file may import a `number`-based formatter. A lint rule forbids
`Number(`, `parseFloat`, and arithmetic on `numeric` strings outside `decimal.js`. The reason is not
pedantry: `0.1 + 0.2` in a 4-decimal price column is a support ticket, and the only way to prevent it at
scale is to make the wrong thing un-writable.

### 6.3 Renko and aggregation: the cases that decide correctness

Aggregation and Renko are where "almost right" is indistinguishable from "right" until a chart is wrong by
one brick. Their tests are enumerated rather than sampled.

**Aggregation (`15m` → `60m/75m/120m/240m`, `1D` → `1W/1M/3M/1Y`):**

1. Volume sums exactly; a parent with children summing to `V` has volume `V`.
2. `high` is the max of child `high`s, `low` the min, `open` the first child's open, `close` the last
   child's close — by `bucket_start`, not by insertion order.
3. A partial parent (fewer children than the bucket expects) is `is_partial = true` and is recomputed, not
   appended to, on the next run.
4. Re-running the same range is idempotent: identical row count, identical values, no new `id`s beyond
   upserts.
5. A session with no `15m` bars produces no `60m` bar (INV-D3) — not a zero-volume bar.
6. The `1W` bucket starts on the week's first **trading** day, so a Monday holiday moves the boundary.
7. A special session (Muhurat) is bucketed using that day's calendar row, not a default 09:15–15:30.

**Renko:**

1. Brick size is computed once at the anchor and stored on `an.renko_brick_set`; changing the anchor price
   changes the size, and the test asserts the stored value, not a recomputation.
2. Every brick satisfies `close = open ± brick_size`, exactly, at 4-decimal precision.
3. `brick.open` equals the previous brick's `close` (the chain is unbroken).
4. A reversal group's first brick has `is_reversal = true`; subsequent bricks in that group do not.
5. With a 2-brick reversal, a 1.99-brick counter-move produces no reversal; 2.00 produces one.
6. Two bricks may share a `bucket_start`; `seq` disambiguates, and ordering by `seq` reproduces the
   construction order.
7. `brick_count` on the set header equals `count(*)` of its bricks (INV-D4) — asserted after every rebuild.
8. A source correction that removes a brick triggers a **full rebuild**, and the rebuilt set has
   `revision = previous + 1` with a different `id`; the old set is retained, not mutated.
9. `HIGH_LOW` mode with a bar that spans both directions in one bar produces bricks in
   farthest-extreme-first order, matching `04` §7.6's documented approximation.
10. A synthetic instrument (GS Composite) produces bricks from engine-written `1D` bars and never from an
    `import_batch` (INV-D2).

### 6.4 Property-based tests beyond security

`06` §17.3 covers the four attacker-facing parsers. Four more components have invariants cheap enough to
state and expensive enough to get wrong:

| Component | Property | Generator |
|---|---|---|
| Timeframe bucketing | Every `15m` bar maps to exactly one bucket of each derived timeframe, and buckets partition the session with no gap and no overlap | Random calendar: holidays, half-days, Muhurat, DST-free IST |
| Aggregation | For any set of child bars, `parent.volume = Σ child.volume` and `parent.high = max(child.high)` | Random bars including zero volume and equal timestamps |
| Watermarks | Recomputing from `t` never advances `computed_through` past the newest input bucket, and never moves it backwards except in the explicit correction path | Random sequences of ingest, correct, recompute |
| RS | `score > 0 ⇔ ratio > 1`, and percentile rank is monotone in score | Random price paths, ties included |

The timeframe property is the one that has already earned its keep in design review: it is what forced the
decision that buckets are session-anchored rather than wall-clock (`04` D-04-07), because a wall-clock
generator produces a 75-minute bucket that straddles the close and a 240-minute bucket that starts before
the open.

### 6.5 Integration tests against real PostgreSQL

**No mocked database. Anywhere.** The schema depends on `numeric` arithmetic, `ON CONFLICT … WHERE`,
advisory locks, `FOR UPDATE SKIP LOCKED`, range partitioning, partial unique indexes and triggers. A mock
would test a different system, and an in-memory substitute would pass tests that production fails.

**Harness** (`packages/testing/src/db`):

| Concern | Approach |
|---|---|
| Container | `testcontainers` PostgreSQL 16, one container per Jest worker, image digest pinned |
| Schema setup | Migrations applied once per container from the real `packages/db/migrations`, not from a schema dump — so migration bugs surface in tests |
| Isolation (data tests) | Each test runs in a transaction rolled back at the end; the reference seed is applied once and is read-only |
| Isolation (concurrency tests) | A dedicated database per test, created with `CREATE DATABASE … TEMPLATE tradesoft_test_template` (~120 ms). Rollback cannot be used where the test needs two real connections, advisory locks, or committed rows visible across sessions |
| Clock | `now()` is never mocked. Time-dependent assertions use explicitly inserted timestamps; token expiry uses an injectable clock, not `pg_sleep` |
| Cleanup | `TRUNCATE` is never used on `audit.*` (triggers forbid it); tests that write audit rows use the per-test database |

**The 16 concurrency scenarios of `03` §7.1** are each a test. Scenario → mechanism:

| # | Test |
|---|---|
| 1, 2 | Two concurrent `POST /ingestion/uploads` with the same bytes → one `201`, one `409 IMPORT_DUPLICATE_FILE` carrying the existing id |
| 3 | Two batches with overlapping bars at equal revision → second row rejected with `SOURCE_CONFLICT`; at higher revision → upsert wins and a history row exists |
| 4 | Kill the process mid-`persist_bars` (simulated by aborting the transaction) → zero bars written; retry succeeds |
| 5 | Two workers compute the same indicator series → one blocks on the advisory lock; final rows identical |
| 6 | Two workers rebuild the same Renko set → serialised; `revision` increments by exactly one |
| 7 | Outbox replay enqueues the same job twice → `count(*) = 1` |
| 8 | Two schedulers start → exactly one acquires the lock; duplicate fire is a no-op |
| 9 | Expired `lock_expires_at` → reaper requeues and records a `RECLAIMED` attempt |
| 10 | Reaper and slow worker race → only one completion wins; the loser logs and discards |
| 11 | Two `POST /scanners/{id}/runs` with the same `Idempotency-Key` → one run, second returns `200` with the same id |
| 12 | Retried upload with `Idempotency-Key` → same batch |
| 13 | Correction during an analytics read at `REPEATABLE READ` → reader sees a consistent snapshot; the newer job supersedes |
| 14 | Insert with no partition → error surfaces as a failed batch, alert metric increments |
| 15 | Two corrections on one bar → `revision` becomes `current+1`, then `current+2`; last writer wins |
| 16 | `POST /market-data/corrections` with a stale `If-Match`-equivalent revision basis → `409`, no write |

Scenarios 9 and 10 use a real second connection and a short `lock_expires_at`, not `pg_sleep`; a test that
sleeps for five minutes is a test that will be deleted.

### 6.6 Contract tests

The contract is generated, not maintained by hand, and the tests assert the generation:

| Test | Assertion |
|---|---|
| OpenAPI completeness | Every registered route appears in the generated document, and every route has a response schema. A route without one fails the build (`05` §14) |
| Error code registry | Every `code` string emitted anywhere in `apps/api` exists in the `05` §5.2.2 registry; every registry entry is emitted somewhere or is documented as reserved |
| Decimal serialisation | Schema walk: every `numeric`/`bigint` field in every response type is `string`; every `integer` is `number` (SEC-T-16) |
| Strict bodies | Every request schema is `.strict()`; an unknown key is `400 VALIDATION_FAILED`, asserted generically over the registry |
| Permission matrix | SEC-T-05: every route × role cell from `00` §4.2 |
| Pagination envelope | Every collection response is `{data, page}`; no endpoint returns a bare array (`05` D-05-05) |
| Problem document | Every error response validates against the RFC 9457 shape, including `type`, `title`, `status`, `code`, `requestId` |
| Cursor binding | A cursor minted for `(route, filters, sort)` is rejected by a different route or filter set (SEC-T-11) |
| ETag semantics | `PUT` without `If-Match` on a scanner or setting is `428`; with a stale value is `412` |

The OpenAPI document is not documentation; it is a **test fixture** that happens to be publishable. That is
the only arrangement in which it stays true.

### 6.7 End-to-end tests

Playwright, against a real `api` + real database + real SPA build, seeded with the deterministic
`trade-soft` dataset. No network interception of `/api/*`: an E2E test that mocks the API is a component
test with extra steps.

Eight journeys, each with a stated failure mode it is designed to catch:

| # | Journey | Catches |
|---|---|---|
| E2E-1 | Admin invites user → user sets password → enrols MFA → logs in → sees dashboard | The invitation, one-time-token and MFA-enrolment chain |
| E2E-2 | Analyst uploads a CSV → watches batch progress → sees rejected rows → downloads reject CSV | The full ingestion lifecycle including the reject contract |
| E2E-3 | Analyst opens a chart, switches timeframe and overlay, and the decimal values match the API response exactly | Silent `number` conversion in the client |
| E2E-4 | Analyst views a Renko chart at 0.5 % and 2 %, and brick counts match `/renko` payload | Client-side re-derivation of bricks |
| E2E-5 | Analyst builds a scanner with three conditions, validates, saves, runs, reads results | Condition builder → compiler → result rendering |
| E2E-6 | Analyst views the RS matrix, sorts by 63-session score, and the decile colouring matches the API's `decile` field | Client recomputing ranks differently from the server |
| E2E-7 | Admin corrects one bar with a justification, and the chart plus the audit trail both reflect it | Correction path end-to-end, including the mandatory justification |
| E2E-8 | A `VIEWER` navigates directly to an admin URL and sees a `403` page, not a broken shell | Client-side-only authorization assumptions |

E2E-8 is not redundant with SEC-T-05. The server test proves the API refuses; E2E-8 proves the SPA does
not leak the shape of an admin screen before refusing, which is a different (and frequently missed)
failure.

**Flake policy.** A test that fails intermittently is quarantined within one business day, tagged
`@quarantine`, and either fixed or deleted within ten. A quarantined test does not count as evidence for a
gate. Retrying a flaky test to green is prohibited: it converts a real race into a permanent blind spot,
and this system's most dangerous defects are races.

### 6.8 Data-quality tests

The deterministic seed deliberately contains defects (`02` §9): a duplicate row, an invalid OHLC
relationship, a missing trading day, a negative volume, and an out-of-session timestamp. Tests assert that
each is **detected, classified and surfaced** — not that it is silently corrected:

| Injected defect | Expected outcome |
|---|---|
| Duplicate row in one file | L3 rejects the later row with `DUPLICATE_ROW`; batch completes with `rejectedRows > 0` |
| `high < low` | L2 rejects with `INVALID_OHLC`; row appears in `/ingestion/batches/{id}/rejects` |
| Missing trading day in a completed batch | L5 fails the batch with `MISSING_SESSIONS`; batch becomes `RECONCILIATION_FAILED` |
| Negative volume | L2 rejects with `NEGATIVE_VOLUME` |
| Timestamp outside the session window | L2 rejects with `OUT_OF_SESSION` |
| Two sources disagree at equal revision | Row rejected, `bar_quality_issue SOURCE_CONFLICT` at `ERROR` |
| Bar for an unregistered symbol | L2 rejects with `UNKNOWN_SYMBOL`, and the reject row names the symbol |

The point of this suite is that the platform's promise is "never silently accept corrupted data", and the
only way to test a promise about silence is to inject the corruption and assert that something loud
happened.

### 6.9 Performance tests

Two distinct activities, often conflated:

**1. Budget tests (nightly, blocking for release).** `k6` against a seeded dataset of 2,000 instruments and
three years of `15m` history. It asserts the p95 values in `04` §10.1 and `05` §15 for: chart bundle, Renko
series, RS matrix, breadth series, scanner run, instrument search, and the nightly pipeline's total wall
time. A budget breach on `main` blocks the release until either the query or the budget changes — and
changing a budget requires an ADR amendment, which is what stops budgets from being edited to match
reality.

**2. Plan regression (every commit that touches `packages/db/sql` or an index).**
`scripts/explain-baseline.ts` runs a fixed set of 12 representative queries against a seeded database and
compares the plan's **shape** — node types and index names, not cost numbers, which vary with statistics.
A `Seq Scan` on `md.market_bar` or `an.indicator_value` in a plan that previously used an index fails the
test. This is the cheapest possible guard against the single most expensive class of regression in the
system.

Load shape for the nightly test is derived from A3: 20 concurrent users, 50 rps sustained for 10 minutes,
a 70/20/10 read/chart/scanner mix. The test also runs one "morning rush" scenario — 40 users opening the
dashboard within 60 seconds after 09:15 IST — because that is the actual worst case, not a uniform ramp.

### 6.10 Migration and restore tests

**Migrations are forward-only** (`02` §8); there are therefore no "down migration" tests, and pretending
otherwise would be worse than omitting them. What is tested:

1. **From empty.** All migrations apply to an empty database; the resulting schema hash matches the
   committed expectation; `ops.schema_migration` contains every version exactly once.
2. **From the previous release.** A snapshot of the previous release's schema (a `pg_dump --schema-only`
   fixture, regenerated each release) is restored, then the new migrations apply cleanly. This is the test
   that catches a migration that assumes a clean database.
3. **Checksum immutability.** Editing an applied migration file makes the runner refuse; a test asserts the
   refusal.
4. **Concurrent runners.** Two migrators started simultaneously: one acquires the advisory lock, the other
   waits and then finds nothing to do.
5. **Structural assertions** from `02` §8: no `DEFAULT` partitions, every price column is `numeric(18,4)`,
   every partitioned table has three months of runway.
6. **Seed idempotence.** The structural seed run twice changes nothing.

**Restore** is a weekly drill, not a test (§7.7). Its result is gate evidence for G-S9 and PRG-16.

### 6.11 Security tests

Scheduled, not restated:

| When | What |
|---|---|
| Every commit | SEC-T-01…SEC-T-17 that are structural or fast behavioural; SEC-T-05 in full |
| Nightly | ZAP baseline, `pnpm audit --prod`, Trivy image scan, the 1-hour property runs, CSV parser fuzz |
| Every release | `06` §17.4 manual matrix M-01…M-12 against staging |
| Quarterly | The deferred-control review (`06` §19.1) and an external penetration test before first production use, then annually |

The manual matrix is the part teams skip. It is a release blocker because every item on it tests
authorization *semantics* — whether user A can read user B's saved view — which no scanner can determine.

### 6.12 Test data

- **Factories** (`packages/testing/src/factories`) build entities with valid defaults and explicit
  overrides. A factory never generates random values that make a failure unreproducible; the PRNG is seeded
  per test from the test name, so a failure reproduces exactly.
- **Golden fixtures** are versioned files, reviewed like code. A golden file changed in a PR is a signal to
  read the PR carefully, which is the point.
- **No production data**, ever (§3.3).
- **The `trade-soft` dataset** is the same in `local`, `ci` and E2E: 50 instruments across NSE/BSE/MCX/NCDEX,
  three years of daily and one year of 15-minute bars, two corporates actions, one index with members, two
  market groups, four users (one per role), and the deliberate defects of §6.8. It is generated by a script
  with a fixed seed, so the same commit produces byte-identical data.

### 6.13 CI pipeline

| Stage | Contents | Wall time | Fails the pipeline |
|---|---|---|---|
| 1. Static | `tsc --noEmit`, ESLint, Prettier check, package-boundary rule, decimal-discipline rule | 60 s | Yes |
| 2. Unit | `packages/engines`, `packages/domain`, `packages/contracts` | 20 s | Yes |
| 3. Contract | OpenAPI generation + assertions, error registry, decimal walk, permission matrix | 40 s | Yes |
| 4. Integration | Testcontainers suite, all 16 concurrency scenarios, migration-from-empty and from-previous | 6 min | Yes |
| 5. Build | Container image, SBOM, Trivy scan, image digest recorded | 3 min | Yes (HIGH/CRITICAL) |
| 6. E2E | Playwright against the built image + seeded database | 5 min | Yes on `main`; advisory on PRs |
| 7. Security fast | SEC-T structural set, `pnpm audit --prod` | 90 s | Yes |
| 8. Nightly | Full property runs, ZAP, performance budgets, plan regression, full audit-chain verification | 45 min | Yes, blocks release |

Stages 1–4 run on every commit; 5–7 on every PR to `main`; 8 nightly and on any release candidate. The
whole per-commit path is under nine minutes, which is the number that decides whether people run it
locally before pushing.

### 6.14 Coverage

Coverage is a **per-package floor**, not a global target, because a global number lets a well-tested engine
hide an untested route:

| Package | Line | Branch | Rationale |
|---|---|---|---|
| `packages/engines` | 95 % | 92 % | Every branch is a number a user sees |
| `packages/domain` | 95 % | 90 % | Invariants live here |
| `packages/contracts` | 90 % | 85 % | Schemas are mostly declarative |
| `packages/db` (repositories) | 85 % | 75 % | Covered by integration tests, counted once |
| `packages/ingestion` | 90 % | 85 % | Validators are the data-quality gate |
| `apps/api` (routes/services) | 80 % | 70 % | Contract tests cover the shape; branch coverage of error paths matters more than the number |
| `apps/web` | 60 % | 50 % | E2E covers the journeys; component tests cover formatting and decimal handling |

A drop below the floor fails the build. Raising a floor is a normal PR; lowering one requires a comment in
the PR explaining which code is deliberately untested and why.

### 6.15 What is deliberately not tested

| Not tested | Why |
|---|---|
| Third-party libraries' internals | Argon2id, the JWT verifier and the chart library are tested by their maintainers; we test the properties we depend on (`06` §17.3) |
| Exact query cost numbers | Costs move with statistics; plan **shape** is the stable signal (§6.9) |
| The SPA's visual appearance pixel-by-pixel | A snapshot test of a chart canvas fails on font rendering and proves nothing about correctness |
| Failure injection at the network layer | There is one network hop to the database and one to SMTP; killing the database and the SMTP connection covers the realistic cases |
| Chaos engineering | At this scale, a chaos experiment costs a day and finds what a code read finds in an hour. Revisit after the first multi-node deployment |
| Browser matrix | The product is used by staff on the current Chrome/Edge/Firefox; a Safari 12 test would be a false comfort |

---

## 7. Deployment

### 7.1 Artefacts and versioning

One release produces four artefacts, all tagged with the same version and all traceable to one commit:

| Artefact | Form | Identity used for deploy |
|---|---|---|
| `api` image | OCI image | **Digest** (`sha256:…`), never the tag |
| `worker` image | Same image, different command | Same digest |
| `scheduler` image | Same image, different command | Same digest |
| SPA bundle | Static files in the image, served by the proxy | Same digest |
| Migration bundle | Same image, `migrate` command | Same digest |

The single-image-multiple-commands choice is deliberate: three images built from one commit at different
times can differ, and a worker running different code from the API is a class of bug that is invisible
until a job writes a shape the API cannot read.

`BUILD_SHA` is injected at build time and exposed by `/meta` and every log line. Given a log line, an
operator can name the commit; given a commit, the registry can name the digest. That chain is checked
during an incident, not after.

**Applications never run migrations at boot.** A process that migrates on start will, during a rolling
deploy, race another process doing the same thing, and will migrate a database that an older instance is
still serving. Migrations are a separate one-shot step (§7.3, step 2) with its own advisory lock (`02` §8).

### 7.2 Release checklist

Completed and pasted into the release note **before** touching production. Every line is a command with an
observable result, because a checklist of intentions is a checklist nobody follows.

| # | Check | Command / evidence | Blocks release |
|---|---|---|---|
| 1 | CI green on the release commit, including nightly stage 8 | CI run URL | Yes |
| 2 | Image digest recorded and matches what staging validated | `docker image inspect --format '{{index .RepoDigests 0}}'` | Yes |
| 3 | No open `HIGH`/`CRITICAL` scan findings (`06` G-S3) | Trivy and `pnpm audit --prod` output | Yes |
| 4 | Migrations reviewed; any destructive change is in a **separate** release (§7.5) | PR label `migration:additive` or `migration:destructive` | Yes |
| 5 | Backup completed in the last 24 h and WAL archiving has no gap | `select last_archived_wal, last_archived_time from pg_stat_archiver` | Yes |
| 6 | Restore drill passed in the last 7 days (for a release touching migrations) | Drill record | Yes for migration releases |
| 7 | Staging has run the release for ≥ 24 h with the same digest | Staging `/meta` `buildSha` | Yes for major releases |
| 8 | Rollback target identified: previous digest and whether it is schema-compatible | Previous release note | Yes |
| 9 | Secret rotation due? (`JWT_SIGNING_KEY` 90 d, `MFA_ENCRYPTION_KEY` 12 mo, DB 6 mo) | Rotation log | Not blocking, but scheduled in the same window |
| 10 | On-call aware, and nobody deploys after 15:00 IST on a trading day or on a expiry day | Ops log | Yes |

Item 10 is not superstition. A deploy at 15:45 on a Thursday is a deploy during the window when the EOD
pipeline starts, and the cost of waiting until 18:00 is four hours; the cost of a bad interaction is a
night of reconciliation.

### 7.3 Deploy procedure

```bash
cd /opt/tradesoft
export RELEASE=2026.11.3
export DIGEST=sha256:4f1c9ab...        # from §7.2 step 2

# 0. Record intent. This line is what makes the deploy auditable.
echo "$(date -Is) deploy $RELEASE $DIGEST by $USER" >> /var/log/tradesoft/deploys.log

# 1. Pre-flight: disk, WAL, migration head, current health.
df -h / /data | tail -n +2
psql "$MIGRATOR_DATABASE_URL" -c "select last_archived_time from pg_stat_archiver"
curl -fsS http://127.0.0.1:3000/readyz | jq '.status'

# 2. Migrations (one-shot, advisory-locked, refuses on checksum drift).
docker compose -f infra/compose/docker-compose.prod.yml run --rm migrate

# 3. Worker: stop claiming, finish in-flight, restart on the new digest.
docker compose -f infra/compose/docker-compose.prod.yml up -d --no-deps worker

# 4. API: rolling, one instance at a time, behind the proxy.
docker compose -f infra/compose/docker-compose.prod.yml up -d --no-deps --scale api=2 api

# 5. Scheduler: restart is safe at any time (advisory lock; missed ticks are caught up).
docker compose -f infra/compose/docker-compose.prod.yml up -d --no-deps scheduler

# 6. Verify.
curl -fsS http://127.0.0.1:3000/readyz | jq '.checks | map_values(.ok)'
curl -fsS -H "Authorization: Bearer $OPS_METRICS_TOKEN" http://127.0.0.1:9090/metrics \
  | grep -E 'authz_unprotected_routes|build_info'
```

Ordering rationale, because it is not arbitrary:

- **Migrations before code** works only for additive migrations. For a contract release (dropping a
  column), the migration runs *after* the new code has been live for a week — see §7.5.
- **Worker before API** because an API that enqueues a job type the old worker does not know is a
  dead-letter; a worker that knows a job type the old API does not enqueue is harmless.
- **Scheduler last** because restarting it re-evaluates every due schedule; doing that while the worker is
  mid-deploy would enqueue work with nowhere to run.

**Expected transient on every deploy:** `CURSOR_SECRET` rotates (`06` §12.1), so any client holding a
pagination cursor receives `400 PAGE_CURSOR_INVALID` and refetches the first page. This is designed
behaviour and is announced in the release note; it is not a regression. Refresh tokens survive, because
they are database rows, not signed blobs.

### 7.4 Graceful shutdown and connection draining

The proxy removes an instance from rotation when `/readyz` fails, and the application fails `/readyz` as
soon as `SIGTERM` arrives — before it stops serving. That ordering is what makes a rolling deploy
zero-downtime without a service mesh.

| Process | On `SIGTERM` | Hard deadline |
|---|---|---|
| `api` | `/readyz` → `503`; stop accepting new connections; finish in-flight requests; close the pool | 25 s, then `SIGKILL` |
| `worker` | Stop claiming; finish the current job and commit; release its advisory locks; exit | 120 s, then the job is reclaimed by the reaper (safe, because every handler is idempotent) |
| `scheduler` | Release the advisory lock; exit | 5 s |

The 120 s worker deadline is longer than the 60 s default job budget and shorter than the 5 min lock
expiry, so a normal job always finishes and a pathological one is reclaimed rather than blocking a deploy.

### 7.5 Migration safety rules

Rules that are enforced in review and, where possible, by the migration runner:

1. **Additive first.** New columns are nullable or have a default; new tables and indexes are additive; no
   column is renamed or dropped in the same release that stops using it.
2. **Two-release rule for destructive changes.** Release *N* deploys code that no longer reads the column.
   Release *N+1*, at least seven days later, drops it. This makes "roll back the app" a valid recovery
   option, which it is not if the column is already gone.
3. **`lock_timeout` on every DDL statement.** `SET lock_timeout = '3s'` at the top of every migration
   file. A migration that cannot get its lock fails and is retried, rather than blocking every reader
   behind it — the classic way a five-second deploy becomes a twenty-minute outage.
4. **`statement_timeout` except for index builds.** `SET statement_timeout = '60s'` normally;
   `CREATE INDEX CONCURRENTLY` runs in a `-- migrate:no-transaction` file with no statement timeout
   (`02` §8).
5. **No data movement in DDL.** Backfills are jobs (`maintenance.backfill_*`), batched and resumable, so
   that a failed backfill does not roll back a schema change and a long backfill does not hold a lock.
6. **No `NOT NULL` without a backfill and a validated constraint.** Add the column nullable, backfill,
   `ALTER TABLE … VALIDATE CONSTRAINT`, then `SET NOT NULL`.
7. **Every migration is reviewed by someone who has read `02` §8.** A migration is the only change that
   cannot be un-deployed by redeploying an image.

### 7.6 Rollback

| Situation | Action | Data consequence |
|---|---|---|
| New code is defective, migrations were additive | Redeploy previous digest; optionally run a compensating forward migration | None; the additive columns stay and are ignored |
| New code is defective and wrote bad derived data | Redeploy, then `POST /admin/recompute` scoped to the affected range | Derived rows rebuilt; ingested bars untouched |
| New code is defective and wrote bad **ingested** bars | Redeploy, then a correction batch with justification (BR-044) | Original values preserved in `market_bar_history` |
| Migration is defective | Forward fix as a new migration; restore only if data was destroyed | Restore loses everything after the backup (RPO ≤ 15 min) |
| Database corrupted | Restore base backup + WAL replay (§7.7) | RPO ≤ 15 min, RTO ≤ 2 h (A9) |

Two things are explicitly **not** rollback options:

- **Reverting a migration by hand.** The runner refuses a changed checksum, and a hand-reverted schema
  leaves `ops.schema_migration` lying about the state. The only correct fix is a new forward migration.
- **Restoring to "just before the bad deploy" as a routine move.** A restore discards every bar ingested
  after the backup and every audit row written since — including the rows that would tell you what
  happened. It is a last resort for corruption, not a deployment tool.

### 7.7 Backup and restore drills

**Continuous.** WAL archiving to off-host storage; nightly `pg_dump --format=custom`, encrypted with `age`
to `AGE_BACKUP_RECIPIENT`, retained 30 days (`02` §13). The raw-import volume is backed up alongside,
because it is the only recovery path that does not depend on the database.

**Weekly drill**, executed by `infra/scripts/restore-drill.sh`, which is itself reviewed like code:

```bash
# 1. Restore the newest base backup into a scratch cluster (never the production host).
age --decrypt -i "$AGE_BACKUP_IDENTITY" backups/latest.dump.age | pg_restore -d tradesoft_drill

# 2. Replay WAL to the latest archived segment.
# 3. Verify. Any failure here fails the drill and raises P1.
psql -d tradesoft_drill -f scripts/verify-restore.sql
```

`verify-restore.sql` asserts six things, each of which has failed in a real system somewhere:

| Check | Expected |
|---|---|
| `count(*) from md.market_bar where timeframe='1D'` | Within 2 % of production's count at the backup's timestamp |
| Newest `session_date` in `md.market_bar` | The most recent completed trading day at backup time |
| `count(*) from audit.audit_event` | Matches the count in the nightly anchor manifest |
| Chain verification over the last 1,000 audit rows | `firstBreak = none` |
| `select count(*) from ops.schema_migration where version > <head>` | `0` |
| `select count(*) from md.market_bar` for every partition in `pg_inherits` | No partition is empty that should not be |
| `select count(*) from ref.instrument where is_synthetic` | GS Composite exists and its `1D` bars are present |

**Recorded outcome.** Date, backup age, restore duration, verification result, and the name of the person
who ran it, in `docs/runbooks/restore-log.md`. Duration is compared against the RTO of 2 h; two
consecutive drills above 90 minutes is a P2 against the backup strategy.

The drill is run against a **scratch** cluster with the same PostgreSQL major version and the same
`postgresql.conf` tuning. A restore that is fast on a laptop proves nothing about the host.

### 7.8 Configuration and secret changes

| Change | Procedure | Restart required |
|---|---|---|
| Non-secret `config` value | Update the compose env file, `up -d` the affected service | Yes, that service |
| Runtime setting in `ops.system_setting` | `PUT /admin/settings/{key}` (`settings:write`), audited | No — read per use |
| `JWT_SIGNING_KEY` rotation | `06` §12.4: new key becomes `CURRENT`, old becomes `PREVIOUS` for 20 min, then cleared | Rolling restart of `api` |
| `MFA_ENCRYPTION_KEY` rotation | `06` §12.4 re-encrypts all `totp_secret_ct` in one transaction | `api` restart after |
| `CURSOR_SECRET` | Regenerated on every deploy; no procedure needed | Covered by the deploy |
| Database password | `ALTER ROLE … PASSWORD`, update the secret file, rolling restart | Rolling |
| SMTP password | Update the secret file, restart `worker` | `worker` |

The split between `config` and `ops.system_setting` is not arbitrary: a value that an operator might
reasonably change during an incident without a deploy (scanner statement timeout, staleness tolerance)
belongs in the database; a value that determines how the process behaves structurally (pool size, port,
log level) belongs in the environment. A value in neither place does not exist.

### 7.9 One-time host hardening

`06` §17.6 requires these and calls them a runbook rather than code, because they are not reproducible
from the repository. Executed once per host, verified at each release:

```bash
# Users and SSH
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/'      /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh

# Firewall: 22 from the bastion/allowlist only, 80/443 public, nothing else.
ufw default deny incoming
ufw default allow outgoing
ufw allow from <BASTION_CIDR> to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Unattended security updates; no automatic reboot during market hours.
dpkg-reconfigure -plow unattended-upgrades
systemctl disable --now apt-daily-upgrade.timer
systemctl enable --now apt-daily-upgrade.timer   # with the override below
# /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf  → OnCalendar=*-*-* 02:30

# Docker: bind the daemon to the unix socket only, enable log rotation.
# /etc/docker/daemon.json → {"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"5"}}

# Time sync matters: session boundaries and token expiry depend on it.
timedatectl set-timezone Asia/Kolkata
timedatectl set-ntp true
```

Verification at each release (`06` G-S6 plus host checks): `sshd -T | grep -E 'permitrootlogin|passwordauthentication'`
returns `no`/`no`; `ufw status verbose` shows only the three rules; `timedatectl` shows NTP synchronised;
`docker info | grep -i 'logging driver'` shows `json-file`.

The host timezone is `Asia/Kolkata` for human convenience only. Every stored timestamp is `timestamptz` in
UTC (`02` §1); a host in the wrong timezone would change log readability and nothing else. That is the
test of whether a time model is correct.

### 7.10 First production deployment

The day-0 sequence differs from a routine deploy in four ways, and each has bitten a real system:

1. **Two admins exist before the gate review.** Accept both invitations, enrol MFA on both, and confirm
   `select count(*) from iam.app_user where status='ACTIVE'` returns 2 with `ADMIN` role.
2. **Secrets are freshly generated, not copied from staging.** `06` G-S4 checks this explicitly.
3. **The first nightly anchor does not exist yet.** G-S7 therefore cannot be satisfied on day 0; the launch
   is declared complete the following morning, after the first anchor and the first full nightly pipeline.
   Plan the announcement for day 1, not day 0.
4. **The first EOD pipeline run is watched, not assumed.** Someone sits with the **Pipeline** dashboard from
   18:00 to 20:30 IST on the first trading day and records the stage durations. Those numbers become the
   baseline for AL-08's threshold, which is otherwise a guess.

### 7.11 What a deploy never does

- Never runs migrations on application boot.
- Never drops a partition, purges retention data, or rebuilds a Renko set. Those are jobs with their own
  authorisation and dry-run mode.
- Never resets a password, a role, or a scanner definition.
- Never seeds reference data. The structural seed runs once, in the migration that creates the tables.
- Never deletes an import file. Retention is a job; deletion during deploy would race an in-flight batch.
- Never "fixes" data. A deploy that changes a stored value is a correction without a justification, and
  BR-044 forbids it.

---

## 8. Runbooks

Each runbook is written to be executed by one person at 07:30 with a laptop and a bastion, in the order
given. Commands assume `$MIGRATOR_DATABASE_URL` is exported and the working directory is
`/opt/tradesoft`. Where a security cause is possible, the runbook hands off to `06` §18.2 rather than
improvising.

### RB-01 — API errors or latency

**Trigger:** AL-01, AL-02, AL-23.

1. **Scope it.** `curl -s http://127.0.0.1:3000/readyz | jq`. If `database` is false, go to RB-02. If
   `schemaVersion` is false, a deploy skipped the migration — stop and redeploy correctly (`§7.3` step 2).
2. **Is it one route or all?** `topk(5, sum by (route) (rate(tradesoft_http_requests_total{status_class="5xx"}[5m])))`.
   A single route points at a query or a handler; all routes point at the database, the pool, or the host.
3. **Check the pool.** `tradesoft_db_pool_in_use` at its ceiling with `pool_wait_seconds` rising means
   requests are queueing for connections, not failing on their own. Go to RB-02.
4. **Check the host.** `uptime`, `free -h`, `df -h`. Memory exhaustion shows as `api` restarts in
   `docker ps -a`; go to AL-23's cause (a leak) rather than restarting on a timer.
5. **Read the errors.** `docker logs --since 15m api 2>&1 | jq -r 'select(.level>=50) | .msg' | sort | uniq -c | sort -rn | head`.
   Stable `msg` values are the point of the level discipline in §4.2.
6. **If a deploy preceded it by < 30 min,** roll back (`§7.6` row 1) before investigating further. The
   fastest diagnosis of a bad deploy is not having it deployed.
7. **Verify:** AL-01 silent for 15 min, `/readyz` green on both instances, p95 inside `05` §15.

**Escalate:** if rollback does not restore p95, the cause is data volume or a plan change — RB-02 and
`§6.9`'s plan regression baseline.

### RB-02 — Database saturation

**Trigger:** AL-03, AL-04, AL-17, or step 3 of RB-01.

1. **Classify the pressure.**
   ```sql
   select state, wait_event_type, wait_event, count(*)
     from pg_stat_activity where datname = 'tradesoft'
    group by 1,2,3 order by 4 desc;
   ```
   Many `idle in transaction` → a leaked transaction in application code. Many `Lock: transactionid` →
   a migration or a long transaction holding a row lock. Many `IO: DataFileRead` → cache miss from a
   large scan.
2. **Find the long ones.**
   ```sql
   select pid, now() - xact_start as age, left(query, 120)
     from pg_stat_activity
    where datname='tradesoft' and xact_start is not null
    order by age desc limit 10;
   ```
   Anything over 60 s outside a known job is a defect. `pg_terminate_backend(pid)` is a last resort and
   must be recorded — a terminated analytics transaction is safe (jobs are idempotent), a terminated
   ingest transaction is also safe (atomic), a terminated migration is not (forward-fix it).
3. **Check the pool ceiling.** `select count(*), state from pg_stat_activity where usename='tradesoft_app' group by 2;`
   against `DATABASE_POOL_MAX × instances`. If the application pool is exhausted by `idle` connections,
   the pool is misconfigured, not the database.
4. **Check for lock waits caused by DDL.**
   ```sql
   select blocked.pid, blocking.pid, left(blocking.query,80)
     from pg_stat_activity blocked
     join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid));
   ```
   A migration holding an `ACCESS EXCLUSIVE` lock is the answer; kill the migration, not the readers.
5. **If a rate limiter is degraded** (AL-17), the fail-open path is working as designed (`05` §9.3). Fix
   the database; do not disable the limiter.
6. **Verify:** `pool_in_use` below 70 %, no wait event above 5 % of sessions, AL-03/AL-04 silent.

**Never:** raise `DATABASE_POOL_MAX` to hide a leak, or restart PostgreSQL during a session. Both convert
a degradation into an outage.

### RB-03 — Ingestion stalled, failing, or a source is stale

**Trigger:** AL-06, AL-19, a batch stuck in `RECEIVED`/`VALIDATING`/`PERSISTING`, or an operator reporting
"today's file did not land".

1. **Locate the batch.**
   ```sql
   select id, status, source_id, session_date, received_at, updated_at,
          rows_total, rows_accepted, rows_rejected
     from md.import_batch
    where session_date >= current_date - 2
    order by received_at desc limit 20;
   ```
2. **If `status` has not changed in > 10 min,** the job is not running. Check `ops.job` for the batch's
   `ingestion.parse_validate` / `persist_bars` / `reconcile` job: `status`, `attempts`, `last_error`.
3. **If `DEAD_LETTER`,** read `last_error.code`:
   - `VALIDATION_FAILED` → the file is wrong. Do not retry; obtain a corrected file and upload it as a new
     batch. The original batch is terminal and immutable (`03` §4).
   - `PERSISTING_FAILED` / `PARTITION_MISSING` → RB-06.
   - `DUPLICATE_FILE` → the file was already ingested; the existing batch id is in the error. No action.
4. **If the job is `QUEUED` and the queue is deep,** the worker is down or starved: `docker ps`, then
   `docker logs --since 10m worker | jq -r 'select(.level>=40) | .msg' | sort | uniq -c`.
5. **Retry safely.** `POST /api/v1/admin/jobs/{id}/retry` (`job:retry`) resets attempts and clears
   completion. This is audited. Never re-upload the same file to "push it through": the `sha256` unique
   constraint returns `409` and, if it did not, you would double-ingest.
6. **If the source itself is stale** (AL-19) and no file exists, the vendor has not delivered. Record it,
   notify the data owner, and do not fabricate bars. A missing session is visible and recoverable; a
   fabricated one is not.
7. **Verify:** batch reaches `COMPLETED` or an explicit terminal failure; `tradesoft_ingestion_source_age_seconds`
   falls below 25 h; the session appears in `/dashboard/freshness`.

### RB-04 — Reconciliation failure or open data-quality findings

**Trigger:** AL-11, AL-24, or a batch in `RECONCILIATION_FAILED`.

1. **Read the failure.**
   ```sql
   select id, status, reconciliation_summary
     from md.import_batch where status = 'RECONCILIATION_FAILED'
    order by updated_at desc limit 5;
   ```
   `reconciliation_summary` names the rule (`MISSING_SESSIONS`, `VOLUME_MISMATCH`, `OHLC_DISAGREEMENT`,
   `CLOSE_OUT_OF_RANGE`) and the affected counts.
2. **Remember the contract:** reconciliation failure does **not** roll back committed bars (`03` §3.5).
   The bars are visible and flagged. Do not assume the data is absent.
3. **For `MISSING_SESSIONS`:** cross-check `ref.trading_calendar`. A missing session that is a holiday in
   the calendar but present in the file is a calendar defect; fix the calendar (`calendar:write`, audited),
   then re-run reconciliation via `POST /ingestion/batches/{id}/reconcile`.
4. **For value mismatches:** compare against the source of record for a sample. If the vendor is wrong,
   the batch stays failed and a corrected file is ingested as a new batch with `supersedes_batch_id`.
   If we are wrong, that is a P1 defect — the bars are already visible, so open an INC-1 and consider
   quarantine (`md.bar_quality_issue` at `ERROR` excludes the instrument from scanners until resolved).
5. **Resolve or waive findings** through `POST /market-data/quality-issues/{id}/resolve`
   (`dataquality:write`), with a reason. Waiving is audited; a waiver is a decision, not a dismissal.
6. **Verify:** no batch in `RECONCILIATION_FAILED` for the session; `data_quality_open_issues{severity="ERROR"}`
   is zero or every remaining row has a documented waiver.

### RB-05 — Pipeline lag, scheduler down, or the nightly run will overrun

**Trigger:** AL-07, AL-08, AL-14, or the Pipeline dashboard showing the 18:00 run past 20:00.

1. **Is the scheduler alive?** `docker ps --filter name=scheduler`; `docker logs --since 10m scheduler`.
   The loop logs one line per tick at `debug` (absent in production) and one per fire at `info`. No fire
   lines at 18:00 means the schedule is disabled or the cron is wrong:
   `select code, cron, timezone, is_enabled, next_run_at from ops.job_schedule where code like 'eod%';`
2. **Is the worker processing?**
   ```sql
   select queue, status, count(*), min(run_after) as oldest
     from ops.job group by 1,2 order by 1,2;
   ```
   `QUEUED` growing with `RUNNING` flat → worker down, crashed, or blocked on an advisory lock held by a
   dead session.
3. **Find the blocked dataset.** `tradesoft_watermark_lag_seconds` by dataset and timeframe identifies
   which stage stopped. A lag on `RENKO` only is a Renko job problem; a lag on everything is the worker.
4. **If the run will overrun the 60-minute budget,** reduce scope deliberately rather than letting it
   fail: raise `indicator_batch_size` if the bottleneck is per-job overhead, or run the remaining
   timeframes in a second pass and accept `is_partial` on the higher timeframes until they complete. Record
   the decision; do not silently skip a timeframe, because the scanner's staleness guard will then exclude
   the instruments and produce a *confident empty result*, which is the worst failure mode in the product.
5. **If a job is stuck `RUNNING` with an expired lock,** the reaper will reclaim it within 60 s. If it does
   not, `maintenance.reclaim_stale_jobs` is failing — treat as RB-08.
6. **Verify:** `pipeline_lag_seconds` for all datasets below the 20:30 IST target; the next morning's
   dashboard shows the session as current.

### RB-06 — Partition runway exhausted

**Trigger:** AL-13, or an insert failing with `no partition of relation "market_bar" found for row`.

1. **Measure the runway.**
   ```sql
   select relname, pg_get_expr(relpartbound, oid) as bounds
     from pg_class c join pg_inherits i on i.inhrelid = c.oid
     join pg_class p on p.oid = i.inhparent
    where p.relname in ('market_bar','indicator_value','audit_event','market_bar_history','domain_event')
    order by p.relname, relname desc limit 12;
   ```
   Compare the highest bound to `now()`. Three months ahead is the target; less than one month is a P1
   because ingestion fails **loudly** with no default partition (`02` §6), which stops the pipeline.
2. **Create the missing partitions immediately.** `maintenance.partition_rollover` is idempotent
   (`CREATE TABLE IF NOT EXISTS`), so run it directly with a larger window:
   `docker compose run --rm worker node dist/jobs/partition-rollover.js --months-ahead=6`
3. **Find out why the job did not run.** A rollover failure is almost always permissions on the schema or
   a lock timeout. `select * from ops.job where job_type='maintenance.partition_rollover' order by created_at desc limit 5;`
4. **Never add a `DEFAULT` partition** to unblock ingestion. It would silently accumulate rows that no
   retention policy and no `DROP PARTITION` will ever reach — the exact failure the design forbids.
5. **Verify:** inserts succeed, `tradesoft_pg_partition_runway_months ≥ 3`, and AL-13 clears.

### RB-07 — Disk pressure

**Trigger:** AL-12.

1. **Where.**
   ```bash
   df -h / /data /backups
   du -xh --max-depth=2 /data | sort -h | tail -20
   ```
   `/data` growth is usually the raw-import volume (files retained per `06` §11.2) or a runaway backup.
2. **What is safe to remove, in order:** `.tmp` files older than 24 h (the janitor job's own domain — if
   they exist, the janitor is failing), unreferenced import files older than 24 h (same), old
   `pg_wal` segments **only if** `pg_stat_archiver` shows them archived. Never delete `pg_wal` by hand
   without checking `last_archived_wal` — that is how a database loses the ability to recover.
3. **If `/` is full because of Docker:** `docker system df`, then `docker image prune -f` for dangling
   images only. Never `docker system prune --volumes` on this host: the database volume is a volume.
4. **If `/backups` is full,** the retention job is failing. Deleting the oldest backup is acceptable only
   after confirming the newest one restored in the last drill.
5. **Verify:** `disk_free_bytes` above 20 GB on `/data`, above 10 GB on `/`, janitor job green on its next
   run.

### RB-08 — Job backlog and dead letters

**Trigger:** AL-05, AL-06, `job_dead_letter_total > 0`.

1. **Size it.**
   ```sql
   select job_type, status, count(*), max(attempts) as max_attempts, min(created_at) as oldest
     from ops.job where status in ('QUEUED','RUNNING','DEAD_LETTER')
    group by 1,2 order by 3 desc limit 20;
   ```
2. **One type or many?** One type with a growing backlog is a handler that is slow or failing; many types
   is a worker capacity or database problem (RB-02).
3. **Dead letters are reviewable artefacts, not log lines** (`03` §5.4). Read the newest:
   `GET /api/v1/admin/jobs?status=DEAD_LETTER` and inspect `last_error.code`. Retry only after the cause
   is understood; the retry resets `attempts` and is audited.
4. **If the same job re-dead-letters after retry,** the payload is poisonous or the handler is defective.
   Do not retry a third time: treat it as a defect, and for an ingestion job, recover by re-uploading a
   corrected file as a new batch (the original is terminal and immutable).
5. **Never delete jobs to clear a backlog.** `COMPLETED` jobs expire after 30 days by retention; dead
   letters do not expire, deliberately.
6. **Verify:** `QUEUED` depth falling, no new dead letters for 30 min, `outbox_backlog_age_seconds` under
   5 min.

### RB-09 — Scanner slow, timing out, or confidently empty

**Trigger:** AL-16, a `422 SCANNER_TIMEOUT`, or a user reporting "the scan returns nothing".

1. **Three different failures wear the same complaint,** and they have different causes:

   | Symptom | Evidence | Cause lives in |
   |---|---|---|
   | Slow but completes | p95 `> 2 s`, `duration_ms` high | the compiled SQL or the universe size |
   | Timed out | `422 SCANNER_TIMEOUT`, `scan.scanner_run.status = 'FAILED'` | the plan, or a missing snapshot |
   | Empty result | completed, zero rows | almost always snapshot staleness, not the condition |

   **Empty is not automatically wrong.** A condition that legitimately matches nothing on a quiet session is
   a correct answer. But an empty result produced by the *staleness guard excluding the whole universe* is
   the worst failure mode in the product (`§RB-05` step 4): it looks like a market observation and is
   actually a pipeline outage. Rule that out first.
2. **Check snapshot freshness before reading the definition.**
   ```sql
   select timeframe, max(as_of_bucket) as newest, count(*) as rows
     from an.indicator_snapshot
    group by 1 order by 1;
   ```
   Compare `newest` per timeframe against the newest `md.market_bar.bucket_start` for the same timeframe. A
   snapshot trailing by one session is RB-05, not RB-09, and no amount of scanner investigation will fix it.
3. **Read the run, not the query.** `scan.scanner_run` records `universe_size`, `rows_examined`,
   `duration_ms`, `status`, and `error_code`. Ten thousand rows examined in four seconds is a planner
   problem; four hundred thousand rows examined is a universe or condition problem.
4. **Reproduce with the plan.** Take the definition's compiled statement and run
   `explain (analyze, buffers, format text)`. Three shapes account for nearly every regression:
   - `Seq Scan on an.indicator_snapshot` — the driving predicate does not lead with `(instrument_id,
     timeframe, params_hash)`, so the index `an.indicator_snapshot` exists for is unused.
   - `Nested Loop` with thousands of iterations over `ref.instrument` — the universe resolved to a list
     rather than a set membership.
   - `SubPlan` or a re-executed `LATERAL` under the join — a condition that needs bar columns (not snapshot
     columns) is re-reading `md.market_bar` per row (`04` §8.3).
5. **The four common causes, in order of frequency.**
   - An `INSTRUMENTS` universe carrying near the 5,000 cap. Replace with a group or index membership; the
     cap is a bound on accidental cost, not a target.
   - `MTF_ALIGN` across `1D` and `15m`. The `15m` snapshot set is roughly 25× the daily one; the same
     condition over both timeframes is not the same query cost.
   - A `paramsHash` for an indicator parameter set that no snapshot row was ever written for. The join
     degenerates to nulls and the run reports empty rather than failing.
   - A condition on a bar column forcing the `LATERAL` path onto daily bars instead of the snapshot.
6. **Do not raise `scanner.statement_timeout_ms` as the first move.** It converts a fast, visible failure
   into a slow one that holds a pooled connection (`06` §16). Raise it only after the plan is understood,
   by at most 2×, and write down why in the change record.
7. **Disable a pathological definition instead of deleting it.** System scanners refuse in-place edits
   (`SCANNER_IMMUTABLE_SYSTEM`): clone, disable the clone, and file a defect against the original condition
   tree. Deleting a definition removes the evidence of what it was doing.
8. **Verify:** AL-16 silent, p95 under 2 s on the Scanner dashboard, and a known-true control scan returns a
   non-empty set — for example, index members with `CLOSE > SMA(50)` on `1D` for a session where the index
   closed above its 50-session average.

**Escalate:** if one definition is fast and another over the same universe is not, the difference is the
condition tree, and the fix is a registry-level bug in the compiler, not an operator setting.

### RB-10 — Audit chain verification failure

**Trigger:** AL-10, `firstBreakId != null` from any verification path, or `verify-audit-chain --full`
printing anything other than `firstBreak=none anchors=ok`.

1. **Get the coordinates.** The three verification paths in `§5.5` all return the same shape; use the
   cheapest one that covers the window.
   ```sql
   select * from audit.verify_chain(now() - interval '30 days');
   ```
   Record `firstBreakId`, `firstBreakAt`, and the stored versus recomputed hash. Everything after this step
   depends on which of the two mismatched.
2. **An `id` gap is not a break.** `audit.chain_hash()` assigns `id` with `nextval` inside a `BEFORE INSERT`
   trigger, and `nextval` is not transactional: a rolled-back business transaction consumes a sequence value
   and leaves a permanent, harmless gap. **Only a `prev_hash` mismatch or a `hash`-recomputation mismatch is
   a break.** Reading a gap as tampering burns an incident; reading a break as a gap hides one.
3. **Classify it before touching anything.**

   | Evidence | Most likely cause | Go to |
   |---|---|---|
   | `prev_hash` ≠ the previous row's `hash`, and both hashes recompute correctly from their own columns | A second writer inserted out of order — a connection not at `READ COMMITTED`, so its snapshot predated the advisory lock (`§5.3`) | step 4 |
   | Stored `hash` ≠ recomputation from the row's own columns | The row was `UPDATE`d after insertion | step 4 |
   | Both, across a contiguous block | A restore lost or reordered rows, or a partition was detached and reloaded | RB-14 |
   | Break begins at the oldest row of a partition | A partition was attached already containing content | step 5 |

4. **Either of the first two rows is an integrity incident, not a bug report.** Both imply a writer that
   bypassed the controls the design relies on — a role holding `UPDATE` on `audit.audit_event`, a session
   with the wrong isolation level, or an application path that opened its own connection outside the audited
   write helper. Open an INC-1, and if any credential path is implicated, run RB-12 in parallel.
5. **Never repair the chain by recomputing hashes.** A recomputed chain is indistinguishable from a chain
   that was never broken, which is exactly the property the chain exists to provide. Instead: copy the
   affected partition to the evidence store with a checksum, record the break id and time in the anchor
   manifest for that day, and let verification continue from the last intact row. Rows after a break are
   **unverified**, and any report quoting them must say so in the same sentence.
6. **Bound the window of doubt.** The highest verified `id` before the break and the break `id` bound it.
   Nothing outside that window is affected, and the incident record should state the window rather than
   implying the whole table is suspect — an over-broad caveat is as misleading as none.
7. **Cross-check the nightly anchor.** The anchor holds `{lastId, terminalHash, rowCount}` from storage whose
   credentials are not on the application host (`§5.4`). If the anchor's `terminalHash` disagrees with the
   recomputed hash at its `id`, the break predates that anchor and the window is wider than step 6 says. If
   it agrees, the break is after the anchor and the window is narrower.
8. **Verify:** a full run prints `firstBreak=none` for every row after the documented break, the incident
   record names the window and the day's anchor is annotated, and the weekly review (`§5.10`) signs off the
   caveat.

**Never:** drop and recreate the audit partition, truncate the table, or re-seed it. Any of the three
destroys the evidence and the control in one statement.

### RB-11 — Authorization anomaly: unprotected route or permission drift

**Trigger:** AL-20 (`tradesoft_authz_unprotected_routes > 0`), a `403` spike, or `PERMISSION_DENIED` events
clustering on one route.

1. **`authz_unprotected_routes` cannot drift at runtime.** `06` §8 installs an `onRoute` hook that refuses
   to register any route whose config lacks `permission` or `public`; the gauge is set during boot and never
   changes afterwards. A non-zero value therefore means a route was registered through the raw Fastify
   instance after the hook ran, or through a plugin loaded outside the guard. Both are deploy defects, not
   configuration drift.
   ```bash
   docker logs --since 10m api | jq -r 'select(.msg|test("permission";"i")) | [.route,.msg] | @tsv'
   ```
2. **Contain before diagnosing.** If the offending route mutates data, remove the instance from the load
   balancer. `/readyz` will not do this for you: an unprotected route is not a health condition, and it is
   deliberately not wired to the readiness gate — a route-level defect should not fail every other request
   on the host.
3. **Find the route and its registration site.** The log line names the method and path; the fix is in the
   plugin that registers it, not in a middleware that "adds auth back". A global pre-handler that
   re-implements the check is a second source of truth and will diverge.
4. **A `403` spike is a different question: one principal or many?**
   ```sql
   select details->>'route' as route, user_id, count(*)
     from audit.security_event
    where event_type = 'PERMISSION_DENIED' and occurred_at >= now() - interval '1 hour'
    group by 1,2 order by 3 desc limit 20;
   ```
   One user across many routes is a role removed by mistake (step 5). Many users on one route is a
   deployment that changed the required permission — compare `config.permission` on that route against the
   previous release's tag.
5. **Permission drift is a seed problem, not a grant problem.** `packages/contracts/src/roles.ts` is the
   transcription of `00` §4.2 and is consumed by both the RBAC seed migration and SEC-T-05. If a role is
   missing a permission it should have, the migration ran against a different contract version than the code:
   check `ops.schema_migration` head against the release tag, then re-run the idempotent RBAC seed. **Do not
   grant by hand.** A manual grant is not in the contract, so the next seed silently reverts it and the same
   user files the same ticket next week.
6. **Verify:** gauge zero after a clean restart, no boot log line naming a route without `config.permission`,
   SEC-T-05 green, and the `PERMISSION_DENIED` rate back to its 7-day median.

### RB-12 — Suspected credential compromise

**Trigger:** AL-21 (`auth_token_reuse_total{outcome="REVOKED_FAMILY"}` above 3 in 24 h), an anomalous
successful login, a user report, or bulk `MFA_CHALLENGE_FAILED` for one account.

1. **This runbook is not the response.** `06` §18.2 P1–P5 is authoritative and is followed, not paraphrased.
   What follows is the operational sequence around it: what to capture, what to run, and what not to touch.
2. **Capture before containing.** Locking the account first destroys the attacker's live session but also the
   record of what that session did. Export, in this order, to the incident ticket:
   ```sql
   -- sessions and their families
   select id, family_id, created_at, last_used_at, revoked_at, revoked_reason, client_fingerprint, client_ip
     from iam.auth_session where user_id = $1 order by created_at desc;
   -- what the principal did, and what was attempted against them
   select occurred_at, event_type, severity, client_ip, details
     from audit.security_event where user_id = $1
      and occurred_at >= now() - interval '7 days' order by occurred_at;
   select occurred_at, action, entity_type, entity_id, correlation_id
     from audit.audit_event where actor_user_id = $1
      and occurred_at >= now() - interval '7 days' order by occurred_at desc;
   ```
3. **Contain.** `POST /api/v1/admin/users/{id}/sessions/revoke` (`users:write`) closes every session row and
   bumps `token_invalid_before`. **The effect is not instantaneous.** Revocation is enforced by `sid` lookup
   with a 30-second poll and `/readyz` gates on that poll's health (`§4.5`), so an access token minted
   seconds earlier remains valid for up to 30 s plus its remaining lifetime if the poll has already run.
   Say that in the incident record rather than claiming immediate termination.
4. **Rotate everything the principal could reach, in this order:** the account password (through the reset
   flow, not by hand), TOTP enrolment (`totp_secret_ct` and `last_totp_counter` are reset together — a new
   secret with an old counter guard locks the user out), and any `iam.api_key` row whose `created_by` is that
   user. API keys are stored SHA-256 hashed and cannot be recovered, so revocation plus reissue is the only
   option and it is cheap.
5. **Decide on the account's continued existence deliberately.** Deleting the user erases the foreign keys the
   audit trail points at and makes the incident unreconstructable. Suspend (`AUTH_ACCOUNT_SUSPENDED`) and
   keep the row.
6. **If the vector was a refresh-token reuse beyond the grace window** (more than three reuses in 24 h,
   `06` SEC-D-04), the family is already revoked by the system. Confirm the revocation happened, then treat
   the cause as token theft: check `client_fingerprint` continuity across the family's rows. A family used
   from two fingerprints is a stolen token; one fingerprint is a client bug replaying a rotated token, which
   is a defect in the SPA's refresh handling rather than an attack.
7. **Verify:** `revoked_at` set on every family row, `token_invalid_before` advanced, no further
   `REFRESH_TOKEN_REUSE` for the principal, the password change and TOTP re-enrolment both in
   `audit.audit_event`, and the `06` §18.2 record closed with the outcome and the containment timestamp.

### RB-13 — TLS, proxy, or certificate failure

**Trigger:** AL-22 (served certificate expiring within 7 days), a burst of `502`/`504` from the proxy, or
clients reporting certificate errors.

1. **Four layers look identical from outside:** DNS, the proxy, the certificate, and the upstream.
   Distinguish them in one pass.
   ```bash
   dig +short <host>                                    # does the name still point here?
   openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null \
     | openssl x509 -noout -subject -issuer -dates     # which certificate is actually served?
   curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/healthz
   ```
2. **A `502` behind a valid certificate is not TLS.** It is the upstream: check `/readyz` on the instance
   and go to RB-01. Diagnosing it as a certificate problem wastes the window in which the real cause is
   still visible in the logs.
3. **Expiry is the one failure with days of notice, so there is no excuse for it.** Automatic renewal over
   the ACME HTTP-01 challenge needs port 80 reachable from the internet — that is the only reason `ufw`
   allows it (`§7.9`). The three causes, in observed order: the provider's edge firewall blocks 80, the A
   record moved, or a CAA record does not authorise the ACME account.
   ```bash
   docker logs --since 24h proxy 2>&1 | grep -iE 'acme|challenge|renew|certificate'
   ```
4. **Renew through the same client, never by hand.** A certificate issued with `openssl` on the host is
   tracked by nothing, renewed by nothing, and becomes next quarter's outage with a known deadline. If the
   challenge cannot complete, fix DNS or the port; do not bypass the challenge.
5. **Never serve plaintext to work around a TLS failure.** Session cookies are `Secure`, the proxy sets HSTS,
   and `06` requires TLS for every non-loopback connection. An HTTP fallback breaks authentication, not just
   confidentiality — the degraded path is worse than the outage.
6. **A private key that has been in a build artefact is rotated, not copied.** `TLS_PRIVATE_KEY` is a secret
   (`§3.4`); its presence in a repository or an image layer is a rotation event, and the old certificate is
   revoked rather than left to expire.
7. **Verify:** `not_after` at least 30 days out, `curl -sSI https://<host>/healthz` returns `200` with the
   expected `Strict-Transport-Security` header, and AL-22 clears within one evaluation interval.

### RB-14 — Backup or WAL archive failure, and restore

**Trigger:** AL-15 — base backup age above 36 h, or any increment in `wal_archive_failures_total`.

1. **The two failures differ in severity, and the less alarming one is worse.** A failed *base backup* means
   the oldest restore point stops advancing. A failed *WAL archive* means point-in-time recovery now ends at
   the last archived segment: every unarchived minute widens the RPO (target ≤ 15 min, A9) while the
   backup-age gauge stays green. Treat archive failure as the more urgent of the two.
2. **Read the archiver, not the logs, first.**
   ```sql
   select last_archived_wal, last_archived_time,
          last_failed_wal, last_failed_time, failed_count, stats_reset
     from pg_stat_archiver;
   ```
   An advancing `failed_count` with a static `last_archived_wal` means archiving is stalled **now**. A
   `last_archived_time` minutes old and `failed_count` flat means it recovered on its own — record it and
   move on.
3. **Three causes account for nearly all of it.** `/backups` is full (RB-07); object-storage credentials or
   permissions changed; or `AGE_BACKUP_RECIPIENT` was rotated without keeping the matching identity, so
   backups succeed and nothing can decrypt them. The third is the dangerous one: no gauge moves, and the
   failure is discovered during a restore. The weekly drill is what catches it.
4. **Never delete `pg_wal` to reclaim space.** Segments that have not been archived are the only copy of the
   writes since the last archive; deleting them destroys PITR for the whole retention window. If space truly
   forces a decision, take a fresh base backup, accept the wider RPO explicitly, and write both facts in the
   incident record.
5. **Restoring is `§7.7`, and it runs against a scratch cluster.** The production host is never the target of
   a test restore: a drill that overwrites the thing it is meant to protect is not a drill.
6. **After any real restore, three things are not where the running code left them.**
   - `ops.schema_migration` is at the backup's head. A redeploy of the current release will find migrations
     pending and refuse to serve (`/readyz` → `migrationsPending`, a fatal check). Run migrations **before**
     starting `api`.
   - `an.analytics_watermark` is at the backup's state. Derived data after the restore point does not exist,
     which is correct; the next pipeline run recomputes forward from the watermark. Do not "fill in" the gap
     by hand — a derived bar written without its source provenance is INV-D3 waiting to fire.
   - Jobs that were `RUNNING` at the backup's timestamp come back `RUNNING` with an expired lock; the reaper
     reclaims them within 60 s. An `md.import_batch` that was `PERSISTING` is either fully present or fully
     absent, because persistence is one transaction per batch — but its *status* may not match. Reconcile
     every non-terminal batch whose `session_date` falls inside the restore window.
7. **Verify:** `backup_age_seconds{kind="BASE"}` under 36 h, `wal_archive_failures_total` flat for an hour,
   a restore drill record for the week in `docs/runbooks/restore-log.md`, and `verify-restore.sql` green. **A
   backup that has never been restored is a hypothesis, and the alert measures the hypothesis, not the
   backups.**

### RB-15 — Mail delivery failure

**Trigger:** AL-18 (`tradesoft_mail_queue_oldest_age_seconds > 600`).

1. **Establish the blast radius before doing anything.** Exactly two flows send mail: password reset and user
   invitation (`ops.send_email`, `03` §5.3). Alerts deliberately do not use mail — this alert reaches you
   through the monitoring system regardless. The operational consequence is therefore narrow and specific: a
   user who has forgotten their password cannot self-serve, and an invited user cannot accept. Neither is a
   data problem and neither justifies a rollback.
2. **Locate the queue.**
   ```sql
   select id, status, attempts, created_at, last_error
     from ops.job
    where job_type = 'ops.send_email'
      and status in ('QUEUED','RUNNING','FAILED','DEAD_LETTER')
    order by created_at limit 20;
   ```
3. **`FAILED` with attempts remaining is self-healing.** The retry policy is 5 attempts over a 30-minute
   deadline (`03` §5.3), so an outage shorter than that is invisible to users and needs no action beyond
   noting it. `DEAD_LETTER` is not self-healing and is the real signal.
4. **Four causes, in order of frequency:** the SMTP password was rotated at the provider and not in the
   secret file (`§7.8`); host, port, or TLS mode changed with the environment; the provider is throttling a
   burst of invitations; DNS. The `last_error` distinguishes them — authentication rejected, connection
   refused, and `421` throttle are three different fixes.
5. **Recovery is the user's retry, on purpose.** The idempotency key is
   `mail:{template}:{sha256(to+variables)}`, so a repeated reset request inside the window is deduplicated
   rather than sent twice. Once transport works, the affected user retries and succeeds. **Do not bulk-replay
   dead letters:** the queued payloads contain reset links whose tokens have their own expiry, so a replay
   delivers links that no longer work and leaves the recipient unsure which link is current.
6. **Do not hand out credentials to work around an unavailable reset flow.** There is no administrative
   "set this user's password" path, and creating one during an incident creates a permanent bypass of the
   reset control. The honest answer to the user is that reset is unavailable and when it will be back.
7. **Verify:** `mail_queue_oldest_age_seconds` back under 60 s, one message delivered to the sink mailbox in
   staging (which uses real SMTP, `§3.1`), and one real reset completed end-to-end in production with the
   recipient confirming receipt.

### RB-16 — Analytics invariant violation (INV-D1…INV-D5)

**Trigger:** AL-09 (`tradesoft_analytics_invariant_violations > 0`).

1. **The alert says "non-zero", not which one.** Run all five; the verifier is five `count(*)`s over indexed
   predicates and costs seconds (`04` §11.3). Do not attempt a diagnosis from the alert.

   | Invariant | What a violation actually means | First action |
   |---|---|---|
   | **INV-D1a** — a derived timeframe carries `import_batch_id` | An ingest adapter wrote a timeframe it does not own, or aggregation reused the ingestion writer and stamped a batch | Stop the aggregation stage; check the adapter's allowed-timeframe list. Readers that filter on `import_batch_id is null` now disagree with readers that do not |
   | **INV-D1b** — `15m`/`1D` with no `import_batch_id` | An engine wrote a bar it does not own. Synthetic instruments are excluded by the verifier, because their `1D` series is engine-written by design (INV-D2), so any remaining count is real | Find the writer: only ingestion owns `15m`/`1D` for listed instruments |
   | **INV-D2** — engine-written `1D` on a non-synthetic instrument | The GS Composite path was applied to a listed instrument, or `is_synthetic` was cleared after its bars were written | Read `audit.audit_event` for `ref.instrument` to see whether the flag changed and when |
   | **INV-D3** — a derived bar exists for a range with no source bars | Aggregation ran against a range whose sources were absent — usually a missing trading day (RB-04) — or a correction rewrote daily sources and left the weekly behind | Delete the orphan derived row, then recompute that instrument and timeframe. Deleting without recomputing leaves a hole |
   | **INV-D4** — `brick_count` ≠ the number of bricks | The most damaging class: a header that claims 412 bricks while 411 exist, so every reader trusting the header disagrees with every reader that counts | **Rebuild the set with `revision + 1`.** Never `UPDATE` the header to match the rows |
   | **INV-D5** — `indicator_snapshot.as_of_bucket` ahead of its watermark | A snapshot was committed before its watermark advanced, so a crash between the two left an incomplete bucket that readers treat as final | Recompute the snapshot after re-reading the watermark, and review the ordering of the two writes in the snapshot job |

2. **How many instruments, and how many dates?** One instrument on one date is a data defect: contained,
   explainable, and fixed by recompute. Many instruments on the same date is a code defect, and the question
   becomes which release changed the engine — roll back first (`§7.6` row 2), then recompute. Diagnosing a
   code defect while it continues to write is not diagnosis.
3. **One nightly run proves the fix; two prove it is not a race.** A violation that clears on recompute and
   returns the next night is a concurrency bug in the engine, not bad data, and belongs in the release
   process as a defect with the invariant as its reproduction.
4. **Never repair an invariant violation by hand.** Not `UPDATE an.renko_brick_set`, not
   `DELETE FROM md.market_bar`. Every one of these tables has a single owning writer; a hand fix makes the
   check pass and the data wrong, the next recompute reverts it, and the audit trail shows the attempt
   without showing the reason.
5. **Record the blast radius for the affected window.** If derived data was wrong for a session, then the
   dashboard, every scanner run, the breadth counts, and the RS matrix were wrong for that session too. That
   belongs in the incident record, because a user who acted on a scan that day needs to know — and because
   the alternative is discovering it from them.
6. **Verify:** all five counts zero, the affected range recomputed, and
   `tradesoft_analytics_invariant_violations` at zero across two consecutive nightly verifications.

### 8.1 Rules that apply inside every runbook above

These are not repeated per runbook because they are not steps; they are the constraints that make the steps
safe to follow under pressure.

1. **A restart is a diagnosis of last resort, not a first response.** It destroys the in-memory state that
   explains the failure — pool saturation, a leaked transaction, a growing heap. Restart only when the
   evidence is already captured, and say in the incident record what was captured first.
2. **Nothing is deleted to make an alert go quiet.** Jobs, audit rows, bars, partitions, and dead letters all
   exist because something went wrong; an alert that stops because the evidence was removed is worse than an
   alert that continues.
3. **Any change to stored data is a correction with a justification, or it is not made.** BR-044 applies to
   operators exactly as it applies to the API.
4. **Write the time and the action as you go, not after.** Memory reconstructs a plausible sequence, and a
   plausible sequence is not evidence.
5. **When two runbooks disagree, follow the more conservative one** and file the contradiction. The
   disagreement is a defect in this document, and the next person will hit it too.

---

## 9. Capacity and cost

### 9.1 The six numbers that decide whether capacity is a problem

Everything else is a derivative. These are the six to watch, where each comes from, and the value at which
it stops being information and becomes a decision.

| # | Number | Source | Year 1 | Year 5 | Decision threshold | What happens when it is crossed |
|---|---|---|---|---|---|---|
| 1 | Database size on `/data` | `pg_database_size` + `du` | ~18 GB | ~60 GB (`02` §12) | 70 GB, or 70 % of the volume | Quote the next volume size; WAL, temp files, and a `pg_dump` all need headroom above the table total |
| 2 | Intraday bar rows (`15m`) | `count(*) from md.market_bar where timeframe='15m'` | ~92 M | ~277 M, flat after month 36 by retention | Retention window vs query cost | If the 36-month window cannot hold p95, shrink retention rather than grow the host — the product reads months, not years, at `15m` |
| 3 | Nightly pipeline wall clock | Pipeline dashboard, 18:00 → completion | ~35 min | ~55 min | 150 min (the window before the 02:00 maintenance jobs) | Add worker concurrency for the parallelism-friendly stages first (`04` §10); only then consider a second worker host |
| 4 | API p95 at peak | `tradesoft_http_request_duration_seconds` | ~90 ms | ~140 ms | `05` §15 per-route budgets | Find the route that moved. Capacity is not the first hypothesis for a single slow route |
| 5 | Scanner p95 duration and rows examined | AL-16 | ~700 ms / ~120 k rows | ~1.4 s / ~250 k rows | 2 s p95, timeout ratio 1 % | RB-09. This is the number that degrades first as the instrument universe grows, because scanners are the only workload that touches the whole universe at once |
| 6 | Restore duration | Weekly drill log | ~25 min | ~70 min | RTO 2 h (A9) | Two consecutive drills above 90 min is a P2 against the backup strategy (`§7.7`) |

The reason these six and not CPU: this system is bound by rows scanned and by wall-clock windows, not by
sustained compute. A 16 GB host at 30 % CPU with a 55-minute pipeline is closer to its limit than one at 70 %
CPU with a 20-minute pipeline.

### 9.2 Growth that is linear, and the two things that are not

Row counts grow as `instruments × sessions × timeframes`, and sessions are fixed by the exchange calendar.
The two discontinuities are both about the instrument universe:

- **Index reconstitution.** Adding members to a tracked index adds `1D` and `15m` bars for each new member
  from the date it joins. A 50-member index that becomes 60 members is a 20 % step change in that index's
  scanner cost, immediately.
- **Adding an exchange or segment.** MCX and NCDEX have different session windows and a different calendar
  (`ref.exchange`, `ref.trading_calendar`), so they do not merely add rows — they add a second set of bucket
  boundaries and a second nightly window. The pipeline window in number 3 must be re-measured, not scaled.

Neither is a reason to build for scale in advance. Both are reasons to have the six numbers measured
continuously, so the step change is visible the week it happens rather than the quarter after.

### 9.3 What is deliberately not provisioned

| Component | Provisioned | Threshold that would justify it | Why not now |
|---|---|---|---|
| Connection pooler (pgBouncer) | No | More than 3 `api` instances, or pool wait p95 above 0.5 s sustained | The pool is per-process and bounded; one or two instances do not need a third layer (`02` §12) |
| Read replica | No | Read latency dominated by IO wait **and** write volume not the cause | A replica adds a consistency question to every read path for a workload that fits in `shared_buffers` |
| Managed PostgreSQL | No | RTO 2 h cannot be met by restore, or the restoration skill leaves the team | Moves the failure domain to a network hop and a control plane we do not operate (see below) |
| Message broker | No | More than ~200 jobs/s sustained, or cross-process fan-out beyond one worker pool | `FOR UPDATE SKIP LOCKED` over `ops.job` costs database CPU, and at this volume that cost is smaller than operating a broker |
| Cache (Redis or in-process shared) | No | A route whose p95 is dominated by a query that has not changed in a week **and** is not already served from `an.indicator_snapshot` | The precomputed snapshot tables *are* the cache, and they are correct by construction rather than by invalidation |
| Object storage for bars | No | Never, for structured bars | The raw import files are the archive; bars are derived and rebuildable (`02` §13) |

Each row is a decision with a trigger, not a permanent no. The trigger is written down so that the argument
in eighteen months is about whether the threshold was crossed, not about whether the component is fashionable.

### 9.4 The monthly cost model

Unit prices are assumptions to be re-quoted at Phase 15, not quotations. The model exists so that the shape
of the cost is visible: this system's cost is dominated by one host and one volume, and it changes in steps
rather than continuously.

| Line | Assumption | Monthly (USD) | Notes |
|---|---|---|---|
| Compute — 8 vCPU / 16 GB, dedicated | $55–90 | 55–90 | The single largest line. Sized from `02` §12's tuning baseline, not from a benchmark |
| Block storage — 100 GB NVMe | $0.10/GB | ~10 | Grows in 100 GB steps; the alert at 70 % is what triggers the step |
| Off-host storage — backups + WAL + audit anchors | 60 GB compressed × 30 days, plus WAL | 8–15 | Cheapest line and the one that must never be the reason a backup is skipped |
| Object storage for audit anchors | < 1 GB, versioned, write-once | 1–2 | Retention beyond the database (`06` §14.4) |
| Domain + DNS | Annual, amortised | 2 | |
| TLS | ACME | 0 | `§RB-13` |
| SMTP relay | Low volume: resets and invitations only | 0–15 | Free tiers cover the volume; paid tier is for deliverability, not capacity |
| **Total** | | **≈ 75–130** | |

Three observations that matter more than the total:

1. **The cost is nearly flat with respect to usage.** Doubling the instrument universe does not double the
   bill; it moves number 5 in §9.1 and may force the next compute step, which is a 2× on one line.
2. **The cheapest line is the one whose absence is most expensive.** Backups are ~10 % of the bill and are
   the only line whose failure is unrecoverable. Any cost review that starts there is being conducted
   backwards.
3. **Managed PostgreSQL would roughly triple line 1 and add a second failure domain.** That is not
   automatically wrong — it is the correct choice for a team that cannot run a restore drill — but it is a
   decision about operating model, not about price, and A12 already made it.

### 9.5 The capacity number that is not hardware

Operator hours are a finite resource and the only one that cannot be bought in a step. The recurring manual
work this design requires is: a five-minute morning freshness check, a thirty-minute weekly review (drill log,
dead letters, audit review, disk trend), and a monthly hour for access review and query-plan review. Call it
**four to six hours a week**.

If that figure exceeds ten hours a week for three consecutive weeks, something is being done by hand that
should be a job, and the correct response is to write the job — not to hire. The maintenance calendar in §10
exists partly to make the gap visible: every entry that a human performs and that has a stable procedure is a
candidate for automation, and the ones that stay manual are the ones where judgement is the point.

---

## 10. Maintenance calendar

Automated work is listed because an operator needs to know it happens, and because a missed automated run is
the usual explanation for a problem that looks mysterious. Manual work is listed with its duration, so that
"we do not have time" becomes a measurable statement rather than a feeling.

### 10.1 Daily

| Time (IST) | Task | Mode | Evidence it ran |
|---|---|---|---|
| 02:00 | `maintenance.partition_rollover` (3 months ahead) | Automated | `tradesoft_pg_partition_runway_months ≥ 3` |
| 02:30 | Off-host audit anchor for the last 24 h (`§5.4`) | Automated | `backup_age_seconds{kind="ANCHOR"}` |
| 03:00 | `audit.verify_chain` over the last 7 days | Automated | `audit.lastVerifiedId` advances; AL-10 silent |
| 03:30 | Retention: expired `ops.job`, old `ops.domain_event`, import files past retention | Automated | Row counts stable; `janitor` job green |
| 08:45 | **Morning check — five minutes.** Pipeline dashboard: yesterday's session current on every timeframe, no `ERROR` quality issues open, no new dead letters, disk trend flat | **Manual** | A line in the ops log, or the absence of one is the finding |
| 18:00 → ~19:00 | EOD pipeline: ingest → validate → persist → aggregate → indicators → Renko → breadth → RS → snapshots | Automated | Pipeline dashboard; `pipeline_lag_seconds` per dataset |
| Continuous | WAL archiving | Automated | `pg_stat_archiver.last_archived_time` within 5 min |

The morning check is deliberately five minutes and deliberately at 08:45. It is early enough to act before
the market opens, and short enough that it is not the task that gets skipped. **A check that takes thirty
minutes is a check that will be done weekly.**

### 10.2 Weekly

| When | Task | Mode | Duration |
|---|---|---|---|
| Sunday 03:00 | Full chain verification over retained history (`§5.5`) | Automated, output archived | — |
| Sunday 04:00 | Restore drill from the newest base backup plus WAL into a scratch cluster (`§7.7`) | Automated run, human review | 30 min to review |
| Monday 09:30 | **Weekly review**: drill result, dead-letter contents, `ERROR`-severity quality issues, disk trend, backup age, `PERMISSION_DENIED` outliers | **Manual** | 30 min |
| Monday | Audit review using `§5.10` (twenty minutes, four questions) | **Manual** | 20 min |
| Monday | Dependency update PR review and merge inside the week's change window (`§12`) | **Manual** | 20 min |

The weekly review has a fixed agenda because an open-ended review becomes a browse. Each item has a place to
write the answer, and "nothing to report" is an acceptable answer that still gets written.

### 10.3 Monthly

| Task | Mode | What is being looked for |
|---|---|---|
| Confirm partition runway ≥ 3 months for every partitioned table | Manual, 5 min | A rollover job that has been silently failing since the last release |
| `pg_stat_statements` top 20 by total execution time | Manual, 20 min | A query that moved into the top 20 without a release — usually a data-shape change, not a code change |
| Indexes with `idx_scan = 0` over the month (`pg_stat_user_indexes`) | Manual, 10 min | An index that was added for a query that no longer exists. Removing it is a migration, not a `DROP INDEX` in psql |
| Table bloat estimate on `md.market_bar`, `an.indicator_value`, `ops.job` | Manual, 10 min | Autovacuum falling behind a table whose update pattern changed |
| Access review: active users and their roles, API keys and `last_used_at`, sessions older than 30 days | Manual, 15 min | An account that should have been suspended, a key nobody admits to owning (`06` §15) |
| Review restore-drill log for the month | Manual, 5 min | Two drills above 90 minutes is a P2 (`§7.7`) |

### 10.4 Quarterly

| Task | Why quarterly and not monthly |
|---|---|
| Base image and runtime patch rebuild, redeploy | Monthly patches are security updates (`§7.9`); the quarterly rebuild is the full dependency refresh that requires the test suite to run |
| Major dependency upgrades (PostgreSQL minor, Node minor, Fastify, Drizzle) | Each is a release with its own regression risk; batching them quarterly bounds the number of variables per release |
| Rotation of secrets with no automatic rotation: database password, SMTP password, `OPS_METRICS_TOKEN` | Rotation has a cost (coordinated restart); quarterly is frequent enough to prove the procedure works and rare enough to be done |
| Review `DEF-01…DEF-12` (`06` §19.1) | A deferred control stops being deferrable when the risk it addresses changes; the review asks whether anything has changed |
| Capacity review against the six numbers in §9.1 | Monthly is noise; annual is too late for a volume step |

### 10.5 Annually

| Task | Note |
|---|---|
| Archive and sign the 85th-month `audit.audit_event` partition (`§5.4`) | Requires two engineers; the manifest goes in `ops.system_setting.audit.archiveManifests` |
| Full disaster rehearsal onto a **new** host, not a scratch cluster | The scratch-cluster drill proves the backup; this proves the runbook, including DNS, secrets, and the bootstrap order in `§3.5` |
| Re-quote the hosting, storage, and mail costs behind §9.4 | Prices move; the model's shape does not |
| Review the A-number assumptions (`00` §2) and ADR-001…ADR-020 | An assumption that has quietly stopped being true invalidates the decision that rested on it |
| Domain and certificate authority review | The one thing where an expiry is entirely predictable and entirely avoidable |

### 10.6 What never needs doing, and why that is a design property

- **No manual `VACUUM`.** Autovacuum is tuned per table in `02` §12; a manual vacuum is a signal that the
  tuning is wrong, and the fix belongs in a migration.
- **No manual partition creation.** `maintenance.partition_rollover` is idempotent and runs daily; creating
  one by hand during an incident is RB-06 step 2, which runs the same job with a larger window.
- **No cache invalidation.** There is no cache to invalidate: `an.indicator_snapshot` is derived data with a
  watermark that says how current it is, and readers compare against it rather than assuming.
- **No log rotation by hand.** Docker's log driver rotates (`§7.9`), and pino writes to stdout only.
- **No "restart it and see".** See `§8.1` rule 1.
- **No manual index creation for a slow query.** An index that is not in a migration does not exist on the
  next host, and the query will be slow again in the environment where it matters.

---

## 11. Incident management

### 11.1 Severity is not the same scale as alert priority

Two scales exist and confusing them is the most common way an incident is mishandled.

- **Priority (P1–P4, §2.3)** answers *how fast should someone look*. It is a property of an alert.
- **Severity (INC-1–INC-4)** answers *how much is broken*. It is a property of the situation.

They do not map onto each other. AL-14 (Renko lag) is a P3 — until you discover the bricks are wrong, at
which point it is INC-1 and the priority is irrelevant. AL-03 (pool saturation at 03:00) is a P1 that
self-healed and is INC-3. **Severity is assigned by a person after looking; priority is assigned by a rule
before anyone looks.**

| Severity | Definition | Examples in this system | Response |
|---|---|---|---|
| **INC-1** | Stored data is **wrong**, or the system is unusable for everyone, or the integrity of the record is in doubt | Bars committed with incorrect OHLC; a correction applied to the wrong instrument; audit chain break; API down during a market session; scanner results computed from a stale snapshot | Drop everything. Declare within 15 min. Contain before diagnosing. Second person required for any data correction |
| **INC-2** | A guarantee is degraded for some users or one module, and a workaround exists | Scanner timeouts on one definition; mail delivery down; one timeframe not computed for one session; RS matrix a day stale | Same business day. Normal runbook |
| **INC-3** | Internal degradation with no user-visible effect **yet** | Disk at 75 %; a single dead-lettered job; backup age 30 h; snapshot job 40 minutes behind | Next business day, or self-heal and note it |
| **INC-4** | A deviation or defect with no current impact | A runbook step that no longer matches the UI; an alert that has always been benign; a hardening gap | Backlog with an owner |

**The test that separates INC-1 from INC-2 is one question: is a number wrong, or is it missing?** A missing
session is visible — the freshness panel says so, a scanner returns nothing and the staleness guard explains
why, and the recovery path is a re-upload. A wrong number is invisible, is acted on, and is discovered by the
person who lost money on it. Missing is INC-2. Wrong is INC-1.

**Security incidents use the ladder in `06` §18.1 (S1–S4), not this one.** A security incident is also an
operational incident, so both apply: the higher severity governs the response time, `06` §18.2 governs the
*content* of the response, and this section governs the mechanics — declaring, recording, communicating, and
reviewing. An S1 is always at least INC-1.

### 11.2 Lifecycle and time boxes

| Stage | What it means | INC-1 | INC-2 |
|---|---|---|---|
| **Detect** | An alert, a user report, or the morning check | — | — |
| **Declare** | Say it out loud and open the record. Naming it is what starts the clock | 15 min | Same day |
| **Contain** | Stop the damage: disable a scanner, pause a stage, roll back a release. **Ahead of diagnosis when data is being written wrong** | 30 min | As needed |
| **Diagnose** | Run the mapped runbook. One hypothesis at a time, written down | — | — |
| **Recover** | Apply the fix; prefer a recompute over a hand edit, a rebuild over a patch | — | — |
| **Verify** | The runbook's own *Verify* step. Not "it looks fine" | Before closing | Before closing |
| **Record** | Written **during** the incident, not after | Continuous | On close |
| **Review** | Blameless, output is artefacts (§11.6) | 5 business days | Optional |

Containment before diagnosis is the one ordering rule that matters, and it is counter-intuitive under
pressure: the instinct is to understand first. When the system is *writing wrong data*, understanding takes
twenty minutes and the wrong data compounds every twenty minutes.

### 11.3 Roles when there is one person

There is no rota (A12), so in the common case the same person is incident commander, scribe, and the engineer
who runs the commands. Pretending otherwise produces incidents that are never declared. Three mitigations
make that workable:

1. **The runbooks are written for one person**, in order, with the verification step included. That is why
   every runbook in §8 ends with *Verify* rather than "confirm the fix worked".
2. **The record is a file written as you go**, not a recollection reconstructed afterwards. A timeline written
   from memory is a plausible story, and a plausible story is not evidence (§8.1 rule 4).
3. **A second person is required for exactly three things:** break-glass database access (`§5.6`), the annual
   audit archive (`§5.4`), and **an INC-1 data correction** — the second person reads the justification before
   it is applied. Everything else is single-person by design, because the alternative is a policy that the
   team of one cannot follow and therefore ignores.

### 11.4 Communication

There is no public status page because the user population is internal and small, and a status page that
nobody is paged to update is worse than a message. Three messages per incident, no stream:

1. **At declare** — what is affected, what users should **not trust** in the meantime, and when the next
   update comes. "Do not trust the scanner results published before 14:20" is the sentence that matters in
   this product; the rest is context.
2. **At contain** — what was done, what is still degraded, and whether the workaround is safe.
3. **At resolve** — what was wrong, what was verified, and whether any published number was affected and for
   which window.

Nothing is communicated as "resolved" before the runbook's *Verify* step has passed. A premature all-clear in
a market-data product is a second incident with the same root cause.

### 11.5 The incident record

`docs/incidents/YYYY-MM-DD-<slug>.md`, in the repository, because it is operational knowledge that belongs
next to the runbook it will amend. Minimum fields:

```markdown
# INC-<n> — <one line, no euphemism>

- Severity: INC-1 | Detected: 2026-11-03T18:12+05:30 | Declared: 18:19 | Contained: 18:41 | Resolved: 19:05
- Detected by: <alert id | person>   Commander: <name>   Second person (if data corrected): <name>
- Affected window: <first bad session/bucket> .. <last>
- Affected surfaces: dashboard | scanner | RS matrix | chart API | none published
- What was wrong:
- What users were told, and when:
- Containment:
- Root cause:
- Verification (paste the runbook's Verify output):
- Was any published number wrong? For which window? Who needs to know?
- Actions: <artefact> — owner — date
```

The line that is specific to this product is *"was any published number wrong, for which window, and who
needs to know"*. An infrastructure incident that published nothing wrong is a near miss; one that published a
wrong scan for a day is a business event, and the record has to make that distinction rather than leaving it
to be inferred.

### 11.6 Review, and what counts as an action

A review produces exactly four kinds of artefact:

| Artefact | Example |
|---|---|
| **An alert** | "Nothing fired when the snapshot job stalled for 40 minutes" → a new threshold, with a runbook mapping |
| **A runbook edit** | A step that was wrong, missing, or in the wrong order |
| **A test** | A regression test that fails on the pre-fix commit and passes on the fixed one |
| **A decision** | "We accept this failure mode" — recorded in §15 with the reason and the trigger that would reopen it |

Anything else — "be more careful", "add to the checklist", "improve monitoring" — is not an action and does
not get an owner. An action item without a named owner and a date is dropped at the next review, which is
the same as deciding not to fix it but with less honesty.

Reviews are blameless in the specific sense that matters: the question is *why the system allowed this*, not
*who typed the command*. The command was typed by someone following a procedure that the system permitted, and
the procedure is what gets fixed.

---

## 12. Change management

### 12.1 Change classes

Every change to production falls into exactly one row. A change that fits no row is a new class and needs a
decision in §15, not an improvisation.

| Class | Examples | Who approves | Evidence | Reversal |
|---|---|---|---|---|
| **Code deploy** | New release, hotfix, dependency bump | Release checklist (§7.2) | CI run + deploy log | Redeploy the previous digest |
| **Additive migration** | New column, new index, new table | Reviewed by someone who has read `02` §8 | Migration file + plan + CI | Forward fix; the column stays and is ignored |
| **Destructive migration** | Drop column, narrow type, drop index | Same, plus the two-release rule (§7.5) | Release N stops reading; release N+1 drops, ≥ 7 days later | Forward fix only. There is no down-migration |
| **Data correction** | Wrong OHLC, wrong corporate action | `marketdata:correct`; second person if INC-1 | `audit_event` with 20–1,000 character justification | A compensating correction — never an edit of the correction |
| **Reference data** | Trading calendar, instrument master, sector membership | `calendar:write`, `reference:write` | `audit_event` with before/after | A corrective change, audited the same way |
| **Scanner definition** | New condition, changed threshold, new universe | Owner, or any analyst if `is_shared` | `If-Match` on the ETag; previous version recoverable from `audit_event.before` | Restore the previous definition body |
| **Runtime setting** | Scanner timeout, staleness tolerance | `settings:write` | `audit_event` | Set it back; both values are in the trail |
| **Secret rotation** | Signing key, MFA key, DB password, SMTP password | §7.8 procedure | Rotation record in the release note | Restore the previous secret only inside its overlap window |
| **Host change** | Firewall, docker daemon, NTP, kernel | §7.9 procedure | Command transcript pasted into the ticket | The same transcript, reversed |
| **Emergency change** | Any of the above, during an incident | The person responding | §12.3 | §12.3 |

Two rows deserve emphasis because they are where discipline slips:

- **A data correction is a first-class change with an approval and an audit row, not a `psql` fix.** The same
  rule binds an operator and an API client (BR-044, §8.1 rule 3). There is no "just this once".
- **A reference-data change is a change to the meaning of every derived number.** Moving a holiday in
  `ref.trading_calendar` changes which sessions exist, which changes weekly buckets, which changes Renko
  anchors and every indicator that crosses the boundary. It is not a lookup-table edit.

### 12.2 Change windows

| Window (IST) | Rule | Reason |
|---|---|---|
| 08:30–16:30 on trading days | **No deploys, no migrations** | Users are reading charts and running scans; a rolling restart during a session is a visible outage |
| 17:30–21:00 | **No deploys, no migrations** | The EOD pipeline owns the database; an `ACCESS EXCLUSIVE` lock waits behind a long read and then blocks the whole pipeline when it finally acquires |
| 02:00–04:00 | **No deploys** | Automated maintenance: partitions, anchor, chain verification, retention. A deploy here races them and, worse, can make a failing maintenance job look like a deploy failure |
| 16:30–17:30, 21:00–02:00, weekends | Deploy window | The only times when nothing else is using the system |
| Any open INC-1 | **Freeze** | Two changes at once make the second one unfalsifiable |
| During the annual audit archive | **Freeze** | The archive reads a partition that a migration might want to lock |

**A migration is never run during a market session, including an additive one.** The lock it takes is brief in
the best case and unbounded in the worst, and the worst case happens exactly when a long analytics query holds
a read lock on the table being altered.

### 12.3 Emergency changes

An emergency change skips the window and the checklist, and skips nothing else:

1. **Migration review is never skipped.** Even at 19:00 with the pipeline down, a second person reads the
   migration. A bad migration during an incident converts a recoverable outage into a restore.
2. **Data is never edited without a justification and an audit row.** If the tooling makes that slow during an
   incident, the tooling is the defect — fix it in the review, not by bypassing it under pressure.
3. **It is recorded within 24 hours**, in the incident record and the release note, with the exact commands.
4. **It is reviewed within 2 business days** like any other change, with the same question: what would have let
   this be a normal change?
5. **If the same emergency change happens twice for the same reason, it is no longer an emergency.** It
   becomes a permanent change with a test, an alert, or a job — and if it cannot, that fact goes in §15.

### 12.4 What is not a change

Three operations look like changes and are not, and treating them as changes adds approval friction to the
actions you most want to be fast:

- **Redeploying the same digest.** The artefact is identical; nothing about the system's behaviour changes.
- **Re-running an idempotent job.** Jobs are designed to be re-runnable (§7.11); a retry is an operation, not
  a change.
- **Restoring a backup.** It is a recovery action with its own runbook (RB-14) and its own consequence, not a
  change that needs approval. It does need a record, because it discards data after the backup point.

---

## 13. Production-readiness gate

This section is the gate that §1.3 refers to. It is the **only** basis on which the system may be called
production-ready. Every item is binary; a partial tick is a fail. Every item names the artefact that proves
it, and the artefact is linked from the gate record (§14.2), not described in it.

The gate is evaluated against **one release commit and one image digest**. Evidence produced against a
different digest is not evidence for this one, except where an item says otherwise (drills and soak runs
are properties of the environment and the data, not of the commit).

Where an item says **pre-production**, it means the production host before cut-over: the release under
gate, real licensed data for the full covered universe, and no staff access. Staging's anonymised subset of at
most 50 instruments (§3.1) is too small to carry PRG-04, PRG-05, PRG-10 or PRG-11, so the production host is
commissioned in pre-production mode at the exit of Phase 5 (`08` §2 S5) to give those items their 10- and 20-trading-day windows.

### 13.1 Data correctness

| # | Condition | Evidence | Owner phase (`08`) |
|---|---|---|---|
| PRG-01 | Every phase 1–14 exit criterion in `08` §4 is met, and each phase has a completion note that records any open question resolved by its default (`05` §17) | Phase completion notes in `docs/release/phases/` | 1–14 |
| PRG-02 | Golden vectors pass for every indicator, the Fibonacci ZigZag, Renko, breadth, RS and every system scanner (`04` §11.1), and the determinism gate passes: two full pipeline runs over the same inputs produce byte-identical derived tables (`04` §11.5) | CI stage 2 and stage 8 run URLs on the release commit | 7, 8, 10, 11, 12 |
| PRG-03 | External cross-check: the scheduled checks of `04` §11.4 have run green on staging for 4 consecutive weeks, and a one-off extended comparison for 30 named instruments across NSE, BSE, MCX and NCDEX on `1D` over the last 250 sessions agrees with an independent reference implementation — SMA exact at 4 decimal places; EMA and Bollinger Bands within 0.01 % after a warm-up of 3 × period; RSI, ADX, DMI+ and DMI- within 0.05 absolute (the `04` §11.4 RSI tolerance, applied to the other Wilder-smoothed series); every disagreement is explained in writing | Cross-check job history plus a signed comparison report naming the instruments and the reference tool's version | 7 |
| PRG-04 | The nightly invariant verifier (`04` §11.3) reports zero violations of INV-01…INV-20 and INV-D1…INV-D5 in pre-production for **10 consecutive trading days** | `tradesoft_analytics_invariant_violations` history export for the window | 6–12 |
| PRG-05 | **Parallel run:** pre-production has ingested EOD data for every enabled exchange (NSE, BSE, MCX, NCDEX, NFO) for **20 consecutive trading days** through the production ingestion path, with zero batches left in `VALIDATION_FAILED`, `PROCESSING_FAILED` or `RECONCILIATION_FAILED` without a recorded disposition, and every reconciliation failure traced to a cause | Batch status report for the window, plus the disposition log | 5 |
| PRG-06 | All 16 concurrency scenarios of `03` §7.1 pass on the release commit, including duplicate upload, concurrent same-instrument recompute, scheduler double-start and client retry with the same `Idempotency-Key` | CI stage 4 run URL | 5, 6 |
| PRG-07 | Migration tests of §6.10 pass from empty and from the previous release; structural assertions hold (no `DEFAULT` partitions, every price column `numeric(18,4)`, at least 3 months of partition runway) | CI stage 4 run URL | 2 |
| PRG-08 | Corporate actions are populated for the covered universe: every instrument in an RS group or a breadth group has a corporate-action history reconciled against the source feed's count for the last 5 years, and the data-quality job reports zero open `UNEXPLAINED_JUMP` findings (`03` §8) of severity `ERROR`, which is the signal for a missing corporate action (`04` §7.2) | Data-quality summary export and the feed reconciliation record | 4 |
| PRG-09 | The trading calendar is loaded for the current and the next calendar year for every enabled exchange, including announced special sessions | Per-exchange, per-year session count from `ref.trading_calendar` | 4 |

### 13.2 Performance and capacity

| # | Condition | Evidence | Owner phase |
|---|---|---|---|
| PRG-10 | Every budget in `04` §10.1 is met at p95 on the **production host class** with a database holding the production universe and history depth from A2 — not the 50-instrument development dataset | Performance-suite report (§6.9) with host spec and row counts | 14 |
| PRG-11 | The nightly full pipeline completes within its 60-minute hard budget at the **actual covered universe size** on the production host class. If the covered universe exceeds the single-host ceiling in `04` §10.1, the R-01 mitigation in `08` §6 is implemented first and this item is measured after it | Pipeline dashboard export with per-stage durations for three consecutive nights | 14 |
| PRG-12 | Load test at the A3 profile — 20 concurrent users, 50 requests/second sustained for 30 minutes, mixed chart, RS, scanner and dashboard reads — completes with a 5xx ratio below 0.1 % and no route outside its hard budget | k6 report attached to the gate record | 14 |

### 13.3 Observability and backup

| # | Condition | Evidence | Owner phase |
|---|---|---|---|
| PRG-13 | Every alert AL-01…AL-24 (§4.7) is deployed, has been **fired deliberately on staging** at least once, reached a human through the paging path, and links to a runbook that exists | Alert test log: alert id, trigger method, time paged, person acknowledging | 14 |
| PRG-14 | `/healthz` and `/readyz` (§4.5) behave as specified under three induced failures on staging: database stopped, worker stopped, pipeline watermark stale | Recorded `curl` output for each case | 14 |
| PRG-15 | Backups are continuous and monitored: `tradesoft_backup_age_seconds{kind="BASE"}` is exported, AL-15 has fired in a test, the newest base backup is younger than 24 h, and WAL archiving has had no gap for the 7 days preceding the gate | `/metrics` scrape, `pg_stat_archiver` output, AL-15 test entry | 14, 15 |
| PRG-16 | Two consecutive weekly restore drills (§7.7) have passed on the production host class, each within the 2 h RTO, and the second drill restored a backup taken from the production database after cut-over | `docs/runbooks/restore-log.md` entries | 15 |
| PRG-17 | Log redaction is verified on production: a sample of 1,000 lines from each process contains no value matching the SEC-T-14 patterns, and every line carries `requestId` or `jobId` and `buildSha` | Output of the redaction scan with the sample window | 14 |

### 13.4 Security

| # | Condition | Evidence | Owner phase |
|---|---|---|---|
| PRG-18 | Every item of the security slice G-S1…G-S10 (`06` §19.3) is satisfied | The G-S evidence set, linked item by item | 3, 14, 15 |
| PRG-19 | An external penetration test against staging, scoped as `06` §17.7, has no open `HIGH` or `CRITICAL` finding and was performed on a build that differs from the gated release by no change to authentication, authorization, upload handling or the proxy configuration | Tester's report and the remediation record | 14 |
| PRG-20 | Production contains no development seed: no `iam.app_user` with a `@tradesoft.local` address (the development seed domain, `02` §9), and no instrument, scanner definition or market group whose identifier exists only in the development seed | Query output from production | 15 |

### 13.5 Operations, licensing and acceptance

| # | Condition | Evidence | Owner phase |
|---|---|---|---|
| PRG-21 | Every enabled data source has a recorded licence or terms-of-use basis that permits this use, with its renewal date | Licence register in `docs/release/data-sources.md`, one row per enabled source | 5 |
| PRG-22 | Two administrators exist, both with MFA enrolled, and the ownership matrix (§2.2) names a primary and a secondary for every area | Query output plus the signed ownership matrix | 15 |
| PRG-23 | Every runbook RB-01…RB-16 has been exercised once on staging — executed for the eight that can be safely induced (RB-01, RB-03, RB-05, RB-06, RB-07, RB-08, RB-09, RB-14), table-topped for the remainder | Runbook exercise log | 14 |
| PRG-24 | A full deploy and a rollback to the previous digest have been rehearsed on staging using §7.3 and §7.6 verbatim | Rehearsal record with timings | 15 |
| PRG-25 | Host hardening (§7.9) is applied to the production host and verified | Command output pasted into the gate record | 15 |
| PRG-26 | User acceptance: a named analyst has executed the acceptance script for every navigation surface (Dashboard, Markets, Charts, Renko, Sectors, Breadth, RS Matrix, Scanners, Data Management, Imports, Settings, Audit/Admin) against staging and signed it | Signed UAT script | 13 |
| PRG-27 | The residual-risk registers — `06` §19.2 and `08` §6 — have been read and accepted in writing by the system owner, referencing the commit hash of these documents | Written acceptance | 15 |

### 13.6 Items that cannot be satisfied on launch day

PRG-15 and PRG-16 require production history; G-S7 requires the first nightly anchor (§7.10 item 3). The gate
is therefore evaluated in two passes:

1. **Pre-cut-over pass** — every item except PRG-15, the second drill of PRG-16, and G-S7 within PRG-18.
   Passing it authorises the production cut-over, not the word "production-ready".
2. **Post-cut-over pass** — the remaining items, evaluated on the first morning after the first full
   production nightly pipeline, and again after the second weekly drill. Until both pass, the system is
   described as "in production, gate open", with the open items listed.

---

## 14. Gate procedure and evidence

### 14.1 Who evaluates and who signs

| Role | Responsibility |
|---|---|
| **Release owner** (engineering lead) | Assembles the evidence, evaluates each item, records pass or fail with the evidence link |
| **Reviewer** (a second engineer who did not assemble the evidence) | Opens every evidence link and confirms it shows what the item claims. A link that cannot be opened is a fail |
| **System owner** (business) | Signs PRG-26, PRG-27 and the final record. Does not evaluate technical items |

The same person may not be release owner and reviewer for the same gate. On a team of one this gate cannot be
passed, and that is intentional: a single person cannot independently verify their own evidence.

### 14.2 The gate record

One file per gated release, `docs/release/gate-<version>.md`, committed to the repository. It contains, for
every PRG item: the item id, `PASS` or `FAIL`, the evidence link, the evaluator, the reviewer, and the
date. The file is append-only after signature; a later correction is a new dated entry, not an edit.

### 14.3 Evidence lifetime

| Evidence | Valid for | Reason |
|---|---|---|
| CI runs (PRG-02, PRG-06, PRG-07) | The commit they ran on | Code evidence is commit-bound |
| Restore drill (PRG-16) | 7 days | §7.2 item 6 uses the same window |
| Alert fire test (PRG-13) | 90 days, or until the alert expression changes | Paging paths decay silently |
| Penetration test (PRG-19) | 12 months, or until an authentication, authorization, upload or proxy change ships | Matches `06` §17.7 |
| Parallel run (PRG-05) and invariant window (PRG-04) | Until a change to ingestion, validation or an engine version constant (`04` §12.1) | These prove data behaviour, which only those changes alter |
| UAT (PRG-26) | Until a navigation surface changes behaviour | A surface that behaves differently has not been accepted |

### 14.4 Re-gating triggers

After the first pass, the full gate is re-evaluated — not only the expired items — when any of the following
happens: a destructive migration ships; the deployment moves host, region or topology; a new exchange or data
source is enabled; an engine version constant changes; or a P1 incident review (§11.6) concludes that a gate
item was passed on insufficient evidence.

---

## 15. Operational decisions and accepted failure modes

### 15.1 Decisions recorded in this document

| ID | Decision | Rationale |
|---|---|---|
| **OPS-D-01** | One image, several commands (api, worker, scheduler, migrate, SPA) | A worker running different code from the API is invisible until a job writes a shape the API cannot read |
| **OPS-D-02** | Migrations never run at application boot | A rolling deploy would race two migrators and migrate under a running older instance |
| **OPS-D-03** | Forward-only migrations; rollback means previous digest on a schema-compatible database | Down migrations on market data are untestable; `02` §8 |
| **OPS-D-04** | Alerts on symptoms (error ratio, lag, freshness), never on CPU or restarts | The nightly pipeline is supposed to saturate CPU; a single restart that recovers is normal |
| **OPS-D-05** | Correctness has no error budget | A 99.9 % correctness target is a statement that wrong prices are acceptable |
| **OPS-D-06** | No deploys after 15:00 IST on a trading day | The EOD pipeline window starts at the close; a bad interaction costs a night of reconciliation |
| **OPS-D-07** | Prometheus-format metrics and host-local logs; no hosted observability platform in v1 | One host, one team; a hosted observability bill would exceed the hosting bill at this scale |
| **OPS-D-08** | Application logs retained 14 days and never treated as a system of record | Audit and security events live in the database with their own retention (§5.1) |
| **OPS-D-09** | No chaos engineering until the first multi-node deployment | §6.15: at one host the realistic failures are covered by killing the database and SMTP |
| **OPS-D-10** | The readiness gate is evaluated in two passes around cut-over | Some evidence (backup age, anchors, production drills) cannot exist before production does |

### 15.2 Accepted failure modes

Each row is a failure the v1 design does not prevent, the reason it is accepted, and the event that reopens
the decision. §11.6 and §12 refer to this table: an incident outcome or change class that is "accepted" is
recorded here, never only in an incident record.

| ID | Failure mode | Impact | Why accepted | Reopen when |
|---|---|---|---|---|
| **AF-01** | Loss of the single host | Full outage until restore; up to 15 min of writes lost (RPO), 2 h to recover (RTO) | A standby doubles cost for a staff tool whose market data is reproducible from retained source files (`08` R-02) | The availability SLO is missed twice in a quarter, or users outside trading hours depend on the platform |
| **AF-02** | SMTP provider outage | Password resets and invitations are delayed; nothing else is affected | Mail is best-effort by design (`03` §5.3, `ops.send_email`) | A second outage within 30 days, or account recovery starts to depend on mail |
| **AF-03** | Scheduler process down | Scheduled ingestion and analytics are not enqueued; missed ticks are caught up on restart | AL-07 pages within 7 minutes; manual uploads still work | An EOD freshness SLO miss is traced to scheduler downtime |
| **AF-04** | A vendor source is late or absent | EOD freshness SLO miss for that exchange; data stays at the previous session and is labelled stale | The platform cannot manufacture data it has not received; manual CSV upload is the fallback | The same source misses more than 2 sessions in a month |
| **AF-05** | Reads during the nightly pipeline see different `asOf` values across instruments | A user comparing two instruments mid-pipeline may see one updated and one not; each response states its `asOf` | Per-instrument atomicity is guaranteed; cross-instrument snapshot isolation would require blocking reads for the pipeline's duration | A user decision is shown to have been made on a mixed-`asOf` view |
| **AF-06** | 15-minute data incomplete for some instruments | Derived intraday timeframes for those instruments carry `isPartial` or gaps; daily analytics are unaffected | A5: EOD is the correctness anchor; intraday is best-effort until a licensed feed exists | A licensed intraday feed is contracted |
