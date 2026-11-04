# Phase 3 progress note — Authentication, authorization, audit and job runtime

Status: **ENGINEERING COMPLETE LOCALLY — slices 1–4 done.** Not verified in CI (PostgreSQL 16) or in a browser. Phase 3 is 15 engineer-days (`08` §5.2). It is delivered in four
slices, each tested before the next starts:

| Slice | Scope | Exit criteria | State |
|---|---|---|---|
| 1 | Config loader, redacting logger, audit writer and chain verification, job runtime (claim, retry, dead letter, reaper, outbox dispatcher, scheduler), worker and scheduler processes | E3.4, E3.5, E3.6 | **Done locally** |
| 2 | Identity: Argon2id, login and lockout, EdDSA access tokens, rotating refresh with grace window, CSRF, TOTP MFA, invitations and reset, API keys | E3.3 | **Done locally** |
| 3 | `apps/api`: Fastify, RFC 9457 errors, headers and CSP, CORS, rate limits, `authorize()` with boot-time route enforcement, endpoints of `05` §11.2, §11.3, §11.10 | E3.1 (partly), E3.2 | **Done locally** |
| 4 | SPA shell: login, MFA, silent refresh, permission-driven navigation, user administration | — | **Done; not exercised in a browser** |

## Slice 1 delivered

| Deliverable | Location |
|---|---|
| Configuration contract of `07` §3.4: validated `config`, non-serialisable `secrets` from `/run/secrets`, production rules, exit 78 | `packages/config` |
| Structured logger with the `07` §4.2 baseline fields; `06` §13.4 path redaction plus key redaction at any depth | `packages/observability` |
| Audit and security-event writers with redaction; chain verification over a range (`06` §14.3) | `packages/db/src/audit.ts` |
| Job runtime of `03` §5–§6 | `packages/db/src/jobs.ts` |
| Worker process (claim loop, outbox dispatcher, reaper) and scheduler process (singleton lock, catch-up) | `apps/worker`, `apps/scheduler` |
| Migration `0014_audit_chain_utc` | `packages/db/migrations` |

## Exit criteria

| ID | Status | Evidence |
|---|---|---|
| E3.4 | **Met locally** | `audit.integration.test.ts`: 10,000 events written from sessions in two time zones verify clean; tampering with one row (as a superuser bypassing the append-only trigger) makes verification name exactly that row; the application role cannot update the trail (INV-14). |
| E3.5 | **Met locally** | `jobs.integration.test.ts`: duplicate enqueue is a no-op; concurrent claims are disjoint; retry with backoff then dead letter; unclassified errors dead-letter at once; the reaper reclaims an expired lock and the slow worker's completion is refused; two schedulers, one lock, each missed window enqueued once; outbox dispatched exactly once with the event's correlation id; a failed handler's writes roll back with it. |
| E3.6 | **Met** | `redaction.test.ts`: a JWT, refresh token, password, API key, MFA secret and TOTP code, logged in seven shapes through the real logger configuration, appear in no output line. |

Local run (Windows 11, PostgreSQL 18.6, Node 24.19.0): static clean; unit 60 passed; contract 3 passed;
integration (audit, jobs, migrations, constraints) 61 passed, 1 skipped. The seed suite was not re-run: this
slice does not touch the seed. Both processes boot under Node's type stripping, and a missing secret exits with
code 78. Graceful drain on `SIGTERM` is not verified, because Windows terminates the process outright.

## Defects found and fixed

| Defect | Fix |
|---|---|
| The normative chain hash (`06` §14.2) hashed `occurred_at::text`, which depends on the writer's session time zone; a verifier in another zone would report a broken chain | `audit.event_hash()` renders `occurred_at` in UTC, and the trigger and verifier share it (`0014`; note added to `02` §7 and `06` §14.2) |
| `audit.audit_event` had no index on `id`, yet the chain trigger reads the highest `id` on every insert: audit writes were O(n) each, O(n²) overall | `ix_audit_event_id` (`0014`). 10,000 chained inserts went from over 5 s to 2 s locally |

## Decisions recorded (also in `03` §5.3 and `06` §12.2)

- A handler runs in the job's transaction and commits with the job's completion, so a failed or superseded run
  leaves no partial effect.
- The reaper dead-letters an expired job that has no attempts left, because claiming it again would violate
  `ck_job_attempts`.
