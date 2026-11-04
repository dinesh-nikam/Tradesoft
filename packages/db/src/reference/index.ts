import type pg from 'pg';
import { DomainError } from '@tradesoft/domain';

/**
 * Market Reference read surface (00 §5): symbol resolution, calendar and effective-dated memberships.
 * Dates are ISO `YYYY-MM-DD` strings, the form `ref.*` date columns are read and written in.
 */

export type SymbolResolution =
  | { kind: 'FOUND'; instrumentId: string }
  | { kind: 'UNKNOWN' }
  | { kind: 'AMBIGUOUS'; instrumentIds: string[] };

/**
 * The instrument a symbol named on `asOf` (BR-002). An instrument's current symbol is valid from its
 * listing (or the day after its last closed alias) until its delisting; an alias is valid inside its own
 * window. A symbol used by two instruments on the same date is ambiguous, never guessed.
 */
export async function resolveSymbol(
  c: pg.ClientBase,
  q: { exchangeCode: string; symbol: string; series?: string; asOf: string },
): Promise<SymbolResolution> {
  return (await resolveSymbols(c, q.exchangeCode, [q]))[0]!;
}

/** `resolveSymbol` for many queries in one round trip; results are in query order. */
export async function resolveSymbols(
  c: pg.ClientBase,
  exchangeCode: string,
  queries: readonly { symbol: string; series?: string; asOf: string }[],
): Promise<SymbolResolution[]> {
  if (queries.length === 0) return [];
  const { rows } = await c.query<{ ids: string[] }>(
    `with ex as (select id from ref.exchange where code = $1),
          q as (select * from unnest($2::text[], $3::text[], $4::date[]) with ordinality t(symbol, series, as_of, n))
     select coalesce(array_agg(distinct m.id) filter (where m.id is not null), '{}') as ids
       from q
       left join lateral (
         select i.id::text as id
           from ref.instrument i
          where i.exchange_id = (select id from ex) and i.symbol = q.symbol and i.series = q.series
            and (i.listing_date is null or i.listing_date <= q.as_of)
            and (i.delisting_date is null or i.delisting_date >= q.as_of)
            and coalesce((select max(a.valid_to) from ref.symbol_alias a
                           where a.instrument_id = i.id and a.exchange_id = i.exchange_id),
                         '-infinity'::date) < q.as_of
         union
         select i.id::text
           from ref.symbol_alias a join ref.instrument i on i.id = a.instrument_id
          where a.exchange_id = (select id from ex) and a.alias_symbol = q.symbol and i.series = q.series
            and a.valid_from <= q.as_of and (a.valid_to is null or a.valid_to >= q.as_of)) m on true
      group by q.n
      order by q.n`,
    [
      exchangeCode,
      queries.map((q) => q.symbol),
      queries.map((q) => q.series ?? ''),
      queries.map((q) => q.asOf),
    ],
  );
  return rows.map(({ ids }): SymbolResolution => {
    if (ids.length === 0) return { kind: 'UNKNOWN' };
    if (ids.length === 1) return { kind: 'FOUND', instrumentId: ids[0]! };
    return { kind: 'AMBIGUOUS', instrumentIds: [...ids].sort() };
  });
}

export interface Instrument {
  id: string;
  exchangeCode: string;
  symbol: string;
  series: string;
  isin: string | null;
  name: string;
  instrumentType: string;
  assetClass: string;
  currency: string;
  lotSize: number;
  tickSize: string;
  pricePrecision: number;
  status: string;
  listingDate: string | null;
  delistingDate: string | null;
  isSynthetic: boolean;
}

export const INSTRUMENT_COLUMNS = `i.id::text as id, e.code as "exchangeCode", i.symbol, i.series, i.isin, i.name,
  i.instrument_type as "instrumentType", i.asset_class as "assetClass", i.currency, i.lot_size as "lotSize",
  i.tick_size::text as "tickSize", i.price_precision as "pricePrecision", i.status,
  i.listing_date::text as "listingDate", i.delisting_date::text as "delistingDate", i.is_synthetic as "isSynthetic"`;

export async function getInstrument(c: pg.ClientBase, id: string): Promise<Instrument> {
  const { rows } = await c.query<Instrument>(
    `select ${INSTRUMENT_COLUMNS} from ref.instrument i join ref.exchange e on e.id = i.exchange_id where i.id = $1`,
    [id],
  );
  if (!rows[0]) throw new DomainError('INSTRUMENT_NOT_FOUND', 'No such instrument');
  return rows[0];
}

