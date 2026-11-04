import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import { migrate, seedDev } from '../src/index.ts';

const adminUrl = testDatabaseUrl();
const SEEDED = [
  'ref.exchange',
  'ref.trading_calendar',
  'ref.sector',
  'ref.instrument',
  'ref.instrument_sector_membership',
  'ref.index_membership',
  'ref.corporate_action',
  'ref.market_group',
  'ref.market_group_member',
  'iam.app_user',
  // Role ids come from the structural-seed migration and differ per database; compare by role code.
  '(select ur.user_id, r.code, ur.granted_at from iam.user_role ur join iam.role r on r.id = ur.role_id)',
  'md.data_source',
  'md.import_batch',
  'md.market_bar',
  'an.renko_brick_set',
];

async function seededDatabase(): Promise<{ db: ScratchDatabase; client: pg.Client }> {
  const db = await createScratchDatabase(adminUrl!);
  const client = await db.connect();
  await migrate(client);
  await seedDev(client);
  return { db, client };
}

// One fingerprint per table. Password hashes are excluded: their salts are random by design (02 §9).
async function fingerprints(client: pg.Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of SEEDED) {
    const { rows } = await client.query<{ fp: string }>(
      `select md5(coalesce(string_agg(x, '|' order by x), '')) as fp
         from (select (to_jsonb(t) - 'password_hash')::text as x from ${table} t) s`,
    );
    out[table] = rows[0]!.fp;
  }
  return out;
}

describe.skipIf(!adminUrl)('development seed', () => {
  let first: { db: ScratchDatabase; client: pg.Client };

  beforeAll(async () => {
    first = await seededDatabase();
    await first.client.query('analyze');
  }, 600_000);

  afterAll(async () => {
    await first?.client.end();
    await first?.db.drop();
  }, 60_000);

  it('holds the dataset of 02 §9', async () => {
    const { rows } = await first.client.query<Record<string, string>>(
      `select (select count(*) from ref.exchange) exchanges,
              (select count(*) from ref.sector where kind = 'SECTOR') sectors,
              (select count(*) from ref.sector where kind = 'INDUSTRY') industries,
              (select count(*) from ref.instrument where instrument_type = 'EQUITY') equities,
              (select count(*) from ref.instrument where instrument_type = 'INDEX' and not is_synthetic) indices,
              (select count(*) from ref.instrument where is_synthetic) synthetic,
              (select count(*) from ref.corporate_action) actions,
              (select count(*) from an.renko_brick_set) renko_sets,
              (select count(*) from ref.market_group) groups,
              (select count(distinct instrument_id) from md.market_bar where timeframe = '1D') with_daily_bars,
              (select max(n) from (select count(*) n from md.market_bar where timeframe = '1D' group by instrument_id) x) max_daily,
              (select min(n) from (select count(*) n from md.market_bar where timeframe = '1D' group by instrument_id) x) min_daily`,
    );
    expect(rows[0]).toEqual({
      exchanges: '5',
      sectors: '12',
      industries: '40',
      equities: '60',
      indices: '4',
      synthetic: '1',
      actions: '6',
      renko_sets: '40',
      groups: '6',
      with_daily_bars: '73',
      max_daily: '800',
      min_daily: '799',
    });
  });

  it('E2.4: a second run produces identical rows in every seeded table', async () => {
    const second = await seededDatabase();
    try {
      expect(await fingerprints(second.client)).toEqual(await fingerprints(first.client));
    } finally {
      await second.client.end();
      await second.db.drop();
    }
  }, 600_000);

  it('refuses to seed a database that already holds reference data', async () => {
    await expect(seedDev(first.client)).rejects.toThrow(/already holds reference data/);
  });

  // E2.5: the bar-read plans of 02 §11 on the seeded database, as assertions rather than stored plan text so
  // that they hold across PostgreSQL versions: primary-key access, no sequential scan, pruned partitions.
  async function plan(sql: string, params: unknown[]) {
    const { rows } = await first.client.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(
      `explain (format json) ${sql}`,
      params,
    );
    const nodes: { type: string; relation: string | undefined; index: string | undefined }[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push({
        type: n['Node Type'] as string,
        relation: n['Relation Name'] as string | undefined,
        index: n['Index Name'] as string | undefined,
      });
      for (const child of (n['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk(rows[0]!['QUERY PLAN'][0]!.Plan);
    return nodes;
  }

  it.each([
    ['1D', '2023-09-01T00:00:00Z', '2026-11-01T00:00:00Z', 38],
    ['15m', '2026-04-01T00:00:00Z', '2026-11-01T00:00:00Z', 7],
  ])(
    'E2.5: %s bars for one instrument use the primary key on pruned partitions',
    async (tf, from, to, months) => {
      const { rows } = await first.client.query<{ id: string }>(
        "select id from ref.instrument where symbol = 'BANKA'",
      );
      const nodes = await plan(
        `select * from md.market_bar where instrument_id = $1 and timeframe = $2
         and bucket_start >= $3 and bucket_start < $4 order by bucket_start`,
        [rows[0]!.id, tf, from, to],
      );
      const scanned = new Set(
        nodes.filter((n) => n.relation?.startsWith('market_bar_')).map((n) => n.relation),
      );
      const indexes = nodes.filter((n) => n.index);
      expect(scanned.size).toBeGreaterThan(0);
      expect(scanned.size).toBeLessThanOrEqual(months);
      expect(nodes.filter((n) => n.type === 'Seq Scan')).toEqual([]);
      expect(indexes.length).toBeGreaterThan(0);
      expect(indexes.every((n) => n.index!.endsWith('_pkey'))).toBe(true);
    },
  );
});