- Attempt rows are numbered from history, because an operator retry resets `ops.job.attempts`.
- The outbox correlation id travels in `payload.context.correlationId`.
- Outside production a secret may come from the environment; in production only from a mounted file.
- Every package now uses explicit `.ts` relative imports, so services run directly under Node 24's type
  stripping without a build step. A container build that bundles instead is a Phase 15 choice.

## Slice 2 delivered

| Deliverable | Location |
|---|---|
| Password policy of `06` §4.3 (pure; blocklist injected) | `packages/domain/src/auth/password-policy.ts` |
| Argon2id with a 4-slot, 32-deep, 5-second semaphore; PHC strings; re-hash on login; dummy hash for unknown emails | `packages/db/src/identity/crypto.ts` |
| Ed25519 keyring with `kid` and previous-key verification; the ordered access-token checks of `06` §5.2 | same |
| TOTP (RFC 6238) with replay prevention; AES-256-GCM secret envelope bound to the user | same |
| Login, lockout, MFA challenge, refresh rotation with the 10-second grace window and the 3-per-day stop, family and user revocation, revocation set and poll | `packages/db/src/identity/service.ts`, `revocation.ts` |
| One-time tokens (reset 60 min, invitation 72 h), password reset with policy and 5-deep history, MFA enrolment, API keys | `service.ts` |
| Migration `0015_identity` (pending-MFA constraint) | `packages/db/migrations` |

E3.3 evidence: `identity.integration.test.ts` replays a rotated refresh token 11 seconds later; the whole family
is revoked, `TOKEN_REUSE_DETECTED` is written, and the successor token is refused. The same suite covers
lockout at ten failures and its expiry, an unknown email answered like a wrong password, the grace window and its
daily limit, TOTP enrolment, client-bound challenges and replayed codes, the admin enrolment gate, single-use
reset and invitation tokens with policy and history, and API keys confined to the machine role.
`identity-crypto.test.ts` checks the RFC 4226 vectors, token forgery attempts (`alg: none`, altered claims,
unknown key) and key rotation. Run: unit 73 passed; integration (identity, audit, jobs, constraints) 60 passed.

Specification defect fixed: `ck_app_user_mfa` made the pending enrolment of `06` §6.3 impossible (`0015`).

Gaps in slice 2:

- **Blocklist data.** `06` §4.3 calls for at least 100,000 common passwords bundled with the build. The policy
  takes the list as input, but no list is bundled yet: choosing its source and licence is the owner's call.
- **Recovery codes** are issued and stored, but consuming one in place of a TOTP code is not built; `06` does not
  specify that flow beyond issue.
- Password change for an authenticated user, invitation creation, the 24-hour pending-secret cleanup job, and
  the reset email job are slice-3 wiring over these services.

## Slice 3a delivered

`apps/api` (Fastify 5): `buildApp` composition root and `main.ts` (config, keyring, MFA key, revocation poll before
listen, readiness). Platform (`platform.ts`): request ids kept or replaced (D-05-19); RFC 9457 problems for every
failure, including Fastify's own; the `06` §9.3 security headers; `no-store` on auth and errors; bearer and
`X-API-Key` authentication; permission checks with `PERMISSION_DENIED` security events; boot-time refusal of any
route without an access declaration; shared Postgres counters for the auth buckets and per-process windows for
read and write (05 §9.1); cookie and CSRF double-submit helpers. Routes (`routes.ts`): `/healthz`, `/readyz`,
login, MFA verify, refresh, logout, me, password forgot and reset, MFA enrol and confirm, users list and create
(invitation), permissions, roles, API keys list, issue and revoke, admin jobs list, retry and cancel, audit-chain
verification. Password-reset and invitation mail is enqueued as `ops.send_email`.

Evidence (`apps/api/test/api.integration.test.ts`, 6 tests):

- **SEC-T-01 / E3.2**: an app with one undeclared route refuses to boot and names the route.
- **SEC-T-05**: every protected route × VIEWER, ANALYST, ADMIN answers 403 exactly when `00` §4.2 says the role
  lacks the permission, and never answers 5xx to random identifiers or empty bodies.
- Login, refresh with and without the CSRF token, logout, refresh after logout; problem documents, request ids
  and headers; 401 for missing and expired tokens; 422 for an unknown body field; login rate limit with
  `RateLimit-*` and `Retry-After`; API key issued once, confined to the machine role, revoked.