export interface SessionBounds {
  date: string;
  isTradingDay: boolean;
  openAt: Date | null;
  closeAt: Date | null;
  isSpecial: boolean;
  description: string | null;
}

async function exchangeId(c: pg.ClientBase, code: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>('select id::text as id from ref.exchange where code = $1', [
    code,
  ]);
  if (!rows[0]) throw new DomainError('EXCHANGE_NOT_FOUND', `Unknown exchange ${code}`);
  return rows[0].id;
}

/** Calendar rows for every date in [from, to]; a date with no row is an error, never a holiday (BR-008). */
async function calendar(c: pg.ClientBase, code: string, from: string, to: string): Promise<SessionBounds[]> {
  const id = await exchangeId(c, code);
  const { rows } = await c.query<SessionBounds & { present: boolean }>(
    `select d::date::text as date, t.calendar_date is not null as present,
            coalesce(t.is_trading_day, false) as "isTradingDay", t.session_open_at as "openAt",
            t.session_close_at as "closeAt", coalesce(t.is_special, false) as "isSpecial", t.description
       from generate_series($2::date, $3::date, interval '1 day') d
       left join ref.trading_calendar t on t.exchange_id = $1 and t.calendar_date = d::date
      order by d`,
    [id, from, to],
  );
  const missing = rows.find((r) => !r.present);
  if (missing)
    throw new DomainError('CALENDAR_DAY_NOT_FOUND', `${code} has no calendar row for ${missing.date}`);
  return rows.map((r) => ({
    date: r.date,
    isTradingDay: r.isTradingDay,
    openAt: r.openAt,
    closeAt: r.closeAt,
    isSpecial: r.isSpecial,
    description: r.description,
  }));
}

export async function sessionBounds(
  c: pg.ClientBase,
  exchangeCode: string,
  date: string,
): Promise<SessionBounds> {
  return (await calendar(c, exchangeCode, date, date))[0]!;
}

export async function tradingDays(
  c: pg.ClientBase,
  exchangeCode: string,
  from: string,
  to: string,
): Promise<string[]> {
  return (await calendar(c, exchangeCode, from, to)).filter((d) => d.isTradingDay).map((d) => d.date);
}

/** Constituents of an index on `asOf` (BR-005): a period is effective from its start to its end, inclusive. */
export async function effectiveMembers(
  c: pg.ClientBase,
  indexInstrumentId: string,
  asOf: string,
): Promise<{ instrumentId: string; weight: string | null }[]> {
  const { rows } = await c.query<{ instrumentId: string; weight: string | null }>(
    `select member_instrument_id::text as "instrumentId", weight::text as weight
       from ref.index_membership
      where index_instrument_id = $1 and effective_from <= $2::date
        and (effective_to is null or effective_to >= $2::date)
      order by member_instrument_id`,
    [indexInstrumentId, asOf],
  );
  return rows;
}

/**
 * Members of a static group on `asOf`; `removed_on` is the first day a member is out. Delisted instruments
 * are left out unless asked for (BR-006).
 */
export async function resolveGroup(
  c: pg.ClientBase,
  groupId: string,
  asOf: string,
  opts: { includeDelisted?: boolean } = {},
): Promise<string[]> {
  const { rows: group } = await c.query<{ isDynamic: boolean }>(
    'select is_dynamic as "isDynamic" from ref.market_group where id = $1',
    [groupId],
  );
  if (!group[0]) throw new DomainError('GROUP_NOT_FOUND', 'No such group');
  // shortcut: dynamic rules are resolved by the Phase 10 rule engine; until then they cannot be resolved.
  if (group[0].isDynamic)
    throw new DomainError('GROUP_DYNAMIC_RULE_INVALID', 'Dynamic groups are resolved from Phase 10');
  const { rows } = await c.query<{ id: string }>(
    `select distinct m.instrument_id::text as id
       from ref.market_group_member m join ref.instrument i on i.id = m.instrument_id
      where m.group_id = $1 and m.added_on <= $2::date and (m.removed_on is null or m.removed_on > $2::date)
        and ($3 or i.delisting_date is null or i.delisting_date >= $2::date)
      order by 1`,
    [groupId, asOf, opts.includeDelisted ?? false],
  );
  return rows.map((r) => r.id);
}
