-- Cluster-level roles of 02 §2. Run once per cluster as a superuser before the first migration; safe to
-- re-run. Passwords are set separately from the secret store (ALTER ROLE ... PASSWORD); none lives here.
do $$
declare
  r text;
begin
  foreach r in array array['tradesoft_migrator', 'tradesoft_app', 'tradesoft_readonly'] loop
    begin
      execute format('create role %I login', r);
    exception when duplicate_object or unique_violation then
      null;
    end;
  end loop;
  execute format('grant create on database %I to tradesoft_migrator', current_database());
end $$;
