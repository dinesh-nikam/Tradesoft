/**
 * The per-process revocation set of 06 §5.7: session ids revoked recently enough that a token carrying them
 * may still be unexpired. Entries expire after 90 minutes; the oldest are evicted beyond 50,000.
 */
export class RevocationSet {
  entries = new Map<string, number>();
  lastPollAt: Date | null = null;
  capacity: number;
  ttlMs: number;

  constructor(capacity = 50_000, ttlMs = 90 * 60_000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  add(sessionId: string, revokedAtMs: number): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, revokedAtMs);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  has(sessionId: string, nowMs: number): boolean {
    const at = this.entries.get(sessionId);
    if (at === undefined) return false;
    if (nowMs - at > this.ttlMs) {
      this.entries.delete(sessionId);
      return false;
    }
    return true;
  }
}
