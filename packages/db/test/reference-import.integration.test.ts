import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  effectiveMembers,
  importReference,
  migrate,
  resolveGroup,
  resolveSymbol,
  sessionBounds,
  type ReferenceKind,
} from '../src/index.ts';

const adminUrl = testDatabaseUrl();

describe.skipIf(!adminUrl)('REFERENCE import batches (08 Phase 4)', { timeout: 60_000 }, () => {
  let db: ScratchDatabase;
  let c: pg.Client;
  const load = (kind: ReferenceKind, csv: string, exchangeCode = 'NSE') =>
    importReference(c, {
      kind,
      exchangeCode,
      csv,
      actorType: 'SYSTEM',
      requestedBy: null,
      correlationId: randomUUID(),
    });
  const count = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;
  const idOf = async (symbol: string) => {
    const r = await resolveSymbol(c, { exchangeCode: 'NSE', symbol, asOf: '2026-11-03' });
    return r.kind === 'FOUND' ? r.instrumentId : null;
  };

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    c = await db.connect();
    await migrate(c);
    await c.query(
      `insert into ref.exchange (code, name, default_open_time, default_close_time)
       values ('NSE', 'National Stock Exchange', '09:15', '15:30')`,
    );
    await c.query(
      `insert into ref.sector (code, name) values ('FIN', 'Financials'), ('IT', 'Information Technology')`,
    );
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await db?.drop();
  }, 60_000);

  const INSTRUMENTS = [
    'symbol,name,instrument_type,asset_class,isin,tick_size,listing_date,is_synthetic',
    'HDFCBANK,HDFC Bank Ltd,EQUITY,EQUITY,INE040A01034,0.05,1995-11-08,N',
    'NIFTYBANK,Nifty Bank,INDEX,EQUITY,,0.05,,N',
    'GOLDBEES,"Gold ETF, proxy",ETF,COMMODITY,,0.01,,N',
    'SILVERBEES,Silver ETF proxy,ETF,COMMODITY,,0.01,,N',
    'GSCOMP,GS Composite,INDEX,COMMODITY,,0.01,,Y',
  ].join('\n');

  it('loads instruments as one completed batch with an audit event per row, and replays the same file', async () => {
    const first = await load('INSTRUMENTS', INSTRUMENTS);
    expect(first).toMatchObject({
      status: 'COMPLETED',
      replay: false,
      totalRows: 5,
      acceptedRows: 5,
      changedRows: 5,
    });
    const batch = await c.query(
      `select batch_type, status, completed_at is not null as done from md.import_batch where id = $1`,
      [first.batchId],
    );
    expect(batch.rows[0]).toEqual({ batch_type: 'REFERENCE', status: 'COMPLETED', done: true });
    expect(await count("audit.audit_event where action = 'instrument.created'")).toBe(5);
    expect(await count("ref.instrument where is_synthetic and symbol = 'GSCOMP'")).toBe(1);

    const again = await load('INSTRUMENTS', INSTRUMENTS);
    expect(again).toMatchObject({ batchId: first.batchId, replay: true, status: 'COMPLETED' });
    expect(await count("md.import_batch where batch_type = 'REFERENCE'")).toBe(1);
  });

  it('rejects the whole batch when one row is bad, applying nothing and recording each reject', async () => {
    const before = await count('ref.instrument');
    const result = await load(
      'INSTRUMENTS',
      [
        'symbol,name,instrument_type,asset_class,tick_size',
        'TCS,Tata Consultancy Services,EQUITY,EQUITY,0.05',
        'BAD1,Bad type,STOCK,EQUITY,0.05',
        'BAD2,Bad tick,EQUITY,EQUITY,0',
        'TCS,Repeated,EQUITY,EQUITY,0.05',
        'SHORT,Too few fields',
        'HDFCBANK,HDFC Bank Ltd,EQUITY,EQUITY,0.05',
      ].join('\n'),
    );
    expect(result).toMatchObject({
      status: 'VALIDATION_FAILED',
      totalRows: 6,
      rejectedRows: 4,
      acceptedRows: 2,
      changedRows: 0,
    });
    expect(result.rejects.map((r) => [r.rowNumber, r.code, r.field])).toEqual([
      [2, 'VALUE_INVALID', 'instrument_type'],
      [3, 'VALUE_INVALID', 'tick_size'],
      [4, 'DUPLICATE_IN_FILE', null],
      [5, 'ROW_MALFORMED', null],
    ]);
    expect(await count('ref.instrument')).toBe(before);
    expect(await count('md.ingestion_reject where import_batch_id = $1', [result.batchId])).toBe(4);
    // The HDFCBANK row, though valid, changed nothing in the database either.
    expect(await count("audit.audit_event where action = 'instrument.updated'")).toBe(0);
  });

  it('fails at the header before reading rows (03 §3.1)', async () => {
    expect((await load('CALENDAR', 'date,is_trading_day,closes\n2026-11-03,Y,15:30')).rejects).toEqual([
      expect.objectContaining({ rowNumber: 0, code: 'HEADER_UNKNOWN_FIELD' }),
    ]);
    expect((await load('CALENDAR', 'date,session_open\n2026-11-03,09:15')).rejects).toEqual([
      expect.objectContaining({ rowNumber: 0, code: 'HEADER_MISSING_REQUIRED' }),
    ]);
    expect((await load('CALENDAR', 'date,is_trading_day\n')).rejects[0]!.code).toBe('FILE_EMPTY');
    await expect(load('CALENDAR', 'date,is_trading_day\n2026-11-03,N', 'XYZ')).rejects.toMatchObject({
      code: 'EXCHANGE_NOT_FOUND',
    });
  });

  it('loads a calendar in exchange-local time that sessionBounds then serves (A8, E4.2)', async () => {
    const bad = await load(
      'CALENDAR',
      'date,is_trading_day,session_open,session_close\n2026-11-09,N,09:15,15:30',
    );
    expect(bad.rejects[0]!.code).toBe('SESSION_BOUNDS_UNEXPECTED');
    const ok = await load(
      'CALENDAR',
      [
        'Date,Is Trading Day,Session Open,Session Close,Is Special,Description',
        '2026-11-06,Y,09:15,15:30,N,',
        '2026-11-08,Y,18:00,19:00,Y,Muhurat trading',
        '2026-11-09,N,,,N,Diwali Balipratipada',
      ].join('\r\n'),
    );
    expect(ok).toMatchObject({ status: 'COMPLETED', changedRows: 3 });
    const normal = await sessionBounds(c, 'NSE', '2026-11-06');
    expect(normal.openAt?.toISOString()).toBe('2026-11-06T03:45:00.000Z');
    expect(await sessionBounds(c, 'NSE', '2026-11-08')).toMatchObject({
      isSpecial: true,
      description: 'Muhurat trading',
    });
    expect(await sessionBounds(c, 'NSE', '2026-11-09')).toMatchObject({ isTradingDay: false });
    // Changing one day changes one row; the others are reported unchanged.
    const moved = await load(
      'CALENDAR',
      'date,is_trading_day,session_open,session_close,is_special,description\n' +
        '2026-11-06,Y,09:15,15:00,N,\n2026-11-09,N,,,N,Diwali Balipratipada',
    );
    expect(moved).toMatchObject({ status: 'COMPLETED', changedRows: 1 });
  });

  it('loads memberships by symbol as of their start date, with BR-004 reclassification', async () => {
    const sectors = await load(
      'SECTOR_MEMBERSHIPS',
      'symbol,sector_code,effective_from\nHDFCBANK,FIN,2020-01-01\nHDFCBANK,IT,2024-04-01',
    );
    expect(sectors).toMatchObject({ status: 'COMPLETED', changedRows: 2 });
    const { rows } = await c.query(
      `select s.code, m.effective_to::text as "to" from ref.instrument_sector_membership m join ref.sector s on s.id = m.sector_id
        order by m.effective_from`,
    );
    expect(rows).toEqual([
      { code: 'FIN', to: '2024-03-31' },
      { code: 'IT', to: null },
    ]);
    const unknown = await load(
      'SECTOR_MEMBERSHIPS',
      'symbol,sector_code,effective_from\nNOPE,FIN,2020-01-01\nHDFCBANK,ENERGY,2020-01-01',
    );
    expect(unknown.rejects.map((r) => r.code)).toEqual(['SYMBOL_UNKNOWN', 'SECTOR_UNKNOWN']);

    const index = await load(
      'INDEX_MEMBERSHIPS',
      'index_symbol,symbol,effective_from,effective_to,weight\nNIFTYBANK,HDFCBANK,2020-01-01,,28.5',
    );
    expect(index.status).toBe('COMPLETED');
    expect(await effectiveMembers(c, (await idOf('NIFTYBANK'))!, '2026-11-03')).toEqual([
      { instrumentId: await idOf('HDFCBANK'), weight: '28.500000' },
    ]);
    const notIndex = await load(
      'INDEX_MEMBERSHIPS',
      'index_symbol,symbol,effective_from\nHDFCBANK,GOLDBEES,2020-01-01',
    );
    expect(notIndex.rejects[0]!.code).toBe('VALIDATION_FAILED');
  });

  it('loads corporate actions with type rules and upserts them on re-import', async () => {
    const bad = await load(
      'CORPORATE_ACTIONS',
      'symbol,action_type,ex_date,cash_amount\nHDFCBANK,DIVIDEND,2024-05-10,',
    );
    expect(bad.rejects[0]!.code).toBe('CORPORATE_ACTION_INVALID');
    const header = 'symbol,action_type,ex_date,ratio_from,ratio_to,cash_amount';
    const first = await load(
      'CORPORATE_ACTIONS',
      `${header}\nHDFCBANK,SPLIT,2019-09-19,2,1,\nHDFCBANK,DIVIDEND,2024-05-10,,,"19.50"`,
    );
    expect(first).toMatchObject({ status: 'COMPLETED', changedRows: 2 });
    const second = await load(
      'CORPORATE_ACTIONS',
      `${header}\nHDFCBANK,DIVIDEND,2024-05-10,,,19.5\nHDFCBANK,DIVIDEND,2025-05-09,,,22`,
    );
    expect(second).toMatchObject({ status: 'COMPLETED', changedRows: 1 });
    expect(await count('ref.corporate_action')).toBe(3);
    expect(await count("audit.audit_event where action = 'corporate_action.updated'")).toBe(0);
  });

  it('defines the GS Composite as a system group of its proxies (A11, 04 §7.8)', async () => {
    const user = await c.query<{ id: string }>(
      `insert into ref.market_group (code, name, group_type) values ('MINE', 'Mine', 'CUSTOM') returning id::text as id`,
    );
    const result = await load(
      'GROUP_MEMBERS',
      [
        'group_code,group_name,group_type,symbol,added_on',
        'GS_COMPOSITE,GS Composite,COMPOSITE,GOLDBEES,2020-01-01',
        'GS_COMPOSITE,GS Composite,COMPOSITE,SILVERBEES,2020-01-01',
      ].join('\n'),
    );
    expect(result).toMatchObject({ status: 'COMPLETED', changedRows: 2 });
    const group = await c.query<{ id: string; isSystem: boolean }>(
      `select id::text as id, is_system as "isSystem" from ref.market_group where code = 'GS_COMPOSITE'`,
    );
    expect(group.rows[0]!.isSystem).toBe(true);
    expect(await resolveGroup(c, group.rows[0]!.id, '2026-11-03')).toEqual(
      [await idOf('GOLDBEES'), await idOf('SILVERBEES')].sort(),
    );
    const userGroup = await load('GROUP_MEMBERS', 'group_code,symbol,added_on\nMINE,GOLDBEES,2020-01-01');
    expect(userGroup.rejects[0]!.code).toBe('GROUP_NOT_SYSTEM');
    expect(await resolveGroup(c, user.rows[0]!.id, '2026-11-03')).toEqual([]);
  });
});
