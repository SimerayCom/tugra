import { QueryClient, type DefaultedQueryObserverOptions, type QueryClientConfig, type QueryKey, type QueryObserverOptions } from "@tanstack/react-query";

/** After this long without a pointer / key / scroll / touch event the panel counts as idle and its polls slow down. */
export const IDLE_AFTER_MS = 60_000;
/** Idle polls run this many times slower than the interval the call site asked for. */
export const IDLE_FACTOR = 4;
/** Never poll slower than this while idle (a 60 s poll x 4 would otherwise drift to 4 minutes). */
export const IDLE_MAX_MS = 120_000;
/** Polls faster than this are a user WAITING on an operation (deploy, migration, reboot): never slowed. */
// Polls of 5 s or less track something running (an install, a backup, a deploy, the live fleet): never slow them.
export const KEEP_FAST_BELOW_MS = 6_000;
const CHECK_EVERY_MS = 5_000;

/** The slowed interval for a base interval while idle (pure, so it is unit-tested). */
export function idleInterval(baseMs: number, idle: boolean): number {
  if (!idle || baseMs < KEEP_FAST_BELOW_MS) return baseMs;
  return Math.min(Math.max(baseMs, IDLE_MAX_MS), baseMs * IDLE_FACTOR);
}

type Interval = number | false | undefined;
type IntervalOption = Interval | ((query: never) => Interval);

/** Wraps a query's `refetchInterval` (number or function) so it reads the shared idle state. Hidden tabs are
 *  already skipped by TanStack Query (refetchIntervalInBackground defaults to false); this adds the idle slow-down. */
export function withIdleSlowdown(option: IntervalOption, isIdle: () => boolean): IntervalOption {
  if (option === undefined || option === false || option === 0) return option;
  if (typeof option === "number") return () => idleInterval(option, isIdle());
  return ((query: never) => {
    const base = option(query);
    return typeof base === "number" && base > 0 ? idleInterval(base, isIdle()) : base;
  }) as IntervalOption;
}

/** The QueryClient used by the app: every polled query slows down 4x after 60 s without user interaction and snaps
 *  back (with an immediate refetch) on the next interaction, focus or tab-visible event. One place, no per-call edits. */
export class PollingQueryClient extends QueryClient {
  private idle = false;
  private lastActive = Date.now();
  private teardown: (() => void) | null = null;

  constructor(config?: QueryClientConfig) {
    super(config);
  }

  isIdle(): boolean {
    return this.idle;
  }

  override defaultQueryOptions<TQueryFnData = unknown, TError = Error, TData = TQueryFnData, TQueryData = TQueryFnData, TQueryKey extends QueryKey = QueryKey, TPageParam = never>(
    options:
      | QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
      | DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
    const defaulted = super.defaultQueryOptions(options);
    if (!defaulted.refetchInterval) return defaulted;
    // `_defaulted` objects are returned untouched by super, so a second pass must not double-wrap.
    if ((defaulted as { _idleWrapped?: boolean })._idleWrapped) return defaulted;
    return { ...defaulted, refetchInterval: withIdleSlowdown(defaulted.refetchInterval as unknown as IntervalOption, () => this.idle), _idleWrapped: true } as unknown as typeof defaulted;
  }

  /** Re-evaluate every active polling observer's interval (the timer only re-reads it on setOptions). */
  private resync(refetchNow: boolean): void {
    for (const query of this.getQueryCache().getAll()) {
      for (const observer of query.observers) {
        const ri = observer.options.refetchInterval;
        if (!ri) continue;
        observer.setOptions(observer.options);
        // Only a query that is polling right now is refetched (a finished operation's poll returned false).
        const polling = typeof ri === "function" ? ri(query) : ri;
        if (refetchNow && polling && observer.options.enabled !== false) void query.fetch().catch(() => undefined);
      }
    }
  }

  /** Marks activity; the first one after an idle spell restores normal polling and refetches at once. */
  markActive(now = Date.now()): void {
    this.lastActive = now;
    if (!this.idle) return;
    this.idle = false;
    this.resync(true);
  }

  /** Called on a timer: flips to idle once nothing happened for IDLE_AFTER_MS. */
  checkIdle(now = Date.now()): void {
    if (this.idle || now - this.lastActive < IDLE_AFTER_MS) return;
    this.idle = true;
    this.resync(false);
  }

  /** Browser-only: wires the interaction listeners and the idle timer. Returns the cleanup. */
  start(): () => void {
    if (typeof window === "undefined" || this.teardown) return this.teardown ?? (() => undefined);
    let lastMove = 0;
    const onActivity = () => this.markActive();
    // pointermove fires constantly: only look at it every 2 s.
    const onMove = () => {
      const now = Date.now();
      if (now - lastMove > 2_000) {
        lastMove = now;
        this.markActive(now);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") this.markActive();
    };
    const opts = { passive: true, capture: true } as const;
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, onActivity, opts);
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("focus", onActivity);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => this.checkIdle(), CHECK_EVERY_MS);
    this.teardown = () => {
      for (const e of events) window.removeEventListener(e, onActivity, opts);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("focus", onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      this.teardown = null;
    };
    return this.teardown;
  }
}
