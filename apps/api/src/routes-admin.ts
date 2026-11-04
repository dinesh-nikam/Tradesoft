// Routes of 05 §11.2, §11.3 and §11.10 completed in Phase 3 slice 3b. Every route declares its access.
import { Cron } from 'croner';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { TIMEFRAMES } from '@tradesoft/contracts';
import { transition, userMachine, type UserEvent } from '@tradesoft/domain';
import {
  changePassword,
  createOneTimeToken,
  disableMfa,
  enqueue,
  recordAudit,
  revokeFamily,
  revokeUserSessions,
} from '@tradesoft/db';
import { ApiError, clientInfo, withClient, type ApiDeps } from './platform.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const page = (rows: unknown[]) => ({ data: rows, page: { limit: 200, hasMore: false, nextCursor: null } });

export async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(pool, async (c) => {
    await c.query('begin');
    try {
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (error) {
      await c.query('rollback');
      throw error;
    }
  });
}

export const actor = (req: FastifyRequest) => ({
  actorType: (req.principal?.kind === 'apiKey' ? 'API_KEY' : 'USER') as 'USER' | 'API_KEY',
  actorUserId: req.principal?.kind === 'user' ? req.principal.userId : null,
  correlationId: req.correlationId,
  requestId: req.id,
});

export const userOf = (req: FastifyRequest): string => {
  if (req.principal?.kind !== 'user')
    throw new ApiError('AUTHZ_FORBIDDEN', 'Only a user session can do this');
  return req.principal.userId;
};

/** 05 §5.2 audit queries: a bounded range, 7 days by default and 90 at most (D-05-17). */
function auditRange(q: { from?: string | undefined; to?: string | undefined }): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86_400_000);
  if (to.getTime() - from.getTime() > 90 * 86_400_000)
    throw new ApiError('AUDIT_RANGE_TOO_LARGE', 'The range exceeds 90 days');
  return { from, to };
}

