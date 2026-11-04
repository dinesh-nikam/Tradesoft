// Identity services of 06 §4–§8 over the iam schema. Each function owns its transaction unless stated.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ClientBase } from 'pg';
import { checkPasswordPolicy, type PasswordViolation } from '@tradesoft/domain';
import { recordAudit, recordSecurityEvent } from '../audit.ts';
import {
  ACCESS_TOKEN_SECONDS,
  base32Encode,
  decryptMfaSecret,
  dummyPasswordHash,
  encryptMfaSecret,
  generateApiKey,
  generateRecoveryCodes,
  hashPassword,
  needsRehash,
  otpauthUri,
  randomToken,
  sha256,
  signAccessToken,
  verifyPassword,
  verifyTotp,
  type Keyring,
} from './crypto.ts';
import type { RevocationSet } from './revocation.ts';

type Db = ClientBase;

export interface IdentityDeps {
  keyring: Keyring;
  issuer: string;
  audience: string;
  /** MFA_ENCRYPTION_KEY (32 bytes) and the key id written into each blob (06 §12.3). */
  mfaKey: Buffer;
  mfaKeyId: number;
  blocklist: ReadonlySet<string>;
  revocations?: RevocationSet;
  now?: () => number;
}

export interface ClientInfo {
  ip: string;
  userAgent: string;
  correlationId: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  familyId: string;
  user: { id: string; email: string; displayName: string; roles: string[]; perms: string[] };
}

const LOCK_THRESHOLD = 10;
const LOCK_MINUTES = 15;
const REFRESH_DAYS = 30;
const GRACE_SECONDS = 10;
const GRACE_REUSES_PER_DAY = 3;
const TOKEN_TTL_MINUTES: Record<'PASSWORD_RESET' | 'EMAIL_VERIFICATION' | 'INVITATION', number> = {
  PASSWORD_RESET: 60,
  EMAIL_VERIFICATION: 72 * 60,
  INVITATION: 72 * 60,
};
// 06 §8.3: an API key can never exceed the machine role.
const INGEST_SERVICE_ROLE = 'INGEST_SERVICE';

async function tx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    const out = await fn();
    await db.query('commit');
    return out;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

async function rolesAndPerms(db: Db, userId: string): Promise<{ roles: string[]; perms: string[] }> {
  const { rows } = await db.query<{ roles: string[] | null; perms: string[] | null }>(
    `select array_agg(distinct r.code) as roles, array_agg(distinct p.code) filter (where p.code is not null) as perms
       from iam.user_role ur join iam.role r on r.id = ur.role_id
       left join iam.role_permission rp on rp.role_id = r.id
       left join iam.permission p on p.id = rp.permission_id
      where ur.user_id = $1`,
    [userId],
  );
  return { roles: (rows[0]?.roles ?? []).sort(), perms: (rows[0]?.perms ?? []).sort() };
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
  totp_enrolled_at: Date | null;
  totp_secret_ct: Buffer | null;
  last_totp_counter: string | null;
  mfa_required: boolean;
}

const USER_COLUMNS = `id::text, email::text, display_name, password_hash, status, failed_login_count, locked_until,
  totp_enrolled_at, totp_secret_ct, last_totp_counter, mfa_required`;

