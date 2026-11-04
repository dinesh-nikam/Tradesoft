import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import { createKeyring, migrate, RevocationSet, signAccessToken, type IdentityDeps } from '@tradesoft/db';
import { buildApp } from '../src/app.ts';

const adminUrl = testDatabaseUrl();
// Audit rows and group owners reference real users, so writers' tokens belong to inserted users.
const ANALYST = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f90';
const OTHER = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f91';
const ADMIN = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f92';

describe.skipIf(!adminUrl)('reference api (05 §11.4, E4.5)', { timeout: 60_000 }, () => {
  let db: ScratchDatabase;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let exchangeId: string;
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

  async function token(role: string, sub: string = randomUUID()): Promise<string> {
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
  const call = async (
    method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    auth: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${auth}` },
      ...(payload ? { payload } : {}),
    });
  const audits = async (action: string) =>
    (
      await pool.query<{ before: unknown; after: unknown; metadata: unknown }>(
        'select before, after, metadata from audit.audit_event where action = $1 order by id',
        [action],
      )
    ).rows;
  const instrument = async (auth: string, symbol: string, instrumentType = 'EQUITY') =>
    (
      await call('POST', '/instruments', auth, {
        exchangeId,
        symbol,
        name: symbol,
        instrumentType,
        assetClass: 'EQUITY',
      })
    ).json() as { id: string };

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    const c = await db.connect();
    try {
      await migrate(c);
      for (const [id, email] of [
        [ANALYST, 'analyst@test.local'],
        [OTHER, 'other@test.local'],
        [ADMIN, 'admin@test.local'],
      ])
        await c.query(
          `insert into iam.app_user (id, email, password_hash, display_name, status) values ($1, $2, '!', 'Analyst', 'ACTIVE')`,
          [id, email],
        );
      exchangeId = (
        await c.query<{ id: string }>(
          `insert into ref.exchange (code, name, default_open_time, default_close_time)
           values ('NSE', 'National Stock Exchange', '09:15', '15:30') returning id::text`,
        )
      ).rows[0]!.id;
    } finally {
      await c.end();
    }
    pool = new pg.Pool({ connectionString: db.url, max: 5 });
    app = buildApp({ pool, identity });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await db?.drop();
  }, 60_000);

  it('refuses every reference write without the permission, with the catalogued code and no audit row', async () => {
    const viewer = await token('VIEWER');
    const id = randomUUID();
    const writes: ['PUT' | 'POST' | 'PATCH' | 'DELETE', string][] = [
      ['POST', '/exchanges'],
      ['PUT', `/exchanges/${exchangeId}/calendar/2026-11-05`],
      ['POST', '/instruments'],
      ['PATCH', `/instruments/${id}`],
      ['POST', `/instruments/${id}/aliases`],
      ['DELETE', `/instruments/${id}/aliases/${id}`],
      ['POST', `/instruments/${id}/sector-memberships`],
      ['POST', `/instruments/${id}/sector-memberships/${id}/close`],
      ['POST', `/instruments/${id}/members`],
      ['POST', `/instruments/${id}/members/${id}/close`],
      ['POST', '/sectors'],
      ['PATCH', `/sectors/${id}`],
      ['POST', '/groups'],
      ['PATCH', `/groups/${id}`],
      ['DELETE', `/groups/${id}`],
      ['POST', `/groups/${id}/members`],
      ['POST', `/groups/${id}/members/remove`],
      ['POST', '/corporate-actions'],
      ['DELETE', `/corporate-actions/${id}`],
    ];
    for (const [method, url] of writes) {
      const res = await call(method, url, viewer, {});
      expect([url, res.statusCode, res.json().code]).toEqual([url, 403, 'AUTHZ_FORBIDDEN']);
    }
    const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from audit.audit_event');
    expect(rows[0]!.n).toBe(0);
  });

  it('creates an exchange only with settings:write, validating its zone and session', async () => {
    const admin = await token('ADMIN', ADMIN);
    const analyst = await token('ANALYST', ANALYST);
    const mcx = {
      code: 'MCX',
      name: 'Multi Commodity Exchange',
      defaultOpenTime: '09:00',
      defaultCloseTime: '23:30',
    };
    expect((await call('POST', '/exchanges', analyst, mcx)).json().code).toBe('AUTHZ_FORBIDDEN');
    expect((await call('POST', '/exchanges', admin, { ...mcx, timezone: 'Mars/Olympus' })).json().code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await call('POST', '/exchanges', admin, { ...mcx, defaultCloseTime: '08:00' })).json().code).toBe(
      'VALIDATION_FAILED',
    );
    const created = await call('POST', '/exchanges', admin, mcx);
    expect(created.statusCode).toBe(201);
    expect(created.headers['location']).toBe(`/api/v1/exchanges/${created.json().id}`);
    expect(created.json()).toMatchObject({
      code: 'MCX',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      defaultCloseTime: '23:30:00',
    });
    expect((await call('POST', '/exchanges', admin, mcx)).json().code).toBe('RESOURCE_CONFLICT');
    expect((await audits('exchange.created'))[0]!.after).toMatchObject({ code: 'MCX' });
    await pool.query("delete from ref.exchange where code = 'MCX'");
  });

  it('maintains calendar days with audit, refusing a holiday with session bounds', async () => {
    const analyst = await token('ANALYST', ANALYST);
    const url = `/exchanges/${exchangeId}/calendar/2026-11-08`;
    const muhurat = {
      isTradingDay: true,
      sessionOpenAt: '2026-11-08T18:00:00+05:30',
      sessionCloseAt: '2026-11-08T19:00:00+05:30',
      isSpecial: true,
      description: 'Muhurat trading',
    };
    expect((await call('PUT', url, analyst, { ...muhurat, isTradingDay: false })).json().code).toBe(
      'VALIDATION_FAILED',
    );
    const saved = await call('PUT', url, analyst, muhurat);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ sessionDate: '2026-11-08', isSpecial: true, source: 'MANUAL' });
    await call('PUT', url, analyst, { isTradingDay: false, description: 'Cancelled' });
    const days = await call(
      'GET',
      `/exchanges/${exchangeId}/calendar?from=2026-11-01&to=2026-11-30`,
      analyst,
    );
    expect(days.json().data).toEqual([
      expect.objectContaining({ sessionDate: '2026-11-08', isTradingDay: false }),
    ]);
    const trail = await audits('calendar.day_saved');
    expect(trail).toHaveLength(2);
    expect(trail[0]!.before).toBeNull();
    expect(trail[1]!.before).toMatchObject({ isTradingDay: true });
    expect(trail[1]!.after).toMatchObject({ isTradingDay: false });
  });

  it('creates, searches and updates instruments through the lifecycle', async () => {
    const analyst = await token('ANALYST', ANALYST);
    const body = {
      exchangeId,
      symbol: 'RELIANCE',
      name: 'Reliance Industries Ltd',
      instrumentType: 'EQUITY',
      assetClass: 'EQUITY',
    };
    const created = await call('POST', '/instruments', analyst, body);
    expect(created.statusCode).toBe(201);
    const inst = created.json();
    expect(inst).toMatchObject({
      symbol: 'RELIANCE',
      exchangeCode: 'NSE',
      tickSize: '0.050000',
      status: 'ACTIVE',
    });
    expect((await call('POST', '/instruments', analyst, body)).json().code).toBe('INSTRUMENT_SYMBOL_TAKEN');

    const found = (await call('GET', '/instruments?q=relian', analyst)).json().data;
    expect(found.map((i: { id: string }) => i.id)).toEqual([inst.id]);
    expect((await call('GET', '/instruments?sector=IT', analyst)).json().code).toBe('FILTER_NOT_SUPPORTED');
    expect((await call('GET', '/instruments?q=r', analyst)).json().code).toBe('VALIDATION_FAILED');

    const url = `/instruments/${inst.id}`;
    expect((await call('PATCH', url, analyst, { status: 'DELISTED' })).json().code).toBe('VALIDATION_FAILED');
    expect((await call('PATCH', url, analyst, { status: 'SUSPENDED' })).json().status).toBe('SUSPENDED');
    expect(
      (await call('PATCH', url, analyst, { status: 'DELISTED', delistingDate: '2026-11-01' })).json(),
    ).toMatchObject({ status: 'DELISTED', delistingDate: '2026-11-01' });
    expect((await call('PATCH', url, analyst, { status: 'ACTIVE' })).json().code).toBe('RESOURCE_CONFLICT');
    const trail = await audits('instrument.updated');
    expect(trail.at(-1)!.before).toMatchObject({ status: 'SUSPENDED' });
    expect(trail.at(-1)!.after).toMatchObject({ status: 'DELISTED' });
  });

  it('refuses overlapping aliases for the same symbol and removes an alias with audit', async () => {
    const analyst = await token('ANALYST', ANALYST);
    const inst = await instrument(analyst, 'LTIM');
    const url = `/instruments/${inst.id}/aliases`;
    const alias = await call('POST', url, analyst, {
      aliasSymbol: 'LTI',
      validFrom: '2016-07-21',
      validTo: '2022-12-04',
    });
    expect(alias.statusCode).toBe(201);
    expect(
      (await call('POST', url, analyst, { aliasSymbol: 'LTI', validFrom: '2022-12-01' })).json().code,
    ).toBe('ALIAS_WINDOW_OVERLAP');
    expect((await call('DELETE', `${url}/${alias.json().id}`, analyst)).statusCode).toBe(204);
    expect((await call('GET', url, analyst)).json().data).toEqual([]);
    expect((await audits('instrument.alias_removed'))[0]!.before).toMatchObject({ aliasSymbol: 'LTI' });
  });

  it('refuses a sector cycle and closes the previous classification on reclassification (BR-003, BR-004)', async () => {
    const analyst = await token('ANALYST', ANALYST);
    const parent = (await call('POST', '/sectors', analyst, { code: 'FIN', name: 'Financials' })).json();
    const child = (
      await call('POST', '/sectors', analyst, { code: 'BANKS', name: 'Banks', parentId: parent.id })
    ).json();
    expect((await call('GET', '/sectors', analyst)).json().data).toEqual([
      expect.objectContaining({ code: 'FIN', children: [expect.objectContaining({ code: 'BANKS' })] }),
    ]);
    expect((await call('PATCH', `/sectors/${parent.id}`, analyst, { parentId: child.id })).json().code).toBe(
      'SECTOR_CYCLE',
    );
    expect((await call('PATCH', `/sectors/${parent.id}`, analyst, { parentId: parent.id })).json().code).toBe(
      'SECTOR_CYCLE',
    );

    const tech = (
      await call('POST', '/sectors', analyst, { code: 'IT', name: 'Information Technology' })
    ).json();
    const inst = await instrument(analyst, 'HDFCBANK');
    const url = `/instruments/${inst.id}/sector-memberships`;
    const first = await call('POST', url, analyst, { sectorId: parent.id, effectiveFrom: '2020-01-01' });
    expect(first.statusCode).toBe(201);
    const moved = await call('POST', url, analyst, { sectorId: tech.id, effectiveFrom: '2024-04-01' });
    expect(moved.json()).toMatchObject({ closedSectorId: parent.id });
    expect(
      (await call('POST', url, analyst, { sectorId: parent.id, effectiveFrom: '2021-01-01' })).json().code,
    ).toBe('MEMBERSHIP_OVERLAP');
    expect((await call('GET', url, analyst)).json().data).toEqual([
      expect.objectContaining({ sectorCode: 'IT', effectiveFrom: '2024-04-01', effectiveTo: null }),
      expect.objectContaining({ sectorCode: 'FIN', effectiveFrom: '2020-01-01', effectiveTo: '2024-03-31' }),
    ]);
    const closed = await call('POST', `${url}/${tech.id}/close`, analyst, { effectiveTo: '2024-03-01' });
    expect(closed.json().code).toBe('MEMBERSHIP_WINDOW_INVALID');
  });

  it('maintains index constituents as of a date', async () => {
    const analyst = await token('ANALYST', ANALYST);
    const index = (await instrument(analyst, 'NIFTYBANK', 'INDEX')).id;
    const member = (await instrument(analyst, 'SBIN')).id;
    const notIndex = await call('POST', `/instruments/${member}/members`, analyst, {
      memberInstrumentId: index,
      effectiveFrom: '2020-01-01',
    });
    expect(notIndex.json().code).toBe('VALIDATION_FAILED');
    const url = `/instruments/${index}/members`;
    const added = await call('POST', url, analyst, {
      memberInstrumentId: member,
      effectiveFrom: '2020-01-01',
      weight: '12.5',
    });
    expect(added.statusCode).toBe(201);
    const again = await call('POST', url, analyst, {
      memberInstrumentId: member,
      effectiveFrom: '2023-01-01',
    });
    expect(again.json().code).toBe('MEMBERSHIP_OVERLAP');
    await call('POST', `${url}/${member}/close`, analyst, { effectiveTo: '2025-12-31' });
    expect((await call('GET', `${url}?asOf=2025-12-31`, analyst)).json().data).toEqual([
      expect.objectContaining({ symbol: 'SBIN', weight: '12.500000' }),
    ]);
    expect((await call('GET', `${url}?asOf=2026-01-01`, analyst)).json().data).toEqual([]);
  });

  it("keeps a user's unshared group private, edits members softly and refuses system groups", async () => {
    const analyst = await token('ANALYST', ANALYST);
    const other = await token('ANALYST', OTHER);
    const viewer = await token('VIEWER');
    const group = (await call('POST', '/groups', analyst, { code: 'MY_BANKS', name: 'My banks' })).json();
    expect(group).toMatchObject({ ownerUserId: ANALYST, isShared: false, groupType: 'CUSTOM' });
    expect((await call('GET', `/groups/${group.id}`, other)).json().code).toBe('GROUP_NOT_FOUND');
    expect((await call('POST', '/groups', analyst, { code: 'MY_BANKS', name: 'x' })).json().code).toBe(
      'GROUP_CODE_TAKEN',
    );
    expect(
      (await call('POST', '/groups', analyst, { code: 'DYN', name: 'x', isDynamic: true })).json().code,
    ).toBe('GROUP_DYNAMIC_RULE_INVALID');

    const ids: string[] = (await call('GET', '/instruments?limit=200', analyst))
      .json()
      .data.map((i: { id: string }) => i.id);
    const members = `/groups/${group.id}/members`;
    expect((await call('POST', members, analyst, { instrumentIds: [randomUUID()] })).json().code).toBe(
      'INSTRUMENT_NOT_FOUND',
    );
    expect(
      (await call('POST', members, analyst, { instrumentIds: ids, addedOn: '2020-01-01' })).json(),
    ).toEqual({
      added: ids.length,
    });
    expect((await call('POST', members, analyst, { instrumentIds: ids })).json()).toEqual({ added: 0 });
    const removed = await call('POST', `${members}/remove`, analyst, {
      instrumentIds: [ids[0]],
      removedOn: '2025-01-01',
    });
    expect(removed.json()).toEqual({ removed: 1 });
    // RELIANCE is delisted from 2026-11-01, after both dates below, so it still counts.
    const resolved = (
      await call('POST', `/groups/${group.id}/resolve`, analyst, { asOf: '2024-12-31' })
    ).json();
    expect(resolved.count).toBe(ids.length);
    expect((await call('GET', `${members}?asOf=2025-01-01`, analyst)).json().data).toHaveLength(
      ids.length - 1,
    );

    await call('PATCH', `/groups/${group.id}`, analyst, { isShared: true });
    expect((await call('GET', `/groups/${group.id}`, viewer)).statusCode).toBe(200);
    expect((await call('PATCH', `/groups/${group.id}`, other, { name: 'Mine now' })).json().code).toBe(
      'AUTHZ_FORBIDDEN',
    );

    const system = (
      await pool.query<{ id: string }>(
        `insert into ref.market_group (code, name, group_type, is_system)
         values ('NIFTY50', 'Nifty 50', 'INDEX', true) returning id::text`,
      )
    ).rows[0]!.id;
    expect((await call('PATCH', `/groups/${system}`, analyst, { name: 'x' })).json().code).toBe(
      'GROUP_IMMUTABLE_SYSTEM',
    );
    expect((await call('DELETE', `/groups/${system}`, analyst)).json().code).toBe('GROUP_IMMUTABLE_SYSTEM');
    expect((await call('DELETE', `/groups/${group.id}`, analyst)).statusCode).toBe(204);
    expect((await audits('group.members_added'))[0]!.metadata).toMatchObject({ added: ids.length });
  });

  it('validates corporate actions by type, refuses duplicates and deletes with audit', async () => {
    const analyst = await token('ANALYST', ANALYST);
    const instrumentId = (await call('GET', '/instruments?q=HDFCBANK', analyst)).json().data[0].id;
    const split = { instrumentId, actionType: 'SPLIT', exDate: '2019-09-19', ratioFrom: '2', ratioTo: '1' };
    const noRatio = await call('POST', '/corporate-actions', analyst, { ...split, ratioTo: undefined });
    expect(noRatio.json().code).toBe('CORPORATE_ACTION_INVALID');
    const noCash = await call('POST', '/corporate-actions', analyst, {
      instrumentId,
      actionType: 'DIVIDEND',
      exDate: '2024-05-10',
    });
    expect(noCash.json().code).toBe('CORPORATE_ACTION_INVALID');
    const created = await call('POST', '/corporate-actions', analyst, split);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ symbol: 'HDFCBANK', ratioFrom: '2.000000', ratioTo: '1.000000' });
    expect((await call('POST', '/corporate-actions', analyst, split)).json().code).toBe(
      'CORPORATE_ACTION_DUPLICATE',
    );
    const listed = await call(
      'GET',
      `/corporate-actions?instrumentId=${instrumentId}&actionType=SPLIT`,
      analyst,
    );
    expect(listed.json().data).toHaveLength(1);
    expect((await call('DELETE', `/corporate-actions/${created.json().id}`, analyst)).statusCode).toBe(204);
    expect((await audits('corporate_action.deleted'))[0]!.before).toMatchObject({ actionType: 'SPLIT' });
  });
});
