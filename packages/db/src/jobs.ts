import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { ClientBase, Pool } from 'pg';

// Job runtime of 03 §5–§6: enqueue, claim, complete, fail with backoff, dead letter, reclaim, outbox
// dispatch and scheduling. Every state change carries its guard in the WHERE clause, so a racing writer
// loses cleanly instead of overwriting (03 §7.1 scenarios 7–10).

type Queryable = Pick<ClientBase, 'query'>;
export type Queue = 'default' | 'ingestion' | 'analytics' | 'maintenance';

/** Retry later, with backoff, while attempts remain. */
export class RetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableError';
  }
}

/** Dead-letter now. Any error that is not a RetryableError is treated the same way (03 §5.2). */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface JobContext {
  /** The job's own transaction: the handler's writes commit together with the job's completion. */
  client: ClientBase;
  jobId: string;
  attempt: number;
  correlationId: string;
  signal: AbortSignal;
  log: JobLogger;
}

/** 03 §5.1 */
export interface JobDefinition<P> {
  type: string;
  payloadVersion: number;
  payloadSchema: { parse(input: unknown): P };
  queue: Queue;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Stable key; a second enqueue with the same key is a no-op. Null for naturally idempotent jobs. */
  idempotencyKey(payload: P): string | null;
  /** Advisory lock scope, when the job mutates a shared aggregate (03 §7.2). */
  lockScope?(payload: P): string | null;
  handle(payload: P, ctx: JobContext): Promise<void>;
}

// A registry holds definitions of many payload types; the runtime parses each payload before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobRegistry = ReadonlyMap<string, JobDefinition<any>>;

/** A registry keyed by job type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jobRegistry(...defs: JobDefinition<any>[]): JobRegistry {
  return new Map(defs.map((d) => [d.type, d]));
}

export interface EnqueueSpec {
  type: string;
  payload: unknown;
  payloadVersion: number;
  queue: Queue;
  maxAttempts: number;
  idempotencyKey: string | null;
  correlationId: string;
  runAfter?: string;
  priority?: number;
}

export function specFor<P>(def: JobDefinition<P>, payload: P, correlationId: string): EnqueueSpec {
  return {
    type: def.type,
    payload,
    payloadVersion: def.payloadVersion,
    queue: def.queue,
    maxAttempts: def.maxAttempts,
    idempotencyKey: def.idempotencyKey(payload),
    correlationId,
  };
}

/** Inserts a job, or returns the existing one with the same idempotency key (03 §7.1 scenario 7). */
export async function enqueue(db: Queryable, s: EnqueueSpec): Promise<{ id: string; created: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `insert into ops.job (queue, job_type, payload, payload_version, max_attempts, idempotency_key,
                          correlation_id, run_after, priority)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9)
     on conflict (idempotency_key) where idempotency_key is not null do nothing
     returning id::text`,
    [
      s.queue,
      s.type,
      JSON.stringify(s.payload),
      s.payloadVersion,
      s.maxAttempts,
      s.idempotencyKey,
      s.correlationId,
      s.runAfter ?? null,
      s.priority ?? 100,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await db.query<{ id: string }>('select id::text from ops.job where idempotency_key = $1', [
    s.idempotencyKey,
  ]);
  return { id: existing.rows[0]!.id, created: false };
}

/** 03 §5.2: capped exponential backoff, uniformly between 50 % and 100 % of the capped value. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: number,
): number {
  return Math.round(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + random * 0.5));
}

export interface ClaimedJob {
  id: string;
  jobType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
}

/**
 * Claims up to `limit` due jobs with FOR UPDATE SKIP LOCKED and opens an attempt row for each. Attempt rows
 * are numbered from the attempt history, because an operator retry resets ops.job.attempts.
 */
export async function claim(
  db: Queryable,
  o: { queues: readonly Queue[]; workerId: string; limit: number; lockMs: number },
): Promise<ClaimedJob[]> {
  const { rows } = await db.query<ClaimedJob>(
    `with picked as (
       select id from ops.job
        where status = 'QUEUED' and queue = any($1::text[]) and run_after <= now()
        order by priority, run_after
        limit $2
        for update skip locked),
     claimed as (
       update ops.job j
          set status = 'RUNNING', attempts = j.attempts + 1, locked_by = $3, locked_at = now(),
              lock_expires_at = now() + make_interval(secs => $4::double precision / 1000),
              started_at = coalesce(j.started_at, now())
         from picked
        where j.id = picked.id
       returning j.id, j.job_type, j.payload, j.attempts, j.max_attempts, j.correlation_id),
     attempt as (
       insert into ops.job_attempt (job_id, attempt_no, worker_id, status)
       select c.id, coalesce((select max(a.attempt_no) from ops.job_attempt a where a.job_id = c.id), 0) + 1,
              $3, 'RUNNING'
         from claimed c)
     select id::text, job_type as "jobType", payload, attempts, max_attempts as "maxAttempts",
            correlation_id::text as "correlationId"
       from claimed`,
    [o.queues, o.limit, o.workerId, o.lockMs],
  );
  return rows;
}

/** Extends the lock while the handler runs. False means the lock was lost to the reaper. */
export async function heartbeat(
  db: Queryable,
  jobId: string,
  workerId: string,
  lockMs: number,
): Promise<boolean> {
  const r = await db.query(
    `update ops.job set lock_expires_at = now() + make_interval(secs => $3::double precision / 1000)
      where id = $1 and status = 'RUNNING' and locked_by = $2`,
    [jobId, workerId, lockMs],
  );
  return r.rowCount === 1;
}

function finishAttempt(status: string, error: string): string {
  return `update ops.job_attempt
             set status = ${status}, finished_at = now(), error = ${error},
                 duration_ms = (extract(epoch from now() - started_at) * 1000)::integer
           where job_id in (select id from done) and status = 'RUNNING'
          returning 1`;
}

/** Marks the job COMPLETED. False means this worker no longer holds it (03 §7.1 scenario 10). */
export async function complete(db: Queryable, jobId: string, workerId: string): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    `with done as (
       update ops.job
          set status = 'COMPLETED', completed_at = now(), locked_by = null, locked_at = null,
              lock_expires_at = null
        where id = $1 and status = 'RUNNING' and locked_by = $2
       returning id),
     attempt as (${finishAttempt("'SUCCEEDED'", 'null')})
     select count(*)::integer as n from done`,
    [jobId, workerId],
  );
  return rows[0]!.n === 1;
}

