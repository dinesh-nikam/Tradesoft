import { hostname } from 'node:os';
import pg from 'pg';
import { exitOnConfigError, loadConfig, type LoadedConfig } from '@tradesoft/config';
import {
  dispatchOutbox,
  ingestionJobs,
  jobRegistry,
  reclaimStale,
  runWorker,
  type OutboxRoutes,
} from '@tradesoft/db';
import { createLogger } from '@tradesoft/observability';
import { consoleTransport, sendEmailJob, smtpTransport } from './mail.ts';

let loaded: LoadedConfig;
try {
  loaded = loadConfig({ service: 'worker' });
} catch (error) {
  exitOnConfigError(error);
}
const { config, secrets } = loaded;
const log = createLogger({ service: 'worker', buildSha: config.BUILD_SHA, level: config.LOG_LEVEL });

// Job handlers and outbox routes are registered by the phases that own them (03 §5.3, 01 §6).
const mail =
  config.NODE_ENV === 'production'
    ? smtpTransport({
        host: config.MAIL_HOST!,
        port: config.MAIL_PORT,
        user: config.MAIL_USER ?? config.MAIL_FROM!,
        password: secrets.SMTP_PASSWORD!,
        from: config.MAIL_FROM!,
      })
    : consoleTransport(log);
const sendEmail = sendEmailJob(mail, config.PUBLIC_ORIGIN!);
const ingestion = ingestionJobs({ importRoot: config.IMPORT_ROOT });
const registry = jobRegistry(sendEmail, ...ingestion.jobs);
const routes: OutboxRoutes = { ...ingestion.routes };

const pool = new pg.Pool({ connectionString: secrets.DATABASE_URL!.reveal(), max: config.DATABASE_POOL_MAX });
const stop = new AbortController();
const workerId = `${hostname()}:${process.pid}`;

// 03 §5.3: the outbox dispatcher and the reaper are loops inside the worker, not jobs, so they keep running
// when the job table itself is what is broken.
function every(ms: number, name: string, task: () => Promise<unknown>): NodeJS.Timeout {
  return setInterval(() => {
    task().catch((err: unknown) => log.error({ err }, `${name} failed`));
  }, ms);
}
const withClient = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const timers = [
  every(10_000, 'outbox dispatch', () => withClient((c) => dispatchOutbox(c, routes))),
  every(60_000, 'reaper', () => withClient((c) => reclaimStale(c))),
];

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'worker draining');
    stop.abort();
  });
}

log.info({ workerId, concurrency: config.JOB_CONCURRENCY }, 'worker started');
await runWorker({
  pool,
  registry,
  queues: ['default', 'ingestion', 'analytics', 'maintenance'],
  workerId,
  concurrency: config.JOB_CONCURRENCY,
  log,
  signal: stop.signal,
});
timers.forEach(clearInterval);
await pool.end();
log.info({ workerId }, 'worker stopped');
