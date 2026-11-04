import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientBase } from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION = '-- migrate:no-transaction';
const LOCK = "hashtext('tradesoft.migrate')";

// The runner records every file it applies, so it creates its own ledger before the first file (02 §8).
const BOOTSTRAP = `
create schema if not exists ops;
create table if not exists ops.schema_migration (
  version     integer primary key,
  name        text not null,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  duration_ms integer not null
);`;

export interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
  transactional: boolean;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const versions = new Set<number>();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = FILE_NAME.exec(file);
      if (!match) throw new Error(`Migration file ${file} is not named NNNN_name.sql`);
      const version = Number(match[1]);
      if (versions.has(version)) throw new Error(`Migration version ${version} appears twice`);
      versions.add(version);
      // Normalised so a Windows checkout and a Linux checkout produce the same checksum.
      const sql = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      return {
        version,
        name: match[2]!,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
        transactional: !sql.startsWith(NO_TRANSACTION),
      };
    });
}

/**
 * Applies pending migrations in order under an advisory lock (02 §8). Refuses to run when an applied file
 * changed or disappeared, or when a pending file is numbered below the newest applied one.
 */
export async function migrate(
  client: ClientBase,
  migrations: Migration[] = loadMigrations(),
): Promise<string[]> {
  await client.query(`select pg_advisory_lock(${LOCK})`);
  try {
    await client.query(BOOTSTRAP);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'select version, name, checksum from ops.schema_migration order by version',
    );
    const files = new Map(migrations.map((m) => [m.version, m]));
    for (const row of rows) {
      const file = files.get(row.version);
      if (!file) throw new Error(`Applied migration ${row.version}_${row.name} has no file; refusing to run`);
      if (file.checksum !== row.checksum) {
        throw new Error(
          `Applied migration ${row.version}_${row.name} was edited (checksum mismatch); refusing to run`,
        );
      }
    }
    const applied = new Set(rows.map((r) => r.version));
    const newest = Math.max(0, ...applied);
    const pending = migrations.filter((m) => !applied.has(m.version));
    const outOfOrder = pending.find((m) => m.version < newest);
    if (outOfOrder) {
      throw new Error(
        `Migration ${outOfOrder.version}_${outOfOrder.name} is older than applied ${newest}; refusing to run`,
      );
    }

    const done: string[] = [];
    for (const m of pending) {
      const started = performance.now();
      if (m.transactional) await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query(
          'insert into ops.schema_migration (version, name, checksum, duration_ms) values ($1, $2, $3, $4)',
          [m.version, m.name, m.checksum, Math.round(performance.now() - started)],
        );
        if (m.transactional) await client.query('commit');
      } catch (error) {
        if (m.transactional) await client.query('rollback');
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      done.push(`${String(m.version).padStart(4, '0')}_${m.name}`);
    }
    return done;
  } finally {
    await client.query(`select pg_advisory_unlock(${LOCK})`);
  }
}