export type FailureOutcome = 'RETRY' | 'DEAD_LETTER' | 'LOST';

/** Requeues with backoff while a retryable error has attempts left; dead-letters otherwise. */
export async function fail(
  db: Queryable,
  job: Pick<ClaimedJob, 'id' | 'attempts' | 'maxAttempts'>,
  workerId: string,
  error: unknown,
  policy: { baseDelayMs: number; maxDelayMs: number; random?: number },
): Promise<FailureOutcome> {
  const retry = error instanceof RetryableError && job.attempts < job.maxAttempts;
  const delayMs = retry
    ? backoffDelayMs(job.attempts, policy.baseDelayMs, policy.maxDelayMs, policy.random ?? Math.random())
    : 0;
  const e = error instanceof Error ? error : new Error(String(error));
  const lastError = JSON.stringify({
    name: e.name,
    message: e.message,
    stack: e.stack ?? null,
    attempt: job.attempts,
    at: new Date().toISOString(),
  });
  const { rows } = await db.query<{ n: number }>(
    `with done as (
       update ops.job
          set status = $3,
              run_after = case when $3 = 'QUEUED'
                               then now() + make_interval(secs => $4::double precision / 1000)
                               else run_after end,
              completed_at = case when $3 = 'DEAD_LETTER' then now() end,
              locked_by = null, locked_at = null, lock_expires_at = null, last_error = $5::jsonb
        where id = $1 and status = 'RUNNING' and locked_by = $2
       returning id),
     attempt as (${finishAttempt("'FAILED'", '$5::jsonb')})
     select count(*)::integer as n from done`,
    [job.id, workerId, retry ? 'QUEUED' : 'DEAD_LETTER', delayMs, lastError],
  );
  if (rows[0]!.n === 0) return 'LOST';
  return retry ? 'RETRY' : 'DEAD_LETTER';
}

/**
 * Returns jobs whose lock expired to QUEUED, recording a RECLAIMED attempt (03 §7.1 scenario 9). A job that has
 * already used every attempt is dead-lettered instead, because claiming it again would exceed max_attempts.
 */
export async function reclaimStale(db: Queryable): Promise<{ reclaimed: number; deadLettered: number }> {
  const { rows } = await db.query<{ status: string }>(
    `with stale as (
       select id from ops.job where status = 'RUNNING' and lock_expires_at < now() for update skip locked),
     done as (
       update ops.job j
          set status = case when j.attempts >= j.max_attempts then 'DEAD_LETTER' else 'QUEUED' end,
              completed_at = case when j.attempts >= j.max_attempts then now() end,
              reclaimed_count = j.reclaimed_count + 1, run_after = now(),
              locked_by = null, locked_at = null, lock_expires_at = null,
              last_error = jsonb_build_object('name', 'LockExpired', 'message', 'worker lock expired',
                                              'attempt', j.attempts, 'at', now())
         from stale
        where j.id = stale.id
       returning j.id, j.status),
     attempt as (
       update ops.job_attempt set status = 'RECLAIMED', finished_at = now()
        where job_id in (select id from done) and status = 'RUNNING' returning 1)
     select status from done`,
  );
  return {
    reclaimed: rows.filter((r) => r.status === 'QUEUED').length,
    deadLettered: rows.filter((r) => r.status === 'DEAD_LETTER').length,
  };
}

