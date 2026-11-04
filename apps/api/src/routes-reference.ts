// Reference-data routes of 05 §11.4 (Phase 4 slice 2). Every write is audited in its own transaction.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { decimalString, isoDate } from '@tradesoft/contracts';
import { instrumentMachine, transition, type InstrumentEvent } from '@tradesoft/domain';
import {
  addIndexMember,
  addSectorMembership,
  INSTRUMENT_COLUMNS,
  recordAudit,
  resolveGroup,
} from '@tradesoft/db';
import { ApiError, withClient, type ApiDeps } from './platform.ts';
import { actor, inTx, userOf } from './routes-admin.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const datetime = z.iso.datetime({ offset: true });
const limit = z.coerce.number().int().min(1).max(200).default(50);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const today = () => new Date().toISOString().slice(0, 10);
/** A repeated query parameter arrives as an array, a single one as a string (05 §6.5). */
const multi = <T extends z.ZodType<string>>(item: T) =>
  z.union([item, z.array(item)]).transform((v) => (Array.isArray(v) ? v : [v]));

const INSTRUMENT_TYPES = ['EQUITY', 'INDEX', 'FUTURE', 'OPTION', 'ETF', 'BOND', 'CURRENCY', 'FUND'] as const;
const ASSET_CLASSES = ['EQUITY', 'COMMODITY', 'FX', 'FIXED_INCOME', 'RATE'] as const;
const ACTION_TYPES = ['SPLIT', 'BONUS', 'DIVIDEND', 'RIGHTS', 'MERGER', 'DEMERGER', 'SYMBOL_CHANGE'] as const;
const GROUP_TYPES = ['SECTOR', 'INDEX', 'CUSTOM', 'BENCHMARK', 'COMPOSITE'] as const;

/** Unknown filters are refused, never ignored (05 §6.5). */
export function filters<T extends z.ZodRawShape>(shape: T, query: unknown): z.infer<z.ZodObject<T>> {
  const unknown = Object.keys((query ?? {}) as object).filter((k) => !(k in shape));
  if (unknown.length > 0)
    throw new ApiError('FILTER_NOT_SUPPORTED', `Unsupported filter: ${unknown.join(', ')}`);
  return z.object(shape).parse(query ?? {});
}

/** One page; `nextCursor` stays null until signed cursors exist (Phase 3 open item). */
export const page = <T>(rows: T[], n: number) => ({
  data: rows.slice(0, n),
  page: { limit: n, hasMore: rows.length > n, nextCursor: null },
});

export const invalid = (path: string, message: string) =>
  new ApiError('VALIDATION_FAILED', message, { errors: [{ path, code: 'VALIDATION_FAILED', message }] });

const pgError = (e: unknown) => e as { code?: string; constraint?: string };
export const isUnique = (e: unknown, constraint: string) =>
  pgError(e).code === '23505' && pgError(e).constraint === constraint;
const checkFailed = (e: unknown) => {
  if (pgError(e).code === '23514') return invalid('/', `Rejected by ${pgError(e).constraint ?? 'a check'}`);
  return e;
};

/** `SET` clauses for the keys present in `body`; column names come from the whitelist, never the client. */
function setClause(body: Record<string, unknown>, columns: Record<string, string>) {
  const keys = Object.keys(body).filter((k) => body[k] !== undefined && k in columns);
  return {
    sql: keys.map((k, i) => `${columns[k]} = $${i + 2}`).join(', '),
    values: keys.map((k) => body[k]),
  };
}

export const audit = (
  c: pg.ClientBase,
  req: FastifyRequest,
  e: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  },
) => recordAudit(c, { ...actor(req), ...e });

const EXCHANGE = `id::text as id, code, name, timezone, currency, default_open_time::text as "defaultOpenTime",
  default_close_time::text as "defaultCloseTime", is_active as "isActive"`;
const CALENDAR_DAY = `calendar_date::text as "sessionDate", is_trading_day as "isTradingDay",
  session_open_at as "sessionOpenAt", session_close_at as "sessionCloseAt", is_special as "isSpecial", description, source`;
const SECTOR = `id::text as id, code, name, parent_id::text as "parentId", kind, is_active as "isActive",
  updated_at as "updatedAt"`;
const GROUP = `g.id::text as id, g.code, g.name, g.group_type as "groupType", g.is_dynamic as "isDynamic",
  g.owner_user_id::text as "ownerUserId", g.is_shared as "isShared", g.is_system as "isSystem", g.description,
  g.updated_at as "updatedAt"`;
const ACTION = `a.id::text as id, a.instrument_id::text as "instrumentId", i.symbol, a.action_type as "actionType",
  a.ex_date::text as "exDate", a.record_date::text as "recordDate", a.ratio_from::text as "ratioFrom",
  a.ratio_to::text as "ratioTo", a.cash_amount::text as "cashAmount", a.announced_at::text as "announcedAt",
  a.source, a.note`;
const ALIAS = `id::text as id, alias_symbol as "aliasSymbol", valid_from::text as "validFrom",
  valid_to::text as "validTo", reason`;
const MEMBERSHIP = `m.sector_id::text as "sectorId", s.code as "sectorCode", s.name as "sectorName", s.kind,
  m.effective_from::text as "effectiveFrom", m.effective_to::text as "effectiveTo", m.source`;
const FROM_INSTRUMENT = 'from ref.instrument i join ref.exchange e on e.id = i.exchange_id';

type Row = pg.QueryResultRow;
const one = async <T extends Row>(c: pg.ClientBase, sql: string, params: unknown[]) =>
  (await c.query<T>(sql, params)).rows[0];

