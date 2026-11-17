import { createHash } from "node:crypto";

/**
 * Client-side pacing and 429 handling for a Coolify instance (4.7+ throttles its REST API).
 *
 * What Coolify enforces (config/api.php, ThrottleFailedApiRequests): 200 requests a minute PER USER (every team token of
 * one user shares the bucket), and a token that causes 30 failed (401/403) requests in a minute is answered 429 for 60 s,
 * then 300 s, then 900 s. This module keeps the hub under both:
 *  - {@link TokenBucket}: one per Coolify base URL, shared by every caller in the process (discover fan-out, the freeze
 *    control client, a second operator), paced to {@link PACED_REQUESTS_PER_MIN} so 25% of the user's bucket is left for
 *    others;
 *  - {@link AuthBreaker}: one per (base URL, token) that stops SENDING once the token keeps failing authorization, so a bad
 *    or under-scoped token is never driven into the escalating lockout;
 *  - {@link RequestLimits.run}: honours `Retry-After` with a bounded wait and a few retries, then a stable
 *    {@link RateLimitedError} (`code: "rate-limited"`). A `Retry-After` longer than the bound is a lockout and is never
 *    waited out inside a request.
 *
 * Time is injected ({@link Clock}) so the behaviour is tested without real sleeps. The token is only ever hashed (the key
 * of the breaker); it is never stored or logged.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Coolify's per-user limit is 200/min: stay well below it so a second operator or a live panel on the same instance keeps working. */
export const PACED_REQUESTS_PER_MIN = 150;
/** Requests that may go out back to back before pacing starts (a small discover needs no waiting at all). */
export const PACE_BURST = 20;

/** Coolify's failed-request limit is 30/min per token; the breaker trips below it so in-flight requests cannot cross it. */
export const AUTH_FAILURE_TRIP = 20;
/** An invalid token (401) fails every request, so a handful is proof enough. */
export const AUTH_401_TRIP = 3;
export const AUTH_WINDOW_MS = 60_000;
export const AUTH_PAUSE_MS = 60_000;

export const RETRY_MAX = 3;
/** A Retry-After above this is a token lockout (300/900 s): fail with `rate-limited` instead of holding the request open. */
export const RETRY_MAX_WAIT_MS = 60_000;
export const RETRY_TOTAL_WAIT_MS = 90_000;
export const RETRY_DEFAULT_WAIT_MS = 10_000;

/** A minimal response view the limiter needs; the real transports return a superset. */
export interface LimitedResponse {
  status: number;
  /** The raw `Retry-After` header (delta-seconds or an HTTP date), when present. */
  retryAfter?: string | null;
}

/** A 429 that outlived the bounded retries, or a Retry-After too long to wait for. Stable: callers branch on `code`. */
export class RateLimitedError extends Error {
  readonly code = "rate-limited" as const;
  /** The HTTP status this stands for. Callers that sniff messages for 401/403/404 must read this field instead. */
  readonly status = 429 as const;
  constructor(
    label: string,
    readonly retryAfterSec: number,
  ) {
    super(`${label} API error 429 (rate-limited: ${label} allows 200 requests a minute per user — wait about ${humanWait(retryAfterSec)} and retry)`);
    this.name = "RateLimitedError";
  }
}

/** A wait as "N s" under a minute, else whole minutes: a bare number of seconds in a message could be mistaken for an HTTP status (401/403/404). */
export function humanWait(sec: number): string {
  return sec < 60 ? `${Math.max(1, Math.ceil(sec))} s` : `${Math.ceil(sec / 60)} min`;
}

