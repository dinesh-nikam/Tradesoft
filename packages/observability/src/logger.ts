import { pino, type DestinationStream, type Level, type Logger } from 'pino';

export type { Logger };
export const CENSOR = '[REDACTED]';

// 06 §13.4, verbatim. Header paths are positional and need these entries.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'body.password',
  'body.currentPassword',
  'body.newPassword',
  'body.token',
  'body.code',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.refreshToken',
  '*.refresh_token',
  '*.secret',
  '*.mfaSecret',
  '*.mfa_secret',
  '*.recoveryCodes',
  '*.recovery_codes',
  '*.keyHash',
  '*.key_hash',
  '*.authorization',
  'err.config.headers',
  'err.request.headers',
];

// The same names at any depth: the path list above stops one level down, and a top-level `password` or a
// deeply nested `refreshToken` must not leak either. Also applied by the audit writer (07 §4.2).
const SENSITIVE_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'password_hash',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'token',
  'secret',
  'mfaSecret',
  'mfa_secret',
  'totpSecret',
  'recoveryCodes',
  'recovery_codes',
  'keyHash',
  'key_hash',
  'apiKey',
  'api_key',
  'x-api-key',
  'authorization',
  'cookie',
  'set-cookie',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A copy of `value` with every sensitive key, at any depth, replaced by the censor. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEYS.has(k) ? CENSOR : redact(v);
  return out as T;
}

export interface LoggerOptions {
  service: 'api' | 'worker' | 'scheduler' | 'migrate';
  buildSha: string;
  level?: Level;
  destination?: DestinationStream;
}

/** Structured JSON logger with the baseline fields of 07 §4.2 and double redaction (06 §13.4). */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service, build_sha: options.buildSha },
      messageKey: 'msg',
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level: (label, number) => ({ level: number, level_label: label }),
        log: (object) => redact(object),
      },
      redact: { paths: REDACT_PATHS, censor: CENSOR },
    },
    options.destination ?? pino.destination(1),
  );
}
