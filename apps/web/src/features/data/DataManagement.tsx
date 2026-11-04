import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { problemMessage, type Api } from '../../lib/api.ts';

// Data Management (08 Phase 4): exchanges and calendars, instruments, sectors, groups and corporate actions
// over the endpoints of 05 §11.4. Write controls appear only with the permission their endpoint requires.

interface Exchange {
  id: string;
  code: string;
  name: string;
  timezone: string;
}
interface CalendarDay {
  sessionDate: string;
  isTradingDay: boolean;
  sessionOpenAt: string | null;
  sessionCloseAt: string | null;
  isSpecial: boolean;
  description: string | null;
}
interface Instrument {
  id: string;
  exchangeCode: string;
  symbol: string;
  series: string;
  name: string;
  instrumentType: string;
  assetClass: string;
  tickSize: string;
  status: string;
  listingDate: string | null;
  delistingDate: string | null;
  isSynthetic: boolean;
}
interface Sector {
  id: string;
  code: string;
  name: string;
  kind: string;
  parentId: string | null;
  children: Sector[];
}
interface Group {
  id: string;
  code: string;
  name: string;
  groupType: string;
  isShared: boolean;
  isSystem: boolean;
  memberCount: number;
}
interface CorporateAction {
  id: string;
  symbol: string;
  actionType: string;
  exDate: string;
  ratioFrom: string | null;
  ratioTo: string | null;
  cashAmount: string | null;
}

type Run = (action: () => Promise<unknown>, done: string) => Promise<boolean>;
interface SectionProps {
  api: Api;
  perms: ReadonlySet<string>;
  run: Run;
}

const today = () => new Date().toISOString().slice(0, 10);
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const optional = (form: FormData, name: string) => field(form, name) || undefined;
// shortcut: every v1 exchange is in Asia/Kolkata (UTC+05:30, no DST); other zones need a zone-aware conversion.
const IST = '+05:30';
const istTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';

/** The instrument whose symbol is exactly `symbol`, found through the search endpoint. */
async function findInstrument(api: Api, symbol: string): Promise<Instrument> {
  const wanted = symbol.trim().toUpperCase();
  const { data } = await api.request<{ data: Instrument[] }>(
    'GET',
    `/instruments?q=${encodeURIComponent(wanted)}&limit=50`,
  );
  const hit = data.find((i) => i.symbol === wanted);
  if (!hit) throw new Error(`No instrument with symbol ${wanted}`);
  return hit;
}

function flatten(sectors: Sector[], depth = 0): { sector: Sector; depth: number }[] {
  return sectors.flatMap((s) => [{ sector: s, depth }, ...flatten(s.children, depth + 1)]);
}

const SECTIONS = [
  ['exchanges', 'Exchanges and calendars'],
  ['instruments', 'Instruments'],
  ['sectors', 'Sectors'],
  ['groups', 'Groups'],
  ['actions', 'Corporate actions'],
] as const;
type SectionKey = (typeof SECTIONS)[number][0];

