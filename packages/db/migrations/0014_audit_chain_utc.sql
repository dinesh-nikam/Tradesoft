-- 06 §14.2's chain hashed occurred_at::text, which PostgreSQL renders in the writing session's TimeZone: the
-- same row hashed differently for a writer and a verifier in different time zones. The hash now renders
-- occurred_at in UTC, and one function serves both the insert trigger and verification.
create or replace function audit.event_hash(p_prev bytea, e audit.audit_event) returns bytea
language sql stable as $$
  select public.digest(
    coalesce(p_prev, ''::bytea)
    || convert_to(
         e.id::text
         || '|' || to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         || '|' || e.action || '|' || e.entity_type || '|' || e.entity_id
         || '|' || coalesce(e.actor_type, '') || '|' || coalesce(e.actor_user_id::text, '')
         || '|' || coalesce(e.after::text, '') || '|' || coalesce(e.before::text, ''),
         'UTF8'),
    'sha256')
$$;

create or replace function audit.chain_hash() returns trigger
language plpgsql as $$
declare
  v_prev bytea;
begin
  -- One chain, low volume: serialise writers so id order equals chain order (06 §14.2).
  perform pg_advisory_xact_lock(hashtext('audit.chain'));
  if new.id is null then
    new.id := nextval(pg_get_serial_sequence('audit.audit_event', 'id'));
  end if;
  select hash into v_prev from audit.audit_event order by id desc limit 1;
  new.prev_hash := v_prev;
  new.hash := audit.event_hash(v_prev, new);
  return new;
end $$;

-- The chain trigger and the verifier read "the row with the highest id"; the primary key leads with
-- occurred_at, so without this index every audit insert scanned the whole trail.
create index ix_audit_event_id on audit.audit_event (id);
