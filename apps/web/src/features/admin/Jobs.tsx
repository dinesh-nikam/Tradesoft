import { useCallback, useEffect, useState } from 'react';
import { problemMessage, type Api } from '../../lib/api.ts';

interface Job {
  id: string;
  jobType: string;
  queue: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  completedAt: string | null;
}

interface JobDetail extends Job {
  payload: unknown;
  runAfter: string;
  lastError: { name?: string; message?: string; attempt?: number; at?: string } | null;
  correlationId: string;
}

interface Attempt {
  attemptNo: number;
  workerId: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  error: { message?: string } | null;
}

/**
 * Job administration (03 §5.4, 05 §11.10): list jobs by status, inspect a dead letter's error and attempts,
 * retry it with job:retry, or cancel a queued job with job:cancel.
 */
export function Jobs({ api, perms }: { api: Api; perms: ReadonlySet<string> }) {
  const [status, setStatus] = useState('DEAD_LETTER');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<(JobDetail & { history: Attempt[] }) | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = status ? `?status=${status}` : '';
    setJobs((await api.request<{ data: Job[] }>('GET', `/admin/jobs${q}`)).data);
  }, [api, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    try {
      const [detail, attempts] = await Promise.all([
        api.request<JobDetail>('GET', `/admin/jobs/${id}`),
        api.request<{ data: Attempt[] }>('GET', `/admin/jobs/${id}/attempts`),
      ]);
      setSelected({ ...detail, history: attempts.data });
    } catch (err) {
      setMessage(problemMessage(err, 'The job could not be loaded'));
    }
  };

  const act = async (id: string, action: 'retry' | 'cancel') => {
    try {
      await api.request('POST', `/admin/jobs/${id}/${action}`);
      setMessage(action === 'retry' ? 'The job is queued again.' : 'The job is cancelled.');
      setSelected(null);
      await load();
    } catch (err) {
      setMessage(problemMessage(err, `The ${action} failed`));
    }
  };

  return (
    <section>
      <h2>Jobs</h2>
      {message && <p role="status">{message}</p>}
      <label>
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['QUEUED', 'RUNNING', 'COMPLETED', 'DEAD_LETTER', 'CANCELLED'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>{' '}
      <button type="button" onClick={() => void load()}>
        Refresh
      </button>
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Type</th>
            <th>Queue</th>
            <th>Status</th>
            <th>Attempts</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                <button type="button" onClick={() => void open(j.id)}>
                  {new Date(j.createdAt).toLocaleString()}
                </button>
              </td>
              <td>{j.jobType}</td>
              <td>{j.queue}</td>
              <td>{j.status}</td>
              <td>
                {j.attempts} of {j.maxAttempts}
              </td>
              <td>
                {j.status === 'DEAD_LETTER' && perms.has('job:retry') && (
                  <button type="button" onClick={() => void act(j.id, 'retry')}>
                    Retry
                  </button>
                )}
                {j.status === 'QUEUED' && perms.has('job:cancel') && (
                  <button type="button" onClick={() => void act(j.id, 'cancel')}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <article aria-label="Job detail">
          <h3>
            {selected.jobType} — {selected.status}
          </h3>
          <p>
            Payload <code>{JSON.stringify(selected.payload)}</code>. Correlation {selected.correlationId}.
          </p>
          {selected.lastError && (
            <p role="alert">
              {selected.lastError.name}: {selected.lastError.message} (attempt {selected.lastError.attempt},{' '}
              {selected.lastError.at})
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Worker</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {selected.history.map((a) => (
                <tr key={a.attemptNo}>
                  <td>{a.attemptNo}</td>
                  <td>{a.workerId}</td>
                  <td>{a.status}</td>
                  <td>{new Date(a.startedAt).toLocaleString()}</td>
                  <td>{a.durationMs === null ? '—' : `${a.durationMs} ms`}</td>
                  <td>{a.error?.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      )}
    </section>
  );
}
