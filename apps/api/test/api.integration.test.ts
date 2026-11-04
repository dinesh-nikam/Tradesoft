import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  createKeyring,
  hashPassword,
  migrate,
  RevocationSet,
  signAccessToken,
  type IdentityDeps,
} from '@tradesoft/db';
import { buildApp } from '../src/app.ts';

const adminUrl = testDatabaseUrl();
const PASSWORD = 'purple monsoon ledger quietly';

describe.skipIf(!adminUrl)('api', { timeout: 60_000 }, () => {
  let db: ScratchDatabase;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
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

  async function tokenFor(role: string, userId = randomUUID()): Promise<string> {
    const { rows } = await pool.query<{ perms: string[] }>(
      `select array_agg(p.code) as perms from iam.role r join iam.role_permission rp on rp.role_id = r.id
         join iam.permission p on p.id = rp.permission_id where r.code = $1`,
      [role],
    );
    const iat = Math.floor(Date.now() / 1000);
    return signAccessToken(identity.keyring, {
      iss: identity.issuer,
      aud: identity.audience,
      sub: userId,
      sid: randomUUID(),
      ver: 1,
      roles: [role],
      perms: rows[0]!.perms,
      iat,
      exp: iat + 900,
      jti: randomUUID(),
    });
  }

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    const c = await db.connect();
    await migrate(c);
    const hash = await hashPassword(PASSWORD);
    await c.query(
      `insert into iam.app_user (id, email, password_hash, display_name, status)
       values ('018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70', 'viewer@test.local', $1, 'Test Viewer', 'ACTIVE'),
              ('018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f71', 'admin@test.local', $1, 'Test Admin', 'ACTIVE')`,
      [hash],
    );
    await c
      .query(
        `insert into iam.user_role (user_id, role_id)
       select '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70'::uuid, id from iam.role where code = 'VIEWER'
       union all select '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f71'::uuid, id from iam.role where code = 'ADMIN'`,
      )
      .finally(() => c.end());
    pool = new pg.Pool({ connectionString: db.url, max: 5 });
    app = buildApp({ pool, identity });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await db?.drop();
  }, 60_000);

  it('SEC-T-01 / E3.2: refuses to boot with a route that declares no access', async () => {
    const bad = buildApp(
      { pool, identity },
      { configure: (a) => void a.get('/api/v1/oops', async () => ({})) },
    );
    await expect(bad.ready()).rejects.toThrow(/unprotected.*GET \/api\/v1\/oops/);
    expect(app.routeTable.length).toBeGreaterThan(15);
  });

  it('SEC-T-05: every protected route answers 403 exactly to the roles of 00 §4.2 that lack its permission', async () => {
    const tokens = Object.fromEntries(
      await Promise.all(['VIEWER', 'ANALYST', 'ADMIN'].map(async (r) => [r, await tokenFor(r)] as const)),
    );
    const perms = Object.fromEntries(
      await Promise.all(
        ['VIEWER', 'ANALYST', 'ADMIN'].map(async (r) => {
          const { rows } = await pool.query<{ code: string }>(
            `select p.code from iam.role r join iam.role_permission rp on rp.role_id = r.id join iam.permission p on p.id = rp.permission_id where r.code = $1`,
            [r],
          );
          return [r, new Set(rows.map((x) => x.code))] as const;
        }),
      ),
    );
    let checked = 0;
    for (const route of app.routeTable.filter((r) => r.permission)) {
      const url = route.url.replace(/:[a-zA-Z]+/g, randomUUID());
      for (const role of ['VIEWER', 'ANALYST', 'ADMIN']) {
        const res = await app.inject({
          method: route.method as 'GET',
          url,
          headers: { authorization: `Bearer ${tokens[role]}` },
          ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
        });
        const allowed = perms[role]!.has(route.permission!);
        expect
          .soft(res.statusCode === 403, `${role} ${route.method} ${route.url} -> ${res.statusCode}`)
          .toBe(!allowed);
        expect.soft(res.statusCode, `${role} ${route.method} ${route.url} must not crash`).toBeLessThan(500);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('logs in, rotates through refresh with the CSRF double-submit, and logs out', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'viewer@test.local', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'] as string[];
    expect(setCookie[0]).toMatch(/^ts_rt=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/api\/v1\/auth/);
    const jar = setCookie.map((c) => c.split(';')[0]).join('; ');
    const csrf = setCookie[1]!.split(';')[0]!.slice('ts_csrf='.length);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(me.json()).toMatchObject({ email: 'viewer@test.local', mfaEnabled: false });

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: jar },
    });
    expect(noCsrf.json()).toMatchObject({ status: 403, code: 'AUTH_CSRF_INVALID' });
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: jar, 'x-csrf-token': csrf },
    });
    expect(refreshed.statusCode).toBe(200);
    const jar2 = (refreshed.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');
    const csrf2 = (refreshed.headers['set-cookie'] as string[])[1]!.split(';')[0]!.slice('ts_csrf='.length);

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: jar2, 'x-csrf-token': csrf2 },
    });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: jar2, 'x-csrf-token': csrf2 },
    });
    expect(after.json()).toMatchObject({ status: 401, code: 'AUTH_SESSION_REVOKED' });
  });

  it('answers every failure as an RFC 9457 problem with the request id, and sets the security headers', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/nowhere?x=1',
      // 05 §5.3: authentication is decided before existence, so the probe carries a valid token.
      headers: { 'x-request-id': 'client-req-0001', authorization: `Bearer ${await tokenFor('VIEWER')}` },
    });
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/nowhere' });
    expect(anonymous.json().code).toBe('AUTH_TOKEN_MISSING');
    expect(missing.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(missing.json()).toMatchObject({
      type: 'urn:tradesoft:problem:v1:resource-not-found',
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
      instance: '/api/v1/nowhere',
      correlationId: 'client-req-0001',
      retryable: false,
    });
    expect(missing.headers['x-request-id']).toBe('client-req-0001');
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
    expect(missing.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    const replaced = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'bad id!' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    expect((await app.inject({ method: 'GET', url: '/api/v1/users' })).json().code).toBe(
      'AUTH_TOKEN_MISSING',
    );
    const iat = Math.floor(Date.now() / 1000) - 2000;
    const expired = signAccessToken(identity.keyring, {
      iss: identity.issuer,
      aud: identity.audience,
      sub: randomUUID(),
      sid: randomUUID(),
      ver: 1,
      roles: [],
      perms: ['user:read'],
      iat,
      exp: iat + 900,
      jti: randomUUID(),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/users',
          headers: { authorization: `Bearer ${expired}` },
        })
      ).json().code,
    ).toBe('AUTH_TOKEN_EXPIRED');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x', isAdmin: true },
    });
    expect(bad.json()).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('rate-limits login per IP and email (05 §9.1) with RateLimit and Retry-After headers', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.20.30.40',
        payload: { email: 'admin@test.local', password: 'wrong wrong wrong' },
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-policy']).toBe('5;w=900');
  });

  it('issues an API key once, confines it to the machine role, and revokes it', async () => {
    const admin = await tokenFor('ADMIN', '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f71');
    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: 'vendor', scopes: ['ingestion:submit'] },
    });
    expect(issued.statusCode).toBe(201);
    const key: string = issued.json().key;
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: { 'x-api-key': key },
    });
    expect(denied.json().code).toBe('AUTHZ_SCOPE_INSUFFICIENT');
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(JSON.stringify(listed.json())).not.toContain(key);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/api-keys/${issued.json().id}`,
          headers: { authorization: `Bearer ${admin}` },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/permissions', headers: { 'x-api-key': key } })).json()
        .code,
    ).toBe('AUTH_TOKEN_INVALID');
    const scope = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: 'x', scopes: ['user:write'] },
    });
    expect(scope.json().code).toBe('API_KEY_SCOPE_INVALID');
  });
});