/** Creates a session family member and its tokens (06 §5.2, §5.4). Runs inside the caller's transaction. */
async function issueSession(
  db: Db,
  user: UserRow,
  client: ClientInfo,
  deps: IdentityDeps,
  family?: { id: string; startedAt: Date },
): Promise<IssuedSession> {
  const nowMs = (deps.now ?? Date.now)();
  const sessionId = randomUUID();
  const jti = randomUUID();
  const refreshToken = randomToken();
  const familyId = family?.id ?? randomUUID();
  const startedAt = family?.startedAt ?? new Date(nowMs);
  const expiresAt = new Date(
    Math.min(nowMs + REFRESH_DAYS * 86_400_000, startedAt.getTime() + 90 * 86_400_000),
  );
  await db.query(
    `insert into iam.auth_session (id, user_id, family_id, family_started_at, refresh_token_hash, access_token_jti,
                                   issued_at, expires_at, client_ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sessionId,
      user.id,
      familyId,
      startedAt,
      sha256(refreshToken),
      jti,
      new Date(nowMs),
      expiresAt,
      client.ip,
      client.userAgent,
    ],
  );
  const { roles, perms } = await rolesAndPerms(db, user.id);
  const iat = Math.floor(nowMs / 1000);
  const accessToken = signAccessToken(deps.keyring, {
    iss: deps.issuer,
    aud: deps.audience,
    sub: user.id,
    sid: sessionId,
    ver: 1,
    roles,
    perms,
    iat,
    exp: iat + ACCESS_TOKEN_SECONDS,
    jti,
  });
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_SECONDS,
    sessionId,
    familyId,
    user: { id: user.id, email: user.email, displayName: user.display_name, roles, perms },
  };
}

async function createChallenge(db: Db, userId: string, client: ClientInfo, nowMs: number) {
  const expiresAt = new Date(nowMs + 5 * 60_000);
  const { rows } = await db.query<{ id: string }>(
    `insert into iam.mfa_challenge (user_id, ip_hash, ua_hash, expires_at, created_at)
     values ($1, $2, $3, $4, $5) returning id::text`,
    [userId, sha256(client.ip), sha256(client.userAgent), expiresAt, new Date(nowMs)],
  );
  return { challengeId: rows[0]!.id, expiresAt };
}

// ------------------------------------------------------------------------------------------- login

export type LoginResult =
  | { kind: 'INVALID' }
  | { kind: 'LOCKED'; until: Date }
  | { kind: 'SUSPENDED' }
  | { kind: 'PENDING' }
  | { kind: 'MFA_REQUIRED'; challengeId: string; expiresAt: Date }
  | { kind: 'MFA_ENROLMENT_REQUIRED'; challengeId: string; expiresAt: Date }
  | { kind: 'SUCCESS'; session: IssuedSession };

/** 06 §4.6, §6.4, §6.5. The password is verified before any account state is revealed. */
export async function login(
  db: Db,
  input: { email: string; password: string },
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<LoginResult> {
  const nowMs = (deps.now ?? Date.now)();
  const { rows } = await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where email = $1`, [
    input.email,
  ]);
  const user = rows[0];
  const ok = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), input.password);
  const security = { clientIp: client.ip, userAgent: client.userAgent, correlationId: client.correlationId };

  if (!user) {
    await recordSecurityEvent(db, {
      ...security,
      eventType: 'LOGIN_FAILURE',
      severity: 'INFO',
      emailAttempted: input.email,
    });
    return { kind: 'INVALID' };
  }
  if (user.status === 'LOCKED' && user.locked_until && user.locked_until.getTime() > nowMs) {
    return { kind: 'LOCKED', until: user.locked_until };
  }
  return tx(db, async () => {
    if (!ok) {
      if (user.status !== 'ACTIVE' && user.status !== 'LOCKED') return { kind: 'INVALID' } as const;
      const failed = user.failed_login_count + 1;
      const lock = failed >= LOCK_THRESHOLD;
      await db.query(
        `update iam.app_user set failed_login_count = $2,
                status = case when $3 then 'LOCKED' else 'ACTIVE' end,
                locked_until = case when $3 then $4::timestamptz else null end
          where id = $1`,
        [user.id, lock ? 0 : failed, lock, new Date(nowMs + LOCK_MINUTES * 60_000)],
      );
      await recordSecurityEvent(db, {
        ...security,
        userId: user.id,
        eventType: lock ? 'LOGIN_LOCKED' : 'LOGIN_FAILURE',
        severity: lock ? 'WARN' : 'INFO',
      });
      return { kind: 'INVALID' } as const;
    }
    if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') return { kind: 'SUSPENDED' } as const;
    if (user.status === 'PENDING_VERIFICATION') return { kind: 'PENDING' } as const;

    // Correct password on an active, or lock-expired, account.
    await db.query(
      `update iam.app_user set status = 'ACTIVE', failed_login_count = 0, locked_until = null,
              password_hash = coalesce($2, password_hash), last_login_at = $3 where id = $1`,
      [user.id, needsRehash(user.password_hash) ? await hashPassword(input.password) : null, new Date(nowMs)],
    );
    if (user.totp_enrolled_at)
      return { kind: 'MFA_REQUIRED', ...(await createChallenge(db, user.id, client, nowMs)) } as const;
    const { roles } = await rolesAndPerms(db, user.id);
    if (user.mfa_required || roles.includes('ADMIN')) {
      return {
        kind: 'MFA_ENROLMENT_REQUIRED',
        ...(await createChallenge(db, user.id, client, nowMs)),
      } as const;
    }
    const session = await issueSession(db, user, client, deps);
    await recordSecurityEvent(db, {
      ...security,
      userId: user.id,
      eventType: 'LOGIN_SUCCESS',
      severity: 'INFO',
    });
    return { kind: 'SUCCESS', session } as const;
  });
}

export type MfaVerifyResult = { kind: 'INVALID' } | { kind: 'SUCCESS'; session: IssuedSession };

