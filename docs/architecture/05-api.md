# TradeSoft — API Architecture

Status: specification, Phase 1. Nothing in this document is implemented yet.

This document is the contract between the SPA, the ingestion service, and the `api` process. It defines
transport, serialisation, error handling, collection semantics, and every endpoint that Phase 3 onward
will implement. It is deliberately more specific than an OpenAPI sketch: an endpoint that is not listed
here does not exist, and a field that is not specified here is not part of the contract.

Related documents:

- [`00-system-architecture.md`](00-system-architecture.md) — permissions, modules, ADR-001…ADR-020
- [`01-domain-model.md`](01-domain-model.md) — business rules `BR-*`, invariants `INV-*`
- [`02-database.md`](02-database.md) — tables, columns, constraints
- [`03-ingestion-and-jobs.md`](03-ingestion-and-jobs.md) — upload contract, rejection codes, job catalogue
- [`04-analytics-engines.md`](04-analytics-engines.md) — indicator, Renko, breadth, RS, scanner mathematics
- [`DIAGRAMS.md`](DIAGRAMS.md) — DIAGRAM 7 (auth), DIAGRAM 8 (scanner), DIAGRAM 9 (RS)

---

## 1. Purpose and non-goals

### 1.1 What this API is

A single REST surface over a single-tenant analytics platform. It serves four kinds of traffic:

| Traffic | Share of requests | Characteristics |
|---|---|---|
| Chart and dashboard reads | ~70 % | Small number of parameters, large responses, latency-sensitive |
| Reference-data reads | ~20 % | Highly cacheable, paginated, search-heavy |
| Writes (scanners, reference data, corrections) | ~8 % | Low volume, audited, strict validation |
| Machine ingestion | ~2 % | Bulk upload, asynchronous, idempotent |

### 1.2 What this API is not

- **Not public.** Users are trusted staff (assumption A10). There is no anonymous read surface beyond
  `GET /healthz`. There is no tenant resolution, no per-organisation scoping, and no API marketplace.
- **Not real-time in v1.** No WebSocket, no Server-Sent Events. Long-running work returns `202` and a
  resource to poll. DIAGRAM 12 shows where a push surface attaches later without changing any contract
  in this document.
- **Not a computation surface.** The API never computes an indicator, a brick, or an RS score during a
  request. It reads persisted results (ADR-008). The only read-time price transformation permitted is
  cumulative corporate-action adjustment, and it is called out explicitly in §12.2.1.
- **Not an ORM projection.** DTOs are hand-written Zod schemas in `packages/contracts`. A column rename
  in the database must not silently rename a JSON field, and vice versa.

### 1.3 Consumers

| Consumer | Auth mode | Uses |
|---|---|---|
| `apps/web` (SPA) | Access token + refresh cookie | Everything except ingestion submission |
| Ingestion service | API key (`X-Api-Key`) | `POST /ingestion/uploads`, `POST /ingestion/pulls`, `GET /ingestion/batches/*` |
| Operations tooling | Admin session | `/admin/*`, `/metrics` |
| Contract tests | Fixture tokens | Every route, asserted against `openapi.json` |

---

## 2. Contract rules

These rules are numbered because tests and code review cite them. A change to any rule is an ADR
amendment, not a pull-request detail.

| ID | Rule |
|---|---|
| **API-C1** | The only version segment is `/api/v1`. There is no `Accept-Version` header and no date-based versioning. |
| **API-C2** | JSON field names are `camelCase`. The one exception is the scanner condition DSL, whose `type` values and parameter names are part of a published contract (§12.7). |
| **API-C3** | Columns typed `numeric` or `bigint` are serialised as **decimal strings**. Columns typed `integer`, `smallint`, `boolean`, and enums are serialised as JSON primitives. No `numeric` value ever becomes a JSON number. |
| **API-C4** | Timestamps are RFC 3339 with a `Z` offset, millisecond precision: `2026-03-13T09:15:00.000Z`. Session dates are `YYYY-MM-DD`. No local-time strings are accepted or emitted. |
| **API-C5** | Single resources are returned bare. Collections are returned as `{ "data": [...], "page": {...} }`. There is no `{ "success": true, "result": ... }` wrapper. |
| **API-C6** | Request bodies are **strict**: unknown properties are rejected with `422 VALIDATION_FAILED`. Response bodies are **open**: clients must ignore properties they do not recognise, so additive changes never break a deployed SPA. |
| **API-C7** | Identity, role, permission, ownership, and audit identity are derived from the authenticated principal only. No endpoint accepts `userId`, `requestedBy`, `ownerUserId`, `role`, `permissions`, or `tenantId` in a request body. Those properties do not exist on any input schema. |
| **API-C8** | Every mutating endpoint declares exactly one required permission. A handler that checks permissions inline instead of via the route guard fails review. |
| **API-C9** | Arrays are never `null`. An empty collection is `[]`. A nullable scalar is `null`, never `""` and never `0`. |
| **API-C10** | Money, price, ratio, percentage, and score values are exact. A client that formats `"2987.4000"` for display may lose precision; a client that receives `2987.4` has already lost it. |
| **API-C11** | No endpoint returns an unbounded result set. Every list has a documented hard cap, enforced server-side, returning `422` rather than truncating silently. |
| **API-C12** | A request that changes durable state and can be retried by a client requires or accepts `Idempotency-Key` (§8). |
| **API-C13** | Enumerated values are `SCREAMING_SNAKE_CASE` and are validated against a closed set. An unknown enum value is a `422`, never a silent fallback. |
| **API-C14** | Errors are RFC 9457 `application/problem+json` with a stable `code` member. Clients branch on `code`, never on `title` or on the HTTP status alone. |

---

## 3. Transport, versioning, and deprecation

### 3.1 Base path and host

```
https://<host>/api/v1/...
```

`<host>` is terminated by the reverse proxy (ADR-015). TLS 1.2+ only, HSTS with `max-age=31536000;
includeSubDomains`. HTTP requests are redirected to HTTPS at the proxy, never inside the application.

Operational endpoints sit outside the version prefix, because they are consumed by infrastructure and
must not change when the API version changes:

| Path | Purpose |
|---|---|
| `GET /healthz` | Liveness |
| `GET /readyz` | Readiness |
| `GET /metrics` | Prometheus exposition |

The SPA is served from the same origin at `/`. There is no separate `api.` subdomain in v1, which means
the refresh cookie is first-party and CORS is not needed in production.

### 3.2 Methods

| Method | Semantics | Body | Idempotent by definition |
|---|---|---|---|
| `GET` | Read | none | yes |
| `POST` | Create, or invoke a named action | required | no |
| `PUT` | Full replacement of a mutable resource | required | yes |
| `PATCH` | Partial update | required | no |
| `DELETE` | Remove or deactivate | optional | yes |

`POST` is also used for actions that are genuinely not CRUD: `POST /scanners/{id}/runs`,
`POST /scanner-runs/{id}/cancel`, `POST /market-data/quality-issues/{id}/resolve`. The path names the
action as a sub-resource or a verb-final segment; no action is smuggled into a query parameter.

### 3.3 Status codes

| Code | Used for |
|---|---|
| `200` | Successful read, successful synchronous update, idempotent replay |
| `201` | Resource created synchronously, with `Location` |
| `202` | Work accepted and queued, with `Location` pointing at the status resource |
| `204` | Successful delete or logout, no body |
| `304` | Conditional read matched `If-None-Match` |
| `400` | Malformed request that is not a field-level validation failure (bad cursor, bad filter name) |
| `401` | Missing, expired, or invalid credentials |
| `403` | Authenticated but not permitted; also CSRF failure |
| `404` | Resource absent **or not visible to the caller** |
| `409` | State conflict (duplicate file, terminal batch, non-terminal run, snapshot stale) |
| `412` | `If-Match` did not match the current version |
| `413` | Body or file exceeds the documented limit |
| `415` | Unsupported `Content-Type` |
| `422` | Syntactically valid but semantically invalid; includes field-level `errors[]` |
| `423` | Account locked |
| `428` | `If-Match` required and absent |
| `429` | Rate limit exceeded, with `Retry-After` |
| `500` | Unhandled server fault |
| `503` | Dependency unavailable or the process is draining |
| `504` | A downstream statement (scanner SQL) exceeded its timeout |

`404` is used instead of `403` for resources the caller may not see, so that a private scanner's
existence is not disclosed by a status code. `403` is reserved for resources the caller can see but may
not modify.

### 3.4 Versioning and deprecation

Within `v1`:

- Adding a response property, a new endpoint, a new enum value in a **response**, or a new optional
  query parameter is non-breaking and ships without notice beyond the changelog.
- Adding a value to a **request** enum is breaking for clients that enumerate the set; the SPA reads
  `/meta` (§10.1) rather than hardcoding, so this is not a concern in practice, but third-party
  consumers must be told.
- Removing or renaming a property, changing a type, changing a status code, or tightening validation is
  breaking and requires `v2`.

A deprecated endpoint or property emits:

```
Deprecation: true
Sunset: Sat, 01 Aug 2026 00:00:00 GMT
Link: </api/v2/scanners>; rel="successor-version"
```

Deprecated routes continue to work for at least two release cycles before removal. There is no runtime
switch that disables `v1`; removal is a deliberate deploy.

### 3.5 Request limits

| Limit | Value | Enforcement |
|---|---|---|
| JSON body size | 1 MiB | Fastify `bodyLimit`, `413 PAYLOAD_TOO_LARGE` |
| Multipart file size | 200 MiB | Streamed to disk, `413` beyond |
| URL length | 8 KiB | Proxy and Fastify |
| Header size | 16 KiB | Proxy |
| JSON nesting depth | 8 | Zod refinement, `422 VALIDATION_FAILED` |
| Array length in a JSON body | 5,000 items | Zod `.max()`, per schema |
| Query string parameters | 30 | Fastify schema |
| Concurrent requests per connection | 100 | HTTP/1.1 keep-alive; HTTP/2 enabled at the proxy |

Multipart uploads never buffer the file in memory. The body stream is written to
`data/imports/{yyyy}/{mm}/{uuid}.csv` while SHA-256 is computed in the same pass (`03` §2.3).

### 3.6 Compression and content negotiation

- Responses larger than 1 KiB are compressed (`br` preferred, `gzip` fallback).
- `Accept: application/json` is the only accepted success type. A missing `Accept` is treated as
  `*/*`.
- `Content-Type: application/json` is required for JSON bodies, with optional `charset=utf-8`.
- `Content-Type: multipart/form-data` is required for uploads.
- Any other request content type → `415 UNSUPPORTED_MEDIA_TYPE`.
- CSV exports return `text/csv; charset=utf-8` with `Content-Disposition: attachment`.

### 3.7 Correlation and request identity

Every request carries a correlation identity:

1. If `X-Request-Id` is present and matches `^[A-Za-z0-9._:-]{8,64}$`, it is used.
2. Otherwise a UUIDv7 is generated.
3. The value is echoed in the `X-Request-Id` response header, attached to every log line, and copied
   into `problem.correlationId` on errors.

A malformed `X-Request-Id` is **never** a request failure. It is replaced and the substitution is logged
at `DEBUG`. Making observability metadata a validation concern turns a monitoring bug into an outage.

`X-Correlation-Id` is not accepted from clients. Correlation across a workflow (upload → batch → jobs)
is generated server-side and returned in the resource representation.

---

## 4. Serialisation

### 4.1 The decimal rule

`API-C3` is the single most important serialisation rule in the product, because it is the boundary at
which exact market data becomes floating point if anyone is careless.

| Database type | JSON type | Example | Rationale |
|---|---|---|---|
| `numeric(18,4)` price | string | `"2987.4000"` | Preserves the stored scale and the exact value |
| `numeric(18,6)` indicator | string | `"1.842000"` | A scanner threshold and a chart tooltip must agree |
| `numeric(9,4)` percentage | string | `"1.8420"` | Percentage points, not a fraction |
| `numeric(9,6)` percentile | string | `"0.912000"` | Fraction in `[0,1]` |
| `numeric(18,8)` ratio / slope | string | `"1.04321877"` | RS ratio and log-slope |
| `numeric(24,4)` turnover | string | `"184920331.5000"` | Exceeds 2^53 in rupee terms for index turnover |
| `bigint` volume, OI | string | `"12849302"` | A `bigint` has no lossless JSON number representation |
| `integer` count, rank | number | `493`, `44` | Bounded by `2^31`, exact in JSON |
| `boolean` | boolean | `true` | — |
| enum | string | `"COMPLETED"` | `API-C13` |

There is no exception for "small" numerics. `open: "0.0500"` is a string even though `0.05` would round-trip
in IEEE-754; a rule with exceptions is a rule that gets broken by the next developer.

The serialiser is implemented once, in `packages/contracts/serialisers/decimal.ts`, as a Zod transform
applied to a branded `DecimalString` type. A DTO that declares `z.number()` for a price column fails the
schema-drift test in §14.3, which compares DTO scalar kinds against `information_schema.columns`.

### 4.2 Identifiers

- All primary keys are UUIDv7, lowercase, hyphenated: `"018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70"`.
- UUIDv7 is time-ordered, so index locality matches insertion order without a sequence.
- Composite-key tables (`market_bar`, `renko_brick`, `breadth_snapshot`) have no surrogate id. Their
  endpoints address rows by their natural key, never by a fabricated identifier.
- Human-facing codes (`NSE`, `NIFTY50`, `1D`) are separate fields (`exchangeCode`, `symbol`, `code`) and
  are never used as primary keys in a URL when a UUID exists. The one exception is `GET /meta`, which is
  code-keyed because it is a catalogue, not a resource.

### 4.3 Timestamps and sessions

```
bucketStart: "2026-03-13T09:15:00.000Z"   // timestamptz, always UTC
sessionDate: "2026-03-13"                 // date, exchange-local trading day
expiresAt:   "2026-03-13T10:15:00.000Z"
```

