// Ingestion routes of 05 §11.6 and the correction route of §11.5 (Phase 5). An upload stores the file,
// creates its batch and announces it in one transaction; validation, persistence and reconciliation are
// jobs (03 §5.3). Every write is audited in the transaction that makes it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  BAR_ADAPTERS,
  createImportBatch,
  enqueue,
  ImportFileError,
  importReference,
  ingestionJobs,
  mapBars,
  MAX_IMPORT_BYTES,
  openImportFile,
  readImportFile,
  REFERENCE_KINDS,
  retryDeadLetter,
  specFor,
  type StoredImportFile,
} from '@tradesoft/db';
import { readMultipart, type MultipartUpload } from './multipart.ts';
import { ApiError, withClient, type ApiDeps } from './platform.ts';
import { actor, inTx } from './routes-admin.ts';
import { audit, filters, invalid, isUnique } from './routes-reference.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const limit = z.coerce.number().int().min(1).max(200).default(50);
const multi = <T extends z.ZodType<string>>(item: T) =>
  z.union([item, z.array(item)]).transform((v) => (Array.isArray(v) ? v : [v]));
const TERMINAL = ['COMPLETED', 'VALIDATION_FAILED', 'PROCESSING_FAILED', 'RECONCILIATION_FAILED'];
const STATUSES = ['RECEIVED', 'VALIDATING', 'VALIDATED', 'PROCESSING', ...TERMINAL] as [string, ...string[]];
const BATCH_TYPES = [
  'EOD_CSV',
  'EOD_API',
  'INTRADAY_CSV',
  'INTRADAY_API',
  'CORRECTION',
  'REFERENCE',
] as const;
const CANONICAL_FIELDS = [
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

/** `md.data_source.config`: an adapter, a vendor field map, and the *name* of a credential variable. */
const sourceConfig = z
  .object({
    adapter: z.enum(BAR_ADAPTERS).optional(),
    fieldMap: z.record(z.string().min(1).max(64), z.enum(CANONICAL_FIELDS)).optional(),
    authEnvVar: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .optional(),
    baseUrl: z.url().optional(),
  })
  .strict();

const SOURCE = `s.id::text as id, s.code, s.name, s.kind, s.provider, e.code as "exchangeCode", s.config,
  s.is_active as "isActive", s.created_at as "createdAt", s.updated_at as "updatedAt"`;
const FROM_SOURCE = 'from md.data_source s left join ref.exchange e on e.id = s.exchange_id';

const BATCH = `b.id::text as id, json_build_object('id', s.id, 'code', s.code, 'name', s.name) as source,
  e.code as "exchangeCode", b.batch_type as "batchType", b.status, b.timeframe,
  b.supersedes_batch_id::text as "supersedesBatchId",
  (select x.id::text from md.import_batch x where x.supersedes_batch_id = b.id
    order by x.received_at desc limit 1) as "supersededByBatchId",
  case when f.id is null then null else json_build_object('id', f.id, 'originalFilename', f.original_filename,
    'byteSize', f.byte_size, 'sha256', encode(f.sha256, 'hex')) end as file,
  json_build_object('totalRows', b.total_rows, 'acceptedRows', b.accepted_rows, 'rejectedRows', b.rejected_rows,
    'insertedBars', b.inserted_bars, 'updatedBars', b.updated_bars,
    'unchangedBars', case when b.status in ('COMPLETED', 'RECONCILIATION_FAILED') and b.batch_type <> 'REFERENCE'
                          then b.accepted_rows - b.inserted_bars - b.updated_bars else 0 end) as counts,
  b.error_summary as "errorSummary", b.header_line as "headerLine",
  case when u.id is null then null else json_build_object('id', u.id, 'displayName', u.display_name) end
    as "requestedBy",
  b.received_at as "receivedAt", b.started_at as "startedAt", b.completed_at as "completedAt",
  b.correlation_id::text as "correlationId"`;
const FROM_BATCH = `from md.import_batch b
  join md.data_source s on s.id = b.source_id
  join ref.exchange e on e.id = b.exchange_id
  left join md.import_file f on f.id = b.file_id
  left join iam.app_user u on u.id = b.requested_by`;

const batchLinks = (id: string) => ({
  self: `/api/v1/ingestion/batches/${id}`,
  rejects: `/api/v1/ingestion/batches/${id}/rejects`,
});

/** 06 §10.4: a cell that a spreadsheet would read as a formula is prefixed with a quote. */
export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

type Received = {
  fields: MultipartUpload['fields'];
  file: StoredImportFile;
  filename: string;
  mimeType: string;
  discard: () => Promise<void>;
};
type Outcome = { keep: boolean; body: object };

export function registerIngestionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool } = deps;
  const root = deps.importRoot ?? 'data';
  const maxBytes = Math.min(deps.uploadMaxBytes ?? MAX_IMPORT_BYTES, MAX_IMPORT_BYTES);
  const reconcileJob = ingestionJobs({ importRoot: root }).reconcile;
  // 05 §12.11: one upload in flight per principal. shortcut: per process; move to shared state if the api
  // runs more than one instance.
  const inFlight = new Set<string>();

  // The body stays a stream; the upload handler reads it after authentication (06 §11.1 steps 1–4).
  app.addContentTypeParser('multipart/form-data', (_req, payload, done) => done(null, payload));

  const loadBatch = async (c: pg.ClientBase, id: string) => {
    const row = (await c.query(`select ${BATCH} ${FROM_BATCH} where b.id = $1`, [id])).rows[0] as
      { id: string; status: string; batchType: string } | undefined;
    if (!row) throw new ApiError('IMPORT_BATCH_NOT_FOUND', 'No such batch');
    return { ...row, links: { rejects: batchLinks(id).rejects } };
  };

  // --------------------------------------------------------------------------------- data sources
  app.get('/api/v1/ingestion/sources', { config: { permission: 'ingestion:read' } }, async (req) => {
    const q = filters({ isActive: z.enum(['true', 'false']).optional() }, req.query);
    const { rows } = await pool.query(
      `select ${SOURCE} ${FROM_SOURCE} where ($1::boolean is null or s.is_active = $1) order by s.code`,
      [q.isActive === undefined ? null : q.isActive === 'true'],
    );
    return { data: rows, page: { limit: rows.length, hasMore: false, nextCursor: null } };
  });

  app.post('/api/v1/ingestion/sources', { config: { permission: 'settings:write' } }, async (req, reply) => {
    const body = z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
        name: z.string().trim().min(1).max(120),
        kind: z.enum(['CSV', 'API', 'MANUAL']),
        provider: z.string().trim().min(1).max(60).default('INTERNAL'),
        exchangeCode: z
          .string()
          .regex(/^[A-Z]{2,8}$/)
          .optional(),
        config: sourceConfig.default({}),
      })
      .strict()
      .parse(req.body);
    if (body.kind === 'CSV' && !body.config.adapter)
      throw invalid('/config/adapter', 'A CSV source names its adapter');
    const created = await inTx(pool, async (c) => {
      let exchangeId: string | null = null;
      if (body.exchangeCode) {
        const ex = await c.query<{ id: string }>('select id::text as id from ref.exchange where code = $1', [
          body.exchangeCode,
        ]);
        if (!ex.rows[0]) throw new ApiError('EXCHANGE_NOT_FOUND', `Unknown exchange ${body.exchangeCode}`);
        exchangeId = ex.rows[0].id;
      }
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into md.data_source (code, name, kind, provider, exchange_id, config)
           values ($1, $2, $3, $4, $5, $6::jsonb) returning id::text as id`,
          [body.code, body.name, body.kind, body.provider, exchangeId, JSON.stringify(body.config)],
        );
        const id = rows[0]!.id;
        const after = (await c.query(`select ${SOURCE} ${FROM_SOURCE} where s.id = $1`, [id])).rows[0];
        await audit(c, req, {
          action: 'data_source.created',
          entityType: 'data_source',
          entityId: id,
          after,
        });
        return after as { id: string };
      } catch (error) {
        if (isUnique(error, 'uq_data_source_code'))
          throw new ApiError('RESOURCE_CONFLICT', `A data source with code ${body.code} exists`);
        throw error;
      }
    });
    return reply.code(201).header('location', `/api/v1/ingestion/sources/${created.id}`).send(created);
  });

  app.patch('/api/v1/ingestion/sources/:id', { config: { permission: 'settings:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        isActive: z.boolean().optional(),
        config: sourceConfig.optional(),
      })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const before = (await c.query(`select ${SOURCE} ${FROM_SOURCE} where s.id = $1 for update of s`, [id]))
        .rows[0];
      if (!before) throw new ApiError('IMPORT_SOURCE_NOT_FOUND', 'No such data source');
      await c.query(
        `update md.data_source set name = coalesce($2, name), is_active = coalesce($3, is_active),
                config = coalesce($4::jsonb, config), updated_at = now() where id = $1`,
        [id, body.name ?? null, body.isActive ?? null, body.config ? JSON.stringify(body.config) : null],
      );
      const after = (await c.query(`select ${SOURCE} ${FROM_SOURCE} where s.id = $1`, [id])).rows[0];
      await audit(c, req, {
        action: 'data_source.updated',
        entityType: 'data_source',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  });

  // ------------------------------------------------------------------------- uploads, corrections

  const idempotencyKey = (req: FastifyRequest) => {
    const key = req.headers['idempotency-key'];
    if (key === undefined) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header');
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw invalid('/headers/idempotency-key', 'Idempotency-Key must be 1–128 of A-Z a-z 0-9 . _ : -');
    return key;
  };
  const principalKey = (req: FastifyRequest) =>
    req.principal?.kind === 'apiKey' ? `key:${req.principal.keyId}` : `user:${actor(req).actorUserId}`;

  const accepted = (
    req: FastifyRequest,
    reply: FastifyReply,
    batch: { batchId: string; fileId: string | null; status: string },
    r: Received,
    replay: boolean,
  ) => {
    const body = {
      batchId: batch.batchId,
      fileId: batch.fileId,
      status: batch.status,
      sha256: r.file.sha256,
      byteSize: r.file.byteSize,
      originalFilename: r.filename,
      correlationId: req.correlationId,
      links: batchLinks(batch.batchId),
    };
    reply.header('location', batchLinks(batch.batchId).self);
    // The body is returned, not sent, so the handler finishes its clean-up before the client hears back.
    if (replay) reply.code(200).header('idempotent-replay', 'true');
    else reply.code(202).header('retry-after', '2');
    return body;
  };

  /** Streams the body to the import volume and returns the fields and the checked file. */
  const receive = async (req: FastifyRequest): Promise<Received> => {
    const body = req.body as AsyncIterable<Buffer> | null | undefined;
    if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function')
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Uploads are multipart/form-data');
    let parts: MultipartUpload;
    try {
      parts = await readMultipart(body, req.headers['content-type'], () => openImportFile(root, maxBytes));
    } catch (error) {
      if (error instanceof ImportFileError) throw new ApiError('PAYLOAD_TOO_LARGE', error.message);
      throw error;
    }
    if (!parts.file) throw invalid('/file', 'A file part is required');
    const { writer, filename, mimeType } = parts.file;
    try {
      const file = await writer.close({ filename, mimeType });
      return { fields: parts.fields, file, filename, mimeType, discard: () => writer.discard() };
    } catch (error) {
      await writer.discard();
      if (error instanceof ImportFileError)
        throw new ApiError('IMPORT_FILE_INVALID', error.code, {
          errors: [{ path: '/file', code: 'IMPORT_FILE_INVALID', message: error.message }],
        });
      throw error;
    }
  };

  async function upload(req: FastifyRequest, reply: FastifyReply, mode: 'UPLOAD' | 'CORRECTION') {
    const key = idempotencyKey(req);
    const who = principalKey(req);
    if (inFlight.has(who))
      throw new ApiError('INGESTION_CONCURRENCY_LIMIT', 'Another upload from you is still in flight', {
        headers: { 'retry-after': '1' },
      });
    inFlight.add(who);
    try {
      const received = await receive(req);
      let keep = false;
      try {
        const out = await ingest(req, reply, mode, `${who}:${mode}:${key}`, received);
        keep = out.keep;
        return out.body;
      } finally {
        // A file no batch refers to is removed now rather than left for the janitor (06 §11.1).
        if (!keep) await received.discard();
      }
    } finally {
      inFlight.delete(who);
    }
  }

  async function ingest(
    req: FastifyRequest,
    reply: FastifyReply,
    mode: 'UPLOAD' | 'CORRECTION',
    scopedKey: string,
    r: Received,
  ): Promise<Outcome> {
    const parsed = z
      .object({
        sourceId: uuid,
        exchangeCode: z.string().regex(/^[A-Z]{2,8}$/),
        batchType:
          mode === 'CORRECTION' ? z.never().optional() : z.enum(['EOD_CSV', 'INTRADAY_CSV', 'REFERENCE']),
        timeframe: z.string().min(1).max(8).optional(),
        referenceKind: z.enum(REFERENCE_KINDS).optional(),
        supersedesBatchId: mode === 'CORRECTION' ? uuid : uuid.optional(),
        justification: mode === 'CORRECTION' ? z.string().optional() : z.never().optional(),
      })
      .strict()
      .safeParse(r.fields);
    if (!parsed.success) {
      if (
        typeof r.fields['batchType'] === 'string' &&
        parsed.error.issues.some((i) => i.path[0] === 'batchType')
      )
        throw new ApiError('IMPORT_BATCH_TYPE_INVALID', `${r.fields['batchType']} cannot be uploaded here`);
      throw parsed.error;
    }
    const fields = parsed.data;
    const batchType = mode === 'CORRECTION' ? 'CORRECTION' : fields.batchType!;
    if (mode === 'CORRECTION') {
      const j = (fields.justification ?? '').trim();
      if (j.length < 20 || j.length > 1000)
        throw new ApiError(
          'CORRECTION_JUSTIFICATION_REQUIRED',
          'A justification of 20 to 1,000 characters is required',
        );
    }
    if (batchType === 'REFERENCE') return reference(req, reply, fields, r);

    const fingerprint = [
      r.file.sha256,
      fields.sourceId,
      fields.exchangeCode,
      batchType,
      fields.timeframe ?? '',
    ];
    const attempt = (): Promise<Outcome> =>
      withClient(pool, async (c) => {
        await c.query('begin');
        try {
          const out = await create(c);
          await c.query('commit');
          return out;
        } catch (error) {
          await c.query('rollback');
          throw error;
        }
      });

    const create = async (c: pg.ClientBase): Promise<Outcome> => {
      // 05 §8.4 guard 2 first: a retry with the same key learns its result.
      const prior = (
        await c.query<{ id: string; fileId: string; status: string; fingerprint: string[] }>(
          `select b.id::text as id, b.file_id::text as "fileId", b.status,
                  array[encode(f.sha256, 'hex'), b.source_id::text, e.code, b.batch_type, coalesce(b.timeframe, '')]
                    as fingerprint
             from md.import_batch b
             join md.import_file f on f.id = b.file_id
             join ref.exchange e on e.id = b.exchange_id
            where b.idempotency_key = $1`,
          [scopedKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.fingerprint.join('|') !== fingerprint.join('|'))
          throw new ApiError(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was used for a different upload',
          );
        return { keep: false, body: accepted(req, reply, { batchId: prior.id, ...prior }, r, true) };
      }
      // Guard 1: the same bytes are already in the system.
      const duplicate = (
        await c.query<{ batchId: string }>(
          `select b.id::text as "batchId" from md.import_file f join md.import_batch b on b.file_id = f.id
            where f.sha256 = decode($1, 'hex') order by b.received_at limit 1`,
          [r.file.sha256],
        )
      ).rows[0];
      if (duplicate)
        throw new ApiError('IMPORT_DUPLICATE_FILE', 'This file has already been imported', {
          headers: { location: batchLinks(duplicate.batchId).self },
          extensions: { existingBatchId: duplicate.batchId },
        });
      const exchange = (
        await c.query<{ id: string; timezone: string }>(
          'select id::text as id, timezone from ref.exchange where code = $1',
          [fields.exchangeCode],
        )
      ).rows[0];
      if (!exchange)
        throw new ApiError('IMPORT_EXCHANGE_UNRESOLVED', `Unknown exchange ${fields.exchangeCode}`);
      const source = (
        await c.query<{ id: string; isActive: boolean; exchangeId: string | null }>(
          `select id::text as id, is_active as "isActive", exchange_id::text as "exchangeId"
             from md.data_source where id = $1`,
          [fields.sourceId],
        )
      ).rows[0];
      if (!source) throw new ApiError('IMPORT_SOURCE_NOT_FOUND', 'No such data source');
      if (!source.isActive) throw new ApiError('IMPORT_SOURCE_INACTIVE', 'The data source is disabled');
      if (source.exchangeId && source.exchangeId !== exchange.id)
        throw invalid('/sourceId', `The data source does not belong to ${fields.exchangeCode}`);

      let timeframe: string | null = null;
      if (batchType === 'INTRADAY_CSV') {
        const tf = await c.query<{ intraday: boolean }>(
          'select is_intraday as intraday from ref.timeframe where code = $1',
          [fields.timeframe ?? ''],
        );
        if (!tf.rows[0]?.intraday)
          throw invalid('/timeframe', 'An INTRADAY_CSV upload declares an intraday timeframe');
        timeframe = fields.timeframe!;
      } else if (fields.timeframe !== undefined) {
        throw invalid('/timeframe', 'Only an INTRADAY_CSV upload declares a timeframe');
      }
      if (fields.supersedesBatchId) {
        const s = (
          await c.query<{ status: string; exchangeId: string; batchType: string }>(
            `select status, exchange_id::text as "exchangeId", batch_type as "batchType"
               from md.import_batch where id = $1`,
            [fields.supersedesBatchId],
          )
        ).rows[0];
        if (
          !s ||
          !TERMINAL.includes(s.status) ||
          s.exchangeId !== exchange.id ||
          (mode === 'UPLOAD' && s.batchType !== batchType)
        )
          throw new ApiError(
            'IMPORT_SUPERSEDES_INVALID',
            'The superseded batch must be finished, on the same exchange and of the same type',
          );
      }

      const rowsPerInstrument: Record<string, number> = {};
      if (mode === 'CORRECTION') {
        // 05 §12.13: the audit row counts rows per instrument, and an all-rejected file is refused now.
        const mapped = await mapBars(
          c,
          {
            batchId: '',
            exchangeId: exchange.id,
            exchangeCode: fields.exchangeCode,
            timezone: exchange.timezone,
            batchType,
            timeframe: null,
            adapter: 'csv.generic.eod',
            fieldMap: {},
          },
          await readImportFile(root, r.file.storedPath),
        );
        if (mapped.kind === 'FILE_FAILED')
          throw new ApiError('IMPORT_FILE_INVALID', mapped.primaryCode, {
            errors: [{ path: '/file', code: 'IMPORT_FILE_INVALID', message: mapped.message }],
          });
        if (mapped.bars.length === 0)
          throw new ApiError('CORRECTION_NO_ROWS', 'Every row of the correction was rejected');
        for (const b of mapped.bars)
          rowsPerInstrument[b.instrumentId] = (rowsPerInstrument[b.instrumentId] ?? 0) + 1;
      }

      const created = await createImportBatch(c, {
        file: {
          originalFilename: r.filename,
          storedPath: r.file.storedPath,
          byteSize: r.file.byteSize,
          sha256: r.file.sha256,
          mimeType: r.mimeType,
        },
        sourceId: source.id,
        exchangeId: exchange.id,
        batchType: batchType as 'EOD_CSV' | 'INTRADAY_CSV' | 'CORRECTION',
        timeframe,
        idempotencyKey: scopedKey,
        supersedesBatchId: fields.supersedesBatchId ?? null,
        correlationId: req.correlationId,
        requestedBy: actor(req).actorUserId,
      });
      await audit(c, req, {
        action: mode === 'CORRECTION' ? 'marketdata.correction_submitted' : 'import.uploaded',
        entityType: 'import_batch',
        entityId: created.batchId,
        after: { batchType, exchangeCode: fields.exchangeCode, sourceId: source.id },
        metadata: {
          sha256: r.file.sha256,
          byteSize: r.file.byteSize,
          originalFilename: r.filename,
          ...(mode === 'CORRECTION'
            ? {
                justification: fields.justification!.trim(),
                rowsPerInstrument,
                supersedesBatchId: fields.supersedesBatchId,
              }
            : {}),
        },
      });
      return { keep: true, body: accepted(req, reply, { ...created, status: 'RECEIVED' }, r, false) };
    };

    try {
      return await attempt();
    } catch (error) {
      // A concurrent twin committed first (03 §7.1 scenarios 1 and 12); the second pass finds it.
      if (isUnique(error, 'uq_import_file_sha') || isUnique(error, 'uq_import_batch_idem')) return attempt();
      throw error;
    }
  }

  /** A REFERENCE upload runs the Phase 4 importer on the stored file, synchronously (05 §12.11). */
  async function reference(
    req: FastifyRequest,
    reply: FastifyReply,
    fields: { exchangeCode: string; referenceKind?: (typeof REFERENCE_KINDS)[number] | undefined },
    r: Received,
  ): Promise<Outcome> {
    const kind = fields.referenceKind;
    if (!kind) throw invalid('/referenceKind', 'A REFERENCE upload names its referenceKind');
    const csv = await readImportFile(root, r.file.storedPath);
    const who = actor(req);
    const result = await withClient(pool, (c) =>
      importReference(c, {
        kind,
        exchangeCode: fields.exchangeCode,
        csv,
        actorType: who.actorType,
        requestedBy: who.actorUserId,
        correlationId: req.correlationId,
      }),
    );
    // The importer keys replays by content; the file row links the batch to its bytes once.
    const fileId = await inTx(pool, async (c) => {
      const inserted = (
        await c.query<{ id: string }>(
          `insert into md.import_file (original_filename, stored_path, byte_size, sha256, mime_type, uploaded_by)
           values ($1, $2, $3, decode($4, 'hex'), $5, $6) on conflict (sha256) do nothing returning id::text`,
          [r.filename, r.file.storedPath, r.file.byteSize, r.file.sha256, r.mimeType, who.actorUserId],
        )
      ).rows[0];
      if (inserted)
        await c.query('update md.import_batch set file_id = $2 where id = $1 and file_id is null', [
          result.batchId,
          inserted.id,
        ]);
      return inserted?.id ?? null;
    });
    return {
      keep: fileId !== null,
      body: accepted(
        req,
        reply,
        { batchId: result.batchId, fileId, status: result.status },
        r,
        result.replay,
      ),
    };
  }

  app.post('/api/v1/ingestion/uploads', { config: { permission: 'ingestion:submit' } }, (req, reply) =>
    upload(req, reply, 'UPLOAD'),
  );
  app.post(
    '/api/v1/market-data/corrections',
    { config: { permission: 'marketdata:correct' } },
    (req, reply) => upload(req, reply, 'CORRECTION'),
  );

  // ------------------------------------------------------------------------------------- batches
  app.get('/api/v1/ingestion/batches', { config: { permission: 'ingestion:read' } }, async (req) => {
    const q = filters(
      {
        status: multi(z.enum(STATUSES)).optional(),
        batchType: multi(z.enum(BATCH_TYPES)).optional(),
        exchangeCode: z.string().optional(),
        sourceId: uuid.optional(),
        limit,
      },
      req.query,
    );
    const { rows } = await pool.query(
      `select ${BATCH} ${FROM_BATCH}
        where ($1::text[] is null or b.status = any($1)) and ($2::text[] is null or b.batch_type = any($2))
          and ($3::text is null or e.code = $3) and ($4::uuid is null or b.source_id = $4)
        order by b.received_at desc, b.id limit $5`,
      [q.status ?? null, q.batchType ?? null, q.exchangeCode ?? null, q.sourceId ?? null, q.limit + 1],
    );
    return {
      data: rows.slice(0, q.limit),
      page: { limit: q.limit, hasMore: rows.length > q.limit, nextCursor: null },
    };
  });

  app.get('/api/v1/ingestion/batches/:id', { config: { permission: 'ingestion:read' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withClient(pool, (c) => loadBatch(c, id));
  });

  app.get(
    '/api/v1/ingestion/batches/:id/rejects',
    { config: { permission: 'ingestion:read' } },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const q = filters(
        { code: z.string().max(64).optional(), cursor: z.coerce.number().int().min(0).optional(), limit },
        req.query,
      );
      return withClient(pool, async (c) => {
        await loadBatch(c, id);
        const { rows } = await c.query<{ rowNumber: number }>(
          `select row_number as "rowNumber", error_code as code, error_message as message, field_name as field,
                raw_row as "rawRow"
           from md.ingestion_reject
          where import_batch_id = $1 and ($2::text is null or error_code = $2) and row_number > $3
          order by row_number limit $4`,
          [id, q.code ?? null, q.cursor ?? 0, q.limit + 1],
        );
        const data = rows.slice(0, q.limit);
        const hasMore = rows.length > q.limit;
        // The cursor is the last row number of the page, which is stable because rejects are append-only.
        return {
          data,
          page: { limit: q.limit, hasMore, nextCursor: hasMore ? String(data.at(-1)!.rowNumber) : null },
        };
      });
    },
  );

  app.get(
    '/api/v1/ingestion/batches/:id/rejects.csv',
    { config: { permission: 'ingestion:read' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const rows = await withClient(pool, async (c) => {
        await loadBatch(c, id);
        return (
          await c.query<{ n: number; code: string; field: string | null; message: string; raw: unknown }>(
            `select row_number as n, error_code as code, field_name as field, error_message as message,
                    raw_row as raw
               from md.ingestion_reject where import_batch_id = $1 order by row_number`,
            [id],
          )
        ).rows;
      });
      if (rows.length === 0)
        throw new ApiError('IMPORT_REJECT_EXPORT_EMPTY', 'The batch has no rejected rows');
      const lines = ['row_number,error_code,field,message,raw_row'];
      for (const r of rows)
        lines.push(
          [String(r.n), r.code, r.field ?? '', r.message, JSON.stringify(r.raw)].map(csvCell).join(','),
        );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="rejects-${id}.csv"`)
        .send(`${lines.join('\r\n')}\r\n`);
    },
  );

  app.post(
    '/api/v1/ingestion/batches/:id/reconcile',
    { config: { permission: 'ingestion:reconcile' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const out = await inTx(pool, async (c) => {
        const batch = await loadBatch(c, id);
        if (batch.status !== 'PROCESSING')
          throw new ApiError(
            'IMPORT_BATCH_STATE_INVALID',
            `Reconciliation runs on a PROCESSING batch, not ${batch.status}`,
          );
        const job = await enqueue(c, specFor(reconcileJob, { batchId: id }, req.correlationId));
        const retried = job.created ? false : await retryDeadLetter(c, job.id);
        await audit(c, req, {
          action: 'ingestion.batch_reconciled',
          entityType: 'import_batch',
          entityId: id,
          metadata: { jobId: job.id, retriedDeadLetter: retried },
        });
        return { batchId: id, jobId: job.id };
      });
      return reply.code(202).header('location', batchLinks(id).self).send(out);
    },
  );

  app.post(
    '/api/v1/ingestion/batches/:id/reprocess',
    { config: { permission: 'ingestion:retry' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const out = await inTx(pool, async (c) => {
        const b = (
          await c.query<{
            status: string;
            batchType: string;
            fileId: string | null;
            sourceId: string;
            exchangeId: string;
            timeframe: string | null;
          }>(
            `select status, batch_type as "batchType", file_id::text as "fileId", source_id::text as "sourceId",
                    exchange_id::text as "exchangeId", timeframe
               from md.import_batch where id = $1 for update`,
            [id],
          )
        ).rows[0];
        if (!b) throw new ApiError('IMPORT_BATCH_NOT_FOUND', 'No such batch');
        if (!TERMINAL.includes(b.status))
          throw new ApiError('IMPORT_BATCH_STATE_INVALID', 'Only a finished batch can be reprocessed');
        if (b.batchType === 'REFERENCE' || !b.fileId)
          throw new ApiError(
            'IMPORT_BATCH_TYPE_INVALID',
            'A reference batch is re-run by uploading its file',
          );
        // Re-running a correction rewrites prices, so it also needs the correction permission.
        if (b.batchType === 'CORRECTION' && !req.principal?.perms.has('marketdata:correct'))
          throw new ApiError('AUTHZ_FORBIDDEN', 'Reprocessing a correction needs marketdata:correct');
        const created = await createImportBatch(c, {
          file: { fileId: b.fileId },
          sourceId: b.sourceId,
          exchangeId: b.exchangeId,
          batchType: b.batchType as 'EOD_CSV' | 'INTRADAY_CSV' | 'CORRECTION',
          timeframe: b.timeframe,
          idempotencyKey: null,
          supersedesBatchId: id,
          correlationId: req.correlationId,
          requestedBy: actor(req).actorUserId,
        });
        await audit(c, req, {
          action: 'ingestion.batch_retried',
          entityType: 'import_batch',
          entityId: created.batchId,
          metadata: { supersedesBatchId: id },
        });
        return created;
      });
      return reply
        .code(202)
        .header('location', batchLinks(out.batchId).self)
        .send({ ...out, status: 'RECEIVED', supersedesBatchId: id, links: batchLinks(out.batchId) });
    },
  );
}