Run: static clean; unit 73; contract 3; integration (api, identity, audit, jobs, migrations, constraints)
74 passed, 1 skipped.

Found and fixed:

- **Lock-table exhaustion.** Migration `0011` creates about 280 partitions in one transaction; six parallel
  test migrations exhausted the default lock table. Integration files now run one at a time, and
  `max_locks_per_transaction = 256` is added to the `00` §8 tuning, because unpruned queries take a lock per
  partition in production too.
- **Security events for unknown users.** A denied request from a token whose subject no longer exists would have
  failed the `security_event.user_id` foreign key; the user id is now resolved inside the insert.
- An unauthenticated request to an unknown path answers 401, not 404 (`05` §5.3 precedence); the test was wrong.

Not in slice 3a (slice 3b):

- `PATCH /users/{id}`, deactivation, role assignment and role-permission editing, sessions list and revoke,
  password change, `DELETE /auth/mfa`, settings, job schedules, recompute, audit and security event lists,
  `/meta`, `/metrics`.
- MFA enrolment by an administrator who has no session yet (06 §6.5 says the challenge id is the credential;
  `05` lists the route under `auth:self:manage`; the two need reconciling).
- Signed cursors: list endpoints return one page of up to 200 rows.
- **SEC-T-02, SEC-T-03, SEC-T-06**, and SEC-T-07…17, which were not reviewed in this slice.
- No CORS headers are emitted: the SPA is served same-origin by the proxy. This is an assumption to confirm
  against `06` §9.5.
- The `ops.send_email` handler (SMTP) does not exist, so queued mail dead-letters until it does.

## Slice 3b delivered

`apps/api/src/routes-admin.ts`, plus `changePassword` and `disableMfa` in the identity service:

- Own account: password change (keeps only the calling session family), `DELETE /auth/mfa` (password and code;
  refused where MFA is mandatory), sessions list, revoke all others, revoke one (another user's session answers
  404, `06` §7.4).
- Users: read, `PATCH` (display name; ACTIVE ↔ SUSPENDED and unlock through the `01` §3.4 state machine; suspension
  revokes sessions), deactivate with a reason (revokes sessions), role assignment (refuses `INGEST_SERVICE` for a
  person and `ADMIN` without MFA; field named `roleCodes` to satisfy SEC-T-02), admin-triggered reset email.
- Roles: read with permissions; replace a role's permissions.
- Admin: job detail and attempts (stack traces stripped), job schedules list and `PATCH` (cron and time zone
  validated with croner; a changed expression restarts at its next window), settings list and `PUT` with
  mandatory `If-Match` (428 / 412), type-preserving values and read-only `security.*`, audit and security event
  lists bounded to 90 days.
- `/meta` returns timeframes, Renko brick sizes, RS windows and the build SHA; the indicator catalogue and condition
  registry join it in Phases 7 and 12.

Every new state change writes an audit row with before and after. Evidence: `apps/api/test/admin.integration.test.ts`
(If-Match and setting rules; password change revoking other families; role guards; deactivation through the state
machine; audit list and range cap; schedule validation; foreign session as 404), and the route × role matrix of
`api.integration.test.ts`, which now covers every new route with no 5xx. Run: static clean; unit 73; contract 3;
integration (admin, api, identity, audit, jobs, migrations, constraints) 78 passed, 1 skipped.

Decisions: settings under `security.*` are read-only through the API because token lifetimes are fixed when the
process starts; a settings ETag is `md5(value || updated_at)`.

Still open in Phase 3:

- `/metrics` (Phase 14) and `/admin/recompute` (needs the analytics jobs of Phases 6–8).
- Signed cursors for lists; SEC-T-02/03/06 and a review of SEC-T-07…17.

## Decision: administrator MFA enrolment by login challenge

Decided by the system owner: an administrator without MFA enrols with the login `challengeId` (`06` §6.5).
`/auth/mfa/enroll` and `/auth/mfa/confirm` accept either a session holding `auth:self:manage` or that challenge,
bound to the same IP and user agent, unexpired, unconsumed and with attempts left; confirmation by challenge
consumes it and returns the session. The routes are declared `public` and authorise inside the handler, so they
stay visible to the boot-time check. `05` §11.2 and `06` §6.5 updated. Evidence: `admin.integration.test.ts`
enrols an administrator end to end and refuses another client, a wrong code and a reused challenge.

## Slice 4 delivered

`apps/web` (React 19, Vite 6; no router or UI library):