/** Operator retry of a dead letter (03 §5.4). False when the job is not dead-lettered. */
export async function retryDeadLetter(db: Queryable, jobId: string): Promise<boolean> {
  const r = await db.query(
    `update ops.job set status = 'QUEUED', attempts = 0, completed_at = null, run_after = now()
      where id = $1 and status = 'DEAD_LETTER'`,
    [jobId],
  );
  return r.rowCount === 1;
}

/** Operator cancel of a queued job (01 §3.2). False when the job is not queued. */
export async function cancelJob(db: Queryable, jobId: string): Promise<boolean> {
  const r = await db.query(
    "update ops.job set status = 'CANCELLED', completed_at = now() where id = $1 and status = 'QUEUED'",
    [jobId],
  );
  return r.rowCount === 1;
}

// ------------------------------------------------------------------------------------------ outbox

export interface DomainEventInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  payload?: Record<string, unknown>;
  correlationId: string;
}

/**
 * Writes an outbox row in the caller's transaction (ADR-019). The correlation id travels in
 * payload.context so dispatched jobs inherit it (07 §4.3). A replay of the same event version is a no-op.
 */
export async function emitEvent(db: Queryable, e: DomainEventInput): Promise<void> {
  await db.query(
    `insert into ops.domain_event (event_type, aggregate_type, aggregate_id, aggregate_version, payload)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (event_type, aggregate_id, aggregate_version) do nothing`,
    [
      e.type,
      e.aggregateType,
      e.aggregateId,
      e.aggregateVersion ?? 1,
      JSON.stringify({ ...e.payload, context: { correlationId: e.correlationId } }),
    ],
  );
}

export interface DispatchedEvent {
  id: string;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId: string;
}

/** Event type -> the jobs it triggers (01 §6). An event with no route is marked processed. */
export type OutboxRoutes = Readonly<Record<string, (event: DispatchedEvent) => EnqueueSpec[]>>;

/**
 * Dispatches unprocessed events in one transaction on a dedicated client: enqueue every routed job, then mark
 * the events processed. Concurrent dispatchers skip each other's rows; job idempotency keys absorb replays.
 */