`bucketStart` is UTC because it is an instant. `sessionDate` is separate because a 15-minute bucket at
`18:45Z` may belong to the next Indian session date at 00:15 IST, and a client that derives the session
date from the timestamp with `toLocaleDateString()` will be wrong twice a year at the boundary. The
server always sends both; clients never derive one from the other.

### 4.4 Nulls, omissions, and empty values

| Situation | Representation |
|---|---|
| Value not computed (warm-up) | `null` |
| Value not applicable (dividend on a non-dividend stock) | `null` |
| Relationship absent | `null` |
| Empty collection | `[]` |
| Property not requested (sparse response) | omitted |
| Property not permitted for this caller | omitted, never `null` |

A field is omitted only where §11 says it is conditional (`provenance`, `explainPlan`). Everywhere else
the property is present, even when `null`, so a client can destructure without guards.

### 4.5 Enumerations

Response enums are the database values, unchanged: `ACTIVE`, `COMPLETED`, `RECONCILIATION_FAILED`,
`UP`. The API does not map `IN_PROGRESS` to `PROCESSING` or prettify `4H` to `4 Hours`. Labels belong in
the SPA's i18n file, keyed by the enum value, so the server never carries presentation strings.

The one derived enum is `trend` on RS values (`UP`, `DOWN`, `FLAT`), which is computed by the engine and
stored, not by the API.

### 4.6 Field naming exceptions

Two deliberate exceptions to `camelCase`:

1. **Scanner condition DSL.** `{"type":"RSI_BELOW","period":14,"value":"40"}` uses the registry's
   names. The DSL is versioned (`scanner-conditions/v1`) and mirrored exactly in
   `packages/engines/src/scanner/registry.ts`, the database JSONB, and the UI builder. Camel-casing it
   would create a third spelling of every parameter.
2. **CSV exports.** Columns are `snake_case` and mirror the database (`bucket_start`, `delivery_pct`),
   because exports are consumed by pandas, Excel, and operators who read the DDL. JSON is for the SPA;
   CSV is for analysis.

---

## 5. Errors

### 5.1 Media type and shape

All errors are `application/problem+json`, per RFC 9457. Example:

```json
{
  "type": "urn:tradesoft:problem:v1:scanner-condition-invalid",
  "title": "Scanner condition is invalid",
  "status": 422,
  "detail": "Node /root/children/2/reference: \"AVG_30\" is not one of AVG_20, AVG_50, PREV.",
  "instance": "/api/v1/scanners/018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70/runs",
  "code": "SCANNER_CONDITION_INVALID",
  "correlationId": "018f2c4b-1d22-7b33-8c44-5d6e7f809a1b",
  "retryable": false,
  "errors": [
    {
      "path": "/root/children/2/reference",
      "code": "SCANNER_PARAM_INVALID",
      "message": "Expected one of AVG_20, AVG_50, PREV."
    }
  ]
}
```

| Member | Required | Meaning |
|---|---|---|
| `type` | yes | Stable URI. URN form avoids owning a domain for error documentation. |
| `title` | yes | Short, human-readable, stable per `code`. Not for programmatic branching. |
| `status` | yes | Duplicates the HTTP status, as RFC 9457 requires. |
| `detail` | yes | Specific to this occurrence. Never contains a stack trace, SQL, token, or email that the caller did not supply. |
| `instance` | yes | The request path, without the query string. |
| `code` | yes | Machine key from the catalogue in §5.2. **This is what clients branch on.** |
| `correlationId` | yes | Matches the `X-Request-Id` header and the server log line. |
| `retryable` | yes | Whether the identical request may succeed later without changing anything. |
| `errors` | no | Field-level failures, present on `422` and on batch validation problems. |

`errors[]` entries use JSON Pointer paths into the request body (`/root/children/2/value`), so the SPA
can attach an error to the exact form control. For query parameters the path is the parameter name with
a leading `/` (`/timeframe`).

### 5.2 Error catalogue

Every error the API can return is listed here. A new error code requires adding a row, not inventing a
string in a handler.

#### 5.2.1 Generic

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `VALIDATION_FAILED` | 422 | Schema or domain validation failed; `errors[]` present | Fix the request |
| `RESOURCE_NOT_FOUND` | 404 | No such resource, or not visible to this principal | Do not retry |
| `RESOURCE_CONFLICT` | 409 | Generic state conflict; `detail` names the constraint | Re-read, then retry |
| `PRECONDITION_FAILED` | 412 | `If-Match` did not match | Re-read, merge, retry |
| `PRECONDITION_REQUIRED` | 428 | Versioned resource updated without `If-Match` | Re-send with the current ETag |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Wrong `Content-Type` | Fix the header |
| `PAYLOAD_TOO_LARGE` | 413 | Body or file over the limit | Split or compress |
| `PAGE_CURSOR_INVALID` | 400 | Cursor is malformed, tampered, or belongs to another query | Restart from the first page |
| `FILTER_NOT_SUPPORTED` | 400 | Unknown or non-whitelisted filter name | Fix the query |
| `SORT_NOT_SUPPORTED` | 400 | Unknown or non-whitelisted sort key | Fix the query |
| `DATE_RANGE_INVALID` | 422 | `from > to`, or a non-trading date where one is required | Fix the range |
| `RANGE_TOO_LARGE` | 422 | Span exceeds the endpoint's documented maximum; `detail` names the cap | Narrow the range |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Endpoint requires the header and it was absent | Add the header |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different request fingerprint | Use a new key |
| `RATE_LIMITED` | 429 | Bucket exhausted; `Retry-After` present | Wait |
| `INTERNAL_ERROR` | 500 | Unhandled fault | Retry once, then report with `correlationId` |
| `SERVICE_UNAVAILABLE` | 503 | Dependency down or process draining | Retry with backoff |
| `REQUEST_TIMEOUT` | 504 | The request exceeded the server budget | Narrow the request |

#### 5.2.2 Authentication and authorisation

| Code | Status | Meaning |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Email or password wrong. Deliberately does not say which. |
| `AUTH_ACCOUNT_LOCKED` | 423 | Too many failures; `detail` states the unlock time |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Account suspended or deactivated |
| `AUTH_ACCOUNT_PENDING` | 403 | Email not yet verified |
| `AUTH_MFA_REQUIRED` | 401 | The operation needs a TOTP code that was not supplied: password reset for an MFA-enrolled user (`06` §4.5). Login never returns it; see §10.5 for the two `202` outcomes |
| `AUTH_MFA_INVALID` | 401 | Wrong or expired TOTP code |
| `AUTH_MFA_ALREADY_ENABLED` | 409 | Enrolment attempted twice |
| `AUTH_TOKEN_MISSING` | 401 | No `Authorization` header |
| `AUTH_TOKEN_INVALID` | 401 | Signature, issuer, audience, or format invalid |
| `AUTH_TOKEN_EXPIRED` | 401 | `exp` passed; client should refresh |
| `AUTH_SESSION_REVOKED` | 401 | Session or family revoked; client must re-authenticate |
| `AUTH_REFRESH_MISSING` | 401 | No refresh cookie |
| `AUTH_REFRESH_REUSED` | 401 | Rotated token replayed; family revoked (BR-041) |
| `AUTH_CSRF_INVALID` | 403 | Missing or mismatched `X-CSRF-Token` |
| `AUTH_PASSWORD_POLICY` | 422 | Password does not meet the policy; `errors[]` lists each failed rule |
| `AUTH_PASSWORD_REUSED` | 422 | Matches one of the last five passwords |
| `AUTH_EMAIL_TAKEN` | 409 | Email already registered |
| `AUTHZ_FORBIDDEN` | 403 | Authenticated but lacks the required permission |
| `AUTHZ_SCOPE_INSUFFICIENT` | 403 | API key lacks the scope for this route |
| `AUTHZ_SELF_ONLY` | 403 | Another user's session or credential was addressed |

#### 5.2.3 Reference data

| Code | Status | Meaning |
|---|---|---|
| `INSTRUMENT_NOT_FOUND` | 404 | No instrument with that id, or not visible |
| `INSTRUMENT_SYMBOL_TAKEN` | 409 | `(exchange, symbol, series)` already exists |
| `INSTRUMENT_NOT_TRADABLE` | 409 | Listing/delisting window excludes the requested date |
| `INSTRUMENT_HAS_HISTORY` | 409 | Delete refused; delist instead (BR-006) |
| `EXCHANGE_NOT_FOUND` | 404 | Unknown exchange |
| `CALENDAR_DAY_NOT_FOUND` | 404 | No calendar row for that exchange and date |
| `CALENDAR_DAY_NOT_EDITABLE` | 409 | Session is in the past and bars exist; corrections must go through a correction batch |
| `SECTOR_CYCLE` | 422 | The proposed parent would create a cycle (BR-003) |
| `SECTOR_NOT_FOUND` | 404 | Unknown sector |
| `MEMBERSHIP_OVERLAP` | 409 | Membership period overlaps an existing period (BR-004) |
| `MEMBERSHIP_NOT_FOUND` | 404 | No membership at that key |
| `MEMBERSHIP_WINDOW_INVALID` | 422 | `effectiveTo` before `effectiveFrom` |
| `GROUP_NOT_FOUND` | 404 | Unknown market group |
| `GROUP_CODE_TAKEN` | 409 | Group code already exists |
| `GROUP_DYNAMIC_RULE_INVALID` | 422 | The dynamic rule does not compile |
| `GROUP_IMMUTABLE_SYSTEM` | 403 | System group cannot be edited |
| `CORPORATE_ACTION_DUPLICATE` | 409 | `(instrument, actionType, exDate)` exists |
| `CORPORATE_ACTION_INVALID` | 422 | Ratio or cash amount missing for the action type |
| `ALIAS_WINDOW_OVERLAP` | 409 | Alias period overlaps an existing alias for the same symbol |

#### 5.2.4 Market data

| Code | Status | Meaning |
|---|---|---|
| `BAR_NOT_FOUND` | 404 | No bar at that key |
| `BAR_RANGE_TOO_LARGE` | 422 | Requested span exceeds the cap; `detail` gives both values |
| `BAR_INCLUDE_PROVENANCE_FORBIDDEN` | 403 | `includeProvenance=true` without `ingestion:read` |
| `TIMEFRAME_INVALID` | 422 | Not in `ref.timeframe` |
| `TIMEFRAME_NOT_CHARTABLE` | 422 | Reserved for future restrictions; currently unreachable because all ten are chartable |
| `ADJUSTMENT_INVALID` | 422 | Not `RAW` or `ADJUSTED` |
| `CORRECTION_CONFLICT` | 409 | Row conflicts with an existing bar at the same revision basis (L4 `CONFLICTING_VALUES`) |
| `CORRECTION_STALE_REVISION` | 409 | Incoming revision lower than stored (L4 `STALE_REVISION`) |
| `CORRECTION_NO_ROWS` | 422 | Every row in the correction was rejected |
| `CORRECTION_JUSTIFICATION_REQUIRED` | 422 | `marketdata:correct` requires a non-empty justification (BR-044) |
| `QUALITY_ISSUE_NOT_FOUND` | 404 | Unknown issue |
| `QUALITY_ISSUE_ALREADY_RESOLVED` | 409 | Issue already has `resolved_at` |
| `RECOMPUTE_SCOPE_INVALID` | 422 | Scope names a dataset that cannot be recomputed for that timeframe |

#### 5.2.5 Ingestion

| Code | Status | Meaning |
|---|---|---|
| `IMPORT_DUPLICATE_FILE` | 409 | `sha256` already ingested; `existingBatchId` is included |
| `IMPORT_FILE_INVALID` | 422 | L1 failure; `detail` carries the L1 code from `03` §3.1 |
| `IMPORT_BATCH_NOT_FOUND` | 404 | Unknown batch |
| `IMPORT_BATCH_STATE_INVALID` | 409 | Operation not legal from the current status (INV-07) |
| `IMPORT_SOURCE_NOT_FOUND` | 404 | Unknown data source |
| `IMPORT_SOURCE_INACTIVE` | 409 | Source is disabled |
| `IMPORT_SUPERSEDES_INVALID` | 422 | Superseded batch is not terminal, or belongs to another exchange |
| `IMPORT_EXCHANGE_UNRESOLVED` | 422 | Declared exchange code does not exist |
| `IMPORT_BATCH_TYPE_INVALID` | 422 | Unknown batch type |
| `IMPORT_REJECT_EXPORT_EMPTY` | 404 | No rejects to export |
| `INGESTION_CONCURRENCY_LIMIT` | 429 | Another upload from this principal is in flight |

#### 5.2.6 Analytics

| Code | Status | Meaning |
|---|---|---|
| `INDICATOR_UNKNOWN` | 422 | Code not in the indicator catalogue |
| `INDICATOR_PARAMS_INVALID` | 422 | Parameter outside the allowed set for that code |
| `INDICATOR_NOT_COMPUTED` | 404 | No values for that instrument/timeframe/code yet |
| `RENKO_SET_NOT_FOUND` | 404 | No brick set for that `(instrument, timeframe, brickPct, reversalBricks, priceSource)` |
| `RENKO_BRICK_PCT_INVALID` | 422 | Not one of `0.1, 0.15, 0.25, 0.5, 1, 2, 3, 5` |
| `RENKO_REVERSAL_INVALID` | 422 | `reversalBricks` outside `1..5` |
| `RENKO_PRICE_SOURCE_INVALID` | 422 | Not `CLOSE` or `HIGH_LOW` |
| `RENKO_RANGE_TOO_LARGE` | 422 | Brick count or span exceeds the cap |
| `BREADTH_NOT_COMPUTED` | 404 | No breadth rows for that `(group, timeframe, brickPct)` |
| `BREADTH_GROUP_INELIGIBLE` | 422 | Group is dynamic and resolves differently per date; breadth requires a static membership |
| `RS_NOT_COMPUTED` | 404 | No snapshot for that `(group, base, window, asOf)` |
| `RS_BASE_INVALID` | 422 | Base instrument is a member of the group, or is missing daily history |
| `RS_WINDOW_INVALID` | 422 | Not one of `21, 63, 126, 252` |
| `RS_GROUP_TOO_LARGE` | 422 | More than 5,000 members |
| `RS_PRICE_MODE_INVALID` | 422 | Not `ADJUSTED` or `RAW` |

