# 02 — Database Design

Status: **APPROVED BASELINE (Phase 0)**. PostgreSQL 16.

Nothing here is illustrative: the DDL in §5 is the intended migration content, and Phase 2 acceptance is
"apply these migrations to an empty cluster and pass the schema test suite".

---

## 1. Conventions

| Concern | Decision |
|---|---|
| Identifier case | `snake_case`, unquoted, singular table names |
| Primary keys | `uuid` (UUIDv7 generated in application for index locality; `gen_random_uuid()` default as a safety net) |
| Append-only tables | `bigint generated always as identity` plus the partition key in the PK |
| Timestamps | `timestamptz`, always UTC. Domain columns end in `_at`. Trading days are `date` columns ending in `_date`. |
| Money and prices | `numeric(18,4)` — 14 integer digits, 4 decimals. Never `float`, never `double precision`. |
| Derived ratios | `numeric(18,6)` or `numeric(9,6)` for percentages |
| Turnover | `numeric(24,4)` — index turnover can exceed ₹10¹² |
| Volumes | `bigint` (shares, contracts, lots) |
| Booleans | `boolean not null default false` — never nullable |
| Enumerations | `text` + named `CHECK` constraint. **Not** `CREATE TYPE`, because altering a Postgres enum inside a migration is awkward and cannot be done in a transaction on older tooling. |
| Soft delete | Only where history matters (`is_active`, `removed_on`, `delisted_on`). Otherwise `DELETE` with `ON DELETE RESTRICT` protection. |
| Naming | `pk_`, `uq_`, `fk_`, `ck_`, `ix_` prefixes, snake_case, ≤ 63 characters |
| Schemas | One per domain module, mirroring §2 of `00-system-architecture.md` |

Every mutable table has:

```sql
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

with `trg_<table>_updated_at` calling `ops.set_updated_at()`.

---

## 2. Schemas and privileges

```sql
create extension if not exists pgcrypto;   -- digest(), gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email
create extension if not exists pg_trgm;    -- instrument search

create schema if not exists iam;        -- identity and access
create schema if not exists ref;        -- market reference data
create schema if not exists md;         -- market data and ingestion
create schema if not exists an;         -- analytics and derived series
create schema if not exists scan;       -- scanners and saved views
create schema if not exists ops;        -- jobs, outbox, settings
create schema if not exists audit;      -- audit and security events
```

Three database roles, least privilege:

| Role | Used by | Grants |
|---|---|---|
| `tradesoft_migrator` | migration runner only | owner of all objects; DDL |
| `tradesoft_app` | api, worker, scheduler | `SELECT, INSERT, UPDATE, DELETE` on all schemas **except** `audit.audit_event` (INSERT + SELECT only) and `audit.security_event` (INSERT + SELECT only) |
| `tradesoft_readonly` | BI tools, incident forensics | `SELECT` on `ref`, `md`, `an`, `scan`; no access to `iam` or `audit` |

`public` schema is unused. The application connects with `options='-c search_path=iam,ref,md,an,scan,ops,audit,public'`
and every statement is schema-qualified anyway.

---

## 3. Lookup tables and enumerated values

### 3.1 `ref.timeframe`

Authoritative timeframe list. Referenced by FK from every bar table so an unknown timeframe cannot exist.

| code | minutes | is_intraday | sort_order | Meaning |
|---|---|---|---|---|
| `15m` | 15 | true | 10 | Fifteen minutes |
| `60m` | 60 | true | 20 | One hour |
| `75m` | 75 | true | 30 | Seventy-five minutes |
| `120m` | 120 | true | 40 | Two hours |
| `240m` | 240 | true | 50 | Four hours |
| `1D` | 375 | false | 60 | One trading session |
| `1W` | null | false | 70 | One trading week |
| `1M` | null | false | 80 | One calendar month |
| `3M` | null | false | 90 | One calendar quarter |
| `1Y` | null | false | 100 | One calendar year |

`minutes` for `1D` is 375 — the NSE/BSE cash session length (09:15–15:30 IST). It is documentation, not a
constraint, because MCX and NCDEX sessions differ; the session length actually used comes from
`ref.trading_calendar`.

### 3.2 Enumerated values (as `CHECK` constraints)

| Column | Allowed values |
|---|---|
| `instrument.instrument_type` | `EQUITY`,`INDEX`,`FUTURE`,`OPTION`,`ETF`,`BOND`,`CURRENCY`,`FUND` |
| `instrument.asset_class` | `EQUITY`,`COMMODITY`,`FX`,`FIXED_INCOME`,`RATE` |
| `instrument.status` | `ACTIVE`,`SUSPENDED`,`DELISTED` |
| `sector.kind` | `SECTOR`,`INDUSTRY`,`THEME` |
| `corporate_action.action_type` | `SPLIT`,`BONUS`,`DIVIDEND`,`RIGHTS`,`MERGER`,`DEMERGER`,`SYMBOL_CHANGE` |
| `market_group.group_type` | `SECTOR`,`INDEX`,`CUSTOM`,`BENCHMARK`,`COMPOSITE` |
| `import_batch.status` | `RECEIVED`,`VALIDATING`,`VALIDATED`,`PROCESSING`,`COMPLETED`,`VALIDATION_FAILED`,`PROCESSING_FAILED`,`RECONCILIATION_FAILED` |
| `market_bar.quality_status` | `VALIDATED`,`CORRECTED`,`QUARANTINED` |
| `bar_quality_issue.severity` | `INFO`,`WARN`,`ERROR` |
| `renko_brick.direction` | `UP`,`DOWN` |
| `renko_brick_set.price_source` | `CLOSE`,`HIGH_LOW` |
| `rs_value.trend` | `UP`,`DOWN`,`FLAT` |
| `scanner_definition.logic` | `AND`,`OR` |
| `scanner_run.status` | `QUEUED`,`RUNNING`,`COMPLETED`,`FAILED`,`CANCELLED` |
| `job.status` | `QUEUED`,`RUNNING`,`COMPLETED`,`DEAD_LETTER`,`CANCELLED` |
| `app_user.status` | `PENDING_VERIFICATION`,`ACTIVE`,`LOCKED`,`SUSPENDED`,`DEACTIVATED` |
| `one_time_token.purpose` | `PASSWORD_RESET`,`EMAIL_VERIFICATION`,`INVITATION` |

---

## 4. Entity-relationship overview

DIAGRAM 6 in [`DIAGRAMS.md`](DIAGRAMS.md) renders cardinality. Three relationship shapes are worth
stating explicitly because they drive index choices:

1. **Star around `ref.instrument`.** Almost every analytical table is keyed by `instrument_id`. This is
   the dominant join and the reason `instrument_id` leads most composite indexes.
2. **Time-bounded membership.** `instrument_sector_membership` and `index_membership` use
   `[effective_from, effective_to)` ranges. A historical breadth query must join on the range, not on
   "current membership", which is the single most common correctness bug in this class of product.
3. **Parameterised derived series.** `indicator_value`, `renko_brick_set` and `breadth_snapshot` all key
   on a parameter identity (`params_hash`, `brick_pct`). Two parameterisations coexist without collision
   and without overwriting each other.

---

## 5. DDL

### 5.1 `iam` — Identity and access

```sql
create table iam.app_user (
  id                        uuid primary key default gen_random_uuid(),
  email                     citext not null,
  password_hash             text not null,
  display_name              text not null,
  status                    text not null default 'PENDING_VERIFICATION',
  totp_secret_ct            bytea,
  totp_enrolled_at          timestamptz,
  last_totp_counter         bigint,
  mfa_required              boolean not null default false,
  failed_login_count        integer not null default 0,
  locked_until              timestamptz,
  last_login_at             timestamptz,
  password_changed_at       timestamptz not null default now(),
  must_change_password      boolean not null default false,
  token_invalid_before      timestamptz,
  deactivated_at            timestamptz,
  deactivation_reason       text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint uq_app_user_email unique (email),
  constraint ck_app_user_status check (status in
    ('PENDING_VERIFICATION','ACTIVE','LOCKED','SUSPENDED','DEACTIVATED')),
  constraint ck_app_user_failed check (failed_login_count >= 0),
  constraint ck_app_user_mfa check (
    (totp_enrolled_at is null) = (totp_secret_ct is null)),
  constraint ck_app_user_totp_counter check (last_totp_counter is null or last_totp_counter >= 0),
  constraint ck_app_user_deactivated check (
    (status = 'DEACTIVATED') = (deactivated_at is not null))
);
create index ix_app_user_status on iam.app_user (status) where status <> 'DEACTIVATED';
create index ix_app_user_mfa_required on iam.app_user (id) where mfa_required and totp_secret_ct is null;