- `lib/api.ts`: access token in memory only; a 401 `AUTH_TOKEN_EXPIRED` triggers one refresh shared by every
  waiting request, serialised across tabs with a Web Lock (`06` §5.9); the CSRF cookie is echoed on every call;
  problems surface as `ApiProblem`.
- `lib/nav.ts`: the brief's navigation, each item behind the permission its API needs; screens of later phases
  say which phase delivers them.
- Login: password, then the TOTP challenge, or enrolment by challenge for an administrator without MFA (secret,
  `otpauth://` link, recovery codes shown once, then confirmation). A reload restores the session silently
  through the refresh cookie.
- Users: list and invite (invite shown only with `user:write`). With `user:write` and `role:read`, each row has
  "Edit roles": it loads the user's current roles, offers every role except `INGEST_SERVICE`, and saves through
  `PUT /users/{id}/roles`. The server's refusals (ADMIN without MFA, a deactivated user) are shown as returned.

Evidence: `apps/web/test/api.test.ts` (one refresh for three concurrent expired requests; no refresh for other
401 codes; navigation filtered by permission); `tsc` with DOM types; `vite build` (231 kB, 72 kB gzipped).

Not done in slice 4: no browser run against a live API, no component or end-to-end tests (Playwright is
Phase 9's E2E stage), Settings and Audit screens (listed for Phase 14), and accessibility review beyond semantic
markup.

## Open

- CI run on PostgreSQL 16; signed cursors; `/metrics`, `/admin/recompute`; SEC-T-02/03/06 and a review of
  SEC-T-07…17.
- An invitation assigns no role, so an invited user signs in to an empty navigation until an administrator
  assigns one with "Edit roles". The role editor's endpoints were checked against a live API; the editor itself
  has not been clicked through in a browser. The user list does not show current roles.
- The `/readyz` mail-queue check and `tradesoft_mail_queue_oldest_age_seconds` (`06` §12.5, `07` §5) are not
  built.
- CI has still not run on PostgreSQL 16.
- Job metrics (`07` §4.4) arrive in Phase 14; until then the runtime logs every claim, completion and failure.

## Smoke test and mail delivery

The SPA was driven in a browser against a live API and a fresh database. Sign-in, a wrong password, the
permission-filtered navigation, a reload restoring the session from the refresh cookie (the `Secure` cookie
is accepted on `http://localhost`), sign-out revoking the session, administrator MFA enrolment by login
challenge, the user list and an invitation all behaved as specified.

The smoke test found one defect: the API did not start under Node's type stripping, because `DomainError`
used a TypeScript parameter property. Vitest compiles with esbuild and never saw it. The class now assigns
its fields, and `erasableSyntaxOnly` in `tsconfig.base.json` makes typecheck reject that syntax.

`ops.send_email` now has a handler (`apps/worker/src/mail.ts`):

- Templates `password-reset` and `invitation`, both linking to `{PUBLIC_ORIGIN}/reset-password#token=…`. The
  token is in the fragment, so it reaches neither a server log nor a `Referer` header.
- Production sends over SMTP with no third-party library: implicit TLS on port 465, STARTTLS required on any
  other port, AUTH PLAIN only after TLS. A server without STARTTLS is refused before any credential is sent.
  Replies 5xx dead-letter the job; 4xx, timeouts and connection failures retry (5 / 30 s / 30 min).
- Development and test use a console transport that logs the message and opens no connection (`07` §3.1).
- New configuration: `MAIL_PORT` (default 587) and `MAIL_USER` (default `MAIL_FROM`); the worker now requires
  `PUBLIC_ORIGIN`.
- Verified by unit tests against an in-process SMTP server with a generated certificate (STARTTLS, an
  untrusted certificate, 4xx and 5xx), and by a worker run that completed a queued invitation. It has not
  been sent through a real provider.
- The SPA page `/reset-password` consumes both links. It reads the token from the fragment, removes it from
  the address bar and history, checks that the two passwords match, lists policy violations, and asks for
  a TOTP code only when the API answers `AUTH_MFA_REQUIRED`. Verified in a browser against a live API: a
  link without a token, a mismatch, two policy rejections, an invitation accepted and signed in with, a
  reused link refused, and a reset for an MFA user completed with a code.
- The ESLint rule tests now allow 30 s: the first lint builds the typed program for the whole repository,
  which took 6.6 s once the worker tests joined that program.