#### 5.2.7 Scanner

| Code | Status | Meaning |
|---|---|---|
| `SCANNER_NOT_FOUND` | 404 | Unknown definition, or private and not owned |
| `SCANNER_CODE_TAKEN` | 409 | `code` already exists |
| `SCANNER_IMMUTABLE_SYSTEM` | 403 | System scanner edited in place; clone instead |
| `SCANNER_CONDITION_INVALID` | 422 | Unknown type, missing required parameter, or parameter outside its domain |
| `SCANNER_CONDITION_DEPTH_EXCEEDED` | 422 | Nesting deeper than 6 |
| `SCANNER_CONDITION_COUNT_EXCEEDED` | 422 | More than 25 nodes |
| `SCANNER_MTF_LIMIT_EXCEEDED` | 422 | More than one `MTF_ALIGN` |
| `SCANNER_TIMEFRAME_NOT_SCANNABLE` | 422 | `timeframe` outside `{15m, 60m, 75m, 1D, 1W, 1M}` |
| `SCANNER_UNIVERSE_EMPTY` | 422 | Universe resolved to zero instruments |
| `SCANNER_UNIVERSE_TOO_LARGE` | 422 | Explicit universe with more than 5,000 ids |
| `SCANNER_PARAM_INVALID` | 422 | Correct type, value outside the allowed set |
| `SCANNER_SNAPSHOT_STALE` | 409 | More than the configured fraction of the universe has a stale snapshot |
| `SCANNER_TIMEOUT` | 504 | Statement exceeded `scanner.statement_timeout_ms` |
| `SCANNER_RUN_NOT_FOUND` | 404 | Unknown run, or not visible |
| `SCANNER_RUN_NOT_TERMINAL` | 409 | Cancel or result read on a non-terminal run |
| `SCANNER_RUN_FAILED` | 409 | Results requested for a failed run; `run.error` is the cause |
| `SCANNER_RUN_CANCELLED` | 409 | Results requested for a cancelled run |
| `SCANNER_RUN_CONCURRENCY_LIMIT` | 429 | Per-user concurrent run limit reached |

#### 5.2.8 Charts, dashboard, admin

| Code | Status | Meaning |
|---|---|---|
| `CHART_ADJUSTMENT_CONFLICT` | 422 | `RAW` requested together with indicator overlays, which are adjusted-based |
| `CHART_OVERLAY_UNKNOWN` | 422 | Unknown indicator overlay code |
| `CHART_INSTRUMENT_NOT_PRICEABLE` | 422 | Instrument has no bar series (e.g. a synthetic composite not yet built) |
| `DASHBOARD_NOT_READY` | 409 | The requested `asOf` predates the first complete EOD run |
| `JOB_NOT_FOUND` | 404 | Unknown job |
| `JOB_STATE_INVALID` | 409 | Retry or cancel illegal from the current status |
| `JOB_SCHEDULE_NOT_FOUND` | 404 | Unknown schedule |
| `SETTING_NOT_FOUND` | 404 | Unknown setting key |
| `SETTING_READ_ONLY` | 409 | Boot-time or secret setting cannot be changed via the API |
| `SETTING_VALUE_INVALID` | 422 | Value fails the setting's schema |
| `AUDIT_RANGE_TOO_LARGE` | 422 | Audit query span exceeds 90 days |
| `AUDIT_CHAIN_BROKEN` | 409 | Hash-chain verification failed for the requested range; `detail` names the first bad id |
| `API_KEY_NOT_FOUND` | 404 | Unknown key |
| `API_KEY_SCOPE_INVALID` | 422 | Scope not in the catalogue, or exceeds the issuing principal's permissions |
| `USER_NOT_FOUND` | 404 | Unknown user |
| `ROLE_NOT_FOUND` | 404 | Unknown role |
| `ROLE_BUILTIN_IMMUTABLE` | 403 | Built-in roles cannot be deleted |

### 5.3 Error precedence

When several failures apply, the first matching rule wins. This matters because a client that receives
`AUTHZ_FORBIDDEN` for a malformed request learns something, and a client that receives
`VALIDATION_FAILED` for an unauthenticated request learns nothing useful.

1. Transport (`415`, `413`, malformed JSON → `400`).
2. Authentication (`401`).
3. Authorisation (`403`).
4. Resource existence and visibility (`404`).
5. Method and state (`409`, `412`, `428`).
6. Request semantics (`422`, field-level `errors[]`).
7. Rate limit (`429`). Evaluated **before** handler work but **after** authentication, so an
   unauthenticated flood does not consume a user's bucket.
8. Execution (`500`, `503`, `504`).

Rate limiting appears at position 7 even though it is enforced by a pre-handler hook. The ordering above
describes which error a client sees, not which code runs first: the hook is consulted after the
principal is resolved, and a request that is both rate-limited and invalid returns `429`, because
telling an attacker that their payload was malformed is a free oracle.

---

## 6. Collections

### 6.1 Envelope

```json
{
  "data": [ { "...": "..." } ],
  "page": {
    "limit": 50,
    "hasMore": true,
    "nextCursor": "eyJ2IjoxLCJxIjoiYTNmOWMyMWQiLCJrIjpbIk5JRlRZNTBc..." 
  }
}
```

- `page.nextCursor` is `null` when `hasMore` is `false`.
- `page.totalCount` is **absent** unless the endpoint documents it as cheap (scanner runs, import
  batches, rejects). A `count(*)` over `md.market_bar` is not cheap and is never exposed.
- `data` is always an array, even when empty.

### 6.2 Keyset pagination, not offset pagination

Offset pagination (`?page=7&perPage=50`) is rejected for three reasons that all bite this product:

1. **Drift.** A new import batch or a completed scanner run inserts rows at the top of the sort order,
   so page 2 repeats or skips rows that the user already saw.
2. **Cost.** `OFFSET 50000` makes PostgreSQL walk and discard 50,000 rows. On `audit.audit_event` with
   millions of rows, this is seconds per request.
3. **Ordering instability.** `ORDER BY created_at DESC` without a tiebreaker has no defined order among
   equal timestamps, which is exactly what a bulk import produces.

Every collection is therefore ordered by a **total order** that ends in a unique column, and the cursor
encodes the last row's sort key:

| Collection | Sort order (fixed or default) | Cursor key |
|---|---|---|
| Instruments | `symbol ASC, id ASC` | `[symbol, id]` |
| Bars | `bucket_start ASC` | `[bucketStart]` (unique per instrument+timeframe) |
| Import batches | `received_at DESC, id DESC` | `[receivedAt, id]` |
| Ingestion rejects | `row_number ASC` | `[rowNumber]` |
| Jobs | `created_at DESC, id DESC` | `[createdAt, id]` |
| Audit events | `occurred_at DESC, id DESC` | `[occurredAt, id]` |
| Security events | `occurred_at DESC, id DESC` | `[occurredAt, id]` |
| Scanners | `name ASC, id ASC` | `[name, id]` |
| Scanner runs | `created_at DESC, id DESC` | `[createdAt, id]` |
| Scanner results | `rank ASC` | `[rank]` |
| Quality issues | `detected_at DESC, id DESC` | `[detectedAt, id]` |
| Breadth series | `session_date ASC` | `[sessionDate]` |
| Renko bricks | `seq ASC` | `[seq]` |
| Indicator series | `bucket_start ASC` | `[bucketStart]` |

### 6.3 Cursor format

A cursor is an opaque, signed token:

```
cursor   = base64url(payloadJson) + "." + base64url(hmacSha256(payloadJson, CURSOR_SECRET))
payload  = {"v":1,"q":"<8 hex chars>","k":[<sort key values>]}
```

- `q` is the first 8 hex characters of SHA-256 over the endpoint template plus the canonicalised filter
  and sort parameters. A cursor presented to a different query is rejected with
  `400 PAGE_CURSOR_INVALID`, which prevents the subtle bug where a user changes a filter and page 2
  silently continues from the previous filter's position.
- The HMAC is truncated to 16 bytes. It prevents a client from synthesising a cursor that pushes an
  arbitrary key into the `WHERE` clause; without it, a hostile cursor is a limited SQL-injection surface
  even with parameter binding, because it can force pathological index scans.
- `CURSOR_SECRET` is a 32-byte random value from the environment, rotated only with a deploy that
  invalidates all in-flight cursors. That is acceptable: a cursor is a scroll position, not a bookmark.
- Cursors do not expire. They are bounded by the retention of the underlying rows.
- Cursors are not accepted on `GET` requests that also require `If-None-Match`; conditional requests
  apply to single resources and first pages only.

### 6.4 Limits

| Endpoint class | Default | Maximum |
|---|---|---|
| Reference lists (instruments, sectors, groups, scanners) | 50 | 200 |
| Import batches, scanner runs | 25 | 100 |
| Ingestion rejects | 100 | 500 |
| Jobs, audit, security events | 50 | 200 |
| Bars, indicator series | 500 | 5,000 |
| Chart bars | 750 | 5,000 |
| Renko bricks | 300 | 2,000 |
| Breadth series | 250 | 2,000 |
| Scanner results | 100 | 500 |

`limit` above the maximum returns `422 VALIDATION_FAILED` with an `errors[]` entry, not a silent clamp.
A silent clamp is worse than a rejection: a client that asks for 10,000 bars and receives 5,000 will
render a truncated chart and believe it.

### 6.5 Filtering

Filters are declared per endpoint in §11. The rules:

- An unknown filter name returns `400 FILTER_NOT_SUPPORTED`. It is never ignored, because a silently
  ignored filter produces a correct-looking but wrong result set.
- Filters combine with `AND`. There is no cross-field `OR` in query parameters; a screen that needs
  `OR` is a scanner.
- Multi-value filters use repeated parameters (`?status=COMPLETED&status=FAILED`) and are `OR`-ed
  within the field.
- `null` is not a filter value. A dedicated boolean (`?unresolvedOnly=true`) exists where a null check
  is meaningful.
- Free-text `q` uses trigram similarity for instruments and prefix matching for codes. `q` shorter than
  2 characters returns `422 VALIDATION_FAILED`.

### 6.6 Sorting

- `sort` takes a comma-separated list of `field` or `-field` (`sort=-updatedAt,name`).
- Only whitelisted fields are accepted; anything else is `400 SORT_NOT_SUPPORTED`.
- The implicit tiebreaker is always appended and is not client-controllable.
- `sort` on a collection whose fixed order is part of its meaning (bars, bricks, results) is rejected
  rather than ignored. Time series are ordered by time; a client that asks for bars sorted by volume is
  asking for a different endpoint.

---

## 7. Conditional requests and caching

### 7.1 ETags

| Resource | ETag source | Supports `If-None-Match` | Supports `If-Match` |
|---|---|---|---|
| Instrument | `updated_at` epoch ms | yes | yes |
| Sector, group | `updated_at` epoch ms | yes | yes |
| Scanner definition | `"v{version}"` | yes | **required** on `PUT`/`PATCH` |
| Saved view | `updated_at` epoch ms | yes | yes |
| System setting | value hash | yes | **required** on `PUT` |
| Bars series | `max(updated_at)` + row count | yes | no |
| Chart bundle | `max(updated_at)` of all components | yes | no |
| Auth responses | — | no | no |
| Problem responses | — | no | no |

`If-Match` on a versioned resource returns `428 PRECONDITION_REQUIRED` when absent. This is deliberate
for scanner definitions: two analysts editing the same screen must not silently overwrite each other.
For instruments and groups the requirement would be friction without benefit, because the edit surface
is a single form owned by one administrator.

### 7.2 Cache-Control

| Response | Header |
|---|---|
| Reference lists and single reference resources | `private, max-age=60, must-revalidate` |
| `/meta` | `private, max-age=300` |
| Bars, daily timeframe | `private, max-age=300` |
| Bars, intraday timeframe | `private, max-age=30` |
| Chart bundle | `private, max-age=30` |
| Breadth, RS matrix | `private, max-age=300` |
| Scanner results (terminal run) | `private, max-age=3600, immutable` |
| Scanner run status | `no-store` |
| Import batch status | `no-store` |
| Auth, sessions | `no-store` |
| Problems | `no-store` |

`immutable` on a terminal scanner run is correct because results are frozen (BR-031): the run pins the
definition version and inserts `scanner_run_result` once.

### 7.3 Compression and ETag interaction

The reverse proxy compresses responses and therefore weakens ETags (`W/"..."`). The application compares
ETags with the weak comparison function, so a `If-None-Match: W/"abc"` matches a stored `"abc"`. This is
the only correct behaviour behind a compressing proxy and is easy to get wrong.

---

## 8. Idempotency

### 8.1 Where it applies

`Idempotency-Key` is **required** on:

| Endpoint | Replay resource |
|---|---|
| `POST /ingestion/uploads` | The `import_batch` created from the file |
| `POST /ingestion/pulls` | The job enqueued for the pull |
| `POST /market-data/corrections` | The correction `import_batch` |
| `POST /scanners/{id}/runs` | The `scanner_run` |
| `POST /admin/recompute` | The recompute job |

It is **accepted but optional** on `POST /scanners` and `POST /saved-views`, where the natural key
(`code`, `(owner, kind, name)`) already prevents duplicates and returns `409` instead.

It is **not accepted** on `PUT`, `PATCH`, `DELETE`, or `GET`. A `PUT` is already idempotent; a `PATCH`
that needs replay protection is a design smell and should be modelled as a `PUT` on a sub-resource.

### 8.2 Semantics

