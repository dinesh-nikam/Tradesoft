# 06 — Security Architecture

**Status:** Phase 0 specification, normative.
**Depends on:** `00` §4 (roles and permissions), `01` BR-040…BR-044, `02` §2 and §5.1, `03` §2.3, `04` §8.3, `05` §5.2.2, §9, §10, §15.
**Wire contract:** `05` §10 defines what a client sees. This document defines what the server does.

---

## 1. Purpose and scope

### 1.1 What this document decides

1. How a principal is authenticated, how that authentication is represented, and how it is revoked.
2. How authorization is evaluated, and why an authorization bug cannot be introduced by adding a route.
3. Where secrets live, how they are rotated, and what happens when they are wrong.
4. Which inputs are dangerous and what stops each class of them.
5. What is written down when something security-relevant happens, and how those records are made tamper-evident.
6. What is explicitly *not* defended, and what event would force it to be defended.

### 1.2 Non-goals

- This document does not re-specify the wire format. Status codes, error codes, cookie attributes and claim names are normative in `05` §10.
- This document does not specify deployment steps. Runbooks are in `07-operations.md`.
- This document does not claim the system is secure because it lists controls. §19 lists what remains exposed.

### 1.3 The one-sentence position

TradeSoft is a **single-tenant, staff-facing analytical platform** with a small, known user population, one internet-facing origin, and no third-party scripts. Its security posture is therefore built around *strong authentication, mechanically enforced authorization, and a short list of trust boundaries* rather than around per-tenant isolation or a WAF.

Two facts drive most of the decisions below:

1. **The dangerous data is financial, and its integrity matters more than its confidentiality.** A leaked sector list is embarrassing; a silently corrupted `close` price is a wrong trading decision. Integrity controls (BR-042, BR-044, INV-15, the hash chain) are therefore as detailed as the authentication controls.
2. **There is exactly one tenant.** Every "tenant" or "account" identifier in a request body would be a fiction that a future reader would trust. There is no such identifier anywhere in the API (`05` API-C1), and §7.7 makes that a build failure rather than a convention.

---

## 2. Objectives, assets, and trust boundaries

### 2.1 Objectives, in priority order

| # | Objective | What failure looks like | Primary controls |
|---|---|---|---|
| O1 | **Market-data integrity** | A bar, indicator, Renko brick, breadth count or RS score differs from what the source said | Ingestion validation L1–L5 (`03` §3), correction workflow (BR-044), append-only audit, revision monotonicity (INV-18) |
| O2 | **Authenticated identity** | Someone acts as a user they are not | Argon2id, MFA for admin, Ed25519-signed access tokens, rotating refresh tokens, API-key hashing |
| O3 | **Authorization correctness** | A Viewer performs an Analyst or Admin action | Route-declared permissions enforced at boot (§7.3), object-level checks (§7.4), deny-by-default |
| O4 | **Audit non-repudiation** | An action happened and there is no trustworthy record of who did it | Same-transaction audit writes (BR-042), hash chain (§14), append-only privileges |
| O5 | **Confidentiality of credentials** | A token, password hash, or MFA secret is readable by an attacker | Memory-only access tokens, hashed refresh tokens, envelope-encrypted TOTP secrets, log redaction |
| O6 | **Availability of the analytical surface** | Logins or scans are flooded into uselessness | Rate-limit buckets (`05` §9), Argon2 semaphore (§4.4), statement timeouts (`04` §10.3) |
| O7 | **Privacy of staff data** | Email addresses, IPs or session history leak | Classification and retention (§13), log redaction, `tradesoft_readonly` cannot read `iam` |

O1 outranks O6: a job that would rather return a stale number than fail is a job that returns a wrong number.

### 2.2 Asset inventory

| Asset | Where it lives | Classification | If disclosed | If altered |
|---|---|---|---|---|
| Password hashes | `iam.app_user.password_hash` | Restricted | Offline cracking; Argon2id makes it expensive, not impossible | Account takeover |
| TOTP secrets | `iam.app_user.totp_secret_ct` | Restricted | MFA bypass for that user | MFA bypass or lockout |
| Refresh tokens | `iam.auth_session.refresh_token_hash` (hash only) | Restricted | Nothing directly: the plaintext is not stored | Session hijack if plaintext also stolen |
| Access tokens | SPA memory, request headers, API process memory | Confidential | Up to 15 minutes of that user's authority | Same |
| API keys | Caller secret store; `iam.api_key.key_hash` (hash only) | Restricted | Ingest-only authority for one exchange | Forged imports under that identity |
| Import files | `data/imports/{yyyy}/{mm}/` on the host volume | Confidential | Vendor market data (already public after close) | Silent corruption of the historical record |
| Audit trail | `audit.audit_event` | Restricted | Who did what, when, from where | Loss of non-repudiation |
| Security events | `audit.security_event` | Restricted | Attack attempts, account names | Loss of detection history |
| Scanner definitions | `scan.scanner_definition` | Confidential | A user's proprietary screen logic | Changed investment criteria |
| Database credentials | `/run/secrets/*` inside containers | Restricted | Full data access at that role's privilege | Total compromise |
| JWT signing key | `/run/secrets/jwt_signing_key.pem` | Restricted | Forged tokens for any user, any role | Total compromise |
| MFA encryption key | `/run/secrets/mfa_encryption_key` | Restricted | Decryption of all TOTP secrets | Total MFA compromise |

### 2.3 Trust boundaries

A trust boundary is crossed whenever data or authority moves between two components that do not share a privilege level. Each boundary below has a numbered identifier used in the STRIDE tables in §15.

| ID | Boundary | Crossing direction | What crosses | Control at the crossing |
|---|---|---|---|---|
| **B1** | Internet → TLS terminator | inbound | HTTP requests, cookies, headers, file bodies | TLS 1.2+/1.3, header and body limits (`05` §3.5), HSTS, request-ID validation |
| **B2** | TLS terminator → `api` | inbound | HTTP with `X-Forwarded-*` | `trustProxy` pinned to the proxy address (§10.10), `X-Forwarded-Proto` required to be `https` in production |
| **B3** | `api` → PostgreSQL | outbound | SQL, bound parameters | `tradesoft_app` role (no DDL, append-only audit), parameterised statements only, per-request `statement_timeout` |
| **B4** | `worker` → PostgreSQL | outbound | SQL, job payloads | Same role as `api`; job payloads are re-validated against the job-type schema before use, never trusted as already-valid |
| **B5** | `api` → filesystem volume | outbound | Uploaded CSV files, exports | Exclusive-create with server-generated names, mode `0640`, path derived from a UUID, never from a filename |
| **B6** | Host → backup store | outbound | Encrypted `pg_dump`/WAL archives | `age` public-key encryption with the private key held offline (§13.3) |
| **B7** | Operator → host / `/metrics` | inbound | SSH, container exec, metric scrapes | Key-only SSH from an allowlisted source, `/metrics` bound to the private interface, no shared root |
| **B8** | Build pipeline → runtime image | inbound | Container images, npm packages | Frozen lockfile, `onlyBuiltDependencies` allowlist, image digest pinning, Trivy gate (§17.5) |

**Nothing crosses B1 without being validated, and nothing crosses B3 without being parameterised.** Every other control in this document either supports one of those two statements or handles the case where a boundary is crossed anyway.

### 2.4 Threat actors

| Actor | Capability | Motivation | Relevant boundaries |
|---|---|---|---|
| Opportunistic scanner | Automated credential stuffing, path probing, known-CVE requests | Bulk account access, crypto-mining | B1, B2 |
| Malicious or careless authenticated insider | Full legitimate UI access, possibly elevated role | Data exfiltration, covering tracks, curiosity | B2, B3, B5 |
| Credential-stuffed legitimate account | Valid password from another breach | Account access | B1 |
| Network attacker on the path | Passive capture if TLS is misconfigured | Credential and cookie theft | B1 |
| Supply-chain attacker | A compromised npm package or base image | Backdoor | B8 |
| Host-level attacker | Anything on the VPS after a container escape | Everything | B3, B5, B7 |

There is **no** multi-tenant attacker in scope, because there are no tenants. A second organisation using the platform would be a second deployment, not a second tenant (§19.2, R-07).

---

## 3. Principles and their mechanical enforcement

A principle that is only written in a document is a preference. Each row below names the mechanism that fails the build, the request, or the migration when the principle is violated.

| Principle | Mechanism that enforces it | What happens on violation |
|---|---|---|
| **Deny by default** | Fastify `onRoute` hook rejects any route whose options lack either `config.permission` (a seeded permission code) or `config.public = true` | **Process refuses to boot.** A new route cannot be added without an explicit authorization decision. |
| **Server-side identity only** | Request schemas are `.strict()`; no DTO contains `userId`, `role`, `permission`, `ownerId`, or `tenantId`; the principal is read exclusively from the verified token | `422 VALIDATION_FAILED` on unknown key. A test enumerates every DTO schema and fails if any field name matches `/^(user|owner|tenant|actor)_?id$/` (§17.2). |
| **Ownership is data, not input** | `owner_user_id` is written from `principal.userId` inside the service, never from the body | Compile error: the create-input type has no such field. |
| **Fail closed on auth** | Auth rate limiter, token verification, and permission resolution all throw on dependency failure | `503 SERVICE_UNAVAILABLE`; never a permissive fallback (§7.7). |
| **No dynamic identifiers from user strings** | Scanner conditions, filters, sort keys, and cursor keys are resolved through closed maps to identifiers | `FILTER_NOT_SUPPORTED`, `SORT_NOT_SUPPORTED`, `SCANNER_CONDITION_INVALID`, `PAGE_CURSOR_INVALID` |
| **Secrets are never in a DTO, log, audit row, or error** | Branded `Secret` type is not serialisable; pino redaction paths; `BR-043` | Serialising a `Secret` throws at runtime in development and test; production type-check prevents it. |
| **Every privileged action is attributable** | BR-042: the audit write shares the transaction with the mutation | Transaction rolls back; the action does not happen. |
| **Least privilege in the database** | Three roles (`02` §2); application role has no DDL and no `UPDATE`/`DELETE` on audit tables | `insufficient_privilege` from PostgreSQL |
| **No client-trusted state** | `If-Match` is mandatory on versioned resources; cursors are HMAC-signed; idempotency is a resource-level unique index | `PRECONDITION_REQUIRED`, `PAGE_CURSOR_INVALID`, `RESOURCE_CONFLICT` |
| **Errors do not leak existence** | Non-owned resources return `404 RESOURCE_NOT_FOUND`, identical to a genuinely absent resource | Response body and timing are indistinguishable (§7.4) |

The first row is the most important one. Authorization decay in every system of this shape happens the same way: a developer adds an endpoint, the default is "no annotation", the framework allows it, and the endpoint is public for six months. Here the framework physically cannot start with an unannotated route.

---

## 4. Identity and account lifecycle

### 4.1 Account states and transitions

`iam.app_user.status` is the single source of truth, with the `CHECK` constraint from `02` §5.1 and the transitions already specified in `01` (state machine 1). Security-relevant semantics per state:

| State | Can authenticate | Can hold sessions | Sessions on entry | Notes |
|---|---|---|---|---|
| `PENDING_VERIFICATION` | No | No | — | Created by invitation or admin creation. Holds one `EMAIL_VERIFICATION` token. |
| `ACTIVE` | Yes | Yes | — | The only state that yields a token. |
| `LOCKED` | No | Existing sessions stay valid until `locked_until` passes | Not revoked | Lockout is a *login* control, not a session control. Revoking sessions on lockout would let an attacker log a victim out by guessing wrong passwords. |
| `SUSPENDED` | No | No | **Revoked immediately** | Administrative action. Revocation is `revoked_at = now()` on every non-revoked session of the user, in the same transaction as the status change. |
| `DEACTIVATED` | No | No | **Revoked immediately** | Terminal. The row is retained for audit-FK integrity (§4.7). |

`LOCKED` deserves the explicit note above because the naive implementation — revoke everything — turns a lockout into a denial-of-service primitive against any user whose email is known.

### 4.2 Invitation

1. Admin calls `POST /users` (`05` §11.3). The service creates the user in `PENDING_VERIFICATION` with `password_hash` set to a random 32-byte value that is never disclosed and never matches any input, and issues an `EMAIL_VERIFICATION` one-time token.
2. The invitation email carries a link containing the token. The token is 32 random bytes, base64url, stored as SHA-256 in `iam.one_time_token.token_hash`, valid for 72 hours, single-use.
3. `POST /auth/password/reset` is the only endpoint that consumes it. On success the user becomes `ACTIVE` and the token is marked consumed in the same transaction.
4. Invitations do not disclose whether the email already exists: `POST /users` returns `409 AUTH_EMAIL_TAKEN` only to a principal holding `user:write`, which is never an anonymous caller.

Admins never see or set another user's password. There is no "set password for user" endpoint; there is only "trigger a reset email" (`POST /users/{id}/password-reset`), which is audited.

### 4.3 Password policy

Policy is enforced in one place — `packages/domain/src/auth/password-policy.ts` — and both `POST /auth/password/change` and `POST /auth/password/reset` call it. `AUTH_PASSWORD_POLICY` carries `errors[]` with one entry per failed rule, and the SPA renders them verbatim so the user is never told "invalid password" without a reason.

| Rule | Value | Rationale |
|---|---|---|
| Minimum length | **12 characters**, counted in Unicode code points after NFKC normalisation | Length is the only composition rule with a real effect on entropy. 12 is the floor for an internet-facing staff tool in 2026. |
| Maximum length | **128 characters** | Bound on Argon2 input size; without it, a 10 MB password is a CPU-exhaustion vector. |
| Composition rules | **None** | NIST SP 800-63B §5.1.1.1: forced symbol classes produce predictable patterns (`Password1!`) and reduce real entropy. |
| Blocklist | Rejected if the normalised lowercase form, or the form with non-alphanumerics stripped, appears in a bundled blocklist; also rejected if it contains `tradesoft`, `nse`, `bse`, `mcx`, `ncdex`, or the deploying organisation's name | Blocklist is a build artefact (`packages/domain/data/common-passwords.txt`, ≥ 100,000 entries, sorted, loaded into a `Set` at boot: ~1.2 MB of resident memory). |
| Context words | Rejected if it contains the user's email local-part or any whitespace-delimited token of `display_name` of length ≥ 4, case-insensitive | Prevents `dinesh.nikam2026`. |
| History | Rejected if it matches any of the **last 5** hashes in `iam.password_history` | `AUTH_PASSWORD_REUSED` |
| Expiry | **None** | Forced rotation produces incremental passwords. Compromise triggers a forced reset instead (§18.2, playbook P4). |
| Security questions | **None** | They are a second, weaker password. |

The blocklist is checked *before* hashing, so a rejected password costs no Argon2 time. That ordering matters: without it, the policy check becomes the cheapest way to burn CPU.

### 4.4 Password hashing

```
algorithm   Argon2id, version 0x13
memory      65536 KiB (64 MiB)
iterations  3
parallelism 1
salt        16 random bytes per hash, from crypto.randomBytes
output      32 bytes
encoding    PHC string: $argon2id$v=19$m=65536,t=3,p=1$<salt-b64>$<hash-b64>
```

`parallelism = 1` is deliberate. Argon2's `p` parameter parallelises *within* one hash; with a single-core-per-request budget and a global semaphore, `p > 1` only helps an attacker amortise their own cracking. One lane per hash also makes the timing test in §4.6 stable.

**The semaphore.** At most **4 concurrent Argon2 operations** per process, with a bounded queue of 32 and a 5-second queue timeout after which the request fails with `503 SERVICE_UNAVAILABLE`. Without this, 64 MiB × unbounded concurrency is a memory-exhaustion vector: the `auth.login` rate limiter (`05` §9.1) bounds *arrival rate*, not *simultaneity*, and 200 concurrent logins would request 12.8 GB.

Derivation parameters are recorded in the PHC string itself, so a future increase (say 96 MiB) can be introduced without invalidating old hashes: verify with the stored parameters, and re-hash on next successful login when the stored parameters are below the current target. The re-hash is a normal `UPDATE` and is not audited as a password change.

### 4.5 Password change and reset

**Change** (`POST /auth/password/change`, authenticated):
1. Require `currentPassword` and `newPassword`. Verify `currentPassword` with Argon2id; a failure is `AUTH_INVALID_CREDENTIALS` and increments the lockout counter.
2. Apply the policy (§4.3).
3. In one transaction: update `password_hash`, `password_changed_at`, insert the old hash into `password_history`, prune history beyond 5, revoke **all** session families for the user **except** the family performing the change, and write `audit_event action = "user.password.changed"`.
4. Emit `security_event PASSWORD_CHANGED`.

Revoking the other families is the mechanism that turns "I think my password leaked" into a completed remediation with no further steps.

**Reset** (`POST /auth/password/forgot` → `POST /auth/password/reset`):

- `forgot` always returns `202` with an empty body, for any syntactically valid email, whether or not the account exists, whether or not it is `ACTIVE`. It is rate-limited to 3 per 60 minutes per `sha256(email)` (`05` §9.1) and silently drops excess requests without sending mail.
- The email is sent by the worker, not the API request path, so response time does not correlate with account existence. The job payload contains the token, and job payloads are redacted from logs (§13.4).
- Reset tokens are valid for **60 minutes**, single-use, and invalidated by any subsequent reset request for the same user. Consuming one revokes **all** session families — a reset means "the account may be compromised".
- A reset does **not** disable MFA. If the user has MFA enabled, `POST /auth/password/reset` requires a valid TOTP code in the same request. The alternative — allowing a reset to bypass MFA — makes email compromise equivalent to account takeover, which is the single most common real-world escalation path.

### 4.6 Anti-enumeration and lockout

Enumeration surfaces and their treatment:

| Surface | Distinguishable? | Treatment |
|---|---|---|
| `POST /auth/login` with unknown vs known email | **No** | Argon2id verification always runs, against a fixed dummy hash when the user is absent. Timing tolerance in the test: 15 ms (§17.2). |
| `POST /auth/password/forgot` | **No** | Always `202`, identical body, mail sent asynchronously |
| `POST /auth/mfa/verify` with an expired challenge | Yes | `AUTH_MFA_INVALID`; the challenge id is high-entropy and meaningless without the password step |
| `GET /users/{id}` | Yes, but authorized | Requires `user:read` |
| `RESOURCE_NOT_FOUND` on an owned resource | **No** | §7.4 |
| Response `Date`/`Server` headers | — | `Server` is stripped at the proxy; no version string is emitted anywhere |

**Lockout**: `failed_login_count` increments on every failed password verification for an existing account. At **10** the account becomes `LOCKED` with `locked_until = now() + 15 minutes`, and `security_event LOGIN_LOCKED` is emitted with severity `WARN`. A successful login resets the counter. The counter is **not** incremented for an unknown email — there is no row to increment, and creating one would be an enumeration oracle by timing and by storage.

Two limiters run in parallel and are deliberately different (`05` §9.1):

- Per `(ip, sha256(email))`: 5 attempts per 15 minutes.
- Per `ip`: 30 attempts per 15 minutes across all accounts. This is the one that stops password spraying, where each account sees only one attempt.

The rate-limit key uses `sha256(email)` rather than the raw address so that `ops.rate_limit_counter` — an unlogged table readable by anyone with `tradesoft_app` — does not become a list of every email address that has ever attempted a login.

### 4.7 Deactivation, anonymisation, retention

`POST /users/{id}/deactivate` sets `status = 'DEACTIVATED'`, `deactivated_at`, `deactivation_reason`, revokes all sessions, and writes an audit event with the reason. Several `CHECK` constraints make partial states impossible (`ck_app_user_deactivated`).

The row is **never hard-deleted** while `audit.audit_event.actor_user_id` references it (`on delete restrict`). Erasure is therefore pseudonymisation, applied by a scheduled job after **180 days** of deactivation:

```sql
update iam.app_user
   set email = ('deleted+' || id || '@invalid')::citext,
       display_name = 'Deleted user',
       password_hash = '!',            -- not a valid PHC string; cannot match any input
       totp_secret_ct = null,
       totp_enrolled_at = null,
       last_totp_counter = null,
       failed_login_count = 0,
       locked_until = null
 where status = 'DEACTIVATED'
   and deactivated_at < now() - interval '180 days'
   and email not like 'deleted+%';
```

The job writes one `audit_event action = "user.pseudonymised"` per row. `password_hash = '!'` is the standard shadow-file sentinel for "no password can match", and `ck_app_user_mfa` requires `totp_enrolled_at` and `totp_secret_ct` to be nulled together, which the statement does.

180 days is chosen to cover a quarterly investigation cycle. It is a policy constant in `ops.system_setting` (`security.pii_retention_days`), not a literal in the job.

---

## 5. Session and token architecture

### 5.1 The two artifacts and why there are two

An access token is checked on every request; a refresh token is checked rarely. These two workloads want opposite designs:

- **Per-request check** wants statelessness: verifying a signature is a microsecond and needs no database. A database round-trip per request would add a dependency on the critical path of every chart load.
- **Long-lived credential** wants revocability: a 30-day credential that cannot be revoked is a 30-day liability the moment it is stolen.

