import pg from 'pg';
import { exitOnConfigError, loadConfig, type LoadedConfig } from '@tradesoft/config';
import { scheduleDue, tryAcquireSchedulerLock, type JobRegistry } from '@tradesoft/db';
import { createLogger } from '@tradesoft/observability';

// Definitions of scheduled job types are registered by the phases that own them (03 §5.3).
const registry: JobRegistry = new Map();

let loaded: LoadedConfig;
try {
  loaded = loadConfig({ service: 'scheduler' });
} catch (error) {
  exitOnConfigError(error);
}
const { config, secrets } = loaded;
const log = createLogger({ service: 'scheduler', buildSha: config.BUILD_SHA, level: config.LOG_LEVEL });
const client = new pg.Client({ connectionString: secrets.DATABASE_URL!.reveal() });
await client.connect();

// 03 §6 step 1: the session lock is held for the life of this process; a second instance exits quietly.
if (!(await tryAcquireSchedulerLock(client))) {
  log.info({}, 'another scheduler holds the lock; exiting');
  await client.end();
  process.exit(0);
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}

log.info({ tickMs: config.SCHEDULER_TICK_MS }, 'scheduler started');
while (!stopping) {
  try {
    const { enqueued, unknownTypes } = await scheduleDue(client, registry);
    if (enqueued > 0) log.info({ enqueued }, 'scheduled jobs enqueued');
    if (unknownTypes.length > 0)
      log.error({ unknownTypes }, 'schedules reference job types with no definition');
  } catch (err) {
    log.error({ err }, 'scheduler tick failed');
  }
  await new Promise((resolve) => setTimeout(resolve, config.SCHEDULER_TICK_MS));
}
await client.end();
log.info({}, 'scheduler stopped');