export function registerReferenceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool } = deps;

  // ----------------------------------------------------------------------------- exchanges
  const loadExchange = async (c: pg.ClientBase, id: string) => {
    const row = await one<{ id: string; code: string }>(
      c,
      `select ${EXCHANGE} from ref.exchange where id = $1`,
      [id],
    );
    if (!row) throw new ApiError('EXCHANGE_NOT_FOUND', 'No such exchange');
    return row;
  };

  app.get('/api/v1/exchanges', { config: { permission: 'exchange:read' } }, async () => {
    const { rows } = await pool.query(`select ${EXCHANGE} from ref.exchange order by code`);
    return page(rows, 200);
  });

  app.get('/api/v1/exchanges/:id', { config: { permission: 'exchange:read' } }, async (req) =>
    withClient(pool, (c) => loadExchange(c, idParam.parse(req.params).id)),
  );

  // An exchange is platform configuration, like a data source (`POST /ingestion/sources`), so it needs
  // settings:write. Its default session is a fallback label only: sessions come from calendar rows (A8).
  app.post('/api/v1/exchanges', { config: { permission: 'settings:write' } }, async (req, reply) => {
    const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
    const body = z
      .object({
        code: z.string().regex(/^[A-Z]{2,8}$/),
        name: z.string().trim().min(1).max(120),
        timezone: z
          .string()
          .refine((tz) => {
            try {
              new Intl.DateTimeFormat('en', { timeZone: tz });
              return true;
            } catch {
              return false;
            }
          }, 'Unknown IANA time zone')
          .default('Asia/Kolkata'),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .default('INR'),
        defaultOpenTime: clock,
        defaultCloseTime: clock,
      })
      .strict()
      .parse(req.body);
    if (body.defaultCloseTime <= body.defaultOpenTime)
      throw invalid('/defaultCloseTime', 'The default session must close after it opens');
    const created = await inTx(pool, async (c) => {
      let row: { id: string } | undefined;
      try {
        row = await one<{ id: string }>(
          c,
          `insert into ref.exchange (code, name, timezone, currency, default_open_time, default_close_time)
           values ($1, $2, $3, $4, $5, $6) returning ${EXCHANGE}`,
          [body.code, body.name, body.timezone, body.currency, body.defaultOpenTime, body.defaultCloseTime],
        );
      } catch (e) {
        if (isUnique(e, 'uq_exchange_code'))
          throw new ApiError('RESOURCE_CONFLICT', `Exchange ${body.code} already exists`);
        throw e;
      }
      await audit(c, req, {
        action: 'exchange.created',
        entityType: 'exchange',
        entityId: row!.id,
        after: row,
      });
      return row!;
    });
    return reply.code(201).header('location', `/api/v1/exchanges/${created.id}`).send(created);
  });

  app.get('/api/v1/exchanges/:id/calendar', { config: { permission: 'exchange:read' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = filters({ from: isoDate.optional(), to: isoDate.optional() }, req.query);
    const from = q.from ?? today();
    const to = q.to ?? new Date(Date.parse(from) + 30 * 86_400_000).toISOString().slice(0, 10);
    if (to < from) throw invalid('/to', '`to` is before `from`');
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000)
      throw invalid('/to', 'The range exceeds 366 days');
    return withClient(pool, async (c) => {
      await loadExchange(c, id);
      const { rows } = await c.query(
        `select ${CALENDAR_DAY} from ref.trading_calendar
          where exchange_id = $1 and calendar_date between $2 and $3 order by calendar_date`,
        [id, from, to],
      );
      return { data: rows };
    });
  });

  app.put(
    '/api/v1/exchanges/:id/calendar/:sessionDate',
    { config: { permission: 'calendar:write' } },
    async (req) => {
      const { id, sessionDate } = z.object({ id: uuid, sessionDate: isoDate }).parse(req.params);
      const body = z
        .object({
          isTradingDay: z.boolean(),
          sessionOpenAt: datetime.optional(),
          sessionCloseAt: datetime.optional(),
          isSpecial: z.boolean().default(false),
          description: z.string().trim().max(200).optional(),
        })
        .strict()
        .parse(req.body);
      if (body.isTradingDay) {
        if (!body.sessionOpenAt || !body.sessionCloseAt)
          throw invalid('/sessionOpenAt', 'A trading day needs both session bounds');
        if (Date.parse(body.sessionCloseAt) <= Date.parse(body.sessionOpenAt))
          throw invalid('/sessionCloseAt', 'The session must close after it opens');
      } else if (body.sessionOpenAt || body.sessionCloseAt)
        throw invalid('/sessionOpenAt', 'A holiday has no session bounds');
      return inTx(pool, async (c) => {
        const exchange = await loadExchange(c, id);
        // A past session that already has bars is history: changing it would move bars between sessions.
        if (sessionDate < today()) {
          const bars = await c.query(
            `select 1 from md.market_bar b join ref.instrument i on i.id = b.instrument_id
              where i.exchange_id = $1 and b.session_date = $2 limit 1`,
            [id, sessionDate],
          );
          if (bars.rowCount)
            throw new ApiError('CALENDAR_DAY_NOT_EDITABLE', 'Bars exist for this past session');
        }
        const before = await one(
          c,
          `select ${CALENDAR_DAY} from ref.trading_calendar where exchange_id = $1 and calendar_date = $2`,
          [id, sessionDate],
        );
        const after = await one(
          c,
          `insert into ref.trading_calendar
             (exchange_id, calendar_date, is_trading_day, session_open_at, session_close_at, is_special, description, source)
           values ($1, $2, $3, $4, $5, $6, $7, 'MANUAL')
           on conflict (exchange_id, calendar_date) do update set is_trading_day = excluded.is_trading_day,
             session_open_at = excluded.session_open_at, session_close_at = excluded.session_close_at,
             is_special = excluded.is_special, description = excluded.description, source = 'MANUAL', updated_at = now()
           returning ${CALENDAR_DAY}`,
          [
            id,
            sessionDate,
            body.isTradingDay,
            body.sessionOpenAt ?? null,
            body.sessionCloseAt ?? null,
            body.isSpecial,
            body.description ?? null,
          ],
        );
        await audit(c, req, {
          action: 'calendar.day_saved',
          entityType: 'trading_calendar',
          entityId: `${exchange.code}:${sessionDate}`,
          before,
          after,
        });
        return after;
      });
    },
  );

  app.get('/api/v1/timeframes', { config: { permission: 'exchange:read' } }, async () => {
    const { rows } = await pool.query(
      `select code, minutes, is_intraday as "isIntraday", sort_order as "sortOrder", label
         from ref.timeframe order by sort_order`,
    );
    return { data: rows };
  });

  // ---------------------------------------------------------------------------- instruments
  const loadInstrument = async (c: pg.ClientBase, id: string) => {
    const row = await one<{ id: string; status: string; instrumentType: string }>(
      c,
      `select ${INSTRUMENT_COLUMNS}, i.updated_at as "updatedAt" ${FROM_INSTRUMENT} where i.id = $1`,
      [id],
    );
    if (!row) throw new ApiError('INSTRUMENT_NOT_FOUND', 'No such instrument');
    return row;
  };

  app.get('/api/v1/instruments', { config: { permission: 'instrument:read' } }, async (req) => {
    const q = filters(
      {
        q: z.string().trim().min(2).max(64).optional(),
        exchangeId: uuid.optional(),
        instrumentType: multi(z.enum(INSTRUMENT_TYPES)).optional(),
        assetClass: multi(z.enum(ASSET_CLASSES)).optional(),
        status: multi(z.enum(['ACTIVE', 'SUSPENDED', 'DELISTED'])).optional(),
        limit,
      },
      req.query,
    );
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    // Free text matches symbol or name by substring or trigram similarity; symbol prefixes rank first.
    const { rows } = await pool.query(
      `select ${INSTRUMENT_COLUMNS} ${FROM_INSTRUMENT}
        where ($1::text is null or i.symbol ilike $1 or i.name ilike $1 or i.symbol % $2 or i.name % $2)
          and ($3::uuid is null or i.exchange_id = $3)
          and ($4::text[] is null or i.instrument_type = any($4))
          and ($5::text[] is null or i.asset_class = any($5))
          and ($6::text[] is null or i.status = any($6))
        order by case when $2::text is null or i.symbol ilike $2 || '%' then 0 else 1 end,
                 case when $2::text is null then 0 else -greatest(similarity(i.symbol, $2), similarity(i.name, $2)) end,
                 i.symbol, i.series, i.id
        limit $7`,
      [
        like,
        q.q ?? null,
        q.exchangeId ?? null,
        q.instrumentType ?? null,
        q.assetClass ?? null,
        q.status ?? null,
        q.limit + 1,
      ],
    );
    return page(rows, q.limit);
  });

  const symbol = z.string().regex(/^[A-Z0-9][A-Z0-9&_.~-]{0,31}$/);
  const isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/);

  app.post('/api/v1/instruments', { config: { permission: 'instrument:write' } }, async (req, reply) => {
    const body = z
      .object({
        exchangeId: uuid,
        symbol,
        series: z
          .string()
          .regex(/^[A-Z0-9]{0,4}$/)
          .default(''),
        isin: isin.optional(),
        name: z.string().trim().min(1).max(200),
        instrumentType: z.enum(INSTRUMENT_TYPES),
        assetClass: z.enum(ASSET_CLASSES),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .default('INR'),
        lotSize: z.number().int().positive().default(1),
        tickSize: decimalString(18, 6).optional(),
        pricePrecision: z.number().int().min(0).max(6).default(2),
        listingDate: isoDate.optional(),
        underlyingId: uuid.optional(),
        isSynthetic: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const created = await inTx(pool, async (c) => {
      await loadExchange(c, body.exchangeId);
      if (body.underlyingId) await loadInstrument(c, body.underlyingId);
      let id: string;
      try {
        const row = await one<{ id: string }>(
          c,
          `insert into ref.instrument (exchange_id, symbol, series, isin, name, instrument_type, asset_class, currency,
             lot_size, tick_size, price_precision, listing_date, underlying_id, is_synthetic)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id::text`,
          [
            body.exchangeId,
            body.symbol,
            body.series,
            body.isin ?? null,
            body.name,
            body.instrumentType,
            body.assetClass,
            body.currency,
            body.lotSize,
            body.tickSize ?? '0.05',
            body.pricePrecision,
            body.listingDate ?? null,
            body.underlyingId ?? null,
            body.isSynthetic,
          ],
        );
        id = row!.id;
      } catch (e) {
        if (isUnique(e, 'uq_instrument_symbol'))
          throw new ApiError('INSTRUMENT_SYMBOL_TAKEN', 'This exchange already has that symbol and series');
        throw checkFailed(e);
      }
      const after = await loadInstrument(c, id);
      await audit(c, req, { action: 'instrument.created', entityType: 'instrument', entityId: id, after });
      return after;
    });
    return reply.code(201).header('location', `/api/v1/instruments/${created.id}`).send(created);
  });

  app.get('/api/v1/instruments/:id', { config: { permission: 'instrument:read' } }, async (req) =>
    withClient(pool, (c) => loadInstrument(c, idParam.parse(req.params).id)),
  );

  app.patch('/api/v1/instruments/:id', { config: { permission: 'instrument:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        isin: isin.nullable().optional(),
        lotSize: z.number().int().positive().optional(),
        tickSize: decimalString(18, 6).optional(),
        pricePrecision: z.number().int().min(0).max(6).optional(),
        listingDate: isoDate.optional(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'DELISTED']).optional(),
        delistingDate: isoDate.optional(),
      })
      .strict()
      .parse(req.body);
    if ((body.status === 'DELISTED') !== (body.delistingDate !== undefined))
      throw invalid('/delistingDate', 'A delisting date is given exactly when the status becomes DELISTED');
    return inTx(pool, async (c) => {
      const before = await loadInstrument(c, id);
      if (body.status && body.status !== before.status) {
        const event: InstrumentEvent =
          body.status === 'DELISTED' ? 'DELIST' : body.status === 'SUSPENDED' ? 'SUSPEND' : 'RESUME';
        transition(instrumentMachine, before.status as Parameters<typeof transition>[1], event);
      }
      const set = setClause(body, {
        name: 'name',
        isin: 'isin',
        lotSize: 'lot_size',
        tickSize: 'tick_size',
        pricePrecision: 'price_precision',
        listingDate: 'listing_date',
        status: 'status',
        delistingDate: 'delisting_date',
      });
      if (set.values.length > 0) {
        try {
          await c.query(`update ref.instrument set ${set.sql}, updated_at = now() where id = $1`, [
            id,
            ...set.values,
          ]);
        } catch (e) {
          throw checkFailed(e);
        }
      }
      const after = await loadInstrument(c, id);
      await audit(c, req, {
        action: 'instrument.updated',
        entityType: 'instrument',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  });

  // ---------------------------------------------------------------------- symbol aliases
  app.get('/api/v1/instruments/:id/aliases', { config: { permission: 'instrument:read' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withClient(pool, async (c) => {
      await loadInstrument(c, id);
      const { rows } = await c.query(
        `select ${ALIAS} from ref.symbol_alias where instrument_id = $1 order by valid_from, id`,
        [id],
      );
      return { data: rows };
    });
  });

  app.post(
    '/api/v1/instruments/:id/aliases',
    { config: { permission: 'instrument:write' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          aliasSymbol: symbol,
          validFrom: isoDate,
          validTo: isoDate.optional(),
          reason: code.default('SYMBOL_CHANGE'),
        })
        .strict()
        .parse(req.body);
      if (body.validTo && body.validTo < body.validFrom)
        throw invalid('/validTo', '`validTo` is before `validFrom`');
      const created = await inTx(pool, async (c) => {
        await loadInstrument(c, id);
        // Serialise alias writes per symbol so two overlapping windows cannot both pass the check.
        await c.query('select pg_advisory_xact_lock(hashtext($1))', [`alias:${body.aliasSymbol}`]);
        const clash = await c.query(
          `select 1 from ref.symbol_alias a join ref.instrument i on i.id = $1
            where a.exchange_id = i.exchange_id and a.alias_symbol = $2
              and daterange(a.valid_from, a.valid_to, '[]') && daterange($3::date, $4::date, '[]')`,
          [id, body.aliasSymbol, body.validFrom, body.validTo ?? null],
        );
        if (clash.rowCount)
          throw new ApiError('ALIAS_WINDOW_OVERLAP', 'An alias for that symbol overlaps this window');
        const row = await one(
          c,
          `insert into ref.symbol_alias (instrument_id, alias_symbol, exchange_id, valid_from, valid_to, reason)
           select $1, $2, exchange_id, $3, $4, $5 from ref.instrument where id = $1 returning ${ALIAS}`,
          [id, body.aliasSymbol, body.validFrom, body.validTo ?? null, body.reason],
        );
        await audit(c, req, {
          action: 'instrument.alias_added',
          entityType: 'instrument',
          entityId: id,
          after: row,
        });
        return row;
      });
      return reply.code(201).send(created);
    },
  );

  app.delete(
    '/api/v1/instruments/:id/aliases/:aliasId',
    { config: { permission: 'instrument:write' } },
    async (req, reply) => {
      const { id, aliasId } = z.object({ id: uuid, aliasId: uuid }).parse(req.params);
      await inTx(pool, async (c) => {
        const before = await one(
          c,
          `delete from ref.symbol_alias where id = $1 and instrument_id = $2 returning ${ALIAS}`,
          [aliasId, id],
        );
        if (!before) throw new ApiError('RESOURCE_NOT_FOUND', 'No such alias');
        await audit(c, req, {
          action: 'instrument.alias_removed',
          entityType: 'instrument',
          entityId: id,
          before,
        });
      });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------ sector memberships
  app.get(
    '/api/v1/instruments/:id/sector-memberships',
    { config: { permission: 'sector:read' } },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return withClient(pool, async (c) => {
        await loadInstrument(c, id);
        const { rows } = await c.query(
          `select ${MEMBERSHIP} from ref.instrument_sector_membership m join ref.sector s on s.id = m.sector_id
            where m.instrument_id = $1 order by m.effective_from desc, s.code`,
          [id],
        );
        return { data: rows };
      });
    },
  );

  app.post(
    '/api/v1/instruments/:id/sector-memberships',
    { config: { permission: 'sector:write' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          sectorId: uuid,
          effectiveFrom: isoDate,
          effectiveTo: isoDate.optional(),
          source: code.default('MANUAL'),
        })
        .strict()
        .parse(req.body);
      if (body.effectiveTo && body.effectiveTo < body.effectiveFrom)
        throw new ApiError('MEMBERSHIP_WINDOW_INVALID', '`effectiveTo` is before `effectiveFrom`');
      const { after, added } = await inTx(pool, async (c) => {
        await loadInstrument(c, id);
        // BR-004 and the overlap rules live in one place for the API and REFERENCE imports.
        const result = await addSectorMembership(c, {
          instrumentId: id,
          sectorId: body.sectorId,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
          source: body.source,
        });
        const saved = { ...body, closedSectorId: result.outcome === 'ADDED' ? result.closedSectorId : null };
        if (result.outcome !== 'UNCHANGED')
          await audit(c, req, {
            action:
              result.outcome === 'ADDED'
                ? 'instrument.sector_membership_added'
                : 'instrument.sector_membership_updated',
            entityType: 'instrument',
            entityId: id,
            before: result.outcome === 'UPDATED' ? result.before : null,
            after: saved,
          });
        return { after: saved, added: result.outcome === 'ADDED' };
      });
      return reply.code(added ? 201 : 200).send(after);
    },
  );

  app.post(
    '/api/v1/instruments/:id/sector-memberships/:sectorId/close',
    { config: { permission: 'sector:write' } },
    async (req) => {
      const { id, sectorId } = z.object({ id: uuid, sectorId: uuid }).parse(req.params);
      const { effectiveTo } = z.object({ effectiveTo: isoDate }).strict().parse(req.body);
      return inTx(pool, async (c) => {
        const open = await one<{ effectiveFrom: string }>(
          c,
          `select effective_from::text as "effectiveFrom" from ref.instrument_sector_membership
            where instrument_id = $1 and sector_id = $2 and effective_to is null for update`,
          [id, sectorId],
        );
        if (!open) throw new ApiError('MEMBERSHIP_NOT_FOUND', 'No open membership for that sector');
        if (effectiveTo < open.effectiveFrom)
          throw new ApiError('MEMBERSHIP_WINDOW_INVALID', '`effectiveTo` is before `effectiveFrom`');
        await c.query(
          `update ref.instrument_sector_membership set effective_to = $3
            where instrument_id = $1 and sector_id = $2 and effective_to is null`,
          [id, sectorId, effectiveTo],
        );
        const after = { sectorId, effectiveFrom: open.effectiveFrom, effectiveTo };
        await audit(c, req, {
          action: 'instrument.sector_membership_closed',
          entityType: 'instrument',
          entityId: id,
          after,
        });
        return after;
      });
    },
  );

  // --------------------------------------------------------------------- index members
  const loadIndex = async (c: pg.ClientBase, id: string) => {
    const index = await loadInstrument(c, id);
    if (index.instrumentType !== 'INDEX') throw invalid('/id', 'The instrument is not an index');
    return index;
  };

  app.get('/api/v1/instruments/:id/members', { config: { permission: 'instrument:read' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const asOf = filters({ asOf: isoDate.optional() }, req.query).asOf ?? today();
    return withClient(pool, async (c) => {
      await loadIndex(c, id);
      const { rows } = await c.query(
        `select m.member_instrument_id::text as "instrumentId", i.symbol, i.name, m.weight::text as weight,
                m.effective_from::text as "effectiveFrom", m.effective_to::text as "effectiveTo"
           from ref.index_membership m join ref.instrument i on i.id = m.member_instrument_id
          where m.index_instrument_id = $1 and m.effective_from <= $2::date
            and (m.effective_to is null or m.effective_to >= $2::date)
          order by i.symbol, i.id`,
        [id, asOf],
      );
      return { asOf, data: rows };
    });
  });

  app.post(
    '/api/v1/instruments/:id/members',
    { config: { permission: 'instrument:write' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          memberInstrumentId: uuid,
          effectiveFrom: isoDate,
          effectiveTo: isoDate.optional(),
          weight: decimalString(9, 6).optional(),
        })
        .strict()
        .parse(req.body);
      if (body.effectiveTo && body.effectiveTo < body.effectiveFrom)
        throw new ApiError('MEMBERSHIP_WINDOW_INVALID', '`effectiveTo` is before `effectiveFrom`');
      const added = await inTx(pool, async (c) => {
        await loadIndex(c, id);
        await loadInstrument(c, body.memberInstrumentId);
        const result = await addIndexMember(c, {
          indexId: id,
          memberId: body.memberInstrumentId,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
          weight: body.weight ?? null,
        });
        if (result.outcome !== 'UNCHANGED')
          await audit(c, req, {
            action: result.outcome === 'ADDED' ? 'instrument.member_added' : 'instrument.member_updated',
            entityType: 'instrument',
            entityId: id,
            before: result.outcome === 'UPDATED' ? result.before : null,
            after: body,
          });
        return result.outcome === 'ADDED';
      });
      return reply.code(added ? 201 : 200).send(body);
    },
  );

  app.post(
    '/api/v1/instruments/:id/members/:memberId/close',
    { config: { permission: 'instrument:write' } },
    async (req) => {
      const { id, memberId } = z.object({ id: uuid, memberId: uuid }).parse(req.params);
      const { effectiveTo } = z.object({ effectiveTo: isoDate }).strict().parse(req.body);
      return inTx(pool, async (c) => {
        const open = await one<{ effectiveFrom: string }>(
          c,
          `select effective_from::text as "effectiveFrom" from ref.index_membership
            where index_instrument_id = $1 and member_instrument_id = $2 and effective_to is null for update`,
          [id, memberId],
        );
        if (!open) throw new ApiError('MEMBERSHIP_NOT_FOUND', 'No open constituent period');
        if (effectiveTo < open.effectiveFrom)
          throw new ApiError('MEMBERSHIP_WINDOW_INVALID', '`effectiveTo` is before `effectiveFrom`');
        await c.query(
          `update ref.index_membership set effective_to = $3
            where index_instrument_id = $1 and member_instrument_id = $2 and effective_to is null`,
          [id, memberId, effectiveTo],
        );
        const after = { memberInstrumentId: memberId, effectiveFrom: open.effectiveFrom, effectiveTo };
        await audit(c, req, {
          action: 'instrument.member_closed',
          entityType: 'instrument',
          entityId: id,
          after,
        });
        return after;
      });
    },
  );

  // ------------------------------------------------------------------------------ sectors
  interface SectorRow {
    id: string;
    parentId: string | null;
    children?: SectorRow[];
  }
  const loadSector = async (c: pg.ClientBase, id: string) => {
    const row = await one<SectorRow>(c, `select ${SECTOR} from ref.sector where id = $1`, [id]);
    if (!row) throw new ApiError('SECTOR_NOT_FOUND', 'No such sector');
    return row;
  };

  app.get('/api/v1/sectors', { config: { permission: 'sector:read' } }, async () => {
    const { rows } = await pool.query<SectorRow>(`select ${SECTOR} from ref.sector order by code`);
    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] as SectorRow[] }]));
    const roots: SectorRow[] = [];
    for (const node of byId.values()) (node.parentId ? byId.get(node.parentId)!.children : roots).push(node);
    return { data: roots };
  });

  app.post('/api/v1/sectors', { config: { permission: 'sector:write' } }, async (req, reply) => {
    const body = z
      .object({
        code,
        name: z.string().trim().min(1).max(120),
        parentId: uuid.optional(),
        kind: z.enum(['SECTOR', 'INDUSTRY', 'THEME']).default('SECTOR'),
      })
      .strict()
      .parse(req.body);
    const created = await inTx(pool, async (c) => {
      if (body.parentId) await loadSector(c, body.parentId);
      let row: SectorRow | undefined;
      try {
        row = await one<SectorRow>(
          c,
          `insert into ref.sector (code, name, parent_id, kind) values ($1, $2, $3, $4) returning ${SECTOR}`,
          [body.code, body.name, body.parentId ?? null, body.kind],
        );
      } catch (e) {
        if (isUnique(e, 'uq_sector_code'))
          throw new ApiError('RESOURCE_CONFLICT', 'A sector with that code exists');
        throw e;
      }
      await audit(c, req, { action: 'sector.created', entityType: 'sector', entityId: row!.id, after: row });
      return row!;
    });
    return reply.code(201).header('location', `/api/v1/sectors/${created.id}`).send(created);
  });

  app.patch('/api/v1/sectors/:id', { config: { permission: 'sector:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        parentId: uuid.nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      // Sector writes are serialised so two concurrent re-parents cannot form a cycle together (BR-003).
      await c.query("select pg_advisory_xact_lock(hashtext('ref.sector'))");
      const before = await loadSector(c, id);
      if (body.parentId) {
        await loadSector(c, body.parentId);
        const cycle = await c.query(
          `with recursive up as (
             select id, parent_id from ref.sector where id = $1
             union all select s.id, s.parent_id from ref.sector s join up on s.id = up.parent_id)
           select 1 from up where id = $2`,
          [body.parentId, id],
        );
        if (cycle.rowCount)
          throw new ApiError('SECTOR_CYCLE', 'The new parent is this sector or one of its descendants');
      }
      const set = setClause(body, { name: 'name', parentId: 'parent_id', isActive: 'is_active' });
      if (set.values.length > 0)
        await c.query(`update ref.sector set ${set.sql}, updated_at = now() where id = $1`, [
          id,
          ...set.values,
        ]);
      const after = await loadSector(c, id);
      await audit(c, req, { action: 'sector.updated', entityType: 'sector', entityId: id, before, after });
      return after;
    });
  });

  // ------------------------------------------------------------------------------- groups
  interface Group {
    id: string;
    ownerUserId: string | null;
    isSystem: boolean;
    isShared: boolean;
  }
  const principalUser = (req: FastifyRequest) =>
    req.principal?.kind === 'user' ? req.principal.userId : null;
  /** A group is visible when it is a system group, shared, or owned by the caller. */
  const loadGroup = async (c: pg.ClientBase, req: FastifyRequest, id: string) => {
    const row = await one<Group>(
      c,
      `select ${GROUP} from ref.market_group g
        where g.id = $1 and (g.is_system or g.is_shared or g.owner_user_id = $2)`,
      [id, principalUser(req)],
    );
    if (!row) throw new ApiError('GROUP_NOT_FOUND', 'No such group');
    return row;
  };
  const editableGroup = async (c: pg.ClientBase, req: FastifyRequest, id: string) => {
    const group = await loadGroup(c, req, id);
    if (group.isSystem) throw new ApiError('GROUP_IMMUTABLE_SYSTEM', 'System groups cannot be edited');
    if (group.ownerUserId !== principalUser(req))
      throw new ApiError('AUTHZ_FORBIDDEN', "Only the group's owner can change it");
    return group;
  };
  const canShare = (req: FastifyRequest) => req.principal?.perms.has('group:share') ?? false;

  app.get('/api/v1/groups', { config: { permission: 'group:read' } }, async (req) => {
    const q = filters({ groupType: multi(z.enum(GROUP_TYPES)).optional(), limit }, req.query);
    const { rows } = await pool.query(
      `select ${GROUP},
              (select count(*)::integer from ref.market_group_member m
                where m.group_id = g.id and m.added_on <= current_date
                  and (m.removed_on is null or m.removed_on > current_date)) as "memberCount"
         from ref.market_group g
        where (g.is_system or g.is_shared or g.owner_user_id = $1)
          and ($2::text[] is null or g.group_type = any($2))
        order by g.code, g.id limit $3`,
      [principalUser(req), q.groupType ?? null, q.limit + 1],
    );
    return page(rows, q.limit);
  });

  app.post('/api/v1/groups', { config: { permission: 'group:write' } }, async (req, reply) => {
    const body = z
      .object({
        code,
        name: z.string().trim().min(1).max(120),
        groupType: z.enum(GROUP_TYPES).default('CUSTOM'),
        description: z.string().trim().max(500).default(''),
        isShared: z.boolean().default(false),
        isDynamic: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    // shortcut: dynamic rules need the Phase 10 rule compiler; until then only static groups are created.
    if (body.isDynamic) throw new ApiError('GROUP_DYNAMIC_RULE_INVALID', 'Dynamic groups arrive in Phase 10');
    if (body.isShared && !canShare(req)) throw new ApiError('AUTHZ_FORBIDDEN', 'Sharing needs group:share');
    const owner = userOf(req);
    const created = await inTx(pool, async (c) => {
      let row: Group | undefined;
      try {
        row = await one<Group>(
          c,
          `insert into ref.market_group as g (code, name, group_type, description, is_shared, owner_user_id)
           values ($1, $2, $3, $4, $5, $6) returning ${GROUP}`,
          [body.code, body.name, body.groupType, body.description, body.isShared, owner],
        );
      } catch (e) {
        if (isUnique(e, 'uq_market_group_code'))
          throw new ApiError('GROUP_CODE_TAKEN', 'A group with that code exists');
        throw e;
      }
      await audit(c, req, {
        action: 'group.created',
        entityType: 'market_group',
        entityId: row!.id,
        after: row,
      });
      return row!;
    });
    return reply.code(201).header('location', `/api/v1/groups/${created.id}`).send(created);
  });

  app.get('/api/v1/groups/:id', { config: { permission: 'group:read' } }, async (req) =>
    withClient(pool, (c) => loadGroup(c, req, idParam.parse(req.params).id)),
  );

  app.patch('/api/v1/groups/:id', { config: { permission: 'group:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).optional(),
        isShared: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const before = await editableGroup(c, req, id);
      if (body.isShared !== undefined && body.isShared !== before.isShared && !canShare(req))
        throw new ApiError('AUTHZ_FORBIDDEN', 'Sharing needs group:share');
      const set = setClause(body, { name: 'name', description: 'description', isShared: 'is_shared' });
      if (set.values.length > 0)
        await c.query(`update ref.market_group set ${set.sql}, updated_at = now() where id = $1`, [
          id,
          ...set.values,
        ]);
      const after = await loadGroup(c, req, id);
      await audit(c, req, {
        action: 'group.updated',
        entityType: 'market_group',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  });

  app.delete('/api/v1/groups/:id', { config: { permission: 'group:write' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await inTx(pool, async (c) => {
      const before = await editableGroup(c, req, id);
      await c.query('delete from ref.market_group where id = $1', [id]);
      await audit(c, req, { action: 'group.deleted', entityType: 'market_group', entityId: id, before });
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/groups/:id/members', { config: { permission: 'group:read' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = filters(
      { asOf: isoDate.optional(), includeDelisted: z.enum(['true', 'false']).optional() },
      req.query,
    );
    const asOf = q.asOf ?? today();
    return withClient(pool, async (c) => {
      await loadGroup(c, req, id);
      const ids = await resolveGroup(c, id, asOf, { includeDelisted: q.includeDelisted === 'true' });
      const { rows } = await c.query(
        `select i.id::text as "instrumentId", i.symbol, i.name, i.status from ref.instrument i
          where i.id = any($1::uuid[]) order by i.symbol, i.id`,
        [ids],
      );
      return { asOf, data: rows };
    });
  });

  const memberIds = z.array(uuid).min(1).max(5000);

  app.post('/api/v1/groups/:id/members', { config: { permission: 'group:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ instrumentIds: memberIds, addedOn: isoDate.optional() }).strict().parse(req.body);
    const addedOn = body.addedOn ?? today();
    return inTx(pool, async (c) => {
      await editableGroup(c, req, id);
      await c.query('select 1 from ref.market_group where id = $1 for update', [id]);
      const unique = [...new Set(body.instrumentIds)];
      const known = await c.query('select 1 from ref.instrument where id = any($1::uuid[])', [unique]);
      if (known.rowCount !== unique.length)
        throw new ApiError('INSTRUMENT_NOT_FOUND', 'Unknown instrument in the list');
      // A member whose period is still open is already in; adding it again would split its history.
      const { rowCount } = await c.query(
        `insert into ref.market_group_member (group_id, instrument_id, added_on)
         select $1, x, $3 from unnest($2::uuid[]) x
          where not exists (select 1 from ref.market_group_member m
                             where m.group_id = $1 and m.instrument_id = x and m.removed_on is null)
         on conflict do nothing`,
        [id, unique, addedOn],
      );
      await c.query('update ref.market_group set updated_at = now() where id = $1', [id]);
      await audit(c, req, {
        action: 'group.members_added',
        entityType: 'market_group',
        entityId: id,
        metadata: { addedOn, added: rowCount ?? 0, instrumentIds: unique },
      });
      return { added: rowCount ?? 0 };
    });
  });

  app.post('/api/v1/groups/:id/members/remove', { config: { permission: 'group:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ instrumentIds: memberIds, removedOn: isoDate.optional() })
      .strict()
      .parse(req.body);
    const removedOn = body.removedOn ?? today();
    return inTx(pool, async (c) => {
      await editableGroup(c, req, id);
      // Removal is soft (01 §1.2): the period ends, history stays.
      const { rowCount } = await c.query(
        `update ref.market_group_member set removed_on = greatest(added_on, $3::date)
          where group_id = $1 and instrument_id = any($2::uuid[]) and removed_on is null`,
        [id, body.instrumentIds, removedOn],
      );
      await c.query('update ref.market_group set updated_at = now() where id = $1', [id]);
      await audit(c, req, {
        action: 'group.members_removed',
        entityType: 'market_group',
        entityId: id,
        metadata: { removedOn, removed: rowCount ?? 0, instrumentIds: body.instrumentIds },
      });
      return { removed: rowCount ?? 0 };
    });
  });

  app.post('/api/v1/groups/:id/resolve', { config: { permission: 'group:read' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const asOf =
      z
        .object({ asOf: isoDate.optional() })
        .strict()
        .parse(req.body ?? {}).asOf ?? today();
    return withClient(pool, async (c) => {
      await loadGroup(c, req, id);
      const ids = await resolveGroup(c, id, asOf);
      return { asOf, count: ids.length, instrumentIds: ids };
    });
  });

  // ---------------------------------------------------------------------- corporate actions
  const loadAction = (c: pg.ClientBase, id: string) =>
    one<{ id: string }>(
      c,
      `select ${ACTION} from ref.corporate_action a join ref.instrument i on i.id = a.instrument_id where a.id = $1`,
      [id],
    );

  app.get('/api/v1/corporate-actions', { config: { permission: 'instrument:read' } }, async (req) => {
    const q = filters(
      {
        instrumentId: uuid.optional(),
        actionType: multi(z.enum(ACTION_TYPES)).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit,
      },
      req.query,
    );
    const { rows } = await pool.query(
      `select ${ACTION} from ref.corporate_action a join ref.instrument i on i.id = a.instrument_id
        where ($1::uuid is null or a.instrument_id = $1) and ($2::text[] is null or a.action_type = any($2))
          and ($3::date is null or a.ex_date >= $3) and ($4::date is null or a.ex_date <= $4)
        order by a.ex_date desc, a.id limit $5`,
      [q.instrumentId ?? null, q.actionType ?? null, q.from ?? null, q.to ?? null, q.limit + 1],
    );
    return page(rows, q.limit);
  });

  app.post(
    '/api/v1/corporate-actions',
    { config: { permission: 'instrument:write' } },
    async (req, reply) => {
      const ratio = decimalString(18, 6);
      const body = z
        .object({
          instrumentId: uuid,
          actionType: z.enum(ACTION_TYPES),
          exDate: isoDate,
          recordDate: isoDate.optional(),
          ratioFrom: ratio.optional(),
          ratioTo: ratio.optional(),
          cashAmount: decimalString(18, 4).optional(),
          announcedAt: isoDate.optional(),
          source: code.default('MANUAL'),
          note: z.string().trim().max(500).optional(),
        })
        .strict()
        .parse(req.body);
      const positive = (v: string | undefined) => v !== undefined && Number(v) > 0;
      if (
        (body.actionType === 'SPLIT' || body.actionType === 'BONUS') &&
        !(positive(body.ratioFrom) && positive(body.ratioTo))
      )
        throw new ApiError(
          'CORPORATE_ACTION_INVALID',
          `${body.actionType} needs positive ratioFrom and ratioTo`,
        );
      if (body.actionType === 'DIVIDEND' && (body.cashAmount === undefined || Number(body.cashAmount) < 0))
        throw new ApiError('CORPORATE_ACTION_INVALID', 'DIVIDEND needs a non-negative cashAmount');
      const created = await inTx(pool, async (c) => {
        await loadInstrument(c, body.instrumentId);
        let id: string;
        try {
          const row = await one<{ id: string }>(
            c,
            `insert into ref.corporate_action (instrument_id, action_type, ex_date, record_date, ratio_from, ratio_to,
             cash_amount, announced_at, source, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
            [
              body.instrumentId,
              body.actionType,
              body.exDate,
              body.recordDate ?? null,
              body.ratioFrom ?? null,
              body.ratioTo ?? null,
              body.cashAmount ?? null,
              body.announcedAt ?? null,
              body.source,
              body.note ?? null,
            ],
          );
          id = row!.id;
        } catch (e) {
          if (isUnique(e, 'uq_corporate_action'))
            throw new ApiError(
              'CORPORATE_ACTION_DUPLICATE',
              'That action is already recorded for this ex-date',
            );
          throw checkFailed(e);
        }
        const after = await loadAction(c, id);
        await audit(c, req, {
          action: 'corporate_action.created',
          entityType: 'corporate_action',
          entityId: id,
          after,
        });
        return after!;
      });
      return reply.code(201).send(created);
    },
  );

  app.delete(
    '/api/v1/corporate-actions/:id',
    { config: { permission: 'instrument:write' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      await inTx(pool, async (c) => {
        const before = await loadAction(c, id);
        if (!before) throw new ApiError('RESOURCE_NOT_FOUND', 'No such corporate action');
        // shortcut: adjustment factors (BR-007) arrive in Phase 6, which must recompute them after a delete.
        await c.query('delete from ref.corporate_action where id = $1', [id]);
        await audit(c, req, {
          action: 'corporate_action.deleted',
          entityType: 'corporate_action',
          entityId: id,
          before,
        });
      });
      return reply.code(204).send();
    },
  );
}