/** 06 §6.4: a challenge bound to the client, five attempts, codes never accepted twice. */
export async function verifyMfaChallenge(
  db: Db,
  input: { challengeId: string; code: string },
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<MfaVerifyResult> {
  const nowMs = (deps.now ?? Date.now)();
  return tx(db, async () => {
    const { rows } = await db.query<{
      user_id: string;
      ip_hash: Buffer;
      ua_hash: Buffer;
      expires_at: Date;
      consumed_at: Date | null;
      attempts: number;
    }>(
      'select user_id::text, ip_hash, ua_hash, expires_at, consumed_at, attempts from iam.mfa_challenge where id = $1 for update',
      [input.challengeId],
    );
    const ch = rows[0];
    const bound = ch && ch.ip_hash.equals(sha256(client.ip)) && ch.ua_hash.equals(sha256(client.userAgent));
    if (!ch || !bound || ch.consumed_at || ch.expires_at.getTime() <= nowMs || ch.attempts >= 5)
      return { kind: 'INVALID' } as const;
    const user = (
      await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where id = $1 for update`, [
        ch.user_id,
      ])
    ).rows[0]!;
    if (!user.totp_enrolled_at || !user.totp_secret_ct) return { kind: 'INVALID' } as const;
    const secret = decryptMfaSecret(deps.mfaKey, user.id, user.totp_secret_ct);
    const counter = verifyTotp(
      secret,
      input.code,
      nowMs,
      user.last_totp_counter === null ? null : Number(user.last_totp_counter),
    );
    if (counter === null) {
      await db.query('update iam.mfa_challenge set attempts = attempts + 1 where id = $1', [
        input.challengeId,
      ]);
      await recordSecurityEvent(db, {
        userId: user.id,
        eventType: 'MFA_FAILURE',
        severity: 'WARN',
        clientIp: client.ip,
        userAgent: client.userAgent,
        correlationId: client.correlationId,
      });
      return { kind: 'INVALID' } as const;
    }
    await db.query('update iam.mfa_challenge set consumed_at = $2 where id = $1', [
      input.challengeId,
      new Date(nowMs),
    ]);
    await db.query('update iam.app_user set last_totp_counter = $2 where id = $1', [user.id, counter]);
    const session = await issueSession(db, user, client, deps);
    await recordSecurityEvent(db, {
      userId: user.id,
      eventType: 'LOGIN_SUCCESS',
      severity: 'INFO',
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return { kind: 'SUCCESS', session } as const;
  });
}

// ----------------------------------------------------------------------------------------- refresh

export type RefreshResult =
  { kind: 'REVOKED' } | { kind: 'REUSED' } | { kind: 'SUCCESS'; session: IssuedSession };

/** Revokes every live session of a family in one statement (06 §5.7) and remembers them locally. */
export async function revokeFamily(
  db: Db,
  familyId: string,
  reason: string,
  deps: Pick<IdentityDeps, 'revocations' | 'now'>,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `update iam.auth_session set revoked_at = now(), revoked_reason = $2
      where family_id = $1 and revoked_at is null returning id::text`,
    [familyId, reason],
  );
  for (const r of rows) deps.revocations?.add(r.id, (deps.now ?? Date.now)());
}

/** Revokes every session of a user, optionally keeping one family (06 §4.5 password change). */
export async function revokeUserSessions(
  db: Db,
  userId: string,
  reason: string,
  deps: Pick<IdentityDeps, 'revocations' | 'now'>,
  keepFamilyId?: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `update iam.auth_session set revoked_at = now(), revoked_reason = $2
      where user_id = $1 and revoked_at is null and ($3::uuid is null or family_id <> $3) returning id::text`,
    [userId, reason, keepFamilyId ?? null],
  );
  for (const r of rows) deps.revocations?.add(r.id, (deps.now ?? Date.now)());
}

/** Rotation with reuse detection and the 10-second grace window of 06 §5.4–§5.5. */
export async function refreshSession(
  db: Db,
  refreshToken: string,
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<RefreshResult> {
  const nowMs = (deps.now ?? Date.now)();
  const security = { clientIp: client.ip, userAgent: client.userAgent, correlationId: client.correlationId };
  return tx(db, async () => {
    const { rows } = await db.query<{
      id: string;
      user_id: string;
      family_id: string;
      family_started_at: Date;
      issued_at: Date;
      expires_at: Date;
      used_at: Date | null;
      revoked_at: Date | null;
      client_ip: string | null;
      user_agent: string | null;
    }>(
      `select id::text, user_id::text, family_id::text, family_started_at, issued_at, expires_at, used_at, revoked_at,
              host(client_ip) as client_ip, user_agent
         from iam.auth_session where refresh_token_hash = $1 for update`,
      [sha256(refreshToken)],
    );
    const s = rows[0];
    if (!s || s.revoked_at || s.expires_at.getTime() <= nowMs) return { kind: 'REVOKED' } as const;

    if (s.used_at) {
      const sameClient = s.client_ip === client.ip && s.user_agent === client.userAgent;
      const inGrace = nowMs - s.used_at.getTime() <= GRACE_SECONDS * 1000;
      if (!inGrace || !sameClient) {
        await revokeFamily(db, s.family_id, 'REUSE_DETECTED', deps);
        await recordSecurityEvent(db, {
          ...security,
          userId: s.user_id,
          eventType: 'TOKEN_REUSE_DETECTED',
          severity: 'HIGH',
          details: { familyId: s.family_id },
        });
        return { kind: 'REUSED' } as const;
      }
      const { rows: graces } = await db.query<{ n: number }>(
        `select count(*)::integer as n from audit.security_event
          where event_type = 'TOKEN_REFRESH' and details->>'reason' = 'GRACE_REUSE' and details->>'familyId' = $1
            and occurred_at > now() - interval '24 hours'`,
        [s.family_id],
      );
      if (graces[0]!.n >= GRACE_REUSES_PER_DAY) {
        await revokeFamily(db, s.family_id, 'REUSE_DETECTED', deps);
        await recordSecurityEvent(db, {
          ...security,
          userId: s.user_id,
          eventType: 'TOKEN_REUSE_DETECTED',
          severity: 'HIGH',
          details: { familyId: s.family_id, graceReuses: graces[0]!.n + 1 },
        });
        return { kind: 'REUSED' } as const;
      }
      // Benign race: drop the successor issued from this row (the family's one unused live row); rotation
      // then continues from this row below.
      await db.query(
        'delete from iam.auth_session where family_id = $1 and id <> $2 and used_at is null and revoked_at is null',
        [s.family_id, s.id],
      );
      await recordSecurityEvent(db, {
        ...security,
        userId: s.user_id,
        eventType: 'TOKEN_REFRESH',
        severity: 'INFO',
        details: { reason: 'GRACE_REUSE', familyId: s.family_id },
      });
    }

    const user = (
      await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where id = $1`, [s.user_id])
    ).rows[0]!;
    if (user.status !== 'ACTIVE') {
      await revokeFamily(db, s.family_id, 'ACCOUNT_INACTIVE', deps);
      return { kind: 'REVOKED' } as const;
    }
    await db.query('update iam.auth_session set used_at = $2, last_used_at = $2 where id = $1', [
      s.id,
      new Date(nowMs),
    ]);
    const session = await issueSession(db, user, client, deps, {
      id: s.family_id,
      startedAt: s.family_started_at,
    });
    return { kind: 'SUCCESS', session } as const;
  });
}

