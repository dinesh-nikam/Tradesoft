-- Generated from docs/architecture/02-database.md, section "5.3". Immutable once applied (02 §8).

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
    = (completed_at is not null))
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
