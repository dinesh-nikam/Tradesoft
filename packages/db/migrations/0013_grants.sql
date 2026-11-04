-- Least privilege (02 §2). The three roles are cluster-level and exist before the first migration
-- (infra/postgres/roles.sql); a missing role fails this migration rather than leaving privileges unset.
grant usage on schema iam, ref, md, an, scan, ops, audit to tradesoft_app;
grant select, insert, update, delete on all tables in schema iam, ref, md, an, scan, ops to tradesoft_app;
grant usage, select on all sequences in schema iam, ref, md, an, scan, ops, audit to tradesoft_app;
-- INV-14: the audit trail is append-only for the application.
grant select, insert on all tables in schema audit to tradesoft_app;
-- The application reads the migration ledger and never writes it.
revoke insert, update, delete on ops.schema_migration from tradesoft_app;

grant usage on schema ref, md, an, scan to tradesoft_readonly;
grant select on all tables in schema ref, md, an, scan to tradesoft_readonly;

-- Tables and partitions created by later migrations and by partition rollover.
alter default privileges in schema iam, ref, md, an, scan, ops
  grant select, insert, update, delete on tables to tradesoft_app;
alter default privileges in schema audit grant select, insert on tables to tradesoft_app;
alter default privileges in schema iam, ref, md, an, scan, ops, audit
  grant usage, select on sequences to tradesoft_app;
alter default privileges in schema ref, md, an, scan grant select on tables to tradesoft_readonly;
