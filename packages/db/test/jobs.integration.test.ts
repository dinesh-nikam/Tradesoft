import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  cancelJob,
  claim,
  complete,
  dispatchOutbox,
  emitEvent,
  enqueue,
  fail,
  migrate,
  PermanentError,
  reclaimStale,
  RetryableError,
  retryDeadLetter,
  runWorker,
  scheduleDue,
  tryAcquireSchedulerLock,
  type EnqueueSpec,
  type JobDefinition,
} from '../src/index.ts';

// E3.5: the job-runtime scenarios of 03 §7.1 (7–10), retry and dead letter, outbox and scheduler.
const adminUrl = testDatabaseUrl();
const silent = { info() {}, warn() {}, error() {} };
const spec = (key: string | null, extra: Partial<EnqueueSpec> = {}): EnqueueSpec => ({
  type: 'test.job',
  payload: { key },
  payloadVersion: 1,
  queue: 'default',
  maxAttempts: 3,
  idempotencyKey: key,
  correlationId: randomUUID(),
  ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lock = { queues: ['default'] as const, limit: 1, lockMs: 60_000 };

describe.skipIf(!adminUrl)('job runtime', () => {
  let db: ScratchDatabase;
  let client: pg.Client;
  let other: pg.Client;

  const job = async (id: string) =>
    (
      await client.query<{
        status: string;
        attempts: number;
        reclaimed_count: number;
        completed_at: Date | null;
        last_error: { attempt: number } | null;
        delay_ms: number;
      }>(
        `select status, attempts, reclaimed_count, completed_at, last_error,
                (extract(epoch from run_after - now()) * 1000)::integer as delay_ms
           from ops.job where id = $1`,
        [id],
      )
    ).rows[0]!;
  const attempts = async (id: string) =>
    (
      await client.query<{ attempt_no: number; status: string }>(
        'select attempt_no, status from ops.job_attempt where job_id = $1 order by 1',
        [id],
      )
    ).rows;

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    client = await db.connect();
    other = await db.connect();
    await migrate(client);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await other?.end();
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await client.query('truncate ops.job, ops.job_schedule, ops.domain_event cascade');
  });

  it('scenario 7: a second enqueue with the same key is a no-op', async () => {
    const a = await enqueue(client, spec('k1'));
    const b = await enqueue(client, spec('k1'));
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });

  it('two workers claiming at once never receive the same job', async () => {
    for (let i = 0; i < 10; i++) await enqueue(client, spec(`k${i}`));
    const [x, y] = await Promise.all([
      claim(client, { ...lock, workerId: 'w1', limit: 10 }),
      claim(other, { ...lock, workerId: 'w2', limit: 10 }),
    ]);
    const ids = [...x, ...y].map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('retries a retryable failure with backoff, then dead-letters when attempts run out', async () => {
    const { id } = await enqueue(client, spec('r1', { maxAttempts: 2 }));
    const policy = { baseDelayMs: 1_000, maxDelayMs: 60_000, random: 0 };
    let [claimed] = await claim(client, { ...lock, workerId: 'w1' });
    expect(await fail(client, claimed!, 'w1', new RetryableError('db restart'), policy)).toBe('RETRY');
    const queued = await job(id);
    expect(queued).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(queued.delay_ms).toBeGreaterThan(400);
    expect(queued.delay_ms).toBeLessThanOrEqual(500);

    await client.query('update ops.job set run_after = now() where id = $1', [id]);
    [claimed] = await claim(client, { ...lock, workerId: 'w1' });
    expect(await fail(client, claimed!, 'w1', new RetryableError('db restart'), policy)).toBe('DEAD_LETTER');
    const dead = await job(id);
    expect(dead.status).toBe('DEAD_LETTER');
    expect(dead.completed_at).not.toBeNull();
    expect(dead.last_error!.attempt).toBe(2);
    expect(await attempts(id)).toEqual([
      { attempt_no: 1, status: 'FAILED' },
      { attempt_no: 2, status: 'FAILED' },
    ]);
  });

  it('dead-letters a permanent or unclassified failure at once', async () => {
    for (const error of [new PermanentError('bad payload'), new TypeError('bug')]) {
      const { id } = await enqueue(client, spec(randomUUID()));
      const [claimed] = await claim(client, { ...lock, workerId: 'w1' });
      expect(await fail(client, claimed!, 'w1', error, { baseDelayMs: 1_000, maxDelayMs: 1_000 })).toBe(
        'DEAD_LETTER',
      );
      expect((await job(id)).attempts).toBe(1);
    }
  });

  it('scenarios 9 and 10: the reaper reclaims an expired lock and the slow worker loses', async () => {
    const { id } = await enqueue(client, spec('slow'));
    await claim(client, { ...lock, workerId: 'slow-worker', lockMs: 1 });
    await sleep(20);
    expect(await reclaimStale(client)).toEqual({ reclaimed: 1, deadLettered: 0 });
    expect(await job(id)).toMatchObject({ status: 'QUEUED', reclaimed_count: 1 });
    expect(await attempts(id)).toEqual([{ attempt_no: 1, status: 'RECLAIMED' }]);
    expect(await complete(client, id, 'slow-worker')).toBe(false);

    const [again] = await claim(client, { ...lock, workerId: 'w2' });
    expect(again!.attempts).toBe(2);
    expect(await complete(client, id, 'w2')).toBe(true);
  });

  it('dead-letters an expired job that has no attempts left', async () => {
    const { id } = await enqueue(client, spec('last', { maxAttempts: 1 }));
    await claim(client, { ...lock, workerId: 'w1', lockMs: 1 });
    await sleep(20);
    expect(await reclaimStale(client)).toEqual({ reclaimed: 0, deadLettered: 1 });
    expect((await job(id)).status).toBe('DEAD_LETTER');
  });

  it('lets an operator retry a dead letter and cancel only queued jobs', async () => {
    const { id } = await enqueue(client, spec('op', { maxAttempts: 1 }));
    const [claimed] = await claim(client, { ...lock, workerId: 'w1' });
    await fail(client, claimed!, 'w1', new PermanentError('x'), { baseDelayMs: 1, maxDelayMs: 1 });
    expect(await cancelJob(client, id)).toBe(false);
    expect(await retryDeadLetter(client, id)).toBe(true);
    expect(await job(id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
    const [again] = await claim(client, { ...lock, workerId: 'w1' });
    expect(again!.attempts).toBe(1);
    expect((await attempts(id)).map((a) => a.attempt_no)).toEqual([1, 2]);

    const queued = await enqueue(client, spec('cancel-me'));
    expect(await cancelJob(client, queued.id)).toBe(true);
    expect(await retryDeadLetter(client, queued.id)).toBe(false);
  });

  it('dispatches each outbox event exactly once, inheriting its correlation id', async () => {
    const correlationId = randomUUID();
    const aggregateId = randomUUID();
    const event = { type: 'batch.completed', aggregateType: 'ImportBatch', aggregateId, correlationId };
    await emitEvent(client, event);
    await emitEvent(client, event);
    expect((await client.query('select 1 from ops.domain_event')).rowCount).toBe(1);

    const routes = {
      'batch.completed': (e: { aggregateId: string }) => [spec(`derive:${e.aggregateId}`)],
    };
    const [a, b] = await Promise.all([dispatchOutbox(client, routes), dispatchOutbox(other, routes)]);
    expect(a.jobs + b.jobs).toBe(1);
    expect((await dispatchOutbox(client, routes)).events).toBe(0);
    const { rows } = await client.query<{ correlation_id: string }>(
      'select correlation_id::text from ops.job',
    );
    expect(rows).toEqual([{ correlation_id: correlationId }]);
  });

  it('scenario 8: one scheduler holds the lock, and every missed window is enqueued once', async () => {
    expect(await tryAcquireSchedulerLock(client)).toBe(true);
    expect(await tryAcquireSchedulerLock(other)).toBe(false);
    await client.query("select pg_advisory_unlock(hashtext('tradesoft.scheduler'))");

    await client.query(
      `insert into ops.job_schedule (code, job_type, cron, timezone, next_run_at)
       values ('tick', 'test.tick', '* * * * *', 'Asia/Kolkata', date_trunc('minute', now()) - interval '3 minutes')`,
    );
    const tick: JobDefinition<{ scheduledFor: string }> = {
      type: 'test.tick',
      payloadVersion: 1,
      payloadSchema: { parse: (u) => u as { scheduledFor: string } },
      queue: 'maintenance',
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      idempotencyKey: (p) => `tick:${p.scheduledFor}`,
      handle: async () => {},
    };
    const registry = new Map([[tick.type, tick]]);
    const [x, y] = await Promise.all([scheduleDue(client, registry), scheduleDue(other, registry)]);
    expect(x.enqueued + y.enqueued).toBe(4);
    expect((await scheduleDue(client, registry)).enqueued).toBe(0);
    const next = await client.query<{ ahead: boolean }>(
      'select next_run_at > now() as ahead from ops.job_schedule',
    );
    expect(next.rows[0]!.ahead).toBe(true);
  });

  it('commits a handler and its completion together, and rolls back a failed handler', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 4 });
    const write: JobDefinition<{ key: string; fail: boolean }> = {
      type: 'test.write',
      payloadVersion: 1,
      payloadSchema: { parse: (u) => u as { key: string; fail: boolean } },
      queue: 'default',
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      idempotencyKey: (p) => p.key,
      lockScope: (p) => `test:${p.key}`,
      async handle(p, ctx) {
        await ctx.client.query("insert into ops.system_setting (key, value) values ($1, '1')", [
          `test.${p.key}`,
        ]);
        if (p.fail) throw new PermanentError('handler failed after writing');
      },
    };
    const ok = await enqueue(client, {
      ...spec('ok'),
      type: 'test.write',
      payload: { key: 'ok', fail: false },
    });
    const bad = await enqueue(client, {
      ...spec('bad'),
      type: 'test.write',
      payload: { key: 'bad', fail: true },
    });
    const stop = new AbortController();
    const worker = runWorker({
      pool,
      registry: new Map([[write.type, write]]),
      queues: ['default'],
      workerId: 'w-e2e',
      concurrency: 2,
      log: silent,
      signal: stop.signal,
      pollMs: 20,
    });
    for (let i = 0; i < 200; i++) {
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::integer as n from ops.job where id = any($1) and status in ('COMPLETED', 'DEAD_LETTER')",
        [[ok.id, bad.id]],
      );
      if (rows[0]!.n === 2) break;
      await sleep(25);
    }
    stop.abort();
    await worker;
    await pool.end();

    expect((await job(ok.id)).status).toBe('COMPLETED');
    expect((await job(bad.id)).status).toBe('DEAD_LETTER');
    const { rows } = await client.query<{ key: string }>(
      "select key from ops.system_setting where key like 'test.%'",
    );
    expect(rows).toEqual([{ key: 'test.ok' }]);
  });
});
