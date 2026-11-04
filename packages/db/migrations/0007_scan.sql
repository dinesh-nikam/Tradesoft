-- Generated from docs/architecture/02-database.md, section "5.5". Immutable once applied (02 §8).

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
