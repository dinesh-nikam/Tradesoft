-- 05 §12.11: an INTRADAY_CSV upload declares a timeframe that every row must match. The batch row had no
-- column for it, and the rows are validated after the upload request has returned, so it is stored here.
alter table md.import_batch add column timeframe text references ref.timeframe(code) on delete restrict;
alter table md.import_batch add constraint ck_import_batch_timeframe
  check ((batch_type = 'INTRADAY_CSV') = (timeframe is not null));

-- 03 §2.2: rejection row numbers are data-row numbers; the header's own line number is kept on the batch.
alter table md.import_batch add column header_line integer;
