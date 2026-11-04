-- Generated from docs/architecture/02-database.md, section "5.4". Immutable once applied (02 §8).

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