So the access token is a self-contained Ed25519-signed JWT valid for 15 minutes, and the refresh token is an opaque random value that exists only as a hash in a database row that can be deleted. The 15-minute window bounds the damage of a stolen access token; the opaque refresh token makes revocation exact.

This is ADR-010. Nothing below changes the decision; it specifies the mechanics.

### 5.2 Access token

**Format:** JWS Compact Serialization, `alg = EdDSA` (Ed25519), header `{"alg":"EdDSA","typ":"JWT","kid":"<8 hex>"}`.

**Claim semantics.** The example in `05` §10.1 is normative for wire names; the meanings are:

| Claim | Type | Meaning | Verification rule |
|---|---|---|---|
| `iss` | string | Public origin, e.g. `https://tradesoft.example.com` | Must equal `OIDC_ISSUER` exactly (byte comparison, no normalisation) |
| `aud` | string | `tradesoft-api` | Must equal the constant exactly |
| `sub` | UUID | `iam.app_user.id` | Must parse as UUID; existence is not re-checked per request |
| `sid` | UUID | `iam.auth_session.id` of the session that issued it | Membership in the revocation set is checked (§5.7) |
| `ver` | integer | **Claim-schema version**, currently `1` | Unknown values rejected with `AUTH_TOKEN_INVALID` |
| `roles` | string[] | Role codes, for display and audit only | **Never** used for authorization (§5.3) |
| `perms` | string[] | Resolved permission codes | Authorization reads only this set |
| `iat`, `exp` | integer | Issued-at, expiry; `exp = iat + 900` | `exp` must be in the future; `iat` must not be more than 60 s in the future |
| `jti` | UUID | Unique token id | Recorded in `iam.auth_session.access_token_jti`; used for correlation in logs, never for revocation |

`ver` is a **format** version, not a per-user epoch. It exists so that a future claim-shape change (for example, replacing `perms` with a bitset) can reject old tokens explicitly instead of misinterpreting them. Revocation is `sid`-based only, which is what `05` §10.1 states. DIAGRAM 7's phrase "session epoch" refers to this `sid` membership check; the diagram is illustrative and this table is authoritative.

**Why `roles` is present but unused.** It makes an audit record readable without a join, and it lets `/auth/me` be answered from the token in the common case. Authorization must read `perms`, because a role is a *set* of permissions resolved at a point in time, and resolving it per request would defeat the purpose of embedding it. A test asserts that no `authorize()` call site reads `roles` (§17.2).

**Verification pipeline.** Ordered, and the order is part of the specification because the order determines which error a client receives:

| # | Step | Failure |
|---|---|---|
| 1 | Split into three base64url segments; decode header | `AUTH_TOKEN_INVALID` |
| 2 | `header.alg` must be exactly `EdDSA` — an allowlist of one | `AUTH_TOKEN_INVALID` |
| 3 | `header.kid` must resolve to a key in the in-memory keyring | `AUTH_TOKEN_INVALID` |
| 4 | Verify the signature over `header.payload` | `AUTH_TOKEN_INVALID` |
| 5 | Parse claims; `iss`, `aud` exact match | `AUTH_TOKEN_INVALID` |
| 6 | `ver === 1`; `sub`, `sid`, `jti` are UUIDs; `perms` is an array of strings | `AUTH_TOKEN_INVALID` |
| 7 | `exp > now - 5s` (5-second leeway for clock skew between `api` processes) | `AUTH_TOKEN_EXPIRED` |
| 8 | `iat <= now + 60s` | `AUTH_TOKEN_INVALID` |
| 9 | `sid` not in the revocation set | `AUTH_SESSION_REVOKED` |

Steps 1–8 are pure computation with no I/O. Step 9 reads an in-process `Set`. There is **no database query** in the happy path, which is why chart requests do not pay for authentication.

The algorithm allowlist at step 2 is not decoration: without it, `{"alg":"none"}` and HS256-signed-with-the-public-key confusion are both live attacks against JWT implementations that trust the header. The library is configured with `algorithms: ['EdDSA']` and the handler additionally asserts the header value, because library defaults have changed between major versions before.

### 5.3 Permission resolution

Permissions are resolved at **login and refresh**, from `iam.user_role` joined to `iam.role_permission`, unioned across roles, and written into `perms`. They are then immutable for the life of the token.

Consequences, stated plainly:

- A permission **grant** takes effect at the next refresh: at most 15 minutes later.
- A permission **revocation** likewise takes effect at the next refresh: at most 15 minutes later.
- An account **suspension or deactivation** takes effect within 30 seconds, because it revokes sessions and revocation is checked per request (§5.7).
- A **password change** revokes every other family immediately.

The asymmetry is deliberate and is the subject of SEC-D-03. The alternative — resolving permissions per request — costs a two-table join on every request including every chart and scanner poll, for a value that changes perhaps monthly in a system with fewer than 50 users. If the user population or the permission churn ever changes by an order of magnitude, this decision is the one to revisit, and the trigger is recorded in §19.1.

There is **no server-side permission cache**. The token is the cache. A second cache would introduce a second invalidation problem with no benefit.

### 5.4 Refresh token: generation, storage, rotation

**Generation.** 32 bytes from `crypto.randomBytes(32)`, encoded base64url (43 characters). Entropy is the entire security property; there is no structure, no claims, and nothing encoded in it.

**Storage.** `iam.auth_session.refresh_token_hash = sha256(token)` as `bytea`. SHA-256 without a salt or pepper is correct here and the reasoning is worth recording, because it is the opposite of the password case:

- A password is low-entropy and guessable, so it needs a slow, salted KDF.
- A refresh token is 256 bits of uniform randomness. There is no dictionary to attack and no rainbow table to precompute. A fast hash is sufficient, and a slow one would add 50 ms of CPU to every refresh for no gain.

Because the plaintext is not stored, a read-only database compromise yields hashes that cannot be replayed.

**Rotation.** Every successful refresh:
1. Locks the session row (`SELECT … FOR UPDATE`, per DIAGRAM 7).
2. If `revoked_at is not null` → `AUTH_SESSION_REVOKED`.
3. If `used_at is not null` → reuse path (§5.5).
4. Otherwise sets `used_at = now()`, inserts a new `iam.auth_session` row with the **same `family_id`**, a fresh 256-bit token, and returns the new access token and a new cookie.

The new row's `expires_at` is `now() + 30 days`, which makes the lifetime sliding. A session family that is used at least once a month never expires; one that is idle for 30 days dies on its own. The absolute cap is **90 days** from the family's first `issued_at`, enforced by a `CHECK` against the family's origin (`expires_at <= family_started_at + 90 days`, stored on the row as `family_started_at`). Without an absolute cap, a stolen refresh token can be kept alive forever by an attentive attacker.

### 5.5 Refresh-token reuse and the grace window

Reuse of an already-rotated token means one of two things: an attacker replayed a stolen token, or a legitimate client raced itself. The two are indistinguishable from a single request, and both responses are wrong half the time:

- Always revoke the family: a user with two browser tabs is logged out at random. This is the bug that makes teams disable rotation.
- Never revoke: a stolen token is silently usable forever.

The design uses three mechanisms together.

**1. Client-side single-flight.** The SPA serialises refresh through a `BroadcastChannel`-backed mutex so that one tab refreshes and the others receive the result (§5.9). This eliminates the common race at the source.

**2. Server-side grace window of 10 seconds.** If a token with `used_at` set is presented, and `now() - used_at <= 10s`, **and** the request's `(client_ip, user_agent)` hash matches the session row's stored values, the server treats it as a benign duplicate:

```
BEGIN;
  SELECT … FOR UPDATE;                                  -- the used row
  -- grace path
  UPDATE iam.auth_session SET used_at = NULL WHERE id = $used_id;
  DELETE FROM iam.auth_session
    WHERE family_id = $family AND issued_at > $used_row.issued_at
      AND revoked_at IS NULL;                           -- the successor we just issued
  UPDATE iam.auth_session SET last_used_at = now() WHERE id = $used_id;
  INSERT INTO audit.security_event (event_type, severity, user_id, client_ip, user_agent, details, correlation_id)
    VALUES ('TOKEN_REFRESH','INFO',$uid,$ip,$ua,
            jsonb_build_object('reason','GRACE_REUSE','familyId',$family), $corr);
COMMIT;
```

Clearing `used_at` and deleting the just-issued successor restores a single valid token, which is the one the racing tab still holds. Both tabs continue with the same chain. This is SEC-D-04, and it is a deliberate, bounded weakening: two valid tokens exist for at most 10 seconds, both within one client fingerprint.

**3. A counter with a hard stop.** Each grace reuse increments `details.graceReuseCount` and is aggregated by a query over `audit.security_event`. More than **3 grace reuses in 24 hours for one family** revokes the family and emits `TOKEN_REUSE_DETECTED`. A real attacker racing a real client produces exactly this pattern.

Outside the grace window, or with a mismatched fingerprint, reuse is unambiguous:

```
UPDATE iam.auth_session SET revoked_at = now(), revoked_reason = 'REUSE_DETECTED'
 WHERE family_id = $family AND revoked_at IS NULL;
INSERT INTO audit.security_event (event_type, severity, …) VALUES ('TOKEN_REUSE_DETECTED','HIGH', …);
```

and the response is `401 AUTH_REFRESH_REUSED` (BR-041).

### 5.6 Cookies

| Cookie | Attributes | Why |
|---|---|---|
| `ts_rt` | `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000` | The refresh token is never readable by JavaScript, and is sent only to the four `/auth/*` endpoints that need it. `Path` scoping means a stolen XSS payload cannot exfiltrate it with a plain `fetch('/api/v1/charts/…')` — the cookie is not attached. |
| `ts_csrf` | `Secure; SameSite=Strict; Path=/; Max-Age=2592000` (readable by JS) | Deliberately readable: that is the whole mechanism of double-submit. It is not a secret from the page, only from other origins. |

Neither cookie sets `Domain`. Both are therefore **host-only**, which prevents a sibling subdomain from receiving them.

**Why not the `__Host-` prefix.** `__Host-` requires `Path=/` and forbids `Domain`. `ts_rt` intentionally uses `Path=/api/v1/auth`, and narrowing the cookie's scope is worth more than the prefix's guarantees. `SameSite=Strict` plus `Secure` plus `HttpOnly` already cover what `__Host-` would add for a cookie that is not shared across subdomains.

**Cookie lifetime vs token lifetime.** `Max-Age` is 30 days but the row's `expires_at` is authoritative. The cookie is a transport; the database is the truth. A cookie that outlives its row produces `AUTH_SESSION_REVOKED`, which is a correct 401, not a bug.

**Clearing.** Logout and any revocation response send `Set-Cookie: ts_rt=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict` and the same for `ts_csrf`. Clearing only the client side is insufficient; the row is revoked in the same request.

### 5.7 Revocation propagation

The problem: a stateless token is valid until it expires, but revocation must be immediate. The solution is a bounded-staleness revocation set.

```
Per api process:
  revokedSessions: Map<sessionId, revokedAt>   // LRU, capacity 50,000, TTL 90 min
  lastPollAt:      Date
  pollFailures:    integer
```

- **Refresh loop**: every 30 seconds, `SELECT id, revoked_at FROM iam.auth_session WHERE revoked_at > $lastPollAt` and merge into the map. The query is served by `ix_auth_session_family`'s sibling index on `revoked_at` (§5.10) and returns a handful of rows.
- **Local invalidation**: when this process performs a revocation (logout, password change, admin deactivate), it inserts the id into the map before committing, so the same process never honours a token it just revoked.
- **Startup**: the first poll runs **before** the HTTP listener accepts traffic. `/readyz` returns `503` until `lastPollAt` is set. This closes the window where a freshly restarted process would honour a token that was revoked while it was down.
- **Poll failure**: entries already in the map remain valid, so old revocations stay enforced. A token whose `sid` is not in the map is accepted, which means revocations that happened after `lastPollAt` are temporarily unknown. After **5 consecutive failures** (2.5 minutes) the process flips `/readyz` to `503` and logs `ERROR`. The proxy removes it from rotation, so the practical window in which a stale process serves traffic is one proxy health-check interval.
- **TTL of 90 minutes**: an entry is safe to forget once the token that could carry that `sid` has expired (15 minutes) plus leeway. 90 minutes is six times the token lifetime and bounds memory at roughly 50,000 × 80 bytes ≈ 4 MB.

The 30-second window is the price of not querying the database per request. It is documented in `05` §10.3 and restated here so that nobody "fixes" it by adding a per-request query without measuring the cost.

**Family revocation is a single `UPDATE`**, not a loop:

```sql
UPDATE iam.auth_session
   SET revoked_at = now(), revoked_reason = $reason
 WHERE family_id = $family AND revoked_at IS NULL;
```

`DELETE /auth/sessions` (revoke all except current) uses `WHERE user_id = $uid AND id <> $currentSid AND revoked_at IS NULL`.

### 5.8 Signing-key rotation

The keyring holds the **current** key and the **previous** key. A token is signed with current and verified against any key in the ring by `kid`.

Rotation procedure (no downtime, no forced logout):

1. Generate a new Ed25519 keypair offline; write the private key to `jwt_signing_key_next.pem`.
2. Deploy with `JWT_SIGNING_KEY_CURRENT` = new key and `JWT_SIGNING_KEY_PREVIOUS` = old key. Restart `api`. Verification now accepts both; signing uses only the new key.
3. Wait **20 minutes** (longer than the 15-minute token lifetime). Every token signed by the old key has expired.
4. Deploy with `JWT_SIGNING_KEY_PREVIOUS` unset. Restart.
5. Destroy the old private key.

`kid` is the first 8 hex characters of `sha256(publicKeyRaw)`. It is not secret. If `kid` collides across a rotation — a 1-in-4-billion event — the keyring refuses to boot rather than guessing.

Rotation cadence: every 90 days as routine hygiene, and immediately on suspected compromise (which additionally revokes all sessions, because the old key may have signed a token for a user whose `sid` the attacker now knows).

There is **no JWKS endpoint** in v1. There is exactly one verifier — this API — and it holds the keys in memory. A public keyset endpoint would add an unauthenticated surface with no consumer. If a second service ever needs to verify TradeSoft tokens, publishing `/.well-known/jwks.json` is the first step, and it is a ten-line change because the keyring already models multiple keys by `kid`.

### 5.9 Client obligations

The SPA's token handling is part of the security design, not a frontend preference. These are requirements on `apps/web`, verified by unit tests and by code review of the auth module:

1. **Access token lives in a module-scoped variable.** Not `localStorage`, not `sessionStorage`, not `IndexedDB`, not a React state that is serialised into a devtools snapshot. A page reload loses it; the app refreshes on boot using the cookie.
2. **`Authorization: Bearer` is attached by a single fetch wrapper.** No component constructs a request directly.
3. **Refresh is single-flight across tabs** via `BroadcastChannel('ts-auth')`: one tab performs `POST /auth/refresh`, the others await the broadcast of the result or of a failure. A tab that receives "refresh failed" drops its in-memory token and shows the login screen.
4. **`X-CSRF-Token` is read from the `ts_csrf` cookie** and attached to the two endpoints that need it.
5. **A `401 AUTH_SESSION_REVOKED` or `AUTH_REFRESH_REUSED` never triggers a retry loop.** It clears state and routes to login. Retrying a reuse error would trip the §5.5 hard stop.
6. **No token is ever placed in a URL**, in an `<img src>`, or in a `Referer`-carrying navigation.
7. **The app does not render anything from a `?next=` parameter as a redirect target** unless it matches an allowlist of in-app paths. Open redirects are how a phishing link becomes a credential-phishing page on the real domain.

### 5.10 Index required by this section

`ix_auth_session_family` already exists (`02` §5.1). The revocation poll needs a supporting index:

```sql
create index ix_auth_session_revoked on iam.auth_session (revoked_at)
  where revoked_at is not null;
```

Without it the 30-second poll is a sequential scan of every session row ever created, which grows without bound until the 30-day purge catches up. This index is part of the `02` §5.1 patch in §20.

---

## 6. Multi-factor authentication

### 6.1 Scope and algorithm

MFA is **TOTP** (RFC 6238) and nothing else in v1. No SMS: SIM-swap and SS7 make it the weakest second factor available, and it adds a paid third-party dependency for a security *reduction*. No WebAuthn in v1: it is the better factor, but it requires a registration-flow design, a relying-party-id decision, and a recovery path, and it buys little for a 50-user staff tool where the dominant risk is a reused password, not a phishing-resistant-token gap. WebAuthn is a recorded deferral with a trigger (§19.1).

| Parameter | Value | Reason |
|---|---|---|
| Secret | 20 random bytes, base32-encoded for the `otpauth://` URI | 160 bits; the RFC 4226 recommendation |
| Algorithm | HMAC-SHA-1 | Universal authenticator support. Every authenticator honours SHA-1; a minority mishandle SHA-256, and a second factor that fails on the user's phone is worse than one with a theoretically weaker hash, which is still cryptographically adequate for 6-digit codes. |
| Digits | 6 | Matches every authenticator's default; 8 digits is a UI/compatibility tax for a 100× search space that a 90-second window does not need. |
| Period | 30 seconds | RFC 6238 default |
| Accepted window | `t-1`, `t`, `t+1` | ±30 seconds of clock drift. Wider windows are a brute-force subsidy. |
| Attempt limit | 5 per challenge (`05` §9.1) | 10^6 × 3 valid codes in a 90-second window with 5 guesses is a 1.5 × 10⁻⁵ probability. |

### 6.2 Secret protection

`iam.app_user.totp_secret_ct` is **envelope-encrypted at the application layer**, not merely protected by disk encryption. A database dump — from a backup, a replica, or `tradesoft_readonly` misuse — must not yield usable TOTP secrets.

```
format:  [1 byte version=0x01][1 byte key_id][12 byte IV][16 byte GCM tag][ciphertext]
cipher:  AES-256-GCM
AAD:     "mfa:" + user_id (UTF-8)          -- binds the blob to its owner
IV:      crypto.randomBytes(12) per encryption, never reused with a key
```

The AAD binding matters: without it, an attacker with `UPDATE` on `iam.app_user` could move one user's encrypted secret onto another account and silently enrol their own authenticator. With it, the GCM tag fails.

Key custody is §12.

### 6.3 Enrolment

Two steps, so that a user cannot be locked out by a half-finished enrolment (BR-009, and `05` §10.6 for the wire shape):

1. `POST /auth/mfa/enroll` → server generates a secret, stores it **encrypted** in `totp_secret_ct` with `totp_enrolled_at is null`, returns `{ secret, otpauthUri, recoveryCodes }`. Recovery codes are returned here and never again. Calling enrol a second time while `totp_enrolled_at is null` replaces the pending secret; calling it when `totp_enrolled_at is not null` returns `409 AUTH_MFA_ALREADY_ENABLED`.
2. `POST /auth/mfa/confirm` with a valid code → `totp_enrolled_at = now()`, `last_totp_counter = <counter used>`, audit event `user.mfa.enabled`, `security_event MFA_ENABLED`.

A pending secret expires after **24 hours**: a background job nulls `totp_secret_ct` where `totp_enrolled_at is null` and the row is older than 24 hours, so an abandoned enrolment does not leave a credential in the database indefinitely.

`DELETE /auth/mfa` requires **both** the account password and a current TOTP code. Requiring only the password would let a stolen session downgrade the account's second factor.

### 6.4 Challenge binding and replay prevention

`POST /auth/login` with a correct password and `totp_enrolled_at is not null` returns `202 { challengeId, methods, expiresAt }` and creates an `iam.mfa_challenge` row:

| Column | Purpose |
|---|---|
| `id` | The `challengeId`; UUIDv7 |
| `user_id` | Owner |
| `ip_hash` | `sha256(client_ip)`; compared, never exposed |
| `ua_hash` | `sha256(user_agent)` |
| `attempts` | Incremented per wrong code; 5 invalidates |
| `expires_at` | `now() + 5 minutes` |
| `consumed_at` | Set on success; a consumed challenge cannot be reused |

Binding to `(ip_hash, ua_hash)` means a challenge id leaked through a log or a shoulder-surf is useless from another host. The binding is a hash so the table does not itself become a store of IP addresses and user agents.

**Replay prevention.** TOTP codes are valid for up to 90 seconds and an attacker who observes one can replay it. `iam.app_user.last_totp_counter` records the counter value of the last accepted code; a code whose counter is `<= last_totp_counter` is rejected even though it is within the window. This is `UPDATE … WHERE last_totp_counter < $counter` inside the verifying transaction, which also makes two simultaneous verifications of the same code safe: exactly one wins on the row lock.

Without this column, a code phished in real time stays valid for the remainder of its window.

### 6.5 Mandatory MFA for administrators

`ADMIN` holders must have `totp_enrolled_at is not null` to obtain a token. The check is in the auth service, after password verification and before session creation:

```
if (user.roles includes 'ADMIN' && user.totp_enrolled_at == null) → 202 { enrolmentRequired: true, challengeId, enrollUrl: '/auth/mfa/enroll' }
```

with no session row created and no cookie set. The `challengeId` is an `iam.mfa_challenge` row bound to this
password verification (§6.4); it is the only credential `/auth/mfa/enroll` accepts from a user without a session. The SPA routes to enrolment. This is a **policy** check, not a permission: an admin without MFA is not "an admin with fewer permissions", they are an admin who cannot log in.