- Header format: 1–128 characters, `^[A-Za-z0-9._:-]+$`. Anything else is `400 VALIDATION_FAILED`.
- Scope is `(principalId, method, routeTemplate)`. Two users may use the same key without collision.
- The server computes a request fingerprint:
  - JSON endpoints: SHA-256 of the canonical JSON body (sorted keys, no whitespace) plus the route
    parameters.
  - Upload endpoints: SHA-256 of the file plus the declared form fields (`sourceId`, `exchangeCode`,
    `batchType`, `timeframe`).
- Same key, same fingerprint → the original response is returned with `200` (or `202`), the original
  body, and `Idempotent-Replay: true`. The original status code is not replayed as `201`/`202`, because
  the client's job is to learn the result, not to re-create.
- Same key, different fingerprint → `422 IDEMPOTENCY_KEY_REUSED`.
- Same key while the first request is still in flight → `409 RESOURCE_CONFLICT` with
  `detail: "request with this Idempotency-Key is still processing"` and `Retry-After: 1`.

### 8.3 Storage

There is **no generic idempotency table**. Each of the five endpoints already has a durable row with a
partial unique index on `idempotency_key`:

- `md.import_batch` — `uq_import_batch_idem`
- `scan.scanner_run` — `uq_scanner_run_idem`
- `ops.job` — `uq_job_idempotency`

A separate table would duplicate the resource, require a two-phase write to keep them consistent, and
introduce the classic bug where the idempotency record commits but the resource does not. Reusing the
resource row means the uniqueness guarantee and the resource are the same transaction.

The fingerprint is stored in the resource's `error_summary`/`payload` metadata (batches) or `error`
(scanner runs) only when a replay conflict has occurred; otherwise the key alone is enough, because the
resource body is the fingerprint's evidence.

### 8.4 Interaction with duplicate-file detection

`POST /ingestion/uploads` has two independent guards:

1. `sha256` uniqueness in `md.import_file` → `409 IMPORT_DUPLICATE_FILE` with `existingBatchId`.
2. `Idempotency-Key` uniqueness in `md.import_batch`.

If a client retries with the same key and the same file, guard 2 wins and the response is a `200` replay,
not a `409`. If a client uploads the same file with a **new** key, guard 1 wins and the response is
`409 IMPORT_DUPLICATE_FILE`. Both behaviours are correct: the first is "my retry succeeded", the second
is "this file is already in the system, here is where".

---

## 9. Rate limiting

### 9.1 Buckets

| Bucket | Key | Limit | Window | Lockout behaviour |
|---|---|---|---|---|
| `auth.login` | `ip + sha256(email)` | 5 | 15 min | Escalates to account lock after 10 in 24 h |
| `auth.login.ip` | `ip` | 30 | 15 min | `429` |
| `auth.mfa` | `challengeId` | 5 | 10 min | Challenge invalidated |
| `auth.refresh` | `sessionFamilyId` | 60 | 60 min | `429` |
| `auth.reset` | `sha256(email)` | 3 | 60 min | Silent `202`, no email sent |
| `read` | `principalId` | 300 | 60 s (burst 60) | `429` |
| `export` | `principalId` | 10 | 60 min | `429` |
| `write` | `principalId` | 60 | 60 s | `429` |
| `scanner.run` | `principalId` | 10 | 60 s | `429` |
| `scanner.concurrent` | `principalId` | 2 concurrent runs | — | `429 SCANNER_RUN_CONCURRENCY_LIMIT` |
| `ingestion.upload` | `principalId` | 10 | 60 min | `429` |
| `ingestion.machine` | `apiKeyId` | 600 | 60 s | `429` |
| `public` | `ip` | 60 | 60 s | `429` (only `/healthz`) |

Buckets are per-process in memory with a Postgres-backed shared table for the auth buckets, per ADR-016.
The in-process path handles the common case in microseconds; the database path is consulted only on a
miss or when the process restarted, so a two-process deployment cannot double the effective login limit.

### 9.2 Headers

Every response carries:

```
RateLimit-Limit: 300
RateLimit-Remaining: 287
RateLimit-Reset: 42
RateLimit-Policy: 300;w=60
```

`RateLimit-Reset` is seconds until the window resets, not an epoch timestamp; clients consistently
misread epoch values here and the delta form is unambiguous.

A `429` response additionally carries `Retry-After` in seconds and the standard problem body with
`code: RATE_LIMITED` and `retryable: true`.

### 9.3 Failure mode

| Bucket class | Database unavailable |
|---|---|
| Auth | **Fail closed** — `503 SERVICE_UNAVAILABLE`. An authentication rate limiter that fails open is a credential-stuffing accelerator. |
| Read | **Fail open** — requests proceed, a `WARN` is logged and a counter incremented. A read flood is a capacity incident, not a security incident. |
| Write | Fail closed — `503`. |

This asymmetry is deliberate and is recorded as D-05-18.

### 9.4 What is not rate limited

