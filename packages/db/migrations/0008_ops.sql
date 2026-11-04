-- Generated from docs/architecture/02-database.md, section "5.6". Immutable once applied (02 §8).

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
