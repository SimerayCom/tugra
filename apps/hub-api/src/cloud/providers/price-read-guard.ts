import { createHash } from "node:crypto";

/**
 * Cache + pacing for the read-only plan/price calls of a provider client. Prices change rarely and a provider's API
 * quota is the customer's, so a read is cached per credential for a few minutes (concurrent callers share one
 * request; a failure is not cached) and the requests of one client are spaced apart. The token is only ever hashed
 * for the cache key; the hash stays in memory.
 */
export class PriceReadGuard {
  private readonly entries = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();
  private nextSlot = 0;

  constructor(
    private readonly ttlMs: number,
    /** Minimum time between two requests of the client. */
    public gapMs: number,
    private readonly maxEntries = 64,
  ) {}

  /** Cache key for a credential: a hash of its token, never the token. */
  static key(scope: string, token: string): string {
    return `${scope}:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }

  /** The cached value for `key`, else `load()` (shared by concurrent callers, dropped again when it rejects). */
  async cached<T>(key: string, load: () => Promise<T>, ttlMs: number = this.ttlMs): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { at: Date.now(), ttl: ttlMs, value });
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** Resolves when the client may send its next request (requests are spaced `gapMs` apart). */
  async pace(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.gapMs;
    if (at > now) await new Promise<void>((r) => setTimeout(r, at - now));
  }
}