/** The token kept failing authorization, so the client stopped sending requests for a while instead of risking Coolify's lockout. */
export class AuthPausedError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(`authorization failed (${status}); requests paused for ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = "AuthPausedError";
  }
}

/** The `Retry-After` value of a node response header bag (a header may arrive as a string or an array); null when absent. */
export function retryAfterHeader(headers: { [name: string]: string | string[] | undefined }): string | null {
  const ra = headers["retry-after"];
  return Array.isArray(ra) ? (ra[0] ?? null) : (ra ?? null);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds from `now`; null when absent or unparseable. */
export function parseRetryAfterMs(raw: string | null | undefined, now: number): number | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.max(1_000, Number(v) * 1_000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(1_000, at - now);
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private blockedUntil = 0;

  constructor(
    private readonly ratePerMin: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {
    this.tokens = burst;
    this.last = clock.now();
  }

  /**
   * Reserve one request slot and return how long the caller must wait before sending (0 = send now). Callers queue fairly:
   * slots are handed out in call order. While the bucket is blocked (a 429 said "not before ts") slots are handed out
   * AFTER the block, one pace apart, so the queue leaves as a trickle and not as a burst that refreshes the 429.
   */
  reserve(): number {
    const t = this.clock.now();
    const te = Math.max(t, this.blockedUntil);
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, te - this.last) * this.ratePerMin) / 60_000);
    this.last = te;
    this.tokens -= 1;
    const pace = this.tokens < 0 ? Math.ceil((-this.tokens * 60_000) / this.ratePerMin) : 0;
    return te - t + pace;
  }

  /** Milliseconds still blocked by a 429 (0 = not blocked). */
  blockedFor(): number {
    return Math.max(0, this.blockedUntil - this.clock.now());
  }

  /** A 429 said "not before `ts`": every caller of this base URL holds back until then (the bucket is the user's shared budget). */
  blockUntil(ts: number): void {
    if (ts > this.blockedUntil) this.blockedUntil = ts;
    // no stored burst after a 429: refilling starts when the block ends, one request leaves then, the rest follow at the pace
    this.tokens = 1;
    this.last = Math.max(this.last, this.blockedUntil);
  }
}

type BreakerState = { kind: "ok" } | { kind: "auth"; status: number; ms: number } | { kind: "locked"; ms: number };

export class AuthBreaker {
  private failures: number[] = [];
  private consecutive401 = 0;
  private pausedUntil = 0;
  private lockedUntil = 0;
  private lastStatus = 401;

  constructor(private readonly clock: Clock) {}

  state(): BreakerState {
    const t = this.clock.now();
    if (this.lockedUntil > t) return { kind: "locked", ms: this.lockedUntil - t };
    if (this.pausedUntil > t) return { kind: "auth", status: this.lastStatus, ms: this.pausedUntil - t };
    return { kind: "ok" };
  }

  /**
   * Every 403 counts, also when other requests of the token succeed: Coolify's own limiter counts every 401/403 of the token
   * in the minute (ThrottleFailedApiRequests) whatever else succeeds, so a discover that keeps hitting per-route 403s would be
   * locked out by Coolify at 30 (for 60 s, then 300 s, then 900 s) just the same. Pausing at {@link AUTH_FAILURE_TRIP} keeps
   * the lockout from ever starting; the pause is short, and the freeze control client reports it as retryable (`rate-limited`), not as a denial.
   *
   * Record the final status of a request that was actually sent (a 429 is recorded through {@link lock}, not here). */
  record(status: number): void {
    const t = this.clock.now();
    if (status >= 200 && status < 300) {
      this.consecutive401 = 0;
      return;
    }
    if (status !== 401 && status !== 403) return;
    this.lastStatus = status;
    this.failures = this.failures.filter((f) => t - f < AUTH_WINDOW_MS);
    this.failures.push(t);
    if (status === 401) this.consecutive401++;
    if (this.consecutive401 >= AUTH_401_TRIP || this.failures.length >= AUTH_FAILURE_TRIP) {
      this.pausedUntil = t + AUTH_PAUSE_MS;
      this.failures = [];
      this.consecutive401 = 0;
    }
  }

  /** Coolify itself blocked this token for `ms`: send nothing until then. */
  lock(ms: number): void {
    this.lockedUntil = Math.max(this.lockedUntil, this.clock.now() + ms);
  }
}

export interface RetryPolicy {
  maxRetries: number;
  maxWaitMs: number;
  maxTotalWaitMs: number;
  defaultWaitMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: RETRY_MAX,
  maxWaitMs: RETRY_MAX_WAIT_MS,
  maxTotalWaitMs: RETRY_TOTAL_WAIT_MS,
  defaultWaitMs: RETRY_DEFAULT_WAIT_MS,
};

export class RequestLimits {
  constructor(
    private readonly bucket: TokenBucket,
    private readonly breaker: AuthBreaker,
    private readonly clock: Clock,
    private readonly label = "Coolify",
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  /**
   * Send one logical request: wait for a pacing slot, refuse to send while the token is paused/locked, and on a 429 wait
   * out a bounded `Retry-After` and try again. Returns the final non-429 response (the caller interprets 2xx/4xx);
   * throws {@link RateLimitedError} or {@link AuthPausedError}.
   */
  async run<T extends LimitedResponse>(send: () => Promise<T>): Promise<T> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      const res = await send();
      if (res.status !== 429) {
        this.breaker.record(res.status);
        return res;
      }
      const waitMs = parseRetryAfterMs(res.retryAfter, this.clock.now()) ?? this.retry.defaultWaitMs;
      if (waitMs > this.retry.maxWaitMs) {
        this.breaker.lock(waitMs); // a lockout: do not poke the token again until it ends
        throw new RateLimitedError(this.label, Math.ceil(waitMs / 1000));
      }
      if (attempt >= this.retry.maxRetries || waited + waitMs > this.retry.maxTotalWaitMs) {
        throw new RateLimitedError(this.label, Math.ceil(waitMs / 1000));
      }
      waited += waitMs;
      this.bucket.blockUntil(this.clock.now() + waitMs); // every concurrent caller of this base URL holds back too
    }
  }

  /**
   * Wait for a pacing slot. The breaker and the bucket's 429 block are consulted again after every sleep: a request that was
   * already queued when another caller's 429 (or the token's auth failures) arrived must not be sent anyway.
   */
  private async slot(): Promise<void> {
    for (;;) {
      const st = this.breaker.state();
      if (st.kind === "auth") throw new AuthPausedError(st.status, st.ms);
      if (st.kind === "locked") throw new RateLimitedError(this.label, Math.ceil(st.ms / 1000));
      const wait = this.bucket.reserve();
      if (wait <= 0) return;
      await this.clock.sleep(wait);
      const after = this.breaker.state();
      if (after.kind === "ok" && this.bucket.blockedFor() <= 0) return;
    }
  }
}

const MAX_TRACKED = 256;

/** Shared limiter state: one {@link TokenBucket} per base URL origin, one {@link AuthBreaker} per (origin, token). */
export class LimitsRegistry {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, AuthBreaker>();

  constructor(private readonly clock: Clock = SYSTEM_CLOCK) {}

  for(baseUrl: string, token: string, label = "Coolify"): RequestLimits {
    const origin = originOf(baseUrl);
    let bucket = this.buckets.get(origin);
    if (!bucket) {
      bucket = new TokenBucket(PACED_REQUESTS_PER_MIN, PACE_BURST, this.clock);
      this.buckets.set(origin, bucket);
      prune(this.buckets);
    }
    const key = `${origin}|${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new AuthBreaker(this.clock);
      this.breakers.set(key, breaker);
      prune(this.breakers);
    }
    return new RequestLimits(bucket, breaker, this.clock, label);
  }
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

function prune<V>(m: Map<string, V>): void {
  while (m.size > MAX_TRACKED) {
    const first = m.keys().next();
    if (first.done) return;
    m.delete(first.value);
  }
}

/** The process-wide registry every Coolify client shares. */
export const coolifyLimits = new LimitsRegistry();