create table iam.role (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  name         text not null,
  description  text not null default '',
  is_system    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint uq_role_code unique (code),
  constraint ck_role_code check (code ~ '^[A-Z][A-Z0-9_]{1,39}$')
);

create table iam.permission (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  description  text not null default '',
  created_at   timestamptz not null default now(),
  constraint uq_permission_code unique (code),
  constraint ck_permission_code check (code ~ '^[a-z][a-z0-9]*(:[a-z0-9]+)+$')
);

create table iam.user_role (
  user_id     uuid not null references iam.app_user(id) on delete cascade,
  role_id     uuid not null references iam.role(id) on delete restrict,
  granted_by  uuid references iam.app_user(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, role_id)
);
create index ix_user_role_role on iam.user_role (role_id);

create table iam.role_permission (
  role_id        uuid not null references iam.role(id) on delete cascade,
  permission_id  uuid not null references iam.permission(id) on delete restrict,
  primary key (role_id, permission_id)
);
create index ix_role_permission_permission on iam.role_permission (permission_id);

create table iam.auth_session (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references iam.app_user(id) on delete cascade,
  family_id          uuid not null,
  family_started_at  timestamptz not null,
  refresh_token_hash bytea not null,
  access_token_jti    uuid not null,
  issued_at          timestamptz not null default now(),
  expires_at         timestamptz not null,
  last_used_at       timestamptz,
  used_at            timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  client_ip          inet,
  user_agent         text,
  constraint uq_auth_session_hash unique (refresh_token_hash),
  constraint ck_auth_session_expiry check (expires_at > issued_at),
  constraint ck_auth_session_family_cap check (
    expires_at <= family_started_at + interval '90 days')
);
create index ix_auth_session_user on iam.auth_session (user_id, issued_at desc);
create index ix_auth_session_family on iam.auth_session (family_id);
create index ix_auth_session_active on iam.auth_session (expires_at)
  where revoked_at is null and used_at is null;
-- Serves the 30-second revocation poll: only rows that are actually revoked are of interest,
-- and that set is tiny relative to the table. Without this the poll is a sequential scan.
create index ix_auth_session_revoked on iam.auth_session (revoked_at)
  where revoked_at is not null;

create table iam.one_time_token (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references iam.app_user(id) on delete cascade,
  purpose      text not null,
  token_hash   bytea not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint uq_one_time_token_hash unique (token_hash),
  constraint ck_one_time_token_purpose check (purpose in
    ('PASSWORD_RESET','EMAIL_VERIFICATION','INVITATION'))
);
create index ix_one_time_token_user on iam.one_time_token (user_id, purpose)
  where consumed_at is null;

-- Previous password hashes, for reuse rejection. Bounded at 5 rows per user by the change routine;
-- the bound is application-enforced because a trigger cannot know which row is "the sixth".
create table iam.password_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references iam.app_user(id) on delete cascade,
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create index ix_password_history_user on iam.password_history (user_id, created_at desc);

-- Single-use recovery codes. Same reasoning as iam.api_key: high-entropy, so SHA-256 suffices.
create table iam.mfa_recovery_code (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references iam.app_user(id) on delete cascade,
  code_hash   bytea not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint uq_mfa_recovery_code_hash unique (code_hash)
);
create index ix_mfa_recovery_code_user on iam.mfa_recovery_code (user_id)
  where used_at is null;

-- Short-lived binding between a password-verified login and the second factor. Kept server-side
-- so that the MFA step cannot be replayed against a different user (06 §6.4).
create table iam.mfa_challenge (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references iam.app_user(id) on delete cascade,
  ip_hash      bytea not null,
  ua_hash      bytea not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint ck_mfa_challenge_expiry check (expires_at > created_at),
  constraint ck_mfa_challenge_attempts check (attempts >= 0 and attempts <= 5)
);
create index ix_mfa_challenge_user on iam.mfa_challenge (user_id)
  where consumed_at is null;

create table iam.api_key (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  key_prefix   text not null,
  key_hash     bytea not null,
  scopes       text[] not null default '{}',
  created_by   uuid not null references iam.app_user(id) on delete restrict,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  constraint uq_api_key_prefix unique (key_prefix),
  constraint uq_api_key_hash unique (key_hash),
  constraint ck_api_key_prefix check (key_prefix ~ '^tsk_[a-z0-9]{8}$')
);
create index ix_api_key_active on iam.api_key (expires_at)
  where revoked_at is null;
```

Retention: `auth_session` rows purged 30 days after `expires_at`; `one_time_token` purged 7 days after
`expires_at`; `mfa_challenge` purged 24 hours after `expires_at` (they live for minutes and are useless
afterwards); `password_history` and `mfa_recovery_code` are deleted with the user by `ON DELETE CASCADE`.
`app_user` rows are never hard-deleted while referenced by audit.

The `ck_auth_session_family_cap` constraint is the database half of the 90-day absolute family lifetime
(`06` §5.4). It is a `CHECK` rather than a job because a sliding `expires_at` with no ceiling is exactly
the failure mode a stolen refresh token needs: an attentive attacker refreshes forever. `family_started_at`
is copied from the first row of the family on every rotation and never changes.

### 5.2 `ref` — Market reference data

```sql
create table ref.timeframe (
  code         text primary key,
  minutes      integer,
  is_intraday  boolean not null,
  sort_order   integer not null,
  label        text not null,
  constraint ck_timeframe_minutes check (
    (is_intraday and minutes is not null and minutes > 0)
    or (not is_intraday))
);

create table ref.exchange (
  id                uuid primary key default gen_random_uuid(),
  code              text not null,
  name              text not null,
  timezone          text not null default 'Asia/Kolkata',
  currency          char(3) not null default 'INR',
  default_open_time time not null,
  default_close_time time not null,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_exchange_code unique (code),
  constraint ck_exchange_code check (code ~ '^[A-Z]{2,8}$'),
  constraint ck_exchange_session check (default_close_time > default_open_time)
);

create table ref.trading_calendar (
  exchange_id     uuid not null references ref.exchange(id) on delete restrict,
  calendar_date   date not null,
  is_trading_day  boolean not null,
  session_open_at timestamptz,
  session_close_at timestamptz,
  is_special      boolean not null default false,
  description     text,
  source          text not null default 'MANUAL',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (exchange_id, calendar_date),
  constraint ck_calendar_window check (
    (is_trading_day and session_open_at is not null and session_close_at is not null
      and session_close_at > session_open_at)
    or (not is_trading_day and session_open_at is null and session_close_at is null))
);
create index ix_calendar_trading on ref.trading_calendar (exchange_id, calendar_date)
  where is_trading_day;

create table ref.sector (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  name        text not null,
  parent_id   uuid references ref.sector(id) on delete restrict,
  kind        text not null default 'SECTOR',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_sector_code unique (code),
  constraint ck_sector_kind check (kind in ('SECTOR','INDUSTRY','THEME')),
  constraint ck_sector_not_self check (parent_id is null or parent_id <> id)
);
create index ix_sector_parent on ref.sector (parent_id);

