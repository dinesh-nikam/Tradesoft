// Cross-cutting HTTP behaviour: request identity, problem documents, security headers, authentication,
// authorization with boot-time enforcement (06 §7.2), and rate limiting (05 §9, ADR-016).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';
import { problem, type ErrorCode } from '@tradesoft/contracts';
import { DomainError } from '@tradesoft/domain';
import {
  authenticateApiKey,
  HashingUnavailableError,
  recordSecurityEvent,
  TokenError,
  verifyAccessToken,
  type IdentityDeps,
} from '@tradesoft/db';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** A permission code of 00 §4.1 that the caller must hold. */
    permission?: string;
    /** Any authenticated principal (05 §11.2 routes marked "—"). */
    authenticated?: boolean;
    /** No principal required. */
    public?: boolean;
  }
  interface FastifyRequest {
    principal: Principal | null;
    correlationId: string;
  }
  interface FastifyInstance {
    routeTable: RouteEntry[];
  }
}

export type Principal =
  | { kind: 'user'; userId: string; sessionId: string; perms: ReadonlySet<string> }
  | { kind: 'apiKey'; keyId: string; perms: ReadonlySet<string> };

export interface RouteEntry {
  method: string;
  url: string;
  permission?: string | undefined;
  authenticated?: boolean | undefined;
  public?: boolean | undefined;
}

export interface ApiDeps {
  pool: pg.Pool;
  identity: IdentityDeps;
  isReady?: () => Promise<boolean>;
  /** Root of the raw-import volume (06 §11.2); defaults to `data`. */
  importRoot?: string;
  /** Upload ceiling (07 §3.4 UPLOAD_MAX_BYTES); defaults to 200 MiB. */
  uploadMaxBytes?: number;
}

/** A failure the API reports as a catalogue problem (05 §5). */
export class ApiError extends Error {
  code: ErrorCode;
  errors: { path: string; code: ErrorCode; message: string }[] | undefined;
  headers: Record<string, string>;
  /** Problem extension members, such as `existingBatchId` (05 §12.11). */
  extensions: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    detail: string,
    extra: {
      errors?: ApiError['errors'];
      headers?: Record<string, string>;
      extensions?: Record<string, unknown>;
    } = {},
  ) {
    super(detail);
    this.name = 'ApiError';
    this.code = code;
    this.errors = extra.errors;
    this.headers = extra.headers ?? {};
    this.extensions = extra.extensions ?? {};
  }
}

export function uuidv7(): string {
  const b = randomBytes(16);
  let ts = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 05 §3.7: a well-formed X-Request-Id is kept; anything else is replaced, never rejected (D-05-19). */
export function requestId(header: unknown): string {
  return typeof header === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(header) ? header : uuidv7();
}

export async function withClient<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export const clientInfo = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'] ?? '',
  correlationId: req.correlationId,
});

export function sendProblem(req: FastifyRequest, reply: FastifyReply, error: ApiError): FastifyReply {
  const body = {
    ...error.extensions,
    ...problem(error.code, {
      detail: error.message,
      instance: req.url.split('?')[0]!,
      correlationId: req.id,
      ...(error.errors ? { errors: error.errors } : {}),
    }),
  };
  for (const [k, v] of Object.entries(error.headers)) reply.header(k, v);
  return reply
    .code(body.status)
    .type('application/problem+json')
    .header('cache-control', 'no-store')
    .send(body);
}

export function zodToApiError(error: ZodError): ApiError {
  return new ApiError('VALIDATION_FAILED', 'The request is not valid', {
    errors: error.issues.map((i) => ({
      path: `/${i.path.join('/')}`,
      code: 'VALIDATION_FAILED' as const,
      message: i.message,
    })),
  });
}

// 06 §9.3. The API serves JSON only, so its CSP forbids everything; the SPA's policy is set by the proxy.
const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

