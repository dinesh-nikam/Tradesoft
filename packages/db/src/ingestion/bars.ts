import type pg from 'pg';
import { parseCsv } from '../reference/csv.ts';
import { resolveSymbols } from '../reference/index.ts';

/**
 * Turns one bar file into canonical rows (03 §1–§3): the adapter maps the header (L1), and the shared
 * validator checks each row (L2) and the rows against each other (L3). Nothing is fixed silently: a row
 * that cannot be proven correct comes back as a reject with its code. Checks against stored bars (L4) run
 * at persist time, inside the persist transaction.
 */

export const BAR_ADAPTERS = [
  'csv.generic.eod',
  'csv.nse.bhavcopy',
  'csv.bse.bhavcopy',
  'csv.mcx.eod',
  'csv.ncdex.eod',
] as const;
export type BarAdapter = (typeof BAR_ADAPTERS)[number];

const FIELDS = [
  'symbol',
  'series',
  'date',
  'open',
  'high',
  'low',
  'close',
  'prev_close',
  'volume',
  'turnover',
  'delivery_qty',
  'delivery_pct',
  'open_interest',
  'timeframe',
  'timestamp',
] as const;
type Field = (typeof FIELDS)[number];
const REQUIRED: Field[] = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'];

/** Header names are compared lowercased, trimmed, with internal whitespace collapsed to `_` (03 §2.1). */
export const normaliseHeader = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, '_');

// 03 §2.1 alias examples. Every adapter accepts the canonical names and these.
const COMMON: Record<string, Field> = {
  tckrsymb: 'symbol',
  scrip_code: 'symbol',
  sctysrs: 'series',
  traddt: 'date',
  date1: 'date',
  opnpric: 'open',
  hghpric: 'high',
  lwpric: 'low',
  clspric: 'close',
  prevclose: 'prev_close',
  prvsclsgpric: 'prev_close',
  ttltradgvol: 'volume',
  ttltrfval: 'turnover',
  deliv_qty: 'delivery_qty',
  delivqty: 'delivery_qty',
  deliv_per: 'delivery_pct',
  delivpct: 'delivery_pct',
  open_int: 'open_interest',
  opnintrst: 'open_interest',
  bucket_start: 'timestamp',
};

// VERIFY_BEFORE_PROD: the legacy exchange column names below are structural for each layout (03 §1.1) and
// must be checked against a current sample file from each exchange before go-live.
const LAYOUT: Record<BarAdapter, Record<string, Field>> = {
  'csv.generic.eod': {},
  'csv.nse.bhavcopy': { tottrdqty: 'volume', tottrdval: 'turnover', timestamp: 'date' },
  'csv.bse.bhavcopy': { sc_code: 'symbol', no_of_shrs: 'volume', net_turnov: 'turnover' },
  'csv.mcx.eod': { openinterest: 'open_interest' },
  'csv.ncdex.eod': { openinterest: 'open_interest' },
};

export interface BatchContext {
  batchId: string;
  exchangeId: string;
  exchangeCode: string;
  timezone: string;
  batchType: string;
  /** Declared by an INTRADAY_CSV batch; every row must match it. */
  timeframe: string | null;
  adapter: BarAdapter;
  /** Vendor header mode (03 §2.1): source column → canonical field, from `md.data_source.config`. */
  fieldMap: Record<string, string>;
}

export type RawRow = Record<string, string | undefined>;

export interface CanonicalBar {
  rowNumber: number;
  instrumentId: string;
  timeframe: string;
  bucketStart: string;
  sessionDate: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  deliveryVolume: string | null;
  deliveryPct: string | null;
  openInterest: string | null;
  turnover: string | null;
  raw: RawRow;
}

export interface BarReject {
  rowNumber: number;
  code: string;
  message: string;
  field: string | null;
  raw: RawRow;
}

export type MapResult =
  | { kind: 'FILE_FAILED'; primaryCode: string; message: string; totalRows: number }
  | { kind: 'MAPPED'; totalRows: number; bars: CanonicalBar[]; rejects: BarReject[] };

