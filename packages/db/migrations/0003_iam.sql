-- Generated from docs/architecture/02-database.md, section "5.1". Immutable once applied (02 §8).

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
