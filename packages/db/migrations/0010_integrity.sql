-- Triggers listed in 02 §7, plus the cross-table invariants that a CHECK cannot express (INV-13, INV-19).

-- 02 §1: every mutable table maintains updated_at. Partitions inherit the trigger from their parent.
do $$
declare
  r record;
begin
  for r in
    select c.table_schema, c.table_name
      from information_schema.columns c
      join pg_namespace n on n.nspname = c.table_schema
      join pg_class k on k.relname = c.table_name and k.relnamespace = n.oid
     where c.column_name = 'updated_at'
       and c.table_schema in ('iam', 'ref', 'md', 'an', 'scan', 'ops')
       and k.relkind in ('r', 'p')
       and not k.relispartition
     order by 1, 2
  loop
    execute format('create trigger %I before update on %I.%I for each row execute function ops.set_updated_at()',
                   'trg_' || r.table_name || '_updated_at', r.table_schema, r.table_name);
  end loop;
end $$;

create trigger trg_import_batch_terminal before update on md.import_batch
  for each row execute function md.guard_import_batch_terminal();

create trigger trg_market_bar_history after update on md.market_bar
  for each row execute function md.capture_bar_history();

create trigger trg_audit_append_only before update or delete on audit.audit_event
  for each row execute function audit.append_only_guard();
create trigger trg_audit_append_only before update or delete on audit.security_event
  for each row execute function audit.append_only_guard();

create trigger trg_audit_chain before insert on audit.audit_event
  for each row execute function audit.chain_hash();

-- INV-19, BR-011, BR-012: a bar's session_date is a trading day of its exchange, the bar starts inside that
-- session, and session_date is the exchange-local date of bucket_start. Checked at commit, because a
-- reference import may write the calendar row in the same transaction.
create or replace function md.check_bar_session() returns trigger
language plpgsql as $$
declare
  v_timezone text;
  v_trading  boolean;
  v_open     timestamptz;
  v_close    timestamptz;
begin
  select e.timezone, c.is_trading_day, c.session_open_at, c.session_close_at
    into v_timezone, v_trading, v_open, v_close
    from ref.instrument i
    join ref.exchange e on e.id = i.exchange_id
    left join ref.trading_calendar c
      on c.exchange_id = i.exchange_id and c.calendar_date = new.session_date
   where i.id = new.instrument_id;

  if v_trading is not true then
    raise exception 'market_bar (%, %, %): % is not a trading day of its exchange',
      new.instrument_id, new.timeframe, new.bucket_start, new.session_date
      using errcode = 'check_violation';
  end if;
  if new.bucket_start < v_open or new.bucket_start >= v_close then
    raise exception 'market_bar (%, %, %): bucket_start is outside the session [%, %)',
      new.instrument_id, new.timeframe, new.bucket_start, v_open, v_close
      using errcode = 'check_violation';
  end if;
  if (new.bucket_start at time zone v_timezone)::date <> new.session_date then
    raise exception 'market_bar (%, %, %): session_date % is not the exchange-local date of bucket_start',
      new.instrument_id, new.timeframe, new.bucket_start, new.session_date
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger trg_market_bar_session after insert or update on md.market_bar
  deferrable initially deferred
  for each row execute function md.check_bar_session();

-- INV-13: a role is never assigned to a deactivated user.
create or replace function iam.guard_role_assignment() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from iam.app_user where id = new.user_id and status = 'DEACTIVATED') then
    raise exception 'cannot assign a role to deactivated user %', new.user_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_user_role_active before insert or update on iam.user_role
  for each row execute function iam.guard_role_assignment();
