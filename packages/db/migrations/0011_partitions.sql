-- Monthly range partitions named <table>_yYYYYmMM, bounded at UTC month starts (02 §6). Idempotent:
-- maintenance.partition_rollover calls it daily to keep the three-month forward runway.
create or replace function ops.ensure_monthly_partitions(p_parent regclass, p_from date, p_to date)
returns integer
language plpgsql as $$
declare
  v_schema  text;
  v_table   text;
  v_month   date := date_trunc('month', p_from)::date;
  v_name    text;
  v_created integer := 0;
begin
  select n.nspname, c.relname into v_schema, v_table
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_parent;
  while v_month < p_to loop
    v_name := format('%s_y%sm%s', v_table, to_char(v_month, 'YYYY'), to_char(v_month, 'MM'));
    if to_regclass(format('%I.%I', v_schema, v_name)) is null then
      execute format('create table %I.%I partition of %I.%I for values from (%L) to (%L)',
                     v_schema, v_name, v_schema, v_table,
                     v_month::timestamp at time zone 'UTC',
                     (v_month + interval '1 month')::timestamp at time zone 'UTC');
      v_created := v_created + 1;
    end if;
    v_month := (v_month + interval '1 month')::date;
  end loop;
  return v_created;
end $$;

-- Market data reaches back to January 2015, covering the ten years of daily history of 00 A2. Audit and
-- bar history start at the current month. Every table gets the current month plus three months ahead.
select ops.ensure_monthly_partitions('md.market_bar', date '2015-01-01',
                                     (date_trunc('month', now()) + interval '4 months')::date);
select ops.ensure_monthly_partitions('an.indicator_value', date '2015-01-01',
                                     (date_trunc('month', now()) + interval '4 months')::date);
select ops.ensure_monthly_partitions('md.market_bar_history', date_trunc('month', now())::date,
                                     (date_trunc('month', now()) + interval '4 months')::date);
select ops.ensure_monthly_partitions('audit.audit_event', date_trunc('month', now())::date,
                                     (date_trunc('month', now()) + interval '4 months')::date);
