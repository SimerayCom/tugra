import { createHash } from "crypto";
import { setBounded } from "./bounded-map";

/** How long a polled read is shared. Two browsers polling the same panel within this window cost one DB round. */
export const COALESCE_TTL_MS = 1500;
const MAX_ENTRIES = 400;

/**
 * Short single-flight cache for the polled panel reads (fleet latest / trend / hottest, server list, dashboard
 * insights, container lists). Concurrent callers of the same key share ONE computation, and the result is reused for
 * `ttlMs` (default 1.5 s) afterwards.
 *
 * Isolation is the caller's job and is by KEY: every key must contain whatever decides what the caller may see (the
 * user id, or a hash of the permitted server-id set), so a result computed for one team can never be served to
 * another. Cached values are shared by reference: callers must treat them as immutable.
 *
 * Staleness: a successful non-GET request calls `invalidate()` (see CoalesceInvalidateInterceptor), so a panel that
 * refetches right after its own mutation never gets the pre-mutation snapshot. A computation that was already running
 * when the invalidation happened is returned to its waiters but NOT stored. Changes that do not come through HTTP
 * (an agent reporting a status flip) show up within `ttlMs`. Errors are never cached. Per hub process, in memory.
 */
export class ReadCoalescer {
  private readonly done = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private generation = 0;
  hits = 0;
  misses = 0;

  async run<T>(rawKey: string, compute: () => Promise<T>, ttlMs = COALESCE_TTL_MS): Promise<T> {
    // A caller-supplied filter (?q=...) must not make keys unbounded.
    const key = rawKey.length > 200 ? `h:${createHash("sha1").update(rawKey).digest("base64url")}` : rawKey;
    const hit = this.done.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      this.hits++;
      return hit.value as T;
    }
    const running = this.inflight.get(key);
    if (running) {
      this.hits++;
      return running as Promise<T>;
    }
    this.misses++;
    const gen = this.generation;
    const p = compute().then((value) => {
      if (gen === this.generation) setBounded(this.done, key, { at: Date.now(), value }, MAX_ENTRIES);
      return value;
    });
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      // Only remove our own entry: an invalidate() may already have let a newer computation take the slot.
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    }
  }

  /** Drop every stored result and stop in-flight ones from being stored (read-your-writes after a mutation). */
  invalidate(): void {
    this.generation++;
    this.done.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.done.size;
  }
}

/** Stable key part for a permitted id set: the same set (in any order) gives the same hash, a different set never does. */
export function setKey(parts: readonly string[]): string {
  const h = createHash("sha1");
  for (const p of [...parts].sort()) h.update(p).update("\0");
  return `${parts.length}:${h.digest("base64url")}`;
}
