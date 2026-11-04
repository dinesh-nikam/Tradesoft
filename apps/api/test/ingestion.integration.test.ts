import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  createKeyring,
  migrate,
  persistBatch,
  reconcileBatch,
  RevocationSet,
  signAccessToken,
  validateBatch,
  type IdentityDeps,
} from '@tradesoft/db';
import { buildApp } from '../src/app.ts';

const adminUrl = testDatabaseUrl();
const ANALYST = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6fa0';
const ADMIN = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6fa1';
const HEADER = 'symbol,series,date,open,high,low,close,volume,turnover';
const JUSTIFICATION = 'The exchange reissued the close price.';

describe.skipIf(!adminUrl)('ingestion api (05 §11.6, §12.11–12.13, E5.2)', { timeout: 60_000 }, () => {
  let db: ScratchDatabase;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let sourceId: string;
  const tokens: Record<string, string> = {};
  const identity: IdentityDeps = {
    keyring: createKeyring(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ),
    issuer: 'https://tradesoft.test',
    audience: 'tradesoft-api',
    mfaKey: Buffer.alloc(32, 3),
    mfaKeyId: 1,
    blocklist: new Set(),
    revocations: new RevocationSet(),
  };

  async function token(role: string, sub: string): Promise<string> {
    const { rows } = await pool.query<{ perms: string[] }>(
      `select array_agg(p.code) as perms from iam.role r join iam.role_permission rp on rp.role_id = r.id
         join iam.permission p on p.id = rp.permission_id where r.code = $1`,
      [role],
    );
    const iat = Math.floor(Date.now() / 1000);
    return signAccessToken(identity.keyring, {
      iss: identity.issuer,
      aud: identity.audience,
      sub,
      sid: randomUUID(),
      ver: 1,
      roles: [role],
      perms: rows[0]!.perms,
      iat,
      exp: iat + 900,
      jti: randomUUID(),
    });
  }
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, auth: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${auth}` },
      ...(payload ? { payload } : {}),
    });
  /** A multipart body built by hand, the way a browser's FormData sends it. */
  function form(fields: Record<string, string>, file?: { name: string; type: string; body: string }) {
    const boundary = `----tradesoft${randomUUID()}`;
    let body = '';
    if (file)
      body +=
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n${file.body}\r\n`;
    for (const [k, v] of Object.entries(fields))
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    body += `--${boundary}--\r\n`;
    return { body: Buffer.from(body), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  const send = (
    url: string,
    auth: string,
    fields: Record<string, string>,
    csv: string | null,
    o: { key?: string | null; name?: string; target?: ReturnType<typeof buildApp> } = {},
  ) => {
    const f = form(
      fields,
      csv === null ? undefined : { name: o.name ?? 'eod.csv', type: 'text/csv', body: csv },
    );
    const key = o.key === undefined ? randomUUID() : o.key;
    return (o.target ?? app).inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': f.contentType,
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      payload: f.body,
    });
  };
  const upload = (
    auth: string,
    csv: string | null,
    o: Parameters<typeof send>[4] & { fields?: Record<string, string> } = {},
  ) =>
    send(
      '/ingestion/uploads',
      auth,
      { sourceId, exchangeCode: 'NSE', batchType: 'EOD_CSV', ...o.fields },
      csv,
      o,
    );
  /** The three ingestion jobs, run in order as the worker would. */
  const process = async (batchId: string) => {
    const c = await pool.connect();
    try {
      for (const step of [validateBatch, persistBatch, reconcileBatch]) {
        await c.query('begin');
        await step(c, root, batchId);
        await c.query('commit');
      }
    } finally {
      c.release();
    }
  };
  const files = async () => {
    let n = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
        if (e.isDirectory()) await walk(join(dir, e.name));
        else n++;
    };
    await walk(root);
    return n;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tradesoft-api-imports-'));
    db = await createScratchDatabase(adminUrl!);
    const c = await db.connect();
    try {
      await migrate(c);
      for (const [id, email] of [
        [ANALYST, 'analyst@test.local'],
        [ADMIN, 'admin@test.local'],
      ])
        await c.query(
          `insert into iam.app_user (id, email, password_hash, display_name, status)
           values ($1, $2, '!', $3, 'ACTIVE')`,
          [id, email, email],
        );
      const ex = await c.query<{ id: string }>(
        `insert into ref.exchange (code, name, default_open_time, default_close_time)
         values ('NSE', 'National Stock Exchange', '09:15', '15:30') returning id::text as id`,
      );
      await c.query(
        `insert into ref.trading_calendar (exchange_id, calendar_date, is_trading_day, session_open_at, session_close_at)
         select $1, d::date, true, (d::date + time '09:15') at time zone 'Asia/Kolkata',
                (d::date + time '15:30') at time zone 'Asia/Kolkata'
           from generate_series(date '2026-11-02', date '2026-11-04', interval '1 day') d`,
        [ex.rows[0]!.id],
      );
      await c.query(
        `insert into ref.instrument (exchange_id, symbol, series, name, instrument_type, asset_class)
         select $1::uuid, s, 'EQ', s, 'EQUITY', 'EQUITY' from unnest(array['INFY', 'TCS']) s`,
        [ex.rows[0]!.id],
      );
    } finally {
      await c.end();
    }
    pool = new pg.Pool({ connectionString: db.url, max: 6 });
    app = buildApp({ pool, identity, importRoot: root });
    await app.ready();
    tokens['analyst'] = await token('ANALYST', ANALYST);
    tokens['admin'] = await token('ADMIN', ADMIN);
    tokens['viewer'] = await token('VIEWER', randomUUID());
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await db?.drop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('manages data sources with settings:write, refusing secrets in config', async () => {
    const body = {
      code: 'NSE_EOD',
      name: 'NSE end-of-day',
      kind: 'CSV',
      exchangeCode: 'NSE',
      config: { adapter: 'csv.generic.eod' },
    };
    expect((await call('POST', '/ingestion/sources', tokens['analyst']!, body)).json()).toMatchObject({
      code: 'AUTHZ_FORBIDDEN',
    });
    const created = await call('POST', '/ingestion/sources', tokens['admin']!, body);
    expect(created.statusCode).toBe(201);
    sourceId = created.json<{ id: string }>().id;
    expect((await call('POST', '/ingestion/sources', tokens['admin']!, body)).json()).toMatchObject({
      code: 'RESOURCE_CONFLICT',
    });
    const secret = await call('POST', '/ingestion/sources', tokens['admin']!, {
      ...body,
      code: 'VENDOR',
      config: { adapter: 'csv.generic.eod', apiKey: 'x' },
    });
    expect(secret.statusCode).toBe(422);
    const list = await call('GET', '/ingestion/sources', tokens['analyst']!);
    expect(list.json<{ data: unknown[] }>().data).toEqual([
      expect.objectContaining({ code: 'NSE_EOD', exchangeCode: 'NSE' }),
    ]);
  });

  it('accepts an upload, then reports the batch, its rejects and the rejects export', async () => {
    const csv = [
      HEADER,
      'INFY,EQ,2026-11-02,100,110,95,105,1000,105000',
      '=HYPERLINK(1),EQ,2026-11-02,1,1,1,1,1,',
    ].join('\n');
    const res = await upload(tokens['analyst']!, csv);
    expect(res.statusCode).toBe(202);
    const body = res.json<{ batchId: string; sha256: string; links: { self: string } }>();
    expect(body).toMatchObject({
      status: 'RECEIVED',
      byteSize: Buffer.byteLength(csv),
      originalFilename: 'eod.csv',
    });
    expect(res.headers['location']).toBe(body.links.self);
    expect(res.headers['retry-after']).toBe('2');
    const events = await pool.query(
      "select 1 from ops.domain_event where event_type = 'import.received' and aggregate_id = $1",
      [body.batchId],
    );
    expect(events.rowCount).toBe(1);
    const audit = await pool.query(
      "select metadata from audit.audit_event where action = 'import.uploaded' and entity_id = $1",
      [body.batchId],
    );
    expect(audit.rows[0].metadata).toMatchObject({ sha256: body.sha256 });

    await process(body.batchId);
    const batch = (await call('GET', `/ingestion/batches/${body.batchId}`, tokens['analyst']!)).json();
    expect(batch).toMatchObject({
      status: 'COMPLETED',
      exchangeCode: 'NSE',
      source: { code: 'NSE_EOD' },
      requestedBy: { id: ANALYST },
      counts: {
        totalRows: 2,
        acceptedRows: 1,
        rejectedRows: 1,
        insertedBars: 1,
        updatedBars: 0,
        unchangedBars: 0,
      },
      file: { sha256: body.sha256 },
    });
    expect(batch.errorSummary.checks.length).toBeGreaterThan(3);

    const rejects = await call(
      'GET',
      `/ingestion/batches/${body.batchId}/rejects?limit=1`,
      tokens['analyst']!,
    );
    expect(rejects.json()).toMatchObject({
      data: [{ rowNumber: 2, code: 'SYMBOL_UNKNOWN' }],
      page: { hasMore: false },
    });
    const exported = await call('GET', `/ingestion/batches/${body.batchId}/rejects.csv`, tokens['analyst']!);
    expect(exported.headers['content-type']).toContain('text/csv');
    // 06 §10.4: the message begins with the hostile symbol, so the cell is defused.
    expect(exported.body).toContain(",'=HYPERLINK(1) names no NSE instrument");
    const completed = await call('GET', '/ingestion/batches?status=COMPLETED', tokens['analyst']!);
    expect(completed.json<{ data: unknown[] }>().data).toHaveLength(1);
    expect((await call('GET', '/ingestion/batches?colour=red', tokens['analyst']!)).json()).toMatchObject({
      code: 'FILTER_NOT_SUPPORTED',
    });
  });

  it('E5.2: replays a retried key, refuses a reused key, and reports a duplicate file with its batch', async () => {
    const csv = `${HEADER}\nTCS,EQ,2026-11-02,10,11,9,10,5,50`;
    expect((await upload(tokens['analyst']!, csv, { key: null })).json()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    const key = randomUUID();
    const first = await upload(tokens['analyst']!, csv, { key });
    expect(first.statusCode).toBe(202);
    const created = first.json<{ batchId: string; fileId: string; links: { self: string } }>();
    // The client timed out and retried with the same key.
    const retry = await upload(tokens['analyst']!, csv, { key });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json<{ batchId: string }>().batchId).toBe(created.batchId);
    expect((await upload(tokens['analyst']!, `${csv}\n`, { key })).json()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    const dup = await upload(tokens['analyst']!, csv);
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'IMPORT_DUPLICATE_FILE', existingBatchId: created.batchId });
    expect(dup.headers['location']).toBe(created.links.self);
    const batches = await pool.query('select count(*)::int as n from md.import_batch where file_id = $1', [
      created.fileId,
    ]);
    expect(batches.rows[0]).toEqual({ n: 1 });
  });

  it('E5.2: the same file uploaded twice at once makes one batch; the other caller learns where it is', async () => {
    const csv = `${HEADER}\nTCS,EQ,2026-11-03,10,11,9,10,5,50`;
    const before = await files();
    const results = await Promise.all([upload(tokens['analyst']!, csv), upload(tokens['admin']!, csv)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const won = results.find((r) => r.statusCode === 202)!.json<{ batchId: string }>();
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({ existingBatchId: won.batchId });
    // The loser's copy of the file is removed, not left behind.
    expect(await files()).toBe(before + 1);
  });

  it('refuses bad files and bad form fields, leaving nothing on disk', async () => {
    const before = await files();
    const csv = `${HEADER}\nINFY,EQ,2026-11-03,1,1,1,1,1,`;
    expect((await upload(tokens['analyst']!, csv, { name: 'eod.xlsx' })).json()).toMatchObject({
      code: 'IMPORT_FILE_INVALID',
      detail: 'FILE_TYPE_REJECTED',
    });
    expect((await upload(tokens['analyst']!, 'a,\u0000b')).json()).toMatchObject({
      detail: 'FILE_TYPE_REJECTED',
    });
    expect((await upload(tokens['analyst']!, csv, { fields: { exchangeCode: 'XX' } })).json()).toMatchObject({
      code: 'IMPORT_EXCHANGE_UNRESOLVED',
    });
    expect(
      (await upload(tokens['analyst']!, csv, { fields: { batchType: 'CORRECTION' } })).json(),
    ).toMatchObject({
      code: 'IMPORT_BATCH_TYPE_INVALID',
    });
    expect(
      (await upload(tokens['analyst']!, csv, { fields: { batchType: 'INTRADAY_CSV' } })).statusCode,
    ).toBe(422);
    expect((await upload(tokens['analyst']!, null)).statusCode).toBe(422);
    const small = buildApp({ pool, identity, importRoot: root, uploadMaxBytes: 16 });
    await small.ready();
    expect((await upload(tokens['analyst']!, csv, { target: small })).json()).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    await small.close();
    const json = await app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/uploads',
      headers: { authorization: `Bearer ${tokens['analyst']}`, 'idempotency-key': randomUUID() },
      payload: { file: 'x' },
    });
    expect(json.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect((await upload(tokens['viewer']!, csv)).json()).toMatchObject({ code: 'AUTHZ_FORBIDDEN' });
    await call('PATCH', `/ingestion/sources/${sourceId}`, tokens['admin']!, { isActive: false });
    expect((await upload(tokens['analyst']!, csv)).json()).toMatchObject({ code: 'IMPORT_SOURCE_INACTIVE' });
    await call('PATCH', `/ingestion/sources/${sourceId}`, tokens['admin']!, { isActive: true });
    expect(await files()).toBe(before);
    const updates = await pool.query(
      "select count(*)::int as n from audit.audit_event where action = 'data_source.updated'",
    );
    expect(updates.rows[0]).toEqual({ n: 2 });
  });

  it('accepts a justified correction with its audit, and refuses one without', async () => {
    const original = (
      await pool.query<{ id: string }>(
        "select id::text from md.import_batch where status = 'COMPLETED' order by received_at limit 1",
      )
    ).rows[0]!.id;
    const csv = `${HEADER}\nINFY,EQ,2026-11-02,100,110,95,106,1000,106000`;
    const fields = { sourceId, exchangeCode: 'NSE', supersedesBatchId: original };
    const correct = (auth: string, extra: Record<string, string>, body = csv) =>
      send('/market-data/corrections', auth, { ...fields, ...extra }, body);
    expect((await correct(tokens['analyst']!, { justification: JUSTIFICATION })).json()).toMatchObject({
      code: 'AUTHZ_FORBIDDEN',
    });
    expect((await correct(tokens['admin']!, { justification: 'typo' })).json()).toMatchObject({
      code: 'CORRECTION_JUSTIFICATION_REQUIRED',
    });
    const none = await correct(
      tokens['admin']!,
      { justification: JUSTIFICATION },
      `${HEADER}\nNOPE,EQ,2026-11-02,1,1,1,1,1,`,
    );
    expect(none.json()).toMatchObject({ code: 'CORRECTION_NO_ROWS' });
    const ok = await correct(tokens['admin']!, { justification: JUSTIFICATION });
    expect(ok.statusCode).toBe(202);
    const batchId = ok.json<{ batchId: string }>().batchId;
    const audit = await pool.query<{ metadata: { rowsPerInstrument: Record<string, number> } }>(
      "select metadata from audit.audit_event where action = 'marketdata.correction_submitted' and entity_id = $1",
      [batchId],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({
      justification: JUSTIFICATION,
      supersedesBatchId: original,
    });
    expect(Object.values(audit.rows[0]!.metadata.rowsPerInstrument)).toEqual([1]);
    await process(batchId);
    expect((await call('GET', `/ingestion/batches/${batchId}`, tokens['admin']!)).json()).toMatchObject({
      batchType: 'CORRECTION',
      status: 'COMPLETED',
      counts: { updatedBars: 1 },
    });
  });

  it('reprocesses a finished batch as a new one, and reconciles only a processing batch', async () => {
    const original = (
      await pool.query<{ id: string }>(
        `select id::text from md.import_batch where status = 'COMPLETED' and batch_type = 'EOD_CSV'
          order by received_at limit 1`,
      )
    ).rows[0]!.id;
    const re = await call('POST', `/ingestion/batches/${original}/reprocess`, tokens['analyst']!);
    expect(re.statusCode).toBe(202);
    const next = re.json<{ batchId: string }>().batchId;
    expect((await call('GET', `/ingestion/batches/${original}`, tokens['analyst']!)).json()).toMatchObject({
      supersededByBatchId: next,
    });
    expect(
      (await call('POST', `/ingestion/batches/${next}/reprocess`, tokens['analyst']!)).json(),
    ).toMatchObject({
      code: 'IMPORT_BATCH_STATE_INVALID',
    });
    expect(
      (await call('POST', `/ingestion/batches/${next}/reconcile`, tokens['analyst']!)).json(),
    ).toMatchObject({
      code: 'IMPORT_BATCH_STATE_INVALID',
    });
    expect(
      (await call('GET', `/ingestion/batches/${randomUUID()}`, tokens['analyst']!)).json(),
    ).toMatchObject({
      code: 'IMPORT_BATCH_NOT_FOUND',
    });
  });

  it('loads a REFERENCE upload through the reference importer and links its file', async () => {
    const csv = 'symbol,name,instrument_type,asset_class\nWIPRO,Wipro Ltd,EQUITY,EQUITY';
    const res = await upload(tokens['admin']!, csv, {
      fields: { batchType: 'REFERENCE', referenceKind: 'INSTRUMENTS' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ batchId: string; status: string; fileId: string }>();
    expect(body.status).toBe('COMPLETED');
    expect((await call('GET', `/ingestion/batches/${body.batchId}`, tokens['admin']!)).json()).toMatchObject({
      batchType: 'REFERENCE',
      file: { id: body.fileId },
    });
    expect((await upload(tokens['admin']!, csv, { fields: { batchType: 'REFERENCE' } })).statusCode).toBe(
      422,
    );
  });
});