Enforcement is also checked at role-assignment time: `PUT /users/{id}/roles` refuses to grant `ADMIN` to a user whose `totp_enrolled_at` is null, returning `422 VALIDATION_FAILED` with `errors[0].field = "roles"` and a message naming the reason. Closing the loop at both ends means an admin cannot exist in a non-compliant state even briefly.

`INGEST_SERVICE` holders are API-key principals and have no interactive login, so the MFA requirement does not apply to them. Their credential is a 256-bit random key, which is a stronger secret than a password plus TOTP.

### 6.6 What MFA does not protect against

Stated so that the residual-risk table in §19.2 is honest:

- **A phished session cookie.** MFA is verified at login. An attacker who steals a post-login refresh token needs no second factor.
- **A compromised authenticator device.** TOTP secrets are exportable from most authenticator apps.
- **An attacker with database write access**, who can null `totp_enrolled_at` and the secret. That is why `tradesoft_app` having `UPDATE` on `iam.app_user` is a boundary-3 concern (§15) and why the audit trail is the compensating control: the change is recorded, hash-chained, and visible in `/admin/security-events`.

---

## 7. Authorization

### 7.1 The pipeline

Every authenticated request passes through the same four stages, in this order. A shortcut at any stage is a defect.

```
1. AUTHENTICATE   Authorization: Bearer  |  X-Api-Key
                  → Principal (userId, sessionId, perms)   or   (keyId, userId, scopes)
                  Failure: 401 AUTH_TOKEN_* / AUTH_REFRESH_* / AUTH_SESSION_REVOKED

2. AUTHORIZE      route.config.permission ∈ principal.permissions
                  Failure: 403 AUTHZ_FORBIDDEN (API key: AUTHZ_SCOPE_INSUFFICIENT)

3. LOAD           fetch the addressed resource by id, scoped by the principal
                  Failure: 404 RESOURCE_NOT_FOUND   (never 403 — see §7.4)

4. CHECK OWNERSHIP  resource.owner_user_id === principal.userId || is_shared || is_system
                  Failure: 404 RESOURCE_NOT_FOUND
```

Stages 3 and 4 are ordered this way on purpose. Loading first and then deciding visibility gives one error path for "absent" and "not yours", which is what makes the two indistinguishable from outside.

### 7.2 Boot-time route enforcement

A Fastify `onRoute` hook runs for every registered route:

```ts
app.addHook('onRoute', (route) => {
  const cfg = route.config ?? {};
  const declared = cfg.permission !== undefined || cfg.public === true;
  if (!declared) {
    throw new Error(
      `route ${route.method} ${route.url} declares neither config.permission nor config.public`
    );
  }
  if (cfg.public === true && cfg.permission !== undefined) {
    throw new Error(`route ${route.method} ${route.url} declares both public and a permission`);
  }
  if (cfg.permission !== undefined && !PERMISSION_CATALOGUE.has(cfg.permission)) {
    throw new Error(`route ${route.method} ${route.url} names unknown permission ${cfg.permission}`);
  }
});
```

Three properties follow:

1. **Unannotated routes cannot exist.** The process exits at boot, so the failure surfaces in CI and in the developer's first `pnpm dev`, not in production six months later.
2. **Typos cannot exist.** The permission string is validated against the catalogue seeded from `00` §4.1, so `scanner:exec` (singular) fails the boot instead of silently never matching.
3. **The catalogue is a single source of truth.** `PERMISSION_CATALOGUE` is generated from `packages/contracts/src/permissions.ts`, which is the same module the RBAC seed migration reads (`02` §9). A permission that exists in the database but not in code, or the reverse, fails a CI check (§17.2).

### 7.3 The `authorize()` contract

Authorization logic exists in exactly one function. Handlers do not compare strings.

```ts
export type Principal =
  | { kind: 'USER';    userId: string; sessionId: string; roles: RoleCode[]; perms: ReadonlySet<PermissionCode> }
  | { kind: 'API_KEY'; keyId: string; userId: string; scopes: ReadonlySet<PermissionCode> };

export function authorize(
  principal: Principal,
  required: PermissionCode,
  resource?: { ownerUserId?: string | null; isShared?: boolean; isSystem?: boolean }
): void
```

Rules, in order:

1. **Effective grant set.** For `USER`, it is `principal.perms`. For `API_KEY`, it is `principal.scopes ∩ INGEST_SERVICE_PERMISSIONS` — the intersection is recomputed per call rather than trusted from the row, so a key issued with an erroneously broad scope array cannot exceed the machine role.
2. **Missing permission.** `USER` → `403 AUTHZ_FORBIDDEN`. `API_KEY` → `403 AUTHZ_SCOPE_INSUFFICIENT`. The distinction is observable but not informative: neither response enumerates what *would* have been granted.
3. **Anonymous never reaches this function.** Stage 1 rejects first. `authorize(undefined, …)` is a type error, not a runtime `if`.
4. **Ownership.** If `resource` is present and has an `ownerUserId`:
   - `API_KEY` principals are rejected outright — machine credentials never own user resources.
   - Owner match → allow.
   - `isShared === true || isSystem === true` → allow for read operations only; the caller passes a different `required` permission for writes (`scanner:share` versus `scanner:write`).
   - Otherwise → `404 RESOURCE_NOT_FOUND`.
5. **No superuser bypass.** `ADMIN` holds `*` as explicit `role_permission` rows (`00` §3). There is no `if (role === 'ADMIN') return;` anywhere, because that line is how "admin can do anything" silently becomes "anything can be done by whoever reaches that line".

### 7.4 Object-level rules per resource class

| Resource | Owner column | Read rule | Write rule | Not-yours response |
|---|---|---|---|---|
| `scan.saved_view` | `owner_user_id` | owner, or `is_shared`, or `is_system` | owner only | `404 RESOURCE_NOT_FOUND` |
| `scan.scanner_definition` | `owner_user_id` | owner, or `is_shared`, or `is_system` | owner only; system definitions refuse edit with `403 GROUP_IMMUTABLE_SYSTEM`-style `SCANNER_IMMUTABLE_SYSTEM` | `404` |
| `scan.scanner_run` | `requested_by` | inherits the definition's visibility **at run time** (`00` §4.3) | none — runs are immutable | `404` |
| `md.import_batch` | none | any holder of `ingestion:read` | any holder of `ingestion:retry` / `:reconcile` | n/a (not owner-scoped) |
| `iam.auth_session` | `user_id` | own only | own only | `403 AUTHZ_SELF_ONLY` |
| `iam.app_user` | — | `user:read` | `user:write`; **never** own password (that is `auth:self:manage`) | `403 AUTHZ_FORBIDDEN` |
| `ref.market_group` | none (system) or `owner_user_id` (custom) | `group:read` | `group:write`; system groups refuse edit | `404` / `403` |
| `ops.job` | — | `job:read` | `job:retry`, `job:cancel` | n/a |
| `audit.*` | — | `audit:read` / `security:read` | none; append-only | n/a |

`scanner_run` inheriting visibility "at run time" has a subtle consequence worth stating: if a shared definition is later made private by its owner, previous runs become invisible to everyone except the owner. That is the correct behaviour — the definition's confidentiality is the owner's to control — and it is why `scanner_run` copies neither the conditions nor the visibility flag, only `definition_id`.

`AUTHZ_SELF_ONLY` is the one place where a 403 is returned instead of a 404, because the addressed object is a session belonging to *some* user, and `/auth/sessions/{id}` with a foreign id is necessarily an attempt to address another account. It reveals nothing about that account beyond "it exists", which the requester already implied by possessing an id.

### 7.5 Machine principals

API keys are the only machine identity (`05` §10.4). Their authorization is deliberately more restrictive than a user's, in ways that are enforced in code rather than by convention:

- **Scope ceiling.** `scopes ∩ INGEST_SERVICE_PERMISSIONS`. The seeded `INGEST_SERVICE` role holds `exchange:read`, `instrument:read`, `sector:read`, `group:read`, `ingestion:read`, `ingestion:submit` (`00` §4.2). A key's `scopes` array is a subset of that.
- **Route denylist, enforced by the guard.** A key cannot reach `/auth/*`, `/users/*`, `/roles/*`, `/permissions`, `/api-keys/*`, `/admin/*`, or any `scanner:*` route, regardless of scopes. The denylist is a route-level `config.machineAllowed = false` default, applied by the same `onRoute` hook, so a new route is machine-denied unless it opts in.
- **No ownership.** Machine principals cannot create owned resources; attempting to create a scanner definition returns `403 AUTHZ_SCOPE_INSUFFICIENT`.

The default-deny direction of `machineAllowed` is the important part. If it defaulted to allow, every new endpoint would silently become reachable by a year-old key.

### 7.6 Forbidden patterns

These are lint rules and review checks, not suggestions. `packages/domain/eslint.config.js` implements them as `no-restricted-syntax` selectors:

| Pattern | Selector | Why |
|---|---|---|
| `req.body.userId`, `.ownerId`, `.tenantId`, `.roleId`, `.permissions` | Member-expression selector on the request body | Client-supplied identity |
| `token.roles.includes(` inside a handler or guard | Call expression selector | Authorization must read `perms` (§5.2) |
| `if (role === 'ADMIN')` | Binary-expression selector | Implicit superuser |
| `searchParams.get('userId')` | Call expression | Identity via query string |
| `JSON.parse(` in a request path | Call expression | Bypasses the Zod-validated body |
| `db.execute(\`… ${` in a request path | Template-literal selector with a `${` | String-interpolated SQL |
| `dangerouslySetInnerHTML` in `apps/web` | JSX attribute selector | XSS |
| `localStorage.setItem` / `sessionStorage.setItem` with a token-shaped value | Call expression with a literal-match regex | §5.9 obligation 1 |

The lint config is shared, so a violation in any workspace fails CI. Two of these — the SQL template literal and the storage write — are heuristics by nature; §17.2 covers them with runtime assertions for the cases lint cannot see.

### 7.7 Fail-closed matrix

| Check | Dependency | Behaviour when the dependency fails | Error |
|---|---|---|---|
| Access-token signature | In-process keyring | Cannot fail at runtime; a missing key fails boot | Boot failure |
| `sid` revocation | In-process `Set` + DB poll | Entries already loaded stay enforced. After 5 failed polls (2.5 min), `/readyz` → `503` | `503 SERVICE_UNAVAILABLE` |
| Permission set | Embedded in token | Cannot fail at runtime | — |
| API-key lookup | `iam.api_key` | **Fail closed** | `503 SERVICE_UNAVAILABLE` |
| Route permission declaration | Compile/boot | Cannot fail at runtime | Boot failure |
| CSRF double-submit | Cookie comparison | Missing cookie or header → reject | `403 AUTH_CSRF_INVALID` |
| Rate limiter, auth bucket (`05` §9.3) | `ops.rate_limit_counter` | **Fail closed** | `503 SERVICE_UNAVAILABLE` |
| Rate limiter, read bucket | `ops.rate_limit_counter` | Fail open, `WARN` log, `rate_limit_degraded` counter | Request proceeds |
| Login (any stage) | PostgreSQL | **Fail closed** | `503 SERVICE_UNAVAILABLE` |

There is no path in which a failure of a security dependency results in a request being allowed. The one deliberate exception — read rate limiting — is a capacity choice, not a security one, and is recorded as D-05-18.

---

## 8. Machine identity

### 8.1 Format and generation

```
tsk_<8 chars base32 lowercase><32 chars base32 lowercase>
     └── prefix, stored and displayed  └── secret half, shown once
```

The full key is 40 characters of Crockford base32 over 25 random bytes (200 bits). `iam.api_key.key_prefix` stores `tsk_` plus the first 8 characters — matching `ck_api_key_prefix`'s `^tsk_[a-z0-9]{8}$` — which is what the UI lists so an operator can identify a key without seeing it. `key_hash` stores `sha256(fullKey)`.

The prefix is not a secret and not a lookup key in the verification path: lookup is by hash. It exists so that a key found in a log or a CI variable can be matched to a row.

### 8.2 Why SHA-256 and not Argon2id

The API key is 200 bits of uniform randomness. There is no dictionary, no composition pattern, and no human memory involved. A slow KDF protects against guessing a *low-entropy* secret; here, guessing is already infeasible at 2²⁰⁰. Using Argon2id would add 50 ms and 64 MiB to every ingestion request — `POST /ingestion/uploads` and `GET /ingestion/batches/{id}`, which the machine principal polls — for no security gain.

The comparison is constant-time (`crypto.timingSafeEqual` over the 32-byte digest) and the lookup is `WHERE key_hash = $1`, so a wrong key costs one index probe.

### 8.3 Scope model

- `scopes text[]` is validated at issue time to be a subset of `INGEST_SERVICE_PERMISSIONS`; a request outside that set returns `422 VALIDATION_FAILED` with the offending scope named.
- At use time the effective set is `scopes ∩ INGEST_SERVICE_PERMISSIONS` (§7.3 rule 1), so a row edited directly in the database still cannot exceed the machine role.
- `expires_at` defaults to `now() + 1 year` and is required to be at most 1 year ahead. A key with no expiry is refused: an eternal credential in a CI system is a credential that outlives the person who created it.
- Revocation is `revoked_at = now()`. Revoked keys are retained for two years so that `last_used_at` history survives for forensics.

### 8.4 Usage monitoring

- `last_used_at` is updated at most once per **60 seconds** per key (`WHERE last_used_at IS NULL OR last_used_at < now() - interval '60 seconds'`), to avoid an `UPDATE` per ingestion poll.
- A nightly job flags keys where `last_used_at < now() - interval '90 days'` in `/admin/security-events` as an informational finding: a stale credential is an unmonitored credential.
- A key used from more than **3 distinct /24 networks in 24 hours** emits `security_event SUSPICIOUS_INPUT` at severity `WARN` with the distinct network count. It is a signal, not an automatic block: an ingestion service behind rotating egress is legitimate but worth knowing about.

### 8.5 Issuance and rotation

`POST /api-keys` (`05` §11.3) requires `apikey:manage`, a name, a scope list, and an expiry. The response contains the plaintext exactly once; there is no endpoint that returns it again, and no "download CSV of keys" feature.

Rotation without downtime, because two keys can be active simultaneously:

1. Issue a new key with the same scopes.
2. Deploy it to the caller.
3. Confirm traffic by observing `last_used_at` on the new key.
4. Revoke the old key.

`POST /api-keys` and `DELETE /api-keys/{id}` both write an `audit_event` with the prefix (never the secret) and the scope list.

---

## 9. Transport and browser security

### 9.1 TLS

- TLS terminates at the reverse proxy (`00` §8). Minimum version **1.2**; **1.3 preferred** and listed first in the cipher configuration.
- Certificates are obtained and renewed by the proxy (ACME or a managed certificate). Renewal is monitored by an external check that fails if the remaining validity is under **14 days**.
- `X-Forwarded-Proto` is set by the proxy and **required** to be `https` in production; a request arriving with `http` is redirected by the proxy before it reaches `api`, and `api` additionally rejects a production request whose `X-Forwarded-Proto` is not `https` with `421 Misdirected Request`. This catches a misconfiguration where a route bypasses the TLS listener.
- The database port `5432` is bound to the private container network only. It is never published on the host's public interface, and no firewall rule permits it from outside the VPC/host.

### 9.2 HSTS

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

`preload` is **not** sent in v1. Adding a domain to the HSTS preload list is effectively irreversible on a browser-release timescale, and the subdomain inventory of the deploying organisation is not known at design time. `includeSubDomains` is safe here because the deployment owns the whole zone. Enabling `preload` is deferred with a trigger (§19.1) and a pre-condition: every current and planned subdomain serves HTTPS.

### 9.3 Security headers

Set by `api` for API responses and by the proxy for static assets, so that both origins of content carry them:

