/** The one-time token of a reset or invitation link, `/reset-password#token=…` (06 §4.2), or null. */
export function readResetToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
