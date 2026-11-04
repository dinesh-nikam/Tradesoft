// Routes of 05 §11.1–§11.3 and §11.10 implemented in Phase 3 slice 3a. Every route declares its access.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  beginEnrolmentByChallenge,
  beginMfaEnrolment,
  confirmEnrolmentByChallenge,
  cancelJob,
  confirmMfaEnrolment,
  createOneTimeToken,
  enqueue,
  issueApiKey,
  login,
  recordAudit,
  refreshSession,
  resetPassword,
  retryDeadLetter,
  revokeApiKey,
  revokeFamily,
  sha256,
  verifyAuditChain,
  verifyMfaChallenge,
  type IssuedSession,
} from '@tradesoft/db';
import {
  ApiError,
  applyLimit,
  authenticate,
  clearSessionCookies,
  clientInfo,
  cookies,
  hitShared,
  requireCsrf,
  setSessionCookies,
  withClient,
  type ApiDeps,
} from './platform.ts';

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(254);

function sessionBody(reply: FastifyReply, s: IssuedSession) {
  setSessionCookies(reply, s.refreshToken);
  return { accessToken: s.accessToken, tokenType: 'Bearer', expiresIn: s.expiresIn, user: s.user };
}

/** 06 §4.5: mail is sent by the worker, never on the request path. */
async function enqueueMail(
  db: Parameters<typeof enqueue>[0],
  template: string,
  to: string,
  variables: Record<string, string>,
  correlationId: string,
) {
  await enqueue(db, {
    type: 'ops.send_email',
    payload: { template, to, variables },
    payloadVersion: 1,
    queue: 'default',
    maxAttempts: 5,
    idempotencyKey: `mail:${template}:${createHash('sha256')
      .update(to + JSON.stringify(variables))
      .digest('hex')}`,
    correlationId,
  });
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool, identity } = deps;
  const auth = '/api/v1/auth';

  // ------------------------------------------------------------------------------- operational (05 §11.1)
  app.get('/healthz', { config: { public: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { config: { public: true } }, async (_req, reply) => {
    const ready = await (deps.isReady?.() ??
      withClient(pool, async (c) => (await c.query('select 1')).rowCount === 1));
    if (!ready) throw new ApiError('SERVICE_UNAVAILABLE', 'Not ready');
    return reply.send({ status: 'ready' });
  });

  // ---------------------------------------------------------------------------------- auth (05 §11.2)
  app.post(`${auth}/login`, { config: { public: true } }, async (req, reply) => {
    const body = z
      .object({ email, password: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body);
    const result = await withClient(pool, async (c) => {
      applyLimit(reply, await hitShared(c, 'auth.login.ip', req.ip, 30, 900), 900);
      applyLimit(
        reply,
        await hitShared(c, 'auth.login', `${req.ip}:${sha256(body.email).toString('hex')}`, 5, 900),
        900,
      );
      return login(c, body, clientInfo(req), identity);
    });
    switch (result.kind) {
      case 'SUCCESS':
        return sessionBody(reply, result.session);
      case 'MFA_REQUIRED':
        return reply.code(202).send({
          challengeId: result.challengeId,
          methods: ['TOTP'],
          expiresAt: result.expiresAt.toISOString(),
        });
      case 'MFA_ENROLMENT_REQUIRED':
        return reply.code(202).send({
          enrolmentRequired: true,
          challengeId: result.challengeId,
          enrollUrl: `${auth}/mfa/enroll`,
        });
      case 'LOCKED':
        throw new ApiError('AUTH_ACCOUNT_LOCKED', `Locked until ${result.until.toISOString()}`);
      case 'SUSPENDED':
        throw new ApiError('AUTH_ACCOUNT_SUSPENDED', 'The account is suspended');
      case 'PENDING':
        throw new ApiError('AUTH_ACCOUNT_PENDING', 'The email address is not yet verified');
      default:
        throw new ApiError('AUTH_INVALID_CREDENTIALS', 'The email or password is incorrect');
    }
  });

  app.post(`${auth}/mfa/verify`, { config: { public: true } }, async (req, reply) => {
    const body = z
      .object({ challengeId: uuid, code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    const result = await withClient(pool, (c) => verifyMfaChallenge(c, body, clientInfo(req), identity));
    if (result.kind !== 'SUCCESS')
      throw new ApiError('AUTH_MFA_INVALID', 'The code or challenge was not accepted');
    return sessionBody(reply, result.session);
  });

  app.post(`${auth}/refresh`, { config: { public: true } }, async (req, reply) => {
    const token = cookies(req).get('ts_rt');
    if (!token) throw new ApiError('AUTH_REFRESH_MISSING', 'No refresh cookie');
    requireCsrf(req);
    const result = await withClient(pool, (c) => refreshSession(c, token, clientInfo(req), identity));
    if (result.kind === 'SUCCESS') return sessionBody(reply, result.session);
    clearSessionCookies(reply);
    throw new ApiError(
      result.kind === 'REUSED' ? 'AUTH_REFRESH_REUSED' : 'AUTH_SESSION_REVOKED',
      'The session has ended',
    );
  });

  app.post(`${auth}/logout`, { config: { public: true } }, async (req, reply) => {
    const token = cookies(req).get('ts_rt');
    if (!token) throw new ApiError('AUTH_REFRESH_MISSING', 'No refresh cookie');
    requireCsrf(req);
    await withClient(pool, async (c) => {
      const { rows } = await c.query<{ family_id: string }>(
        'select family_id::text from iam.auth_session where refresh_token_hash = $1',
        [sha256(token)],
      );
      if (rows[0]) await revokeFamily(c, rows[0].family_id, 'LOGOUT', identity);
    });
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.get(`${auth}/me`, { config: { authenticated: true } }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') throw new ApiError('AUTHZ_FORBIDDEN', 'Only a user session has a profile');
    const { rows } = await pool.query<{
      id: string;
      email: string;
      display_name: string;
      status: string;
      mfa: boolean;
    }>(
      'select id::text, email::text, display_name, status, totp_enrolled_at is not null as mfa from iam.app_user where id = $1',
      [p.userId],
    );
    const u = rows[0];
    if (!u) throw new ApiError('RESOURCE_NOT_FOUND', 'No such user');
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      status: u.status,
      mfaEnabled: u.mfa,
      sessionId: p.sessionId,
      permissions: [...p.perms].sort(),
    };
  });

  app.post(`${auth}/password/forgot`, { config: { public: true } }, async (req, reply) => {
    const body = z.object({ email }).strict().parse(req.body);
    await withClient(pool, async (c) => {
      const limit = await hitShared(c, 'auth.reset', sha256(body.email).toString('hex'), 3, 3600);
      if (!limit.allowed) return; // 05 §9.1: excess requests are dropped silently.
      const { rows } = await c.query<{ id: string }>(
        "select id::text from iam.app_user where email = $1 and status = 'ACTIVE'",
        [body.email],
      );
      if (!rows[0]) return;
      const token = await createOneTimeToken(c, rows[0].id, 'PASSWORD_RESET', identity);
      await enqueueMail(c, 'password-reset', body.email, { token }, req.correlationId);
    });
    return reply.code(202).send();
  });

  app.post(`${auth}/password/reset`, { config: { public: true } }, async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(20).max(128),
        newPassword: z.string().min(1).max(1024),
        totpCode: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const input = {
      token: body.token,
      newPassword: body.newPassword,
      ...(body.totpCode ? { totpCode: body.totpCode } : {}),
    };
    const result = await withClient(pool, (c) => resetPassword(c, input, clientInfo(req), identity));
    switch (result.kind) {
      case 'SUCCESS':
        return reply.code(204).send();
      case 'MFA_REQUIRED':
        throw new ApiError('AUTH_MFA_REQUIRED', 'A current TOTP code is required');
      case 'REUSED':
        throw new ApiError('AUTH_PASSWORD_REUSED', 'Choose a password you have not used recently');
      case 'POLICY':
        throw new ApiError('AUTH_PASSWORD_POLICY', 'The password does not meet the policy', {
          errors: result.violations.map((v) => ({
            path: '/newPassword',
            code: 'AUTH_PASSWORD_POLICY' as const,
            message: v.message,
          })),
        });
      default:
        throw new ApiError('AUTH_TOKEN_INVALID', 'The link has expired or was already used');
    }
  });

  // 06 §6.5: an administrator without MFA has no session, so the login challenge (bound to this client) is the
  // credential for enrolment. With an Authorization header, a session holding auth:self:manage is required.
  const enrolmentUser = async (req: FastifyRequest): Promise<string | null> => {
    if (!req.headers.authorization && !req.headers['x-api-key']) return null;
    const p = await authenticate(req, deps);
    if (p.kind !== 'user' || !p.perms.has('auth:self:manage'))
      throw new ApiError('AUTHZ_FORBIDDEN', 'auth:self:manage is required');
    return p.userId;
  };

  app.post(`${auth}/mfa/enroll`, { config: { public: true } }, async (req) => {
    const body = z
      .object({ challengeId: uuid.optional() })
      .strict()
      .parse(req.body ?? {});
    const userId = await enrolmentUser(req);
    if (!userId && !body.challengeId)
      throw new ApiError('AUTH_TOKEN_MISSING', 'Send a session token or the login challenge id');
    const result = await withClient(pool, (c) =>
      userId
        ? beginMfaEnrolment(c, userId, identity)
        : beginEnrolmentByChallenge(c, body.challengeId!, clientInfo(req), identity),
    );
    if (result.kind === 'INVALID') throw new ApiError('AUTH_MFA_INVALID', 'The challenge was not accepted');
    if (result.kind !== 'PENDING') throw new ApiError('AUTH_MFA_ALREADY_ENABLED', 'MFA is already enabled');
    return { secret: result.secret, otpauthUri: result.otpauthUri, recoveryCodes: result.recoveryCodes };
  });

  app.post(`${auth}/mfa/confirm`, { config: { public: true } }, async (req, reply) => {
    const body = z
      .object({ code: z.string().regex(/^\d{6}$/), challengeId: uuid.optional() })
      .strict()
      .parse(req.body);
    const userId = await enrolmentUser(req);
    if (userId) {
      const ok = await withClient(pool, (c) =>
        confirmMfaEnrolment(c, userId, body.code, clientInfo(req), identity),
      );
      if (!ok) throw new ApiError('AUTH_MFA_INVALID', 'The code was not accepted');
      return reply.code(204).send();
    }
    if (!body.challengeId)
      throw new ApiError('AUTH_TOKEN_MISSING', 'Send a session token or the login challenge id');
    const result = await withClient(pool, (c) =>
      confirmEnrolmentByChallenge(
        c,
        { challengeId: body.challengeId!, code: body.code },
        clientInfo(req),
        identity,
      ),
    );
    if (result.kind !== 'SUCCESS')
      throw new ApiError('AUTH_MFA_INVALID', 'The code or challenge was not accepted');
    return sessionBody(reply, result.session);
  });

  // --------------------------------------------------------------- users, roles, API keys (05 §11.3)
  app.get('/api/v1/users', { config: { permission: 'user:read' } }, async () => {
    // shortcut: one page of up to 200 users (00 A3 assumes 50); signed cursors arrive with CURSOR_SECRET wiring.
    const { rows } = await pool.query(
      `select id::text as id, email::text as email, display_name as "displayName", status,
              totp_enrolled_at is not null as "mfaEnabled", last_login_at as "lastLoginAt"
         from iam.app_user order by email, id limit 200`,
    );
    return { data: rows, page: { limit: 200, hasMore: false, nextCursor: null } };
  });

  app.post('/api/v1/users', { config: { permission: 'user:write' } }, async (req, reply) => {
    const body = z
      .object({ email, displayName: z.string().trim().min(1).max(120) })
      .strict()
      .parse(req.body);
    const p = req.principal!;
    const id = await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        // 06 §4.2: a random value that is not a PHC string, so no password can ever match it.
        const unusable = `!${randomBytes(32).toString('base64url')}`;
        const { rows } = await c.query<{ id: string }>(
          `insert into iam.app_user (email, password_hash, display_name) values ($1, $2, $3)
           on conflict (email) do nothing returning id::text`,
          [body.email, unusable, body.displayName],
        );
        if (!rows[0]) throw new ApiError('AUTH_EMAIL_TAKEN', 'A user with this email exists');
        const token = await createOneTimeToken(c, rows[0].id, 'EMAIL_VERIFICATION', identity);
        await enqueueMail(c, 'invitation', body.email, { token }, req.correlationId);
        await recordAudit(c, {
          action: 'user.created',
          entityType: 'user',
          entityId: rows[0].id,
          actorType: 'USER',
          actorUserId: p.kind === 'user' ? p.userId : null,
          after: { email: body.email, displayName: body.displayName },
          correlationId: req.correlationId,
          requestId: req.id,
        });
        await c.query('commit');
        return rows[0].id;
      } catch (error) {
        await c.query('rollback');
        throw error;
      }
    });
    return reply
      .code(201)
      .header('location', `/api/v1/users/${id}`)
      .send({ id, email: body.email, displayName: body.displayName, status: 'PENDING_VERIFICATION' });
  });

  app.get('/api/v1/permissions', { config: { permission: 'role:read' } }, async () => {
    const { rows } = await pool.query('select code, description from iam.permission order by code');
    return { data: rows, page: { limit: rows.length, hasMore: false, nextCursor: null } };
  });

  app.get('/api/v1/roles', { config: { permission: 'role:read' } }, async () => {
    const { rows } = await pool.query(
      `select r.id::text as id, r.code, r.name, r.is_system as "isSystem", count(rp.permission_id)::integer as "permissionCount"
         from iam.role r left join iam.role_permission rp on rp.role_id = r.id group by r.id order by r.code`,
    );
    return { data: rows, page: { limit: rows.length, hasMore: false, nextCursor: null } };
  });

  app.get('/api/v1/api-keys', { config: { permission: 'apikey:manage' } }, async () => {
    const { rows } = await pool.query(
      `select id::text as id, name, key_prefix as prefix, scopes, created_at as "createdAt", expires_at as "expiresAt",
              last_used_at as "lastUsedAt", revoked_at as "revokedAt"
         from iam.api_key order by created_at desc, id desc limit 200`,
    );
    return { data: rows, page: { limit: 200, hasMore: false, nextCursor: null } };
  });

  app.post('/api/v1/api-keys', { config: { permission: 'apikey:manage' } }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.string()).min(1).max(20),
        expiresAt: z.iso.datetime().optional(),
      })
      .strict()
      .parse(req.body);
    const p = req.principal!;
    if (p.kind !== 'user') throw new ApiError('AUTHZ_FORBIDDEN', 'Only a user can issue keys');
    const result = await withClient(pool, (c) =>
      issueApiKey(
        c,
        {
          name: body.name,
          scopes: body.scopes,
          createdBy: p.userId,
          ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
        },
        clientInfo(req),
        identity,
      ),
    );
    if (result.kind === 'SCOPE_INVALID')
      throw new ApiError(
        'API_KEY_SCOPE_INVALID',
        `Scopes outside the machine role: ${result.scopes.join(', ') || '(none given)'}`,
      );
    if (result.kind === 'EXPIRY_INVALID') {
      throw new ApiError('VALIDATION_FAILED', 'expiresAt must be in the future and at most one year ahead', {
        errors: [{ path: '/expiresAt', code: 'VALIDATION_FAILED', message: 'At most one year ahead' }],
      });
    }
    return reply.code(201).send({
      id: result.id,
      key: result.key,
      prefix: result.prefix,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.delete('/api/v1/api-keys/:id', { config: { permission: 'apikey:manage' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const p = req.principal!;
    const ok = await withClient(pool, (c) =>
      revokeApiKey(c, id, p.kind === 'user' ? p.userId : '', clientInfo(req)),
    );
    if (!ok) throw new ApiError('API_KEY_NOT_FOUND', 'No such active key');
    return reply.code(204).send();
  });

  // --------------------------------------------------------------------------- admin (05 §11.10)
  app.get('/api/v1/admin/jobs', { config: { permission: 'job:read' } }, async (req) => {
    const { status } = z
      .object({ status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'DEAD_LETTER', 'CANCELLED']).optional() })
      .parse(req.query);
    const { rows } = await pool.query(
      `select id::text as id, job_type as "jobType", queue, status, attempts, max_attempts as "maxAttempts",
              created_at as "createdAt", completed_at as "completedAt"
         from ops.job where ($1::text is null or status = $1) order by created_at desc, id desc limit 200`,
      [status ?? null],
    );
    return { data: rows, page: { limit: 200, hasMore: false, nextCursor: null } };
  });

  const jobAction = (action: 'retry' | 'cancel', permission: string) =>
    app.post(`/api/v1/admin/jobs/:id/${action}`, { config: { permission } }, async (req, reply) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const p = req.principal!;
      await withClient(pool, async (c) => {
        await c.query('begin');
        try {
          const exists = await c.query('select 1 from ops.job where id = $1 for update', [id]);
          if (exists.rowCount === 0) throw new ApiError('JOB_NOT_FOUND', 'No such job');
          const ok = action === 'retry' ? await retryDeadLetter(c, id) : await cancelJob(c, id);
          if (!ok)
            throw new ApiError(
              'JOB_STATE_INVALID',
              `The job cannot be ${action === 'retry' ? 'retried' : 'cancelled'} in its current status`,
            );
          await recordAudit(c, {
            action: `job.${action === 'retry' ? 'retried' : 'cancelled'}`,
            entityType: 'job',
            entityId: id,
            actorType: 'USER',
            actorUserId: p.kind === 'user' ? p.userId : null,
            correlationId: req.correlationId,
            requestId: req.id,
          });
          await c.query('commit');
        } catch (error) {
          await c.query('rollback');
          throw error;
        }
      });
      return reply.code(204).send();
    });
  jobAction('retry', 'job:retry');
  jobAction('cancel', 'job:cancel');

  app.get('/api/v1/admin/audit-events/verify', { config: { permission: 'audit:read' } }, async (req) => {
    const q = z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    const from = q.from ? Date.parse(q.from) : undefined;
    const to = q.to ? Date.parse(q.to) : Date.now();
    if (from !== undefined && to - from > 90 * 86_400_000)
      throw new ApiError('AUDIT_RANGE_TOO_LARGE', 'The range exceeds 90 days');
    return withClient(pool, (c) =>
      verifyAuditChain(c, { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }),
    );
  });
}
