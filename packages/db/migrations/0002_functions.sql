-- Generated from docs/architecture/02-database.md, section "7.". Immutable once applied (02 §8).

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
