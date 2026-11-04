// Development seed (02 §9). A fixed PRNG seed, fixed timestamps and generated UUIDv7 ids make every run
// produce identical rows; only password hashes differ, because their salts are random by design.
import { argon2Sync, randomBytes } from 'node:crypto';
import type { ClientBase } from 'pg';

const SEED = 20261030;
const CALENDAR_START = '2022-10-31';
const END_DATE = '2026-10-30';
const DAILY_SESSIONS = 800;
const INTRADAY_SESSIONS = 400;
const FIXED_AT = '2026-10-30T12:00:00.000Z';
const HOLIDAYS = ['01-26', '03-14', '04-14', '05-01', '08-15', '10-02', '12-25'];
const SPECIAL_SESSION = { date: '2025-10-21', open: '18:00', close: '19:15', exchanges: ['NSE', 'BSE'] };
const BRICK_PCTS = ['0.1', '0.15', '0.25', '0.5', '1', '2', '3', '5'];

// ---------------------------------------------------------------- deterministic randomness and ids

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next: () => number;
  normal: () => number;
  uuid: () => string;
}

function createRng(): Rng {
  const next = mulberry32(SEED);
  let counter = 0;
  const base = Date.parse(FIXED_AT);
  return {
    next,
    normal() {
      let u = 0;
      while (u === 0) u = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    // UUIDv7 layout: a fixed millisecond base plus a counter, then seeded random bits.
    uuid() {
      const bytes = new Uint8Array(16);
      let ts = base + counter++;
      for (let i = 5; i >= 0; i--) {
        bytes[i] = ts % 256;
        ts = Math.floor(ts / 256);
      }
      for (let i = 6; i < 16; i++) bytes[i] = Math.floor(next() * 256);
      bytes[6] = (bytes[6]! & 0x0f) | 0x70;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}

// ---------------------------------------------------------------- dates and money

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const istInstant = (date: string, time: string) =>
  new Date(Date.parse(`${date}T${time}:00+05:30`)).toISOString();
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;
const plusMinutes = (instant: string, m: number) => new Date(Date.parse(instant) + m * 60_000).toISOString();

/** A non-negative integer amount of 1/10,000 rupee as a numeric(18,4) literal. */
function units4(units: number): string {
  return `${Math.trunc(units / 10_000)}.${String(units % 10_000).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- reference data definitions

const EXCHANGES = [
  { code: 'NSE', name: 'National Stock Exchange of India', open: '09:15', close: '15:30' },
  { code: 'BSE', name: 'BSE', open: '09:15', close: '15:30' },
  { code: 'NFO', name: 'NSE Futures and Options', open: '09:15', close: '15:30' },
  { code: 'MCX', name: 'Multi Commodity Exchange of India', open: '09:00', close: '23:30' },
  { code: 'NCDEX', name: 'National Commodity and Derivatives Exchange', open: '10:00', close: '17:00' },
] as const;

const SECTORS: [code: string, name: string, industries: string[]][] = [
  ['BANK', 'Banking', ['PVTBANK', 'PSUBANK', 'SMALLFIN', 'COOPBANK']],
  ['ITSV', 'Information Technology', ['ITSERV', 'SOFTPROD', 'ITINFRA', 'BPO']],
  ['PHRM', 'Pharmaceuticals', ['GENERICS', 'APIMFG', 'HOSPITALS']],
  ['AUTO', 'Automobiles', ['PASSVEH', 'TWOWHEEL', 'AUTOANC', 'COMMVEH']],
  ['FMCG', 'Consumer Goods', ['FOODBEV', 'PERSCARE', 'TOBACCO']],
  ['ENGY', 'Energy', ['OILGAS', 'POWERGEN', 'RENEW', 'GASDIST']],
  ['METL', 'Metals', ['STEEL', 'NONFERR', 'MINING']],
  ['RLTY', 'Realty', ['RESIDENT', 'COMMREAL', 'REITS']],
  ['TELE', 'Telecom', ['WIRELESS', 'TOWERS', 'BROADBND']],
  ['CAPG', 'Capital Goods', ['ENGG', 'DEFENCE', 'ELECEQP']],
  ['CHEM', 'Chemicals', ['SPECCHEM', 'FERTIL', 'AGROCHEM']],
  ['MDIA', 'Media', ['BROADCAST', 'FILMS', 'DIGITAL']],
];
const SUFFIXES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

interface InstrumentDef {
  id: string;
  exchange: string;
  symbol: string;
  name: string;
  type: string;
  assetClass: string;
  /** Tick in units of 1/10,000. */
  tickUnits: number;
  start: number;
  sigma: number;
  baseVolume: number;
  delivery: boolean;
  synthetic?: boolean;
  sector?: string;
  industry?: string;
}

// ---------------------------------------------------------------- insertion helpers

type Value = string | number | boolean | null;
type Row = Record<string, Value>;

/** Multi-row insert. Every row must carry the same keys as the first. */
async function insert(client: ClientBase, table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  const chunk = Math.floor(30_000 / columns.length);
  for (let i = 0; i < rows.length; i += chunk) {
    const params: Value[] = [];
    const tuples = rows
      .slice(i, i + chunk)
      .map((row) => `(${columns.map((c) => `$${params.push(row[c] ?? null)}`).join(', ')})`);
    await client.query(`insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}`, params);
  }
}

class BarSink {
  client: ClientBase;
  cols: (string | null)[][] = Array.from({ length: 12 }, () => []);

  constructor(client: ClientBase) {
    this.client = client;
  }

  async push(row: (string | null)[]): Promise<void> {
    row.forEach((v, i) => this.cols[i]!.push(v));
    if (this.cols[0]!.length >= 20_000) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.cols[0]!.length === 0) return;
    await this.client.query(
      `insert into md.market_bar (instrument_id, timeframe, bucket_start, session_date, open, high, low, close,
         volume, delivery_volume, delivery_pct, import_batch_id, validated_at, created_at, updated_at)
       select u.*, $13::timestamptz, $13::timestamptz, $13::timestamptz
         from unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::date[], $5::numeric[], $6::numeric[],
                     $7::numeric[], $8::numeric[], $9::bigint[], $10::bigint[], $11::numeric[], $12::uuid[]) as u`,
      [...this.cols, FIXED_AT],
    );
    this.cols = Array.from({ length: 12 }, () => []);
  }
}

function hashPassword(password: string): string {
  // 06 §4.4 parameters, PHC encoding. Phase 3 owns password hashing; the seed only needs valid hashes.
  const salt = randomBytes(16);
  const hash = argon2Sync('argon2id', {
    message: password,
    nonce: salt,
    parallelism: 1,
    tagLength: 32,
    memory: 65536,
    passes: 3,
  });
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=65536,t=3,p=1$${b64(salt)}$${b64(hash)}`;
}

// ---------------------------------------------------------------- the seed

export async function seedDev(client: ClientBase): Promise<{ passwords: Record<string, string> }> {
  const { rows } = await client.query<{ n: string }>('select count(*) as n from ref.exchange');
  if (rows[0]!.n !== '0')
    throw new Error('The database already holds reference data; seed only an empty schema.');

  const rng = createRng();
  const stamp = { created_at: FIXED_AT, updated_at: FIXED_AT };
  await client.query('begin');
  try {
    // Exchanges and calendars
    const exchangeIds = new Map<string, string>();
    await insert(
      client,
      'ref.exchange',
      EXCHANGES.map((e) => {
        const id = rng.uuid();
        exchangeIds.set(e.code, id);
        return {
          id,
          code: e.code,
          name: `${e.name} (dev placeholder session, VERIFY_BEFORE_PROD)`,
          default_open_time: e.open,
          default_close_time: e.close,
          ...stamp,
        };
      }),
    );

    const sessions = new Map<string, { date: string; open: string; close: string }[]>();
    const calendar: Row[] = [];
    for (const e of EXCHANGES) {
      const list: { date: string; open: string; close: string }[] = [];
      for (let d = CALENDAR_START; d <= END_DATE; d = addDays(d, 1)) {
        const weekend = weekday(d) === 0 || weekday(d) === 6;
        const special = d === SPECIAL_SESSION.date && SPECIAL_SESSION.exchanges.includes(e.code);
        const closed = weekend || HOLIDAYS.includes(d.slice(5)) || d === SPECIAL_SESSION.date;
        const trading = !closed || special;
        const open = trading ? istInstant(d, special ? SPECIAL_SESSION.open : e.open) : null;
        const close = trading ? istInstant(d, special ? SPECIAL_SESSION.close : e.close) : null;
        if (open && close) list.push({ date: d, open, close });
        calendar.push({
          exchange_id: exchangeIds.get(e.code)!,
          calendar_date: d,
          is_trading_day: trading,
          session_open_at: open,
          session_close_at: close,
          is_special: special,
          description: special ? 'Special session' : weekend ? 'Weekend' : trading ? null : 'Holiday',
          source: 'DEV_SEED',
          ...stamp,
        });
      }
      sessions.set(e.code, list);
    }
    await insert(client, 'ref.trading_calendar', calendar);

    // Sectors (12) and industries (40)
    const sectorIds = new Map<string, string>();
    const sectorRows: Row[] = [];
    const industryRows: Row[] = [];
    for (const [code, name, industries] of SECTORS) {
      const id = rng.uuid();
      sectorIds.set(code, id);
      sectorRows.push({ id, code, name, kind: 'SECTOR', ...stamp });
      for (const industry of industries) {
        const iid = rng.uuid();
        sectorIds.set(industry, iid);
        industryRows.push({
          id: iid,
          code: industry,
          name: industry,
          parent_id: id,
          kind: 'INDUSTRY',
          ...stamp,
        });
      }
    }
    await insert(client, 'ref.sector', sectorRows);
    await insert(client, 'ref.sector', industryRows);

    // Instruments: 60 equities, 4 indices, 4 ETFs, 2 commodities, 1 currency pair, 2 bond proxies, GS Composite
    const instruments: InstrumentDef[] = [];
    for (const [code, name, industries] of SECTORS) {
      for (let k = 0; k < 5; k++) {
        instruments.push({
          id: rng.uuid(),
          exchange: 'NSE',
          symbol: `${code}${'ABCDE'[k]}`,
          name: `${name} ${SUFFIXES[k]} Ltd`,
          type: 'EQUITY',
          assetClass: 'EQUITY',
          tickUnits: 500,
          start: Math.exp(Math.log(50) + rng.next() * Math.log(60)),
          sigma: 0.25 + rng.next() * 0.15,
          baseVolume: Math.round(Math.exp(Math.log(100_000) + rng.next() * Math.log(50))),
          delivery: true,
          sector: code,
          industry: industries[k % industries.length]!,
        });
      }
    }
    const other = (
      exchange: string,
      symbol: string,
      name: string,
      type: string,
      assetClass: string,
      tickUnits: number,
      start: number,
      sigma: number,
      baseVolume: number,
    ): InstrumentDef => ({
      id: rng.uuid(),
      exchange,
      symbol,
      name,
      type,
      assetClass,
      tickUnits,
      start,
      sigma,
      baseVolume,
      delivery: false,
    });
    instruments.push(
      other('NSE', 'NIFTY50', 'Nifty 50', 'INDEX', 'EQUITY', 500, 18000, 0.16, 0),
      other('NSE', 'BANKNIFTY', 'Nifty Bank', 'INDEX', 'EQUITY', 500, 42000, 0.2, 0),
      other('NSE', 'NIFTYMIDCAP', 'Nifty Midcap 100', 'INDEX', 'EQUITY', 500, 31000, 0.2, 0),
      other('BSE', 'SENSEX', 'Sensex', 'INDEX', 'EQUITY', 500, 61000, 0.16, 0),
      other('NSE', 'NIFTYETF', 'Nifty 50 ETF', 'ETF', 'EQUITY', 100, 190, 0.16, 2_000_000),
      other('NSE', 'BANKETF', 'Bank ETF', 'ETF', 'EQUITY', 100, 420, 0.2, 800_000),
      other('NSE', 'GOLDETF', 'Gold ETF', 'ETF', 'COMMODITY', 100, 48, 0.14, 3_000_000),
      other('NSE', 'LIQUIDETF', 'Liquid ETF', 'ETF', 'RATE', 100, 1000, 0.01, 50_000),
      other('MCX', 'GOLD', 'Gold continuous future', 'FUTURE', 'COMMODITY', 10_000, 52000, 0.14, 8_000),
      other('MCX', 'SILVER', 'Silver continuous future', 'FUTURE', 'COMMODITY', 10_000, 61000, 0.22, 12_000),
      other('NSE', 'USDINR', 'US dollar / Indian rupee', 'CURRENCY', 'FX', 25, 81, 0.05, 1_500_000),
      other(
        'NSE',
        'GSEC10Y',
        '10-year government security proxy',
        'BOND',
        'FIXED_INCOME',
        100,
        100,
        0.04,
        200_000,
      ),
      other('NSE', 'GILTIDX', 'Gilt index proxy', 'BOND', 'FIXED_INCOME', 100, 2500, 0.05, 50_000),
    );
    const gsComposite: InstrumentDef = {
      ...other(
        'MCX',
        'GSCOMPOSITE',
        'Gold-silver composite (synthetic, 00 A11)',
        'INDEX',
        'COMMODITY',
        100,
        1,
        0,
        0,
      ),
      synthetic: true,
    };
    await insert(
      client,
      'ref.instrument',
      [...instruments, gsComposite].map((i) => ({
        id: i.id,
        exchange_id: exchangeIds.get(i.exchange)!,
        symbol: i.symbol,
        name: i.name,
        instrument_type: i.type,
        asset_class: i.assetClass,
        tick_size: units4(i.tickUnits),
        price_precision: i.tickUnits % 100 === 0 ? 2 : 4,
        listing_date: CALENDAR_START,
        is_synthetic: i.synthetic ?? false,
        ...stamp,
      })),
    );
    const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
    const equities = instruments.filter((i) => i.type === 'EQUITY');

    await insert(
      client,
      'ref.instrument_sector_membership',
      equities.flatMap((i) => [
        {
          instrument_id: i.id,
          sector_id: sectorIds.get(i.sector!)!,
          effective_from: CALENDAR_START,
          created_at: FIXED_AT,
        },
        {
          instrument_id: i.id,
          sector_id: sectorIds.get(i.industry!)!,
          effective_from: CALENDAR_START,
          created_at: FIXED_AT,
        },
      ]),
    );
    const indexMembers: [string, InstrumentDef[]][] = [
      ['NIFTY50', equities.slice(0, 50)],
      ['SENSEX', equities.slice(0, 30)],
      ['BANKNIFTY', equities.filter((i) => i.sector === 'BANK')],
      ['NIFTYMIDCAP', equities.slice(50)],
    ];
    await insert(
      client,
      'ref.index_membership',
      indexMembers.flatMap(([index, members]) =>
        members.map((m) => ({
          index_instrument_id: bySymbol.get(index)!.id,
          member_instrument_id: m.id,
          effective_from: CALENDAR_START,
          created_at: FIXED_AT,
        })),
      ),
    );

    // Six splits and bonuses inside the daily history; raw prices jump on the ex-date (04 §7.2).
    const nseSessions = sessions.get('NSE')!.slice(-DAILY_SESSIONS);
    const actions = new Map<string, { date: string; from: number; to: number }>();
    const actionDefs: [string, number, number][] = [
      ['SPLIT', 1, 2],
      ['BONUS', 1, 2],
      ['SPLIT', 1, 5],
      ['BONUS', 2, 3],
      ['SPLIT', 1, 10],
      ['BONUS', 1, 2],
    ];
    const actionRows: Row[] = actionDefs.map(([type, from, to], k) => {
      const instrument = equities[k * 7]!;
      const date = nseSessions[150 + k * 100]!.date;
      actions.set(instrument.id, { date, from, to });
      return {
        id: rng.uuid(),
        instrument_id: instrument.id,
        action_type: type,
        ex_date: date,
        ratio_from: String(from),
        ratio_to: String(to),
        source: 'DEV_SEED',
        ...stamp,
      };
    });
    await insert(client, 'ref.corporate_action', actionRows);

    // Users: one per human role; the CLI prints their passwords once.
    const roleIds = new Map(
      (await client.query<{ code: string; id: string }>('select code, id from iam.role')).rows.map((r) => [
        r.code,
        r.id,
      ]),
    );
    const passwords: Record<string, string> = {};
    const userRows: Row[] = [];
    const userRoleRows: Row[] = [];
    for (const role of ['ADMIN', 'ANALYST', 'VIEWER']) {
      const id = rng.uuid();
      const email = `${role.toLowerCase()}@tradesoft.local`;
      const password = randomBytes(18).toString('base64url');
      passwords[email] = password;
      userRows.push({
        id,
        email,
        password_hash: hashPassword(password),
        display_name: `Development ${role.toLowerCase()}`,
        status: 'ACTIVE',
        mfa_required: role === 'ADMIN',
        password_changed_at: FIXED_AT,
        ...stamp,
      });
      userRoleRows.push({ user_id: id, role_id: roleIds.get(role)!, granted_at: FIXED_AT });
    }
    await insert(client, 'iam.app_user', userRows);
    await insert(client, 'iam.user_role', userRoleRows);

    // Bars. One completed batch per exchange and batch type, so no seeded bar looks derived (INV-D1).
    const missingDay = { instrument: equities[6]!.id, date: nseSessions[DAILY_SESSIONS - 100]!.date };
    const sourceId = rng.uuid();
    await insert(client, 'md.data_source', [
      { id: sourceId, code: 'DEV_FIXTURE', name: 'Development seed', kind: 'CSV', ...stamp },
    ]);
    const plans = instruments.map((i) => {
      const all = sessions.get(i.exchange)!;
      const daily = all
        .slice(-DAILY_SESSIONS)
        .filter((s) => !(i.id === missingDay.instrument && s.date === missingDay.date));
      const intraday = new Set(all.slice(-INTRADAY_SESSIONS).map((s) => s.date));
      return { instrument: i, daily, intraday };
    });
    const counts = new Map<string, number>();
    for (const p of plans) {
      const eod = `${p.instrument.exchange}:EOD_CSV`;
      const intra = `${p.instrument.exchange}:INTRADAY_CSV`;
      counts.set(eod, (counts.get(eod) ?? 0) + p.daily.length);
      for (const s of p.daily) {
        if (p.intraday.has(s.date))
          counts.set(intra, (counts.get(intra) ?? 0) + minutesBetween(s.open, s.close) / 15);
      }
    }
    const batchIds = new Map<string, string>();
    await insert(
      client,
      'md.import_batch',
      [...counts].map(([key, n]) => {
        const id = rng.uuid();
        batchIds.set(key, id);
        const [exchange, batchType] = key.split(':') as [string, string];
        return {
          id,
          source_id: sourceId,
          exchange_id: exchangeIds.get(exchange)!,
          batch_type: batchType,
          timeframe: batchType === 'INTRADAY_CSV' ? '15m' : null,
          status: 'COMPLETED',
          correlation_id: rng.uuid(),
          total_rows: n,
          accepted_rows: n,
          inserted_bars: n,
          received_at: FIXED_AT,
          started_at: FIXED_AT,
          completed_at: FIXED_AT,
          ...stamp,
        };
      }),
    );

    const sink = new BarSink(client);
    const firstClose = new Map<string, { ticks: number; bucket: string }>();
    for (const { instrument: i, daily, intraday } of plans) {
      const tickPrice = i.tickUnits / 10_000;
      const toTicks = (p: number) => Math.max(1, Math.round(p / tickPrice));
      const price = (ticks: number) => units4(ticks * i.tickUnits);
      const action = actions.get(i.id);
      const eodBatch = batchIds.get(`${i.exchange}:EOD_CSV`)!;
      const intraBatch = batchIds.get(`${i.exchange}:INTRADAY_CSV`)!;
      const dt = 1 / 250;
      let last = i.start;
      for (const s of daily) {
        let volumeScale = 1;
        if (action && action.date === s.date) {
          last = (last * action.from) / action.to;
          volumeScale = action.to / action.from;
        }
        const open = last * Math.exp(rng.normal() * 0.002);
        const close = open * Math.exp(i.sigma * Math.sqrt(dt) * rng.normal());
        const baseVolume = Math.round(i.baseVolume * volumeScale * Math.exp(0.4 * rng.normal()));
        let o: number, h: number, l: number, c: number, volume: number;
        if (intraday.has(s.date)) {
          // A Brownian bridge from the session open to its close, so 15m bars aggregate to the daily bar.
          const n = minutesBetween(s.open, s.close) / 15;
          const sd = i.sigma * Math.sqrt(dt / n);
          const walk = [0];
          for (let k = 1; k <= n; k++) walk.push(walk[k - 1]! + sd * rng.normal());
          const target = Math.log(close / open);
          const points = walk.map((w, k) => open * Math.exp(w - (k / n) * (walk[n]! - target)));
          const spread = Math.max(1, Math.round((open * sd * 0.5) / tickPrice));
          o = toTicks(points[0]!);
          h = 0;
          l = Number.MAX_SAFE_INTEGER;
          volume = 0;
          for (let k = 0; k < n; k++) {
            const bo = toTicks(points[k]!);
            const bc = toTicks(points[k + 1]!);
            const bh = Math.max(bo, bc) + Math.floor(Math.abs(rng.normal()) * spread);
            const bl = Math.max(1, Math.min(bo, bc) - Math.floor(Math.abs(rng.normal()) * spread));
            const edge = k === 0 || k === n - 1 ? 1 : 0;
            const bv = i.baseVolume === 0 ? 0 : Math.round((baseVolume / n) * (0.5 + rng.next() + edge));
            h = Math.max(h, bh);
            l = Math.min(l, bl);
            volume += bv;
            await sink.push([
              i.id,
              '15m',
              plusMinutes(s.open, k * 15),
              s.date,
              price(bo),
              price(bh),
              price(bl),
              price(bc),
              String(bv),
              null,
              null,
              intraBatch,
            ]);
          }
          c = toTicks(points[n]!);
        } else {
          const spread = Math.max(1, Math.round((open * 0.006) / tickPrice));
          o = toTicks(open);
          c = toTicks(close);
          h = Math.max(o, c) + Math.floor(Math.abs(rng.normal()) * spread);
          l = Math.max(1, Math.min(o, c) - Math.floor(Math.abs(rng.normal()) * spread));
          volume = i.baseVolume === 0 ? 0 : baseVolume;
        }
        let deliveryVolume: string | null = null;
        let deliveryPct: string | null = null;
        if (i.delivery && volume > 0) {
          const dv = Math.floor(volume * (0.2 + 0.5 * rng.next()));
          deliveryVolume = String(dv);
          deliveryPct = units4(Math.round((dv * 1_000_000) / volume));
        }
        if (!firstClose.has(i.id)) firstClose.set(i.id, { ticks: c, bucket: s.open });
        await sink.push([
          i.id,
          '1D',
          s.open,
          s.date,
          price(o),
          price(h),
          price(l),
          price(c),
          String(volume),
          deliveryVolume,
          deliveryPct,
          eodBatch,
        ]);
        last = c * tickPrice;
      }
    }
    await sink.flush();

    // Market groups: four sector groups, one index group, and the GS Composite (00 A11).
    const groups: [string, string, string, InstrumentDef[]][] = [
      ['SECTOR_BANK', 'Banking', 'SECTOR', equities.filter((i) => i.sector === 'BANK')],
      ['SECTOR_ITSV', 'Information Technology', 'SECTOR', equities.filter((i) => i.sector === 'ITSV')],
      ['SECTOR_PHRM', 'Pharmaceuticals', 'SECTOR', equities.filter((i) => i.sector === 'PHRM')],
      ['SECTOR_AUTO', 'Automobiles', 'SECTOR', equities.filter((i) => i.sector === 'AUTO')],
      ['NIFTY50', 'Nifty 50 constituents', 'INDEX', equities.slice(0, 50)],
      [
        'GS_COMPOSITE',
        'Gold-silver composite',
        'COMPOSITE',
        [bySymbol.get('GOLD')!, bySymbol.get('SILVER')!],
      ],
    ];
    const groupRows: Row[] = [];
    const memberRows: Row[] = [];
    for (const [code, name, type, members] of groups) {
      const id = rng.uuid();
      groupRows.push({ id, code, name, group_type: type, is_system: true, is_shared: true, ...stamp });
      for (const m of members)
        memberRows.push({ group_id: id, instrument_id: m.id, added_on: CALENDAR_START });
    }
    await insert(client, 'ref.market_group', groupRows);
    await insert(client, 'ref.market_group_member', memberRows);

    // Renko sets for all eight brick percentages on five instruments. Bricks are Phase 8's job.
    const renkoRows: Row[] = [];
    for (const i of equities.slice(0, 5)) {
      const anchor = firstClose.get(i.id)!;
      const anchorUnits = anchor.ticks * i.tickUnits;
      for (const pct of BRICK_PCTS) {
        // brick_size_abs = max(tick, round_half_up(anchor × pct / 100 / tick) × tick), exactly (04 §5.2, INV-10)
        const num = anchorUnits * Math.round(Number(pct) * 100);
        const den = 1_000_000 * i.tickUnits;
        const ticks = Math.max(1, Math.floor((2 * num + den) / (2 * den)));
        renkoRows.push({
          id: rng.uuid(),
          instrument_id: i.id,
          source_timeframe: '1D',
          brick_pct: pct,
          brick_size_abs: units4(ticks * i.tickUnits),
          anchor_price: units4(anchorUnits),
          anchor_bucket: anchor.bucket,
          ...stamp,
        });
      }
    }
    await insert(client, 'an.renko_brick_set', renkoRows);

    await client.query('commit');
    return { passwords };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