/** Session ids revoked since the last poll, for the revocation set (06 §5.7). */
export async function pollRevocations(db: Db, revocations: RevocationSet): Promise<void> {
  const since = revocations.lastPollAt ?? new Date(0);
  const { rows } = await db.query<{ id: string; revoked_at: Date }>(
    `select id::text, revoked_at from iam.auth_session
      where revoked_at > $1 and revoked_at > now() - interval '90 minutes'`,
    [since],
  );
  for (const r of rows) revocations.add(r.id, r.revoked_at.getTime());
  revocations.lastPollAt = new Date();
}

// --------------------------------------------------------------------------------------------- MFA

/** 06 §6.3 step 1: a pending secret, replaced by a repeated call; recovery codes shown once. */
export async function beginMfaEnrolment(db: Db, userId: string, deps: IdentityDeps) {
  return tx(db, async () => {
    const { rows } = await db.query<{ email: string; totp_enrolled_at: Date | null }>(
      'select email::text, totp_enrolled_at from iam.app_user where id = $1 for update',
      [userId],
    );
    if (!rows[0] || rows[0].totp_enrolled_at) return { kind: 'ALREADY_ENABLED' } as const;
    const secret = randomBytes(20);
    const recoveryCodes = generateRecoveryCodes();
    await db.query('update iam.app_user set totp_secret_ct = $2 where id = $1', [
      userId,
      encryptMfaSecret(deps.mfaKey, deps.mfaKeyId, userId, secret),
    ]);
    await db.query('delete from iam.mfa_recovery_code where user_id = $1', [userId]);
    for (const code of recoveryCodes) {
      await db.query('insert into iam.mfa_recovery_code (user_id, code_hash) values ($1, $2)', [
        userId,
        sha256(code),
      ]);
    }
    return {
      kind: 'PENDING',
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(rows[0].email, secret),
      recoveryCodes,
    } as const;
  });
}

