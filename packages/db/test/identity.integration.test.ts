import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabase, testDatabaseUrl, type ScratchDatabase } from '@tradesoft/testing';
import { migrate } from '../src/index.ts';
import {
  authenticateApiKey,
  beginMfaEnrolment,
  confirmMfaEnrolment,
  createKeyring,
  createOneTimeToken,
  hashPassword,
  hotp,
  issueApiKey,
  login,
  refreshSession,
  resetPassword,
  RevocationSet,
  revokeApiKey,
  totpCounter,
  verifyAccessToken,
  verifyMfaChallenge,
  type IdentityDeps,
} from '../src/identity/index.ts';

const adminUrl = testDatabaseUrl();
const PASSWORD = 'purple monsoon ledger quietly';
const client = { ip: '10.0.0.1', userAgent: 'vitest', correlationId: randomUUID() };

// Every login runs a real Argon2id at 06 §4.4 cost, so these tests take seconds, not milliseconds.
describe.skipIf(!adminUrl)('identity services', { timeout: 60_000 }, () => {
  let db: ScratchDatabase;
  let c: pg.Client;
  let clock = Date.parse('2026-11-03T10:00:00Z');
  const revocations = new RevocationSet();
  const deps: IdentityDeps = {
    keyring: createKeyring(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ),
    issuer: 'https://tradesoft.test',
    audience: 'tradesoft-api',
    mfaKey: Buffer.alloc(32, 9),
    mfaKeyId: 1,
    blocklist: new Set(['password123456']),
    revocations,
    now: () => clock,
  };

  async function user(email: string, role: string, status = 'ACTIVE'): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `insert into iam.app_user (email, password_hash, display_name, status) values ($1, $2, 'Test User', $3) returning id::text`,
      [email, await hashPassword(PASSWORD), status],
    );
    await c.query(
      'insert into iam.user_role (user_id, role_id) select $1, id from iam.role where code = $2',
      [rows[0]!.id, role],
    );
    return rows[0]!.id;
  }
  const events = async (type: string) =>
    (await c.query('select 1 from audit.security_event where event_type = $1', [type])).rowCount;

  beforeAll(async () => {
    db = await createScratchDatabase(adminUrl!);
    c = await db.connect();
    await migrate(c);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await db?.drop();
  }, 60_000);

  it('logs in, issuing an access token that carries the role permissions', async () => {
    await user('viewer@test.local', 'VIEWER');
    const r = await login(c, { email: 'viewer@test.local', password: PASSWORD }, client, deps);
    expect(r.kind).toBe('SUCCESS');
    if (r.kind !== 'SUCCESS') return;
    const claims = verifyAccessToken(deps.keyring, r.session.accessToken, {
      issuer: deps.issuer,
      audience: deps.audience,
      nowSeconds: Math.floor(clock / 1000),
      isRevoked: (sid) => revocations.has(sid, clock),
    });
    expect(claims.roles).toEqual(['VIEWER']);
    expect(claims.perms).toContain('chart:read');
    expect(claims.perms).not.toContain('user:write');
  });

  it('answers an unknown email exactly like a wrong password, and locks at ten failures (06 §4.6)', async () => {
    expect((await login(c, { email: 'nobody@test.local', password: PASSWORD }, client, deps)).kind).toBe(
      'INVALID',
    );
    await user('locked@test.local', 'VIEWER');
    for (let i = 0; i < 10; i++) {
      expect(
        (await login(c, { email: 'locked@test.local', password: 'wrong password!!' }, client, deps)).kind,
      ).toBe('INVALID');
    }
    expect(await events('LOGIN_LOCKED')).toBe(1);
    expect((await login(c, { email: 'locked@test.local', password: PASSWORD }, client, deps)).kind).toBe(
      'LOCKED',
    );
    clock += 16 * 60_000;
    expect((await login(c, { email: 'locked@test.local', password: PASSWORD }, client, deps)).kind).toBe(
      'SUCCESS',
    );
  });

  it('E3.3: replaying a rotated refresh token outside the grace window revokes the whole family', async () => {
    await user('rotate@test.local', 'ANALYST');
    const first = await login(c, { email: 'rotate@test.local', password: PASSWORD }, client, deps);
    if (first.kind !== 'SUCCESS') throw new Error(first.kind);
    const second = await refreshSession(c, first.session.refreshToken, client, deps);
    if (second.kind !== 'SUCCESS') throw new Error(second.kind);
    expect(second.session.familyId).toBe(first.session.familyId);

    clock += 11_000;
    expect((await refreshSession(c, first.session.refreshToken, client, deps)).kind).toBe('REUSED');
    expect(await events('TOKEN_REUSE_DETECTED')).toBe(1);
    expect((await refreshSession(c, second.session.refreshToken, client, deps)).kind).toBe('REVOKED');
    expect(revocations.has(second.session.sessionId, clock)).toBe(true);
  });

  it('treats a replay within ten seconds from the same client as a benign race, at most three times a day', async () => {
    await user('race@test.local', 'ANALYST');
    const r = await login(c, { email: 'race@test.local', password: PASSWORD }, client, deps);
    if (r.kind !== 'SUCCESS') throw new Error(r.kind);
    const token = r.session.refreshToken;
    const rotated = await refreshSession(c, token, client, deps);
    expect(rotated.kind).toBe('SUCCESS');
    for (let i = 0; i < 3; i++) {
      const again = await refreshSession(c, token, client, deps);
      expect(again.kind).toBe('SUCCESS');
    }
    expect((await refreshSession(c, token, client, deps)).kind).toBe('REUSED');
    const other = await refreshSession(c, token, { ...client, ip: '10.9.9.9' }, deps);
    expect(other.kind).toBe('REVOKED');
  });

  it('enrols TOTP, requires it at login, binds the challenge to the client and refuses a replayed code', async () => {
    const id = await user('mfa@test.local', 'ANALYST');
    const begun = await beginMfaEnrolment(c, id, deps);
    if (begun.kind !== 'PENDING') throw new Error(begun.kind);
    expect(begun.recoveryCodes).toHaveLength(10);
    const secret = Buffer.from(
      begun.secret
        .split('')
        .reduce(
          (bits, ch) => bits + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0'),
          '',
        )
        .match(/.{8}/g)!
        .map((b) => parseInt(b, 2)),
    );
    expect(await confirmMfaEnrolment(c, id, hotp(secret, totpCounter(clock)), client, deps)).toBe(true);

    clock += 60_000;
    const r = await login(c, { email: 'mfa@test.local', password: PASSWORD }, client, deps);
    if (r.kind !== 'MFA_REQUIRED') throw new Error(r.kind);
    const code = hotp(secret, totpCounter(clock));
    expect(
      (
        await verifyMfaChallenge(
          c,
          { challengeId: r.challengeId, code },
          { ...client, userAgent: 'other' },
          deps,
        )
      ).kind,
    ).toBe('INVALID');
    expect(
      (await verifyMfaChallenge(c, { challengeId: r.challengeId, code: '000000' }, client, deps)).kind,
    ).toBe('INVALID');
    expect((await verifyMfaChallenge(c, { challengeId: r.challengeId, code }, client, deps)).kind).toBe(
      'SUCCESS',
    );

    const again = await login(c, { email: 'mfa@test.local', password: PASSWORD }, client, deps);
    if (again.kind !== 'MFA_REQUIRED') throw new Error(again.kind);
    expect((await verifyMfaChallenge(c, { challengeId: again.challengeId, code }, client, deps)).kind).toBe(
      'INVALID',
    );
  });

  it('sends an administrator without MFA to enrolment instead of issuing a session (06 §6.5)', async () => {
    await user('admin@test.local', 'ADMIN');
    expect((await login(c, { email: 'admin@test.local', password: PASSWORD }, client, deps)).kind).toBe(
      'MFA_ENROLMENT_REQUIRED',
    );
  });

  it('resets a password once per token, enforces policy and history, revokes sessions and activates invitees', async () => {
    const id = await user('reset@test.local', 'VIEWER', 'PENDING_VERIFICATION');
    const token = await createOneTimeToken(c, id, 'EMAIL_VERIFICATION', deps);
    expect((await resetPassword(c, { token, newPassword: 'short' }, client, deps)).kind).toBe('POLICY');
    expect((await resetPassword(c, { token, newPassword: PASSWORD }, client, deps)).kind).toBe('REUSED');
    expect(
      (await resetPassword(c, { token, newPassword: 'amber harbour violin sunrise' }, client, deps)).kind,
    ).toBe('SUCCESS');
    expect(
      (await resetPassword(c, { token, newPassword: 'another fresh passphrase' }, client, deps)).kind,
    ).toBe('INVALID_TOKEN');
    expect(
      (await login(c, { email: 'reset@test.local', password: 'amber harbour violin sunrise' }, client, deps))
        .kind,
    ).toBe('SUCCESS');

    const r2 = await createOneTimeToken(c, id, 'PASSWORD_RESET', deps);
    const r3 = await createOneTimeToken(c, id, 'PASSWORD_RESET', deps);
    expect(
      (await resetPassword(c, { token: r2, newPassword: 'cobalt meadow lantern drift' }, client, deps)).kind,
    ).toBe('INVALID_TOKEN');
    expect(
      (await resetPassword(c, { token: r3, newPassword: 'cobalt meadow lantern drift' }, client, deps)).kind,
    ).toBe('SUCCESS');
    const live = await c.query(
      "select 1 from iam.auth_session s join iam.app_user u on u.id = s.user_id where u.email = 'reset@test.local' and s.revoked_at is null",
    );
    expect(live.rowCount).toBe(0);
  });

  it('issues API keys only within the machine role, authenticates them, and revokes them (06 §8)', async () => {
    const admin = (
      await c.query<{ id: string }>("select id::text from iam.app_user where email = 'admin@test.local'")
    ).rows[0]!.id;
    expect(
      (await issueApiKey(c, { name: 'x', scopes: ['user:write'], createdBy: admin }, client, deps)).kind,
    ).toBe('SCOPE_INVALID');
    expect(
      (
        await issueApiKey(
          c,
          {
            name: 'x',
            scopes: ['ingestion:submit'],
            createdBy: admin,
            expiresAt: new Date(clock + 400 * 86_400_000),
          },
          client,
          deps,
        )
      ).kind,
    ).toBe('EXPIRY_INVALID');
    const issued = await issueApiKey(
      c,
      { name: 'vendor pull', scopes: ['ingestion:submit', 'ingestion:read'], createdBy: admin },
      client,
      deps,
    );
    if (issued.kind !== 'SUCCESS') throw new Error(issued.kind);
    expect(await authenticateApiKey(c, issued.key)).toEqual({
      keyId: issued.id,
      scopes: ['ingestion:submit', 'ingestion:read'],
    });
    expect(await authenticateApiKey(c, `${issued.key.slice(0, -1)}0`)).toBeNull();
    expect(await revokeApiKey(c, issued.id, admin, client)).toBe(true);
    expect(await authenticateApiKey(c, issued.key)).toBeNull();
    const audit = await c.query<{ after: { prefix: string } }>(
      "select after from audit.audit_event where action = 'api_key.created'",
    );
    expect(JSON.stringify(audit.rows)).not.toContain(issued.key);
  });
});