export const MAX_ROWS = 2_000_000;

class Reject extends Error {
  readonly code: string;
  readonly field: Field | null;
  constructor(code: string, message: string, field: Field | null = null) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

// ------------------------------------------------------------------------------ field parsing (03 §2.2)

const ABSENT = new Set(['', '-', 'NA', 'N/A', 'NULL']);
const SCALE = 4;

/** A decimal string with separators and a currency prefix stripped, or undefined when absent. */
function number(v: string | undefined, f: Field, opts: { integer?: boolean; maxDigits: number }) {
  if (v === undefined || ABSENT.has(v.trim().toUpperCase())) return undefined;
  const s = v
    .trim()
    .replace(/^(₹|rs\.?|inr|\$)\s*/i, '')
    .replace(/[, ]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  // More places than the column holds would round silently, so it is refused like any other bad number.
  if (!m || m[2]!.length > opts.maxDigits || (m[3] ?? '').length > (opts.integer ? 0 : SCALE))
    throw new Reject(
      'DECIMAL_INVALID',
      `${f} is not a ${opts.integer ? 'whole number' : `number with up to ${SCALE} decimal places`}`,
      f,
    );
  return s.replace(/^-0+(?=\d)/, '-').replace(/^0+(?=\d)/, '');
}

/** Fixed-point value at four places, so comparisons are exact. */
const scaled = (s: string): bigint => {
  const [int, frac = ''] = s.split('.');
  return BigInt(`${int}${frac.padEnd(SCALE, '0')}`.replace(/^(-?)0+(?=\d)/, '$1'));
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** `YYYY-MM-DD`, or the bhavcopy form `DD-MMM-YYYY`. */
function date(v: string | undefined): string {
  const t = (v ?? '').trim().toUpperCase();
  const dmy = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(t);
  const iso = dmy ? `${dmy[3]}-${String(MONTHS.indexOf(dmy[2]!) + 1).padStart(2, '0')}-${dmy[1]}` : t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !isValidDate(iso))
    throw new Reject('DATE_INVALID', `date ${v ?? ''} is not a valid calendar date`, 'date');
  return iso;
}

function isValidDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

const localDate = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

// -------------------------------------------------------------------------------------------- L1

function mapHeader(ctx: BatchContext, header: string[]) {
  // Later entries win: a layout may re-purpose a canonical name (NSE's legacy TIMESTAMP holds the date),
  // and a source's own field map overrides everything.
  const aliases: Record<string, string> = {
    ...Object.fromEntries(FIELDS.map((f) => [f, f])),
    ...COMMON,
    ...LAYOUT[ctx.adapter],
  };
  for (const [column, field] of Object.entries(ctx.fieldMap)) aliases[normaliseHeader(column)] = field;
  const columns = new Map<Field, number>();
  const ambiguous: string[] = [];
  header.forEach((h, i) => {
    const field = aliases[normaliseHeader(h)] as Field | undefined;
    if (!field || !FIELDS.includes(field)) return;
    if (columns.has(field)) ambiguous.push(`${field} (${header[columns.get(field)!]}, ${h})`);
    else columns.set(field, i);
  });
  const intraday = ctx.timeframe !== null;
  const missing = [...REQUIRED, ...(intraday ? (['timestamp'] as Field[]) : [])].filter(
    (f) => !columns.has(f),
  );
  if (missing.length)
    return { failure: { primaryCode: 'HEADER_MISSING_REQUIRED', message: `Missing: ${missing.join(', ')}` } };
  if (ambiguous.length)
    return {
      failure: {
        primaryCode: 'HEADER_AMBIGUOUS',
        message: `More than one column maps to ${ambiguous.join('; ')}`,
      },
    };
  return { columns };
}

// ---------------------------------------------------------------------------------------- L2, L3

interface Session {
  trading: boolean;
  openAt: Date | null;
  closeAt: Date | null;
}

export async function mapBars(
  c: pg.ClientBase,
  ctx: BatchContext,
  text: string,
  maxRows = MAX_ROWS,
): Promise<MapResult> {
  const table = parseCsv(text);
  const totalRows = table.rows.length;
  if (table.header.length === 0 || totalRows === 0)
    return {
      kind: 'FILE_FAILED',
      primaryCode: 'FILE_EMPTY',
      message: 'The file has no data rows',
      totalRows,
    };
  if (totalRows > maxRows)
    return {
      kind: 'FILE_FAILED',
      primaryCode: 'ROW_COUNT_EXCEEDED',
      message: `The file has ${totalRows} rows; the limit is ${maxRows}`,
      totalRows,
    };
  const mapped = mapHeader(ctx, table.header);
  if (mapped.failure) return { kind: 'FILE_FAILED', ...mapped.failure, totalRows };
  const columns = mapped.columns;

  const timeframes = new Set(
    (await c.query<{ code: string }>('select code from ref.timeframe')).rows.map((r) => r.code),
  );
  const sessions = new Map<string, Session>();
  const session = async (d: string): Promise<Session> => {
    let s = sessions.get(d);
    if (!s) {
      const row = (
        await c.query<{ trading: boolean; openAt: Date | null; closeAt: Date | null }>(
          `select is_trading_day as trading, session_open_at as "openAt", session_close_at as "closeAt"
             from ref.trading_calendar where exchange_id = $1 and calendar_date = $2`,
          [ctx.exchangeId, d],
        )
      ).rows[0];
      s = row ?? { trading: false, openAt: null, closeAt: null };
      sessions.set(d, s);
    }
    return s;
  };
  const symbolCounts = new Map<string, number>();
  const instrumentsNamed = async (symbol: string) => {
    let n = symbolCounts.get(symbol);
    if (n === undefined) {
      n = (
        await c.query<{ n: number }>(
          'select count(*)::int as n from ref.instrument where exchange_id = $1 and symbol = $2',
          [ctx.exchangeId, symbol],
        )
      ).rows[0]!.n;
      symbolCounts.set(symbol, n);
    }
    return n;
  };

  const pending: { bar: Omit<CanonicalBar, 'instrumentId'>; symbol: string; series: string }[] = [];
  const rejects: BarReject[] = [];
  const seenKeys = new Set<string>();
  const seriesFor = new Map<string, string>();

  for (const { rowNumber, fields, malformed } of table.rows) {
    const raw: RawRow = Object.fromEntries(table.header.map((h, i) => [h, fields[i]]));
    try {
      if (malformed || fields.length !== table.header.length)
        throw new Reject(
          'ROW_MALFORMED',
          malformed
            ? 'The row has unbalanced quoting'
            : `Expected ${table.header.length} fields, found ${fields.length}`,
        );
      const get = (f: Field) => {
        const i = columns.get(f);
        const v = i === undefined ? undefined : fields[i]?.trim();
        return v === undefined || ABSENT.has(v.toUpperCase()) ? undefined : v;
      };

      // Identity first, so a later row with the same key is a duplicate whatever else is wrong with either.
      const symbol = (get('symbol') ?? '').toUpperCase();
      const series = (get('series') ?? '').toUpperCase();
      if (symbol.length > 32) throw new Reject('FIELD_TOO_LONG', 'symbol exceeds 32 characters', 'symbol');
      if (series.length > 4) throw new Reject('FIELD_TOO_LONG', 'series exceeds 4 characters', 'series');
      if (!symbol) throw new Reject('SYMBOL_UNKNOWN', 'The row has no symbol', 'symbol');
      const sessionDate = date(get('date'));
      const timeframe = (get('timeframe') ?? ctx.timeframe ?? '1D').trim();
      if (!timeframes.has(timeframe))
        throw new Reject('TIMEFRAME_UNKNOWN', `${timeframe} is not a timeframe`, 'timeframe');
      if (timeframe !== (ctx.timeframe ?? '1D'))
        throw new Reject(
          'TIMEFRAME_UNKNOWN',
          `This batch carries ${ctx.timeframe ?? '1D'} bars, not ${timeframe}`,
          'timeframe',
        );

      const s = await session(sessionDate);
      if (!s.trading || !s.openAt || !s.closeAt)
        throw new Reject(
          'NOT_A_TRADING_DAY',
          `${sessionDate} is not a ${ctx.exchangeCode} trading day`,
          'date',
        );
      let bucketStart: Date = s.openAt;
      if (ctx.timeframe !== null) {
        const ts = get('timestamp');
        if (!ts || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(ts))
          throw new Reject('DATE_INVALID', 'timestamp must be ISO 8601 with an offset', 'timestamp');
        bucketStart = new Date(ts);
        if (!isValidDate(ts.slice(0, 10)) || Number.isNaN(bucketStart.getTime()))
          throw new Reject('DATE_INVALID', `timestamp ${ts} is not a valid instant`, 'timestamp');
        if (
          bucketStart < s.openAt ||
          bucketStart >= s.closeAt ||
          localDate(bucketStart, ctx.timezone) !== sessionDate
        )
          throw new Reject(
            'TIMESTAMP_OUT_OF_SESSION',
            `${ts} is outside the ${sessionDate} session`,
            'timestamp',
          );
      }

      // L3: the first occurrence of a key wins; a repeat is rejected (03 §3.3).
      const bucket = bucketStart.toISOString();
      const key = `${symbol}|${series}|${timeframe}|${bucket}`;
      if (seenKeys.has(key))
        throw new Reject('DUPLICATE_IN_FILE', 'An earlier row has the same symbol, series and bucket');
      seenKeys.add(key);
      const seriesKey = `${symbol}|${timeframe}|${bucket}`;
      const earlier = seriesFor.get(seriesKey);
      if (earlier === undefined) seriesFor.set(seriesKey, series);
      else if (earlier !== series && (await instrumentsNamed(symbol)) === 1)
        throw new Reject(
          'SERIES_CONFLICT',
          `An earlier row gives ${symbol} series ${earlier || '(none)'} for the same bucket`,
          'series',
        );

      const open = number(get('open'), 'open', { maxDigits: 14 });
      const high = number(get('high'), 'high', { maxDigits: 14 });
      const low = number(get('low'), 'low', { maxDigits: 14 });
      const close = number(get('close'), 'close', { maxDigits: 14 });
      const volume = number(get('volume'), 'volume', { integer: true, maxDigits: 18 });
      for (const [f, v] of [
        ['open', open],
        ['high', high],
        ['low', low],
        ['close', close],
        ['volume', volume],
      ] as const)
        if (v === undefined) throw new Reject('DECIMAL_INVALID', `${f} is required`, f);
      const deliveryQty = number(get('delivery_qty'), 'delivery_qty', { integer: true, maxDigits: 18 });
      const deliveryPct = number(get('delivery_pct'), 'delivery_pct', { maxDigits: 3 });
      const openInterest = number(get('open_interest'), 'open_interest', { integer: true, maxDigits: 18 });
      const turnover = number(get('turnover'), 'turnover', { maxDigits: 20 });
      number(get('prev_close'), 'prev_close', { maxDigits: 14 });

      const [o, h, l, cl] = [open!, high!, low!, close!].map(scaled) as [bigint, bigint, bigint, bigint];
      if (o <= 0n || h <= 0n || l <= 0n || cl <= 0n)
        throw new Reject('OHLC_NON_POSITIVE', 'Open, high, low and close must be above zero', 'open');
      if (h < l || h < o || h < cl || l > o || l > cl)
        throw new Reject(
          'OHLC_INCONSISTENT',
          'High must be the highest and low the lowest of the four prices',
          'high',
        );
      if (BigInt(volume!) < 0n) throw new Reject('VOLUME_NEGATIVE', 'volume is negative', 'volume');
      if (deliveryQty !== undefined || deliveryPct !== undefined) {
        if (deliveryQty === undefined || deliveryPct === undefined)
          throw new Reject('DELIVERY_INVALID', 'delivery_qty and delivery_pct come together', 'delivery_qty');
        if (BigInt(deliveryQty) < 0n || BigInt(deliveryQty) > BigInt(volume!))
          throw new Reject('DELIVERY_INVALID', 'delivery_qty must be between 0 and volume', 'delivery_qty');
        const pct = scaled(deliveryPct);
        if (pct < 0n || pct > 1_000_000n)
          throw new Reject('DELIVERY_INVALID', 'delivery_pct must be between 0 and 100', 'delivery_pct');
      }
      if (openInterest !== undefined && BigInt(openInterest) < 0n)
        throw new Reject('OPEN_INTEREST_INVALID', 'open_interest is negative', 'open_interest');
      if (turnover !== undefined && scaled(turnover) < 0n)
        throw new Reject('DECIMAL_INVALID', 'turnover is negative', 'turnover');

      pending.push({
        symbol,
        series,
        bar: {
          rowNumber,
          timeframe,
          bucketStart: bucket,
          sessionDate,
          open: open!,
          high: high!,
          low: low!,
          close: close!,
          volume: volume!,
          deliveryVolume: deliveryQty ?? null,
          deliveryPct: deliveryPct ?? null,
          openInterest: openInterest ?? null,
          turnover: turnover ?? null,
          raw,
        },
      });
    } catch (error) {
      if (!(error instanceof Reject)) throw error;
      rejects.push({ rowNumber, code: error.code, message: error.message, field: error.field, raw });
    }
  }
  // Symbols are resolved in one round trip per distinct (symbol, series, date), not one per row.
  const keyOf = (p: (typeof pending)[number]) => `${p.symbol}|${p.series}|${p.bar.sessionDate}`;
  const distinct = [...new Map(pending.map((p) => [keyOf(p), p])).values()];
  const found = await resolveSymbols(
    c,
    ctx.exchangeCode,
    distinct.map((p) => ({ symbol: p.symbol, series: p.series, asOf: p.bar.sessionDate })),
  );
  const resolution = new Map(distinct.map((p, i) => [keyOf(p), found[i]!]));
  // An unknown symbol that names an instrument outside its listing window is not tradable that day (03 §3.2).
  const unknown = distinct.filter((p) => resolution.get(keyOf(p))!.kind === 'UNKNOWN');
  const notTradable = new Set(
    unknown.length === 0
      ? []
      : (
          await c.query<{ k: string }>(
            `select q.symbol || '|' || q.series || '|' || q.as_of::text as k
               from unnest($2::text[], $3::text[], $4::date[]) q(symbol, series, as_of)
              where exists (select 1 from ref.instrument i
                             where i.exchange_id = $1 and i.symbol = q.symbol and i.series = q.series
                               and ((i.listing_date is not null and i.listing_date > q.as_of)
                                    or (i.delisting_date is not null and i.delisting_date < q.as_of)))`,
            [
              ctx.exchangeId,
              unknown.map((p) => p.symbol),
              unknown.map((p) => p.series),
              unknown.map((p) => p.bar.sessionDate),
            ],
          )
        ).rows.map((r) => r.k),
  );
  const bars: CanonicalBar[] = [];
  for (const p of pending) {
    const r = resolution.get(keyOf(p))!;
    const reject = (code: string, message: string) =>
      rejects.push({ rowNumber: p.bar.rowNumber, code, message, field: 'symbol', raw: p.bar.raw });
    if (r.kind === 'FOUND') bars.push({ ...p.bar, instrumentId: r.instrumentId });
    else if (r.kind === 'AMBIGUOUS')
      reject('SYMBOL_AMBIGUOUS', `${p.symbol} names ${r.instrumentIds.length} instruments`);
    else if (notTradable.has(keyOf(p)))
      reject('INSTRUMENT_NOT_TRADABLE_ON_DATE', `${p.symbol} was not listed on ${p.bar.sessionDate}`);
    else
      reject('SYMBOL_UNKNOWN', `${p.symbol} names no ${ctx.exchangeCode} instrument on ${p.bar.sessionDate}`);
  }
  return { kind: 'MAPPED', totalRows, bars, rejects };
}