// ------------------------------------------------------------------------------------ rate limiting

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/** Fixed-window counter shared through ops.rate_limit_counter, for the auth buckets (05 §9.1). */
export async function hitShared(
  db: Pick<pg.ClientBase, 'query'>,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<LimitResult> {
  const { rows } = await db.query<{ hits: number; reset: number }>(
    `insert into ops.rate_limit_counter (bucket_key, window_start, hits)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2::double precision) * $2::double precision), 1)
     on conflict (bucket_key, window_start) do update set hits = ops.rate_limit_counter.hits + 1
     returning hits, ceil(extract(epoch from window_start + make_interval(secs => $2::double precision) - now()))::integer as reset`,
    [`${bucket}:${key}`, windowSeconds],
  );
  const hits = rows[0]!.hits;
  return {
    allowed: hits <= limit,
    limit,
    remaining: Math.max(0, limit - hits),
    resetSeconds: Math.max(1, rows[0]!.reset),
  };
}

/**
 * Per-process fixed windows for the read and write buckets (05 §9.1).
 * shortcut: per process only; with two api instances a principal gets twice the budget. Upgrade to the
 * in-process fast path backed by the shared table of ADR-016 when the deployment runs more than one api.
 */
export class MemoryLimiter {
  windows = new Map<string, { start: number; hits: number }>();

  hit(key: string, limit: number, windowSeconds: number, nowMs = Date.now()): LimitResult {
    const start = Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
    const w = this.windows.get(key);
    const current = w && w.start === start ? w : { start, hits: 0 };
    current.hits++;
    this.windows.set(key, current);
    if (this.windows.size > 100_000) this.windows.clear();
    const resetSeconds = Math.max(1, Math.ceil((start + windowSeconds * 1000 - nowMs) / 1000));
    return {
      allowed: current.hits <= limit,
      limit,
      remaining: Math.max(0, limit - current.hits),
      resetSeconds,
    };
  }
}

export function applyLimit(reply: FastifyReply, r: LimitResult, windowSeconds: number): void {
  reply.header('ratelimit-limit', String(r.limit));
  reply.header('ratelimit-remaining', String(r.remaining));
  reply.header('ratelimit-reset', String(r.resetSeconds));
  reply.header('ratelimit-policy', `${r.limit};w=${windowSeconds}`);
  if (!r.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many requests', {
      headers: { 'retry-after': String(r.resetSeconds) },
    });
  }
}

// ---------------------------------------------------------------------------------- cookies, CSRF