create table ref.instrument (
  id                  uuid primary key default gen_random_uuid(),
  exchange_id         uuid not null references ref.exchange(id) on delete restrict,
  symbol              text not null,
  series              text not null default '',
  isin                text,
  name                text not null,
  instrument_type     text not null,
  asset_class         text not null,
  currency            char(3) not null default 'INR',
  lot_size            integer not null default 1,
  tick_size           numeric(18,6) not null default 0.05,
  price_precision     smallint not null default 2,
  status              text not null default 'ACTIVE',
  listing_date        date,
  delisting_date      date,
  expiry_date         date,
  strike_price        numeric(18,4),
  option_type         char(1),
  underlying_id       uuid references ref.instrument(id) on delete restrict,
  lot_multiplier      numeric(18,6) not null default 1,
  is_synthetic        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_instrument_symbol unique (exchange_id, symbol, series),
  constraint ck_instrument_type check (instrument_type in
    ('EQUITY','INDEX','FUTURE','OPTION','ETF','BOND','CURRENCY','FUND')),
  constraint ck_instrument_asset_class check (asset_class in
    ('EQUITY','COMMODITY','FX','FIXED_INCOME','RATE')),
  constraint ck_instrument_status check (status in ('ACTIVE','SUSPENDED','DELISTED')),
  constraint ck_instrument_tick check (tick_size > 0),
  constraint ck_instrument_precision check (price_precision between 0 and 6),
  constraint ck_instrument_lot check (lot_size > 0),
  constraint ck_instrument_delisted check (
    (status = 'DELISTED') = (delisting_date is not null)),
  constraint ck_instrument_option check (
    (instrument_type = 'OPTION') or (strike_price is null and option_type is null)),
  constraint ck_instrument_option_type check (option_type in ('C','P') or option_type is null)
);
create index ix_instrument_exchange_status on ref.instrument (exchange_id, status);
create index ix_instrument_type_class on ref.instrument (instrument_type, asset_class);
create index ix_instrument_underlying on ref.instrument (underlying_id)
  where underlying_id is not null;
create index ix_instrument_symbol_trgm on ref.instrument using gin (symbol gin_trgm_ops);
create index ix_instrument_name_trgm on ref.instrument using gin (name gin_trgm_ops);
create index ix_instrument_isin on ref.instrument (isin) where isin is not null;

create table ref.symbol_alias (
  id           uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ref.instrument(id) on delete cascade,
  alias_symbol text not null,
  exchange_id  uuid not null references ref.exchange(id) on delete restrict,
  valid_from   date not null,
  valid_to     date,
  reason       text not null default 'SYMBOL_CHANGE',
  created_at   timestamptz not null default now(),
  constraint ck_symbol_alias_window check (valid_to is null or valid_to >= valid_from)
);
create index ix_symbol_alias_lookup on ref.symbol_alias (exchange_id, alias_symbol, valid_from desc);

create table ref.instrument_sector_membership (
  instrument_id  uuid not null references ref.instrument(id) on delete cascade,
  sector_id      uuid not null references ref.sector(id) on delete restrict,
  effective_from date not null,
  effective_to   date,
  source         text not null default 'MANUAL',
  created_at     timestamptz not null default now(),
  primary key (instrument_id, sector_id, effective_from),
  constraint ck_ism_window check (effective_to is null or effective_to >= effective_from)
);
create index ix_ism_sector_date on ref.instrument_sector_membership (sector_id, effective_from desc);

create table ref.index_membership (
  index_instrument_id  uuid not null references ref.instrument(id) on delete cascade,
  member_instrument_id uuid not null references ref.instrument(id) on delete cascade,
  effective_from       date not null,
  effective_to         date,
  weight               numeric(9,6),
  created_at           timestamptz not null default now(),
  primary key (index_instrument_id, member_instrument_id, effective_from),
  constraint ck_index_membership_window check (effective_to is null or effective_to >= effective_from),
  constraint ck_index_membership_not_self check (index_instrument_id <> member_instrument_id),
  constraint ck_index_membership_weight check (weight is null or (weight >= 0 and weight <= 100))
);
create index ix_index_membership_member on ref.index_membership (member_instrument_id, effective_from desc);

create table ref.corporate_action (
  id             uuid primary key default gen_random_uuid(),
  instrument_id  uuid not null references ref.instrument(id) on delete cascade,
  action_type    text not null,
  ex_date        date not null,
  record_date    date,
  ratio_from     numeric(18,6),
  ratio_to       numeric(18,6),
  cash_amount    numeric(18,4),
  announced_at   date,
  source         text not null default 'MANUAL',
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_corporate_action unique (instrument_id, action_type, ex_date),
  constraint ck_corporate_action_type check (action_type in
    ('SPLIT','BONUS','DIVIDEND','RIGHTS','MERGER','DEMERGER','SYMBOL_CHANGE')),
  constraint ck_corporate_action_ratio check (
    (action_type not in ('SPLIT','BONUS'))
    or (ratio_from is not null and ratio_to is not null and ratio_from > 0 and ratio_to > 0)),
  constraint ck_corporate_action_cash check (
    (action_type <> 'DIVIDEND') or (cash_amount is not null and cash_amount >= 0))
);
create index ix_corporate_action_exdate on ref.corporate_action (instrument_id, ex_date desc);

create table ref.market_group (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  group_type     text not null,
  is_dynamic     boolean not null default false,
  dynamic_rule   jsonb,
  owner_user_id  uuid references iam.app_user(id) on delete set null,
  is_shared      boolean not null default false,
  is_system      boolean not null default false,
  description    text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_market_group_code unique (code),
  constraint ck_market_group_type check (group_type in
    ('SECTOR','INDEX','CUSTOM','BENCHMARK','COMPOSITE')),
  constraint ck_market_group_dynamic check (
    (is_dynamic and dynamic_rule is not null) or (not is_dynamic))
);
create index ix_market_group_owner on ref.market_group (owner_user_id)
  where owner_user_id is not null;

create table ref.market_group_member (
  group_id      uuid not null references ref.market_group(id) on delete cascade,
  instrument_id uuid not null references ref.instrument(id) on delete cascade,
  added_on      date not null,
  removed_on    date,
  weight        numeric(9,6),
  primary key (group_id, instrument_id, added_on),
  constraint ck_mgm_window check (removed_on is null or removed_on >= added_on)
);
create index ix_mgm_instrument on ref.market_group_member (instrument_id, added_on desc);
```

Retention: reference data is retained indefinitely. `market_group_member` rows are closed, never deleted,
so historical breadth is reproducible. `instrument` rows are never hard-deleted.

### 5.3 `md` — Market data and ingestion

```sql
create table md.data_source (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  name         text not null,
  kind         text not null,
  provider     text not null default 'INTERNAL',
  exchange_id  uuid references ref.exchange(id) on delete restrict,
  config       jsonb not null default '{}',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint uq_data_source_code unique (code),
  constraint ck_data_source_kind check (kind in ('CSV','API','MANUAL')),
  constraint ck_data_source_no_secrets check (
    not (config ? 'password') and not (config ? 'apiKey') and not (config ? 'token'))
);

create table md.import_file (
  id                uuid primary key default gen_random_uuid(),
  original_filename text not null,
  stored_path       text not null,
  byte_size         bigint not null,
  sha256            bytea not null,
  mime_type         text not null,
  uploaded_by       uuid references iam.app_user(id) on delete set null,
  uploaded_at       timestamptz not null default now(),
  row_estimate      integer,
  constraint uq_import_file_sha unique (sha256),
  constraint ck_import_file_size check (byte_size > 0 and byte_size <= 209715200)
);

create table md.import_batch (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid not null references md.data_source(id) on delete restrict,
  file_id             uuid references md.import_file(id) on delete restrict,
  exchange_id         uuid not null references ref.exchange(id) on delete restrict,
  batch_type          text not null,
  status              text not null default 'RECEIVED',
  idempotency_key     text,
  supersedes_batch_id uuid references md.import_batch(id) on delete restrict,
  correlation_id      uuid not null,
  requested_by        uuid references iam.app_user(id) on delete set null,
  total_rows          integer not null default 0,
  accepted_rows       integer not null default 0,
  rejected_rows       integer not null default 0,
  inserted_bars       integer not null default 0,
  updated_bars        integer not null default 0,
  error_summary       jsonb,
  timeframe           text references ref.timeframe(code) on delete restrict,
  header_line         integer,
  received_at         timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ck_import_batch_type check (batch_type in
    ('EOD_CSV','EOD_API','INTRADAY_CSV','INTRADAY_API','CORRECTION','REFERENCE')),
  constraint ck_import_batch_status check (status in
    ('RECEIVED','VALIDATING','VALIDATED','PROCESSING','COMPLETED',
     'VALIDATION_FAILED','PROCESSING_FAILED','RECONCILIATION_FAILED')),
  constraint ck_import_batch_counts check (
    total_rows >= 0 and accepted_rows >= 0 and rejected_rows >= 0
    and accepted_rows + rejected_rows = total_rows),
  constraint ck_import_batch_terminal check (
    (status in ('COMPLETED','VALIDATION_FAILED','PROCESSING_FAILED','RECONCILIATION_FAILED'))
    = (completed_at is not null)),
  -- Migration 0016 (Phase 5): an INTRADAY_CSV upload declares the timeframe every row must match, and
  -- header_line locates rejected rows (03 §2.2).
  constraint ck_import_batch_timeframe check ((batch_type = 'INTRADAY_CSV') = (timeframe is not null))
);
create unique index uq_import_batch_idem on md.import_batch (idempotency_key)
  where idempotency_key is not null;
