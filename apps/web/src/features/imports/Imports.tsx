import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiProblem, problemMessage, type Api } from '../../lib/api.ts';

interface Source {
  id: string;
  code: string;
  name: string;
  kind: string;
  exchangeCode: string | null;
  config: { adapter?: string };
  isActive: boolean;
}

interface Batch {
  id: string;
  source: { id: string; code: string; name: string };
  exchangeCode: string;
  batchType: string;
  status: string;
  timeframe: string | null;
  supersedesBatchId: string | null;
  supersededByBatchId: string | null;
  file: { originalFilename: string; byteSize: number; sha256: string } | null;
  counts: {
    totalRows: number;
    acceptedRows: number;
    rejectedRows: number;
    insertedBars: number;
    updatedBars: number;
    unchangedBars: number;
  };
  errorSummary: {
    primaryCode?: string;
    message?: string;
    checks?: { code: string; passed: boolean; detail?: string }[];
  } | null;
  requestedBy: { displayName: string } | null;
  receivedAt: string;
  completedAt: string | null;
}

interface Reject {
  rowNumber: number;
  code: string;
  message: string;
  field: string | null;
  rawRow: Record<string, string>;
}

const TERMINAL = ['COMPLETED', 'VALIDATION_FAILED', 'PROCESSING_FAILED', 'RECONCILIATION_FAILED'];
const ADAPTERS = ['csv.generic.eod', 'csv.nse.bhavcopy', 'csv.bse.bhavcopy', 'csv.mcx.eod', 'csv.ncdex.eod'];
const REFERENCE_KINDS = [
  'CALENDAR',
  'INSTRUMENTS',
  'SECTOR_MEMBERSHIPS',
  'INDEX_MEMBERSHIPS',
  'CORPORATE_ACTIONS',
  'GROUP_MEMBERS',
];

/**
 * The Imports screen (08 Phase 5): upload a file, follow its batch through validation, persistence and
 * reconciliation, browse and export its rejects, reprocess it, or submit a correction. Every control appears
 * only with the permission its endpoint needs.
 */