/** 06 §6.3 step 2: the first valid code enables MFA. */
export async function confirmMfaEnrolment(
  db: Db,
  userId: string,
  code: string,
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<boolean> {
  const nowMs = (deps.now ?? Date.now)();
  return tx(db, async () => {
    const { rows } = await db.query<{ totp_secret_ct: Buffer | null; totp_enrolled_at: Date | null }>(
      'select totp_secret_ct, totp_enrolled_at from iam.app_user where id = $1 for update',
      [userId],
    );
    const row = rows[0];
    if (!row?.totp_secret_ct || row.totp_enrolled_at) return false;
    const counter = verifyTotp(decryptMfaSecret(deps.mfaKey, userId, row.totp_secret_ct), code, nowMs, null);
    if (counter === null) return false;
    await db.query('update iam.app_user set totp_enrolled_at = $2, last_totp_counter = $3 where id = $1', [
      userId,
      new Date(nowMs),
      counter,
    ]);
    await recordAudit(db, {
      action: 'user.mfa_enabled',
      entityType: 'user',
      entityId: userId,
      actorType: 'USER',
      actorUserId: userId,
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, {
      userId,
      eventType: 'MFA_ENABLED',
      severity: 'INFO',
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return true;
  });
}

// ------------------------------------------------------------------ one-time tokens and passwords

export type OneTimePurpose = keyof typeof TOKEN_TTL_MINUTES;

/** Issues a single-use token, invalidating any earlier unused token of the same purpose (06 §4.2, §4.5). */
export async function createOneTimeToken(
  db: Db,
  userId: string,
  purpose: OneTimePurpose,
  deps: Pick<IdentityDeps, 'now'>,
): Promise<string> {
  const nowMs = (deps.now ?? Date.now)();
  const token = randomToken();
  await db.query(
    'update iam.one_time_token set consumed_at = $3 where user_id = $1 and purpose = $2 and consumed_at is null',
    [userId, purpose, new Date(nowMs)],
  );
  await db.query(
    'insert into iam.one_time_token (user_id, purpose, token_hash, expires_at, created_at) values ($1, $2, $3, $4, $5)',
    [userId, purpose, sha256(token), new Date(nowMs + TOKEN_TTL_MINUTES[purpose] * 60_000), new Date(nowMs)],
  );
  return token;
}

export type ResetResult =
  | { kind: 'INVALID_TOKEN' }
  | { kind: 'MFA_REQUIRED' }
  | { kind: 'POLICY'; violations: PasswordViolation[] }
  | { kind: 'REUSED' }
  | { kind: 'SUCCESS'; userId: string };

/**
 * 06 §4.2, §4.5: consumes a reset or invitation token, applies the policy and history, revokes every session,
 * and activates an invited account. An enrolled account must also present a TOTP code.
 */
export async function resetPassword(
  db: Db,
  input: { token: string; newPassword: string; totpCode?: string },
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<ResetResult> {
  const nowMs = (deps.now ?? Date.now)();
  return tx(db, async () => {
    const { rows } = await db.query<{ id: string; user_id: string; purpose: string }>(
      `select id::text, user_id::text, purpose from iam.one_time_token
        where token_hash = $1 and purpose in ('PASSWORD_RESET', 'EMAIL_VERIFICATION')
          and consumed_at is null and expires_at > $2 for update`,
      [sha256(input.token), new Date(nowMs)],
    );
    const token = rows[0];
    if (!token) return { kind: 'INVALID_TOKEN' } as const;
    const user = (
      await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where id = $1 for update`, [
        token.user_id,
      ])
    ).rows[0]!;
    if (user.totp_enrolled_at && user.totp_secret_ct) {
      const secret = decryptMfaSecret(deps.mfaKey, user.id, user.totp_secret_ct);
      const counter = input.totpCode
        ? verifyTotp(
            secret,
            input.totpCode,
            nowMs,
            user.last_totp_counter === null ? null : Number(user.last_totp_counter),
          )
        : null;
      if (counter === null) return { kind: 'MFA_REQUIRED' } as const;
      await db.query('update iam.app_user set last_totp_counter = $2 where id = $1', [user.id, counter]);
    }
    const violations = checkPasswordPolicy(input.newPassword, {
      email: user.email,
      displayName: user.display_name,
      blocklist: deps.blocklist,
    });
    if (violations.length > 0) return { kind: 'POLICY', violations } as const;
    const history = await db.query<{ password_hash: string }>(
      'select password_hash from iam.password_history where user_id = $1 order by created_at desc limit 5',
      [user.id],
    );
    for (const old of [user.password_hash, ...history.rows.map((r) => r.password_hash)]) {
      if (await verifyPassword(old, input.newPassword)) return { kind: 'REUSED' } as const;
    }
    await db.query('insert into iam.password_history (user_id, password_hash) values ($1, $2)', [
      user.id,
      user.password_hash,
    ]);
    await db.query(
      `delete from iam.password_history where user_id = $1 and id not in
         (select id from iam.password_history where user_id = $1 order by created_at desc limit 5)`,
      [user.id],
    );
    await db.query(
      `update iam.app_user set password_hash = $2, password_changed_at = $3, failed_login_count = 0, locked_until = null,
              status = case when status in ('PENDING_VERIFICATION', 'LOCKED') then 'ACTIVE' else status end
        where id = $1`,
      [user.id, await hashPassword(input.newPassword), new Date(nowMs)],
    );
    await db.query('update iam.one_time_token set consumed_at = $2 where id = $1', [
      token.id,
      new Date(nowMs),
    ]);
    await revokeUserSessions(db, user.id, 'PASSWORD_RESET', deps);
    await recordAudit(db, {
      action: 'user.password_reset',
      entityType: 'user',
      entityId: user.id,
      actorType: 'USER',
      actorUserId: user.id,
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, {
      userId: user.id,
      eventType: 'PASSWORD_CHANGED',
      severity: 'INFO',
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return { kind: 'SUCCESS', userId: user.id } as const;
  });
}

// ---------------------------------------------------------------------------------------- API keys

export type IssueApiKeyResult =
  | { kind: 'SCOPE_INVALID'; scopes: string[] }
  | { kind: 'EXPIRY_INVALID' }
  | { kind: 'SUCCESS'; id: string; key: string; prefix: string; expiresAt: Date };

async function ingestPermissions(db: Db): Promise<Set<string>> {
  const { rows } = await db.query<{ code: string }>(
    `select p.code from iam.role r join iam.role_permission rp on rp.role_id = r.id
       join iam.permission p on p.id = rp.permission_id where r.code = $1`,
    [INGEST_SERVICE_ROLE],
  );
  return new Set(rows.map((r) => r.code));
}

/** 06 §8.3, §8.5: scopes within the machine role, an expiry of at most a year, plaintext returned once. */
export async function issueApiKey(
  db: Db,
  input: { name: string; scopes: string[]; expiresAt?: Date; createdBy: string },
  client: ClientInfo,
  deps: Pick<IdentityDeps, 'now'>,
): Promise<IssueApiKeyResult> {
  const nowMs = (deps.now ?? Date.now)();
  const allowed = await ingestPermissions(db);
  const outside = input.scopes.filter((s) => !allowed.has(s));
  if (outside.length > 0 || input.scopes.length === 0)
    return { kind: 'SCOPE_INVALID', scopes: outside } as const;
  const yearMs = 365 * 86_400_000;
  const expiresAt = input.expiresAt ?? new Date(nowMs + yearMs);
  if (expiresAt.getTime() <= nowMs || expiresAt.getTime() > nowMs + yearMs)
    return { kind: 'EXPIRY_INVALID' } as const;
  const { key, prefix, hash } = generateApiKey();
  return tx(db, async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into iam.api_key (name, key_prefix, key_hash, scopes, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [input.name, prefix, hash, input.scopes, input.createdBy, expiresAt],
    );
    const id = rows[0]!.id;
    await recordAudit(db, {
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: id,
      actorType: 'USER',
      actorUserId: input.createdBy,
      after: { prefix, scopes: input.scopes, expiresAt },
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, {
      userId: input.createdBy,
      eventType: 'API_KEY_CREATED',
      severity: 'INFO',
      details: { prefix },
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return { kind: 'SUCCESS', id, key, prefix, expiresAt } as const;
  });
}

/** 06 §8.2–§8.4: lookup by hash; effective scopes never exceed the machine role. */
export async function authenticateApiKey(
  db: Db,
  key: string,
): Promise<{ keyId: string; scopes: string[] } | null> {
  const { rows } = await db.query<{ id: string; scopes: string[] }>(
    `select id::text, scopes from iam.api_key
      where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [sha256(key)],
  );
  const row = rows[0];
  if (!row) return null;
  await db.query(
    `update iam.api_key set last_used_at = now()
      where id = $1 and (last_used_at is null or last_used_at < now() - interval '60 seconds')`,
    [row.id],
  );
  const allowed = await ingestPermissions(db);
  return { keyId: row.id, scopes: row.scopes.filter((s) => allowed.has(s)) };
}

export async function revokeApiKey(
  db: Db,
  keyId: string,
  actorUserId: string,
  client: ClientInfo,
): Promise<boolean> {
  return tx(db, async () => {
    const { rows } = await db.query<{ prefix: string }>(
      'update iam.api_key set revoked_at = now() where id = $1 and revoked_at is null returning key_prefix as prefix',
      [keyId],
    );
    if (!rows[0]) return false;
    await recordAudit(db, {
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: keyId,
      actorType: 'USER',
      actorUserId,
      after: { prefix: rows[0].prefix },
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, {
      userId: actorUserId,
      eventType: 'API_KEY_REVOKED',
      severity: 'INFO',
      details: { prefix: rows[0].prefix },
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return true;
  });
}

// ------------------------------------------------------------------ password change, MFA removal

export type ChangePasswordResult =
  | { kind: 'INVALID_CREDENTIALS' }
  | { kind: 'POLICY'; violations: PasswordViolation[] }
  | { kind: 'REUSED' }
  | { kind: 'SUCCESS' };

/** 06 §4.5 change: verify, apply policy and history, then revoke every family except the caller's. */
export async function changePassword(
  db: Db,
  input: { userId: string; keepFamilyId: string | null; currentPassword: string; newPassword: string },
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<ChangePasswordResult> {
  const nowMs = (deps.now ?? Date.now)();
  return tx(db, async () => {
    const user = (
      await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where id = $1 for update`, [
        input.userId,
      ])
    ).rows[0];
    if (!user || !(await verifyPassword(user.password_hash, input.currentPassword))) {
      if (user)
        await db.query('update iam.app_user set failed_login_count = failed_login_count + 1 where id = $1', [
          user.id,
        ]);
      return { kind: 'INVALID_CREDENTIALS' } as const;
    }
    const violations = checkPasswordPolicy(input.newPassword, {
      email: user.email,
      displayName: user.display_name,
      blocklist: deps.blocklist,
    });
    if (violations.length > 0) return { kind: 'POLICY', violations } as const;
    const history = await db.query<{ password_hash: string }>(
      'select password_hash from iam.password_history where user_id = $1 order by created_at desc limit 5',
      [user.id],
    );
    for (const old of [user.password_hash, ...history.rows.map((r) => r.password_hash)]) {
      if (await verifyPassword(old, input.newPassword)) return { kind: 'REUSED' } as const;
    }
    await db.query('insert into iam.password_history (user_id, password_hash) values ($1, $2)', [
      user.id,
      user.password_hash,
    ]);
    await db.query(
      `delete from iam.password_history where user_id = $1 and id not in
         (select id from iam.password_history where user_id = $1 order by created_at desc limit 5)`,
      [user.id],
    );
    await db.query('update iam.app_user set password_hash = $2, password_changed_at = $3 where id = $1', [
      user.id,
      await hashPassword(input.newPassword),
      new Date(nowMs),
    ]);
    await revokeUserSessions(db, user.id, 'PASSWORD_CHANGED', deps, input.keepFamilyId ?? undefined);
    await recordAudit(db, {
      action: 'user.password_changed',
      entityType: 'user',
      entityId: user.id,
      actorType: 'USER',
      actorUserId: user.id,
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, {
      userId: user.id,
      eventType: 'PASSWORD_CHANGED',
      severity: 'INFO',
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return { kind: 'SUCCESS' } as const;
  });
}

export type DisableMfaResult =
  { kind: 'INVALID_CREDENTIALS' } | { kind: 'INVALID_CODE' } | { kind: 'MANDATORY' } | { kind: 'SUCCESS' };

/** 06 §6.3: removing MFA needs both the password and a current code; administrators cannot remove it (§6.5). */
export async function disableMfa(
  db: Db,
  input: { userId: string; password: string; code: string },
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<DisableMfaResult> {
  const nowMs = (deps.now ?? Date.now)();
  return tx(db, async () => {
    const user = (
      await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where id = $1 for update`, [
        input.userId,
      ])
    ).rows[0];
    if (!user || !(await verifyPassword(user.password_hash, input.password)))
      return { kind: 'INVALID_CREDENTIALS' } as const;
    if (!user.totp_enrolled_at || !user.totp_secret_ct) return { kind: 'INVALID_CODE' } as const;
    const counter = verifyTotp(
      decryptMfaSecret(deps.mfaKey, user.id, user.totp_secret_ct),
      input.code,
      nowMs,
      user.last_totp_counter === null ? null : Number(user.last_totp_counter),
    );
    if (counter === null) return { kind: 'INVALID_CODE' } as const;
    const { roles } = await rolesAndPerms(db, user.id);
    if (user.mfa_required || roles.includes('ADMIN')) return { kind: 'MANDATORY' } as const;
    await db.query(
      'update iam.app_user set totp_secret_ct = null, totp_enrolled_at = null, last_totp_counter = null where id = $1',
      [user.id],
    );
    await db.query('delete from iam.mfa_recovery_code where user_id = $1', [user.id]);
    await recordAudit(db, {
      action: 'user.mfa_disabled',
      entityType: 'user',
      entityId: user.id,
      actorType: 'USER',
      actorUserId: user.id,
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, {
      userId: user.id,
      eventType: 'MFA_DISABLED',
      severity: 'WARN',
      clientIp: client.ip,
      userAgent: client.userAgent,
      correlationId: client.correlationId,
    });
    return { kind: 'SUCCESS' } as const;
  });
}

// ------------------------------------------------------------ enrolment by login challenge (06 §6.5)

/**
 * The user behind an unexpired, unconsumed login challenge from the same client, provided that user has not
 * enrolled MFA. Locks the challenge row; call inside a transaction.
 */
async function enrolmentChallengeUser(
  db: Db,
  challengeId: string,
  client: ClientInfo,
  nowMs: number,
): Promise<string | null> {
  const { rows } = await db.query<{
    user_id: string;
    ip_hash: Buffer;
    ua_hash: Buffer;
    expires_at: Date;
    consumed_at: Date | null;
    attempts: number;
    enrolled: boolean;
  }>(
    `select c.user_id::text, c.ip_hash, c.ua_hash, c.expires_at, c.consumed_at, c.attempts,
            u.totp_enrolled_at is not null as enrolled
       from iam.mfa_challenge c join iam.app_user u on u.id = c.user_id
      where c.id = $1 for update of c`,
    [challengeId],
  );
  const ch = rows[0];
  if (!ch || ch.enrolled || ch.consumed_at || ch.expires_at.getTime() <= nowMs || ch.attempts >= 5)
    return null;
  if (!ch.ip_hash.equals(sha256(client.ip)) || !ch.ua_hash.equals(sha256(client.userAgent))) return null;
  return ch.user_id;
}

/** 06 §6.3 step 1 for a user who has no session yet; the challenge is the credential. */
export async function beginEnrolmentByChallenge(
  db: Db,
  challengeId: string,
  client: ClientInfo,
  deps: IdentityDeps,
) {
  const nowMs = (deps.now ?? Date.now)();
  const userId = await tx(db, () => enrolmentChallengeUser(db, challengeId, client, nowMs));
  if (!userId) return { kind: 'INVALID' } as const;
  return beginMfaEnrolment(db, userId, deps);
}

/** 06 §6.3 step 2 by challenge: enables MFA, consumes the challenge and issues the session in one transaction. */
export async function confirmEnrolmentByChallenge(
  db: Db,
  input: { challengeId: string; code: string },
  client: ClientInfo,
  deps: IdentityDeps,
): Promise<MfaVerifyResult> {
  const nowMs = (deps.now ?? Date.now)();
  const security = { clientIp: client.ip, userAgent: client.userAgent, correlationId: client.correlationId };
  return tx(db, async () => {
    const userId = await enrolmentChallengeUser(db, input.challengeId, client, nowMs);
    if (!userId) return { kind: 'INVALID' } as const;
    const user = (
      await db.query<UserRow>(`select ${USER_COLUMNS} from iam.app_user where id = $1 for update`, [userId])
    ).rows[0]!;
    const counter = user.totp_secret_ct
      ? verifyTotp(decryptMfaSecret(deps.mfaKey, userId, user.totp_secret_ct), input.code, nowMs, null)
      : null;
    if (counter === null) {
      await db.query('update iam.mfa_challenge set attempts = attempts + 1 where id = $1', [
        input.challengeId,
      ]);
      await recordSecurityEvent(db, { ...security, userId, eventType: 'MFA_FAILURE', severity: 'WARN' });
      return { kind: 'INVALID' } as const;
    }
    await db.query('update iam.app_user set totp_enrolled_at = $2, last_totp_counter = $3 where id = $1', [
      userId,
      new Date(nowMs),
      counter,
    ]);
    await db.query('update iam.mfa_challenge set consumed_at = $2 where id = $1', [
      input.challengeId,
      new Date(nowMs),
    ]);
    await recordAudit(db, {
      action: 'user.mfa_enabled',
      entityType: 'user',
      entityId: userId,
      actorType: 'USER',
      actorUserId: userId,
      correlationId: client.correlationId,
    });
    await recordSecurityEvent(db, { ...security, userId, eventType: 'MFA_ENABLED', severity: 'INFO' });
    const session = await issueSession(db, user, client, deps);
    await recordSecurityEvent(db, { ...security, userId, eventType: 'LOGIN_SUCCESS', severity: 'INFO' });
    return { kind: 'SUCCESS', session } as const;
  });
}