create index ix_import_batch_status on md.import_batch (status, received_at desc);
create index ix_import_batch_source on md.import_batch (source_id, received_at desc);

create table md.ingestion_reject (
  id              bigint generated always as identity primary key,
  import_batch_id uuid not null references md.import_batch(id) on delete cascade,
  row_number      integer not null,
  raw_row         jsonb not null,
  error_code      text not null,
  error_message   text not null,
  field_name      text,
  created_at      timestamptz not null default now(),
  constraint uq_ingestion_reject_row unique (import_batch_id, row_number)
);
create index ix_ingestion_reject_batch on md.ingestion_reject (import_batch_id, error_code);

create table md.market_bar (
  instrument_id   uuid not null references ref.instrument(id) on delete restrict,
  timeframe       text not null references ref.timeframe(code) on delete restrict,
  bucket_start    timestamptz not null,
  session_date    date not null,
  open            numeric(18,4) not null,
  high            numeric(18,4) not null,
  low             numeric(18,4) not null,
  close           numeric(18,4) not null,
  volume          bigint not null default 0,
  delivery_volume bigint,
  delivery_pct    numeric(9,4),
  open_interest   bigint,
  turnover        numeric(24,4),
  is_partial      boolean not null default false,
  quality_status  text not null default 'VALIDATED',
  revision        integer not null default 1,
  import_batch_id uuid references md.import_batch(id) on delete set null,
  validated_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (instrument_id, timeframe, bucket_start),
  constraint ck_market_bar_ohlc_positive check (
    open > 0 and high > 0 and low > 0 and close > 0),
  constraint ck_market_bar_high check (high >= low and high >= open and high >= close),
  constraint ck_market_bar_low check (low <= open and low <= close),
  constraint ck_market_bar_volume check (volume >= 0),
  constraint ck_market_bar_delivery check (
    delivery_volume is null
    or (delivery_volume >= 0 and delivery_volume <= volume
        and delivery_pct is not null
        and delivery_pct >= 0 and delivery_pct <= 100)),
  constraint ck_market_bar_oi check (open_interest is null or open_interest >= 0),
  constraint ck_market_bar_revision check (revision >= 1),
  constraint ck_market_bar_quality check (quality_status in
    ('VALIDATED','CORRECTED','QUARANTINED'))
) partition by range (bucket_start);

create index ix_market_bar_batch on md.market_bar (import_batch_id)
  where import_batch_id is not null;
create index ix_market_bar_daily_cross on md.market_bar (session_date, instrument_id)
  where timeframe = '1D';
create index ix_market_bar_quarantined on md.market_bar (session_date)
  where quality_status = 'QUARANTINED';

create table md.market_bar_history (
  history_id      bigint generated always as identity,
  instrument_id   uuid not null,
  timeframe       text not null,
  bucket_start    timestamptz not null,
  session_date    date not null,
  open            numeric(18,4) not null,
  high            numeric(18,4) not null,
  low             numeric(18,4) not null,
  close           numeric(18,4) not null,
  volume          bigint not null,
  revision        integer not null,
  quality_status  text not null,
  import_batch_id uuid,
  superseded_at   timestamptz not null default now(),
  superseded_by   uuid,
  recorded_at     timestamptz not null default now(),
  primary key (recorded_at, history_id)
) partition by range (recorded_at);

create table md.bar_quality_issue (
  id              bigint generated always as identity primary key,
  instrument_id   uuid not null references ref.instrument(id) on delete restrict,
  timeframe       text not null references ref.timeframe(code) on delete restrict,
  bucket_start    timestamptz not null,
  session_date    date not null,
  issue_code      text not null,
  severity        text not null,
  details         jsonb not null default '{}',
  import_batch_id uuid references md.import_batch(id) on delete set null,
  detected_at     timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution_note text,
  constraint ck_bqi_severity check (severity in ('INFO','WARN','ERROR')),
  constraint ck_bqi_resolution check (
    (resolved_at is null) or (resolution_note is not null))
);
create index ix_bqi_open on md.bar_quality_issue (instrument_id, detected_at desc)
  where resolved_at is null;
create index ix_bqi_code on md.bar_quality_issue (issue_code, detected_at desc);

create table md.bar_adjustment_factor (
  instrument_id uuid not null references ref.instrument(id) on delete cascade,
  session_date  date not null,
  factor        numeric(18,10) not null,
  source_action_ids uuid[] not null default '{}',
  computed_at   timestamptz not null default now(),
  primary key (instrument_id, session_date),
  constraint ck_bar_adjustment_factor check (factor > 0)
);

create table md.instrument_daily_snapshot (
  instrument_id uuid not null references ref.instrument(id) on delete cascade,
  session_date  date not null,
  open          numeric(18,4) not null,
  high          numeric(18,4) not null,
  low           numeric(18,4) not null,
  close         numeric(18,4) not null,
  prev_close    numeric(18,4),
  volume        bigint not null,
  turnover      numeric(24,4),
  delivery_pct  numeric(9,4),
  open_interest bigint,
  change_pct    numeric(9,4),
  computed_at   timestamptz not null default now(),
  primary key (instrument_id, session_date),
  constraint ck_ids_ohlc check (high >= low and high >= open and high >= close
    and low <= open and low <= close and high > 0 and low > 0)
);
create index ix_ids_date on md.instrument_daily_snapshot (session_date, change_pct desc);

create table md.instrument_stat_52w (
  instrument_id  uuid not null references ref.instrument(id) on delete cascade,
  as_of_date     date not null,
  high_252       numeric(18,4) not null,
  low_252        numeric(18,4) not null,
  close          numeric(18,4) not null,
  pct_from_high  numeric(9,4) not null,
  pct_from_low   numeric(9,4) not null,
  sessions_used  smallint not null,
  computed_at    timestamptz not null default now(),
  primary key (instrument_id, as_of_date),
  constraint ck_52w_range check (high_252 >= low_252 and high_252 > 0),
  constraint ck_52w_sessions check (sessions_used > 0 and sessions_used <= 252)
);
create index ix_52w_high on md.instrument_stat_52w (as_of_date, pct_from_high);
```

### 5.4 `an` — Analytics

```sql
create table an.indicator_value (
  instrument_id  uuid not null references ref.instrument(id) on delete cascade,
  timeframe      text not null references ref.timeframe(code) on delete restrict,
  bucket_start   timestamptz not null,
  indicator_code text not null,
  params_hash    text not null,
  value          numeric(18,6),
  computed_at    timestamptz not null default now(),
  primary key (instrument_id, timeframe, bucket_start, indicator_code, params_hash),
  constraint ck_indicator_value_hash check (params_hash ~ '^[0-9a-f]{16}$')
) partition by range (bucket_start);

create index ix_indicator_value_cross on an.indicator_value
  (indicator_code, params_hash, bucket_start, instrument_id);

