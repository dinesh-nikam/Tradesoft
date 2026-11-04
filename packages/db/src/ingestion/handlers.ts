import {
  PermanentError,
  RetryableError,
  specFor,
  type JobContext,
  type JobDefinition,
  type OutboxRoutes,
} from '../jobs.ts';
import { persistBatch, reconcileBatch, validateBatch, type StepOutcome } from './pipeline.ts';

/** Jobs and outbox routes of the ingestion pipeline (03 §5.3). */

export interface BatchPayload {
  batchId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const batchPayload = {
  parse(input: unknown): BatchPayload {
    const id = (input as { batchId?: unknown } | null)?.batchId;
    if (typeof id !== 'string' || !UUID.test(id)) throw new PermanentError('payload.batchId must be a UUID');
    return { batchId: id };
  },
};

/**
 * A missing file, or a step that hits a bug, fails the same way again, so it dead-letters. Any other
 * failure (a lost connection, a missing partition) is retried with backoff (03 §5.2).
 */
async function run(step: () => Promise<StepOutcome>, ctx: JobContext, batchId: string) {
  try {
    const outcome = await step();
    ctx.log.info({ batchId, outcome }, 'ingestion step finished');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || error instanceof TypeError || error instanceof PermanentError) throw error;
    throw new RetryableError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function batchJob(
  type: string,
  key: string,
  limits: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number },
  step: (ctx: JobContext, batchId: string) => Promise<StepOutcome>,
): JobDefinition<BatchPayload> {
  return {
    type,
    payloadVersion: 1,
    payloadSchema: batchPayload,
    queue: 'ingestion',
    ...limits,
    idempotencyKey: (p) => `${key}:${p.batchId}`,
    handle: (p, ctx) => run(() => step(ctx, p.batchId), ctx, p.batchId),
  };
}

export function ingestionJobs(o: { importRoot: string }) {
  const parseValidate = batchJob(
    'ingestion.parse_validate',
    'parse',
    { maxAttempts: 3, baseDelayMs: 30_000, maxDelayMs: 600_000 },
    (ctx, id) => validateBatch(ctx.client, o.importRoot, id),
  );
  const persistBars = batchJob(
    'ingestion.persist_bars',
    'persist',
    { maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 900_000 },
    (ctx, id) => persistBatch(ctx.client, o.importRoot, id),
  );
  const reconcile = batchJob(
    'ingestion.reconcile',
    'reconcile',
    { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 1_200_000 },
    (ctx, id) => reconcileBatch(ctx.client, o.importRoot, id),
  );
  const routes: OutboxRoutes = {
    'import.received': (e) => [specFor(parseValidate, { batchId: e.aggregateId }, e.correlationId)],
    'batch.validated': (e) => [specFor(persistBars, { batchId: e.aggregateId }, e.correlationId)],
    'batch.persisted': (e) => [specFor(reconcile, { batchId: e.aggregateId }, e.correlationId)],
  };
  return { jobs: [parseValidate, persistBars, reconcile], routes, reconcile };
}