export async function dispatchOutbox(
  client: ClientBase,
  routes: OutboxRoutes,
  limit = 100,
): Promise<{ events: number; jobs: number }> {
  await client.query('begin');
  try {
    const { rows } = await client.query<{
      id: string;
      type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `select id::text, event_type as type, aggregate_id::text, payload from ops.domain_event
        where processed_at is null order by id limit $1 for update skip locked`,
      [limit],
    );
    let jobs = 0;
    for (const row of rows) {
      const context = (row.payload['context'] ?? {}) as { correlationId?: string };
      const event: DispatchedEvent = {
        id: row.id,
        type: row.type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        correlationId: context.correlationId ?? randomUUID(),
      };
      for (const spec of routes[row.type]?.(event) ?? []) {
        if ((await enqueue(client, { ...spec, correlationId: event.correlationId })).created) jobs++;
      }
    }
    if (rows.length > 0) {
      await client.query(
        'update ops.domain_event set published_at = now(), processed_at = now() where id = any($1::bigint[])',
        [rows.map((r) => r.id)],
      );
    }
    await client.query('commit');
    return { events: rows.length, jobs };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

// --------------------------------------------------------------------------------------- scheduler

/** 03 §6 step 1: only one scheduler instance holds the session lock. */
export async function tryAcquireSchedulerLock(client: ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    "select pg_try_advisory_lock(hashtext('tradesoft.scheduler')) as ok",
  );
  return rows[0]!.ok;
}

/**
 * 03 §6: enqueues every due window of every enabled schedule, catching up missed windows (07 AF-03) up to
 * `maxCatchUp` per schedule, keyed by the job type's own idempotency key so a double fire is a no-op.
 * A schedule whose job type has no definition is left untouched and reported.
 */
export async function scheduleDue(
  client: ClientBase,
  registry: JobRegistry,
  maxCatchUp = 100,
): Promise<{ enqueued: number; unknownTypes: string[] }> {
  await client.query('begin');
  try {
    const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
    const { rows } = await client.query<{
      id: string;
      job_type: string;
      cron: string;
      timezone: string;
      payload: Record<string, unknown>;
      next_run_at: Date | null;
    }>(
      `select id::text, job_type, cron, timezone, payload, next_run_at from ops.job_schedule
        where is_enabled and (next_run_at is null or next_run_at <= $1)
        for update skip locked`,
      [now],
    );
    let enqueued = 0;
    const unknownTypes: string[] = [];
    for (const row of rows) {
      const def = registry.get(row.job_type);
      if (!def) {
        unknownTypes.push(row.job_type);
        continue;
      }
      const cron = new Cron(row.cron, { timezone: row.timezone, paused: true });
      // A new schedule starts at its next window; an existing one fires every window that has come due.
      let due: Date | null = row.next_run_at ?? cron.nextRun(now);
      let fired = 0;
      while (row.next_run_at && due && due <= now && fired < maxCatchUp) {
        const payload = def.payloadSchema.parse({ ...row.payload, scheduledFor: due.toISOString() });
        if ((await enqueue(client, specFor(def, payload, randomUUID()))).created) enqueued++;
        fired++;
        due = cron.nextRun(due);
      }
      await client.query(
        `update ops.job_schedule
            set next_run_at = $2, last_enqueued_at = case when $3 then now() else last_enqueued_at end
          where id = $1`,
        [row.id, due, fired > 0],
      );
    }
    await client.query('commit');
    return { enqueued, unknownTypes };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

// ------------------------------------------------------------------------------------------ worker

export interface WorkerOptions {
  pool: Pool;
  registry: JobRegistry;
  queues: readonly Queue[];
  workerId: string;
  concurrency: number;
  log: JobLogger;
  signal: AbortSignal;
  /** 03 §7.1 scenario 9: a five-minute lock, extended every minute. */
  lockMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
}

/** Claims and runs jobs until `signal` aborts, then waits for the jobs in flight. */
export async function runWorker(o: WorkerOptions): Promise<void> {
  const running = new Set<Promise<void>>();
  const lockMs = o.lockMs ?? 300_000;
  while (!o.signal.aborted) {
    const free = o.concurrency - running.size;
    let jobs: ClaimedJob[] = [];
    if (free > 0) {
      const client = await o.pool.connect();
      try {
        jobs = await claim(client, { queues: o.queues, workerId: o.workerId, limit: free, lockMs });
      } finally {
        client.release();
      }
    }
    for (const job of jobs) {
      const p: Promise<void> = execute(o, job, lockMs).finally(() => running.delete(p));
      running.add(p);
    }
    if (jobs.length === 0 || running.size >= o.concurrency) {
      await Promise.race([...running, delay(o.pollMs ?? 1_000, o.signal)]);
    }
  }
  await Promise.allSettled(running);
}

async function execute(o: WorkerOptions, job: ClaimedJob, lockMs: number): Promise<void> {
  const def = o.registry.get(job.jobType);
  const meta = {
    jobId: job.id,
    jobType: job.jobType,
    attempt: job.attempts,
    correlation_id: job.correlationId,
  };
  const policy = { baseDelayMs: def?.baseDelayMs ?? 30_000, maxDelayMs: def?.maxDelayMs ?? 600_000 };
  const failWith = async (error: unknown) => {
    const client = await o.pool.connect();
    try {
      const outcome = await fail(client, job, o.workerId, error, policy);
      if (outcome === 'RETRY') o.log.warn({ ...meta, outcome, err: error }, 'job failed');
      else o.log.error({ ...meta, outcome, err: error }, 'job failed');
    } finally {
      client.release();
    }
  };

  let payload: unknown;
  try {
    if (!def) throw new PermanentError(`No handler is registered for ${job.jobType}`);
    payload = def.payloadSchema.parse(job.payload);
  } catch (error) {
    await failWith(error);
    return;
  }

  const heartbeatTimer = setInterval(() => {
    void (async () => {
      const c = await o.pool.connect();
      try {
        if (!(await heartbeat(c, job.id, o.workerId, lockMs)))
          o.log.warn(meta, 'heartbeat found the lock lost');
      } finally {
        c.release();
      }
    })().catch((err: unknown) => o.log.warn({ ...meta, err }, 'heartbeat failed'));
  }, o.heartbeatMs ?? 60_000);
  const client = await o.pool.connect();
  try {
    await client.query('begin');
    const scope = def.lockScope?.(payload);
    if (scope) await client.query('select pg_advisory_xact_lock(hashtext($1))', [scope]);
    await def.handle(payload, {
      client,
      jobId: job.id,
      attempt: job.attempts,
      correlationId: job.correlationId,
      signal: o.signal,
      log: o.log,
    });
    if (await complete(client, job.id, o.workerId)) {
      await client.query('commit');
      o.log.info(meta, 'job completed');
    } else {
      // Another worker owns the job now; discarding keeps its effects from being applied twice.
      await client.query('rollback');
      o.log.warn(meta, 'job lock lost; result discarded');
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await failWith(error);
  } finally {
    clearInterval(heartbeatTimer);
    client.release();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