export function cookies(req: FastifyRequest): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** 06 §5.6: the refresh token is HttpOnly and scoped to /api/v1/auth; the CSRF token is readable. */
export function setSessionCookies(reply: FastifyReply, refreshToken: string): void {
  const csrf = randomBytes(32).toString('base64url');
  reply.header('set-cookie', [
    `ts_rt=${refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000`,
    `ts_csrf=${csrf}; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
  ]);
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.header('set-cookie', [
    'ts_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=0',
    'ts_csrf=; Secure; SameSite=Strict; Path=/; Max-Age=0',
  ]);
}

/** Double-submit check of 05 §10.2. */
export function requireCsrf(req: FastifyRequest): void {
  const header = req.headers['x-csrf-token'];
  const cookie = cookies(req).get('ts_csrf');
  const ok =
    typeof header === 'string' &&
    cookie !== undefined &&
    header.length === cookie.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(cookie));
  if (!ok) throw new ApiError('AUTH_CSRF_INVALID', 'Missing or mismatched X-CSRF-Token');
}

// ------------------------------------------------------------------------------------- the platform

export async function authenticate(req: FastifyRequest, deps: ApiDeps): Promise<Principal> {
  const auth = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const id = deps.identity;
    const nowMs = (id.now ?? Date.now)();
    try {
      const claims = verifyAccessToken(id.keyring, auth.slice(7), {
        issuer: id.issuer,
        audience: id.audience,
        nowSeconds: Math.floor(nowMs / 1000),
        isRevoked: (sid) => id.revocations?.has(sid, nowMs) ?? false,
      });
      return { kind: 'user', userId: claims.sub, sessionId: claims.sid, perms: new Set(claims.perms) };
    } catch (error) {
      if (error instanceof TokenError) throw new ApiError(error.code, 'The access token was not accepted');
      throw error;
    }
  }
  if (typeof apiKey === 'string') {
    const key = await withClient(deps.pool, (c) => authenticateApiKey(c, apiKey));
    if (!key) throw new ApiError('AUTH_TOKEN_INVALID', 'The API key was not accepted');
    return { kind: 'apiKey', keyId: key.keyId, perms: new Set(key.scopes) };
  }
  throw new ApiError('AUTH_TOKEN_MISSING', 'No Authorization header');
}

export function registerPlatform(app: FastifyInstance, deps: ApiDeps): void {
  const limiter = new MemoryLimiter();
  app.decorateRequest('principal', null);
  app.decorateRequest('correlationId', '');
  app.decorate('routeTable', [] as RouteEntry[]);

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      const c = route.config ?? {};
      app.routeTable.push({
        method,
        url: route.url,
        permission: c.permission,
        authenticated: c.authenticated,
        public: c.public,
      });
    }
  });

  // SEC-T-01, E3.2: a route that declares neither a permission, nor authentication, nor public access
  // stops the process before it accepts a request.
  app.addHook('onReady', async () => {
    const unprotected = app.routeTable.filter(
      (r) => !r.public && !r.authenticated && !(typeof r.permission === 'string' && r.permission.length > 0),
    );
    if (unprotected.length > 0) {
      throw new Error(
        `Routes without an access declaration (unprotected): ${unprotected.map((r) => `${r.method} ${r.url}`).join(', ')}`,
      );
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    req.correlationId = uuidv7();
    reply.header('x-request-id', req.id);
  });

  app.addHook('preHandler', async (req, reply) => {
    const c = req.routeOptions.config;
    if (c.public) return;
    req.principal = await authenticate(req, deps);
    if (c.permission && !req.principal.perms.has(c.permission)) {
      await withClient(deps.pool, (db) =>
        recordSecurityEvent(db, {
          eventType: 'PERMISSION_DENIED',
          severity: 'INFO',
          userId: req.principal?.kind === 'user' ? req.principal.userId : null,
          clientIp: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          details: { route: req.routeOptions.url, method: req.method, permission: c.permission },
          correlationId: req.correlationId,
        }),
      );
      throw new ApiError(
        req.principal.kind === 'apiKey' ? 'AUTHZ_SCOPE_INSUFFICIENT' : 'AUTHZ_FORBIDDEN',
        'The principal lacks the required permission',
      );
    }
    const principalKey = req.principal.kind === 'user' ? req.principal.userId : req.principal.keyId;
    const write = req.method !== 'GET';
    applyLimit(reply, limiter.hit(`${write ? 'write' : 'read'}:${principalKey}`, write ? 60 : 300, 60), 60);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (!reply.hasHeader('cache-control') || req.url.startsWith('/api/v1/auth'))
      reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setNotFoundHandler((req, reply) =>
    sendProblem(req, reply, new ApiError('RESOURCE_NOT_FOUND', 'No such resource')),
  );

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) return sendProblem(req, reply, error);
    if (error instanceof ZodError) return sendProblem(req, reply, zodToApiError(error));
    if (error instanceof DomainError) return sendProblem(req, reply, new ApiError(error.code, error.message));
    if (error instanceof HashingUnavailableError)
      return sendProblem(req, reply, new ApiError('SERVICE_UNAVAILABLE', 'Try again shortly'));
    const fastifyCode = (error as { code?: string }).code;
    if (fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
      return sendProblem(req, reply, new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported Content-Type'));
    if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return sendProblem(req, reply, new ApiError('PAYLOAD_TOO_LARGE', 'The body exceeds the limit'));
    if (fastifyCode?.startsWith('FST_ERR_CTP_'))
      return sendProblem(req, reply, new ApiError('VALIDATION_FAILED', 'The body is not valid JSON'));
    req.log.error({ err: error }, 'unhandled error');
    return sendProblem(req, reply, new ApiError('INTERNAL_ERROR', 'An unexpected error occurred'));
  });
}