create table an.indicator_snapshot (
  instrument_id      uuid not null references ref.instrument(id) on delete cascade,
  timeframe          text not null references ref.timeframe(code) on delete restrict,
  as_of_bucket       timestamptz not null,
  session_date       date not null,
  params_hash        text not null,
  close              numeric(18,4) not null,
  prev_close         numeric(18,4),
  volume             bigint not null,
  prev_volume        bigint,
  delivery_pct       numeric(9,4),
  sma_20             numeric(18,6),
  sma_50             numeric(18,6),
  sma_200            numeric(18,6),
  prev_sma_50        numeric(18,6),
  prev_sma_200       numeric(18,6),
  ema_20             numeric(18,6),
  ema_50             numeric(18,6),
  prev_ema_20        numeric(18,6),
  rsi_14             numeric(18,6),
  adx_14             numeric(18,6),
  di_plus_14         numeric(18,6),
  di_minus_14        numeric(18,6),
  atr_14             numeric(18,6),
  bb_upper_20_2      numeric(18,6),
  bb_middle_20_2     numeric(18,6),
  bb_lower_20_2      numeric(18,6),
  avg_volume_20      numeric(20,2),
  avg_volume_50      numeric(20,2),
  high_252           numeric(18,4),
  low_252            numeric(18,4),
  pct_from_high_252  numeric(9,4),
  pct_from_low_252   numeric(9,4),
  extra              jsonb not null default '{}',
  computed_at        timestamptz not null default now(),
  primary key (instrument_id, timeframe),
  constraint ck_indicator_snapshot_hash check (params_hash ~ '^[0-9a-f]{16}$')
);
create index ix_indicator_snapshot_scan on an.indicator_snapshot (timeframe, params_hash);
create index ix_indicator_snapshot_rsi on an.indicator_snapshot (timeframe, rsi_14);
create index ix_indicator_snapshot_adx on an.indicator_snapshot (timeframe, adx_14);
create index ix_indicator_snapshot_52w on an.indicator_snapshot (timeframe, pct_from_high_252);

create table an.renko_brick_set (
  id                uuid primary key default gen_random_uuid(),
  instrument_id     uuid not null references ref.instrument(id) on delete cascade,
  source_timeframe  text not null references ref.timeframe(code) on delete restrict,
  brick_pct         numeric(6,4) not null,
  reversal_bricks   smallint not null default 2,
  price_source      text not null default 'CLOSE',
  brick_size_abs    numeric(18,4) not null,
  anchor_price      numeric(18,4) not null,
  anchor_bucket     timestamptz not null,
  revision          integer not null default 1,
  brick_count       integer not null default 0,
  last_brick_close  numeric(18,4),
  last_brick_at     timestamptz,
  computed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_renko_set unique
    (instrument_id, source_timeframe, brick_pct, reversal_bricks, price_source),
  constraint ck_renko_brick_pct check (brick_pct in
    (0.1, 0.15, 0.25, 0.5, 1, 2, 3, 5)),
  constraint ck_renko_reversal check (reversal_bricks between 1 and 5),
  constraint ck_renko_price_source check (price_source in ('CLOSE','HIGH_LOW')),
  constraint ck_renko_size check (brick_size_abs > 0),
  constraint ck_renko_count check (brick_count >= 0)
);
create index ix_renko_set_instrument on an.renko_brick_set (instrument_id, source_timeframe);

create table an.renko_brick (
  brick_set_id         uuid not null references an.renko_brick_set(id) on delete cascade,
  seq                  bigint not null,
  direction            text not null,
  open                 numeric(18,4) not null,
  high                 numeric(18,4) not null,
  low                  numeric(18,4) not null,
  close                numeric(18,4) not null,
  brick_size           numeric(18,4) not null,
  is_reversal          boolean not null default false,
  source_bucket_start  timestamptz not null,
  source_session_date  date not null,
  created_at           timestamptz not null default now(),
  primary key (brick_set_id, seq),
  constraint ck_renko_brick_seq check (seq >= 1),
  constraint ck_renko_brick_direction check (direction in ('UP','DOWN')),
  constraint ck_renko_brick_ohlc check (
    high >= low and high >= open and high >= close and low <= open and low <= close),
  constraint ck_renko_brick_size check (brick_size > 0)
);
create index ix_renko_brick_date on an.renko_brick (brick_set_id, source_session_date desc);
create index ix_renko_brick_latest on an.renko_brick (brick_set_id, seq desc);

create table an.breadth_snapshot (
  group_id           uuid not null references ref.market_group(id) on delete cascade,
  timeframe          text not null references ref.timeframe(code) on delete restrict,
  brick_pct          numeric(6,4) not null,
  session_date       date not null,
  total_members      integer not null,
  eligible_members   integer not null,
  positive_bricks    integer not null,
  negative_bricks    integer not null,
  unchanged_bricks   integer not null,
  positive_pct       numeric(9,4) not null,
  sma5_positive_pct  numeric(9,4),
  computed_at        timestamptz not null default now(),
  primary key (group_id, timeframe, brick_pct, session_date),
  constraint ck_breadth_counts check (
    positive_bricks >= 0 and negative_bricks >= 0 and unchanged_bricks >= 0
    and eligible_members >= 0 and total_members >= eligible_members
    and positive_bricks + negative_bricks + unchanged_bricks <= eligible_members),
  constraint ck_breadth_pct check (positive_pct >= 0 and positive_pct <= 100),
  constraint ck_breadth_sma check (
    sma5_positive_pct is null or (sma5_positive_pct >= 0 and sma5_positive_pct <= 100))
);
create index ix_breadth_date on an.breadth_snapshot (session_date desc, group_id);

create table an.rs_snapshot (
  id                  uuid primary key default gen_random_uuid(),
  group_id            uuid not null references ref.market_group(id) on delete cascade,
  base_instrument_id  uuid not null references ref.instrument(id) on delete restrict,
  as_of_date          date not null,
  window_days         integer not null,
  methodology_version text not null default 'ratio-of-returns/v1',
  price_mode          text not null default 'ADJUSTED',
  member_count        integer not null default 0,
  computed_at         timestamptz not null default now(),
  constraint uq_rs_snapshot unique
    (group_id, base_instrument_id, as_of_date, window_days, methodology_version),
  constraint ck_rs_window check (window_days in (21, 63, 126, 252)),
  constraint ck_rs_price_mode check (price_mode in ('ADJUSTED','RAW'))
);
create index ix_rs_snapshot_latest on an.rs_snapshot (group_id, window_days, as_of_date desc);

create table an.rs_value (
  snapshot_id       uuid not null references an.rs_snapshot(id) on delete cascade,
  instrument_id     uuid not null references ref.instrument(id) on delete cascade,
  ratio             numeric(18,8),
  score             numeric(18,6),
  rank              integer,
  percentile        numeric(9,6),
  rs_line_slope     numeric(18,8),
  trend             text,
  is_leader         boolean not null default false,
  is_laggard        boolean not null default false,
  insufficient_history boolean not null default false,
  primary key (snapshot_id, instrument_id),
  constraint ck_rs_value_rank check (rank is null or rank >= 1),
  constraint ck_rs_value_percentile check (
    percentile is null or (percentile >= 0 and percentile <= 1)),
  constraint ck_rs_value_trend check (trend in ('UP','DOWN','FLAT') or trend is null),
  constraint ck_rs_value_exclusive check (not (is_leader and is_laggard)),
  constraint ck_rs_value_scored check (
    insufficient_history or (ratio is not null and score is not null and rank is not null))
);
create unique index uq_rs_value_rank on an.rs_value (snapshot_id, rank)
  where rank is not null;
create index ix_rs_value_score on an.rs_value (snapshot_id, score desc);

