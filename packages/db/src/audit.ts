import type { ClientBase } from 'pg';
import { redact } from '@tradesoft/observability';

type Queryable = Pick<ClientBase, 'query'>;

export interface AuditEvent {
  /** `entity.verb`, lowercase (ck_audit_action). */
  action: string;
  entityType: string;
  entityId: string;
  actorType: 'USER' | 'SYSTEM' | 'API_KEY';
  actorUserId?: string | null;
  actorIp?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  correlationId: string;
  requestId?: string | null;
}

/** Writes one business audit row; the trigger chains it (06 §14.2). Values are redacted first (07 §4.2). */
export async function recordAudit(db: Queryable, e: AuditEvent): Promise<string> {
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(redact(v)));
  const { rows } = await db.query<{ id: string }>(
    `insert into audit.audit_event (action, entity_type, entity_id, actor_type, actor_user_id, actor_ip,
                                    before, after, metadata, correlation_id, request_id)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, coalesce($9::jsonb, '{}'), $10, $11)
     returning id::text`,
    [
      e.action,
      e.entityType,
      e.entityId,
      e.actorType,
      e.actorUserId ?? null,
      e.actorIp ?? null,
      json(e.before),
      json(e.after),
      json(e.metadata),
      e.correlationId,
      e.requestId ?? null,
    ],
  );
  return rows[0]!.id;
}

export type SecurityEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGIN_LOCKED'
  | 'LOGOUT'
  | 'TOKEN_REFRESH'
  | 'TOKEN_REUSE_DETECTED'
  | 'SESSION_REVOKED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'MFA_FAILURE'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'API_KEY_CREATED'
  | 'API_KEY_REVOKED'
  | 'UPLOAD_REJECTED'
  | 'SUSPICIOUS_INPUT';

export interface SecurityEvent {
  eventType: SecurityEventType;
  severity: 'INFO' | 'WARN' | 'HIGH' | 'CRITICAL';
  userId?: string | null;
  emailAttempted?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
  correlationId: string;
}

export async function recordSecurityEvent(db: Queryable, e: SecurityEvent): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into audit.security_event (event_type, severity, user_id, email_attempted, client_ip, user_agent,
                                       details, correlation_id)
     values ($1, $2, (select id from iam.app_user where id = $3::uuid), $4, $5, $6, $7::jsonb, $8) returning id::text`,
    [
      e.eventType,
      e.severity,
      e.userId ?? null,
      e.emailAttempted ?? null,
      e.clientIp ?? null,
      e.userAgent ?? null,
      JSON.stringify(redact(e.details ?? {})),
      e.correlationId,
    ],
  );
  return rows[0]!.id;
}

export interface ChainVerification {
  checked: number;
  firstBreakId: string | null;
  firstBreakAt: string | null;
}

/**
 * Recomputes the chain over a time range in id order (06 §14.3). A row breaks the chain when its hash does
 * not match its content, or its prev_hash does not equal the hash of the row before it. The first row of the
 * range links to its predecessor outside the range, or to nothing when it is the chain's first row.
 */
export async function verifyAuditChain(
  db: Queryable,
  range: { from?: string; to?: string } = {},
): Promise<ChainVerification> {
  const { rows } = await db.query<{
    id: string;
    at: string;
    prev_hash: Buffer | null;
    hash: Buffer;
    content_ok: boolean;
  }>(
    `select e.id::text, e.occurred_at::text as at, e.prev_hash, e.hash,
            e.hash = audit.event_hash(e.prev_hash, e) as content_ok
       from audit.audit_event e
      where ($1::timestamptz is null or e.occurred_at >= $1) and ($2::timestamptz is null or e.occurred_at < $2)
      order by e.id`,
    [range.from ?? null, range.to ?? null],
  );
  let previous: Buffer | null = null;
  if (rows.length > 0) {
    const before = await db.query<{ hash: Buffer }>(
      'select hash from audit.audit_event where id < $1 order by id desc limit 1',
      [rows[0]!.id],
    );
    previous = before.rows[0]?.hash ?? null;
  }
  for (const row of rows) {
    const linked =
      previous === null ? row.prev_hash === null : row.prev_hash !== null && row.prev_hash.equals(previous);
    if (!row.content_ok || !linked)
      return { checked: rows.length, firstBreakId: row.id, firstBreakAt: row.at };
    previous = row.hash;
  }
  return { checked: rows.length, firstBreakId: null, firstBreakAt: null };
}
