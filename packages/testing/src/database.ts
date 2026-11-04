import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const ROLES_SQL = readFileSync(new URL('../../../infra/postgres/roles.sql', import.meta.url), 'utf8');

/**
 * The server for integration tests: a role allowed to create databases and roles. Locally it may be unset,
 * and the integration suite is skipped; in CI an unset value is an error, never a silent skip.
 */
export function testDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL must be set in CI');
  return url;
}

export interface ScratchDatabase {
  url: string;
  connect(): Promise<pg.Client>;
  drop(): Promise<void>;
}

/** A throwaway database with the cluster roles in place, dropped by `drop()`. */
export async function createScratchDatabase(adminUrl: string): Promise<ScratchDatabase> {
  const name = `ts_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  const connect = async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  };
  const client = await connect();
  try {
    await client.query(ROLES_SQL);
  } finally {
    await client.end();
  }
  return {
    url,
    connect,
    async drop() {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query(`drop database if exists ${name} with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
