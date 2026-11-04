import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  createKeyring,
  decryptMfaSecret,
  encryptMfaSecret,
  generateApiKey,
  hashPassword,
  hotp,
  needsRehash,
  RevocationSet,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
  verifyTotp,
  type AccessClaims,
} from '../src/identity/index.ts';

const pem = () =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const id = '018f2c4a-7b31-7c9e-9a1f-2b3c4d5e6f70';
const claims = (now: number): AccessClaims => ({
  iss: 'https://tradesoft.test',
  aud: 'tradesoft-api',
  sub: id,
  sid: id,
  ver: 1,
  roles: ['VIEWER'],
  perms: ['chart:read'],
  iat: now,
  exp: now + 900,
  jti: id,
});
const opts = (now: number, revoked = false) => ({
  issuer: 'https://tradesoft.test',
  audience: 'tradesoft-api',
  nowSeconds: now,
  isRevoked: () => revoked,
});

describe('TOTP (RFC 4226 / 6238 vectors)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('matches the published HOTP values', () => {
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
    expect(hotp(secret, 1, 8)).toBe('94287082');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('accepts t-1, t, t+1 and never a counter at or below the last accepted one', () => {
    const now = 1_000 * 30_000;
    expect(verifyTotp(secret, hotp(secret, 1001), now, null)).toBe(1001);
    expect(verifyTotp(secret, hotp(secret, 999), now, null)).toBe(999);
    expect(verifyTotp(secret, hotp(secret, 1002), now, null)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, 1000), now, 1000)).toBeNull();
  });
});

describe('access tokens (06 §5.2)', () => {
  const now = 1_800_000_000;
  const ring = createKeyring(pem());

  it('round-trips and enforces the ordered checks', () => {
    const token = signAccessToken(ring, claims(now));
    expect(verifyAccessToken(ring, token, opts(now)).perms).toEqual(['chart:read']);
    expect(() => verifyAccessToken(ring, token, opts(now + 906))).toThrow('AUTH_TOKEN_EXPIRED');
    expect(() => verifyAccessToken(ring, token, opts(now, true))).toThrow('AUTH_SESSION_REVOKED');
    expect(() => verifyAccessToken(ring, token, { ...opts(now), audience: 'other' })).toThrow(
      'AUTH_TOKEN_INVALID',
    );
  });

  it('rejects alg none, a tampered payload and an unknown key', () => {
    const [, payload, sig] = signAccessToken(ring, claims(now)).split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: ring.current.kid })).toString('base64url');
    expect(() => verifyAccessToken(ring, `${none}.${payload}.`, opts(now))).toThrow('AUTH_TOKEN_INVALID');
    const forged = Buffer.from(JSON.stringify({ ...claims(now), perms: ['user:write'] })).toString(
      'base64url',
    );
    const header = signAccessToken(ring, claims(now)).split('.')[0];
    expect(() => verifyAccessToken(ring, `${header}.${forged}.${sig}`, opts(now))).toThrow(
      'AUTH_TOKEN_INVALID',
    );
    expect(() =>
      verifyAccessToken(createKeyring(pem()), signAccessToken(ring, claims(now)), opts(now)),
    ).toThrow('AUTH_TOKEN_INVALID');
  });

  it('verifies tokens of the previous key during a rotation (06 §5.8)', () => {
    const oldPem = pem();
    const token = signAccessToken(createKeyring(oldPem), claims(now));
    expect(verifyAccessToken(createKeyring(pem(), oldPem), token, opts(now)).sub).toBe(id);
  });
});

describe('MFA envelope, passwords, API keys, revocation set', () => {
  it('binds an encrypted secret to its user (06 §6.2)', () => {
    const key = Buffer.alloc(32, 7);
    const blob = encryptMfaSecret(key, 1, 'user-a', Buffer.from('secret'));
    expect(decryptMfaSecret(key, 'user-a', blob).toString()).toBe('secret');
    expect(() => decryptMfaSecret(key, 'user-b', blob)).toThrow();
  });

  it('hashes with Argon2id in PHC form and verifies only the right password', async () => {
    const hash = await hashPassword('purple monsoon ledger');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyPassword(hash, 'purple monsoon ledger')).toBe(true);
    expect(await verifyPassword(hash, 'purple monsoon ledgeR')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('generates API keys in the 06 §8.1 format', () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^tsk_[0-9a-hjkmnp-tv-z]{40}$/);
    expect(prefix).toMatch(/^tsk_[a-z0-9]{8}$/);
    expect(key.startsWith(prefix)).toBe(true);
  });

  it('forgets revocations after the TTL and evicts the oldest beyond capacity', () => {
    const set = new RevocationSet(2, 1000);
    set.add('a', 0);
    set.add('b', 0);
    set.add('c', 0);
    expect([set.has('a', 10), set.has('b', 10), set.has('c', 10)]).toEqual([false, true, true]);
    expect(set.has('b', 2000)).toBe(false);
  });
});
