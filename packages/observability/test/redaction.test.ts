import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../src/index.ts';

// SEC-T-14 (06 §17.2), E3.6: credentials never reach a log line, through the real logger configuration.
const fixtures = {
  jwt: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImFiY2QxMjM0In0.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLXZhbHVl',
  refresh: 'q8Zr0w3V1b7xYp2Nn4Ld6Hk9Jm5Tc1Gs8Fe0Ua3Wz7',
  password: 'correct horse battery staple 1!',
  apiKey: 'tsk_live_4f9c2b7e1a8d6c3b5e0f9a2d7c4b1e8f',
  mfaSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  totpCode: '492039',
};

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'api',
    buildSha: 'abc1234',
    destination: { write: (s: string) => void lines.push(s) },
  });
  return { logger, lines };
}

describe('log redaction', () => {
  it('removes every credential from structured log records', () => {
    const { logger, lines } = capture();
    logger.info({ password: fixtures.password }, 'login attempt');
    logger.info({ user: { passwordHash: fixtures.password } }, 'user loaded');
    logger.info(
      {
        req: {
          headers: {
            authorization: `Bearer ${fixtures.jwt}`,
            cookie: `ts_rt=${fixtures.refresh}`,
            'x-api-key': fixtures.apiKey,
            'x-csrf-token': fixtures.refresh,
          },
        },
      },
      'request',
    );
    logger.info({ body: { code: fixtures.totpCode, token: fixtures.refresh } }, 'mfa verify');
    logger.info({ session: { refreshToken: fixtures.refresh, accessToken: fixtures.jwt } }, 'session issued');
    logger.info({ a: { b: { c: { mfaSecret: fixtures.mfaSecret, apiKey: fixtures.apiKey } } } }, 'deep');
    logger.info({ users: [{ password: fixtures.password }] }, 'array');

    const output = lines.join('');
    for (const value of Object.values(fixtures)) expect(output).not.toContain(value);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(12);
  });

  it('writes the baseline fields of 07 §4.2 on every line', () => {
    const { logger, lines } = capture();
    logger.info({ user_id: 'u1' }, 'job claimed');
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      level: 30,
      level_label: 'info',
      msg: 'job claimed',
      service: 'api',
      build_sha: 'abc1234',
    });
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('redacts nested values without changing the input', () => {
    const input = { metadata: { refresh_token: 'x', note: 'kept' } };
    expect(redact(input)).toEqual({ metadata: { refresh_token: '[REDACTED]', note: 'kept' } });
    expect(input.metadata.refresh_token).toBe('x');
  });
});
