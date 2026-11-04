import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../src/index.ts';

const adminUrl = testDatabaseUrl();
const SCHEMAS = ['iam', 'ref', 'md', 'an', 'scan', 'ops', 'audit'];
const read = (doc: string) =>
  readFileSync(new URL(`../../../docs/architecture/${doc}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// 02 §5 parsed into table -> column -> "type, null|not null"
function specSchema(): Map<string, Map<string, string>> {
  const spec = read('02-database.md');
  const ddl = spec.slice(spec.indexOf('## 5. DDL'), spec.indexOf('## 6. Partitioning'));
  const aliases: Record<string, string> = {
    timestamptz: 'timestamp with time zone',
    time: 'time without time zone',
  };
  const tables = new Map<string, Map<string, string>>();
  for (const m of ddl.matchAll(/create (?:unlogged )?table (\w+\.\w+) \(\n([\s\S]*?)\n\)/g)) {
    const columns = new Map<string, string>();
    const body = m[2]!;
    const pk =
      /^\s*primary key \(([^)]+)\)/m
        .exec(body)?.[1]
        ?.split(',')
        .map((s) => s.trim()) ?? [];
    for (const line of body.split('\n')) {
      const col = /^\s{2}([a-z_][a-z0-9_]*)\s+([a-z]+(?:\(\d+(?:,\d+)?\))?(?:\[\])?)(.*)$/.exec(line);
      if (!col || ['constraint', 'primary', 'unique', 'check'].includes(col[1]!)) continue;
      const rawType = col[2]!.replace(/^char\(/, 'character(');
      const type = aliases[rawType] ?? rawType;
      const notNull =
        /not null|primary key|generated (always|by default) as identity/.test(col[3]!) ||
        pk.includes(col[1]!);
      columns.set(col[1]!, `${type}, ${notNull ? 'not null' : 'null'}`);
    }
    tables.set(m[1]!, columns);
  }
  return tables;
}

async function dbSchema(client: pg.Client): Promise<Map<string, Map<string, string>>> {
  const { rows } = await client.query<{ tbl: string; col: string; type: string; notnull: boolean }>(
    `select n.nspname || '.' || c.relname as tbl, a.attname as col,
            format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition
        and a.attnum > 0 and not a.attisdropped`,
    [SCHEMAS],
  );
  const tables = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!tables.has(r.tbl)) tables.set(r.tbl, new Map());
    tables.get(r.tbl)!.set(r.col, `${r.type}, ${r.notnull ? 'not null' : 'null'}`);
  }
  return tables;
}

const toObject = (m: Map<string, Map<string, string>>) =>
  Object.fromEntries([...m].sort().map(([t, cols]) => [t, Object.fromEntries([...cols].sort())]));

describe.skipIf(!adminUrl)('migrations against PostgreSQL', () => {
  let db: ScratchDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    client = await db.connect();
    await migrate(client);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  }, 60_000);

  it('E2.1 / 07 §6.10 test 1: an empty database migrates to exactly the tables and columns of 02 §5', async () => {
    expect(toObject(await dbSchema(client))).toEqual(toObject(specSchema()));
    const { rows } = await client.query<{ version: number }>(
      'select version from ops.schema_migration order by 1',
    );
    expect(rows.map((r) => r.version)).toEqual(loadMigrations().map((m) => m.version));
  });

  it.skip('07 §6.10 test 2: from the previous release (no release exists yet; 08 E2.2)', () => {});

  it('07 §6.10 test 3: refuses to run when an applied migration was edited', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-migrations-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const file = path.join(dir, '0001_schemas.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited\n`);
    await expect(migrate(client, loadMigrations(dir))).rejects.toThrow(/checksum mismatch/);
  });

  it('07 §6.10 test 4: two concurrent runners apply each migration exactly once', async () => {
    const fresh = await createScratchDatabase(adminUrl!);
    const a = await fresh.connect();
    const b = await fresh.connect();
    try {
      const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
      expect([ra.length, rb.length].sort((x, y) => x - y)).toEqual([0, loadMigrations().length]);
    } finally {
      await a.end();
      await b.end();
      await fresh.drop();
    }
  }, 120_000);

  it('07 §6.10 test 5: no DEFAULT partitions, price columns are numeric(18,4), three months of runway', async () => {
    const defaults = await client.query('select 1 from pg_partitioned_table where partdefid <> 0');
    expect(defaults.rowCount).toBe(0);

    const prices = await client.query<{ col: string; type: string }>(
      `select n.nspname || '.' || c.relname || '.' || a.attname as col, format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0
          and (a.attname in ('open', 'high', 'low', 'close', 'last_brick_close', 'brick_size_abs')
               or a.attname like '%\\_price')`,
      [SCHEMAS],
    );
    expect(prices.rows.length).toBeGreaterThan(10);
    expect(prices.rows.filter((r) => r.type !== 'numeric(18,4)')).toEqual([]);

    const runway = await client.query<{ parent: string; enough: boolean }>(
      `select p.relname as parent,
              max(substring(pg_get_expr(c.relpartbound, c.oid) from 'TO \\(''([^'']+)''\\)')::timestamptz)
                >= now() + interval '3 months' as enough
         from pg_partitioned_table pt
         join pg_class p on p.oid = pt.partrelid
         join pg_inherits i on i.inhparent = p.oid
         join pg_class c on c.oid = i.inhrelid
        group by p.relname`,
    );
    expect(runway.rows.map((r) => r.parent).sort()).toEqual([
      'audit_event',
      'indicator_value',
      'market_bar',
      'market_bar_history',
    ]);
    expect(runway.rows.every((r) => r.enough)).toBe(true);
  });

  it('07 §6.10 test 6: the structural seed applied twice changes nothing', async () => {
    const seed = loadMigrations().find((m) => m.name === 'structural_seed')!;
    const snapshot = async () =>
      (
        await client.query(
          `select (select count(*) from ref.timeframe) tf, (select count(*) from iam.permission) p,
                  (select count(*) from iam.role) r, (select count(*) from iam.role_permission) rp,
                  (select count(*) from ops.system_setting) s`,
        )
      ).rows;
    const before = await snapshot();
    await client.query(seed.sql);
    expect(await snapshot()).toEqual(before);
  });

  it('seeds the permission catalogue and the role matrix of 00 §4', async () => {
    const spec = read('00-system-architecture.md');
    const catalogue = spec.slice(spec.indexOf('### 4.1'), spec.indexOf('### 4.2'));
    const codes = [...new Set([...catalogue.matchAll(/`([a-z]+(?::[a-z]+)+)`/g)].map((m) => m[1]!))].sort();
    const permissions = await client.query<{ code: string }>('select code from iam.permission order by code');
    expect(permissions.rows.map((r) => r.code)).toEqual(codes);

    const matrix = spec.slice(spec.indexOf('### 4.2'), spec.indexOf('### 4.3'));
    const roles = ['VIEWER', 'ANALYST', 'ADMIN', 'INGEST_SERVICE'];
    const expected = new Set<string>();
    for (const row of matrix.matchAll(/^\| (`.+?) \| (yes|no) \| (yes|no) \| (yes|no) \| (yes|no) \|$/gm)) {
      const cells = [...row[1]!.matchAll(/`([a-z]+(?::[a-z*]+)+)`/g)].map((m) => m[1]!);
      const granted = cells.flatMap((c) =>
        c.endsWith(':*') ? codes.filter((p) => p.startsWith(c.slice(0, -1))) : [c],
      );
      roles.forEach((role, i) => {
        if (row[i + 2] === 'yes') for (const p of granted) expected.add(`${role} ${p}`);
      });
    }
    const actual = await client.query<{ grant: string }>(
      `select r.code || ' ' || p.code as grant from iam.role_permission rp
         join iam.role r on r.id = rp.role_id join iam.permission p on p.id = rp.permission_id`,
    );
    expect(actual.rows.map((r) => r.grant).sort()).toEqual([...expected].sort());
  });

  it('keeps import batches immutable once terminal (INV-07)', async () => {
    await client.query('begin');
    try {
      const ex = await client.query<{ id: string }>(
        "insert into ref.exchange (code, name, default_open_time, default_close_time) values ('TST', 'Test', '09:15', '15:30') returning id",
      );
      const src = await client.query<{ id: string }>(
        "insert into md.data_source (code, name, kind) values ('T', 'T', 'CSV') returning id",
      );
      const batch = await client.query<{ id: string }>(
        `insert into md.import_batch (source_id, exchange_id, batch_type, status, correlation_id, completed_at)
         values ($1, $2, 'EOD_CSV', 'COMPLETED', gen_random_uuid(), now()) returning id`,
        [src.rows[0]!.id, ex.rows[0]!.id],
      );
      await expect(
        client.query("update md.import_batch set status = 'PROCESSING', completed_at = null where id = $1", [
          batch.rows[0]!.id,
        ]),
      ).rejects.toThrow(/is terminal/);
    } finally {
      await client.query('rollback');
    }
  });

  it('chains audit rows and refuses to change them (INV-14, INV-15)', async () => {
    await client.query('begin');
    try {
      for (const action of ['user.created', 'user.updated']) {
        await client.query(
          `insert into audit.audit_event (action, entity_type, entity_id, correlation_id, actor_type)
           values ($1, 'user', 'u1', gen_random_uuid(), 'SYSTEM')`,
          [action],
        );
      }
      const { rows } = await client.query<{ prev_hash: Buffer | null; hash: Buffer }>(
        'select prev_hash, hash from audit.audit_event order by id',
      );
      expect(rows[0]!.prev_hash).toBeNull();
      expect(rows[1]!.prev_hash).toEqual(rows[0]!.hash);
      await expect(client.query("update audit.audit_event set action = 'user.deleted'")).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await client.query('rollback');
    }
  });
});
