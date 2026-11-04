import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import {
  createKeyring,
  hashPassword,
  hotp,
  migrate,
  RevocationSet,
  signAccessToken,
  totpCounter,
  type IdentityDeps,
} from '@tradesoft/db';
import { buildApp } from '../src/app.ts';

const adminUrl = testDatabaseUrl();
const PASSWORD = 'purple monsoon ledger quietly';
const VIEWER = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f80';
// Audit rows reference their actor, so administrator tokens belong to a real user.
const ADMIN = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f81';

describe.skipIf(!adminUrl)('admin api', { timeout: 60_000 }, () => {
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

  async function token(
    role: string,
    sub = role === 'ADMIN' ? ADMIN : randomUUID(),
    sid = randomUUID(),
  ): Promise<string> {
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
      sid,
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
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${auth}`, ...headers },
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    const c = await db.connect();
    try {
      await migrate(c);
      await c.query(
        `insert into iam.app_user (id, email, password_hash, display_name, status) values ($1, 'v@test.local', $2, 'Test Viewer', 'ACTIVE')`,
        [VIEWER, await hashPassword(PASSWORD)],
      );
      await c.query(
        "insert into iam.user_role (user_id, role_id) select $1::uuid, id from iam.role where code = 'VIEWER'",
        [VIEWER],
      );
      await c.query(
        "insert into iam.app_user (id, email, password_hash, display_name, status) values ($1, 'a@test.local', '!', 'Test Admin', 'ACTIVE')",
        [ADMIN],
      );
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

  it('updates a setting only with a matching If-Match, of the same type, outside security.* (05 D-05-13)', async () => {
    const admin = await token('ADMIN');
    const list = (await call('GET', '/api/v1/admin/settings', admin)).json().data as {
      key: string;
      etag: string;
    }[];
    const etag = list.find((s) => s.key === 'scanner.statement_timeout_ms')!.etag;
    const url = '/api/v1/admin/settings/scanner.statement_timeout_ms';
    expect((await call('PUT', url, admin, { value: 6000 })).json().code).toBe('PRECONDITION_REQUIRED');
    expect((await call('PUT', url, admin, { value: 6000 }, { 'if-match': '"stale"' })).json().code).toBe(
      'PRECONDITION_FAILED',
    );
    expect((await call('PUT', url, admin, { value: 'six' }, { 'if-match': etag })).json().code).toBe(
      'SETTING_VALUE_INVALID',
    );
    const ok = await call('PUT', url, admin, { value: 6000 }, { 'if-match': etag });
    expect(ok.json()).toEqual({ key: 'scanner.statement_timeout_ms', value: 6000 });
    expect(ok.headers['etag']).not.toBe(etag);
    const sec = list.find((s) => s.key === 'security.access_token_ttl_seconds')!.etag;
    expect(
      (
        await call(
          'PUT',
          '/api/v1/admin/settings/security.access_token_ttl_seconds',
          admin,
          { value: 60 },
          { 'if-match': sec },
        )
      ).json().code,
    ).toBe('SETTING_READ_ONLY');
  });

  it('changes the own password, keeping only the calling session family (06 §4.5)', async () => {
    const families = [randomUUID(), randomUUID()];
    const sessions = [randomUUID(), randomUUID()];
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `insert into iam.auth_session (id, user_id, family_id, family_started_at, refresh_token_hash, access_token_jti, expires_at)
         values ($1, $2, $3, now(), $4, gen_random_uuid(), now() + interval '1 day')`,
        [sessions[i], VIEWER, families[i], Buffer.from(randomUUID())],
      );
    }
    const t = await token('VIEWER', VIEWER, sessions[1]);
    expect(
      (
        await call('POST', '/api/v1/auth/password/change', t, { currentPassword: 'wrong', newPassword: 'x' })
      ).json().code,
    ).toBe('AUTH_INVALID_CREDENTIALS');
    expect(
      (
        await call('POST', '/api/v1/auth/password/change', t, {
          currentPassword: PASSWORD,
          newPassword: 'short',
        })
      ).json().code,
    ).toBe('AUTH_PASSWORD_POLICY');
    expect(
      (
        await call('POST', '/api/v1/auth/password/change', t, {
          currentPassword: PASSWORD,
          newPassword: 'amber harbour violin sunrise',
        })
      ).statusCode,
    ).toBe(204);
    const { rows } = await pool.query<{ family_id: string; revoked: boolean }>(
      'select family_id::text, revoked_at is not null as revoked from iam.auth_session where user_id = $1 order by 1',
      [VIEWER],
    );
    expect(Object.fromEntries(rows.map((r) => [r.family_id, r.revoked]))).toEqual({
      [families[0]!]: true,
      [families[1]!]: false,
    });
  });

  it('guards role assignment, deactivates through the state machine, and audits both', async () => {
    const admin = await token('ADMIN');
    const roles = (body: object) => call('PUT', `/api/v1/users/${VIEWER}/roles`, admin, body);
    expect((await roles({ roleCodes: ['ADMIN'] })).json().code).toBe('VALIDATION_FAILED');
    expect((await roles({ roleCodes: ['INGEST_SERVICE'] })).json().code).toBe('VALIDATION_FAILED');
    expect((await roles({ roleCodes: ['ANALYST'] })).json().roles).toEqual(['ANALYST']);

    const deactivate = () =>
      call('POST', `/api/v1/users/${VIEWER}/deactivate`, admin, { reason: 'left the organisation' });
    expect((await deactivate()).json().status).toBe('DEACTIVATED');
    expect((await deactivate()).json().code).toBe('RESOURCE_CONFLICT');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'v@test.local', password: 'amber harbour violin sunrise' },
    });
    expect(login.json().code).toBe('AUTH_ACCOUNT_SUSPENDED');

    const audit = (await call('GET', `/api/v1/admin/audit-events?entityId=${VIEWER}`, admin)).json().data as {
      action: string;
    }[];
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['user.roles_changed', 'user.deactivated', 'user.password_changed']),
    );
    const wide = await call(
      'GET',
      '/api/v1/admin/audit-events?from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      admin,
    );
    expect(wide.json().code).toBe('AUDIT_RANGE_TOO_LARGE');
  });

  it('validates schedule changes and reports another user’s session as absent', async () => {
    const admin = await token('ADMIN');
    const { rows } = await pool.query<{ id: string }>(
      "insert into ops.job_schedule (code, job_type, cron) values ('t', 'test.tick', '0 18 * * 1-5') returning id::text",
    );
    const url = `/api/v1/admin/job-schedules/${rows[0]!.id}`;
    expect((await call('PATCH', url, admin, { cron: 'not a cron!' })).json().code).toBe('VALIDATION_FAILED');
    expect((await call('PATCH', url, admin, { isEnabled: false })).json()).toMatchObject({
      is_enabled: false,
    });
    const other = await pool.query<{ id: string }>(
      'select id::text from iam.auth_session where user_id = $1 limit 1',
      [VIEWER],
    );
    expect(
      (await call('DELETE', `/api/v1/auth/sessions/${other.rows[0]!.id}`, await token('VIEWER'))).json().code,
    ).toBe('RESOURCE_NOT_FOUND');
  });

  it('lets an administrator without MFA enrol with the login challenge from the same client (06 §6.5)', async () => {
    const { rows } = await pool.query<{ id: string }>(
      "insert into iam.app_user (email, password_hash, display_name, status) values ('boss@test.local', $1, 'Test Boss', 'ACTIVE') returning id::text",
      [await hashPassword(PASSWORD)],
    );
    await pool.query(
      "insert into iam.user_role (user_id, role_id) select $1::uuid, id from iam.role where code = 'ADMIN'",
      [rows[0]!.id],
    );
    const ua = { 'user-agent': 'browser-one' };
    const post = (url: string, payload: object, headers: Record<string, string> = ua) =>
      app.inject({ method: 'POST', url: `/api/v1/auth/${url}`, headers, payload });

    const login = await post('login', { email: 'boss@test.local', password: PASSWORD });
    expect(login.statusCode).toBe(202);
    const { challengeId, enrolmentRequired } = login.json();
    expect(enrolmentRequired).toBe(true);
    expect((await post('mfa/enroll', { challengeId }, { 'user-agent': 'another-browser' })).json().code).toBe(
      'AUTH_MFA_INVALID',
    );

    const enrolled = await post('mfa/enroll', { challengeId });
    expect(enrolled.statusCode).toBe(200);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...(enrolled.json().secret as string)]
      .map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, '0'))
      .join('');
    const secret = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));

    expect((await post('mfa/confirm', { challengeId, code: '000000' })).json().code).toBe('AUTH_MFA_INVALID');
    const confirmed = await post('mfa/confirm', { challengeId, code: hotp(secret, totpCounter(Date.now())) });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().user.roles).toEqual(['ADMIN']);
    expect((confirmed.headers['set-cookie'] as string[])[0]).toMatch(/^ts_rt=/);
    expect(
      (await post('mfa/confirm', { challengeId, code: hotp(secret, totpCounter(Date.now())) })).json().code,
    ).toBe('AUTH_MFA_INVALID');
    expect((await post('login', { email: 'boss@test.local', password: PASSWORD })).json()).toMatchObject({
      methods: ['TOTP'],
    });
  });
});
