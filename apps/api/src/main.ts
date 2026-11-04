import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { exitOnConfigError, loadConfig, type LoadedConfig } from '@tradesoft/config';
import { createKeyring, pollRevocations, RevocationSet } from '@tradesoft/db';
import { createLogger } from '@tradesoft/observability';
import { buildApp } from './app.ts';

let loaded: LoadedConfig;
try {
  loaded = loadConfig({ service: 'api' });
} catch (error) {
  exitOnConfigError(error);
}
const { config, secrets } = loaded;
const log = createLogger({ service: 'api', buildSha: config.BUILD_SHA, level: config.LOG_LEVEL });

const mfaKey = Buffer.from(secrets.MFA_ENCRYPTION_KEY!.reveal(), 'base64');
if (mfaKey.length !== 32) {
  console.error('MFA_ENCRYPTION_KEY: must be 32 bytes, base64-encoded');
  process.exit(78);
}
// 06 §4.3: the common-password list is a build artefact; without it the blocklist rule is inert.
const blocklistFile = new URL('../../../packages/domain/data/common-passwords.txt', import.meta.url);
const blocklist = new Set(
  existsSync(blocklistFile)
    ? readFileSync(blocklistFile, 'utf8')
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
    : [],
);
if (blocklist.size === 0) log.warn({}, 'password blocklist is empty; 06 §4.3 blocklist rule is not enforced');

const pool = new pg.Pool({ connectionString: secrets.DATABASE_URL!.reveal(), max: config.DATABASE_POOL_MAX });
const revocations = new RevocationSet();
let pollFailures = 0;
const poll = async () => {
  try {
    const c = await pool.connect();
    try {
      await pollRevocations(c, revocations);
    } finally {
      c.release();
    }
    pollFailures = 0;
  } catch (err) {
    pollFailures++;
    log.error({ err, pollFailures }, 'revocation poll failed');
  }
};
// 06 §5.7: the first poll completes before the listener accepts traffic.
await poll();
setInterval(() => void poll(), 30_000);

const app = buildApp(
  {
    pool,
    identity: {
      keyring: createKeyring(
        secrets.JWT_SIGNING_KEY_CURRENT!.reveal(),
        secrets.JWT_SIGNING_KEY_PREVIOUS?.reveal(),
      ),
      issuer: config.PUBLIC_ORIGIN!,
      audience: 'tradesoft-api',
      mfaKey,
      mfaKeyId: 1,
      blocklist,
      revocations,
    },
    importRoot: config.IMPORT_ROOT,
    uploadMaxBytes: config.UPLOAD_MAX_BYTES,
    isReady: async () =>
      revocations.lastPollAt !== null && pollFailures < 5 && (await pool.query('select 1')).rowCount === 1,
  },
  { logger: log, trustProxyHops: config.TRUST_PROXY_HOPS, bodyLimit: config.HTTP_BODY_LIMIT_BYTES },
);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
log.info({ port: config.PORT }, 'api started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}