export function DataManagement({ api, perms }: { api: Api; perms: ReadonlySet<string> }) {
  const [section, setSection] = useState<SectionKey>('exchanges');
  const [message, setMessage] = useState<string | null>(null);
  const run: Run = useCallback(async (action, done) => {
    try {
      await action();
      setMessage(done);
      return true;
    } catch (err) {
      setMessage(problemMessage(err, err instanceof Error ? err.message : 'The request failed'));
      return false;
    }
  }, []);
  const props = { api, perms, run };
  return (
    <section>
      <h2>Data Management</h2>
      <nav aria-label="Data sections" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {SECTIONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={section === key}
            onClick={() => {
              setSection(key);
              setMessage(null);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {message && <p role="status">{message}</p>}
      {section === 'exchanges' && <Exchanges {...props} />}
      {section === 'instruments' && <Instruments {...props} />}
      {section === 'sectors' && <Sectors {...props} />}
      {section === 'groups' && <Groups {...props} />}
      {section === 'actions' && <CorporateActions {...props} />}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} style={{ textAlign: 'left' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------- exchanges
function Exchanges({ api, perms, run }: SectionProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [exchangeId, setExchangeId] = useState('');
  const [range, setRange] = useState({ from: today(), to: today() });
  const [days, setDays] = useState<CalendarDay[]>([]);

  const loadExchanges = useCallback(async () => {
    const { data } = await api.request<{ data: Exchange[] }>('GET', '/exchanges');
    setExchanges(data);
    setExchangeId((current) => current || data[0]?.id || '');
  }, [api]);
  useEffect(() => {
    void run(loadExchanges, '');
  }, [loadExchanges, run]);

  const createExchange = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(async () => {
      // The time zone stays at the API default, Asia/Kolkata, which the IST shortcut above depends on.
      const created = await api.request<Exchange>('POST', '/exchanges', {
        code: field(f, 'code').toUpperCase(),
        name: field(f, 'name'),
        defaultOpenTime: field(f, 'open'),
        defaultCloseTime: field(f, 'close'),
      });
      await loadExchanges();
      setExchangeId(created.id);
    }, 'Exchange created. Load its calendar before any data for it.');
    if (ok) form.reset();
  };

  const loadDays = useCallback(async () => {
    if (!exchangeId) return;
    const q = `from=${range.from}&to=${range.to}`;
    setDays(
      (await api.request<{ data: CalendarDay[] }>('GET', `/exchanges/${exchangeId}/calendar?${q}`)).data,
    );
  }, [api, exchangeId, range]);
  useEffect(() => {
    void run(loadDays, '');
  }, [loadDays, run]);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const date = field(f, 'date');
    const trading = f.get('isTradingDay') === 'on';
    await run(async () => {
      await api.request('PUT', `/exchanges/${exchangeId}/calendar/${date}`, {
        isTradingDay: trading,
        ...(trading
          ? {
              sessionOpenAt: `${date}T${field(f, 'open')}:00${IST}`,
              sessionCloseAt: `${date}T${field(f, 'close')}:00${IST}`,
            }
          : {}),
        isSpecial: f.get('isSpecial') === 'on',
        ...(optional(f, 'description') ? { description: field(f, 'description') } : {}),
      });
      await loadDays();
    }, `Saved ${date}.`);
  };

  return (
    <>
      <label>
        Exchange{' '}
        <select value={exchangeId} onChange={(e) => setExchangeId(e.target.value)}>
          {exchanges.map((x) => (
            <option key={x.id} value={x.id}>
              {x.code} — {x.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        From{' '}
        <input
          type="date"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
      </label>{' '}
      <label>
        To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
      </label>
      {days.length === 0 ? (
        <p>No calendar rows in this range. A date without a row is an error, never a holiday.</p>
      ) : (
        <Table head={['Date', 'Trading', 'Open (IST)', 'Close (IST)', 'Special', 'Description']}>
          {days.map((d) => (
            <tr key={d.sessionDate}>
              <td>{d.sessionDate}</td>
              <td>{d.isTradingDay ? 'Yes' : 'Holiday'}</td>
              <td>{istTime(d.sessionOpenAt)}</td>
              <td>{istTime(d.sessionCloseAt)}</td>
              <td>{d.isSpecial ? 'Yes' : ''}</td>
              <td>{d.description}</td>
            </tr>
          ))}
        </Table>
      )}
      {perms.has('settings:write') && (
        <form onSubmit={(e) => void createExchange(e)}>
          <h3>Create an exchange</h3>
          <label>
            Code <input name="code" required pattern="[A-Za-z]{2,8}" size={8} />
          </label>{' '}
          <label>
            Name <input name="name" required maxLength={120} />
          </label>{' '}
          <label>
            Default open <input name="open" type="time" required defaultValue="09:15" />
          </label>{' '}
          <label>
            Default close <input name="close" type="time" required defaultValue="15:30" />
          </label>{' '}
          <button type="submit">Create exchange</button>
        </form>
      )}
      {perms.has('calendar:write') && exchangeId && (
        <form onSubmit={(e) => void save(e)}>
          <h3>Save a calendar day</h3>
          <label>
            Date <input name="date" type="date" required />
          </label>{' '}
          <label>
            <input name="isTradingDay" type="checkbox" defaultChecked /> Trading day
          </label>{' '}
          <label>
            Opens <input name="open" type="time" defaultValue="09:15" />
          </label>{' '}
          <label>
            Closes <input name="close" type="time" defaultValue="15:30" />
          </label>{' '}
          <label>
            <input name="isSpecial" type="checkbox" /> Special session
          </label>{' '}
          <label>
            Description <input name="description" maxLength={200} />
          </label>{' '}
          <button type="submit">Save day</button>
        </form>
      )}
    </>
  );
}

// -------------------------------------------------------------------------------- instruments
const INSTRUMENT_TYPES = ['EQUITY', 'INDEX', 'FUTURE', 'OPTION', 'ETF', 'BOND', 'CURRENCY', 'FUND'];
const ASSET_CLASSES = ['EQUITY', 'COMMODITY', 'FX', 'FIXED_INCOME', 'RATE'];

function Instruments({ api, perms, run }: SectionProps) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Instrument[]>([]);
  const [selected, setSelected] = useState<Instrument | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const canWrite = perms.has('instrument:write');

  useEffect(() => {
    void run(
      async () => setExchanges((await api.request<{ data: Exchange[] }>('GET', '/exchanges')).data),
      '',
    );
  }, [api, run]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const query = q.trim().length >= 2 ? `q=${encodeURIComponent(q.trim())}&` : '';
      const { data } = await api.request<{ data: Instrument[] }>('GET', `/instruments?${query}limit=50`);
      setFound(data);
    }, '');
  };

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(async () => {
      const created = await api.request<Instrument>('POST', '/instruments', {
        exchangeId: field(f, 'exchangeId'),
        symbol: field(f, 'symbol').toUpperCase(),
        name: field(f, 'name'),
        instrumentType: field(f, 'instrumentType'),
        assetClass: field(f, 'assetClass'),
        ...(optional(f, 'series') ? { series: field(f, 'series').toUpperCase() } : {}),
        ...(optional(f, 'tickSize') ? { tickSize: field(f, 'tickSize') } : {}),
        ...(optional(f, 'listingDate') ? { listingDate: field(f, 'listingDate') } : {}),
      });
      setSelected(created);
      form.reset();
    }, 'Instrument created.');
  };

  return (
    <>
      <form onSubmit={(e) => void search(e)}>
        <label>
          Symbol or name{' '}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="at least 2 characters" />
        </label>{' '}
        <button type="submit">Search</button>
      </form>
      {found.length > 0 && (
        <Table head={['Symbol', 'Name', 'Exchange', 'Type', 'Status', '']}>
          {found.map((i) => (
            <tr key={i.id}>
              <td>
                {i.symbol}
                {i.series && ` (${i.series})`}
              </td>
              <td>{i.name}</td>
              <td>{i.exchangeCode}</td>
              <td>
                {i.instrumentType}
                {i.isSynthetic && ' · synthetic'}
              </td>
              <td>{i.status}</td>
              <td>
                <button type="button" onClick={() => setSelected(i)}>
                  Open
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {selected && (
        <InstrumentDetail key={selected.id} api={api} perms={perms} run={run} initial={selected} />
      )}
      {canWrite && (
        <form onSubmit={(e) => void create(e)}>
          <h3>Create an instrument</h3>
          <label>
            Exchange{' '}
            <select name="exchangeId" required>
              {exchanges.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Symbol <input name="symbol" required maxLength={32} />
          </label>{' '}
          <label>
            Series <input name="series" maxLength={4} size={4} />
          </label>{' '}
          <label>
            Name <input name="name" required maxLength={200} />
          </label>{' '}
          <label>
            Type{' '}
            <select name="instrumentType">
              {INSTRUMENT_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>{' '}
          <label>
            Asset class{' '}
            <select name="assetClass">
              {ASSET_CLASSES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>{' '}
          <label>
            Tick size <input name="tickSize" placeholder="0.05" size={8} />
          </label>{' '}
          <label>
            Listed <input name="listingDate" type="date" />
          </label>{' '}
          <button type="submit">Create</button>
        </form>
      )}
    </>
  );
}

interface Alias {
  id: string;
  aliasSymbol: string;
  validFrom: string;
  validTo: string | null;
}
interface Membership {
  sectorId: string;
  sectorCode: string;
  sectorName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}
interface Constituent {
  instrumentId: string;
  symbol: string;
  weight: string | null;
  effectiveFrom: string;
}

function InstrumentDetail({ api, perms, run, initial }: SectionProps & { initial: Instrument }) {
  const [inst, setInst] = useState(initial);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [asOf, setAsOf] = useState(today());
  const [constituents, setConstituents] = useState<Constituent[]>([]);
  const base = `/instruments/${inst.id}`;
  const isIndex = inst.instrumentType === 'INDEX';

  const load = useCallback(async () => {
    setAliases((await api.request<{ data: Alias[] }>('GET', `${base}/aliases`)).data);
    if (perms.has('sector:read')) {
      setMemberships((await api.request<{ data: Membership[] }>('GET', `${base}/sector-memberships`)).data);
      setSectors((await api.request<{ data: Sector[] }>('GET', '/sectors')).data);
    }
    if (isIndex)
      setConstituents(
        (await api.request<{ data: Constituent[] }>('GET', `${base}/members?asOf=${asOf}`)).data,
      );
  }, [api, base, perms, isIndex, asOf]);
  useEffect(() => {
    void run(load, '');
  }, [load, run]);

  const submit =
    (handler: (f: FormData) => Promise<unknown>, done: string) => async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (await run(() => handler(new FormData(form)).then(load), done)) form.reset();
    };
  const setStatus = (status: string, delistingDate?: string) =>
    run(async () => {
      setInst(
        await api.request<Instrument>('PATCH', base, { status, ...(delistingDate ? { delistingDate } : {}) }),
      );
    }, `Status is now ${status}.`);
  const canWrite = perms.has('instrument:write');

  return (
    <article style={{ border: '1px solid #ddd', padding: 12, margin: '12px 0' }}>
      <h3>
        {inst.exchangeCode}:{inst.symbol} — {inst.name}
      </h3>
      <p>
        {inst.instrumentType} · {inst.assetClass} · tick {inst.tickSize} · {inst.status}
        {inst.listingDate && ` · listed ${inst.listingDate}`}
        {inst.delistingDate && ` · delisted ${inst.delistingDate}`}
      </p>
      {canWrite && inst.status !== 'DELISTED' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void setStatus('DELISTED', field(new FormData(e.currentTarget), 'delistingDate'));
          }}
        >
          {inst.status === 'ACTIVE' ? (
            <button type="button" onClick={() => void setStatus('SUSPENDED')}>
              Suspend
            </button>
          ) : (
            <button type="button" onClick={() => void setStatus('ACTIVE')}>
              Resume
            </button>
          )}{' '}
          <label>
            Delisting date <input name="delistingDate" type="date" required />
          </label>{' '}
          <button type="submit">Delist</button>
        </form>
      )}

      <h4>Symbol aliases</h4>
      <ul>
        {aliases.map((a) => (
          <li key={a.id}>
            {a.aliasSymbol} from {a.validFrom} {a.validTo ? `to ${a.validTo}` : 'onward'}{' '}
            {canWrite && (
              <button
                type="button"
                onClick={() =>
                  void run(
                    () => api.request('DELETE', `${base}/aliases/${a.id}`).then(load),
                    'Alias removed.',
                  )
                }
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form
          onSubmit={(e) =>
            void submit(
              (f) =>
                api.request('POST', `${base}/aliases`, {
                  aliasSymbol: field(f, 'aliasSymbol').toUpperCase(),
                  validFrom: field(f, 'validFrom'),
                  ...(optional(f, 'validTo') ? { validTo: field(f, 'validTo') } : {}),
                }),
              'Alias added.',
            )(e)
          }
        >
          <label>
            Alias <input name="aliasSymbol" required maxLength={32} />
          </label>{' '}
          <label>
            From <input name="validFrom" type="date" required />
          </label>{' '}
          <label>
            To <input name="validTo" type="date" />
          </label>{' '}
          <button type="submit">Add alias</button>
        </form>
      )}

      {perms.has('sector:read') && (
        <>
          <h4>Sector memberships</h4>
          <ul>
            {memberships.map((m) => (
              <li key={`${m.sectorId}:${m.effectiveFrom}`}>
                {m.sectorName} ({m.sectorCode}) from {m.effectiveFrom}{' '}
                {m.effectiveTo ? `to ${m.effectiveTo}` : 'onward'}
              </li>
            ))}
          </ul>
          {perms.has('sector:write') && (
            <form
              onSubmit={(e) =>
                void submit(
                  (f) =>
                    api.request('POST', `${base}/sector-memberships`, {
                      sectorId: field(f, 'sectorId'),
                      effectiveFrom: field(f, 'effectiveFrom'),
                    }),
                  'Membership added; an open period of the same kind was closed the day before.',
                )(e)
              }
            >
              <label>
                Sector{' '}
                <select name="sectorId" required>
                  {flatten(sectors).map(({ sector, depth }) => (
                    <option key={sector.id} value={sector.id}>
                      {'— '.repeat(depth)}
                      {sector.name}
                    </option>
                  ))}
                </select>
              </label>{' '}
              <label>
                From <input name="effectiveFrom" type="date" required />
              </label>{' '}
              <button type="submit">Classify</button>
            </form>
          )}
        </>
      )}

      {isIndex && (
        <>
          <h4>
            Constituents as of <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </h4>
          <ul>
            {constituents.map((m) => (
              <li key={m.instrumentId}>
                {m.symbol} {m.weight && `(${m.weight} %)`} since {m.effectiveFrom}{' '}
                {canWrite && (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () =>
                          api
                            .request('POST', `${base}/members/${m.instrumentId}/close`, { effectiveTo: asOf })
                            .then(load),
                        `${m.symbol} leaves the index after ${asOf}.`,
                      )
                    }
                  >
                    End on {asOf}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canWrite && (
            <form
              onSubmit={(e) =>
                void submit(async (f) => {
                  const member = await findInstrument(api, field(f, 'symbol'));
                  return api.request('POST', `${base}/members`, {
                    memberInstrumentId: member.id,
                    effectiveFrom: field(f, 'effectiveFrom'),
                    ...(optional(f, 'weight') ? { weight: field(f, 'weight') } : {}),
                  });
                }, 'Constituent added.')(e)
              }
            >
              <label>
                Member symbol <input name="symbol" required />
              </label>{' '}
              <label>
                From <input name="effectiveFrom" type="date" required />
              </label>{' '}
              <label>
                Weight % <input name="weight" size={6} />
              </label>{' '}
              <button type="submit">Add constituent</button>
            </form>
          )}
        </>
      )}
    </article>
  );
}

// ------------------------------------------------------------------------------------ sectors
function SectorTree({ sectors }: { sectors: Sector[] }) {
  return (
    <ul>
      {sectors.map((s) => (
        <li key={s.id}>
          {s.name}{' '}
          <small>
            ({s.code}, {s.kind})
          </small>
          {s.children.length > 0 && <SectorTree sectors={s.children} />}
        </li>
      ))}
    </ul>
  );
}

function Sectors({ api, perms, run }: SectionProps) {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const load = useCallback(async () => {
    setSectors((await api.request<{ data: Sector[] }>('GET', '/sectors')).data);
  }, [api]);
  useEffect(() => {
    void run(load, '');
  }, [load, run]);
  const all = flatten(sectors);
  const options = (blank: string) => [
    <option key="" value="">
      {blank}
    </option>,
    ...all.map(({ sector, depth }) => (
      <option key={sector.id} value={sector.id}>
        {'— '.repeat(depth)}
        {sector.name}
      </option>
    )),
  ];

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(async () => {
      await api.request('POST', '/sectors', {
        code: field(f, 'code').toUpperCase(),
        name: field(f, 'name'),
        kind: field(f, 'kind'),
        ...(optional(f, 'parentId') ? { parentId: field(f, 'parentId') } : {}),
      });
      await load();
    }, 'Sector created.');
    if (ok) form.reset();
  };
  const move = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api.request('PATCH', `/sectors/${field(f, 'sectorId')}`, {
        parentId: optional(f, 'parentId') ?? null,
      });
      await load();
    }, 'Sector moved.');
  };

  return (
    <>
      <SectorTree sectors={sectors} />
      {perms.has('sector:write') && (
        <>
          <form onSubmit={(e) => void create(e)}>
            <h3>Create a sector</h3>
            <label>
              Code <input name="code" required pattern="[A-Za-z][A-Za-z0-9_]{1,39}" />
            </label>{' '}
            <label>
              Name <input name="name" required maxLength={120} />
            </label>{' '}
            <label>
              Kind{' '}
              <select name="kind">
                <option>SECTOR</option>
                <option>INDUSTRY</option>
                <option>THEME</option>
              </select>
            </label>{' '}
            <label>
              Parent <select name="parentId">{options('(top level)')}</select>
            </label>{' '}
            <button type="submit">Create</button>
          </form>
          <form onSubmit={(e) => void move(e)}>
            <h3>Move a sector</h3>
            <label>
              Sector{' '}
              <select name="sectorId" required>
                {options('Choose…')}
              </select>
            </label>{' '}
            <label>
              New parent <select name="parentId">{options('(top level)')}</select>
            </label>{' '}
            <button type="submit">Move</button>
          </form>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------- groups
interface GroupMember {
  instrumentId: string;
  symbol: string;
  name: string;
  status: string;
}

function Groups({ api, perms, run }: SectionProps) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<Group | null>(null);
  const [asOf, setAsOf] = useState(today());
  const [members, setMembers] = useState<GroupMember[]>([]);
  const canWrite = perms.has('group:write');

  const load = useCallback(async () => {
    setGroups((await api.request<{ data: Group[] }>('GET', '/groups?limit=200')).data);
  }, [api]);
  useEffect(() => {
    void run(load, '');
  }, [load, run]);
  const loadMembers = useCallback(async () => {
    if (!selected) return;
    setMembers(
      (await api.request<{ data: GroupMember[] }>('GET', `/groups/${selected.id}/members?asOf=${asOf}`)).data,
    );
  }, [api, selected, asOf]);
  useEffect(() => {
    void run(loadMembers, '');
  }, [loadMembers, run]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(async () => {
      await api.request('POST', '/groups', {
        code: field(f, 'code').toUpperCase(),
        name: field(f, 'name'),
        isShared: f.get('isShared') === 'on',
      });
      await load();
    }, 'Group created.');
    if (ok) form.reset();
  };
  const addMember = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selected) return;
    const form = e.currentTarget;
    const symbol = field(new FormData(form), 'symbol');
    const ok = await run(async () => {
      const inst = await findInstrument(api, symbol);
      await api.request('POST', `/groups/${selected.id}/members`, {
        instrumentIds: [inst.id],
        addedOn: asOf,
      });
      await Promise.all([loadMembers(), load()]);
    }, `${symbol.toUpperCase()} added from ${asOf}.`);
    if (ok) form.reset();
  };
  const editable = selected !== null && canWrite && !selected.isSystem;

  return (
    <>
      <Table head={['Code', 'Name', 'Type', 'Members today', 'Visibility', '']}>
        {groups.map((g) => (
          <tr key={g.id}>
            <td>{g.code}</td>
            <td>{g.name}</td>
            <td>{g.groupType}</td>
            <td>{g.memberCount}</td>
            <td>{g.isSystem ? 'System' : g.isShared ? 'Shared' : 'Private'}</td>
            <td>
              <button type="button" onClick={() => setSelected(g)}>
                Open
              </button>
            </td>
          </tr>
        ))}
      </Table>
      {selected && (
        <article style={{ border: '1px solid #ddd', padding: 12, margin: '12px 0' }}>
          <h3>
            {selected.name} <small>({selected.code})</small>
          </h3>
          {selected.isSystem && <p>System groups are maintained through reference imports.</p>}
          <label>
            Members as of <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <ul>
            {members.map((m) => (
              <li key={m.instrumentId}>
                {m.symbol} — {m.name} {m.status !== 'ACTIVE' && `(${m.status})`}{' '}
                {editable && (
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        await api.request('POST', `/groups/${selected.id}/members/remove`, {
                          instrumentIds: [m.instrumentId],
                          removedOn: asOf,
                        });
                        await Promise.all([loadMembers(), load()]);
                      }, `${m.symbol} removed from ${asOf}.`)
                    }
                  >
                    Remove from {asOf}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {editable && (
            <>
              <form onSubmit={(e) => void addMember(e)}>
                <label>
                  Add symbol <input name="symbol" required />
                </label>{' '}
                <button type="submit">Add from {asOf}</button>
              </form>
              {perms.has('group:share') && (
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      async () => {
                        setSelected(
                          await api.request<Group>('PATCH', `/groups/${selected.id}`, {
                            isShared: !selected.isShared,
                          }),
                        );
                        await load();
                      },
                      selected.isShared ? 'The group is private.' : 'The group is shared.',
                    )
                  }
                >
                  {selected.isShared ? 'Make private' : 'Share'}
                </button>
              )}{' '}
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await api.request('DELETE', `/groups/${selected.id}`);
                    setSelected(null);
                    await load();
                  }, 'Group deleted.')
                }
              >
                Delete group
              </button>
            </>
          )}
        </article>
      )}
      {canWrite && (
        <form onSubmit={(e) => void create(e)}>
          <h3>Create a group</h3>
          <label>
            Code <input name="code" required pattern="[A-Za-z][A-Za-z0-9_]{1,39}" />
          </label>{' '}
          <label>
            Name <input name="name" required maxLength={120} />
          </label>{' '}
          {perms.has('group:share') && (
            <label>
              <input name="isShared" type="checkbox" /> Shared
            </label>
          )}{' '}
          <button type="submit">Create</button>
        </form>
      )}
    </>
  );
}

// --------------------------------------------------------------------------- corporate actions
const ACTION_TYPES = ['SPLIT', 'BONUS', 'DIVIDEND', 'RIGHTS', 'MERGER', 'DEMERGER', 'SYMBOL_CHANGE'];

function CorporateActions({ api, perms, run }: SectionProps) {
  const [actions, setActions] = useState<CorporateAction[]>([]);
  const [symbol, setSymbol] = useState('');
  const load = useCallback(
    async (filterSymbol = '') => {
      const filter = filterSymbol ? `instrumentId=${(await findInstrument(api, filterSymbol)).id}&` : '';
      setActions(
        (await api.request<{ data: CorporateAction[] }>('GET', `/corporate-actions?${filter}limit=200`)).data,
      );
    },
    [api],
  );
  useEffect(() => {
    void run(() => load(), '');
  }, [load, run]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(async () => {
      const inst = await findInstrument(api, field(f, 'symbol'));
      await api.request('POST', '/corporate-actions', {
        instrumentId: inst.id,
        actionType: field(f, 'actionType'),
        exDate: field(f, 'exDate'),
        ...(optional(f, 'ratioFrom') ? { ratioFrom: field(f, 'ratioFrom') } : {}),
        ...(optional(f, 'ratioTo') ? { ratioTo: field(f, 'ratioTo') } : {}),
        ...(optional(f, 'cashAmount') ? { cashAmount: field(f, 'cashAmount') } : {}),
      });
      await load(symbol);
    }, 'Corporate action recorded.');
    if (ok) form.reset();
  };

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => load(symbol.trim()), '');
        }}
      >
        <label>
          Symbol{' '}
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="all instruments" />
        </label>{' '}
        <button type="submit">Filter</button>
      </form>
      <Table head={['Symbol', 'Type', 'Ex-date', 'Ratio', 'Cash', '']}>
        {actions.map((a) => (
          <tr key={a.id}>
            <td>{a.symbol}</td>
            <td>{a.actionType}</td>
            <td>{a.exDate}</td>
            <td>{a.ratioFrom && `${a.ratioFrom} : ${a.ratioTo}`}</td>
            <td>{a.cashAmount}</td>
            <td>
              {perms.has('instrument:write') && (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await api.request('DELETE', `/corporate-actions/${a.id}`);
                      await load(symbol.trim());
                    }, 'Corporate action deleted.')
                  }
                >
                  Delete
                </button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {perms.has('instrument:write') && (
        <form onSubmit={(e) => void create(e)}>
          <h3>Record a corporate action</h3>
          <label>
            Symbol <input name="symbol" required />
          </label>{' '}
          <label>
            Type{' '}
            <select name="actionType">
              {ACTION_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>{' '}
          <label>
            Ex-date <input name="exDate" type="date" required />
          </label>{' '}
          <label>
            Ratio from <input name="ratioFrom" size={6} />
          </label>{' '}
          <label>
            Ratio to <input name="ratioTo" size={6} />
          </label>{' '}
          <label>
            Cash per share <input name="cashAmount" size={8} />
          </label>{' '}
          <button type="submit">Record</button>
        </form>
      )}
    </>
  );
}
