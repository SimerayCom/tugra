import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { RedisService } from "../redis/redis.service";

// Generous enough for automation, tight enough to blunt a leaked-token hammer. Overridable per instance.
const DEFAULT_LIMIT = 300;
const DEFAULT_WINDOW_SEC = 60;
// Cap on the Redis round-trip so a Redis OUTAGE fails open promptly instead of hanging. ioredis is built with
// maxRetriesPerRequest:null, so a command issued while disconnected queues and retries forever (never rejects) —
// `.catch` alone would never fire, so the whole request would hang. We race the counter against this timer.
const REDIS_TIMEOUT_MS = 300;

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

/**
 * Per-personal-access-token rate limit for the REST API. API-1 opened many controllers to PATs, so a leaked or
 * abusive token needs a budget of its own beyond the coarse global per-IP throttler. Each PAT request (keyed by
 * `req.user.tokenId`) is counted in a wall-clock-aligned fixed window in Redis; every response carries
 * `X-RateLimit-Limit/Remaining/Reset`, and an over-budget request is rejected `429` with `Retry-After`.
 *
 * Browser sessions (no `tokenId`) and public routes are untouched — the global IP throttler already covers them.
 * Registered globally, it runs AFTER the auth guard, so `req.user` is populated. Fail-OPEN: a Redis error yields
 * a count of 0, so a cache hiccup never blocks the API. Configure with `API_RATE_LIMIT` / `API_RATE_WINDOW_SEC`.
 */
@Injectable()
export class ApiRateLimitInterceptor implements NestInterceptor {
  private readonly limit: number;
  private readonly windowSec: number;

  constructor(private readonly redis: RedisService) {
    this.limit = envInt("API_RATE_LIMIT", DEFAULT_LIMIT);
    this.windowSec = envInt("API_RATE_WINDOW_SEC", DEFAULT_WINDOW_SEC);
  }

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const tokenId: string | undefined = req.user?.tokenId;
    if (!tokenId) return next.handle(); // session or public route — covered by the global per-IP throttler

    const res = ctx.switchToHttp().getResponse();
    const nowSec = Math.floor(Date.now() / 1000);
    const windowIdx = Math.floor(nowSec / this.windowSec);
    const resetSec = (windowIdx + 1) * this.windowSec;
    // Fail-open on BOTH a Redis error (incr rejects → 0) AND a Redis outage/hang (the timer wins → 0), so a cache
    // problem never blocks or stalls the API; a healthy Redis resolves well within the timeout.
    const count = await Promise.race([
      this.redis.incr(`api:rl:${tokenId}:${windowIdx}`, this.windowSec).catch(() => 0),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), REDIS_TIMEOUT_MS)),
    ]);
    const remaining = count > 0 ? Math.max(0, this.limit - count) : this.limit;

    res.setHeader("X-RateLimit-Limit", String(this.limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSec));

    if (count > this.limit) {
      res.setHeader("Retry-After", String(Math.max(1, resetSec - nowSec)));
      throw new HttpException("API rate limit exceeded for this token", HttpStatus.TOO_MANY_REQUESTS);
    }
    return next.handle();
  }
}
