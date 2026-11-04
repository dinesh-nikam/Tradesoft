-- Generated from docs/architecture/02-database.md, section "2.". Immutable once applied (02 §8).

create extension if not exists pgcrypto;   -- digest(), gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email
create extension if not exists pg_trgm;    -- instrument search

create schema if not exists iam;        -- identity and access
create schema if not exists ref;        -- market reference data
create schema if not exists md;         -- market data and ingestion
create schema if not exists an;         -- analytics and derived series
create schema if not exists scan;       -- scanners and saved views
create schema if not exists ops;        -- jobs, outbox, settings
create schema if not exists audit;      -- audit and security events
