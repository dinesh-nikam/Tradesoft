import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.ts';

const noSecrets = mkdtempSync(path.join(tmpdir(), 'ts-secrets-empty-'));
const devEnv = { DATABASE_URL: 'postgres://app:change-me@localhost/tradesoft' };

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies the defaults of 07 §3.4 and the per-service pool size', () => {
    const { config } = loadConfig({ service: 'scheduler', env: devEnv, secretsDir: noSecrets });
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      SCHEDULER_TICK_MS: 15000,
      DATABASE_POOL_MAX: 2,
    });
  });

  it('treats an empty value as unset', () => {
    const { config } = loadConfig({
      service: 'scheduler',
      env: { ...devEnv, OTEL_EXPORTER_OTLP_ENDPOINT: '' },
      secretsDir: noSecrets,
    });
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('names every missing or invalid key, and never prints a value', () => {
    const found = problems(() =>
      loadConfig({ service: 'api', env: { PORT: 'eighty', CURSOR_SECRET: 'abc' }, secretsDir: noSecrets }),
    ).join('\n');
    expect(found).toMatch(/PORT/);
    expect(found).toMatch(/PUBLIC_ORIGIN: required/);
    expect(found).toMatch(/DATABASE_URL: required secret is missing/);
    expect(found).not.toMatch(/eighty|abc/);
  });

  it('enforces the production rules of 07 §3.4', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-secrets-'));
    writeFileSync(path.join(dir, 'DATABASE_URL'), 'postgres://app:change-me@db/tradesoft\n');
    const found = problems(() =>
      loadConfig({
        service: 'scheduler',
        env: { NODE_ENV: 'production', LOG_LEVEL: 'debug', TRUST_PROXY_HOPS: '0' },
        secretsDir: dir,
      }),
    );
    expect(found).toEqual([
      'LOG_LEVEL: debug and trace are refused in production',
      'TRUST_PROXY_HOPS: must be at least 1 in production',
      'DATABASE_URL: is a documented placeholder',
    ]);
  });

  it('reads production secrets from files only', () => {
    const found = problems(() =>
      loadConfig({
        service: 'scheduler',
        env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://x' },
        secretsDir: noSecrets,
      }),
    );
    expect(found).toContain(
      `DATABASE_URL: secrets are read from ${noSecrets} in production, not from the environment`,
    );
  });

  it('prefers a mounted secret file over the environment', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-secrets-'));
    writeFileSync(path.join(dir, 'DATABASE_URL'), 'postgres://from-file\n');
    const { secrets } = loadConfig({ service: 'scheduler', env: devEnv, secretsDir: dir });
    expect(secrets.DATABASE_URL!.reveal()).toBe('postgres://from-file');
  });

  it('makes secrets impossible to serialise or print (06 §12.2)', () => {
    const { secrets } = loadConfig({ service: 'scheduler', env: devEnv, secretsDir: noSecrets });
    expect(() => JSON.stringify(secrets)).toThrow(/cannot be serialised/);
    expect(String(secrets.DATABASE_URL)).toBe('[secret]');
    expect(inspect(secrets)).not.toContain('change-me');
  });
});
