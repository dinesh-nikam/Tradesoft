import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export type Service = 'api' | 'worker' | 'scheduler';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

// 07 §3.4: validated, loggable configuration.
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PUBLIC_ORIGIN: z.url().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_SINK: z.string().min(1).default('stdout'),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(209_715_200).default(20_971_520),
  IMPORT_ROOT: z.string().min(1).default('data'),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1_000).default(15_000),
  ANALYTICS_STALENESS_DAILY_SESSIONS: z.coerce.number().int().min(0).default(3),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(300),
  MAIL_FROM: z.string().min(3).optional(),
  MAIL_HOST: z.string().min(1).optional(),
  MAIL_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  MAIL_USER: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  BUILD_SHA: z.string().min(1).default('dev'),
});
export type Config = z.infer<typeof configSchema> & { DATABASE_POOL_MAX: number };

const REQUIRED_CONFIG: Record<Service, (keyof Config)[]> = {
  api: ['PUBLIC_ORIGIN'],
  worker: ['MAIL_FROM', 'MAIL_HOST', 'PUBLIC_ORIGIN'],
  scheduler: [],
};
const POOL_DEFAULT: Record<Service, number> = { api: 20, worker: 10, scheduler: 2 };

// 07 §3.4 secrets, by the process that needs them.
export type SecretName =
  | 'DATABASE_URL'
  | 'JWT_SIGNING_KEY_CURRENT'
  | 'JWT_SIGNING_KEY_PREVIOUS'
  | 'MFA_ENCRYPTION_KEY'
  | 'CURSOR_SECRET'
  | 'OPS_METRICS_TOKEN'
  | 'SMTP_PASSWORD';
const REQUIRED_SECRETS: Record<Service, SecretName[]> = {
  api: [
    'DATABASE_URL',
    'JWT_SIGNING_KEY_CURRENT',
    'MFA_ENCRYPTION_KEY',
    'CURSOR_SECRET',
    'OPS_METRICS_TOKEN',
  ],
  worker: ['DATABASE_URL', 'SMTP_PASSWORD'],
  scheduler: ['DATABASE_URL'],
};
const OPTIONAL_SECRETS: Record<Service, SecretName[]> = {
  api: ['JWT_SIGNING_KEY_PREVIOUS'],
  worker: [],
  scheduler: [],
};
const RANDOM_SECRETS: SecretName[] = ['MFA_ENCRYPTION_KEY', 'CURSOR_SECRET', 'OPS_METRICS_TOKEN'];
// 06 §12.2: documented example values that must never reach production.
const PLACEHOLDERS = ['change-me', 'changeme', 'test', 'secret', 'password', 'example'];

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** A secret value. It cannot be serialised, logged or interpolated by accident (06 §12.2). */
export class Secret {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): never {
    throw new Error('A secret cannot be serialised');
  }

  toString(): string {
    return '[secret]';
  }

  [INSPECT](): string {
    return '[secret]';
  }
}

export type Secrets = Readonly<Partial<Record<SecretName, Secret>>>;
export interface LoadedConfig {
  config: Readonly<Config>;
  secrets: Secrets;
}

/** Lists the names of the keys at fault, never their values. */
export class ConfigError extends Error {
  problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface LoadOptions {
  service: Service;
  env?: Readonly<Record<string, string | undefined>>;
  /** Directory of mounted secret files (07 §3.1). */
  secretsDir?: string;
}

export function loadConfig(options: LoadOptions): LoadedConfig {
  const { service, env = process.env, secretsDir = '/run/secrets' } = options;
  const problems: string[] = [];

  // An empty value is unset: `.env` files write `KEY=` for "not configured".
  const input = Object.fromEntries(
    Object.keys(configSchema.shape).map((k) => [k, env[k] === '' ? undefined : env[k]]),
  );
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join('.')}: ${issue.message}`);
  }
  const config = {
    ...(parsed.success ? parsed.data : configSchema.parse({})),
    DATABASE_POOL_MAX: parsed.data?.DATABASE_POOL_MAX ?? POOL_DEFAULT[service],
  } as Config;
  for (const key of REQUIRED_CONFIG[service]) {
    if (config[key] === undefined) problems.push(`${key}: required for ${service}`);
  }

  const production = config.NODE_ENV === 'production';
  if (production) {
    if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') {
      problems.push('LOG_LEVEL: debug and trace are refused in production');
    }
    if (config.PUBLIC_ORIGIN && !config.PUBLIC_ORIGIN.startsWith('https://')) {
      problems.push('PUBLIC_ORIGIN: must be https in production');
    }
    if (config.TRUST_PROXY_HOPS < 1) problems.push('TRUST_PROXY_HOPS: must be at least 1 in production');
  }

  const secrets: Partial<Record<SecretName, Secret>> = {};
  for (const name of [...REQUIRED_SECRETS[service], ...OPTIONAL_SECRETS[service]]) {
    const file = path.join(secretsDir, name);
    let value: string | undefined;
    if (existsSync(file)) value = readFileSync(file, 'utf8').trim();
    else if (!production) value = env[name] || undefined;
    else if (env[name])
      problems.push(`${name}: secrets are read from ${secretsDir} in production, not from the environment`);

    if (!value) {
      if (REQUIRED_SECRETS[service].includes(name)) problems.push(`${name}: required secret is missing`);
      continue;
    }
    if (production) {
      const lower = value.toLowerCase();
      if (PLACEHOLDERS.some((p) => lower === p || lower.includes(`:${p}@`))) {
        problems.push(`${name}: is a documented placeholder`);
      }
      if (RANDOM_SECRETS.includes(name) && value.length < 32) {
        problems.push(`${name}: must be at least 32 characters of random data`);
      }
      if (name.startsWith('JWT_SIGNING_KEY') && !value.includes('BEGIN PRIVATE KEY')) {
        problems.push(`${name}: must be a PEM private key`);
      }
    }
    secrets[name] = new Secret(value);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { config: Object.freeze(config), secrets: Object.freeze(secrets) };
}

/** 07 §3.4 load rule 2: a configuration failure exits with EX_CONFIG. */
export function exitOnConfigError(error: unknown): never {
  console.error(error instanceof ConfigError ? error.message : 'Invalid configuration');
  process.exit(78);
}