export function Imports({ api, perms }: { api: Api; perms: ReadonlySet<string> }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Batch | null>(null);
  const [rejects, setRejects] = useState<{ data: Reject[]; next: string | null }>({ data: [], next: null });
  const [batchType, setBatchType] = useState('EOD_CSV');
  const [message, setMessage] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setSources((await api.request<{ data: Source[] }>('GET', '/ingestion/sources')).data);
  }, [api]);
  const loadBatches = useCallback(async () => {
    const q = status ? `&status=${status}` : '';
    setBatches((await api.request<{ data: Batch[] }>('GET', `/ingestion/batches?limit=50${q}`)).data);
  }, [api, status]);

  const open = useCallback(
    async (id: string) => {
      try {
        setSelected(await api.request<Batch>('GET', `/ingestion/batches/${id}`));
        const page = await api.request<{ data: Reject[]; page: { nextCursor: string | null } }>(
          'GET',
          `/ingestion/batches/${id}/rejects?limit=50`,
        );
        setRejects({ data: page.data, next: page.page.nextCursor });
      } catch (err) {
        setMessage(problemMessage(err, 'The batch could not be loaded'));
      }
    },
    [api],
  );

  useEffect(() => {
    void loadSources();
  }, [loadSources]);
  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);
  // A batch moves on by itself while the jobs run, so the list refreshes until every batch has finished.
  useEffect(() => {
    if (batches.every((b) => TERMINAL.includes(b.status))) return;
    const timer = setInterval(() => {
      void loadBatches();
      if (selected && !TERMINAL.includes(selected.status)) void open(selected.id);
    }, 3000);
    return () => clearInterval(timer);
  }, [batches, selected, loadBatches, open]);

  const moreRejects = async () => {
    if (!selected || !rejects.next) return;
    const page = await api.request<{ data: Reject[]; page: { nextCursor: string | null } }>(
      'GET',
      `/ingestion/batches/${selected.id}/rejects?limit=50&cursor=${rejects.next}`,
    );
    setRejects({ data: [...rejects.data, ...page.data], next: page.page.nextCursor });
  };

  const exportRejects = async () => {
    if (!selected) return;
    try {
      const csv = await api.request<string>('GET', `/ingestion/batches/${selected.id}/rejects.csv`);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `rejects-${selected.id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(problemMessage(err, 'The export failed'));
    }
  };

  /** A new Idempotency-Key per submission; a retry of the same submission would reuse it (05 §8). */
  const submit = async (path: string, form: FormData, done: string) => {
    try {
      const out = await api.request<{ batchId: string; status: string }>('POST', path, form, {
        'idempotency-key': crypto.randomUUID(),
      });
      setMessage(`${done} Batch ${out.batchId.slice(0, 8)} is ${out.status}.`);
      await loadBatches();
      await open(out.batchId);
      return true;
    } catch (err) {
      const existing =
        err instanceof ApiProblem
          ? (err.problem as unknown as { existingBatchId?: string }).existingBatchId
          : undefined;
      setMessage(problemMessage(err, 'The upload failed'));
      if (existing) await open(existing);
      return false;
    }
  };

  const upload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    const form = new FormData(target);
    for (const [k, v] of [...form.entries()]) if (v === '') form.delete(k);
    if (await submit('/ingestion/uploads', form, 'Uploaded.')) target.reset();
  };

  const correct = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selected) return;
    const target = e.currentTarget;
    const form = new FormData(target);
    form.set('sourceId', selected.source.id);
    form.set('exchangeCode', selected.exchangeCode);
    form.set('supersedesBatchId', selected.id);
    if (await submit('/market-data/corrections', form, 'Correction submitted.')) target.reset();
  };

  const act = async (action: 'reprocess' | 'reconcile') => {
    if (!selected) return;
    try {
      const out = await api.request<{ batchId: string }>(
        'POST',
        `/ingestion/batches/${selected.id}/${action}`,
      );
      setMessage(
        action === 'reprocess' ? 'A new batch was created from the same file.' : 'Reconciliation queued.',
      );
      await loadBatches();
      await open(out.batchId);
    } catch (err) {
      setMessage(problemMessage(err, `The ${action} request failed`));
    }
  };

  const createSource = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    const f = new FormData(target);
    try {
      await api.request('POST', '/ingestion/sources', {
        code: String(f.get('code')),
        name: String(f.get('name')),
        kind: 'CSV',
        ...(f.get('exchangeCode') ? { exchangeCode: String(f.get('exchangeCode')) } : {}),
        config: { adapter: String(f.get('adapter')) },
      });
      setMessage('Data source created.');
      target.reset();
      await loadSources();
    } catch (err) {
      setMessage(problemMessage(err, 'The data source could not be created'));
    }
  };

  const toggleSource = async (s: Source) => {
    try {
      await api.request('PATCH', `/ingestion/sources/${s.id}`, { isActive: !s.isActive });
      await loadSources();
    } catch (err) {
      setMessage(problemMessage(err, 'The data source could not be changed'));
    }
  };

  const active = sources.filter((s) => s.isActive);
  return (
    <section>
      <h2>Imports</h2>
      {message && <p role="status">{message}</p>}
      {perms.has('ingestion:submit') && (
        <form onSubmit={(e) => void upload(e)}>
          <h3>Upload a file</h3>
          <label>
            File <input name="file" type="file" accept=".csv,.txt" required />
          </label>{' '}
          <label>
            Source{' '}
            <select name="sourceId" required>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Exchange <input name="exchangeCode" defaultValue="NSE" required pattern="[A-Z]{2,8}" size={6} />
          </label>{' '}
          <label>
            Type{' '}
            <select name="batchType" value={batchType} onChange={(e) => setBatchType(e.target.value)}>
              <option value="EOD_CSV">End of day</option>
              <option value="INTRADAY_CSV">Intraday</option>
              <option value="REFERENCE">Reference data</option>
            </select>
          </label>{' '}
          {batchType === 'INTRADAY_CSV' && (
            <label>
              Timeframe{' '}
              <select name="timeframe">
                {['15m', '60m', '75m', '120m', '240m'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          )}
          {batchType === 'REFERENCE' && (
            <label>
              Kind{' '}
              <select name="referenceKind">
                {REFERENCE_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          )}{' '}
          <button type="submit" disabled={active.length === 0}>
            Upload
          </button>
        </form>
      )}
      <h3>Batches</h3>
      <label>
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['RECEIVED', 'VALIDATING', 'VALIDATED', 'PROCESSING', ...TERMINAL].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>{' '}
      <button type="button" onClick={() => void loadBatches()}>
        Refresh
      </button>
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>File</th>
            <th>Exchange</th>
            <th>Type</th>
            <th>Status</th>
            <th>Rows</th>
            <th>Rejected</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} aria-selected={selected?.id === b.id}>
              <td>
                <button type="button" onClick={() => void open(b.id)}>
                  {new Date(b.receivedAt).toLocaleString()}
                </button>
              </td>
              <td>{b.file?.originalFilename ?? '—'}</td>
              <td>{b.exchangeCode}</td>
              <td>{b.batchType}</td>
              <td>{b.status}</td>
              <td>{b.counts.totalRows}</td>
              <td>{b.counts.rejectedRows}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <article aria-label="Batch detail">
          <h3>
            Batch {selected.id.slice(0, 8)} — {selected.status}
          </h3>
          <p>
            {selected.source.name}, {selected.exchangeCode}, {selected.batchType}
            {selected.timeframe ? ` ${selected.timeframe}` : ''}
            {selected.requestedBy ? `, by ${selected.requestedBy.displayName}` : ''}.{' '}
            {selected.file && `${selected.file.originalFilename} (${selected.file.byteSize} bytes).`}
          </p>
          <p>
            Rows {selected.counts.totalRows}: accepted {selected.counts.acceptedRows}, rejected{' '}
            {selected.counts.rejectedRows}. Bars inserted {selected.counts.insertedBars}, updated{' '}
            {selected.counts.updatedBars}, unchanged {selected.counts.unchangedBars}.
          </p>
          {selected.supersedesBatchId && (
            <p>
              Supersedes{' '}
              <button type="button" onClick={() => void open(selected.supersedesBatchId!)}>
                {selected.supersedesBatchId.slice(0, 8)}
              </button>
            </p>
          )}
          {selected.supersededByBatchId && (
            <p>
              Superseded by{' '}
              <button type="button" onClick={() => void open(selected.supersededByBatchId!)}>
                {selected.supersededByBatchId.slice(0, 8)}
              </button>
            </p>
          )}
          {selected.errorSummary?.primaryCode && (
            <p role="alert">
              {selected.errorSummary.primaryCode}: {selected.errorSummary.message}
            </p>
          )}
          {selected.errorSummary?.checks && (
            <ul>
              {selected.errorSummary.checks.map((c) => (
                <li key={c.code}>
                  {c.passed ? 'Passed' : 'Failed'} {c.code}
                  {c.detail ? ` — ${c.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
          {perms.has('ingestion:retry') && TERMINAL.includes(selected.status) && selected.file && (
            <button type="button" onClick={() => void act('reprocess')}>
              Reprocess the file
            </button>
          )}{' '}
          {perms.has('ingestion:reconcile') && selected.status === 'PROCESSING' && (
            <button type="button" onClick={() => void act('reconcile')}>
              Run reconciliation
            </button>
          )}
          <h4>Rejected rows</h4>
          {rejects.data.length === 0 ? (
            <p>None.</p>
          ) : (
            <>
              <button type="button" onClick={() => void exportRejects()}>
                Download as CSV
              </button>
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Code</th>
                    <th>Field</th>
                    <th>Message</th>
                    <th>Row as received</th>
                  </tr>
                </thead>
                <tbody>
                  {rejects.data.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.code}</td>
                      <td>{r.field ?? ''}</td>
                      <td>{r.message}</td>
                      <td>
                        <code>{Object.values(r.rawRow).join(',')}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rejects.next && (
                <button type="button" onClick={() => void moreRejects()}>
                  More rejects
                </button>
              )}
            </>
          )}
          {perms.has('marketdata:correct') &&
            TERMINAL.includes(selected.status) &&
            selected.batchType !== 'REFERENCE' && (
              <form onSubmit={(e) => void correct(e)}>
                <h4>Submit a correction for this batch</h4>
                <label>
                  Corrected file <input name="file" type="file" accept=".csv,.txt" required />
                </label>
                <label style={{ display: 'block' }}>
                  Justification (20 to 1,000 characters){' '}
                  <textarea
                    name="justification"
                    required
                    minLength={20}
                    maxLength={1000}
                    rows={3}
                    cols={60}
                  />
                </label>
                <button type="submit">Submit correction</button>
              </form>
            )}
        </article>
      )}
      {perms.has('settings:write') && (
        <>
          <h3>Data sources</h3>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Exchange</th>
                <th>Adapter</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.code}</td>
                  <td>{s.name}</td>
                  <td>{s.exchangeCode ?? 'any'}</td>
                  <td>{s.config.adapter ?? '—'}</td>
                  <td>
                    <button type="button" onClick={() => void toggleSource(s)}>
                      {s.isActive ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={(e) => void createSource(e)}>
            <h4>Add a CSV data source</h4>
            <label>
              Code <input name="code" required pattern="[A-Z][A-Z0-9_]{1,39}" size={12} />
            </label>{' '}
            <label>
              Name <input name="name" required />
            </label>{' '}
            <label>
              Exchange <input name="exchangeCode" pattern="[A-Z]{2,8}" size={6} />
            </label>{' '}
            <label>
              Adapter{' '}
              <select name="adapter">
                {ADAPTERS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>{' '}
            <button type="submit">Add source</button>
          </form>
        </>
      )}
    </section>
  );
}
