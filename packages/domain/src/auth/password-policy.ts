// 06 §4.3, the single place the password policy lives. Pure: the blocklist is passed in.
export interface PasswordContext {
  email: string;
  displayName: string;
  /** Normalised lowercase common passwords (06 §4.3 blocklist). */
  blocklist: ReadonlySet<string>;
  organisationName?: string;
}

export type PasswordRule = 'MIN_LENGTH' | 'MAX_LENGTH' | 'BLOCKLIST' | 'CONTEXT';
export interface PasswordViolation {
  rule: PasswordRule;
  message: string;
}

const PRODUCT_WORDS = ['tradesoft', 'nse', 'bse', 'mcx', 'ncdex'];

/** Every rule the password fails; empty when it passes. History (last 5) is checked by the caller. */
export function checkPasswordPolicy(password: string, ctx: PasswordContext): PasswordViolation[] {
  const normalised = password.normalize('NFKC');
  const length = [...normalised].length;
  const lower = normalised.toLowerCase();
  const stripped = lower.replace(/[^\p{L}\p{N}]/gu, '');
  const out: PasswordViolation[] = [];
  if (length < 12) out.push({ rule: 'MIN_LENGTH', message: 'Use at least 12 characters' });
  if (length > 128) out.push({ rule: 'MAX_LENGTH', message: 'Use at most 128 characters' });
  const words = [...PRODUCT_WORDS, ...(ctx.organisationName ? [ctx.organisationName.toLowerCase()] : [])];
  if (ctx.blocklist.has(lower) || ctx.blocklist.has(stripped) || words.some((w) => lower.includes(w))) {
    out.push({ rule: 'BLOCKLIST', message: 'This password is too common or names the product' });
  }
  const localPart = ctx.email.split('@')[0]!.toLowerCase();
  const nameTokens = ctx.displayName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => [...t].length >= 4);
  if ((localPart.length >= 4 && lower.includes(localPart)) || nameTokens.some((t) => lower.includes(t))) {
    out.push({ rule: 'CONTEXT', message: 'Do not use your name or email address' });
  }
  return out;
}