export function registerAdminRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool, identity } = deps;

  app.get('/api/v1/meta', { config: { authenticated: true } }, async () => ({
    timeframes: TIMEFRAMES,
    renkoBrickPcts: ['0.1', '0.15', '0.25', '0.5', '1', '2', '3', '5'],
    rsWindows: [21, 63, 126, 252],
    build: { sha: process.env['BUILD_SHA'] ?? 'dev' },
  }));

  // ------------------------------------------------------------------------------- own account
  app.post(
    '/api/v1/auth/password/change',
    { config: { permission: 'auth:self:manage' } },
    async (req, reply) => {
      const body = z
        .object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) })
        .strict()
        .parse(req.body);
      const userId = userOf(req);
      const family = await pool.query<{ family_id: string }>(
        'select family_id::text from iam.auth_session where id = $1',
        [req.principal!.kind === 'user' ? req.principal!.sessionId : null],
      );
      const result = await withClient(pool, (c) =>
        changePassword(
          c,
          { userId, keepFamilyId: family.rows[0]?.family_id ?? null, ...body },
          clientInfo(req),
          identity,
        ),
      );
      if (result.kind === 'INVALID_CREDENTIALS')
        throw new ApiError('AUTH_INVALID_CREDENTIALS', 'The current password is incorrect');
      if (result.kind === 'REUSED')
        throw new ApiError('AUTH_PASSWORD_REUSED', 'Choose a password you have not used recently');
      if (result.kind === 'POLICY') {
        throw new ApiError('AUTH_PASSWORD_POLICY', 'The password does not meet the policy', {
          errors: result.violations.map((v) => ({
            path: '/newPassword',
            code: 'AUTH_PASSWORD_POLICY' as const,
            message: v.message,
          })),
        });
      }
      return reply.code(204).send();
    },
  );

  app.delete('/api/v1/auth/mfa', { config: { permission: 'auth:self:manage' } }, async (req, reply) => {
    const body = z
      .object({ password: z.string().min(1).max(1024), code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    const result = await withClient(pool, (c) =>
      disableMfa(c, { userId: userOf(req), ...body }, clientInfo(req), identity),
    );
    if (result.kind === 'INVALID_CREDENTIALS')
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'The password is incorrect');
    if (result.kind === 'INVALID_CODE') throw new ApiError('AUTH_MFA_INVALID', 'The code was not accepted');
    if (result.kind === 'MANDATORY')
      throw new ApiError('RESOURCE_CONFLICT', 'MFA is mandatory for this account (06 §6.5)');
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/sessions', { config: { permission: 'auth:self:manage' } }, async (req) => {
    const p = req.principal!;
    const { rows } = await pool.query(
      `select id::text as id, family_id::text as "familyId", issued_at as "issuedAt", last_used_at as "lastUsedAt",
              host(client_ip) as "clientIp", user_agent as "userAgent", id = $2 as current
         from iam.auth_session
        where user_id = $1 and revoked_at is null and used_at is null and expires_at > now()
        order by issued_at desc limit 200`,
      [userOf(req), p.kind === 'user' ? p.sessionId : null],
    );
    return page(rows);
  });

  app.delete('/api/v1/auth/sessions', { config: { permission: 'auth:self:manage' } }, async (req, reply) => {
    const userId = userOf(req);
    await withClient(pool, async (c) => {
      const current = await c.query<{ family_id: string }>(
        'select family_id::text from iam.auth_session where id = $1',
        [req.principal!.kind === 'user' ? req.principal!.sessionId : null],
      );
      await revokeUserSessions(c, userId, 'USER_REVOKED', identity, current.rows[0]?.family_id);
    });
    return reply.code(204).send();
  });

  app.delete(
    '/api/v1/auth/sessions/:sessionId',
    { config: { permission: 'auth:self:manage' } },
    async (req, reply) => {
      const { sessionId } = z.object({ sessionId: uuid }).parse(req.params);
      await withClient(pool, async (c) => {
        const { rows } = await c.query<{ family_id: string }>(
          'select family_id::text from iam.auth_session where id = $1 and user_id = $2',
          [sessionId, userOf(req)],
        );
        // 06 §7.4: another user's session is reported as absent, never as forbidden.
        if (!rows[0]) throw new ApiError('RESOURCE_NOT_FOUND', 'No such session');
        await revokeFamily(c, rows[0].family_id, 'USER_REVOKED', identity);
      });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------------------------- users
  const loadUser = async (c: pg.ClientBase, id: string) => {
    const { rows } = await c.query<{
      id: string;
      email: string;
      displayName: string;
      status: string;
      mfaEnabled: boolean;
      roles: string[];
    }>(
      `select u.id::text as id, u.email::text as email, u.display_name as "displayName", u.status,
              u.totp_enrolled_at is not null as "mfaEnabled",
              coalesce(array_agg(r.code order by r.code) filter (where r.code is not null), '{}') as roles
         from iam.app_user u left join iam.user_role ur on ur.user_id = u.id left join iam.role r on r.id = ur.role_id
        where u.id = $1 group by u.id`,
      [id],
    );
    if (!rows[0]) throw new ApiError('USER_NOT_FOUND', 'No such user');
    return rows[0];
  };

  app.get('/api/v1/users/:id', { config: { permission: 'user:read' } }, async (req) =>
    withClient(pool, (c) => loadUser(c, idParam.parse(req.params).id)),
  );

  app.patch('/api/v1/users/:id', { config: { permission: 'user:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(120).optional(),
        status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const before = await loadUser(c, id);
      if (body.status && body.status !== before.status) {
        const event: UserEvent =
          body.status === 'SUSPENDED' ? 'SUSPEND' : before.status === 'LOCKED' ? 'UNLOCK' : 'REINSTATE';
        transition(userMachine, before.status as Parameters<typeof transition>[1], event);
        await c.query(
          "update iam.app_user set status = $2, failed_login_count = case when $2 = 'ACTIVE' then 0 else failed_login_count end, locked_until = null where id = $1",
          [id, body.status],
        );
        if (body.status === 'SUSPENDED') await revokeUserSessions(c, id, 'SUSPENDED', identity);
      }
      if (body.displayName)
        await c.query('update iam.app_user set display_name = $2 where id = $1', [id, body.displayName]);
      const after = await loadUser(c, id);
      await recordAudit(c, {
        ...actor(req),
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  });

  app.post('/api/v1/users/:id/deactivate', { config: { permission: 'user:deactivate' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const before = await loadUser(c, id);
      transition(userMachine, before.status as Parameters<typeof transition>[1], 'DEACTIVATE');
      await c.query(
        "update iam.app_user set status = 'DEACTIVATED', deactivated_at = now(), deactivation_reason = $2 where id = $1",
        [id, reason],
      );
      await revokeUserSessions(c, id, 'DEACTIVATED', identity);
      const after = await loadUser(c, id);
      await recordAudit(c, {
        ...actor(req),
        action: 'user.deactivated',
        entityType: 'user',
        entityId: id,
        before,
        after,
        metadata: { reason },
      });
      return after;
    });
  });

  app.put('/api/v1/users/:id/roles', { config: { permission: 'user:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { roleCodes } = z
      .object({ roleCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).max(10) })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const before = await loadUser(c, id);
      if (before.status === 'DEACTIVATED')
        throw new ApiError('RESOURCE_CONFLICT', 'A deactivated user cannot hold roles (INV-13)');
      const invalid = (field: string, message: string) =>
        new ApiError('VALIDATION_FAILED', message, {
          errors: [{ path: field, code: 'VALIDATION_FAILED', message }],
        });
      // 00 §4.2: INGEST_SERVICE belongs to API keys only; 06 §6.5: ADMIN requires MFA first.
      if (roleCodes.includes('INGEST_SERVICE'))
        throw invalid('/roleCodes', 'INGEST_SERVICE is assigned to API keys, never to a person');
      if (roleCodes.includes('ADMIN') && !before.mfaEnabled)
        throw invalid('/roleCodes', 'ADMIN requires MFA to be enabled first');
      const { rows } = await c.query<{ id: string; code: string }>(
        'select id::text, code from iam.role where code = any($1)',
        [roleCodes],
      );
      const unknown = roleCodes.filter((code) => !rows.some((r) => r.code === code));
      if (unknown.length > 0) throw invalid('/roleCodes', `Unknown roles: ${unknown.join(', ')}`);
      await c.query('delete from iam.user_role where user_id = $1', [id]);
      for (const r of rows)
        await c.query('insert into iam.user_role (user_id, role_id, granted_by) values ($1, $2, $3)', [
          id,
          r.id,
          actor(req).actorUserId,
        ]);
      const after = await loadUser(c, id);
      await recordAudit(c, {
        ...actor(req),
        action: 'user.roles_changed',
        entityType: 'user',
        entityId: id,
        before: { roles: before.roles },
        after: { roles: after.roles },
      });
      return after;
    });
  });

  app.post(
    '/api/v1/users/:id/password-reset',
    { config: { permission: 'user:write' } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      await inTx(pool, async (c) => {
        const user = await loadUser(c, id);
        if (user.status !== 'ACTIVE')
          throw new ApiError('RESOURCE_CONFLICT', 'Only an active user can be sent a reset link');
        const token = await createOneTimeToken(c, id, 'PASSWORD_RESET', identity);
        await enqueue(c, {
          type: 'ops.send_email',
          payload: { template: 'password-reset', to: user.email, variables: { token } },
          payloadVersion: 1,
          queue: 'default',
          maxAttempts: 5,
          idempotencyKey: null,
          correlationId: req.correlationId,
        });
        await recordAudit(c, {
          ...actor(req),
          action: 'user.password_reset_requested',
          entityType: 'user',
          entityId: id,
        });
      });
      return reply.code(202).send();
    },
  );

  // ------------------------------------------------------------------------------------- roles
  const loadRole = async (c: pg.ClientBase, id: string) => {
    const { rows } = await c.query<{
      id: string;
      code: string;
      name: string;
      isSystem: boolean;
      permissions: string[];
    }>(
      `select r.id::text as id, r.code, r.name, r.is_system as "isSystem",
              coalesce(array_agg(p.code order by p.code) filter (where p.code is not null), '{}') as permissions
         from iam.role r left join iam.role_permission rp on rp.role_id = r.id left join iam.permission p on p.id = rp.permission_id
        where r.id = $1 group by r.id`,
      [id],
    );
    if (!rows[0]) throw new ApiError('ROLE_NOT_FOUND', 'No such role');
    return rows[0];
  };

  app.get('/api/v1/roles/:id', { config: { permission: 'role:read' } }, async (req) =>
    withClient(pool, (c) => loadRole(c, idParam.parse(req.params).id)),
  );

  app.put('/api/v1/roles/:id/permissions', { config: { permission: 'role:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { permissionCodes } = z
      .object({ permissionCodes: z.array(z.string().max(64)).max(100) })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const before = await loadRole(c, id);
      const { rows } = await c.query<{ id: string; code: string }>(
        'select id::text, code from iam.permission where code = any($1)',
        [permissionCodes],
      );
      const unknown = permissionCodes.filter((code) => !rows.some((r) => r.code === code));
      if (unknown.length > 0) {
        throw new ApiError('VALIDATION_FAILED', `Unknown permissions: ${unknown.join(', ')}`, {
          errors: [
            { path: '/permissionCodes', code: 'VALIDATION_FAILED', message: 'Unknown permission code' },
          ],
        });
      }
      await c.query('delete from iam.role_permission where role_id = $1', [id]);
      for (const p of rows)
        await c.query('insert into iam.role_permission (role_id, permission_id) values ($1, $2)', [id, p.id]);
      const after = await loadRole(c, id);
      await recordAudit(c, {
        ...actor(req),
        action: 'role.permissions_changed',
        entityType: 'role',
        entityId: id,
        before: { permissions: before.permissions },
        after: { permissions: after.permissions },
      });
      return after;
    });
  });

  // -------------------------------------------------------------------------------------- jobs
  app.get('/api/v1/admin/jobs/:id', { config: { permission: 'job:read' } }, async (req) => {
    const { rows } = await pool.query(
      `select id::text as id, job_type as "jobType", queue, status, payload, attempts, max_attempts as "maxAttempts",
              reclaimed_count as "reclaimedCount", run_after as "runAfter", last_error - 'stack' as "lastError",
              correlation_id::text as "correlationId", created_at as "createdAt", completed_at as "completedAt"
         from ops.job where id = $1`,
      [idParam.parse(req.params).id],
    );
    if (!rows[0]) throw new ApiError('JOB_NOT_FOUND', 'No such job');
    return rows[0];
  });

  app.get('/api/v1/admin/jobs/:id/attempts', { config: { permission: 'job:read' } }, async (req) => {
    const { rows } = await pool.query(
      `select attempt_no as "attemptNo", worker_id as "workerId", status, started_at as "startedAt", finished_at as "finishedAt",
              duration_ms as "durationMs", error - 'stack' as error
         from ops.job_attempt where job_id = $1 order by attempt_no`,
      [idParam.parse(req.params).id],
    );
    return page(rows);
  });

  app.get('/api/v1/admin/job-schedules', { config: { permission: 'job:read' } }, async () => {
    const { rows } = await pool.query(
      `select id::text as id, code, job_type as "jobType", cron, timezone, is_enabled as "isEnabled",
              next_run_at as "nextRunAt", last_enqueued_at as "lastEnqueuedAt" from ops.job_schedule order by code`,
    );
    return page(rows);
  });

  app.patch('/api/v1/admin/job-schedules/:id', { config: { permission: 'settings:write' } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        isEnabled: z.boolean().optional(),
        cron: z.string().min(9).max(100).optional(),
        timezone: z.string().min(1).max(64).optional(),
      })
      .strict()
      .parse(req.body);
    return inTx(pool, async (c) => {
      const { rows } = await c.query<{ cron: string; timezone: string; is_enabled: boolean }>(
        'select cron, timezone, is_enabled from ops.job_schedule where id = $1 for update',
        [id],
      );
      const before = rows[0];
      if (!before) throw new ApiError('JOB_SCHEDULE_NOT_FOUND', 'No such schedule');
      const cron = body.cron ?? before.cron;
      const timezone = body.timezone ?? before.timezone;
      try {
        new Cron(cron, { timezone, paused: true });
      } catch {
        throw new ApiError('VALIDATION_FAILED', 'The cron expression or time zone is not valid', {
          errors: [
            { path: body.cron ? '/cron' : '/timezone', code: 'VALIDATION_FAILED', message: 'Not valid' },
          ],
        });
      }
      // A changed expression restarts from its next window; the scheduler fills next_run_at (03 §6).
      const reset = cron !== before.cron || timezone !== before.timezone;
      await c.query(
        'update ops.job_schedule set cron = $2, timezone = $3, is_enabled = $4, next_run_at = case when $5 then null else next_run_at end where id = $1',
        [id, cron, timezone, body.isEnabled ?? before.is_enabled, reset],
      );
      const after = { cron, timezone, is_enabled: body.isEnabled ?? before.is_enabled };
      await recordAudit(c, {
        ...actor(req),
        action: 'job_schedule.updated',
        entityType: 'job_schedule',
        entityId: id,
        before,
        after,
      });
      return after;
    });
  });

  // ---------------------------------------------------------------------------------- settings
  const SETTING_SQL = `select key, value, description, updated_at as "updatedAt", md5(value::text || updated_at::text) as etag
                         from ops.system_setting`;

  app.get('/api/v1/admin/settings', { config: { permission: 'settings:read' } }, async () => {
    const { rows } = await pool.query(`${SETTING_SQL} order by key`);
    return page(rows.map((r) => ({ ...r, etag: `"${r.etag}"` })));
  });

  app.put('/api/v1/admin/settings/:key', { config: { permission: 'settings:write' } }, async (req, reply) => {
    const { key } = z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/) }).parse(req.params);
    const { value } = z.object({ value: z.unknown() }).strict().parse(req.body);
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string')
      throw new ApiError('PRECONDITION_REQUIRED', 'Send If-Match with the setting ETag (05 D-05-13)');
    return inTx(pool, async (c) => {
      const { rows } = await c.query<{ value: unknown; etag: string }>(
        `${SETTING_SQL} where key = $1 for update`,
        [key],
      );
      const current = rows[0];
      if (!current) throw new ApiError('SETTING_NOT_FOUND', 'No such setting');
      // Token lifetimes are fixed when the process starts; changing them at runtime would not take effect.
      if (key.startsWith('security.'))
        throw new ApiError('SETTING_READ_ONLY', 'Security settings are boot-time values');
      if (ifMatch !== `"${current.etag}"`)
        throw new ApiError('PRECONDITION_FAILED', 'The setting changed since it was read');
      const sameType =
        typeof value === typeof current.value &&
        Array.isArray(value) === Array.isArray(current.value) &&
        value !== null;
      if (!sameType || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new ApiError('SETTING_VALUE_INVALID', 'The value does not match the setting type');
      }
      const updated = await c.query<{ value: unknown; etag: string }>(
        `update ops.system_setting set value = $2::jsonb, updated_at = now(), updated_by = $3 where key = $1
         returning value, md5(value::text || updated_at::text) as etag`,
        [key, JSON.stringify(value), actor(req).actorUserId],
      );
      await recordAudit(c, {
        ...actor(req),
        action: 'setting.updated',
        entityType: 'system_setting',
        entityId: key,
        before: { value: current.value },
        after: { value },
      });
      reply.header('etag', `"${updated.rows[0]!.etag}"`);
      return { key, value: updated.rows[0]!.value };
    });
  });

  // ----------------------------------------------------------------------------- audit trails
  const rangeQuery = z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    action: z.string().max(100).optional(),
    entityType: z.string().max(100).optional(),
    entityId: z.string().max(200).optional(),
    eventType: z.string().max(100).optional(),
  });

  app.get('/api/v1/admin/audit-events', { config: { permission: 'audit:read' } }, async (req) => {
    const q = rangeQuery.parse(req.query);
    const { from, to } = auditRange(q);
    const { rows } = await pool.query(
      `select id::text as id, occurred_at as "occurredAt", actor_type as "actorType", actor_user_id::text as "actorUserId",
              action, entity_type as "entityType", entity_id as "entityId", before, after, metadata,
              correlation_id::text as "correlationId"
         from audit.audit_event
        where occurred_at >= $1 and occurred_at < $2 and ($3::text is null or action = $3)
          and ($4::text is null or entity_type = $4) and ($5::text is null or entity_id = $5)
        order by occurred_at desc, id desc limit 200`,
      [from, to, q.action ?? null, q.entityType ?? null, q.entityId ?? null],
    );
    return page(rows);
  });

  app.get('/api/v1/admin/security-events', { config: { permission: 'security:read' } }, async (req) => {
    const q = rangeQuery.parse(req.query);
    const { from, to } = auditRange(q);
    const { rows } = await pool.query(
      `select id::text as id, occurred_at as "occurredAt", event_type as "eventType", severity, user_id::text as "userId",
              host(client_ip) as "clientIp", details, correlation_id::text as "correlationId"
         from audit.security_event
        where occurred_at >= $1 and occurred_at < $2 and ($3::text is null or event_type = $3)
        order by occurred_at desc, id desc limit 200`,
      [from, to, q.eventType ?? null],
    );
    return page(rows);
  });
}
