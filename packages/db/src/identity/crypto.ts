// Cryptographic primitives of 06 §4.4, §5.2, §5.4, §6.1–§6.2 and §8.1. No I/O; keys are passed in.
import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

export const sha256 = (input: string | Buffer): Buffer => createHash('sha256').update(input).digest();
export const randomToken = (): string => randomBytes(32).toString('base64url');

// ------------------------------------------------------------------ Argon2id with a semaphore (06 §4.4)

const ARGON = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 };

/** Thrown when the Argon2 queue is full or its wait times out; the API maps it to 503. */
export class HashingUnavailableError extends Error {
  constructor() {
    super('Password hashing is saturated');
    this.name = 'HashingUnavailableError';
  }
}

let active = 0;
const waiting: (() => void)[] = [];

async function withArgonSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 4) {
    if (waiting.length >= 32) throw new HashingUnavailableError();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(go), 1);
        reject(new HashingUnavailableError());
      }, 5_000);
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      waiting.push(go);
    });
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function argon2id(password: string, salt: Buffer, p: typeof ARGON): Promise<Buffer> {
  return withArgonSlot(
    () =>
      new Promise((resolve, reject) =>
        argon2('argon2id', { message: password, nonce: salt, ...p }, (err, key) =>
          err ? reject(err) : resolve(key),
        ),
      ),
  );
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await argon2id(password, salt, ARGON);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(salt)}$${b64(key)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Verifies with the parameters stored in the PHC string. A non-PHC value (an unusable hash) never matches. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const key = await argon2id(password, Buffer.from(m[4]!, 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True when the stored hash uses weaker parameters than today's target (06 §4.4 re-hash on login). */
export function needsRehash(stored: string): boolean {
  const m = PHC.exec(stored);
  return !m || Number(m[1]) < ARGON.memory || Number(m[2]) < ARGON.passes;
}

let dummy: Promise<string> | undefined;
/** Verified against when the account does not exist, so timing does not reveal it (06 §4.6). */
export const dummyPasswordHash = (): Promise<string> => (dummy ??= hashPassword(randomToken()));

// ------------------------------------------------------------------ EdDSA access tokens (06 §5.2, §5.8)

export interface Keyring {
  current: { kid: string; privateKey: KeyObject };
  verifiers: ReadonlyMap<string, KeyObject>;
}

function kidOf(publicKey: KeyObject): string {
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return sha256(raw).toString('hex').slice(0, 8);
}

export function createKeyring(currentPem: string, previousPem?: string): Keyring {
  const privateKey = createPrivateKey(currentPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('JWT signing key must be Ed25519');
  const current = { kid: kidOf(createPublicKey(privateKey)), privateKey };
  const verifiers = new Map([[current.kid, createPublicKey(privateKey)]]);
  if (previousPem) {
    const previous = createPublicKey(createPrivateKey(previousPem));
    const kid = kidOf(previous);
    if (verifiers.has(kid)) throw new Error('JWT key ids collide across the rotation; refusing to boot');
    verifiers.set(kid, previous);
  }
  return { current, verifiers };
}

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  ver: 1;
  roles: string[];
  perms: string[];
  iat: number;
  exp: number;
  jti: string;
}

export const ACCESS_TOKEN_SECONDS = 900;

export function signAccessToken(keyring: Keyring, claims: AccessClaims): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyring.current.kid };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input), keyring.current.privateKey).toString('base64url')}`;
}

export type TokenErrorCode = 'AUTH_TOKEN_INVALID' | 'AUTH_TOKEN_EXPIRED' | 'AUTH_SESSION_REVOKED';
export class TokenError extends Error {
  code: TokenErrorCode;
  constructor(code: TokenErrorCode) {
    super(code);
    this.name = 'TokenError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ordered verification pipeline of 06 §5.2; the order decides which error a client sees. */
export function verifyAccessToken(
  keyring: Keyring,
  token: string,
  o: { issuer: string; audience: string; nowSeconds: number; isRevoked(sid: string): boolean },
): AccessClaims {
  const invalid = () => new TokenError('AUTH_TOKEN_INVALID');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  let header: { alg?: unknown; kid?: unknown };
  let claims: AccessClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (header.alg !== 'EdDSA') throw invalid();
  const key = typeof header.kid === 'string' ? keyring.verifiers.get(header.kid) : undefined;
  if (!key) throw invalid();
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url')))
    throw invalid();
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (claims.iss !== o.issuer || claims.aud !== o.audience) throw invalid();
  if (
    claims.ver !== 1 ||
    ![claims.sub, claims.sid, claims.jti].every((v) => typeof v === 'string' && UUID.test(v))
  ) {
    throw invalid();
  }
  if (!Array.isArray(claims.perms) || !claims.perms.every((p) => typeof p === 'string')) throw invalid();
  if (!(claims.exp > o.nowSeconds - 5)) throw new TokenError('AUTH_TOKEN_EXPIRED');
  if (!(claims.iat <= o.nowSeconds + 60)) throw invalid();
  if (o.isRevoked(claims.sid)) throw new TokenError('AUTH_SESSION_REVOKED');
  return claims;
}

// ------------------------------------------------------------------ TOTP (06 §6.1, RFC 6238)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer, alphabet = BASE32): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpCounter = (nowMs: number): number => Math.floor(nowMs / 30_000);

/**
 * The counter of the window (t-1, t, t+1) whose code matches, provided it is newer than the last accepted
 * counter (06 §6.4 replay prevention); null otherwise.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastCounter: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const t = totpCounter(nowMs);
  for (const counter of [t - 1, t, t + 1]) {
    if (lastCounter !== null && counter <= lastCounter) continue;
    const expected = Buffer.from(hotp(secret, counter));
    if (timingSafeEqual(expected, Buffer.from(code))) return counter;
  }
  return null;
}

export function otpauthUri(email: string, secret: Buffer): string {
  const label = encodeURIComponent(`TradeSoft:${email}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=TradeSoft&algorithm=SHA1&digits=6&period=30`;
}

// ------------------------------------------------------------------ MFA secret envelope (06 §6.2, §12.3)

/** blob = 0x01 || key_id || IV(12) || tag(16) || ciphertext; AAD binds the blob to its user. */
export function encryptMfaSecret(key: Buffer, keyId: number, userId: string, secret: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`mfa:${userId}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([Buffer.from([0x01, keyId]), iv, cipher.getAuthTag(), ct]);
}

export function decryptMfaSecret(key: Buffer, userId: string, blob: Buffer): Buffer {
  if (blob[0] !== 0x01) throw new Error('Unknown MFA secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(2, 14));
  decipher.setAAD(Buffer.from(`mfa:${userId}`, 'utf8'));
  decipher.setAuthTag(blob.subarray(14, 30));
  return Buffer.concat([decipher.update(blob.subarray(30)), decipher.final()]);
}

// ------------------------------------------------------------------ API keys and recovery codes (06 §8.1)

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** `tsk_` + 40 Crockford base32 characters over 25 random bytes; the prefix is `tsk_` + the first 8. */
export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const body = base32Encode(randomBytes(25), CROCKFORD);
  const key = `tsk_${body}`;
  return { key, prefix: `tsk_${body.slice(0, 8)}`, hash: sha256(key) };
}

/** Ten single-use recovery codes, `xxxxx-xxxxx`, stored as SHA-256 (06 §12.5). */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const s = base32Encode(randomBytes(7), CROCKFORD).slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
