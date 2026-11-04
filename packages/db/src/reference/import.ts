import { createHash } from 'node:crypto';
import type pg from 'pg';
import { DomainError, instrumentMachine, transition } from '@tradesoft/domain';
import { recordAudit, type AuditEvent } from '../audit.ts';
import { parseCsv } from './csv.ts';
import { getInstrument, resolveSymbol } from './index.ts';
import { addIndexMember, addSectorMembership } from './write.ts';

/**
 * `REFERENCE` import batches (08 Phase 4): calendars, instruments, memberships, corporate actions and
 * system-group members loaded from CSV. A batch is all or nothing: every row is validated by applying it
 * inside the batch transaction, and one rejected row rolls every row back and fails the batch, because a
 * half-loaded calendar or index is worse than none. Re-importing the same file replays the first batch.
 */

export const REFERENCE_KINDS = [
  'CALENDAR',
  'INSTRUMENTS',
  'SECTOR_MEMBERSHIPS',
  'INDEX_MEMBERSHIPS',
  'CORPORATE_ACTIONS',
  'GROUP_MEMBERS',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ReferenceImportRequest {
  kind: ReferenceKind;
  exchangeCode: string;
  csv: string;
  actorType: AuditEvent['actorType'];
  requestedBy: string | null;
  correlationId: string;
}

export interface RowReject {
  rowNumber: number;
  code: string;
  message: string;
  field: string | null;
}

export interface ReferenceImportResult {
  batchId: string;
  status: 'COMPLETED' | 'VALIDATION_FAILED';
  replay: boolean;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  changedRows: number;
  /** The first 50 rejects, or the file-level failure as row 0. */
  rejects: RowReject[];
}

class Reject extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

type Row = Record<string, string | undefined>;
type AuditInput = Omit<AuditEvent, 'actorType' | 'actorUserId' | 'correlationId'>;

interface Ctx {
  c: pg.ClientBase;
  exchangeId: string;
  exchangeCode: string;
  timezone: string;
  audit(e: AuditInput): Promise<unknown>;
}

interface Profile {
  required: string[];
  optional: string[];
  /** The in-file identity of a row; a repeat is `DUPLICATE_IN_FILE` (03 §3.3). */
  key(r: Row): string;
  /** Applies one row; returns whether anything changed. */
  apply(ctx: Ctx, r: Row): Promise<boolean>;
}

// ---------------------------------------------------------------------------- field parsing (03 §2.2)
const ABSENT = new Set(['', '-', 'NA', 'N/A', 'NULL']);
const opt = (r: Row, f: string) => {
  const v = r[f];
  return v === undefined || ABSENT.has(v.toUpperCase()) ? undefined : v;
};
const req = (r: Row, f: string) => {
  const v = opt(r, f);
  if (v === undefined) throw new Reject('FIELD_REQUIRED', `${f} is required`, f);
  return v;
};
function date(v: string | undefined, f: string): string | undefined {
  if (v === undefined) return undefined;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  if (!ok || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v)
    throw new Reject('DATE_INVALID', `${f} is not a YYYY-MM-DD date`, f);
  return v;
}
function bool(v: string | undefined, f: string): boolean | undefined {
  if (v === undefined) return undefined;
  const u = v.toUpperCase();
  if (['Y', 'YES', 'TRUE', '1'].includes(u)) return true;
  if (['N', 'NO', 'FALSE', '0'].includes(u)) return false;
  throw new Reject('VALUE_INVALID', `${f} must be Y or N`, f);
}
function time(v: string | undefined, f: string): string | undefined {
  if (v === undefined) return undefined;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(v);
  if (!m) throw new Reject('TIME_INVALID', `${f} is not HH:MM`, f);
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
}
/** Thousands separators are stripped (03 §2.2); the result is a plain decimal string. */
function decimal(v: string | undefined, f: string, scale: number): string | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(/[, ]/g, '');
  if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${scale}})?$`).test(s))
    throw new Reject('DECIMAL_INVALID', `${f} is not a non-negative decimal with up to ${scale} places`, f);
  return s;
}
function int(v: string | undefined, f: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new Reject('VALUE_INVALID', `${f} is not a whole number`, f);
  return Number(v);
}
function oneOf<T extends string>(v: string | undefined, f: string, values: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  const u = v.toUpperCase() as T;
  if (!values.includes(u)) throw new Reject('VALUE_INVALID', `${f} must be one of ${values.join(', ')}`, f);
  return u;
}
function text(v: string | undefined, f: string, max: number, pattern?: RegExp): string | undefined {
  if (v === undefined) return undefined;
  if (v.length > max) throw new Reject('FIELD_TOO_LONG', `${f} exceeds ${max} characters`, f);
  if (pattern && !pattern.test(v)) throw new Reject('VALUE_INVALID', `${f} has an invalid format`, f);
  return v;
}
const SYMBOL = /^[A-Z0-9][A-Z0-9&_.~-]{0,31}$/;
const series = (r: Row) => text(opt(r, 'series'), 'series', 4, /^[A-Z0-9]{0,4}$/) ?? '';

async function instrumentAt(ctx: Ctx, symbol: string, ser: string, asOf: string, field = 'symbol') {
  const found = await resolveSymbol(ctx.c, { exchangeCode: ctx.exchangeCode, symbol, series: ser, asOf });
  if (found.kind === 'UNKNOWN')
    throw new Reject('SYMBOL_UNKNOWN', `${symbol} names no ${ctx.exchangeCode} instrument on ${asOf}`, field);
  if (found.kind === 'AMBIGUOUS')
    throw new Reject(
      'SYMBOL_AMBIGUOUS',
      `${symbol} names ${found.instrumentIds.length} instruments on ${asOf}`,
      field,
    );
  return found.instrumentId;
}

const one = async <T extends pg.QueryResultRow>(c: pg.ClientBase, sql: string, params: unknown[]) =>
  (await c.query<T>(sql, params)).rows[0];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------------------ profiles
const INSTRUMENT_TYPES = ['EQUITY', 'INDEX', 'FUTURE', 'OPTION', 'ETF', 'BOND', 'CURRENCY', 'FUND'] as const;
const ASSET_CLASSES = ['EQUITY', 'COMMODITY', 'FX', 'FIXED_INCOME', 'RATE'] as const;
const ACTION_TYPES = ['SPLIT', 'BONUS', 'DIVIDEND', 'RIGHTS', 'MERGER', 'DEMERGER', 'SYMBOL_CHANGE'] as const;
const GROUP_TYPES = ['SECTOR', 'INDEX', 'CUSTOM', 'BENCHMARK', 'COMPOSITE'] as const;
const CALENDAR_DAY = `is_trading_day as "isTradingDay", session_open_at as "openAt",
  session_close_at as "closeAt", is_special as "isSpecial", description`;

const PROFILES: Record<ReferenceKind, Profile> = {
  // Session times are exchange-local wall-clock times, converted with the exchange's time zone (A8).
  CALENDAR: {
    required: ['date', 'is_trading_day'],
    optional: ['session_open', 'session_close', 'is_special', 'description'],
    key: (r) => r['date'] ?? '',
    async apply(ctx, r) {
      const day = date(req(r, 'date'), 'date')!;
      const trading = bool(req(r, 'is_trading_day'), 'is_trading_day')!;
      const open = time(opt(r, 'session_open'), 'session_open');
      const close = time(opt(r, 'session_close'), 'session_close');
      if (trading && (!open || !close))
        throw new Reject(
          'SESSION_BOUNDS_MISSING',
          'A trading day needs session_open and session_close',
          'session_open',
        );
      if (!trading && (open || close))
        throw new Reject('SESSION_BOUNDS_UNEXPECTED', 'A holiday has no session times', 'session_open');
      if (open && close && close <= open)
        throw new Reject(
          'SESSION_BOUNDS_INVALID',
          'session_close is not after session_open',
          'session_close',
        );
      const description = text(opt(r, 'description'), 'description', 200) ?? null;
      const special = bool(opt(r, 'is_special'), 'is_special') ?? false;
      const after = (await one<Record<string, unknown>>(
        ctx.c,
        `select $1::boolean as "isTradingDay", ($2::date + $3::time) at time zone $5 as "openAt",
                ($2::date + $4::time) at time zone $5 as "closeAt", $6::boolean as "isSpecial",
                $7::text as description`,
        [trading, day, open ?? null, close ?? null, ctx.timezone, special, description],
      ))!;
      const before = await one<Record<string, unknown>>(
        ctx.c,
        `select ${CALENDAR_DAY} from ref.trading_calendar where exchange_id = $1 and calendar_date = $2`,
        [ctx.exchangeId, day],
      );
      if (before && same(before, after)) return false;
      if (before) {
        const bars = await ctx.c.query(
          `select 1 from md.market_bar b join ref.instrument i on i.id = b.instrument_id
            where i.exchange_id = $1 and b.session_date = $2 and $2 < current_date limit 1`,
          [ctx.exchangeId, day],
        );
        if (bars.rowCount)
          throw new Reject('CALENDAR_DAY_NOT_EDITABLE', `Bars exist for the past session ${day}`, 'date');
      }
      await ctx.c.query(
        `insert into ref.trading_calendar (exchange_id, calendar_date, is_trading_day, session_open_at,
           session_close_at, is_special, description, source)
         values ($1, $2, $3, $4, $5, $6, $7, 'IMPORT')
         on conflict (exchange_id, calendar_date) do update set is_trading_day = excluded.is_trading_day,
           session_open_at = excluded.session_open_at, session_close_at = excluded.session_close_at,
           is_special = excluded.is_special, description = excluded.description, source = 'IMPORT',
           updated_at = now()`,
        [ctx.exchangeId, day, trading, after['openAt'], after['closeAt'], special, description],
      );
      await ctx.audit({
        action: 'calendar.day_saved',
        entityType: 'trading_calendar',
        entityId: `${ctx.exchangeCode}:${day}`,
        before: before ?? null,
        after,
      });
      return true;
    },
  },

  // Upserts by (exchange, symbol, series). A delisting date delists; a delisted instrument is never
  // re-activated (01 §3.5): a re-listing is a new instrument, with the old symbol kept as an alias.
  INSTRUMENTS: {
    required: ['symbol', 'name', 'instrument_type', 'asset_class'],
    optional: [
      'series',
      'isin',
      'currency',
      'lot_size',
      'tick_size',
      'price_precision',
      'listing_date',
      'delisting_date',
      'is_synthetic',
    ],
    key: (r) => `${r['symbol']}|${r['series'] ?? ''}`,
    async apply(ctx, r) {
      const v = {
        symbol: text(req(r, 'symbol'), 'symbol', 32, SYMBOL)!,
        series: series(r),
        name: text(req(r, 'name'), 'name', 200)!,
        instrumentType: oneOf(req(r, 'instrument_type'), 'instrument_type', INSTRUMENT_TYPES)!,
        assetClass: oneOf(req(r, 'asset_class'), 'asset_class', ASSET_CLASSES)!,
        isin: text(opt(r, 'isin'), 'isin', 12, /^[A-Z]{2}[A-Z0-9]{9}\d$/) ?? null,
        currency: text(opt(r, 'currency'), 'currency', 3, /^[A-Z]{3}$/) ?? 'INR',
        lotSize: int(opt(r, 'lot_size'), 'lot_size') ?? 1,
        tickSize: decimal(opt(r, 'tick_size'), 'tick_size', 6) ?? '0.05',
        pricePrecision: int(opt(r, 'price_precision'), 'price_precision') ?? 2,
        listingDate: date(opt(r, 'listing_date'), 'listing_date') ?? null,
        delistingDate: date(opt(r, 'delisting_date'), 'delisting_date') ?? null,
        isSynthetic: bool(opt(r, 'is_synthetic'), 'is_synthetic') ?? false,
      };
      if (v.lotSize < 1) throw new Reject('VALUE_INVALID', 'lot_size must be at least 1', 'lot_size');
      if (Number(v.tickSize) <= 0)
        throw new Reject('VALUE_INVALID', 'tick_size must be positive', 'tick_size');
      if (v.pricePrecision > 6)
        throw new Reject('VALUE_INVALID', 'price_precision is at most 6', 'price_precision');
      const params = [
        v.isin,
        v.name,
        v.instrumentType,
        v.assetClass,
        v.currency,
        v.lotSize,
        v.tickSize,
        v.pricePrecision,
        v.listingDate,
        v.delistingDate,
        v.isSynthetic,
      ];
      const existing = await one<{ id: string; status: string }>(
        ctx.c,
        'select id::text as id, status from ref.instrument where exchange_id = $1 and symbol = $2 and series = $3',
        [ctx.exchangeId, v.symbol, v.series],
      );
      if (!existing) {
        const { id } = (await one<{ id: string }>(
          ctx.c,
          `insert into ref.instrument (exchange_id, symbol, series, isin, name, instrument_type, asset_class,
             currency, lot_size, tick_size, price_precision, listing_date, delisting_date, is_synthetic, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   case when $13::date is null then 'ACTIVE' else 'DELISTED' end)
           returning id::text as id`,
          [ctx.exchangeId, v.symbol, v.series, ...params],
        ))!;
        await ctx.audit({
          action: 'instrument.created',
          entityType: 'instrument',
          entityId: id,
          after: await getInstrument(ctx.c, id),
        });
        return true;
      }
      if (existing.status === 'DELISTED' && v.delistingDate === null)
        throw new Reject(
          'INSTRUMENT_DELISTED',
          'A delisted instrument is not re-activated; import the re-listing as a new symbol',
          'delisting_date',
        );
      if (v.delistingDate !== null && existing.status !== 'DELISTED')
        transition(instrumentMachine, existing.status as Parameters<typeof transition>[1], 'DELIST');
      const before = await getInstrument(ctx.c, existing.id);
      await ctx.c.query(
        `update ref.instrument set isin = $2, name = $3, instrument_type = $4, asset_class = $5, currency = $6,
           lot_size = $7, tick_size = $8, price_precision = $9, listing_date = $10, delisting_date = $11,
           is_synthetic = $12, status = case when $11::date is null then status else 'DELISTED' end
         where id = $1`,
        [existing.id, ...params],
      );
      const after = await getInstrument(ctx.c, existing.id);
      if (same(before, after)) return false;
      await ctx.c.query('update ref.instrument set updated_at = now() where id = $1', [existing.id]);
      await ctx.audit({
        action: 'instrument.updated',
        entityType: 'instrument',
        entityId: existing.id,
        before,
        after,
      });
      return true;
    },
  },

  SECTOR_MEMBERSHIPS: {
    required: ['symbol', 'sector_code', 'effective_from'],
    optional: ['series', 'effective_to'],
    key: (r) => `${r['symbol']}|${r['series'] ?? ''}|${r['sector_code']}|${r['effective_from']}`,
    async apply(ctx, r) {
      const from = date(req(r, 'effective_from'), 'effective_from')!;
      const to = date(opt(r, 'effective_to'), 'effective_to') ?? null;
      const instrumentId = await instrumentAt(ctx, req(r, 'symbol'), series(r), from);
      const code = req(r, 'sector_code');
      const sector = await one<{ id: string }>(
        ctx.c,
        'select id::text as id from ref.sector where code = $1',
        [code],
      );
      if (!sector) throw new Reject('SECTOR_UNKNOWN', `No sector ${code}`, 'sector_code');
      const result = await addSectorMembership(ctx.c, {
        instrumentId,
        sectorId: sector.id,
        effectiveFrom: from,
        effectiveTo: to,
        source: 'IMPORT',
      });
      if (result.outcome === 'UNCHANGED') return false;
      await ctx.audit({
        action:
          result.outcome === 'ADDED'
            ? 'instrument.sector_membership_added'
            : 'instrument.sector_membership_updated',
        entityType: 'instrument',
        entityId: instrumentId,
        before: result.outcome === 'UPDATED' ? result.before : null,
        after: {
          sectorId: sector.id,
          effectiveFrom: from,
          effectiveTo: to,
          closedSectorId: result.outcome === 'ADDED' ? result.closedSectorId : null,
        },
      });
      return true;
    },
  },

  INDEX_MEMBERSHIPS: {
    required: ['index_symbol', 'symbol', 'effective_from'],
    optional: ['series', 'effective_to', 'weight'],
    key: (r) => `${r['index_symbol']}|${r['symbol']}|${r['series'] ?? ''}|${r['effective_from']}`,
    async apply(ctx, r) {
      const from = date(req(r, 'effective_from'), 'effective_from')!;
      const to = date(opt(r, 'effective_to'), 'effective_to') ?? null;
      const weight = decimal(opt(r, 'weight'), 'weight', 6) ?? null;
      if (weight !== null && Number(weight) > 100)
        throw new Reject('VALUE_INVALID', 'weight is a percentage up to 100', 'weight');
      const indexId = await instrumentAt(ctx, req(r, 'index_symbol'), '', from, 'index_symbol');
      const memberId = await instrumentAt(ctx, req(r, 'symbol'), series(r), from);
      const result = await addIndexMember(ctx.c, {
        indexId,
        memberId,
        effectiveFrom: from,
        effectiveTo: to,
        weight,
      });
      if (result.outcome === 'UNCHANGED') return false;
      await ctx.audit({
        action: result.outcome === 'ADDED' ? 'instrument.member_added' : 'instrument.member_updated',
        entityType: 'instrument',
        entityId: indexId,
        before: result.outcome === 'UPDATED' ? result.before : null,
        after: { memberInstrumentId: memberId, effectiveFrom: from, effectiveTo: to, weight },
      });
      return true;
    },
  },

  // Upserts by (instrument, action type, ex-date). Adjustment factors are derived from these in Phase 6.
  CORPORATE_ACTIONS: {
    required: ['symbol', 'action_type', 'ex_date'],
    optional: ['series', 'record_date', 'ratio_from', 'ratio_to', 'cash_amount', 'announced_at', 'note'],
    key: (r) => `${r['symbol']}|${r['series'] ?? ''}|${r['action_type']?.toUpperCase()}|${r['ex_date']}`,
    async apply(ctx, r) {
      const exDate = date(req(r, 'ex_date'), 'ex_date')!;
      const type = oneOf(req(r, 'action_type'), 'action_type', ACTION_TYPES)!;
      const v = {
        recordDate: date(opt(r, 'record_date'), 'record_date') ?? null,
        ratioFrom: decimal(opt(r, 'ratio_from'), 'ratio_from', 6) ?? null,
        ratioTo: decimal(opt(r, 'ratio_to'), 'ratio_to', 6) ?? null,
        cashAmount: decimal(opt(r, 'cash_amount'), 'cash_amount', 4) ?? null,
        announcedAt: date(opt(r, 'announced_at'), 'announced_at') ?? null,
        note: text(opt(r, 'note'), 'note', 500) ?? null,
      };
      if ((type === 'SPLIT' || type === 'BONUS') && !(Number(v.ratioFrom) > 0 && Number(v.ratioTo) > 0))
        throw new Reject(
          'CORPORATE_ACTION_INVALID',
          `${type} needs positive ratio_from and ratio_to`,
          'ratio_from',
        );
      if (type === 'DIVIDEND' && v.cashAmount === null)
        throw new Reject('CORPORATE_ACTION_INVALID', 'DIVIDEND needs cash_amount', 'cash_amount');
      const instrumentId = await instrumentAt(ctx, req(r, 'symbol'), series(r), exDate);
      const read = `select action_type as "actionType", ex_date::text as "exDate", record_date::text as "recordDate",
          ratio_from::text as "ratioFrom", ratio_to::text as "ratioTo", cash_amount::text as "cashAmount",
          announced_at::text as "announcedAt", note
        from ref.corporate_action where instrument_id = $1 and action_type = $2 and ex_date = $3`;
      const before = await one(ctx.c, read, [instrumentId, type, exDate]);
      const { id } = (await one<{ id: string }>(
        ctx.c,
        `insert into ref.corporate_action (instrument_id, action_type, ex_date, record_date, ratio_from, ratio_to,
           cash_amount, announced_at, note, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'IMPORT')
         on conflict (instrument_id, action_type, ex_date) do update set record_date = excluded.record_date,
           ratio_from = excluded.ratio_from, ratio_to = excluded.ratio_to, cash_amount = excluded.cash_amount,
           announced_at = excluded.announced_at, note = excluded.note, source = 'IMPORT'
         returning id::text as id`,
        [
          instrumentId,
          type,
          exDate,
          v.recordDate,
          v.ratioFrom,
          v.ratioTo,
          v.cashAmount,
          v.announcedAt,
          v.note,
        ],
      ))!;
      const after = await one(ctx.c, read, [instrumentId, type, exDate]);
      if (before && same(before, after)) return false;
      await ctx.c.query('update ref.corporate_action set updated_at = now() where id = $1', [id]);
      await ctx.audit({
        action: before ? 'corporate_action.updated' : 'corporate_action.created',
        entityType: 'corporate_action',
        entityId: id,
        before: before ?? null,
        after,
      });
      return true;
    },
  },

  // Members of system groups, which the API cannot edit (GROUP_IMMUTABLE_SYSTEM): index and sector groups
  // and the GS Composite (04 §7.8). A missing group is created as a system group when the row names it.
  GROUP_MEMBERS: {
    required: ['group_code', 'symbol', 'added_on'],
    optional: ['series', 'removed_on', 'weight', 'group_name', 'group_type'],
    key: (r) => `${r['group_code']}|${r['symbol']}|${r['series'] ?? ''}|${r['added_on']}`,
    async apply(ctx, r) {
      const code = text(req(r, 'group_code'), 'group_code', 40, /^[A-Z][A-Z0-9_]{1,39}$/)!;
      const addedOn = date(req(r, 'added_on'), 'added_on')!;
      const removedOn = date(opt(r, 'removed_on'), 'removed_on') ?? null;
      if (removedOn !== null && removedOn < addedOn)
        throw new Reject('MEMBERSHIP_WINDOW_INVALID', 'removed_on is before added_on', 'removed_on');
      const weight = decimal(opt(r, 'weight'), 'weight', 6) ?? null;
      let group = await one<{ id: string; isSystem: boolean }>(
        ctx.c,
        'select id::text as id, is_system as "isSystem" from ref.market_group where code = $1 for update',
        [code],
      );
      if (!group) {
        const name = text(opt(r, 'group_name'), 'group_name', 120);
        const type = oneOf(opt(r, 'group_type'), 'group_type', GROUP_TYPES);
        if (!name || !type)
          throw new Reject(
            'GROUP_UNKNOWN',
            `No group ${code}; give group_name and group_type to create it`,
            'group_code',
          );
        group = (await one<{ id: string; isSystem: boolean }>(
          ctx.c,
          `insert into ref.market_group (code, name, group_type, is_system, is_shared)
           values ($1, $2, $3, true, true) returning id::text as id, is_system as "isSystem"`,
          [code, name, type],
        ))!;
        await ctx.audit({
          action: 'group.created',
          entityType: 'market_group',
          entityId: group.id,
          after: { code, name, groupType: type, isSystem: true },
        });
      }
      if (!group.isSystem)
        throw new Reject(
          'GROUP_NOT_SYSTEM',
          `${code} is a user group; edit it through the API`,
          'group_code',
        );
      const instrumentId = await instrumentAt(ctx, req(r, 'symbol'), series(r), addedOn);
      const existing = await one<{ removedOn: string | null; weight: string | null }>(
        ctx.c,
        `select removed_on::text as "removedOn", weight::text as weight from ref.market_group_member
          where group_id = $1 and instrument_id = $2 and added_on = $3`,
        [group.id, instrumentId, addedOn],
      );
      // `removed_on` is the first day out, so periods are half-open.
      const clash = await ctx.c.query(
        `select 1 from ref.market_group_member
          where group_id = $1 and instrument_id = $2 and added_on <> $3
            and daterange(added_on, removed_on, '[)') && daterange($3::date, $4::date, '[)')`,
        [group.id, instrumentId, addedOn, removedOn],
      );
      if (clash.rowCount)
        throw new Reject('MEMBERSHIP_OVERLAP', 'The member already has an overlapping period', 'added_on');
      const saved = (await one<{ removedOn: string | null; weight: string | null }>(
        ctx.c,
        `insert into ref.market_group_member (group_id, instrument_id, added_on, removed_on, weight)
         values ($1, $2, $3, $4, $5)
         on conflict (group_id, instrument_id, added_on) do update set removed_on = excluded.removed_on,
           weight = excluded.weight
         returning removed_on::text as "removedOn", weight::text as weight`,
        [group.id, instrumentId, addedOn, removedOn, weight],
      ))!;
      if (existing && same(existing, saved)) return false;
      await ctx.c.query('update ref.market_group set updated_at = now() where id = $1', [group.id]);
      await ctx.audit({
        action: 'group.member_saved',
        entityType: 'market_group',
        entityId: group.id,
        before: existing ?? null,
        after: { instrumentId, addedOn, ...saved },
      });
      return true;
    },
  },
};

/** Header names compare case-insensitively with whitespace collapsed to `_` (03 §2.1). */
const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');

function fileFailure(kind: ReferenceKind, header: string[], rows: number) {
  const profile = PROFILES[kind];
  if (rows === 0) return { primaryCode: 'FILE_EMPTY', message: 'The file has no data rows' };
  const missing = profile.required.filter((f) => !header.includes(f));
  if (missing.length)
    return { primaryCode: 'HEADER_MISSING_REQUIRED', message: `Missing: ${missing.join(', ')}` };
  const repeated = header.filter((h, i) => header.indexOf(h) !== i);
  if (repeated.length)
    return { primaryCode: 'HEADER_AMBIGUOUS', message: `Repeated: ${repeated.join(', ')}` };
  const known = new Set([...profile.required, ...profile.optional]);
  const unknown = header.filter((h) => !known.has(h));
  if (unknown.length)
    return { primaryCode: 'HEADER_UNKNOWN_FIELD', message: `Not a ${kind} field: ${unknown.join(', ')}` };
  return null;
}

async function finish(
  c: pg.ClientBase,
  batchId: string,
  status: 'COMPLETED' | 'VALIDATION_FAILED',
  counts: { total: number; rejected: number },
  summary: { primaryCode: string; message: string } | null,
) {
  // 01 §3.1: a passing batch moves VALIDATING → VALIDATED → PROCESSING → COMPLETED.
  if (status === 'COMPLETED')
    for (const step of ['VALIDATED', 'PROCESSING'])
      await c.query('update md.import_batch set status = $2, updated_at = now() where id = $1', [
        batchId,
        step,
      ]);
  await c.query(
    `update md.import_batch set status = $2, total_rows = $3::int, accepted_rows = $3::int - $4::int, rejected_rows = $4::int,
       error_summary = $5::jsonb, completed_at = now(), updated_at = now() where id = $1`,
    [batchId, status, counts.total, counts.rejected, summary ? JSON.stringify(summary) : null],
  );
}

/** The stored outcome of a batch, with its first 50 rejects. */
export async function referenceImportResult(
  c: pg.ClientBase,
  batchId: string,
): Promise<ReferenceImportResult> {
  const b = await one<{
    status: 'COMPLETED' | 'VALIDATION_FAILED';
    total: number;
    accepted: number;
    rejected: number;
    summary: { primaryCode: string; message: string } | null;
  }>(
    c,
    `select status, total_rows as total, accepted_rows as accepted, rejected_rows as rejected,
            error_summary as summary
       from md.import_batch where id = $1 and batch_type = 'REFERENCE'`,
    [batchId],
  );
  if (!b) throw new DomainError('RESOURCE_NOT_FOUND', 'No such reference import');
  const { rows } = await c.query<RowReject>(
    `select row_number as "rowNumber", error_code as code, error_message as message, field_name as field
       from md.ingestion_reject where import_batch_id = $1 order by row_number limit 50`,
    [batchId],
  );
  const fileLevel = b.status === 'VALIDATION_FAILED' && rows.length === 0 && b.summary !== null;
  return {
    batchId,
    status: b.status,
    replay: true,
    totalRows: b.total,
    acceptedRows: b.accepted,
    rejectedRows: b.rejected,
    changedRows: 0,
    rejects: fileLevel
      ? [{ rowNumber: 0, code: b.summary!.primaryCode, message: b.summary!.message, field: null }]
      : rows,
  };
}

/**
 * Runs one `REFERENCE` batch in its own transaction on `c`, which must not already be in one. An unknown
 * exchange raises `EXCHANGE_NOT_FOUND` before any batch exists (03 §3.1 `EXCHANGE_UNRESOLVED`).
 */
export async function importReference(
  c: pg.ClientBase,
  q: ReferenceImportRequest,
): Promise<ReferenceImportResult> {
  const profile = PROFILES[q.kind];
  const sha = createHash('sha256').update(q.csv).digest('hex');
  const key = `reference:${q.kind}:${q.exchangeCode}:${sha}`;
  let batchId: string;
  let changed = 0;
  await c.query('begin');
  try {
    const exchange = await one<{ id: string; timezone: string }>(
      c,
      'select id::text as id, timezone from ref.exchange where code = $1',
      [q.exchangeCode],
    );
    if (!exchange) throw new DomainError('EXCHANGE_NOT_FOUND', `Unknown exchange ${q.exchangeCode}`);
    // The same file for the same kind and exchange replays its first batch instead of running twice.
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [key]);
    const prior = await one<{ id: string }>(
      c,
      'select id::text as id from md.import_batch where idempotency_key = $1',
      [key],
    );
    if (prior) {
      await c.query('commit');
      return referenceImportResult(c, prior.id);
    }
    const source = (await one<{ id: string }>(
      c,
      `insert into md.data_source (code, name, kind, provider, config) values ($1, $2, 'CSV', 'INTERNAL', $3::jsonb)
       on conflict (code) do update set updated_at = md.data_source.updated_at returning id::text as id`,
      [
        `REF_${q.kind}`,
        `Reference ${q.kind.toLowerCase().replace(/_/g, ' ')}`,
        JSON.stringify({ referenceKind: q.kind }),
      ],
    ))!;
    batchId = (await one<{ id: string }>(
      c,
      `insert into md.import_batch (source_id, exchange_id, batch_type, status, idempotency_key, correlation_id,
         requested_by, started_at)
       values ($1, $2, 'REFERENCE', 'RECEIVED', $3, $4, $5, now()) returning id::text as id`,
      [source.id, exchange.id, key, q.correlationId, q.requestedBy],
    ))!.id;
    await c.query("update md.import_batch set status = 'VALIDATING', updated_at = now() where id = $1", [
      batchId,
    ]);
    const audit = (e: AuditInput) =>
      recordAudit(c, {
        ...e,
        actorType: q.actorType,
        actorUserId: q.requestedBy,
        correlationId: q.correlationId,
        metadata: { ...e.metadata, importBatchId: batchId },
      });

    const table = parseCsv(q.csv);
    const header = table.header.map(normaliseHeader);
    const failure = fileFailure(q.kind, header, table.rows.length);
    if (failure) {
      await finish(
        c,
        batchId,
        'VALIDATION_FAILED',
        { total: table.rows.length, rejected: table.rows.length },
        failure,
      );
    } else {
      // L2/L3: every row is applied on probation; any reject rolls all of them back.
      await c.query('savepoint batch_rows');
      const rejects: (RowReject & { raw: Row })[] = [];
      const seen = new Set<string>();
      const ctx: Ctx = {
        c,
        exchangeId: exchange.id,
        exchangeCode: q.exchangeCode,
        timezone: exchange.timezone,
        audit,
      };
      for (const { rowNumber, fields, malformed } of table.rows) {
        const raw: Row = Object.fromEntries(header.map((h, i) => [h, fields[i]]));
        const reject = (code: string, message: string, field: string | null) =>
          rejects.push({ rowNumber, code, message, field, raw });
        if (malformed || fields.length !== header.length) {
          reject('ROW_MALFORMED', `Expected ${header.length} fields, found ${fields.length}`, null);
          continue;
        }
        const rowKey = profile.key(raw);
        if (seen.has(rowKey)) {
          reject('DUPLICATE_IN_FILE', 'An earlier row has the same key', null);
          continue;
        }
        seen.add(rowKey);
        await c.query('savepoint batch_row');
        try {
          if (await profile.apply(ctx, raw)) changed++;
          await c.query('release savepoint batch_row');
        } catch (error) {
          await c.query('rollback to savepoint batch_row');
          const pgCode = (error as { code?: string }).code;
          if (error instanceof Reject) reject(error.code, error.message, error.field);
          else if (error instanceof DomainError) reject(error.code, error.message, null);
          else if (typeof pgCode === 'string' && pgCode.startsWith('23'))
            reject(
              'CONSTRAINT_VIOLATED',
              `Rejected by ${(error as { constraint?: string }).constraint ?? pgCode}`,
              null,
            );
          else throw error;
        }
      }
      if (rejects.length > 0) {
        await c.query('rollback to savepoint batch_rows');
        changed = 0;
        for (const r of rejects)
          await c.query(
            `insert into md.ingestion_reject (import_batch_id, row_number, raw_row, error_code, error_message, field_name)
             values ($1, $2, $3::jsonb, $4, $5, $6)`,
            [batchId, r.rowNumber, JSON.stringify(r.raw), r.code, r.message, r.field],
          );
        const tally = new Map<string, number>();
        for (const r of rejects) tally.set(r.code, (tally.get(r.code) ?? 0) + 1);
        const primaryCode = [...tally].sort((a, b) => b[1] - a[1])[0]![0];
        await finish(
          c,
          batchId,
          'VALIDATION_FAILED',
          { total: table.rows.length, rejected: rejects.length },
          {
            primaryCode,
            message: `${rejects.length} of ${table.rows.length} rows rejected; nothing was applied`,
          },
        );
      } else {
        await finish(c, batchId, 'COMPLETED', { total: table.rows.length, rejected: 0 }, null);
        await audit({
          action: 'reference.imported',
          entityType: 'import_batch',
          entityId: batchId,
          metadata: {
            kind: q.kind,
            exchangeCode: q.exchangeCode,
            rows: table.rows.length,
            changedRows: changed,
          },
        });
      }
    }
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  }
  return { ...(await referenceImportResult(c, batchId)), replay: false, changedRows: changed };
}