| Header | Value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | §9.2 |
| `X-Content-Type-Options` | `nosniff` | Prevents a CSV export or a JSON error from being sniffed as HTML |
| `Referrer-Policy` | `no-referrer` | No path, query, or origin leaks through outbound navigation. Cursors and instrument ids can appear in URLs, and a referrer leak would expose a user's research to a third-party site. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Severs `window.opener` to cross-origin pages, blocking reverse tabnabbing |
| `Cross-Origin-Resource-Policy` | `same-origin` | Prevents another site from embedding API responses as subresources |
| `X-Frame-Options` | `DENY` | Redundant with `frame-ancestors`, retained for clients that ignore CSP |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()` | Nothing in the product needs any of these; denying them removes a class of feature-abuse |
| `Content-Security-Policy` | §9.4 | XSS containment |
| `Cache-Control` | `no-store` on all `/auth/*` responses and all error responses | A token-bearing or account-identifying response must not sit in a shared cache |

`Server` and `X-Powered-By` are removed at the proxy. A version string is free reconnaissance.

`Cross-Origin-Embedder-Policy` is deliberately **not** set. `require-corp` would break any subresource that does not opt in with CORP, and the product has no requirement for `SharedArrayBuffer` or high-resolution timers. Adding it would be cargo-culting a header that exists for a capability we do not use.

### 9.4 Content Security Policy

Enforced policy on the SPA document:

```
default-src 'self';
script-src 'self';
style-src 'self';
style-src-attr 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
manifest-src 'self';
worker-src 'none';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

Reasoning for the two non-obvious lines:

- **`style-src-attr 'unsafe-inline'`** is required because React's `style={{…}}` prop and TradingView Lightweight Charts both write inline style *attributes*. Inline styles are not an XSS execution vector on their own: `script-src 'self'` still forbids inline script, and CSS-based data exfiltration needs an outbound channel that `connect-src 'self'` and `img-src 'self' data:` do not provide. Scoping the relaxation to attributes rather than to all styles means that a `<style>` element injected into the DOM is still blocked.
- **`worker-src 'none'`** is accurate today: neither the chart library nor the build emits a worker. If a future feature needs one, the directive is widened to `'self'` deliberately rather than being pre-widened now.

**Build assertion.** `script-src 'self'` only works if the built `index.html` contains no inline script. CI fails if `apps/web/dist/index.html` matches `/<script(?![^>]*\bsrc=)[^>]*>/` (a `<script>` tag without a `src`). This is checked because a plugin adding an inline bootstrap is a silent production breakage that a developer would otherwise discover from a blank page.

**No report collector in v1.** A CSP report endpoint would be an unauthenticated write surface whose only function is to accept attacker-shaped JSON, and log-flooding it is a trivial denial-of-service against the log pipeline. Instead: `Content-Security-Policy-Report-Only` with the same policy is served in `staging`, and violations are inspected manually during each release candidate. If a violation ever reaches production, the endpoint can be added with the same rate-limit bucket as `public`.

### 9.5 CORS

**There is no CORS configuration in production, and the absence is the control.**

The SPA is served from the same origin as the API (`00` §8: the proxy serves `/` as static assets and proxies `/api/v1`). Same-origin requests are not subject to CORS at all. Emitting `Access-Control-Allow-Origin` would only ever *add* permission, so no such header is emitted for any origin.

- Development uses Vite's `server.proxy` to forward `/api` to `http://localhost:3000`, which makes the dev origin same-origin too. No CORS middleware exists in the codebase.
- The proxy is configured to strip any client-supplied `Origin`, `Access-Control-Request-Method`, and `Access-Control-Request-Headers` before forwarding, so a request cannot influence a header the API never reads.
- A preflight `OPTIONS` request reaches `api` only if a client is making a cross-origin request, which no supported client does. It returns `405 METHOD_NOT_ALLOWED` by the normal router. This is intentional: a supported preflight would be an invitation.

If a mobile or partner client ever needs cross-origin access, that is a new architectural decision, not a configuration change, because it re-opens CSRF and token-exposure questions that the same-origin design closed.

### 9.6 Clickjacking and embedding

`frame-ancestors 'none'` plus `X-Frame-Options: DENY`. There is no embeddable widget, no iframe surface, and no plan for one. The chart is a canvas inside our own document.

### 9.7 CSP and the charting library

TradingView Lightweight Charts is vendored through npm and bundled — it is not loaded from a CDN. That is a security property, not a performance one: a third-party script tag would be a remote-code-execution channel that `script-src 'self'` correctly forbids, and `Subresource Integrity` would not help because the script would still be a third party's to change at will.

---

## 10. Input handling and injection defence

### 10.1 Validation pipeline

Every request passes the same stages. The order is fixed because it determines both the error a client sees and the work an attacker can force.

| # | Stage | Enforced by | Failure |
|---|---|---|---|
| 1 | TLS and proxy limits | Proxy (`client_max_body_size`, header buffer limits) | Connection closed or `413` |
| 2 | Route match | Fastify router | `404 RESOURCE_NOT_FOUND` |
| 3 | Body size | Fastify `bodyLimit` 1 MiB (JSON), streaming counter 200 MiB (multipart) | `413 PAYLOAD_TOO_LARGE` |
| 4 | Content-Type allowlist | Fastify `onRequest` | `415 UNSUPPORTED_MEDIA_TYPE` |
| 5 | Authentication | Guard (§7.1) | `401` |
| 6 | Rate limit | Bucket by route class (`05` §9.1) | `429 RATE_LIMITED` |
| 7 | Authorization | `config.permission` (§7.2) | `403` |
| 8 | Schema validation | Zod, `.strict()`, in `packages/contracts` | `422 VALIDATION_FAILED` |
| 9 | Domain rules | Services in `packages/domain` | `422` or `409` with a specific code |
| 10 | Persistence | PostgreSQL constraints, `EXCLUDE`, deferred triggers | `409 RESOURCE_CONFLICT` or `422` |

Two properties of this ordering matter:

- **Rate limiting precedes schema validation.** Otherwise an attacker can force Zod parsing and error formatting at unlimited rate, which is a CPU and log-volume amplifier.
- **The database is the last line, not the first.** Every constraint that can be expressed in PostgreSQL is, because a service bug must not be able to write an invalid row. The `422` from stage 9 and the `409` from stage 10 must agree; when they disagree, stage 10 is correct and stage 9 has a bug.

### 10.2 SQL injection

There are exactly three surfaces where a value reaches SQL, and each has a different defence. Naming them separately matters, because "we use an ORM" is not an answer for any of them.

**Surface 1 — bound values.** All user-supplied values are bound parameters (`$1`, `$2`, …) through `pg` or Drizzle. There is no string concatenation of a value anywhere in the codebase; the lint selector in §7.6 catches the template-literal form, and code review catches `+` concatenation.

**Surface 2 — identifiers.** Column names, table names, sort keys, filter names and timeframes cannot be bound as parameters. They are therefore **resolved through closed maps**, never passed through:

```ts
// packages/db/sql/identifiers.ts
export const SORT_COLUMNS = {
  symbol:    sql`i.symbol`,
  close:     sql`b.close`,
  changePct: sql`b.change_pct`,
  turnover:  sql`b.turnover`,
} as const;

export function resolveSort(key: string): SQL {
  const col = SORT_COLUMNS[key as keyof typeof SORT_COLUMNS];
  if (!col) throw new SortNotSupported(key);   // → 400 SORT_NOT_SUPPORTED
  return col;
}
```

The map is the allowlist. An unknown key produces a typed error, never a fallback to "use the raw string". This is the same mechanism used for filters (`/market-data/bars`), cursor keys, and the scanner compiler.

**Surface 3 — the scanner condition tree.** This is the only place where a user-authored *structure* is translated into SQL, and it is the most dangerous surface in the product. `04` §8.3 specifies the compiler; the security properties are:

1. **Closed registry.** Every node's `type` must exist in the registry (`04` §8.3, 37 entries). Unknown type → `422 SCANNER_CONDITION_INVALID`. There is no generic "expression" node.
2. **Closed operator set.** Comparison operators come from a fixed `Map<Operator, SqlFragment>`. The operator string from JSON indexes the map; it is never emitted.
3. **Values are parameters.** Every user value — a threshold, a period, a percentage — becomes a bound `$n` with an explicit cast (`$1::numeric`). Numbers are parsed into `Decimal`, re-formatted canonically, and bound as text; they are never interpolated.
4. **Parameterised indicator selection.** An indicator is selected by `params_hash` computed from a **closed** parameter map (`04` §8.3: period must be one of `{5,10,20,50,100,200}` for SMA). A user cannot request `sma_37` because 37 is not in the map, and cannot inject `sma_20; drop` because the string never becomes SQL.
5. **Structural limits before compilation.** Depth ≤ 6, nodes ≤ 25, at most one `MTF_ALIGN` (`04` §8.3). These bound the size of the generated statement, which bounds the damage from a pathological but legal tree.
6. **Statement timeout.** The compiled statement runs with `SET LOCAL statement_timeout = '5s'` (`04` §10.3). A query that defeats the planner is killed rather than allowed to hold a connection.
7. **Assertion in test.** A property test generates random condition trees — including trees seeded with SQL metacharacters in every string field — compiles them, and asserts that the resulting SQL string contains none of the input strings and that the parameter array contains all of them (§17.3).

**Cursor injection.** A keyset cursor carries sort-key values that end up in a `WHERE` clause. They are bound as parameters, but a *forged* cursor could still supply a value that forces a pathological index scan. The HMAC in `05` §6.3 makes forging infeasible, and the `q` fingerprint binds the cursor to its query so a cursor cannot be replayed against a different filter set.

### 10.3 XSS

The product renders numbers and symbols. The attack surface is small, and the controls keep it small:

| Vector | Control |
|---|---|
| Stored XSS via instrument names, sector names, scanner names, group names | React escapes all interpolated text. `dangerouslySetInnerHTML` is lint-forbidden (§7.6). |
| Stored XSS via a data-quality finding message or an ingestion reject reason | Rendered as text, never as HTML. These strings contain vendor-supplied content, so they are treated as hostile. |
| Reflected XSS via a query parameter echoed in an error `detail` | `detail` is rendered as a text node. The API also never reflects a raw input value into `detail` — it reflects the *constraint* that failed. |
| DOM XSS via `window.location` | The SPA's router parses paths, never injects them. The `?next=` allowlist requirement is §5.9 obligation 7. |
| XSS via a CSV export opened in a spreadsheet | Not XSS, but the same family: see §10.4. |
| XSS via an SVG served from our origin | We serve no user-uploaded images. Uploads are `.csv`/`.txt` only (`03` §2.3). |

CSP (§9.4) is the containment layer when one of the above fails: with `script-src 'self'`, an injected `<img onerror=…>` does not execute, and an injected `<script src="//evil">` is blocked.

### 10.4 CSV formula injection

Scanner result exports and audit exports produce CSV that a user will open in Excel or LibreOffice. A cell beginning with `=`, `+`, `-`, `@`, tab, or carriage return is interpreted as a formula by those applications, and `=HYPERLINK(...)` or `=cmd|...` are live attack strings.

The exporter prefixes any such cell with a single quote:

```ts
function csvCell(value: string): string {
  const dangerous = /^[=+\-@\t\r]/;
  const v = dangerous.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
```

Numeric columns are emitted from decimal strings and cannot begin with `=`; the guard applies to every cell regardless, because the day someone adds a "notes" column is the day the guard matters.

### 10.5 Path traversal

The upload path is the only place where a filename exists, and it is never used to build a path:

```ts
const ext = path.extname(originalName).toLowerCase();
if (!['.csv', '.txt'].includes(ext)) throw new FileTypeRejected();
const key = `${yyyy}/${mm}/${uuidv7()}.csv`;
const abs = path.join(IMPORT_ROOT, key);       // uuid-derived; no user bytes
const fh = await fs.open(abs, 'wx', 0o640);    // exclusive create
```

`path.join` with a UUID cannot escape `IMPORT_ROOT`. The original name is stored in `md.import_file.original_name` for display only and is escaped at render. `..`, absolute paths, UNC paths, NTFS alternate data streams (`file.csv:stream`), and trailing-dot/dot-space names all cease to be meaningful because none of them reach the filesystem.

Downloads do not exist for import files in v1: `05` §13 defers them. If they are added, the rule is that the response path is looked up from the database by batch id, never constructed from a client string.

### 10.6 SSRF

There is **no outbound HTTP from any process**, and this is enforced structurally rather than by policy:

- Ingestion adapters are *file* adapters (`03` §1.1). They read from the import volume.
- No code path calls `fetch`, `http.request`, or `axios` against a user-supplied URL. `packages/ingestion` has no HTTP client dependency at all, and adding one fails a dependency check (§17.5).
- The only outbound connections are to PostgreSQL (fixed host from configuration) and SMTP (fixed host from configuration, used for password-reset and invitation mail).
- Link previews, image proxies, webhook testers, and "import from URL" are absent by design.

A future "fetch daily bhavcopy from the exchange" adapter would introduce SSRF, and its design would need an allowlist of exchange hosts resolved at boot plus a ban on redirects to private ranges. That is recorded as a trigger in §19.1 so the decision is not made accidentally.

### 10.7 Deserialisation

- Body parsing is JSON only, with `JSON.parse` on a bounded string. There is no `eval`, no `vm`, no `Function`, and no YAML/XML parser anywhere in the request path.
- Nesting depth is capped at 8 and array length at 5,000 (`05` §3.5). Without a depth cap, `{"a":{"a":{…}}}` at 100,000 levels overflows the stack in any recursive validator.
- No `prototype`-polluting merge: object merging uses explicit field assignment, and Zod strips unknown keys (`.strict()` rejects them instead).
- `ops.job.payload` is JSON produced by our own API, but the worker re-validates it against the job-type schema before use. A payload is data, not a capability: an old payload whose shape no longer matches fails the job with `PAYLOAD_INVALID` rather than being coerced.

### 10.8 Algorithmic complexity

| Surface | Bound | Enforcement |
|---|---|---|
| Regex | **No user-supplied regular expressions exist anywhere in v1.** Scanner conditions compare values; dynamic group rules use a closed predicate set (`00` §5) | Absence, verified by review and by a dependency check on the condition registry |
| CSV row count | 2,000,000 rows (`03` §3.1) | L1 check before parse |
| CSV field length | Per-column documented maximum (`03` §3.2 `FIELD_TOO_LONG`) | L2 check |
| Condition tree | depth 6, 25 nodes | Pre-compile check |
| Bar range | 5,000 bars per request (`05` §6.4) | Schema `max` |
| Renko bricks | 2,000 per request | Schema `max` |
| RS matrix | 5,000 members, unpaginated by design (`05` §12.6) | Schema `max` + `RANGE_TOO_LARGE` |
| Scanner query | 5-second `statement_timeout` | `SET LOCAL` |
| Audit query window | 90 days (`05` §11.10) | `DATE_RANGE_INVALID` beyond it |
| Cursor decode | 4 KiB maximum before base64 decoding | Length check before `JSON.parse` |

The absence of user regexes is the single largest complexity control in the system. A backtracking regex is the most reliable way to turn a text field into a CPU denial of service, and the product has no requirement that would justify one.

### 10.9 Log injection

- `X-Request-Id` is validated against `^[A-Za-z0-9._:-]{8,64}$`; a malformed value is **replaced**, not rejected (`05` §3.7).
- Every user-controlled string written to a log is passed through pino's serialiser, which JSON-encodes. A newline in a symbol name becomes `\n` in the JSON and cannot forge a log line.
- Audit rows store user-controlled strings in `jsonb`, not in a text column that is later concatenated into a log message.
- The audit hash (§14) covers the canonical JSON of the row, so an injected newline changes the hash rather than hiding.

### 10.10 Proxy trust and request smuggling

- `trustProxy` is set to the **exact proxy address or CIDR**, never `true`. With `trustProxy: true`, Fastify believes any `X-Forwarded-For` header, and every IP-keyed rate limiter becomes bypassable by rotating a header value. This is the single most common way a correct rate limiter is defeated in production.
- Requests carrying both `Content-Length` and `Transfer-Encoding` are rejected at the proxy. Node's `llhttp` also rejects them, but the proxy rejection means the request never reaches the application.
- `Transfer-Encoding: chunked` with a declared length mismatch is rejected by the proxy.
- The proxy normalises the request line and rejects absolute-form request targets (`GET http://evil/ HTTP/1.1`).
- HTTP/2 is enabled at the proxy and downgraded to HTTP/1.1 for upstream. `h2c` smuggling is therefore not reachable.

---

## 11. File upload security

### 11.1 The pipeline

Uploads are the only path by which bytes from outside the trusted boundary reach storage. The pipeline is ordered so that the cheapest and most decisive checks run first.

| # | Step | Failure code | Notes |
|---|---|---|---|
| 1 | Authenticate + `ingestion:submit` | `401` / `403 AUTHZ_FORBIDDEN` | No anonymous upload path exists |
| 2 | Rate limit `ingestion.upload` (10 per 60 min per principal) | `429 RATE_LIMITED` | Per-principal, not per-IP, because the caller is authenticated |
| 3 | `Content-Type` is `multipart/form-data` | `415 UNSUPPORTED_MEDIA_TYPE` | |
| 4 | Stream to disk while counting bytes; abort at 200 MiB | `413 PAYLOAD_TOO_LARGE` | Never buffered; the counter is checked every chunk |
| 5 | Extension ∈ `{.csv, .txt}` | `FILE_TYPE_REJECTED` | Case-insensitive; `path.extname` |
| 6 | Declared MIME ∈ `{text/csv, text/plain, application/csv, application/vnd.ms-excel}` | `FILE_TYPE_REJECTED` | Declared MIME is advisory, but rejecting an obvious mismatch costs nothing |
| 7 | First 512 bytes contain no `0x00` | `FILE_TYPE_REJECTED` | A null byte means binary; a real CSV never has one |
| 8 | Valid UTF-8 (or UTF-16 with BOM, transcoded) | `FILE_TYPE_REJECTED` | Invalid UTF-8 in a CSV is a corrupt file, not a row-level problem |
| 9 | `sha256` computed during the same streaming pass | — | One pass, not two |
| 10 | Hash not already in `md.import_file` | `409 IMPORT_DUPLICATE_FILE` with `existingBatchId` | Per `05` §8.4 |
| 11 | `Idempotency-Key` check | Replay of the same key returns the original `202` | Per `05` §8 |
| 12 | Row count ≤ 2,000,000 | `ROW_COUNT_EXCEEDED` | Counted during parse, not by pre-scanning the file |
| 13 | Header mapping resolves every required canonical field | `HEADER_MISSING_REQUIRED`, `HEADER_AMBIGUOUS` | `03` §2.1 |
| 14 | Rows validated L2–L4 | Per-row codes | `03` §3 |
| 15 | File row inserted in `md.import_file`, batch in `RECEIVED` | — | Same transaction as the audit row |

Steps 4–9 happen in a single pass over the stream. A second pass would double the I/O on a 200 MB file and would let a file change between passes if the volume is shared.

**Partial-file handling.** A failure at steps 5–8 leaves a file on disk that is not referenced by any row. A janitor job deletes unreferenced files in `data/imports/**` older than **24 hours**, running hourly. The 24-hour delay ensures a file is never deleted while a slow request is still writing it. If a failure happens *after* `md.import_file` is written, the file is retained per §11.2's retention because the reject reasons reference it.

### 11.2 Storage and permissions

- Root: `IMPORT_ROOT` (a mounted volume, `00` §8). It is **outside** the web root and the proxy has no location block for it.
- Layout: `data/imports/{yyyy}/{mm}/{uuid}.csv`. Month directories are created on demand with mode `0750`.
- Files: mode `0640`, owner is the container's non-root UID, group is the shared group between `api` and `worker`. `worker` must read them for validation; nobody else can.
- The API container runs as a non-root user (`uid 10001`), and the volume is mounted read-write only into `api` and `worker`. `scheduler` mounts it read-only.
- Retention: **24 months**, matching the rejection-record retention in `02` §6, so a reject can always be investigated from its source file.
- Backups include the import volume (`00` §8). Files are already public market data after close, so the backup carries no additional confidentiality requirement — but it is encrypted anyway (§13.3), because the *identity of who imported what* is inferred from the file's existence and timestamp.

### 11.3 Serving files back

There is no download endpoint in v1 (`05` §13). The rule for when one is added:

- The response is generated from a database lookup by `fileId`, never from a path in the request.
- `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="…"` with the filename sanitised to `[A-Za-z0-9._-]`.
- `X-Content-Type-Options: nosniff` is already global.
- The response is never `inline`, so a browser cannot be persuaded to render it as HTML.
- The permission is `ingestion:read`, and the audit event is written.

### 11.4 The parser is the security boundary

Because files are never executed, never rendered by a browser, and never unzipped, the *only* thing that can go wrong with a malicious file is that our parser mishandles it. That makes the parser a security-critical component and the subject of the fuzzing programme in §17.3:

- RFC 4180 quoting, embedded delimiters, embedded newlines, escaped quotes, CRLF and LF, a UTF-8 BOM, and a header-only file are all in the fixture set.
- The fuzz target asserts three properties for arbitrary input: (a) the parser terminates, (b) it never allocates more than 4× the input size, (c) it either produces a row count equal to the number of logical records or rejects the file — it never silently drops a record.
- Property (c) is the one that matters for market data: a parser that silently drops a malformed row is worse than one that crashes, because the batch would reconcile against a smaller set and look valid.

No archive formats are accepted. A CSV inside a ZIP is not a feature request we honour, because zip bombs, path traversal in archive entries, and symlink entries are three vulnerabilities we would then have to defend against.

### 11.5 Accepted risk: no antivirus

There is no ClamAV or equivalent in the pipeline.

Reasoning: the threat model for a malware scanner is "a user downloads a file and executes it". In this system, an uploaded file is parsed by our own code, never served inline, never downloaded by v1 clients, and is stored with restrictive permissions. A scanner would consume ~1 GB of resident memory and require a signature-update channel on a 16 GB host, to protect against a threat that the architecture has already removed.

Triggers that would make it mandatory: any endpoint that serves an uploaded file to a browser with `Content-Disposition: inline`; any feature that shares a file between users; any accepted format that is executable or interpretable (Office, PDF, HTML, SVG, archive).

This is recorded as residual risk AR-06 in §19.2.

---

## 12. Secrets and keys

### 12.1 Inventory

Every secret the system holds, with its custody and its rotation. A secret that is not in this table does not exist, and a pull request that adds one must add a row.

| Secret | Format | Used by | Custody | Rotation |
|---|---|---|---|---|
| `JWT_SIGNING_KEY_CURRENT` | Ed25519 private key, PEM | `api` | `/run/secrets/jwt_signing_key.pem`, mode `0400` | 90 days, or immediately on suspicion (§5.8) |
| `JWT_SIGNING_KEY_PREVIOUS` | Ed25519 private key, PEM | `api` | Same file, previous key appended or separate file | Cleared 20 min after rotation |
| `MFA_ENCRYPTION_KEY` | 32 bytes, base64 | `api` | `/run/secrets/mfa_encryption_key` | 12 months, or on suspicion (§12.4) |
| `CURSOR_SECRET` | 32 bytes, base64 | `api` | `/run/secrets/cursor_secret` | Every deploy; invalidates in-flight cursors (`05` §6.3) |
| `DATABASE_URL` | `postgres://tradesoft_app:…@db:5432/tradesoft` | `api`, `worker`, `scheduler` | `/run/secrets/database_url` | 6 months, via `ALTER ROLE … PASSWORD` in a maintenance window |
| `MIGRATOR_DATABASE_URL` | `postgres://tradesoft_migrator:…` | Migration job only | `/run/secrets/migrator_database_url` | 6 months |
| `SMTP_PASSWORD` | string | `worker` | `/run/secrets/smtp_password` | Per provider policy; 90 days |
| `TLS_PRIVATE_KEY` | PEM | Proxy | Proxy's own secret store | On renewal (≤ 90 days with ACME) |
| `AGE_BACKUP_RECIPIENT` | public key (**not** a secret) | Backup job | Repository, plaintext | n/a |
| `AGE_BACKUP_IDENTITY` | private key | Restore only | **Offline**, on the operator's workstation, never on the host | Annually, or on operator change |

Two deliberate absences:

- **No `COOKIE_SECRET`.** The CSRF token is a random value compared to itself; it is not signed, and signing it would add nothing because the attacker who can set the cookie can set any value. Session integrity comes from the database row, not from a cookie signature.
- **No token-hash pepper.** Refresh tokens and API keys are 200+ bits of uniform randomness. A pepper protects against precomputation, and there is nothing to precompute.

### 12.2 Loading and validation

Secrets are mounted as files under `/run/secrets` and read at boot by `packages/config`. Properties of the loader:

1. **Files, not environment variables.** An environment variable appears in `docker inspect`, in `/proc/self/environ`, and in crash dumps. A file mounted with `0400` does not.
2. **Read once, held in memory.** The file content is read at boot into a non-enumerable module-level binding. No component re-reads a secret file at request time.
3. **Fail-fast validation.** The loader asserts: present, non-empty, correct length or parseable as a PEM key, and not equal to any value in a small deny-list of documented example values (`changeme`, `test`, the literal placeholder in `.env.example`). A failure exits the process with a non-zero code and a message naming the *name* of the secret, never its value.
4. **Never logged, even at `DEBUG`.** The `Secret` branded type has a `toJSON()` that throws. A `console.log(config)` in development throws instead of printing the key.
5. **Non-secret configuration is separate.** `packages/config` exposes `config` (validated, loggable) and `secrets` (validated, not serialisable). Mixing them is a type error because their shapes differ.

What this does not protect against: a process with `ptrace` or `/proc/<pid>/mem` access on the host. That is a host-compromise scenario (§15, boundary B7) and is out of reach of any application-level control.

### 12.3 Key hierarchy for MFA secrets

```
MFA_ENCRYPTION_KEY (32 bytes, external)
        │
        └── AES-256-GCM per record
                AAD = "mfa:" + user_id
                IV  = random 12 bytes per record
                blob = 0x01 || key_id || IV || tag || ciphertext
```

There is exactly one level. A second level (a data-encryption key per user, wrapped by the master) would allow per-user key destruction, which is a meaningful property only if user deletion is a regulatory requirement — and here deletion is pseudonymisation (§4.7), not crypto-shredding. Adding a wrapping layer would add a second failure mode (lost wrapped key) for a property not needed.

`key_id` is a single byte. It allows two keys to be live simultaneously during rotation without a schema change: the decryptor selects by `key_id`, and re-encryption is lazy (§12.4).

### 12.4 Rotation procedures

**JWT signing key.** §5.8. No user impact.

**MFA encryption key.** Rotation must not invalidate stored secrets, so it is lazy and idempotent:

1. Provision `key_id = 2` alongside `key_id = 1`. The loader holds a map `{1: keyA, 2: keyB}`; `MFA_ENCRYPTION_KEY_CURRENT_ID = 2`.
2. New enrolments encrypt with key 2. Reads decrypt by the blob's `key_id`, so both work.
3. A background job (`security.reencrypt_mfa_secrets`, batch size 200, `FOR UPDATE SKIP LOCKED`) re-encrypts rows where `key_id = 1` with key 2. It runs during the maintenance window and is resumable.
4. When the job reports zero remaining rows for key 1, remove key 1 from the loader and restart.

If key 1 is **compromised** rather than merely rotated, step 3 is not optional and the response is different: every affected user must re-enrol (§18.2, playbook P2), because the attacker may already have the plaintext.

**Cursor secret.** Replaced on every deploy. In-flight cursors fail with `400 PAGE_CURSOR_INVALID`, which the client handles by restarting from page 1 (`05` §6.3). This is acceptable because a cursor is a scroll position, and the alternative — a long-lived secret protecting scroll positions — is a worse trade.

**Database password.** `ALTER ROLE tradesoft_app PASSWORD '…'` takes effect for the next connection; existing pooled connections keep working until they recycle. Procedure: set the new password, write the new secret file, rolling-restart `api`, then `worker`, then `scheduler`, then update the database. Both old and new work during the overlap because PostgreSQL does not force-reconnect.

**SMTP.** Provider-dependent. The failure mode is a silent one — password resets stop being delivered — so `/readyz` includes a mail-queue depth check and an alert fires when the oldest queued mail is over 10 minutes old.

### 12.5 What is never stored

| Item | Never stored because |
|---|---|
| Plaintext passwords | Even transiently: the plaintext is hashed in the request handler and never assigned to a variable that outlives the call |
| Plaintext refresh tokens | Only the SHA-256 digest |
| Plaintext API keys | Only the SHA-256 digest; shown once at creation |
| TOTP secrets in plaintext | Encrypted at the application layer |
| Recovery codes in plaintext | SHA-256 digests, ten per set |
| JWT private keys in the repository | The repository contains `.env.example` with the *names* only |
| Session tokens in URLs | §5.9 obligation 6 |
| Credentials in audit `before`/`after` | The audit serialiser strips fields whose names match `/(password|secret|token|hash|key)$/i` |

The audit-stripping rule is enforced in `packages/observability/src/redact.ts` and is applied to every `before`/`after` payload by the audit service, not by each caller. A caller that forgets cannot leak, because the service redacts on the way in.

### 12.6 Secret leakage detection

- **Repository**: `gitleaks` runs in CI on every commit and fails on a detected secret. Its allowlist contains only the documented example values in `.env.example`.
- **Logs**: a post-deploy check greps the last 24 hours of logs for `tsk_`, `eyJ` (a JWT prefix), and `BEGIN PRIVATE KEY`. A hit is a `CRITICAL` alert and a rollback candidate.
- **Client**: `packages/observability` never ships a server secret to the browser bundle. A CI check asserts that `apps/web/dist` contains none of the strings `tsk_`, `postgres://`, or `BEGIN`.

The JWT prefix check is worth a note: an access token in a log is a 15-minute credential, and 15 minutes is enough for an automated attacker to enumerate the entire read surface.

---

## 13. Data protection and privacy

### 13.1 Classification

| Class | Definition | Examples | Handling |
|---|---|---|---|
| **Restricted** | Compromise enables account takeover or total data access | Password hashes, TOTP secrets, signing keys, DB credentials, refresh-token hashes | Application-layer encryption where applicable; never logged; no read path in `tradesoft_readonly` |
| **Confidential** | Compromise enables a business or privacy harm | Emails, display names, IP addresses, user agents, scanner definitions, saved views, import files, audit trails | Redacted in logs; access-controlled; retention-bounded |
| **Internal** | Not public but low impact | Job payloads, settings, data-quality findings, `explain_plan` | Access-controlled by permission |
| **Public** | Market data after publication | OHLCV bars, index levels, Renko bricks, RS scores, breadth counts | No confidentiality control; integrity controls still apply |

Market data is **Public** for confidentiality and **Restricted** for integrity. That asymmetry is the reason O1 outranks O5 in §2.1: nobody is harmed by reading a closing price, and everybody is harmed by a wrong one.

### 13.2 Personal data inventory

| Data | Table.column | Purpose | Retention |
|---|---|---|---|
| Email | `iam.app_user.email` | Identity, notifications | Life of account; pseudonymised 180 days after deactivation (§4.7) |
| Display name | `iam.app_user.display_name` | UI | Same |
| Password hash | `iam.app_user.password_hash` | Authentication | Life of account; set to `'!'` on pseudonymisation |
| Password history | `iam.password_history` | Reuse prevention | 5 most recent; older rows deleted on each change |
| TOTP secret | `iam.app_user.totp_secret_ct` | MFA | Life of MFA enrolment; nulled on disable or pseudonymisation |
| IP address | `iam.auth_session.client_ip`, `audit.security_event.client_ip`, `audit.audit_event.actor_ip` | Security forensics | Sessions 30 days after expiry; security events 24 months; audit 7 years |
| User agent | `iam.auth_session.user_agent`, `audit.security_event.user_agent` | Anomaly detection | Same as the row |
| Failed-login counter | `iam.app_user.failed_login_count` | Lockout | Life of account |

That is the complete inventory. There is no address, no phone number, no payment instrument, no date of birth, and no government identifier anywhere in the schema. There is no analytics beacon and no third-party tracker in the SPA.

### 13.3 Encryption at rest

| Layer | Mechanism |
|---|---|
| Database volume | The host's block-device encryption (LUKS or the provider's volume encryption), enabled before the first migration. Verified by a pre-production check that reads the mount options. |
| Backups | `pg_dump --format=custom` piped through `age --encrypt --recipient $AGE_BACKUP_RECIPIENT`. The private identity is offline (§12.1). |
| Import files in backups | Same `age` encryption, same archive |
| MFA secrets | Application-layer AES-256-GCM (§12.3), independent of volume encryption |
| Passwords, tokens, API keys | Irreversible digests |

The layering matters: volume encryption protects against a stolen disk, and application-layer encryption protects against a stolen *backup* or a leaked `tradesoft_readonly` credential. A backup restored onto an unencrypted laptop still yields no usable TOTP secret.

### 13.4 Log and error redaction

`packages/observability/src/logger.ts` configures pino with an explicit redaction list. The list is deny-by-name, and a test asserts each path is actually redacted by logging a synthetic object and inspecting the output.

```
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
    'body.password',
    'body.currentPassword',
    'body.newPassword',
    'body.token',
    'body.code',
    '*.password', '*.passwordHash', '*.password_hash',
    '*.refreshToken', '*.refresh_token',
    '*.secret', '*.mfaSecret', '*.mfa_secret',
    '*.recoveryCodes', '*.recovery_codes',
    '*.keyHash', '*.key_hash',
    '*.authorization',
    'err.config.headers',
    'err.request.headers'
  ],
  censor: '[REDACTED]'
}
```

Two entries exist because of specific incidents waiting to happen:

- `body.code` — the MFA code. A log of a successful MFA verification containing the code is a second factor leaking into a log aggregator.
- `err.request.headers` — HTTP-client errors in Node conventionally attach the full request including headers, which is how `Authorization` ends up in an error log.

The error formatter never includes a stack trace in a production HTTP response (`05` §5.1: `problem.detail` is generic for `500`), and the `correlationId` is the only pointer a client receives.

### 13.5 Subject access and erasure

- **Access**: an operator holding `user:read` and `audit:read` can assemble a user's record from `/users/{id}`, `/admin/audit-events?actorUserId=…`, and `/admin/security-events?userId=…`. There is no one-click "export everything" endpoint, because building one would create a high-value exfiltration primitive for an insider. The assembly is a documented manual procedure (`07-operations.md`).
- **Erasure**: §4.7. Pseudonymisation preserves referential integrity for the audit trail, which itself is a legal-obligation retention (financial records). The audit rows that reference a pseudonymised user retain `actor_user_id`, which now points at a row with no personal data.

The honest limitation: audit rows written *before* pseudonymisation contain `actor_ip`, which is personal data, and they are retained for 7 years. That is recorded as residual risk AR-08.

---

## 14. Audit and security event integrity

### 14.1 Two streams, two questions

| Table | Answers | Volume | Written by | Read by |
|---|---|---|---|---|
| `audit.audit_event` | *What changed, by whom, and what were the values before and after?* | Low: hundreds per day | Any service, in the same transaction as the mutation (BR-042) | `audit:read` |
| `audit.security_event` | *What authentication, authorization and abuse events occurred?* | Higher: thousands per day | Auth guard, rate limiter, upload validator | `security:read` |

They are separate because their access patterns and retention differ, and because mixing them would force a security analyst to page through `market_bar` corrections to find a login failure. Application logs (pino, stdout, shipped by the host) are the third stream and are **not** a system of record — they are operational and rotate away.

An event that spans both (a failed login) writes a `security_event` only. An event that both changes state and is security-relevant (a password change) writes both, in the same transaction.

### 14.2 The hash chain, and the ordering rule that makes it correct

`audit.audit_event` is append-only and hash-chained: each row's `hash` covers its own canonical content plus `prev_hash`. Modifying or deleting any row breaks the chain from that point forward, and verification detects it.

**The ordering rule is the subtle part.** The original trigger in `02` §7 selected the previous row with `ORDER BY occurred_at DESC, id DESC`. That is wrong in the presence of clock skew between the `api` and `worker` containers: if process A inserts at `t=10.000` and process B inserts at `t=9.998` (skew of 2 ms), B links to A, and a verification that walks `ORDER BY occurred_at` sees B before A and reports a break that is not a tamper.

The corrected rule, which is the normative version:

```sql
create or replace function audit.chain_hash() returns trigger
language plpgsql as $$
declare
  v_prev bytea;
begin
  -- One chain, low volume, and correctness is worth the serialisation.
  perform pg_advisory_xact_lock(hashtext('audit.chain'));

  -- A BEFORE INSERT trigger runs before the identity default is applied, so NEW.id is NULL here.
  -- Assign it from the same sequence the default would use. The assignment happens under the
  -- advisory lock, so id order equals chain order by construction.
  if new.id is null then
    new.id := nextval(pg_get_serial_sequence('audit.audit_event', 'id'));
  end if;

  select hash into v_prev
    from audit.audit_event
   order by id desc
   limit 1;                     -- id is globally monotonic and unique across all partitions

  new.prev_hash := v_prev;
  new.hash := digest(
    coalesce(v_prev, ''::bytea)
    || convert_to(
         new.id::text || '|' || new.occurred_at::text || '|' || new.action
         || '|' || new.entity_type || '|' || new.entity_id
         || '|' || coalesce(new.actor_type, '') || '|'
         || coalesce(new.actor_user_id::text, '') || '|'
         || coalesce(new.after::text, '') || '|' || coalesce(new.before::text, ''),
         'UTF8'),
    'sha256');
  return new;
end $$;
```

`id` is `bigint generated **by default** as identity`, not `always`. The `by default` matters: a `BEFORE INSERT` trigger runs *before* the identity default is applied, so `new.id` is NULL at that point and must be assigned explicitly. `generated always` would still permit the trigger assignment — the restriction is enforced when an `INSERT` statement names the column, not when a trigger sets it — but `by default` states the intent honestly. Application code never supplies `id`.

The function is correct only at `READ COMMITTED`, which is the PostgreSQL default and the isolation level every audit-writing transaction uses. Under `REPEATABLE READ` the writer's snapshot is fixed before it acquires the advisory lock, so it would not see its predecessor and the chain would fork. This is recorded because it is invisible in the code and would only surface as an intermittent verification failure.

`id` is `bigint generated always as identity`, so it is assigned from one sequence and is strictly increasing in insertion order across every process and every partition. Ordering the chain by `id` makes the chain's order equal to insertion order **by construction**, independent of any clock comparison. `occurred_at` remains a reporting column and is not part of the ordering decision.

The chain covers `before` and `after`, so a change to a stored value is detectable. It does **not** cover `metadata`; metadata is free-form context and is protected by the append-only trigger and the privilege model, not by the hash. Excluding it is a deliberate trade to keep hash verification cheap when metadata contains large `explain_plan` blobs. Recorded as SEC-D-08.

The trigger takes an advisory transaction lock. Audit volume is low by design (hundreds per day), so a serialisation point costs nothing measurable, and it removes the read-modify-write race entirely.

### 14.3 Verification

Two mechanisms:

1. **Continuous.** A daily job (`audit.verify_chain`) walks the last 7 days in `id` order, recomputing each hash and comparing. A mismatch is `CRITICAL`, writes a `security_event SUSPICIOUS_INPUT` with the first broken id, and pages the operator. The job records the highest verified `id` in `ops.system_setting` so each run continues rather than rescanning.
2. **On demand.** `GET /admin/audit-events/verify?from=…&to=…` (`05` §11.10) runs the same verification over a range and returns `{ checked, firstBreakAt, firstBreakId }`. The response never includes the recomputed hashes: an operator who can read `hash` and `prev_hash` cannot forge a chain anyway, but there is no reason to hand out the material for a preimage exercise.

The verification is O(n) in rows scanned and reads sequentially by `id`. On the expected volume (≈ 150k rows/year), a full 7-year verification is under 10 seconds.

### 14.4 Partition retention and the archive anchor

`audit.audit_event` is range-partitioned monthly with 7-year retention (`02` §6). Dropping the oldest partition would break the chain, because the oldest surviving row's `prev_hash` points into a partition that no longer exists.

Procedure for a partition being retired:

1. Export it (`COPY … TO` or `pg_dump --table`), compute the terminal row's `hash`, and write a manifest `{partition, firstId, lastId, terminalHash, rowCount, exportedAt}`.
2. Sign the manifest with a detached Ed25519 signature using an **archive** keypair whose public key is committed to the repository and whose private key is offline.
3. Store the export and manifest in the backup store (§13.3).
4. Record the manifest in `ops.system_setting` under `audit.archiveManifests` (a JSON array — small enough to keep in one row).
5. Drop the partition.

Verification treats each manifest as an **anchor**: the oldest live row's `prev_hash` must equal the manifest's `terminalHash`. A chain that starts from nothing is a chain whose beginning was deleted; a chain that starts from a signed anchor is one whose beginning was deleted *deliberately and provably*.

### 14.5 Mandatory audited actions

BR-042 requires an `AuditEvent` in the same transaction for every state-changing administrative action. The concrete list, which is a test fixture (§17.2 asserts each one produces an audit row):

| Action prefix | Triggered by |
|---|---|
| `user.created`, `user.updated`, `user.deactivated`, `user.roles.replaced`, `user.pseudonymised` | `/users/*` |
| `role.permissions.replaced` | `PUT /roles/{id}/permissions` |
| `apikey.created`, `apikey.revoked` | `/api-keys/*` |
| `calendar.updated` | `PUT /exchanges/{id}/calendar/{date}` |
| `instrument.created`, `instrument.updated`, `instrument.delisted` | `/instruments/*` |
| `sector.created`, `sector.updated` | `/sectors/*` |
| `membership.added`, `membership.closed` | Sector and index membership endpoints |
| `group.created`, `group.updated`, `group.deleted` | `/groups/*` |
| `marketdata.correction.submitted` | `POST /market-data/corrections` (BR-044) |
| `ingestion.batch.retried`, `ingestion.batch.reconciled` | Ingestion admin actions |
| `scanner.published`, `scanner.unpublished`, `scanner.deleted` | Scanner definition lifecycle |
| `settings.updated` | `PUT /admin/settings/{key}` |
| `recompute.enqueued` | `POST /admin/recompute` |
| `job.retried`, `job.cancelled` | `/admin/jobs/*` |
| `dataquality.resolved`, `dataquality.waived` | Data-quality findings |

Read operations are **not** audited. Auditing reads would multiply volume by three orders of magnitude, and the questions reads answer ("who looked at the RS matrix") are answered better by the access log than by a transactional table.

### 14.6 Access control on the audit trail

- `audit:read` and `security:read` are `ADMIN`-only (`00` §4.2). There is no per-user audit scoping.
- `tradesoft_readonly` has **no** grant on `iam` or `audit` (`02` §2). A BI tool cannot read the audit trail, and an incident responder using `tradesoft_readonly` must switch to a superuser connection, which is itself a deliberate, logged act.
- `tradesoft_app` has `INSERT` and `SELECT` only on both audit tables. `UPDATE` and `DELETE` are revoked **and** a `BEFORE UPDATE OR DELETE` trigger raises `insufficient_privilege` (`02` §7), so even a mistakenly over-privileged connection fails loudly.
- `GET /admin/audit-events` is capped at a 90-day window per query (`05` §11.10) so that a single request cannot be used to stream the entire trail.

---

## 15. STRIDE threat model

### 15.1 Method

Each trust boundary from §2.3 is examined against the six STRIDE categories. The table records only threats with a non-negligible residual path; a threat fully removed by a control that cannot be misconfigured is omitted rather than padded with "mitigated: TLS".

Severity is assessed as **likelihood × impact** on O1–O7, not on a generic scale.

### 15.2 Threats by boundary

**B1 — Internet → TLS terminator**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-01 | Spoofing | Credential stuffing with a valid password from another breach | Argon2id, per-IP and per-account limiters, MFA on admin | Medium: a non-admin account with a reused strong password and no MFA is still takeable. The control that would close it is mandatory MFA for all users (§19.1). |
| T-02 | Spoofing | Session cookie theft via network capture | TLS 1.2+ with HSTS; `Secure`, `HttpOnly`, `SameSite=Strict` | Low |
| T-03 | Tampering | Request smuggling to desynchronise proxy and API | Both `CL`+`TE` rejected at the proxy; no `h2c` upstream | Low |
| T-04 | Tampering | Path traversal through a crafted upload filename | Filename never used as a path; UUID names; `wx` create | Low |
| T-05 | Repudiation | A user denies having submitted a correction | Audit row written in the same transaction, hash-chained, with `actor_ip` | Low |
| T-06 | Information disclosure | Version fingerprinting from headers or error bodies | `Server` stripped; generic `500` detail; no version in any body except `/meta` (authenticated) | Low |
| T-07 | Denial of service | Request flood | Proxy connection limits; per-IP limits on `public` and `auth.*` buckets; read bucket per principal | Medium: an unauthenticated L3/L4 flood is a hosting-provider problem, not an application one (AR-01) |
| T-08 | Elevation of privilege | A crafted `X-Forwarded-For` bypasses IP rate limits | `trustProxy` pinned to the proxy address; `X-Forwarded-For` overwritten at the proxy | Low |

**B2 — TLS terminator → `api`**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-09 | Spoofing | A request reaches `api` directly, bypassing the proxy's header normalisation | `api` binds to the private interface only; `X-Forwarded-Proto` must be `https` in production | Low |
| T-10 | Tampering | A client supplies `X-Correlation-Id` to poison trace correlation | `X-Correlation-Id` is not accepted; correlation is server-generated (`05` §3.7) | Low |
| T-11 | Information disclosure | Secrets in request headers captured by an access log | pino redaction of `authorization`, `cookie`, `x-api-key`, `x-csrf-token` (§13.4) | Low |
| T-12 | Elevation of privilege | A route added without a permission declaration | Boot-time `onRoute` hook rejects it (§7.2) | Very low |

**B3 — `api` → PostgreSQL**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-13 | Tampering | SQL injection through a bound value | Parameter binding only; lint selector; no string interpolation | Very low |
| T-14 | Tampering | SQL injection through an identifier (sort, filter, cursor) | Closed identifier maps; unknown key → typed error (§10.2) | Very low |
| T-15 | Tampering | SQL injection through the scanner condition tree | Closed registry + closed operator map + bound values + property test (§10.2) | Very low |
| T-16 | Tampering | Application role runs DDL | `tradesoft_app` has no `CREATE`; DDL only as `tradesoft_migrator` | Low: a compromised `api` with the migrator credential would. The migrator URL is mounted only into the migration job (§12.1). |
| T-17 | Tampering | Audit rows modified after the fact | `UPDATE`/`DELETE` revoked + trigger raises; hash chain detects direct superuser edits | Low: a superuser can rewrite the whole chain. Mitigation is the off-host encrypted export (§14.4, AR-09). |
| T-18 | Information disclosure | `tradesoft_readonly` reads `iam` or `audit` | No grant (`02` §2) | Low |
| T-19 | Denial of service | A pathological query holds a connection | Per-request `statement_timeout` (5 s for scanners, 30 s default); pool size bounded | Medium: with a bound pool, a burst of slow reads can still starve writes. Monitored by `pg_stat_activity` wait sampling (§16.5). |
| T-20 | Elevation of privilege | SQL injection reads a signing key from the database | Keys are never in the database (§12.1) | Very low |

**B4 — `worker` → PostgreSQL**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-21 | Tampering | A forged job payload mutates data beyond its intent | Payloads are produced only by our own API and re-validated against the job-type schema; the worker executes typed handlers, never a payload-supplied statement or path | Low |
| T-22 | Spoofing | A rogue worker claims jobs | `locked_by` is bound to a worker id from configuration; the advisory lock on the queue serialises the scheduler; a rogue worker needs database credentials, which is already full compromise | Low |
| T-23 | Repudiation | A job mutates data with no attributable actor | Jobs carry `correlation_id` and `payload.actorUserId` where an operator initiated them; the audit event records `actor_type = 'SYSTEM'` otherwise | Low |
| T-24 | Denial of service | A poison job retries forever | `max_attempts`, then `DEAD_LETTER` (`03` §5.2); `reclaimed_count` bounded | Low |

**B5 — `api` → filesystem**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-25 | Tampering | An uploaded file overwrites an existing file | `wx` (exclusive create) with a UUID name; overwrite is impossible | Very low |
| T-26 | Information disclosure | Another tenant's file is readable | Single tenant; volume mounted only into `api`, `worker`, `scheduler` | n/a |
| T-27 | Denial of service | Disk exhaustion by uploads | 200 MiB per file, 10 uploads/hour per principal, 24-hour janitor for unreferenced files, disk-space alert at 80% | Medium: ten principals can still write 2 GB/hour. Bounded by the alert and by the fact that principals are staff. |
| T-28 | Elevation of privilege | A file with the execute bit is placed in a directory that is later executed | Files are `0640` with no execute bit, written by a non-root process, into a directory that no process executes from | Low |
| T-29 | Tampering | An imported file is modified after ingestion, invalidating the audit record | The `sha256` in `md.import_file` is the reference; a re-verification job for the last 90 days compares the on-disk hash | Low |

**B6 — Host → backup store**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-30 | Information disclosure | A backup is stolen and read | `age` encryption with an offline identity (§13.3) | Low |
| T-31 | Tampering | A backup is restored and silently altered | Restore is followed by a chain verification (§14.3) and a reconciliation query comparing row counts and `max(id)` per table against the manifest | Low |
| T-32 | Denial of service | Backups are not restorable | Monthly restore drill into a scratch database with a recorded outcome (`07-operations.md`) | Medium: an untested backup is a hypothesis. The drill is the control and it is scheduled. |

**B7 — Operator → host**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-33 | Spoofing | SSH access with a password | Key-only authentication; password authentication disabled in `sshd_config`; source-IP allowlist | Low |
| T-34 | Elevation of privilege | A compromised container reaches the host | Containers run as non-root, `no-new-privileges`, dropped capabilities, read-only root filesystem where possible, no Docker socket mount | **High.** A container escape is a total compromise, and the mitigations are hardening, not isolation. AR-02. |
| T-35 | Information disclosure | `/metrics` is publicly readable | Bound to the private interface; bearer token required | Low |
| T-36 | Repudiation | An operator makes an unaudited change | Direct SQL changes bypass the audit trail. The compensating control is that all routine operations have a scripted path that audits, and direct SQL is a documented break-glass procedure requiring a second person. | **High.** AR-03. |
| T-37 | Tampering | The audit chain is rewritten by a superuser | As T-17 | High, accepted |

**B8 — Build pipeline → image**

| ID | Category | Threat | Control | Residual |
|---|---|---|---|---|
| T-38 | Tampering | A malicious npm package runs a postinstall script | `pnpm` blocks lifecycle scripts by default; `onlyBuiltDependencies` allowlist; the allowlist is reviewed like code | Medium: an allowlisted package is trusted absolutely. AR-04. |
| T-39 | Tampering | A dependency is typosquatted | Exact versions in `pnpm-lock.yaml`; `--frozen-lockfile` in CI; a new dependency requires a review that checks the publisher and download count | Medium |
| T-40 | Information disclosure | A secret is baked into an image layer | Secrets are mounted at runtime, never `COPY`d; `gitleaks` on the build context; Trivy secret scanning on the image | Low |
| T-41 | Elevation of privilege | A base image vulnerability is exploited | Digest-pinned base images, Trivy `HIGH`/`CRITICAL` gate, monthly rebuild | Medium |

### 15.3 The five risks that actually keep this system's owner awake

Ordered by expected loss, not by severity label:

1. **T-34, host compromise.** A container escape yields the database, the volume, and the environment. The architecture cannot prevent this; it can only make the host hard to enter and make the blast radius observable.
2. **T-36, unaudited operator change.** This is the most likely way the audit trail is defeated, and it requires a *human process* control rather than a code control.
3. **T-01, credential stuffing against a non-admin account.** Closed by mandatory MFA for everyone, which is deferred for usability reasons. This is the largest remaining gap and it is a product decision, not a technical one.
4. **T-19, connection starvation.** A performance incident that presents as an outage. It is prevented by statement timeouts and detected by wait-event sampling.
5. **T-38, supply chain.** The one attack that requires no credentials and no interaction with the deployed system.

---

## 16. Abuse cases and detection

### 16.1 Detection signals

Every row is a `security_event` `event_type` (`02` §5.7 enumerates the allowed values), a threshold, and an alert destination. The thresholds are `ops.system_setting` values, not literals.

| Signal | `event_type` | Severity | Threshold for alerting | Response |
|---|---|---|---|---|
| Failed logins for one account | `LOGIN_FAILURE` | `INFO` | 5 in 15 min | None (the limiter handles it) |
| Account locked | `LOGIN_LOCKED` | `WARN` | Any | Notify the account owner by email |
| Failed logins across many accounts from one IP | `LOGIN_FAILURE` | `WARN` | 20 distinct emails in 15 min | Block the IP at the proxy for 1 hour |
| Refresh-token reuse | `TOKEN_REUSE_DETECTED` | `HIGH` | Any | Page the operator; the family is already revoked |
| Grace-window reuse count exceeded | `TOKEN_REFRESH` with `reason=GRACE_REUSE` | `WARN` | > 3 per family per 24 h | Family revoked automatically (§5.5) |
| Permission denied | `PERMISSION_DENIED` | `INFO` | 10 in 5 min for one principal | Surface in the admin dashboard; a spike is a misconfigured role or a curious user |
| Rate limit exceeded on an auth bucket | `RATE_LIMIT_EXCEEDED` | `WARN` | 50 in 15 min for one IP | Block the IP for 1 hour |
| Upload rejected for type or size | `UPLOAD_REJECTED` | `INFO` | 5 in 1 hour for one principal | Notify the principal's admin |
| API key used from many networks | `SUSPICIOUS_INPUT` | `WARN` | > 3 distinct /24 in 24 h | Review the key (§8.4) |
| Malformed `X-Request-Id` | — (DEBUG log only) | — | — | Never alerted: it is a monitoring bug, not an attack (`05` §3.7) |
| JWT prefix found in a log line | `SUSPICIOUS_INPUT` | `CRITICAL` | Any | Rotate the signing key, revoke all sessions (§18.2, P1) |
| Audit chain break | `SUSPICIOUS_INPUT` | `CRITICAL` | Any | Page; freeze writes; investigate (§18.2, P5) |
| Data-quality `ERROR` finding | `SUSPICIOUS_INPUT` | `WARN` | Any | Not a security event; routed to the data-quality surface. Included here because the same alert path is used. |

### 16.2 Credential stuffing

Detection: many `LOGIN_FAILURE` across distinct emails from few IPs. Controls already in place: per-IP limiter at 30/15 min, per-account limiter at 5/15 min, Argon2 cost with a 4-way semaphore.

The uncomfortable truth: a stuffing attack with residential proxies and one attempt per account per IP is indistinguishable from normal traffic at the application layer. The only real defences are MFA and breached-password checking. Breached-password checking against HIBP's k-anonymity API is *deferred* because it is an outbound HTTP call and §10.6 states there is none; the trigger to add it is recorded in §19.1.

### 16.3 Session theft

An attacker with a refresh token can mint access tokens indefinitely. Detection signals:

- A refresh from a new `/24` **and** a new user agent, for a session whose `client_ip` has been stable for weeks.
- Two refreshes from different `/24` within the same 10-second grace window (the grace path requires a fingerprint match, so this revokes the family).
- A refresh from a network that has never appeared for that user.

The first and third are **not** automatically blocked in v1 — a travelling user is legitimate. They are recorded and surfaced. The second is blocked.

### 16.4 The scanner as an exfiltration oracle

Scanner results are a licence to query the entire dataset 25 nodes at a time. A principal with `scanner:execute` can enumerate, for example, every instrument whose `close` is between two values, one binary-search step at a time.

This is **by design**: an analyst is supposed to be able to ask questions of the whole market. The controls that matter are rate limits (10 runs/minute, 2 concurrent), the 5-second statement timeout, and the fact that results contain only instruments the principal could already read one at a time. There is no escalation of *data* access through scanners; there is only an escalation of *speed*, which is bounded.

Recorded as SEC-D-11 so that a future "scanner results are sensitive" requirement is recognised as a change of policy rather than a bug.

### 16.5 Resource exhaustion

| Vector | Bound | Detection |
|---|---|---|
| Argon2 memory | Semaphore of 4 (§4.4) | `auth_argon2_queue_depth` metric; alert > 20 |
| Scanner CPU | `statement_timeout` 5 s; 2 concurrent per principal | `scanner_run_duration` histogram; alert p95 > 2 s |
| Chart payload | 5,000 bars per request; one bundled request per chart | `http_response_size` histogram; alert p95 > 4 MB |
| Connection pool | Bounded pool per process; `pg_stat_activity` wait sampling | `db_pool_waiting`; alert > 5 for 60 s |
| Disk | 200 MiB per upload; janitor; 80% alert | `disk_used_percent`; alert > 80% |
| Audit growth | 7-year partition retention with signed archive (§14.4) | `audit_partition_count`; alert > 90 |
| Log volume | Structured, level-controlled; `INFO` in production | `log_bytes_total` rate; alert on 3× baseline |

The pool bound deserves emphasis: with `api` × 2 and `worker` × n all sharing one PostgreSQL, an unbounded pool turns a slow query into a total outage. The pool is sized from the host's `max_connections` with explicit headroom for migrations and the operator's `psql`, and the sum across processes is asserted by a boot check.

## 17. Security verification

### 17.1 What testing can and cannot establish

A security control that is not tested is a claim, not a control. But most security testing is theatre: a scanner that reports "no critical findings" against an authenticated application it cannot log into proves nothing. This section is therefore organised by **what the test would catch if it failed**, not by tool category.

Three classes of property are distinguished, because they need different machinery:

| Class | Example | Mechanism | Where it runs |
|---|---|---|---|
| **Structural** — a property of the code graph | Every route declares a permission; no DTO has a `userId` field | Static analysis, AST query, or a boot-time assertion | CI, every commit |
| **Behavioural** — a property of a running system | A revoked session is rejected within 30 s; a tampered cursor is rejected | Integration test against a real PostgreSQL | CI, every commit |
| **Adversarial** — a property under hostile input | The condition compiler never emits attacker-controlled text into SQL | Property-based test with a generator biased toward metacharacters | CI nightly, plus on change to the target module |

What testing cannot establish, stated so nobody over-claims: it cannot show the absence of a vulnerability, it cannot validate the *policy* (whether `ANALYST` should have `marketdata:correct` is a product decision that no test can make), and it cannot cover the operator. The last is why §18 exists.

### 17.2 Assertions that fail the build

Each of these is a test that must pass before an image is built. They are numbered SEC-T-nn so that a failing pipeline reports a stable identifier, and the identifier appears in the failure message.

| ID | Assertion | Mechanism | What its failure would mean |
|---|---|---|---|
| **SEC-T-01** | Every registered route has either `config.permission` (a non-empty string from the catalogue) or `config.public === true` | The `onRoute` hook (§7.2) runs at boot; a test constructs a Fastify instance with a deliberately unprotected route and asserts registration throws | A handler was added without an authorization decision. This is the single highest-value test in the suite. |
| **SEC-T-02** | No request DTO declares a field matching `/^(user\|owner\|tenant\|actor)_?id$/` or named `role`, `roles`, `permission`, `permissions`, `isAdmin` | Reflection over the Zod schema registry in `packages/contracts`; the test enumerates every exported schema | The API is about to trust client-supplied identity (§3, B3) |
| **SEC-T-03** | No call site of `authorize()` reads `claims.roles` | AST scan of `apps/api/src/**` for member access on the object passed to `authorize()`; the only permitted property reads are `sub`, `sid`, `perms`, `mfa` | Someone has reintroduced role-based branching, which re-creates the stale-permission ambiguity of §5.3 in a second place |
| **SEC-T-04** | `PERMISSION_CATALOGUE` in code and the rows produced by the RBAC seed migration are identical sets | The seed module is imported by the test and diffed against the migration's generated SQL | A permission exists in one place only; either a route is unprotectable or a grant is meaningless (`00` §4.1) |
| **SEC-T-05** | The **authorization matrix** holds: for every route × every role in `00` §4.2, the observed status is the expected status | Generated table test: the role matrix is parsed from `packages/contracts/src/roles.ts` (single source of truth), each cell becomes a test case, a seeded database provides one user per role | A role gained or lost access silently. 47 routes × 4 roles = 188 cases, which is cheap enough to run exhaustively. |
| **SEC-T-06** | `POST /auth/login` against an unknown email and against a known email differ by less than 15 ms at the median over 200 samples | The dummy-hash path of §4.6 is exercised; the test runs with a fixed Argon2 cost so the tolerance is stable in CI | The dummy-hash branch was optimised away, and login became a user-enumeration oracle |
| **SEC-T-07** | Every action in the §14.5 table produces **exactly one** `audit.audit_event` row in the same transaction as its state change | Fixture-driven: each row of the table is a test case that performs the action and asserts `count(*) = 1` and that `txid_current()` matches the mutation's transaction | BR-042 regressed. "Exactly one" matters: two rows means a double-write bug, zero means an unaudited mutation. |
| **SEC-T-08** | Presenting a rotated refresh token outside the grace window revokes the family, and the next request with the successor token returns `401 AUTH_SESSION_REVOKED` | Integration test with two sequential refreshes and a third replay | Rotation is not actually enforcing reuse detection, so a stolen token survives indefinitely |
| **SEC-T-09** | After `revokeAllForUser()`, a request using a still-unexpired access token is rejected within 30 s | Integration test that revokes, advances a fake clock past one poll interval, and asserts `401` | The revocation poll is broken, and §5.3's "suspension takes effect within 30 seconds" is false |
| **SEC-T-10** | The same TOTP code presented twice is accepted once and rejected once with `AUTH_MFA_INVALID` | Uses a deterministic TOTP generator injected into the verifier; no clock mocking | `last_totp_counter` is not being advanced, and a shoulder-surfed code is replayable for 90 s (§6.4) |
| **SEC-T-11** | A cursor with any single byte flipped, or with a truncated MAC, returns `400 PAGE_CURSOR_INVALID` and leaks no row | Property test over 1,000 mutations of a valid cursor | Cursors became a data-exfiltration channel by accepting unsigned offsets (`05` §6.3) |
| **SEC-T-12** | Every SQL fragment produced by the analytics lane either comes from a `packages/db/sql/*.sql` file or is built through the tagged-template helper | Runtime assertion in the query executor: a `QueryPlan` carries a `source: 'file' \| 'template'` discriminant, and a non-template string containing `--` or `;` raises | String-concatenated SQL has appeared in the codebase (§10.2 surface 1) |
| **SEC-T-13** | Every file write goes through `storage.write(objectKey)` and no call site computes a path from request data | Lint rule plus a runtime assertion that the object key matches `^[0-9a-f-]{36}/[0-9a-f-]{36}$` | Path traversal via a filename (§10.5) |
| **SEC-T-14** | Log fixtures containing a JWT, a refresh token, a password, an API key, and an MFA secret produce output in which none of those values appear | Serialise a synthetic record set through the real pino configuration and regex the output | The redaction list in §13.4 has a hole |
| **SEC-T-15** | With the rate-limit store unavailable, `POST /auth/login` returns `503` and `GET /instruments` still returns `200` | Integration test that drops the limiter table's schema; asserts the fail-closed/fail-open split of §7.7 | The failure mode inverted: either logins are unlimited or reads are down |
| **SEC-T-16** | `numeric` columns serialise as JSON strings and `integer` columns as JSON numbers, for every response schema | Schema-walk test over `packages/contracts` response types plus one live request per resource | A price was emitted as an IEEE-754 double, which is a correctness bug with security consequences for anything downstream that compares it (`05` §3.3) |
| **SEC-T-17** | The emitted CSP header equals the snapshot in §9.4 | Response header assertion on `/` and on an API route | Someone added `'unsafe-inline'` to make a chart library work |

SEC-T-01 and SEC-T-05 are the two that justify the whole harness. Everything else is a regression guard against a specific past mistake in this design; those two guard against the mistake nobody has made yet.

The authorization matrix deserves one more sentence, because it is where most RBAC systems rot. The matrix is **generated**, not hand-written: `00` §4.2 is transcribed into `roles.ts` as a typed literal, and the test reads the same literal the seed migration reads. A hand-maintained test table drifts within two sprints; a generated one cannot, because adding a role or a route without updating the matrix fails to compile.

### 17.3 Fuzzing and property-based testing

Four components take attacker-controlled input and transform it into something executable or interpretive. Those four get property-based tests. Everything else gets example-based tests, because fuzzing a function whose input domain is a UUID is a way to burn CPU.

**1. The scanner condition compiler** (`04` §8.3). This is the highest-risk component in the system: it turns analyst-authored JSON into SQL. The property is stated as an invariant rather than as a set of bad inputs:

> For any condition tree `T` accepted by the schema, `compile(T)` produces `(sql, params)` such that no string literal present in `T` appears in `sql`, and every string literal present in `T` appears in `params`.

The generator produces trees with string fields seeded from a corpus of metacharacters — `'`, `--`, `/*`, `;`, `$$`, `\`, `%`, `_`, newlines, and the exact identifiers of system tables. A second generator produces *invalid* trees (unknown operator, unknown field, depth 7, 26 nodes, two `MTF_ALIGN` nodes, a field name that is a SQL keyword) and asserts each is rejected with the specific error code from `04` §8.9 rather than a generic 500. A third asserts the depth/node/`MTF_ALIGN` caps of §10.8 are enforced by the compiler, not only by the schema, so that a future non-HTTP caller cannot bypass them.

The reason for the property rather than a checklist: the registry is expected to grow. A checklist protects the operators that existed when it was written; the property protects the ones added next year by a developer who has not read this document. Note the one deliberate exception: the property is stated over *string* literals. Numeric literals are bound too, but the compiler is allowed to inline a numeric constant it has itself produced.

**2. The CSV parser** (`03` §2.3, and §11.4 of this document). The property is "never panics, never allocates more than the configured bound, and terminates". The corpus includes: unterminated quotes, quotes inside unquoted fields, embedded CRLF inside quotes, a 10 MiB single field, a 20,000-column row, a UTF-16 BOM, mixed encodings mid-file, NUL bytes, lone surrogates, and `EOF` mid-escape. The parser is fuzzed with `fast-check` for one hour nightly against a 512 MiB heap ceiling; a run that exceeds the ceiling fails and produces the shrinking input as an artefact.

**3. The cursor codec.** The property is "any single-byte mutation of a valid cursor is rejected", plus "a cursor minted for query A is rejected by endpoint B". The second property catches the mistake of signing a payload without binding it to the route and filter set, which would let a `15m` cursor be replayed against a `1D` query and return rows under the wrong key ordering.

**4. The TOTP verifier.** The property is "for a fixed secret and fixed counter, exactly one of `{counter−1, counter, counter+1}` verifies, and a counter already consumed never verifies again". This is small enough to test exhaustively, but it is included in the property suite because the ±1 window and the replay guard interact: a naive implementation that checks the window before checking `last_totp_counter` accepts a replay at the lower window edge.

Two components are deliberately **not** property-tested, with reasons: Argon2id (a third-party binding; SEC-T-06 covers the only property we depend on, which is timing parity between the real and dummy paths) and the JWT verifier (a third-party library; the property we depend on is the one-element `algorithms` allowlist of §5.2, which is asserted by a unit test on the verify options, not by fuzzing).

### 17.4 DAST and manual review

**Automated.** OWASP ZAP baseline scan against an ephemeral stack seeded with the `trade-soft` deterministic dataset, authenticated with a seeded `ANALYST` session, in the nightly pipeline. The honest assessment: against a JSON API with no CORS, no reflected input in HTML, and a `script-src 'self'` CSP, the baseline scan finds almost nothing. It is run anyway for two reasons that are not about finding bugs: it fails the build if a security header regresses, and it produces evidence that the deployed artefact — not the source tree — was scanned. Findings are triaged by the rule table in ZAP's config, not by a human reading 200 informational alerts.

**Manual, per release.** DAST cannot test authorization semantics, because it does not know which object belongs to whom. The following are executed by hand against staging before a release that touches `apps/api` or `apps/web`, and the result is recorded in the release note:

| # | Scenario | Expected |
|---|---|---|
| M-01 | Log in as `VIEWER`, call every mutating route with a valid body | `403` on all; no `audit.audit_event` written (denials are security events, not audit events) |
| M-02 | Take an `ANALYST` access token, deactivate the user, wait 31 s, replay the token | `401 AUTH_SESSION_REVOKED` |
| M-03 | Change a user's password in tab A while tab B holds a session | Tab B's next request after refresh returns `401`; the family is revoked |
| M-04 | Enrol TOTP, then present the previous code | `401 AUTH_MFA_INVALID` |
| M-05 | Tamper with one character of a `page[next]` cursor | `400 PAGE_CURSOR_INVALID` |
| M-06 | Submit a scanner with 26 nodes, and one with a nested `MTF_ALIGN` | `422 VALIDATION_FAILED` with the specific code from `04` §8.9 |
| M-07 | Upload a CSV whose header row contains a formula (`=cmd\|...`) in the symbol column | Row rejected at L3; the value never reaches the database |
| M-08 | Upload a 201 MiB file | `413 PAYLOAD_TOO_LARGE`; the temp file is removed |
| M-09 | Request `/admin/audit-events` with a 400-day window | `422 VALIDATION_FAILED` |
| M-10 | Revoke an API key, then use it | `401` within one poll interval |
| M-11 | Inspect the browser's local storage and session storage after login | No token, no refresh token, no user object beyond display fields (§5.9) |
| M-12 | Inspect every response header on `/` and on `/api/v1/instruments` | The §9.3 set, and no `Server`, no `X-Powered-By` |

M-01 and M-06 are the two that have caught real regressions in systems of this shape; the others are cheap and prevent the class of mistake that only appears after a refactor.

### 17.5 Supply chain and dependency controls

The build is a trust boundary (B8). A compromised npm package in the dependency tree has the same privileges as the `api` process: it can read the database, the signing key, and the MFA key. These controls exist to make that harder, not to make it impossible.

| Control | Implementation | What it stops |
|---|---|---|
| Frozen lockfile | `pnpm install --frozen-lockfile` in CI; a lockfile diff without a `package.json` diff fails review | A transitive version changing between the tested artefact and the shipped one |
| No lifecycle scripts by default | `pnpm` blocks postinstall; `onlyBuiltDependencies` lists the exact packages allowed to run one, currently `esbuild` and `argon2` | Arbitrary code execution at install time — the most common npm attack |
| Allowlist review | A change to `onlyBuiltDependencies` is treated as a security-relevant change and requires a second reviewer | Silently widening the executable surface |
| Vulnerability gate | `pnpm audit --prod --audit-level high` fails the build; `devDependencies` findings are triaged weekly, not per-commit | A known-exploitable CVE shipping by default |
| Image scan | Trivy on the final image, `--severity HIGH,CRITICAL --exit-code 1`, with an explicit `.trivyignore` that requires a reason and an expiry per entry | OS-package CVEs in the base image |
| Base image pinning | `node:24-bookworm-slim` pinned by **digest**, not tag; Dependabot-style updates are reviewed | A mutable tag resolving to a different image |
| No HTTP client in ingestion | Dependency-graph assertion: `packages/ingestion/package.json` must not include `undici`, `axios`, `node-fetch`, or `got`; a CI script walks the workspace graph | SSRF being reintroduced by a future adapter (§10.6) |
| SBOM | CycloneDX emitted per release and stored with the image digest | Answering "are we affected?" in minutes rather than days |
| Provenance | Images built only from a tagged commit by CI; the digest is recorded in the release note | A hand-built image reaching production |

The `onlyBuiltDependencies` mechanism is the one with the largest effect and the smallest cost, and it is worth being precise about why. Almost every npm supply-chain compromise in the last several years has executed at install time, through a lifecycle script, in an environment that has network access and often has CI secrets. Blocking lifecycle scripts by default means the attacker must get code into a package that is actually *imported and executed at runtime*, which is a strictly harder position and one that `pnpm audit` and code review have some chance of catching.

### 17.6 Container and host hardening

Both the API image and the database run under Docker Compose on one host. Hardening is therefore split between "what the container cannot do" and "what the host prevents".

**Container** (`infra/docker/api.Dockerfile`, multi-stage):

| Setting | Value | Reason |
|---|---|---|
| User | `node` mapped to uid/gid `10001`, created in the build stage | A container escape starting from uid 0 is a host compromise; from 10001 it is a privilege-escalation step |
| Filesystem | `read_only: true` with `tmpfs` at `/tmp` (64 MiB) and a writable volume only at the import root | Nothing the application does needs a writable root; uploads are the one exception and are bounded |
| Capabilities | `cap_drop: [ALL]` | The process needs no Linux capabilities |
| Escalation | `security_opt: [no-new-privileges:true]` | Blocks setuid binaries inside the image |
| Ports | `api` publishes only through the proxy's network; PostgreSQL publishes nothing | The database is not reachable from the internet at all |
| Docker socket | Not mounted, ever | A mounted socket is root on the host |
| Healthcheck | `GET /healthz` | Compose restarts a wedged process |
| Logging | `json-file` with `max-size: 50m`, `max-file: 5` | An unbounded log driver fills the disk during an incident, which turns a security event into an outage |

**PostgreSQL**:

| Setting | Value | Reason |
|---|---|---|
| `listen_addresses` | Container network only | Not reachable from the host's public interface |
| `pg_hba.conf` | `scram-sha-256` for the three application roles, from the compose subnet only | No `trust`, no `md5` |
| Roles | `app_rw`, `app_ro`, `migrator` (`02` §3); the application connects as `app_rw` | The audit trail's `REVOKE UPDATE, DELETE` is meaningless if the app connects as the owner |
| `log_statement` | `ddl` | DDL outside a migration is visible; DML logging is too expensive |
| `pgaudit` | Not installed | Deferred: the application-level audit trail is the primary record, and pgaudit's volume on this workload would be mostly `SELECT` noise (AR-05) |

**Host**: SSH key-only with password authentication disabled, `PermitRootLogin no`, `ufw` default-deny inbound with only 22/80/443, `unattended-upgrades` for security patches, and a separate non-login account for the deployment user. These are one-time setup steps recorded as a runbook in `07`, not as code, because they are not reproducible from the repository and pretending otherwise would be worse than documenting them.

### 17.7 Penetration test scope

A third-party test is commissioned once before the production-readiness gate and annually thereafter. The scope is written down here so that a quote can be compared against it and so that the tester does not waste days on out-of-scope surface.

**In scope:** the public HTTPS surface (`/api/v1/**`, the SPA) as an authenticated `ANALYST`, `VIEWER`, and `SUPPORT` user, plus unauthenticated; the authentication flows including MFA enrolment and recovery; the scanner condition surface; the file-upload surface; the admin surface as `ADMIN`; session handling including fixation, rotation, and logout; authorization on every object-level route.

**Explicitly out of scope:** volumetric denial of service (a hosting-provider concern, AR-01), social engineering, physical access, the npm registry and its packages, and PostgreSQL itself beyond the application's use of it. A finding that requires superuser access to the database is recorded as an accepted risk (AR-03, AR-09), not as a remediation item.

**Report requirements:** each finding must carry a reproduction, an impact statement tied to this document's objectives (§2.1), and a severity. Remediation targets: critical 72 hours, high 14 days, medium 90 days, low at the next scheduled release. A finding that this document already lists as an accepted risk is closed as "known and accepted" with a pointer to §19.2, and the acceptance is re-justified at that time rather than assumed.

### 17.8 What is deliberately not tested

Stated because an untested control that is believed to be tested is worse than one that is known to be untested:

- **The operator.** No test covers a human running `psql` against production. That is AR-03, and the compensating control is procedural.
- **The proxy configuration.** TLS termination, HSTS at the edge, and request-size limits are configuration of a third-party component, verified by M-12 and by the deployment runbook, not by the test suite.
- **Timing side channels beyond login.** Inequality of response time between "instrument exists" and "instrument does not exist" is not tested, because every read route requires authentication and the population of instruments is not secret to an authenticated analyst.
- **The audit chain under concurrent load.** §14.3 verifies the chain; the *behaviour* of the chain function under 50 concurrent writers is covered by the concurrency tests in `07`, not here, because it is a throughput question rather than a security one.

## 18. Incident response

### 18.1 Severity ladder

Severity is assigned by **what an attacker can currently do**, not by how alarming the alert looked. A `CRITICAL` security event that turns out to be a monitoring artefact is S4; a quiet `WARN` that reveals an analyst can read another user's session is S2.

| Sev | Definition | Examples | Acknowledge | Contain | Who declares |
|---|---|---|---|---|---|
| **S1** | A credential granting broad or cross-user access is confirmed or strongly suspected compromised, or the integrity of the record is in doubt | Signing key or MFA key exposed; `app_rw` or superuser credentials exposed; audit chain break; confirmed exfiltration of market data or user data | 15 min, page the on-call | 4 h | On-call, informs the owner |
| **S2** | One account or one narrow capability is compromised, or a defect grants access that should be denied | Password reuse + no MFA on a `SUPPORT` account; leaked API key; IDOR-class authorization defect; MFA bypass for one user | 1 h | 24 h | On-call |
| **S3** | Suspicious activity with no confirmed compromise, or a vulnerability with no evidence of exploitation | 200 failed logins from one ASN; a dependency CVE reachable in theory; a rate-limit bucket found disabled | 1 business day | 7 days | On-call, may downgrade |
| **S4** | Policy deviation, hardening gap, informational | Missing security header on a non-production route; an allowlisted build dependency that no longer needs its script | Next triage | Next release | Anyone, via issue tracker |

The ladder has one asymmetry worth stating: **S1 is declared on suspicion, not proof.** Rotating the signing key and revoking all sessions costs every user one re-login — perhaps 40 people, 30 seconds each. Failing to do so while investigating costs the confidentiality of the entire dataset. The asymmetry of consequences decides, not the asymmetry of effort.

### 18.2 Playbooks

Each playbook is a sequence of commands with a verification step, because an incident is the worst possible time to be composing SQL from memory. Commands assume an operator with the `migrator` role on the production database through the bastion; the application roles deliberately cannot perform most of these actions.

#### P1 — Signing key compromise (S1)

Trigger: a JWT appears in a log, a repository, an error report, or a support ticket; or the deployment host is suspected compromised; or §12.6's leakage detector fires.

```
# 1. Generate the new key pair off-host, then install as key CURRENT; move old CURRENT to PREVIOUS.
#    (scripts/rotate-signing-key.ts, run as the deployment user; writes 0600, never prints the key)
pnpm --filter @tradesoft/api rotate-signing-key --reason "incident-P1"

# 2. Revoke every session, in one statement. This is the step that actually contains the incident:
UPDATE iam.auth_session
   SET revoked_at = now(), revoked_reason = 'INCIDENT_KEY_COMPROMISE'
 WHERE revoked_at IS NULL;

# 3. Force a re-authentication for every user, so no cached SPA state survives:
UPDATE iam.app_user SET token_invalid_before = now() WHERE status <> 'DEACTIVATED';

# 4. Verify: zero live sessions, all processes have polled, and a token minted before step 2 is rejected.
SELECT count(*) FROM iam.auth_session WHERE revoked_at IS NULL;         -- expect 0
SELECT count(*) FROM iam.auth_session WHERE revoked_at IS NULL
   AND revoked_at > now() - interval '2 minutes';                        -- expect 0 after 60 s
```

Steps 2 and 3 are both required. Step 2 kills refresh tokens; step 3 kills access tokens that are still inside their 15-minute window and were signed by the compromised key. Because the key is compromised, the attacker can *mint* tokens, so the new key must be generated fresh and the old key must **not** remain in `JWT_SIGNING_KEY_PREVIOUS` for the usual 20-minute overlap — that overlap exists for routine rotation and is exactly wrong here. Set `PREVIOUS` to empty, accept that in-flight requests fail with `401`, and let clients refresh against the new key.

What not to do: do not delete the key file and restart without step 2. Restarting with a new key invalidates tokens signed with the old one, but sessions remain in the database and the attacker's stolen refresh token still works.

#### P2 — MFA encryption key compromise (S1)

Trigger: `MFA_ENCRYPTION_KEY` or `MFA_ENCRYPTION_KEY_PREVIOUS` exposed; or the host is compromised and the key file was readable.

The attacker with the key and a database read has every user's TOTP secret and can generate valid codes. Rotation alone is insufficient: the plaintext secrets are already known, and re-encrypting them under a new key changes nothing about what the attacker knows.

```
# 1. Rotate the key so that future writes use a new key (lazy re-encryption, §12.4):
#    install new key as CURRENT, old as PREVIOUS.
# 2. Delete every enrolled secret rather than re-encrypting it. The attacker has the plaintext;
#    ciphertext under a new key is not a mitigation.
DELETE FROM iam.mfa_recovery_code;
UPDATE iam.app_user
   SET totp_secret_ct = NULL, totp_enrolled_at = NULL, last_totp_counter = NULL
 WHERE totp_secret_ct IS NOT NULL;

# 3. Revoke all sessions: a session that passed MFA before the compromise is not trustworthy.
UPDATE iam.auth_session SET revoked_at = now(), revoked_reason = 'INCIDENT_MFA_KEY'
 WHERE revoked_at IS NULL;

# 4. Verify: no user has a secret, and every ADMIN is blocked from privileged routes until re-enrolment.
SELECT count(*) FROM iam.app_user WHERE totp_secret_ct IS NOT NULL;      -- expect 0
```

Every user re-enrols at next login. For `ADMIN`, `mfa_required = true` with `totp_enrolled_at is null` means the login flow issues an enrolment challenge and privileged routes stay closed until it completes (§6.5). Non-admin users may complete enrolment at their convenience; the risk of them not having MFA is unchanged by the incident, because they did not have it enforced before either.

The old key stays in `MFA_ENCRYPTION_KEY_PREVIOUS` only long enough to confirm that no row still decrypts under it — in practice, zero rows, because step 2 deleted them. Retain it for 24 hours offline and then destroy it.

#### P3 — Application database credential or data exfiltration (S1)

Trigger: `app_rw` password exposed; an unexplained volume of `SELECT`s; a monitoring alert on `http_response_size` or on scanner run counts; a credible report that market data is being redistributed.

```
# 1. Rotate the credential. The application reads it at boot; roll both API instances.
ALTER ROLE app_rw WITH PASSWORD :'new_password';

# 2. Preserve evidence before cleaning anything. Copy the relevant audit partitions and the
#    proxy access log off-host. Do this first; the next steps overwrite nothing but time passes.
pg_dump -Fc -t 'audit.audit_event*' -t 'audit.security_event*' > /evidence/audit-$(date +%F).dump

# 3. Identify the principal and the session family from audit.security_event, then revoke narrowly:
UPDATE iam.auth_session SET revoked_at = now(), revoked_reason = 'INCIDENT_EXFIL'
 WHERE user_id = :'user_id' AND revoked_at IS NULL;
#    If the credential is shared (an API key), revoke the key and every session that used it:
UPDATE iam.api_key SET revoked_at = now() WHERE id = :'key_id';

# 4. If the source cannot be narrowed to one principal, treat it as P1 and run P1 steps 2–3.
```

The uncomfortable step is 2, because it competes with step 1 for urgency. Rotating first is correct for *containment*; preserving first is correct for *attribution and scope*. The resolution: rotate the credential first if it is still usable by the attacker (a live password), preserve first if the activity is historical (an already-completed bulk read). The on-call makes this call explicitly and records it in the incident log.

#### P4 — User account compromise (S2)

Trigger: a user reports phishing or a lost device; or `LOGIN_FAILURE` followed by `LOGIN_SUCCESS` from an unusual network; or a support ticket from a colleague reporting odd activity.

```
# 1. Revoke every session for the user (not just the current one).
UPDATE iam.auth_session SET revoked_at = now(), revoked_reason = 'INCIDENT_ACCOUNT'
 WHERE user_id = :'uid' AND revoked_at IS NULL;

# 2. Force a password reset at next login, and invalidate any password reset token in flight.
UPDATE iam.app_user
   SET must_change_password = true, failed_login_count = 0,
       locked_until = NULL, token_invalid_before = now()
 WHERE id = :'uid';
DELETE FROM iam.one_time_token
 WHERE user_id = :'uid' AND purpose = 'PASSWORD_RESET' AND consumed_at IS NULL;

# 3. If the account had MFA, reset it: the attacker may have enrolled their own factor.
UPDATE iam.app_user SET totp_secret_ct = NULL, totp_enrolled_at = NULL, last_totp_counter = NULL
 WHERE id = :'uid';
DELETE FROM iam.mfa_recovery_code WHERE user_id = :'uid';

# 4. Verify the user can log in with a new password, and that no session survives.
SELECT count(*) FROM iam.auth_session WHERE user_id = :'uid' AND revoked_at IS NULL;  -- expect 0
```

Step 3 is easy to skip and important. If an attacker had access to a session, they may have used the authenticated surface to enrol a factor of their own; leaving it in place means the password reset does not lock them out. Reset MFA whenever the compromise involved a period of authenticated access, not merely a leaked password.

There is no forced password *rotation* as routine policy (§4.3), but there is a forced reset after compromise. The distinction matters: routine rotation produces incremental passwords and trains users to defeat the policy, while a post-compromise reset is a single event with a clear reason.

#### P5 — Audit chain break (S1)

Trigger: the nightly verification job reports a break; or `audit.chain_hash()` verification of a partition fails on demand.

A break means either corruption or deliberate modification. Both are S1, because the audit trail is the evidence base for every other investigation.

```
# 1. Freeze writes to the audit trail's writers before investigating, so the evidence set stops changing.
#    Revoke INSERT from the application roles; the application will fail closed on audited actions.
REVOKE INSERT ON audit.audit_event FROM app_rw;

# 2. Identify the first broken row: the smallest id for which recomputation disagrees.
#    (scripts/verify-audit-chain.ts implements §14.3 and prints id, occurred_at, expected, actual.)
pnpm --filter @tradesoft/ops verify-audit-chain --from 2026-01-01 --to 2026-11-03

# 3. Compare against the off-host archive anchor (§14.4). The anchor is the authoritative
#    last-known-good hash; anything after it is suspect.
# 4. Snapshot the partition set before any repair.
pg_dump -Fc -t 'audit.audit_event*' > /evidence/audit-broken-$(date +%F).dump
```

**Repair is not automatic and is not a code path.** There is no "recompute the chain" command in the application, deliberately: such a command would be the perfect tool for an attacker who has already modified rows. Recovery is: restore the affected partitions from the most recent verified backup, re-apply legitimate audit rows from the application log if any are missing, and record the entire episode as a manual note in the restored trail. Accepting a permanent, documented discontinuity is better than manufacturing a continuous chain over tampered data.

The freeze in step 1 is not free: every audited action fails while it is in place, which means logins and administrative changes stop working. That cost is the point — an audit trail that can be silently bypassed is not a control.

### 18.3 Forensic capability, and its honest limits

What the system can reconstruct after the fact, in order of reliability:

| Source | Retention | What it answers | Limits |
|---|---|---|---|
| `audit.audit_event` | 7 years, partitioned, hash-chained | Who changed what, when, before and after | Excludes `metadata` from the chain (SEC-D-08); superuser edits are detectable but not preventable (AR-09) |
| `audit.security_event` | 2 years | Authentication and authorization events, IPs, user agents | Not chained; deletable by a superuser without detection |
| Application logs (pino) | 30 days on disk, shipped off-host | Request-level detail, correlation IDs, errors | Redacted by design (§13.4), so the most useful fields for forensics are the ones removed |
| Proxy access logs | 90 days | Request line, status, bytes, timing, source IP | No bodies, no headers beyond a small set |
| PostgreSQL WAL | 14 days of base backups + WAL archive | Point-in-time recovery | Not queryable without restoring a cluster |
| `pg_stat_statements` | Reset on restart | Which queries ran and how often | Aggregated, not per-session |

The gap that matters: **there is no packet capture and no endpoint telemetry.** The system can say that user X read 4,000 scanner results between 14:02 and 14:07; it cannot say what the client did with them. That is an accepted limit of a single-VPS deployment (AR-09) and the reason P3's step 2 preserves what little there is before anything else happens.

### 18.4 After an incident

Two artefacts are mandatory, and neither is optional for S1/S2:

1. **A timeline** in the incident log: detection time, acknowledgement, each action with its timestamp and actor, containment, recovery, and the moment the system returned to normal. Written during the incident, not after, because memory reconstructs a flattering story.
2. **A blameless post-incident review within 5 business days**, answering three questions only: what control should have prevented this and why did it not, what would have detected it sooner, and what changed in this document or in the code as a result. Every action item gets an owner and a date.

A review that produces no change to this document, to a test, or to a runbook has not happened. The specific commitment: if an incident reveals a control gap that is not already in §19.1 or §19.2, the gap is either fixed before the next release or added to §19.2 with a justification. Silence is the one outcome that is not allowed.

## 19. Deferred controls and accepted residual risks

Two different things are recorded here, and conflating them is how security documents lie.

A **deferred control** (DEF-nn) is something we know how to build, have decided not to build yet, and will build when a stated condition occurs. It is a scheduling decision with a trigger.

An **accepted residual risk** (AR-nn) is exposure that remains *after* the design, that we have no concrete plan to remove, and that the system's owner is being asked to accept knowingly. It is a judgement, not a schedule.

Every deferral has a trigger that is observable — a user count, a requirement, a deployment change — not a date. "Q3" is not a trigger; "a second organisation needs access" is.

### 19.1 Deferred controls

| ID | Control | Why deferred now | Trigger to implement | Cost when implemented |
|---|---|---|---|---|
| **DEF-01** | WebAuthn / passkeys as a second factor | Requires a registration-flow design, a relying-party-ID decision, and a recovery path; the dominant risk in a 50-user staff tool is a reused password, which TOTP already covers | Any of: a phished session is confirmed in an incident; the user count exceeds 200; a customer contract requires phishing-resistant MFA | ~10 working days plus a recovery flow; replaces TOTP rather than adding to it |
| **DEF-02** | Breached-password checking (HIBP k-anonymity) | It is an outbound HTTP call, and §10.6 states there is none; introducing one adds an SSRF surface and a dependency on a third party for a login-path decision | Any of: a credential-stuffing incident succeeds; the system becomes internet-facing to non-staff users | ~3 days including a fail-open policy when HIBP is unreachable |
| **DEF-03** | Mandatory MFA for all users, not only `ADMIN` | Enrolment friction for `VIEWER`/`ANALYST` accounts whose blast radius is read-only market data | Any of: a non-admin account is compromised; the platform exposes data that is not already public | Zero code (flip `mfa_required` policy), plus a support burden for enrolment |
| **DEF-04** | HSTS `preload` | Effectively irreversible on a browser-release timescale; the subdomain inventory of the deploying organisation is unknown at design time | A decision that this hostname is permanent and that every current and future subdomain serves HTTPS | Submission plus a multi-month wait; no code |
| **DEF-05** | SSRF-hardened outbound HTTP for exchange adapters | v1 ingests files; no adapter fetches a URL (`03` §2.1). A fetch adapter would need an egress allowlist, redirect bans, and private-range blocking | A bhavcopy-from-URL adapter is requested | ~5 days, and it must ship with the adapter, never after it |
| **DEF-06** | Step-up re-authentication for destructive operations | v1 relies on `ADMIN` + MFA at login + the 20–1,000 character justification on corrections (`05` §12.13) | A destructive action is performed by a compromised-but-authenticated session, or a regulator requires it | ~4 days; adds a second MFA challenge and a short-lived elevation claim |
| **DEF-07** | CSP violation reporting (`report-to`) | Requires an endpoint that accepts unauthenticated reports, which is a new abuse surface and a new storage table | A CSP regression reaches production and is discovered by a user rather than a report | ~2 days plus a rate-limited ingest endpoint |
| **DEF-08** | Antivirus / malware scanning on uploads | Files are parsed, never executed, never rendered, never unzipped (AR-06); a scanner adds a signature-update dependency and a third-party binary | Any of: uploads become downloadable by other users; a format is accepted that can carry active content (PDF, Office) | ~3 days plus a licence or a ClamAV sidecar (~1 GB RAM) |
| **DEF-09** | JWKS endpoint and asymmetric key discovery | There is one resource server and it shares the keyring through configuration; a JWKS endpoint exists to let *other* services verify tokens | A second service needs to verify these tokens | ~2 days; the endpoint is public and must be cached aggressively |
| **DEF-10** | Per-request permission resolution instead of token-embedded `perms` | Costs a two-table join on every request for a value that changes monthly (§5.3, SEC-D-03) | Either the user population exceeds 500, or permission changes are observed to need sub-15-minute effect | ~2 days of code, plus a cache and a second invalidation problem |
| **DEF-11** | Database-level auditing (`pgaudit`) | Volume on this workload would be mostly `SELECT` noise, and the application audit trail already covers state changes (§17.6, AR-05) | A compliance requirement names database-native audit, or AR-03 is exploited | ~1 day to enable; storage growth of roughly 2–5 GB/month at `ddl,role` level |
| **DEF-12** | Multi-tenant isolation | There are no tenants; a second organisation is a second deployment (§2.3) | A single deployment must serve two organisations with separate data | This is a re-architecture, not a control: row-level security, a tenant discriminator on every table, and a rewrite of every query. Recorded as R-07 in `08`. |

The pattern across most of these: the control is cheap but the *supporting surface* is not. DEF-07 is two days of code and a new unauthenticated endpoint; DEF-02 is three days and a third-party dependency in the login path. That is why they are deferred, and it is why the trigger is a real event rather than a calendar entry — a calendar entry would arrive before the surface is justified.

### 19.2 Accepted residual risks

Each of these is stated with what would have to be true for it to matter, so that the acceptance can be revisited rather than merely repeated.

| ID | Risk | Why it is accepted | Compensating control | Residual impact if realised |
|---|---|---|---|---|
| **AR-01** | A volumetric L3/L4 flood takes the service offline | The application cannot mitigate traffic it never receives; only the hosting provider or a CDN can | Proxy connection limits, per-IP request limits on `public` and `auth.*` buckets, timeouts | Total unavailability for the duration. No confidentiality or integrity impact. This is an availability risk only, and availability is objective O6 — the lowest. |
| **AR-02** | A container escape yields host root, and therefore every secret and the database | Containers are packaging, not a security boundary; a single-host deployment has no second line of defence | Non-root uid, `cap_drop: ALL`, `no-new-privileges`, read-only rootfs, no Docker socket, digest-pinned base image, Trivy gate | Total compromise: signing key, MFA key, `app_rw`, all data. Recovery is P1 + P2 + restore. The only real mitigation is a second host, which contradicts the single-VPS decision (`00` ADR-011). |
| **AR-03** | An operator with database access changes data without an audit record | Every deployment has an operator with a `psql` prompt; denying it would make incident response impossible | `app_rw` cannot `UPDATE`/`DELETE` the audit tables; the hash chain detects *modification of audit rows*; the break-glass procedure requires a second person | Undetected data change. This is the highest-impact accepted risk after AR-09, and the reason P5 freezes writes rather than trusting the trail. |
| **AR-04** | A malicious or compromised npm dependency executes with application privileges | A dependency tree of this size cannot be fully audited; the alternative is writing everything from scratch | Frozen lockfile, no lifecycle scripts except an explicit two-entry allowlist, Trivy, `pnpm audit --prod`, SBOM per release, digest-pinned base image | The dependency can read the database, the signing key, and the MFA key, and can exfiltrate over the network. Equivalent to AR-02 in impact, with a different entry point. |
| **AR-05** | There is no database-native audit trail | `pgaudit` volume would be dominated by `SELECT`s, and the application trail answers the questions that matter (§14.1) | `log_statement = ddl`; the append-only trigger; the hash chain; `app_rw` has no `UPDATE`/`DELETE` on audit tables | A direct-SQL `SELECT` of market data is invisible. Confidentiality of market data is not a primary objective — the data is largely public — so the impact is bounded. |
| **AR-06** | No antivirus scanning on uploaded files | Files are parsed to rows and discarded; nothing is executed, rendered, or unzipped (§11.5) | Strict 200 MiB cap, magic-byte sniffing, parser fuzzing, storage outside the web root, no download-by-other-users route | The only exposure is a parser bug, which is the same exposure a scanner would not fix — a scanner cannot tell whether *our* parser mishandles a valid file. |
| **AR-07** | `api`, `worker`, `scheduler`, and PostgreSQL share one host with no isolation between them | A single-VPS deployment is a stated constraint (`00` ADR-011), and splitting hosts multiplies cost and operational surface by three | Containers run as non-root with dropped capabilities and read-only root filesystems; the database publishes no port; each process holds only the secrets it needs (`06` §12.1) | A compromise of any one process can read the others' environment if it can escape its container. This is AR-02 with a wider blast radius, and the two should be assessed together. |
| **AR-08** | Audit rows written before pseudonymisation retain `actor_ip` for 7 years | The audit trail must be immutable and durable; rewriting it on erasure would defeat its purpose and break the hash chain | Pseudonymisation replaces the display name and email on the `iam.app_user` row, not on historical audit rows; the trail is readable only by `ADMIN` (§14.6) | A former user's IP history remains available to administrators for up to 7 years. This is a data-protection exposure, not an access-control one. |
| **AR-09** | A superuser can rewrite the audit chain, including the archive anchor, if they also control the off-host storage | The anchor is only as trustworthy as its custodian, and the same operator administers both | Anchors are exported nightly, encrypted, to storage whose credentials are not on the application host; the anchor file is append-only | Undetectable tampering by a determined insider with full infrastructure access. No purely software control can address this; it requires a separate custodian or an external timestamping authority. |

Two of these deserve a sentence more than the table allows.

**AR-03 and AR-09 are the same risk at different levels.** AR-03 is "an operator changes a business row"; AR-09 is "an operator rewrites the evidence that they did". Both are accepted because the alternative — a deployment with no human database access — is not operable. The mitigation is procedural (two-person break-glass, off-host anchors) and the honest framing is that the audit trail protects against *application-level* and *account-level* misuse, not against infrastructure-level misuse.

**AR-01 and AR-07 are availability and isolation respectively, and both flow from ADR-011.** If the deployment ever moves to multiple hosts or behind a CDN, AR-01 shrinks and AR-07 changes shape; the risk register should be re-read at that point rather than carried forward by default.

### 19.3 The security slice of the production-readiness gate

The full gate lives in `07`; this is the subset that must be green before the system is described as production-ready *from a security standpoint*. Each line is binary — a partial tick is a fail.

| # | Condition | Evidence required |
|---|---|---|
| G-S1 | SEC-T-01 through SEC-T-17 pass on the release commit | CI run URL recorded in the release note |
| G-S2 | The manual matrix M-01…M-12 has been executed against staging on this release | Signed checklist, one line per scenario |
| G-S3 | No `HIGH` or `CRITICAL` finding open from Trivy, `pnpm audit --prod`, or the last penetration test | Scanner output attached; any exception carries a §19.2 pointer and an expiry |
| G-S4 | `JWT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, and the database passwords are **not** the development values, are ≥ 32 bytes of CSPRNG output, and are stored 0600 | `scripts/check-secrets.ts` output, plus a listing of file modes |
| G-S5 | Every route in the deployed instance declares a permission (the boot hook has not been bypassed by a plugin registered after it) | `/metrics` exposes `authz_unprotected_routes 0`; a boot log line confirms the hook ran |
| G-S6 | TLS is valid for the production hostname, HSTS is served with `max-age` ≥ 31,536,000, and the §9.3 header set is present | `curl -sI https://<host>/` output pasted into the release note |
| G-S7 | Audit chain verification passes over the full retained history, and an anchor for the last 24 h exists off-host | `verify-audit-chain` output plus the anchor's object key |
| G-S8 | The break-glass procedure has been rehearsed by two people within the last 90 days | Incident log entry naming both operators |
| G-S9 | Restore from backup has been rehearsed and the restored instance passes `/readyz` and one authenticated read | Restore drill record with duration |
| G-S10 | The residual-risk register (§19.2) has been read and accepted in writing by the system's owner | Written acceptance referencing the commit hash of this document |

G-S8 and G-S9 are the two that teams skip, and they are the two that determine whether an incident is a bad afternoon or a lost week. G-S10 is not bureaucracy: AR-02 and AR-09 are total-compromise risks that cannot be mitigated by code, and an owner who has not read them has not accepted them.

## 20. Security decision log

The decisions that shaped this document, recorded so that a future change is recognised as a *change* rather than a fix. The format matches `04` §13 and `05` §16: one row, one decision, one reason. Where a decision has an escape hatch, the trigger lives in §19.1.

| ID | Decision | Rationale |
|---|---|---|
| **SEC-D-01** | Single-tenant, staff-facing posture. No tenant identifier anywhere in the schema or the token. | There is one organisation. Multi-tenancy would add a discriminator to every table and a check to every query for a requirement that does not exist. A second organisation is a second deployment (DEF-12, R-07). |
| **SEC-D-02** | Ed25519 (EdDSA) access tokens with a one-element `algorithms` allowlist. | The `alg: none` and RS256→HS256 confusion attacks both require the verifier to accept more than one algorithm. Fixing the algorithm at one value eliminates the class rather than filtering it. |
| **SEC-D-03** | Permissions are resolved at login/refresh and embedded in the token; a revocation takes up to 15 minutes. | A two-table join on every request, including every chart poll and scanner run, for a value that changes monthly in a 50-user system. Account suspension is *not* subject to this delay — it revokes sessions, which is checked per request. Revisit trigger: DEF-10. |
| **SEC-D-04** | A 10-second refresh grace window, matched on client fingerprint, with a hard stop at 3 reuses per family per 24 h. | Rotation with no grace logs out users with two tabs; no rotation lets a stolen token live forever. The window is bounded in time and in client identity, and the counter catches the attacker who races a real client. |
| **SEC-D-05** | The `ver` claim is the claims-schema version, not a revocation epoch. Revocation is keyed on `sid`. | An epoch would invalidate every token on every logout, which is a 15-minute global logout. A `sid` allows surgical revocation with a 30-second propagation bound. |
| **SEC-D-06** | Argon2id with m=65,536 KiB, t=3, p=1, a 4-way verification semaphore, and a dummy-hash path for unknown emails. | ~50 ms per hash on the target host, which is slow enough to make offline cracking expensive and fast enough that a login burst does not exhaust memory. The semaphore bounds peak allocation at 256 MiB. |
| **SEC-D-07** | TOTP is the only second factor. No SMS, no WebAuthn in v1. | SMS is a security *reduction* (SIM swap, SS7) and adds a paid dependency. WebAuthn is better but needs a registration design, an RP-ID decision, and a recovery path (DEF-01). |
| **SEC-D-08** | `audit.audit_event.metadata` is outside the hash chain; `before` and `after` are inside it. | The chain must cover every field whose change is an event. Metadata is free-form context, sometimes large (`explain_plan`), and is protected by the append-only trigger and the privilege model instead. |
| **SEC-D-09** | Refresh tokens and API keys are hashed with SHA-256, not Argon2id. Passwords use Argon2id. | Both are ≥ 200 bits of uniform randomness: there is no dictionary to attack, so a slow KDF adds latency to every refresh for no security gain. The two cases are genuinely different, and treating them the same would be cargo-culting. |
| **SEC-D-10** | No CORS in production. The SPA is served from the same origin as the API. | Any CORS policy is a set of relaxations, and the safest one is the absence of the mechanism. Same-origin deployment is possible because there is one SPA and one API. |
| **SEC-D-11** | Scanner results are not classified as sensitive; there is no per-result authorization beyond instrument read access. | An analyst is *supposed* to query the whole market. The escalation a scanner provides is speed, bounded by rate limits and a statement timeout, not data access. Reclassifying this would be a policy change, not a bug fix. |
| **SEC-D-12** | The audit hash chain is ordered by `id desc`, not `occurred_at desc`. | `id` is a global identity column and therefore monotonic per insert; `occurred_at` comes from the application clock and can skew between containers. Ordering by a skewed timestamp would make verification fail intermittently for a reason unrelated to tampering. |
| **SEC-D-13** | MFA secrets use AES-256-GCM envelope encryption with `AAD = "mfa:" ‖ user_id`. | The AAD binds ciphertext to its row: moving a secret from one user's row to another's fails authentication at decrypt time. GCM gives integrity as well as confidentiality, which CTR alone does not. |
| **SEC-D-14** | No outbound HTTP from any process. Ingestion reads files from a directory. | Every SSRF finding in history starts with a feature that fetched a URL. Removing the capability removes the class. It costs a manual download step, which the operator was doing anyway. |
| **SEC-D-15** | On the rate-limiter store being unavailable, auth and write buckets fail closed (`503`); read buckets fail open. | A login flood during a database incident is the worst possible time to lose the limiter. A read outage caused by a limiter is a self-inflicted denial of service with no security benefit. |
| **SEC-D-16** | Uploads are not virus-scanned. | Files are parsed and discarded; nothing is executed, rendered, or extracted. A scanner cannot detect whether our parser mishandles a syntactically valid file, which is the actual risk (AR-06). |
| **SEC-D-17** | Session cookies use the `__Host-` prefix. | The prefix forces `Secure`, `Path=/`, and the absence of a `Domain` attribute at the browser level, which makes subdomain cookie injection impossible regardless of what the application sets. |
| **SEC-D-18** | Audit queries are capped at a 90-day window per request. | The trail is 7 years; a single request that streams it is an exfiltration primitive and a memory hazard. Ninety days covers every investigation that is not already an incident, and an incident has direct database access. |
| **SEC-D-19** | `disabled` and `locked` are separate account states. | A lockout is automatic and temporary; a disable is deliberate and indefinite. Collapsing them would mean a lockout either becomes permanent or a disable expires. |
| **SEC-D-20** | There is no impersonation, for any role, at any level. | The audit trail's value depends on `actor_user_id` meaning what it says. "Log in as user" makes the trail ambiguous precisely when it matters most, and support can reproduce issues with seeded data or a screen share. |

Three of these are the ones most likely to be argued with later, so the argument is restated: SEC-D-03 trades 15 minutes of stale permissions for a per-request join, and the asymmetry that makes it safe is that *suspension* is instant even though *grants* are not. SEC-D-04 is a deliberate weakening — two valid tokens for ten seconds — bounded by fingerprint and by a counter that converts repetition into revocation. SEC-D-11 is a policy position, and if the product ever sells scanner output to a third party, it becomes wrong overnight.

## 21. Traceability

This section exists so that a reviewer can check that the controls are attached to the requirements rather than invented alongside them, and so that a future change to an error code or an invariant can find the security surface that depends on it.

### 21.1 Business rules and invariants

| Source | Rule | Where enforced in this document |
|---|---|---|
| `01` BR-040 | A session is bound to a client fingerprint | §5.4, §5.5, SEC-D-04 |
| `01` BR-041 | Refresh-token reuse revokes the family | §5.5, SEC-T-08 |
| `01` BR-042 | Every administrative state change writes an `AuditEvent` in the same transaction | §14.5, SEC-T-07 |
| `01` BR-043 | A user cannot grant themselves a role | §7.3 (self-modification denial), §14.5 |
| `01` BR-044 | Deactivation revokes all sessions | §4.7, §18.2 P4 |
| `01` INV-15 | The audit trail is append-only | §14.2, §17.6 (`REVOKE UPDATE, DELETE`), §18.2 P5 |
| `01` INV-16 | A correction requires a justification and an audit row | `05` §12.13; §14.5 |
| `01` INV-19 | Market data is never mutated in place | §7.4 (no `PUT` on bars), `05` §11.6 |
| `04` INV-D1 | Derived bars have `import_batch_id IS NULL` | §7.4 (write-path ownership), SEC-T-07 (audited recompute) |

### 21.2 API error codes owned by this document

The codes below are defined in `05` §5.2.2 and are emitted by controls described here. This table is the contract: a control that emits a code not listed here, or a code listed here with no control, is a defect.

| Code | HTTP | Emitted by | Section |
|---|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Password verification, including the dummy-hash path | §4.6 |
| `AUTH_ACCOUNT_LOCKED` | 423 | Lockout after 10 failures | §4.6, SEC-D-19 |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | State check at login and at token verification | §4.1, §4.7 |
| `AUTH_MFA_REQUIRED` | 401 | Password reset for an MFA-enrolled user without a TOTP code | §4.5 |
| `AUTH_MFA_INVALID` | 401 | TOTP verification and replay guard | §6.4, SEC-T-10 |
| `AUTH_TOKEN_EXPIRED` | 401 | Access-token `exp` | §5.2 |
| `AUTH_TOKEN_INVALID` | 401 | Signature, `alg`, `kid`, `iss`, `aud`, `ver` | §5.2 |
| `AUTH_SESSION_REVOKED` | 401 | `sid` in the revocation set | §5.7, SEC-T-09 |
| `AUTH_REFRESH_REUSED` | 401 | Reuse outside the grace window | §5.5, BR-041 |
| `FORBIDDEN` | 403 | `perms` missing the route's permission | §7.1, §7.3 |
| `RATE_LIMITED` | 429 | Any bucket | §16.5, SEC-D-15 |
| `PAYLOAD_TOO_LARGE` | 413 | Upload cap | §11.1 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Magic-byte sniff mismatch | §11.1 |
| `PAGE_CURSOR_INVALID` | 400 | Cursor MAC or binding mismatch | `05` §6.3, SEC-T-11 |
| `VALIDATION_FAILED` | 422 | Schema, depth caps, field allowlists | §10.1, §10.8 |

### 21.3 What a reviewer should be able to verify

Three checks, in order of value:

1. **Every permission in `00` §4.1 appears in §7.1's pipeline description or in §14.5's audited-action list.** A permission with no enforcement point is a promise; a permission with no audit is a blind spot.
2. **Every `AR-nn` cited anywhere in this document appears in §19.2, and every `SEC-D-nn` cited appears in §20.** This is mechanical and should be a lint on the docs themselves.
3. **Every control claimed in §2.1's objective ordering has either a test in §17.2, a playbook in §18.2, or an entry in §19.2.** A control with none of the three is an assertion, and assertions are what this document was written to avoid.
