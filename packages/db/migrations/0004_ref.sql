-- Generated from docs/architecture/02-database.md, section "5.2". Immutable once applied (02 §8).

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