create table an.analytics_watermark (
  instrument_id    uuid not null references ref.instrument(id) on delete cascade,
  timeframe        text not null references ref.timeframe(code) on delete restrict,
  dataset          text not null,
  params_hash      text not null,
  computed_through timestamptz not null,
  updated_at       timestamptz not null default now(),
  primary key (instrument_id, timeframe, dataset, params_hash),
  constraint ck_watermark_dataset check (dataset in
    ('INDICATORS','RENKO','SNAPSHOT','STATS_52W'))
);
create index ix_watermark_dataset on an.analytics_watermark (dataset, computed_through);
```

### 5.5 `scan` — Scanners and saved views

```sql
create table scan.scanner_definition (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  description    text not null default '',
  version        integer not null default 1,
  universe       jsonb not null,
  timeframe      text not null references ref.timeframe(code) on delete restrict,
  logic          text not null default 'AND',
  conditions     jsonb not null,
  parameters     jsonb not null default '{}',
  allow_partial  boolean not null default false,
  is_system      boolean not null default false,
  is_shared      boolean not null default false,
  owner_user_id  uuid references iam.app_user(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_scanner_code unique (code),
  constraint ck_scanner_logic check (logic in ('AND','OR')),
  constraint ck_scanner_version check (version >= 1),
  constraint ck_scanner_conditions check (jsonb_typeof(conditions) = 'object'),
  constraint ck_scanner_universe check (jsonb_typeof(universe) = 'object')
);
create index ix_scanner_owner on scan.scanner_definition (owner_user_id)
  where owner_user_id is not null;

create table scan.scanner_run (
  id              uuid primary key default gen_random_uuid(),
  scanner_id      uuid not null references scan.scanner_definition(id) on delete cascade,
  scanner_version integer not null,
  status          text not null default 'QUEUED',
  trigger_type    text not null default 'MANUAL',
  as_of           timestamptz not null,
  idempotency_key text,
  requested_by    uuid references iam.app_user(id) on delete set null,
  correlation_id  uuid not null,
  universe_count  integer,
  matched_count   integer,
  duration_ms     integer,
  explain_plan    jsonb,
  error           jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ck_scanner_run_status check (status in
    ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  constraint ck_scanner_run_trigger check (trigger_type in ('MANUAL','SCHEDULED','API')),
  constraint ck_scanner_run_counts check (
    (universe_count is null or universe_count >= 0)
    and (matched_count is null or matched_count >= 0)),
  constraint ck_scanner_run_terminal check (
    (status in ('COMPLETED','FAILED','CANCELLED')) = (completed_at is not null))
);
create unique index uq_scanner_run_idem on scan.scanner_run (idempotency_key)
  where idempotency_key is not null;
create index ix_scanner_run_scanner on scan.scanner_run (scanner_id, created_at desc);
create index ix_scanner_run_status on scan.scanner_run (status, created_at)
  where status in ('QUEUED','RUNNING');

create table scan.scanner_run_result (
  run_id         uuid not null references scan.scanner_run(id) on delete cascade,
  instrument_id  uuid not null references ref.instrument(id) on delete cascade,
  rank           integer not null,
  values         jsonb not null,
  matched_at     timestamptz not null default now(),
  primary key (run_id, instrument_id),
  constraint ck_scanner_result_rank check (rank >= 1)
);
create unique index uq_scanner_result_rank on scan.scanner_run_result (run_id, rank);
create index ix_scanner_result_run on scan.scanner_run_result (run_id, rank);

create table scan.saved_view (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references iam.app_user(id) on delete cascade,
  kind          text not null,
  name          text not null,
  config        jsonb not null,
  is_shared     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint uq_saved_view_name unique (owner_user_id, kind, name),
  constraint ck_saved_view_kind check (kind in
    ('CHART','RENKO','SCANNER','RS_MATRIX','BREADTH'))
);
create index ix_saved_view_shared on scan.saved_view (kind) where is_shared;
```

### 5.6 `ops` — Jobs, outbox, settings

```sql
create table ops.job (
  id              uuid primary key default gen_random_uuid(),
  queue           text not null default 'default',
  job_type        text not null,
  payload         jsonb not null,
  payload_version integer not null default 1,
  status          text not null default 'QUEUED',
  priority        smallint not null default 100,
  run_after       timestamptz not null default now(),
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,
  reclaimed_count integer not null default 0,
  idempotency_key text,
  correlation_id  uuid not null,
  locked_by       text,
  locked_at       timestamptz,
  lock_expires_at timestamptz,
  last_error      jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  constraint ck_job_status check (status in
    ('QUEUED','RUNNING','COMPLETED','DEAD_LETTER','CANCELLED')),
  constraint ck_job_attempts check (attempts >= 0 and attempts <= max_attempts),
  constraint ck_job_priority check (priority between 0 and 1000),
  constraint ck_job_locked check (
    (status = 'RUNNING') = (locked_by is not null and locked_at is not null
                            and lock_expires_at is not null)),
  constraint ck_job_terminal check (
    (status in ('COMPLETED','CANCELLED','DEAD_LETTER')) = (completed_at is not null))
);
create unique index uq_job_idempotency on ops.job (idempotency_key)
  where idempotency_key is not null;
create index ix_job_claim on ops.job (queue, priority, run_after)
  where status = 'QUEUED';
create index ix_job_running on ops.job (lock_expires_at)
  where status = 'RUNNING';
create index ix_job_type_status on ops.job (job_type, status, created_at desc);

create table ops.job_attempt (
  job_id      uuid not null references ops.job(id) on delete cascade,
  attempt_no  integer not null,
  worker_id   text not null,
  status      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  error       jsonb,
  primary key (job_id, attempt_no),
  constraint ck_job_attempt_status check (status in
    ('RUNNING','SUCCEEDED','FAILED','RECLAIMED','CANCELLED')),
  constraint ck_job_attempt_no check (attempt_no >= 1)
);
create index ix_job_attempt_worker on ops.job_attempt (worker_id, started_at desc);

create table ops.job_schedule (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  job_type       text not null,
  queue          text not null default 'default',
  cron           text not null,
  timezone       text not null default 'Asia/Kolkata',
  payload        jsonb not null default '{}',
  is_enabled     boolean not null default true,
  last_enqueued_at timestamptz,
  next_run_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_job_schedule_code unique (code)
);
create index ix_job_schedule_due on ops.job_schedule (next_run_at) where is_enabled;

create table ops.domain_event (
  id               bigint generated always as identity primary key,
  event_type       text not null,
  aggregate_type   text not null,
  aggregate_id     uuid not null,
  aggregate_version integer not null default 1,
  payload          jsonb not null default '{}',
  occurred_at      timestamptz not null default now(),
  published_at     timestamptz,
  processed_at     timestamptz,
  constraint uq_domain_event unique (event_type, aggregate_id, aggregate_version)
);
create index ix_domain_event_unpublished on ops.domain_event (occurred_at)
  where processed_at is null;

create table ops.system_setting (
  key         text primary key,
  value       jsonb not null,
  description text not null default '',
  updated_by  uuid references iam.app_user(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create unlogged table ops.rate_limit_counter (
  bucket_key   text not null,
  window_start timestamptz not null,
  hits         integer not null default 1,
  primary key (bucket_key, window_start),
  constraint ck_rate_limit_hits check (hits >= 0)
);
create index ix_rate_limit_window on ops.rate_limit_counter (window_start);
```

`ops.rate_limit_counter` is `UNLOGGED` deliberately: it is ephemeral, and losing it on crash merely
resets counters. It is truncated on restart by the migration/maintenance job.

### 5.7 `audit` — Audit and security events

```sql
create table audit.audit_event (
  id            bigint generated by default as identity,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid references iam.app_user(id) on delete restrict,
  actor_type    text not null default 'USER',
  actor_ip      inet,
  action        text not null,
  entity_type   text not null,
  entity_id     text not null,
  before        jsonb,
  after         jsonb,
  metadata      jsonb not null default '{}',
  correlation_id uuid not null,
  request_id    text,
  prev_hash     bytea,
  hash          bytea not null,
  primary key (occurred_at, id),
  constraint ck_audit_actor_type check (actor_type in ('USER','SYSTEM','API_KEY')),
  constraint ck_audit_action check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
) partition by range (occurred_at);
create index ix_audit_entity on audit.audit_event (entity_type, entity_id, occurred_at desc);
create index ix_audit_actor on audit.audit_event (actor_user_id, occurred_at desc);
create index ix_audit_action on audit.audit_event (action, occurred_at desc);
create index ix_audit_correlation on audit.audit_event (correlation_id);

create table audit.security_event (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  event_type    text not null,
  severity      text not null default 'INFO',
  user_id       uuid references iam.app_user(id) on delete set null,
  email_attempted citext,
  client_ip     inet,
  user_agent    text,
  details       jsonb not null default '{}',
  correlation_id uuid not null,
  constraint ck_security_event_type check (event_type in (
    'LOGIN_SUCCESS','LOGIN_FAILURE','LOGIN_LOCKED','LOGOUT','TOKEN_REFRESH',
    'TOKEN_REUSE_DETECTED','SESSION_REVOKED','PASSWORD_CHANGED','PASSWORD_RESET_REQUESTED',
    'MFA_ENABLED','MFA_DISABLED','MFA_FAILURE','PERMISSION_DENIED','RATE_LIMIT_EXCEEDED',
    'API_KEY_CREATED','API_KEY_REVOKED','UPLOAD_REJECTED','SUSPICIOUS_INPUT')),
  constraint ck_security_event_severity check (severity in ('INFO','WARN','HIGH','CRITICAL'))
);
create index ix_security_event_time on audit.security_event (occurred_at desc, event_type);
create index ix_security_event_user on audit.security_event (user_id, occurred_at desc);

create table ops.schema_migration (
  version     integer primary key,
  name        text not null,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  duration_ms integer not null
);
```

`audit.audit_event` and `audit.security_event` are append-only. `REVOKE UPDATE, DELETE` on both tables
from `tradesoft_app` is part of the privilege migration, and a trigger raises on attempted
`UPDATE`/`DELETE` so that even an over-privileged connection fails loudly.

---

## 6. Partitioning

| Table | Strategy | Granularity | Retention | Rationale |
|---|---|---|---|---|
| `md.market_bar` | `RANGE (bucket_start)` | monthly | daily+ indefinite; intraday 36 months | Chart queries always bound a date range; `DROP PARTITION` is the only sane way to expire 150M rows |
| `md.market_bar_history` | `RANGE (recorded_at)` | monthly | 24 months | Audit traffic, not query traffic |
| `an.indicator_value` | `RANGE (bucket_start)` | monthly | 36 months | Same access shape as bars |
| `ops.domain_event` | none | — | 3 months | `uq_domain_event` is the outbox's dedupe guarantee, and PostgreSQL cannot enforce a unique constraint on a partitioned table unless it includes the partition key. Retention is a batched `DELETE` of processed rows by `maintenance.retention_purge`. |
| `audit.audit_event` | `RANGE (occurred_at)` | monthly | 84 months | Regulatory-style retention without a 25M-row single table |
| `an.renko_brick` | none | — | 5 years | Keyed by `brick_set_id`; a set is naturally time-coherent and the access pattern is a range scan within one set. Re-evaluate if row count exceeds 100M. |
| `md.instrument_daily_snapshot` | none | — | 10 years | ~2.5M rows/year; partitioning adds no value |
| `an.indicator_snapshot` | none | — | current only | Upserted in place, ~60k rows |

Partition naming: `md.market_bar_y2026m01`, `an.indicator_value_y2026m01`,
`audit.audit_event_y2026m01`. Partitions are created by `maintenance.partition_rollover`, which keeps a
3-month forward runway and raises a `WARN` when the runway drops below 30 days. Partitions are never
created by a request handler.

`DEFAULT` partitions are **not** used: a missing partition must fail the insert, not silently accumulate
rows that no retention policy will ever touch.

---

## 7. Functions and triggers

```sql
create or replace function ops.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function md.guard_import_batch_terminal() returns trigger
language plpgsql as $$
begin
  if old.status in ('COMPLETED','VALIDATION_FAILED','PROCESSING_FAILED','RECONCILIATION_FAILED')
     and new.status <> old.status then
    raise exception 'import_batch % is terminal in status %', old.id, old.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function md.capture_bar_history() returns trigger
language plpgsql as $$
begin
  if new.revision > old.revision then
    insert into md.market_bar_history (
      instrument_id, timeframe, bucket_start, session_date,
      open, high, low, close, volume, revision, quality_status,
      import_batch_id, superseded_by)
    values (
      old.instrument_id, old.timeframe, old.bucket_start, old.session_date,
      old.open, old.high, old.low, old.close, old.volume, old.revision,
      old.quality_status, old.import_batch_id, new.import_batch_id);
  end if;
  return new;
end $$;

create or replace function audit.append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'audit records are append-only' using errcode = 'insufficient_privilege';
end $$;

create or replace function audit.chain_hash() returns trigger
language plpgsql as $$
declare
  v_prev bytea;
begin
  -- One chain, low volume, and correctness is worth the serialisation. The lock is held until
  -- commit, so a concurrent writer blocks until the previous audit row is visible.
  perform pg_advisory_xact_lock(hashtext('audit.chain'));

  -- A BEFORE INSERT trigger runs before the identity default is applied, so NEW.id is NULL here.
  -- Assign it from the same sequence the default would use. Because the assignment happens under
  -- the advisory lock, id order equals chain order by construction.
  if new.id is null then
    new.id := nextval(pg_get_serial_sequence('audit.audit_event', 'id'));
  end if;

  select hash into v_prev
    from audit.audit_event
   order by id desc
   limit 1;                       -- id is globally monotonic; occurred_at is not (clock skew)

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

**Amended by migration `0014_audit_chain_utc`.** The function above hashed `occurred_at::text`, which
PostgreSQL renders in the writing session's `TimeZone`, so a writer and a verifier in different time zones
computed different hashes for the same row. The normative hash is now `audit.event_hash(prev_hash, row)`,
which renders `occurred_at` in UTC (`YYYY-MM-DDTHH24:MI:SS.USZ`); the trigger and the verifier both call it,
so they cannot drift apart.

The function is correct only at **`READ COMMITTED`**, which is the PostgreSQL default and the isolation level every audit-writing transaction uses. Under `REPEATABLE READ` the writer's snapshot is fixed before it acquires the advisory lock, so it would not see the predecessor row and the chain would fork. This is recorded because it is invisible in the code and would only appear as an intermittent verification failure.

`id` is `generated by default as identity` rather than `always`, purely so the trigger may assign it. Inserts never supply `id` themselves; the trigger always does.

Triggers to attach in the migration:

| Trigger | Table | Timing |
|---|---|---|
| `trg_app_user_updated_at` … one per mutable table | — | `BEFORE UPDATE` → `ops.set_updated_at()` |
| `trg_import_batch_terminal` | `md.import_batch` | `BEFORE UPDATE` → `md.guard_import_batch_terminal()` |
| `trg_market_bar_history` | `md.market_bar` | `AFTER UPDATE` → `md.capture_bar_history()` |
| `trg_audit_append_only` | `audit.audit_event`, `audit.security_event` | `BEFORE UPDATE OR DELETE` → `audit.append_only_guard()` |
| `trg_audit_chain` | `audit.audit_event` | `BEFORE INSERT` → `audit.chain_hash()` |

Cross-table invariants that cannot be expressed as `CHECK` are enforced by a **deferred constraint
trigger** on `md.market_bar` (`INV-19`, `BR-011`, `BR-012`): at commit time it verifies that
`session_date` has a `ref.trading_calendar` row with `is_trading_day = true`, that `bucket_start` lies
within `[session_open_at, session_close_at)`, and that `session_date` equals the exchange-local date of
`bucket_start`. `DEFERRABLE INITIALLY DEFERRED` is required because a batch may insert bars and the
calendar row in the same transaction during a reference import.

---

## 8. Migration strategy

- **Forward-only.** No `down` migrations in production. Rollback is a new forward migration.
- **Numbered, immutable.** `packages/db/migrations/0001_initial_schema.sql`, `0002_rbac_seed.sql`, … The
  runner records `(version, name, checksum)` in `ops.schema_migration` and **refuses to run** if a
  previously applied file's checksum changed.
- **Single runner.** The migrator takes `pg_advisory_lock(hashtext('tradesoft.migrate'))`, so concurrent
  deploys cannot race. A migration either fully applies or the transaction rolls back.
- **Expand / contract for zero downtime.** Three deploys: (1) add nullable column or new table and
  backfill; (2) deploy code that writes both old and new; (3) drop the old column. A destructive change in
  a single deploy is rejected in review.
- **Long operations are not migrations.** Backfills of millions of rows run as jobs
  (`maintenance.backfill_*`), batched and resumable, not inside a DDL transaction that holds locks.
- **Index creation** on existing large tables uses `CREATE INDEX CONCURRENTLY` in a separate
  non-transactional migration file, flagged `-- migrate:no-transaction`.
- **CI verification:** apply all migrations to an empty database; assert the resulting tables and columns
  equal the DDL of §5; run the raw-SQL contract suite; assert no `DEFAULT` partitions exist; assert
  every `numeric` price column is `numeric(18,4)`.

Ordering constraint: `ref.timeframe`, `iam.role`, `iam.permission`, `iam.role_permission` and the
`ops.system_setting` defaults are populated by migration (structural reference data, §9). Exchanges carry
environment-specific session windows and are seeded by script. The runner itself creates `ops` and
`ops.schema_migration` before applying the first file, because it must record that file; the table's DDL in
§5.6 is therefore executed by the runner, not by a numbered migration.

---

## 9. Seed strategy

Two distinct mechanisms, never conflated:

**Structural seed (migration, runs in every environment):**
`ref.timeframe` (10 rows), `iam.permission` (all codes from §4.1 of `00-system-architecture.md`),
`iam.role` (4 system roles), `iam.role_permission` (the matrix), `ops.system_setting` defaults
(`ingestion.max_rows_per_batch`, `ingestion.max_file_bytes`, `analytics.primary_params_hash`,
`security.access_token_ttl_seconds`, `security.refresh_token_ttl_days`,
`scanner.statement_timeout_ms`, `breadth.min_history_bars`).

**Development seed (`packages/db/src/seed-dev.ts`, run by `pnpm db:seed:dev`; refuses to run unless `NODE_ENV=development` and
`SEED_ALLOW=true`):**

| Dataset | Content |
|---|---|
| Users | `admin@tradesoft.local` (ADMIN), `analyst@tradesoft.local` (ANALYST), `viewer@tradesoft.local` (VIEWER); passwords printed once to stdout, never committed |
| Exchanges | NSE, BSE, MCX, NCDEX, NFO with placeholder session windows flagged `VERIFY_BEFORE_PROD` |
| Calendar | 4 years of weekdays as trading days (enough to hold 800 sessions), minus a fixed holiday list, plus one special session |
| Sectors | 12 sectors, 40 industries, hierarchy two levels deep |
| Indices | `NIFTY50`, `BANKNIFTY`, `SENSEX`, `NIFTYMIDCAP` as `instrument_type='INDEX'` with membership |
| Instruments | 60 equities across sectors, 4 ETFs, 2 commodities, 1 currency pair, 2 bond proxies |
| Bars | 800 daily bars per instrument plus 400 sessions of 15-minute bars, generated from a seeded GBM with fixed volatility so the dataset is byte-reproducible |
| Corporate actions | 6 splits and bonuses, chosen to exercise adjustment factors across the history |
| Renko sets | All 8 brick percentages on 5 instruments |
| Scanners | None in the development seed. System scanners are seeded in Phase 12 from the versioned file defined in `04` §8.7, in every environment. |
| RS groups | 4 sector groups, 1 index group, `GS_COMPOSITE` |
| Defects | 1 missing trading day for one instrument is in the database. Duplicate rows, invalid OHLC, negative volume and out-of-session timestamps cannot exist in `md.market_bar` — its constraints reject them — so they live in an ingestion CSV fixture (Phase 5) used by data-quality tests. |

The seed is deterministic: a fixed PRNG seed produces identical output on every machine, so golden tests
can assert exact values.

**Production is never seeded with development data.** A startup assertion fails if
`NODE_ENV=production` and any user other than the bootstrap administrator exists with a known seed email.

---

## 10. Important indexes and the queries they serve

| Index | Serves |
|---|---|
| `md.market_bar` PK (`instrument_id`,`timeframe`,`bucket_start`) | Chart window: `WHERE instrument_id = $1 AND timeframe = $2 AND bucket_start BETWEEN $3 AND $4 ORDER BY bucket_start` → index-only range scan, partition pruning on `bucket_start` |
| `ix_market_bar_daily_cross` (`session_date`,`instrument_id`) `WHERE timeframe='1D'` | Dashboard movers, breadth, 52-week statistics: all instruments for one session |
| `ix_indicator_snapshot_scan` (`timeframe`,`params_hash`) | Scanner full-universe predicate evaluation |
| `ix_indicator_snapshot_rsi` / `_adx` / `_52w` | Range predicates on the most common scanner thresholds |
| `ix_renko_brick_latest` (`brick_set_id`,`seq DESC`) | "Latest brick" lateral join for breadth and Renko-aware scanners |
| `ix_renko_brick_date` (`brick_set_id`,`source_session_date DESC`) | Breadth series over time, brick lookups per session |
| `ix_breadth_date` (`session_date DESC`,`group_id`) | Breadth chart and dashboard |
| `ix_rs_value_score` (`snapshot_id`,`score DESC`) | RS matrix ordering and leader/laggard extraction |
| `ix_job_claim` (`queue`,`priority`,`run_after`) `WHERE status='QUEUED'` | Worker claim: partial index keeps the hot path to a few thousand entries |
| `ix_job_running` (`lock_expires_at`) `WHERE status='RUNNING'` | Reaper scan for expired locks |
| `ix_instrument_symbol_trgm` / `_name_trgm` | Type-ahead instrument search (`symbol ILIKE '%…%'`) |
| `ix_audit_entity` (`entity_type`,`entity_id`,`occurred_at DESC`) | "Show me everything that happened to this instrument" |
| `ix_import_batch_status` (`status`,`received_at DESC`) | Operator queue view |

Deliberately **absent**: an index on `md.market_bar.close`. A range predicate on close is never used; every
price query is instrument-and-time scoped. Adding it would cost write throughput for no query.

---

## 11. Expected query plans (regression targets)

These are asserted in the performance test suite. A plan regression is a build failure, not a warning.

| Query | Expected access path | Budget |
|---|---|---|
| 2,000 daily bars for one instrument | `Index Scan` on each partition's PK, partitions pruned to the requested range (monthly partitions put 2,000 sessions across about 96) | p95 < 40 ms |
| 5,000 15-minute bars for one instrument | `Index Scan` on PK, ≤ 3 partitions | p95 < 120 ms |
| Latest snapshot for 2,000 instruments in one timeframe | `Index Scan` on `ix_indicator_snapshot_scan` | p95 < 80 ms |
| Breadth series for one group, 250 sessions | `Index Scan` on `ix_breadth_date` | p95 < 60 ms |
| RS matrix, 1 snapshot, 500 members | `Index Scan` on `ix_rs_value_score` | p95 < 50 ms |
| Scanner over 2,000 instruments, 5 conditions, 1 timeframe | `Hash Join` over snapshot + 2 label joins | < 3 s |
| Job claim batch of 50 | `Index Scan` on partial `ix_job_claim` | p95 < 15 ms |
| Instrument search, prefix, 20 results | `Bitmap Index Scan` on trigram GIN | p95 < 25 ms |

---

## 12. Capacity model and storage estimate

| Object | Year 1 | Year 5 | Bytes/row (incl. index) | Year-5 size |
|---|---|---|---|---|
| `md.market_bar` daily | 2.5M | 25M | ~180 | 4.5 GB |
| `md.market_bar` intraday | 92M | 277M (36-month retention) | ~180 | 25 GB |
| `an.indicator_value` | 30M | 90M | ~120 | 11 GB |
| `md.market_bar_history` | 0.5M | 3M | ~200 | 0.6 GB |
| `an.renko_brick` | 20M | 60M | ~110 | 6.6 GB |
| `audit.audit_event` | 5M | 25M | ~400 | 10 GB |
| `md.ingestion_reject` | 0.2M | 1M | ~600 | 0.6 GB |
| **Total** | | | | **≈ 60 GB** |

Provisioning: 100 GB volume with alerting at 70 %. Postgres tuning baseline for a 16 GB host:
`shared_buffers=4GB`, `effective_cache_size=12GB`, `work_mem=64MB`, `maintenance_work_mem=1GB`,
`max_connections=100` (with pgBouncer if API instances exceed 3), `random_page_cost=1.1` (NVMe),
`default_statistics_target=200` on analytical columns, `autovacuum_vacuum_scale_factor=0.02` on
`md.market_bar` and `an.indicator_value`.

---

## 13. Backup and recovery

- Nightly `pg_dump --format=custom` of the whole cluster, retained 30 days off-host.
- Continuous WAL archiving (`archive_mode=on`, `archive_command` to a separate volume/bucket) giving
  RPO ≤ 15 minutes.
- Weekly restore drill: restore the latest base backup plus WAL into a scratch database, run
  `scripts/verify-restore.sql` which asserts row counts, the newest `market_bar` session date, and the
  audit chain integrity from the last 1,000 events.
- The raw-import volume is included in the nightly backup; bars can be rebuilt from it if a logical
  corruption is discovered, which is the only recovery path that does not depend on the database itself.