- `GET /healthz` from the loopback interface (the proxy's health check).
- Requests authenticated with a key holding `settings:write` from the private operations network, up to a
  hard ceiling of 1,000 requests/second. Operations must not be locked out of their own platform during
  an incident.

---

## 10. Authentication and session surface

Full security design is in [`06-security.md`](06-security.md). This section defines only the wire
contract.

### 10.1 Token model

| Artifact | Lifetime | Storage | Sent as |
|---|---|---|---|
| Access token (JWT, EdDSA) | 15 min | SPA memory only | `Authorization: Bearer <jwt>` |
| Refresh token (opaque, 256-bit) | 30 days, sliding | `ts_rt` cookie, `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` | Cookie |
| CSRF token (opaque) | same as refresh | `ts_csrf` cookie, readable by JS | `X-CSRF-Token` header |
| API key (opaque, `tsk_` prefix) | 1 year, revocable | Caller's secret store | `X-Api-Key` |

Access-token claims:

```json
{
  "iss": "https://<host>",
  "aud": "tradesoft-api",
  "sub": "018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70",
  "sid": "018f2c4b-1d22-7b33-8c44-5d6e7f809a1b",
  "ver": 1,
  "roles": ["ANALYST"],
  "perms": ["marketdata:read", "analytics:read", "scanner:read"],
  "iat": 1773400000,
  "exp": 1773400900,
  "jti": "018f2c4c-..."
}
```

`perms` is the resolved permission set, so an authorisation check is a set lookup rather than a query.
It is safe because the token lives 15 minutes and session revocation is checked against `sid` on every
request (§10.3). A permission change therefore takes effect at the next refresh, at most 15 minutes
later, which is acceptable for staff tooling and is documented rather than hidden.

### 10.2 CSRF

`POST /auth/refresh` and `POST /auth/logout` require `X-CSRF-Token` equal to the `ts_csrf` cookie value.
`SameSite=Strict` already blocks cross-site sends in modern browsers; the double-submit check is defence
in depth against a browser that ignores it and against a same-site subdomain XSS.

All other mutating endpoints use `Authorization: Bearer`, which is not attached automatically by the
browser and is therefore not CSRF-vulnerable.

### 10.3 Revocation

- Each access token carries `sid`, the session id.
- The guard checks `sid` against an in-process LRU of revoked session ids, refreshed from
  `iam.auth_session` every 30 seconds, plus an immediate invalidation when this process performs the
  revocation.
- Logout revokes the session's entire family (BR-041).
- A password change revokes all families for that user except the one performing the change.

The 30-second window is a deliberate trade: a per-request database check would add a query to every
request for a condition that changes rarely, while a 30-second window is short enough that a terminated
employee cannot meaningfully use a stolen token.

### 10.4 API keys

- Header `X-Api-Key: tsk_<base32>`. The plaintext is shown once at creation and never retrievable.
- Stored as a SHA-256 hash in `iam.api_key.key_hash` with a `prefix` for identification in the UI.
- Scopes are a subset of the issuing principal's permissions, intersected with `INGEST_SERVICE`.
- An API key cannot call `/auth/*`, `/users/*`, `/roles/*`, `/admin/*`, or any `scanner:*` route.
- `AUTHZ_SCOPE_INSUFFICIENT` is returned when the route's permission is outside the key's scopes; the
  response does not enumerate the granted scopes.

### 10.5 Login sequence

```
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "analyst@example.com", "password": "..." }
```

| Outcome | Status | Body |
|---|---|---|
| Success, no MFA | `200` | `{ accessToken, tokenType, expiresIn, user }` + `Set-Cookie: ts_rt`, `Set-Cookie: ts_csrf` |
| Success, MFA enrolled | `202` | `{ challengeId, methods: ["TOTP"], expiresAt }` |
| `ADMIN` without MFA enrolment | `202` | `{ enrolmentRequired: true, challengeId, enrollUrl }`; no session, no cookie (`06` §6.5) |
| Bad credentials | `401` | `AUTH_INVALID_CREDENTIALS` |
| Locked | `423` | `AUTH_ACCOUNT_LOCKED`, `detail` states unlock time |
| Suspended | `403` | `AUTH_ACCOUNT_SUSPENDED` |
| Rate limited | `429` | `RATE_LIMITED` |

The invalid-credentials path performs an Argon2id verification against a dummy hash even when the email
does not exist, so response time does not disclose account existence. This is implemented in the auth
service, not in the handler, and is covered by a timing test with a tolerance of 15 ms.

### 10.6 MFA

`POST /auth/mfa/verify` accepts `{ challengeId, code }` and returns the same success shape as a
non-MFA login. A challenge is valid for 5 minutes, single-use, and bound to the `(ip, user-agent)` pair
that requested it. Five failures invalidate the challenge and emit `MFA_FAILURE`.

Enrolment is two steps so that a user cannot lock themselves out:

1. `POST /auth/mfa/enroll` → `{ secret, otpauthUri, recoveryCodes }` (recovery codes shown once).
2. `POST /auth/mfa/confirm` with a valid code → MFA becomes active.

MFA is mandatory for `ADMIN` and enforced at login: an admin without MFA is redirected to enrolment and
cannot obtain a token until enrolment completes. This is a policy check in the auth service, not a
permission.

---

## 11. Endpoint catalogue

Paths below omit the `/api/v1` prefix. Every endpoint requires authentication unless marked
**public**. `—` in the Permission column means "authenticated principal, no permission code"; the row
is then subject to resource-level ownership rules from `00` §4.3.

### 11.1 Operational (outside `/api/v1`)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | public | Liveness. Returns 200 if the process is running. Never touches the database. |
| `GET` | `/readyz` | public (loopback) | Readiness. Checks DB connectivity, schema version match, import volume writability, scheduler heartbeat age. |
| `GET` | `/metrics` | ops network / bearer ops token | Prometheus exposition. |

### 11.2 Meta and auth

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/meta` | — | Timeframes, brick sizes, RS windows, indicator catalogue, condition registry version, build info |
| `POST` | `/auth/login` | public | Password authentication |
| `POST` | `/auth/mfa/verify` | public (challenge) | Complete an MFA challenge |
| `POST` | `/auth/refresh` | refresh cookie + CSRF | Rotate refresh token, issue access token |
| `POST` | `/auth/logout` | refresh cookie + CSRF | Revoke the session family |
| `GET` | `/auth/me` | — | Principal, roles, permissions, MFA state, session info |
| `POST` | `/auth/password/change` | `auth:self:manage` | Change own password |
| `POST` | `/auth/password/forgot` | public | Request a reset link (always `202`) |
| `POST` | `/auth/password/reset` | public (token) | Consume a reset token |
| `POST` | `/auth/mfa/enroll` | `auth:self:manage`, or the login `challengeId` from the same client (`06` §6.5) | Begin TOTP enrolment |
| `POST` | `/auth/mfa/confirm` | `auth:self:manage`, or the login `challengeId` from the same client (`06` §6.5) | Activate TOTP; by challenge it also consumes the challenge and returns the session, like `/auth/mfa/verify` |
| `DELETE` | `/auth/mfa` | `auth:self:manage` | Disable TOTP (requires password + code) |
| `GET` | `/auth/sessions` | `auth:self:manage` | List own active sessions |
| `DELETE` | `/auth/sessions` | `auth:self:manage` | Revoke all own sessions except current |
| `DELETE` | `/auth/sessions/{sessionId}` | `auth:self:manage` | Revoke one own session |

### 11.3 Users, roles, permissions, API keys

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/users` | `user:read` | List users |
| `POST` | `/users` | `user:write` | Create a user (sends invitation) |
| `GET` | `/users/{id}` | `user:read` | Read a user |
| `PATCH` | `/users/{id}` | `user:write` | Update name, email, status |
| `POST` | `/users/{id}/deactivate` | `user:deactivate` | Deactivate; revokes sessions |
| `PUT` | `/users/{id}/roles` | `user:write` | Replace role assignments |
| `POST` | `/users/{id}/password-reset` | `user:write` | Trigger a reset email |
| `GET` | `/roles` | `role:read` | List roles with permission counts |
| `GET` | `/roles/{id}` | `role:read` | Read a role and its permissions |
| `PUT` | `/roles/{id}/permissions` | `role:write` | Replace a role's permission set |
| `GET` | `/permissions` | `role:read` | Full permission catalogue |
| `GET` | `/api-keys` | `apikey:manage` | List keys (prefix and metadata only) |
| `POST` | `/api-keys` | `apikey:manage` | Issue a key; plaintext returned once |
| `DELETE` | `/api-keys/{id}` | `apikey:manage` | Revoke a key |

### 11.4 Reference data

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/exchanges` | `exchange:read` | List exchanges |
| `GET` | `/exchanges/{id}` | `exchange:read` | Read an exchange |
| `POST` | `/exchanges` | `settings:write` | Create an exchange (platform configuration, like a data source); its default session is a label, sessions come from the calendar (A8) |
| `GET` | `/exchanges/{id}/calendar` | `exchange:read` | Calendar days in a range |
| `PUT` | `/exchanges/{id}/calendar/{sessionDate}` | `calendar:write` | Create or update a calendar day |
| `GET` | `/timeframes` | `exchange:read` | The `ref.timeframe` catalogue |
| `GET` | `/instruments` | `instrument:read` | Search and list instruments |
| `POST` | `/instruments` | `instrument:write` | Create an instrument |
| `GET` | `/instruments/{id}` | `instrument:read` | Read an instrument |
| `PATCH` | `/instruments/{id}` | `instrument:write` | Update an instrument |
| `GET` | `/instruments/{id}/aliases` | `instrument:read` | Symbol aliases |
| `POST` | `/instruments/{id}/aliases` | `instrument:write` | Add a symbol alias |
| `DELETE` | `/instruments/{id}/aliases/{aliasId}` | `instrument:write` | Remove an alias |
| `GET` | `/instruments/{id}/sector-memberships` | `sector:read` | Sector membership history |
| `POST` | `/instruments/{id}/sector-memberships` | `sector:write` | Add a membership period |
| `POST` | `/instruments/{id}/sector-memberships/{sectorId}/close` | `sector:write` | Close a membership period |
| `GET` | `/instruments/{id}/members` | `instrument:read` | Constituents of an index as of a date |
| `POST` | `/instruments/{id}/members` | `instrument:write` | Add a constituent |
| `POST` | `/instruments/{id}/members/{memberId}/close` | `instrument:write` | Close a constituent period |
| `GET` | `/sectors` | `sector:read` | Sector tree |
| `POST` | `/sectors` | `sector:write` | Create a sector |
| `PATCH` | `/sectors/{id}` | `sector:write` | Update or re-parent a sector |
| `GET` | `/groups` | `group:read` | List market groups |
| `POST` | `/groups` | `group:write` | Create a group |
| `GET` | `/groups/{id}` | `group:read` | Read a group |
| `PATCH` | `/groups/{id}` | `group:write` | Update a group, including `isShared` |
| `DELETE` | `/groups/{id}` | `group:write` | Delete a user-owned group |
| `GET` | `/groups/{id}/members` | `group:read` | Members as of a date |
| `POST` | `/groups/{id}/members` | `group:write` | Add members (bulk, max 5,000) |
| `POST` | `/groups/{id}/members/remove` | `group:write` | Remove members (bulk) |
| `POST` | `/groups/{id}/resolve` | `group:read` | Preview a dynamic rule's resolved membership |
| `GET` | `/corporate-actions` | `instrument:read` | List corporate actions |
| `POST` | `/corporate-actions` | `instrument:write` | Record a corporate action |
| `DELETE` | `/corporate-actions/{id}` | `instrument:write` | Delete a mistaken action |

### 11.5 Market data

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/market-data/bars` | `marketdata:read` | Bar series for one instrument and timeframe |
| `GET` | `/market-data/bars/latest` | `marketdata:read` | Latest bar for one instrument and timeframe |
| `GET` | `/market-data/bars/revisions` | `marketdata:read` | Superseded revisions from `market_bar_history` |
| `GET` | `/market-data/snapshots` | `marketdata:read` | Bulk latest daily snapshot, up to 200 instruments |
| `GET` | `/instruments/{id}/statistics/52w` | `marketdata:read` | 52-week statistics series |
| `GET` | `/market-data/quality-issues` | `dataquality:read` | Data-quality findings |
| `POST` | `/market-data/quality-issues/{id}/resolve` | `dataquality:write` | Resolve or waive a finding |
| `POST` | `/market-data/corrections` | `marketdata:correct` | Submit a correction batch |

### 11.6 Ingestion

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/ingestion/sources` | `ingestion:read` | Data sources |
| `POST` | `/ingestion/sources` | `settings:write` | Create a data source |
| `PATCH` | `/ingestion/sources/{id}` | `settings:write` | Update a data source |
| `POST` | `/ingestion/uploads` | `ingestion:submit` | Upload a CSV; returns a batch |
| `POST` | `/ingestion/pulls` | `ingestion:submit` | Trigger a vendor pull now |
| `GET` | `/ingestion/batches` | `ingestion:read` | List batches |
| `GET` | `/ingestion/batches/{id}` | `ingestion:read` | Batch status document |
| `GET` | `/ingestion/batches/{id}/rejects` | `ingestion:read` | Rejected rows, paginated |
| `GET` | `/ingestion/batches/{id}/rejects.csv` | `ingestion:read` | Rejected rows as CSV |
| `POST` | `/ingestion/batches/{id}/reconcile` | `ingestion:reconcile` | Re-run reconciliation after inspection |
| `POST` | `/ingestion/batches/{id}/reprocess` | `ingestion:retry` | Create a new batch from the same file |

`POST /ingestion/batches/{id}/reprocess` does **not** reopen the batch. It creates a new
`import_batch` with `supersedes_batch_id` pointing at the original, because terminal batch states are
immutable (INV-07) and in-place recovery would destroy the evidence of what failed.

### 11.7 Analytics

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/instruments/{id}/indicators` | `analytics:read` | Indicator series |
| `GET` | `/instruments/{id}/indicators/latest` | `analytics:read` | Current snapshot for one timeframe |
| `GET` | `/instruments/{id}/zigzag` | `analytics:read` | Fibonacci ZigZag pivots |
| `GET` | `/instruments/{id}/renko` | `analytics:read` | Renko bricks |
| `GET` | `/instruments/{id}/renko/sets` | `analytics:read` | Available brick sets |
| `GET` | `/breadth` | `breadth:read` | Breadth series for a group |
| `GET` | `/breadth/latest` | `breadth:read` | Latest breadth for several groups |
| `GET` | `/rs/matrix` | `rs:read` | Full RS matrix |

### 11.8 Scanners

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/scanners` | `scanner:read` | List visible scanners |
| `POST` | `/scanners` | `scanner:write` | Create a scanner |
| `GET` | `/scanners/{id}` | `scanner:read` | Read a scanner |
| `PUT` | `/scanners/{id}` | `scanner:write` | Replace a scanner (requires `If-Match`) |
| `DELETE` | `/scanners/{id}` | `scanner:write` | Delete an owned scanner |
| `POST` | `/scanners/{id}/clone` | `scanner:write` | Clone a system or shared scanner |
| `POST` | `/scanners/validate` | `scanner:write` | Validate a draft without saving |
| `GET` | `/scanner-conditions` | `scanner:read` | Condition registry for the builder UI |
| `POST` | `/scanners/{id}/runs` | `scanner:execute` | Run a scanner |
| `GET` | `/scanner-runs` | `scanner:read` | List runs visible to the caller |
| `GET` | `/scanner-runs/{id}` | `scanner:read` | Run status |
| `GET` | `/scanner-runs/{id}/results` | `scanner:read` | Matched results, paginated by rank |
| `GET` | `/scanner-runs/{id}/results.csv` | `scanner:read` | Matched results as CSV |
| `POST` | `/scanner-runs/{id}/cancel` | `scanner:execute` | Cancel a queued or running run |

### 11.9 Charts, dashboard, saved views

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/charts/{instrumentId}` | `chart:read` | Bundled chart payload |
| `GET` | `/dashboard` | `dashboard:read` | One-call dashboard aggregate |
| `GET` | `/dashboard/freshness` | `dashboard:read` | Data freshness per exchange and timeframe |
| `GET` | `/saved-views` | — | List own and shared saved views |
| `POST` | `/saved-views` | — | Create a saved view |
| `GET` | `/saved-views/{id}` | — | Read a saved view |
| `PUT` | `/saved-views/{id}` | — | Replace a saved view |
| `DELETE` | `/saved-views/{id}` | — | Delete a saved view |

Saved views deliberately have no permission code. They contain no market data, only a reference to a
surface and its parameters. Visibility is row-level: an owner sees and edits their own; a shared view is
readable by any authenticated principal; a view whose `kind` the caller cannot read is filtered out
rather than returned and then failing.

### 11.10 Administration

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/admin/jobs` | `job:read` | List jobs |
| `GET` | `/admin/jobs/{id}` | `job:read` | Job detail |
| `GET` | `/admin/jobs/{id}/attempts` | `job:read` | Attempt history |
| `POST` | `/admin/jobs/{id}/retry` | `job:retry` | Requeue a `FAILED` or `DEAD_LETTER` job |
| `POST` | `/admin/jobs/{id}/cancel` | `job:cancel` | Cancel a `QUEUED` job |
| `GET` | `/admin/job-schedules` | `job:read` | Cron schedules |
| `PATCH` | `/admin/job-schedules/{id}` | `settings:write` | Enable, disable, or change a cron expression |
| `POST` | `/admin/recompute` | `analytics:recompute` | Enqueue a scoped recompute |
| `GET` | `/admin/settings` | `settings:read` | Runtime settings |
| `PUT` | `/admin/settings/{key}` | `settings:write` | Update a setting |
| `GET` | `/admin/audit-events` | `audit:read` | Business audit trail |
| `GET` | `/admin/audit-events/verify` | `audit:read` | Verify the hash chain over a range |
| `GET` | `/admin/security-events` | `security:read` | Security event trail |
| `GET` | `/admin/data-quality/summary` | `dataquality:read` | Open findings grouped by code and severity |

Two permission codes were added to the catalogue during Phase 1 and are recorded in `00` §4.1 with their
role cells in §4.2: `dataquality:write` (resolve or waive a finding) and `analytics:recompute` (enqueue a
rebuild). Without them, resolving a finding would either reuse `marketdata:correct` — which grants price
mutation to anyone who only needs to acknowledge a warning — or be ungated.

---

## 12. Detailed specifications

These are the endpoints where a wrong detail becomes a wrong number on a chart. Everything else in §11
follows the conventions in §2–§9 without further elaboration.

### 12.1 `POST /auth/refresh`

Request: no body. Requires `ts_rt` cookie and `X-CSRF-Token`.

```
POST /api/v1/auth/refresh
Cookie: ts_rt=<opaque>; ts_csrf=<opaque>
X-CSRF-Token: <opaque>
```

| Outcome | Status |
|---|---|
| Rotated | `200 { accessToken, tokenType, expiresIn }` + new cookies |
| Already rotated (replay) | `401 AUTH_REFRESH_REUSED`, family revoked, `TOKEN_REUSE_DETECTED` security event |
| Missing cookie | `401 AUTH_REFRESH_MISSING` |
| CSRF mismatch | `403 AUTH_CSRF_INVALID` |
| Session revoked | `401 AUTH_SESSION_REVOKED` |

Rotation is a single transaction: `SELECT ... FOR UPDATE` on `auth_session` by token hash, mark the old
row `used_at`, insert the new row with the same `family_id`, return the new token. A concurrent second
request blocks on the row lock and then sees a used token, which is the reuse path. This is why the
`FOR UPDATE` is not an optimisation — it is the correctness mechanism that makes reuse detection
race-free.

### 12.2 `GET /market-data/bars`

The primary read of the platform. Every parameter is significant.

```
GET /api/v1/market-data/bars
  ?instrumentId=018f2c4a-...
  &timeframe=1D
  &from=2025-03-01
  &to=2026-03-13
  &adjustment=ADJUSTED
  &includePartial=false
  &includeProvenance=false
  &limit=500
  &cursor=<opaque>
```

| Parameter | Required | Default | Validation |
|---|---|---|---|
| `instrumentId` | yes | — | UUID; must exist and be visible |
| `timeframe` | yes | — | One of the ten `ref.timeframe` codes |
| `from` | no | `to − 1 year` | `YYYY-MM-DD`, inclusive |
| `to` | no | latest bar's session date | `YYYY-MM-DD`, inclusive; `from ≤ to` |
| `adjustment` | no | `ADJUSTED` | `RAW` or `ADJUSTED` |
| `includePartial` | no | `false` | Boolean; `true` includes higher-timeframe bars with `is_partial = true` |
| `includeProvenance` | no | `false` | Boolean; requires `ingestion:read` |
| `limit` | no | `500` | 1–5,000 |
| `cursor` | no | — | Signed cursor |

Response:

```json
{
  "instrument": { "id": "…", "symbol": "RELIANCE", "exchangeCode": "NSE", "timeframe": "1D" },
  "timeframe": "1D",
  "adjustment": "ADJUSTED",
  "bars": [
    {
      "bucketStart": "2026-03-12T00:00:00.000Z",
      "sessionDate": "2026-03-12",
      "open": "2941.0000",
      "high": "3004.5000",
      "low": "2935.1000",
      "close": "2987.4000",
      "volume": "12849302",
      "deliveryVolume": "7251200",
      "deliveryPct": "56.4300",
      "openInterest": null,
      "turnover": "38294810233.4000",
      "isPartial": false,
      "qualityStatus": "VALIDATED",
      "revision": 2
    }
  ],
  "page": { "limit": 500, "hasMore": false, "nextCursor": null },
  "meta": {
    "barCount": 250,
    "firstBarAt": "2025-03-03T00:00:00.000Z",
    "lastBarAt": "2026-03-12T00:00:00.000Z",
    "warnings": [
      { "code": "GAP_IN_SERIES", "from": "2025-08-14", "to": "2025-08-16", "sessionsMissing": 2 }
    ],
    "computedAt": "2026-03-13T01:12:44.000Z"
  }
}
```

Rules:

- `bucketStart` for `1D` is **00:00:00Z** on the session date, not the session open. A daily bar
  represents a session, and anchoring it to 09:15 IST would make it look like a 15-minute bar and would
  shift by 5.5 hours in the browser's locale. Intraday buckets use the true instant of the bucket's
  session-anchored start (`04` §2.1).
- `warnings` surfaces gaps rather than interpolating. A chart with a missing session renders a gap; it
  must not render a straight line through it.
- If `adjustment=ADJUSTED` and no corporate action affects the range, the values equal the raw values and
  `meta` gains `"adjustmentApplied": false`. The client does not need to special-case it.
- `sessionDate` is returned even though it is derivable from `bucketStart` for daily bars, because it is
  not derivable for intraday bars near midnight and the client must never guess.
- An empty result is `200` with `bars: []` and `page.hasMore: false`, not `404`. A range with no bars is
  a valid answer to a valid question.
- Requesting a range longer than 20 years (daily) or 90 days (intraday) returns
  `422 BAR_RANGE_TOO_LARGE` with `detail: "intraday range is limited to 90 days; requested 412"`.

#### 12.2.1 Why `ADJUSTED` is the default

Every stored indicator, every Renko brick, and every RS score is computed from adjusted closes
(`04` §3, §5, §7.2). If the bar endpoint defaulted to `RAW`, a chart would draw an unadjusted price line
under an SMA-200 computed on adjusted prices, and both would look plausible while disagreeing by the
size of every split in the window. Defaulting to adjusted makes the default view internally consistent.
`RAW` remains available because an operator reconciling against an exchange file needs the printed
number.

The adjustment itself is applied at read time by multiplying each OHLC by the cumulative product of
`md.bar_adjustment_factor` rows with `session_date > bar.session_date`. This is the **only** read-time
price transformation in the API. It is a projection over stored factors, not an analytical computation:
the factors are precomputed by `marketdata.rebuild_adjustments`, and the result is deterministic and
identical to what the engines used. Because corporate actions are rare, the join touches a handful of
rows and the plan is a nested loop over an index on `(instrument_id, session_date)`.

### 12.3 `GET /charts/{instrumentId}`

One request per visible chart. The alternative — the SPA firing six requests for bars, three overlays,
Renko, statistics, and corporate actions — creates six partial-failure states and a chart that renders
in an inconsistent intermediate shape.

```
GET /api/v1/charts/018f2c4a-...
  ?timeframe=1D
  &from=2025-03-01
  &to=2026-03-13
  &indicators=SMA_20,SMA_50,SMA_200,RSI_14,BB_20_2
  &renkoBrickPct=1
  &renkoPriceSource=CLOSE
  &includeCorporateActions=true
  &adjustment=ADJUSTED
```

| Parameter | Required | Default | Validation |
|---|---|---|---|
| `timeframe` | yes | — | Any of the ten chart timeframes |
| `from`, `to` | no | last 250 bars | Max span: 60 days intraday, 20 years daily |
| `indicators` | no | empty | Comma list, max 8, each in the catalogue in §12.3.1 |
| `renkoBrickPct` | no | absent | One of `0.1, 0.15, 0.25, 0.5, 1, 2, 3, 5` |
| `renkoPriceSource` | no | `CLOSE` | `CLOSE` or `HIGH_LOW` |
| `renkoReversalBricks` | no | `2` | 1–5 |
| `includeCorporateActions` | no | `true` | Boolean |
| `adjustment` | no | `ADJUSTED` | `RAW` or `ADJUSTED`; `RAW` with `indicators` → `422 CHART_ADJUSTMENT_CONFLICT` |

Response (abridged):

```json
{
  "instrument": {
    "id": "018f2c4a-…", "symbol": "RELIANCE", "name": "Reliance Industries Ltd",
    "exchangeCode": "NSE", "instrumentType": "EQUITY", "assetClass": "EQUITY",
    "tickSize": "0.050000", "pricePrecision": 2
  },
  "timeframe": "1D",
  "adjustment": "ADJUSTED",
  "bars": [ { "bucketStart": "…", "open": "…", "high": "…", "low": "…", "close": "…", "volume": "…", "isPartial": false, "qualityStatus": "VALIDATED", "revision": 1 } ],
  "indicators": {
    "SMA_20":  [ { "bucketStart": "…", "value": "2854.120000" } ],
    "RSI_14":  [ { "bucketStart": "…", "value": null } ]
  },
  "renko": {
    "brickPct": "1.0000",
    "priceSource": "CLOSE",
    "reversalBricks": 2,
    "brickSizeAbs": "28.7400",
    "anchorPrice": "2874.0000",
    "revision": 3,
    "bricks": [
      { "seq": 1, "bucketStart": "…", "sessionDate": "2025-04-02", "open": "2874.0000", "high": "2902.7400", "low": "2874.0000", "close": "2902.7400", "direction": "UP", "isReversal": false }
    ],
    "truncated": false
  },
  "statistics52w": {
    "asOfDate": "2026-03-12", "high252": "3120.0000", "low252": "2410.5000",
    "close": "2987.4000", "pctFromHigh": "-4.2500", "pctFromLow": "23.9300", "sessionsUsed": 252
  },
  "snapshot": { "asOfBucket": "…", "rsi14": "58.410000", "adx14": "22.130000", "atr14": "41.200000", "pctFromHigh252": "-4.2500" },
  "corporateActions": [
    { "id": "…", "actionType": "DIVIDEND", "exDate": "2025-08-14", "cashAmount": "10.0000" }
  ],
  "meta": {
    "asOf": "2026-03-13T01:12:44.000Z",
    "barCount": 250,
    "renkoTruncated": false,
    "warnings": []
  }
}
```

Rules:

- Indicator series are **keyed by `bucketStart` and may contain `null`** for warm-up. They are not
  index-aligned with `bars`: a series that starts 200 bars later must not force the client to pad.
- `renko` is `null` when `renkoBrickPct` is absent, not an empty object.
- `renko.bricks` is limited to the last 2,000 bricks intersecting the range; `truncated` says whether
  older bricks exist. A chart that shows 4 years of a 0.1 % brick set cannot render 30,000 rectangles.
- `corporateActions` is only the actions whose `exDate` falls in the requested range.
- A bar with `qualityStatus = QUARANTINED` is **included** in the response with its status, so the UI can
  grey it out. It is not silently dropped: a chart with a hole where a bad print was quarantined is
  less honest than a chart that shows the bad print as excluded.
- If any component is missing (e.g. no 52-week stats because the instrument has 40 sessions of history),
  the component is `null` and `meta.warnings` gains `STATS_52W_UNAVAILABLE`. The chart still renders.

#### 12.3.1 Chart indicator catalogue

The eight overlays the SPA may request, each mapping to a stored `indicator_value` series and a
documented parameterisation from `04` §3.1:

| Code | Parameters | Warm-up | Renders as |
|---|---|---|---|
| `SMA_20` | period 20 | 20 | Line overlay |
| `SMA_50` | period 50 | 50 | Line overlay |
| `SMA_200` | period 200 | 200 | Line overlay |
| `EMA_20` | period 20 | 20 | Line overlay |
| `EMA_50` | period 50 | 50 | Line overlay |
| `BB_20_2` | period 20, 2σ | 20 | Three lines |
| `RSI_14` | period 14 | 15 | Separate pane, 0–100 |
| `ADX_14` | period 14 | 28 | Separate pane, 0–100 |

Requesting an overlay outside this list returns `422 CHART_OVERLAY_UNKNOWN`. The list is also returned
by `GET /meta`, so the SPA builds its overlay menu from the server rather than from a hardcoded array
that drifts from the engine.

### 12.4 `GET /instruments/{id}/renko`

```
GET /api/v1/instruments/018f2c4a-.../renko
  ?brickPct=1
  &sourceTimeframe=1D
  &priceSource=CLOSE
  &reversalBricks=2
  &from=2024-01-01
  &to=2026-03-13
  &limit=300
```

| Parameter | Required | Default | Validation |
|---|---|---|---|
| `brickPct` | **yes** | — | Exactly one of `0.1, 0.15, 0.25, 0.5, 1, 2, 3, 5` |
| `sourceTimeframe` | no | `1D` | `15m`, `60m`, `75m`, `1D` |
| `priceSource` | no | `CLOSE` | `CLOSE` or `HIGH_LOW` |
| `reversalBricks` | no | `2` | 1–5 |
| `from`, `to` | no | last 300 bricks | `from ≤ to` |
| `limit` | no | `300` | 1–2,000 |

`brickPct` is required because there is no sensible default: 1 % bricks on a ₹50 stock and 0.1 % bricks
on a ₹3,000 stock describe completely different phenomena, and a default would silently choose one.

Decimal comparison is exact, not floating point. `brickPct=1.0`, `1`, and `1.00` all resolve to the
stored `numeric(6,4)` value `1.0000`; `1.0001` is rejected.

Response:

```json
{
  "instrument": { "id": "…", "symbol": "RELIANCE" },
  "set": {
    "id": "…", "sourceTimeframe": "1D", "brickPct": "1.0000", "priceSource": "CLOSE",
    "reversalBricks": 2, "brickSizeAbs": "28.7400", "anchorPrice": "2874.0000",
    "anchorBucket": "2024-01-02T00:00:00.000Z", "revision": 3,
    "brickCount": 184, "lastBrickClose": "3120.4800", "lastBrickAt": "2026-03-12T00:00:00.000Z",
    "computedAt": "2026-03-13T01:14:02.000Z"
  },
  "bricks": [
    {
      "seq": 182, "bucketStart": "2026-03-10T00:00:00.000Z", "sessionDate": "2026-03-10",
      "open": "3062.0000", "high": "3091.7400", "low": "3062.0000", "close": "3091.7400",
      "direction": "UP", "isReversal": false
    }
  ],
  "page": { "limit": 300, "hasMore": false, "nextCursor": null },
  "truncated": false
}
```

- `seq` is the identity. Several bricks may share `bucketStart`; the client must render by `seq`, not by
  time. This is the defining property of a Renko chart and is the most common integration mistake.
- A 404 `RENKO_SET_NOT_FOUND` means no set exists for that exact parameter tuple. The client offers
  `POST /admin/recompute` only to principals holding `analytics:recompute`; ordinary analysts see a
  message that the set has not been built.
- `truncated` is `true` when bricks exist outside the requested window, so the UI can offer "load
  earlier" instead of implying the series started there.

### 12.5 `GET /breadth`

```
GET /api/v1/breadth
  ?groupId=018f2c4a-...
  &timeframe=1D
  &brickPct=1
  &from=2025-01-01
  &to=2026-03-13
  &limit=250
```

| Parameter | Required | Default | Validation |
|---|---|---|---|
| `groupId` | yes | — | Must exist; must not be dynamic |
| `timeframe` | no | `1D` | `15m`, `60m`, `75m`, `1D`, `1W`, `1M` |
| `brickPct` | no | `1` | One of the eight sizes |
| `from`, `to` | no | last 250 sessions | Max span 5 years |

Response:

```json
{
  "group": { "id": "…", "code": "NIFTY500", "name": "Nifty 500" },
  "timeframe": "1D",
  "brickPct": "1.0000",
  "points": [
    {
      "sessionDate": "2026-03-12",
      "totalMembers": 500, "eligibleMembers": 493,
      "positiveBricks": 271, "negativeBricks": 198, "unchangedBricks": 24,
      "positivePct": "54.9700", "sma5PositivePct": "51.3400"
    }
  ],
  "page": { "limit": 250, "hasMore": false, "nextCursor": null },
  "meta": { "computedAt": "2026-03-13T01:20:11.000Z", "isStale": false }
}
```

- `totalMembers − eligibleMembers` is the ineligible count. It is derived, not a stored column, so the
  two numbers cannot disagree.
- `unchangedBricks` is the residual, not a fourth count computed independently (`04` §6.3). The
  invariant `positive + negative + unchanged ≤ eligible` is a database check (INV-12).
- `isStale` is `true` when the newest point's `computed_at` is older than the most recent completed EOD
  batch. The dashboard uses it to badge the widget; the API never hides staleness.
- `422 BREADTH_GROUP_INELIGIBLE` for a dynamic group, because its membership changes per date and a
  breadth series over a moving universe is not comparable across sessions.

### 12.6 `GET /rs/matrix`

```
GET /api/v1/rs/matrix
  ?groupId=018f2c4a-...
  &baseInstrumentId=018f2c4b-...
  &windows=21,63,126,252
  &asOf=2026-03-13
  &priceMode=ADJUSTED
```

| Parameter | Required | Default | Validation |
|---|---|---|---|
| `groupId` | yes | — | Membership resolved as of `asOf` |
| `baseInstrumentId` | yes | — | Must not be a member of the group |
| `windows` | no | `21,63,126,252` | Subset of `{21,63,126,252}`, at least one |
| `asOf` | no | latest computed snapshot | Must be a trading day for the base's exchange |
| `priceMode` | no | `ADJUSTED` | `ADJUSTED` or `RAW` |

Response is the shape specified in `04` §7.9, extended with `sortWindow` and row ordering:

```json
{
  "group": { "id": "…", "code": "NIFTY500" },
  "base": { "id": "…", "symbol": "NIFTY50" },
  "asOfDate": "2026-03-13",
  "methodologyVersion": "ratio-of-returns/v1",
  "priceMode": "ADJUSTED",
  "memberCount": 500,
  "scoredCount": 493,
  "windows": [21, 63, 126, 252],
  "sortWindow": 63,
  "rows": [
    {
      "instrumentId": "…", "symbol": "RELIANCE", "name": "Reliance Industries Ltd",
      "sectorCode": "ENERGY",
      "close": "2987.4000",
      "scores":      { "21": "1.842000", "63": "5.744100", "126": "9.120000", "252": "11.902000" },
      "ranks":       { "21": 44, "63": 37, "126": 51, "252": 21 },
      "percentiles": { "21": "0.912000", "63": "0.927856", "126": "0.898374", "252": "0.959920" },
      "slopes":      { "21": "0.00120400", "63": "0.00081200", "126": null, "252": "0.00043000" },
      "trend": "UP",
      "isLeader": true, "isLaggard": false,
      "insufficientHistory": false
    }
  ],
  "meta": {
    "computedAt": "2026-03-13T01:22:31.000Z",
    "leaderCount": 50,
    "laggardCount": 50,
    "isStale": false,
    "missingWindows": []
  }
}
```

Rules:

- The matrix is **not paginated**. Percentiles and leader/laggard flags are computed over the entire
  scored set; paginating would show rank 44 on page 1 and rank 44 again on page 2 after a recompute, and
  a user comparing two pages would be comparing two different populations. The cap is 5,000 members,
  above which `422 RS_GROUP_TOO_LARGE` asks the user to narrow the group.
- `sortWindow` defaults to the second requested window when four are requested (63), because the
  one-month window is dominated by noise and the one-year window is dominated by trend; the quarterly
  window is the one most people mean. When a single window is requested, `sortWindow` is that window.
  Rows are ordered by `(ranks[sortWindow] ASC NULLS LAST, symbol ASC)`.
- `insufficientHistory` rows are included with `null` scores and `null` ranks, sorted last. They are part
  of `memberCount` and excluded from `scoredCount`. Hiding them would make "493 of 500" impossible to
  display.
- `missingWindows` lists requested windows for which no snapshot exists. The endpoint returns `200` with
  the windows it has rather than failing the whole matrix, because a partially computed matrix is still
  useful and the gap is explicit. If **no** requested window exists, the response is
  `404 RS_NOT_COMPUTED`.
- `trend` is the trend of the `sortWindow` RS line. Per-window trends are in `meta.rowTrends` when the
  request asks for them (`includeAllTrends=true`); the default keeps the payload small.

### 12.7 `GET /scanner-conditions`

Returns the registry the SPA uses to build the condition editor. Without it, the UI would hardcode the
37 condition types and drift from the compiler the first time a condition is added.

```json
{
  "schema": "scanner-conditions/v1",
  "registryVersion": "2026-02-01.3",
  "limits": { "maxDepth": 6, "maxNodes": 25, "maxMtfAlign": 1, "maxUniverseIds": 5000 },
  "timeframes": ["15m", "60m", "75m", "1D", "1W", "1M"],
  "groups": [
    { "key": "TREND", "label": "Trend" },
    { "key": "MOMENTUM", "label": "Momentum" },
    { "key": "VOLATILITY", "label": "Volatility" },
    { "key": "VOLUME", "label": "Volume" },
    { "key": "RELATIVE_STRENGTH", "label": "Relative strength" },
    { "key": "PRICE_ACTION", "label": "Price action" }
  ],
  "conditions": [
    {
      "type": "RSI_BELOW",
      "group": "MOMENTUM",
      "label": "RSI below",
      "params": [
        { "name": "value", "kind": "DECIMAL", "required": true, "min": "0", "max": "100", "scale": 4 }
      ],
      "fixedParams": { "period": 14 },
      "supportedTimeframes": ["15m", "60m", "75m", "1D", "1W", "1M"]
    },
    {
      "type": "VOLUME_SPIKE",
      "group": "VOLUME",
      "label": "Volume spike",
      "params": [
        { "name": "multiple", "kind": "DECIMAL", "required": true, "min": "0.1", "max": "100", "scale": 2 },
        { "name": "reference", "kind": "ENUM", "required": true, "values": ["AVG_20", "AVG_50", "PREV"] }
      ]
    }
  ]
}
```

`registryVersion` is returned so that a scanner saved under an older registry can be flagged when a
condition's parameters changed. The definition itself carries its own `schema` and its own `type`
strings, so an old scanner still validates against the registry as long as the type still exists; a
removed type produces `SCANNER_CONDITION_INVALID` on read with a `detail` naming the removed type, and
the UI offers migration rather than silently dropping the condition.

### 12.8 `POST /scanners/validate`

Validates a draft without persisting it. The scanner builder calls this on every structural change,
debounced.

```json
{
  "universe": { "type": "GROUP", "code": "NIFTY500" },
  "timeframe": "1D",
  "allowPartial": false,
  "root": {
    "op": "AND",
    "children": [
      { "type": "CLOSE_ABOVE_SMA", "period": 200 },
      { "type": "RSI_BELOW", "value": "40" },
      { "type": "VOLUME_SPIKE", "multiple": "2.0", "reference": "AVG_20" }
    ]
  }
}
```

Success:

```json
{
  "valid": true,
  "normalized": {
    "schema": "scanner-conditions/v1",
    "logic": "AND",
    "universe": { "type": "GROUP", "code": "NIFTY500", "resolvedCount": 500 },
    "timeframe": "1D",
    "nodeCount": 3,
    "depth": 2,
    "conditions": [ { "type": "CLOSE_ABOVE_SMA", "period": 200 }, { "type": "RSI_BELOW", "period": 14, "value": "40.0000" }, { "type": "VOLUME_SPIKE", "multiple": "2.00", "reference": "AVG_20" } ]
  },
  "warnings": [
    { "code": "UNIVERSE_HAS_STALE_SNAPSHOTS", "count": 12, "message": "12 members have no snapshot for 1D and will be excluded." }
  ]
}
```

Failure: `422` with the problem body in §5.1 and `errors[]` carrying one entry per failing node path.

Validation **resolves the universe**, because a scanner with a valid tree and a deleted group is not
valid. This means `POST /scanners/validate` is not a pure schema check and can return
`SCANNER_UNIVERSE_EMPTY`. It does not execute the query.

### 12.9 `POST /scanners/{id}/runs`

```
POST /api/v1/scanners/018f2c4a-.../runs
Idempotency-Key: 7f3c1a2e-...
Content-Type: application/json

{ "asOf": "2026-03-13", "parameters": { "rsiThreshold": "35" } }
```

Response `202 Accepted`:

```
Location: /api/v1/scanner-runs/018f2c4b-...
Retry-After: 1
```

```json
{
  "id": "018f2c4b-...",
  "scannerId": "018f2c4a-...",
  "scannerVersion": 4,
  "status": "QUEUED",
  "triggerType": "MANUAL",
  "asOf": "2026-03-13T00:00:00.000Z",
  "requestedBy": { "id": "…", "displayName": "A. Analyst" },
  "createdAt": "2026-03-13T10:02:11.000Z",
  "links": { "self": "/api/v1/scanner-runs/018f2c4b-...", "results": "/api/v1/scanner-runs/018f2c4b-.../results" }
}
```

Polling: `GET /scanner-runs/{id}` returns the same document with `status` and, once terminal,
`matchedCount`, `universeCount`, `durationMs`, `completedAt`, and `error` (when failed). Polling cadence
is client-side: 1 s, 2 s, 4 s, 8 s, capped at 8 s. The server never streams.

Rules:

- `asOf` may not be in the future and may not predate the instrument history. A historical `asOf` is
  accepted but evaluated against the **current** snapshot, and `meta.pointInTime` is `false`
  (`04` §8.9). The replay mode that evaluates historical snapshots is a separate, clearly labelled
  surface, not a hidden behaviour of this one.
- `parameters` merges over the definition's stored `parameters`. A parameter not declared by any
  condition in the tree is rejected with `SCANNER_PARAM_INVALID` — an ignored parameter is a silent
  wrong answer.
- `202` is returned even when the run completes in 40 ms, because the contract is that the resource
  exists at `Location`; making the status code depend on execution speed would make the client's retry
  logic non-deterministic.
- The run pins `scannerVersion` at enqueue time. Editing the definition while the run is queued does not
  change what executes.

### 12.10 `GET /scanner-runs/{id}/results`

```
GET /api/v1/scanner-runs/018f2c4b-.../results?limit=100&cursor=<opaque>
```

```json
{
  "run": {
    "id": "018f2c4b-...", "scannerId": "018f2c4a-...", "scannerVersion": 4,
    "status": "COMPLETED", "asOf": "2026-03-13T00:00:00.000Z",
    "universeCount": 500, "matchedCount": 37, "durationMs": 412,
    "completedAt": "2026-03-13T10:02:12.000Z"
  },
  "results": [
    {
      "rank": 1,
      "instrument": { "id": "…", "symbol": "BEL", "name": "Bharat Electronics Ltd" },
      "values": {
        "close": "412.8000",
        "sma_200": "318.410000",
        "rsi_14": "38.420000",
        "avg_volume_20": "18420000.00",
        "volume": "44128000"
      }
    }
  ],
  "page": { "limit": 100, "hasMore": false, "nextCursor": null }
}
```

Rules:

- `values` contains exactly the leaf predicates evaluated and the display columns the definition asked
  for (BR-033). It is not the whole snapshot: a 40-column snapshot per row would triple the payload for
  no analytical benefit.
- `values` keys are the registry's parameter and column names in `snake_case`, matching the DSL
  exception in `API-C2`.
- Results are ordered by `rank`, which is unique per run (`uq_scanner_result_rank`). The cursor is
  `[rank]`.
- A run that is `QUEUED` or `RUNNING` returns `409 SCANNER_RUN_NOT_TERMINAL`. A `FAILED` run returns
  `409 SCANNER_RUN_FAILED` and the problem's `detail` is the run's error code; the full `error` object
  is on the run resource.
- A `COMPLETED` run with zero matches returns `200` with `results: []`. That is a valid, informative
  answer.

### 12.11 `POST /ingestion/uploads`

```
POST /api/v1/ingestion/uploads
Content-Type: multipart/form-data; boundary=...
Idempotency-Key: 018f2c4c-...

--boundary
Content-Disposition: form-data; name="file"; filename="NSE_EOD_2026-03-12.csv"
Content-Type: text/csv

<streamed body>
--boundary
Content-Disposition: form-data; name="sourceId"

018f2c4d-...
--boundary
Content-Disposition: form-data; name="exchangeCode"

NSE
--boundary
Content-Disposition: form-data; name="batchType"

EOD_CSV
--boundary--
```

| Field | Required | Validation |
|---|---|---|
| `file` | yes | `.csv`/`.txt`, allowed MIME, ≤ 200 MiB, no null bytes in the first 512 |
| `sourceId` | yes | Must exist, be active, and belong to the declared exchange |
| `exchangeCode` | yes | Must exist |
| `batchType` | yes | `EOD_CSV`, `INTRADAY_CSV`, `REFERENCE` |
| `timeframe` | conditional | Required when `batchType = INTRADAY_CSV`; must match every row |
| `supersedesBatchId` | no | Must be terminal, same exchange, same `batchType` |

`CORRECTION` is **not** accepted here. Corrections go through `POST /market-data/corrections`, which
requires a different permission and a justification. Allowing a correction through the ordinary upload
path would let anyone with `ingestion:submit` rewrite prices.

Response `202 Accepted`:

```
Location: /api/v1/ingestion/batches/018f2c4e-...
Retry-After: 2
```

```json
{
  "batchId": "018f2c4e-...",
  "fileId": "018f2c4f-...",
  "status": "RECEIVED",
  "sha256": "9f2c…",
  "byteSize": 18492033,
  "originalFilename": "NSE_EOD_2026-03-12.csv",
  "correlationId": "018f2c50-...",
  "links": { "self": "/api/v1/ingestion/batches/018f2c4e-...", "rejects": "/api/v1/ingestion/batches/018f2c4e-.../rejects" }
}
```

Errors:

| Condition | Response |
|---|---|
| Same `sha256`, new key | `409 IMPORT_DUPLICATE_FILE` with `existingBatchId` and a `Location` header |
| Same key, same file | `200` replay with `Idempotent-Replay: true` |
| Same key, different file | `422 IDEMPOTENCY_KEY_REUSED` |
| L1 failure | `422 IMPORT_FILE_INVALID`, `detail` is the L1 code, `errors[]` carries the file-level reason |
| Source inactive | `409 IMPORT_SOURCE_INACTIVE` |
| Second upload in flight for this principal | `429 INGESTION_CONCURRENCY_LIMIT` with `Retry-After` |

The upload is streamed to disk while hashing. The batch row is created **before** the response, but the
job is enqueued in the same transaction as the batch insert, so a crash between the two cannot produce a
batch that nobody will ever process.

### 12.12 `GET /ingestion/batches/{id}`

```json
{
  "id": "018f2c4e-...",
  "source": { "id": "…", "code": "NSE_EOD", "name": "NSE end-of-day" },
  "exchangeCode": "NSE",
  "batchType": "EOD_CSV",
  "status": "RECONCILIATION_FAILED",
  "supersedesBatchId": null,
  "supersededByBatchId": "018f2c60-...",
  "file": { "id": "…", "originalFilename": "NSE_EOD_2026-03-12.csv", "byteSize": 18492033, "sha256": "9f2c…" },
  "counts": {
    "totalRows": 1984, "acceptedRows": 1981, "rejectedRows": 3,
    "insertedBars": 1975, "updatedBars": 6, "unchangedBars": 0
  },
  "errorSummary": {
    "primaryCode": "RECON_TURNOVER_DRIFT",
    "message": "Aggregate turnover differs from source total by 0.031 % (limit 0.01 %).",
    "checks": [
      { "code": "RECON_ROW_COUNT", "passed": true },
      { "code": "RECON_MISSING_BAR", "passed": true },
      { "code": "RECON_TURNOVER_DRIFT", "passed": false, "detail": "source 38294011233.40, stored 38305888210.10" }
    ]
  },
  "requestedBy": { "id": "…", "displayName": "A. Analyst" },
  "receivedAt": "2026-03-12T18:02:03.000Z",
  "startedAt": "2026-03-12T18:02:04.000Z",
  "completedAt": "2026-03-12T18:03:51.000Z",
  "correlationId": "018f2c50-...",
  "links": { "rejects": "/api/v1/ingestion/batches/018f2c4e-.../rejects" }
}
```

Rules:

- `errorSummary.checks` is present only for batches that reached L5.
- `supersededByBatchId` is derived from the reverse lookup, not stored twice on the row.
- A batch in a terminal state is immutable; the API never offers a `PATCH` on it. The only legal
  transitions are the ones in `01`'s import-batch state machine, enforced by
  `md.guard_import_batch_terminal`.
- `counts.unchangedBars` is `IDENTICAL_ROW` from L4. It is reported separately from `updatedBars` so an
  operator can tell a genuine correction from a re-upload that changed nothing.

### 12.13 `POST /market-data/corrections`

```
POST /api/v1/market-data/corrections
Content-Type: multipart/form-data
Idempotency-Key: 018f2c70-...
```

Form fields:

| Field | Required | Validation |
|---|---|---|
| `file` | yes | Same CSV contract as `03` §2 |
| `exchangeCode` | yes | Must exist |
| `sourceId` | yes | Active source |
| `justification` | yes | 20–1,000 characters, non-whitespace (BR-044) |
| `supersedesBatchId` | yes | Terminal batch, same exchange |

The CSV rows carry `revision` implicitly: the server computes `previous.revision + 1` for each affected
bar. A row that would lower a revision is rejected as `CORRECTION_STALE_REVISION`.

Response `202` with `Location` pointing at the correction batch. Before returning, the API writes an
`audit_event` with `action: "marketdata.correction_submitted"`, the justification, the file hash, and
the count of rows per instrument. The audit write is in the same transaction as the batch insert
(BR-042), so a correction cannot exist without its audit trail.

Errors are the same as §12.11 plus:

| Condition | Response |
|---|---|
| Missing or short justification | `422 CORRECTION_JUSTIFICATION_REQUIRED` |
| Every row rejected | `422 CORRECTION_NO_ROWS` |
| Conflict survives validation | `409 CORRECTION_CONFLICT` with `errors[]` naming each conflicting row and both value sets |

### 12.14 `GET /meta`

One call, cached, that lets the SPA avoid every hardcoded list that would otherwise drift:

```json
{
  "build": { "version": "1.4.0", "commit": "9f2c1a7", "builtAt": "2026-03-01T10:00:00.000Z" },
  "timeframes": {
    "chart": ["15m", "60m", "75m", "120m", "240m", "1D", "1W", "1M", "3M", "1Y"],
    "scanner": ["15m", "60m", "75m", "1D", "1W", "1M"],
    "renkoSource": ["15m", "60m", "75m", "1D"]
  },
  "renko": { "brickPercentages": ["0.1000", "0.1500", "0.2500", "0.5000", "1.0000", "2.0000", "3.0000", "5.0000"], "reversalBricks": { "min": 1, "max": 5, "default": 2 }, "priceSources": ["CLOSE", "HIGH_LOW"] },
  "rs": { "windows": [21, 63, 126, 252], "methodologyVersion": "ratio-of-returns/v1", "priceModes": ["ADJUSTED", "RAW"] },
  "indicators": [
    { "code": "SMA_20", "label": "SMA 20", "warmup": 20, "decimals": 6, "params": { "period": 20 } }
  ],
  "scanner": { "registryVersion": "2026-02-01.3", "limits": { "maxDepth": 6, "maxNodes": 25 } },
  "exchanges": [ { "id": "…", "code": "NSE", "name": "National Stock Exchange", "timezone": "Asia/Kolkata" } ],
  "limits": { "barsPerRequest": 5000, "chartBars": 5000, "renkoBricks": 2000, "rsMembers": 5000 }
}
```

`GET /meta` carries no market data and no user data, which is what makes it safe to cache for five
minutes and safe to serve to any authenticated principal regardless of role.

---

## 13. Deferred surfaces

Recorded here so that their absence is a decision rather than an oversight.

| Surface | Why deferred | What would have to change |
|---|---|---|
| WebSocket / SSE push | Polling is sufficient for EOD-cadence work and removes a second auth path, a fan-out mechanism, and a reconnect state machine from v1 | DIAGRAM 12's fan-out over `domain_event`; access-token auth on the socket handshake |
| RS line chart series | Requires a persisted per-session `an.rs_series` table (ratio per member per date per window). Persisting it now would multiply storage by `members × sessions × windows` for a view that the slope already summarises | New table, new job, new endpoint |
| Historical scanner replay | `an.indicator_snapshot` holds only the latest state; a true replay compiles the same DSL against `an.indicator_value` (`04` §8.9) | Separate endpoint, explicit label, same compiler |
| Bulk instrument import via API | Reference data changes are low-volume and audited; a CSV import is a `REFERENCE` batch | An adapter and a validation profile |
| GraphQL | One consumer, a fixed set of screens, and a database whose analytics are precomputed. GraphQL would add a resolver layer over exactly the endpoints already defined | Nothing, if a mobile client later needs flexible shapes |
| Offset pagination | Drift and cost (§6.2) | Nothing; it will not be added |
| `DELETE /market-data/bars` | Market data is corrected, never deleted; deletion destroys auditability | A retention job, not an API |
| Multi-tenancy headers | Assumption A1 | Schema-wide `tenant_id` and RLS |
| Impersonation (`X-Act-As`) | An audit trail that can be forged is not an audit trail | A separate, heavily audited break-glass flow |
| Step-up re-authentication | v1 relies on `ADMIN` + MFA at login + the mandatory 20–1,000 character justification on corrections (`06` §14.5). A second factor challenge per destructive action is a UX cost with no threat model behind it yet, because the destructive actions are already `ADMIN`-only and audited | A destructive action performed by a compromised-but-authenticated session, or a regulator requirement. `06` DEF-06 specifies the elevation claim and the 5-minute window |

---

## 14. OpenAPI and contract testing

### 14.1 Generation

`packages/contracts` is the single source of truth (ADR-013). Each route declares:

- `params`, `query`, `body`, `response` Zod schemas;
- the required permission;
- the error codes it can produce;
- the success status.

A build step generates `openapi.json` from those declarations. The SPA imports the generated types;
nothing is hand-typed twice. A route that lacks a response schema fails the build, so "returns whatever
the ORM produced" is not representable.

### 14.2 Contract tests

| Test | Assertion |
|---|---|
| Route coverage | Every route in §11 resolves to a registered handler and appears in `openapi.json` |
| Permission coverage | Every route declares exactly one permission or is in the documented `—` allowlist |
| Error coverage | Every `code` in §5.2 is produced by at least one handler path, asserted by fault injection |
| Decimal serialisation | Every DTO property whose column type is `numeric` or `bigint` is typed as a decimal string |
| Enum drift | Every response enum matches the corresponding database `CHECK` list |
| Cursor robustness | A tampered cursor, a cursor from another endpoint, and a truncated cursor each return `400 PAGE_CURSOR_INVALID` |
| Idempotency | A repeated request with the same key and body returns the identical body; a different body returns `422` |
| Strict requests | An unknown body property returns `422`, not silently ignored |
| Open responses | A response with an extra property still validates against the client schema |

### 14.3 Schema drift test

A CI job compares `information_schema.columns` against the DTOs:

- a `numeric` column with no matching decimal-string DTO property fails;
- a `bigint` column typed as `number` fails;
- a `NOT NULL` column typed as optional in the response fails;
- a nullable column typed as non-nullable fails.

This is the test that stops the API from silently becoming a different contract than the database after
a migration.

### 14.4 Load assertions

The performance budgets from `04` §10.1 are asserted per endpoint, not only per engine:

| Endpoint | p95 target | Rows |
|---|---|---|
| `GET /market-data/bars` | 120 ms | 500 |
| `GET /charts/{id}` (5 overlays + Renko) | 350 ms | 750 bars, 300 bricks |
| `GET /rs/matrix` | 400 ms | 500 members, 4 windows |
| `GET /breadth` | 150 ms | 250 points |
| `GET /scanner-runs/{id}/results` | 90 ms | 100 rows |
| `GET /instruments?q=` | 60 ms | 50 rows |
| `POST /ingestion/uploads` (accept) | 250 ms | 20 MB file |

A regression beyond 150 % of target fails the build. Budgets are measured against a seeded database of
the size in `00` §9.1, not against an empty schema.

---

## 15. Client contract (SPA)

These obligations are part of the API contract because a client that violates them produces incorrect
market data on screen even though the server is correct.

1. **Access token in memory only.** Never `localStorage`, never `sessionStorage`, never a non-HttpOnly
   cookie. A page reload performs a refresh; that is expected and costs one request.
2. **Never convert a decimal string to a number for storage or comparison.** Parse for display with
   `Intl.NumberFormat`, or use a decimal library for arithmetic. `parseFloat("2987.4000")` is acceptable
   only inside a formatter that immediately renders and discards it.
3. **Refresh on `401 AUTH_TOKEN_EXPIRED` only.** A `401` with any other code means re-authenticate; a
   refresh loop on `AUTH_REFRESH_REUSED` would revoke every session the user has.
4. **Serialise refreshes.** Concurrent 401s must share one in-flight refresh promise. Ten parallel
   chart requests that each refresh independently will trip reuse detection and log the user out.
5. **Poll with backoff, stop on terminal.** Scanner runs and import batches are polled at 1/2/4/8 s and
   stop at any terminal status. Polling a `COMPLETED` run forever is a self-inflicted rate limit.
6. **Render gaps, do not interpolate.** A missing `bucketStart` is a gap. Drawing a line through it
   fabricates a price.
7. **Render Renko by `seq`.** Two bricks can share a timestamp. Grouping by time collapses them.
8. **Show `warnings`.** `GAP_IN_SERIES`, `STATS_52W_UNAVAILABLE`, `isStale`, and `truncated` exist to be
   displayed, not swallowed.
9. **Never derive `sessionDate` from `bucketStart`.** Use the field.
10. **Treat `404` on a private resource as "not found", not as "forbidden".** The distinction is
    deliberate and the UI must not undo it by guessing.
11. **Send `Idempotency-Key` on the five endpoints that require it, and regenerate it on a genuinely new
    intent.** Reusing a key for a second, different scan returns the first scan's results.
12. **Respect `RateLimit-Reset`.** A client that retries a `429` immediately turns a throttle into an
    outage.

---

## 16. Decisions recorded in this document

| ID | Decision | Rationale |
|---|---|---|
| **D-05-01** | Single path version `/api/v1`; additive changes within a version | One consumer, no public API, and path versioning is the least ambiguous option for a staff tool |
| **D-05-02** | `numeric` and `bigint` serialise as strings; `integer` as numbers | One mechanical rule, enforceable by a drift test; no exceptions to erode it |
| **D-05-03** | Collections use `{data, page}`; single resources are bare | An envelope on a single resource adds a level for no benefit; a bare array cannot carry pagination |
| **D-05-04** | Signed opaque keyset cursors, no offset pagination | Drift, cost, and unstable ordering are all real in this product |
| **D-05-05** | RFC 9457 with a `code` member and URN `type` | Standard shape, no domain ownership, and clients branch on a stable key |
| **D-05-06** | Strict requests, open responses | Catches client typos server-side without breaking deployed clients on additive change |
| **D-05-07** | Idempotency uses each resource's own unique index, not a generic table | One transaction, no two-phase write, no divergence between record and resource |
| **D-05-08** | Charts are one bundled request with `bucketStart`-keyed series | Six parallel requests create six partial-failure states and an inconsistent chart |
| **D-05-09** | RS matrix is unpaginated, capped at 5,000 | Percentiles and leader flags are population statistics; pagination changes the population |
| **D-05-10** | RS line chart deferred until a persisted series exists | Computing it per request violates ADR-008 and would disagree with the stored slope |
| **D-05-11** | Condition registry exposed at `GET /scanner-conditions` | The UI must be generated from the compiler's registry, not from a parallel hardcoded list |
| **D-05-12** | CSV exports use `snake_case` DB column names | Exports feed pandas and operators reading the DDL; JSON feeds the SPA |
| **D-05-13** | `If-Match` mandatory on scanner definitions and settings | Two analysts editing one screen must not silently overwrite each other |
| **D-05-14** | No push transport in v1 | Polling is sufficient at EOD cadence and removes a second auth path and a reconnect state machine |
| **D-05-15** | Adjusted prices are the default everywhere; `RAW` is opt-in, and chart rejects `RAW` + indicators | Indicators, Renko, and RS are all adjusted-based; a raw line under an adjusted average is a plausible-looking lie |
| **D-05-16** | Bulk snapshot reads capped at 200 ids; no cross-instrument bar endpoint | Prevents an accidental full-market scan through the read path; the dashboard uses precomputed aggregates |
| **D-05-17** | Audit queries capped at 90 days, with a scoped chain-verification endpoint | An unbounded audit scan is a denial-of-service against the audit trail itself |
| **D-05-18** | Rate limits fail closed for auth and writes, open for reads | A failing-open auth limiter is a credential-stuffing accelerator; a failing-closed read limiter turns a blip into an outage |
| **D-05-19** | Malformed `X-Request-Id` is replaced, never rejected | Observability metadata must not be able to fail a request |
| **D-05-20** | No impersonation and no client-supplied identity | An audit trail that a caller can direct is not evidence |
| **D-05-21** | `dataquality:write` and `analytics:recompute` added to the permission catalogue | Resolving a finding must not require price-mutation rights, and a rebuild must not be open to read-only roles |

---

## 17. Open questions carried into implementation

These are not blockers for the specification, but they must be resolved before the endpoints that
depend on them are implemented. Each has an owner phase.

| ID | Question | Phase | Default if unresolved |
|---|---|---|---|
| Q-05-01 | Should `GET /market-data/bars` expose a `1D` bar for a synthetic instrument (GS Composite) before the composite's source instruments have a complete common history? | 6 | No: the composite bar exists only for sessions where every configured proxy has a bar |
| Q-05-02 | Does the dashboard need per-widget `asOf` overrides, or is one `asOf` for the whole page sufficient? | 13 | One `asOf`; a widget that needs another date links to its own surface |
| Q-05-03 | Should scanner parameter overrides be persisted on the run for reproducibility? | 12 | Yes: `scanner_run.parameters` snapshot, additive column, read-only in the API |
| Q-05-04 | Is `limit` on `/admin/audit-events` enough, or is a server-side CSV export required for compliance review? | 14 | Export added only when a compliance requirement names it |

An open question that reaches its phase without an answer is resolved by the default, recorded in the
phase's completion note, and never left as a `TODO` in code.
