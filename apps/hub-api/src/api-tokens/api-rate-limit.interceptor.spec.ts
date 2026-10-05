import { CallHandler, ExecutionContext, HttpException } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { ApiRateLimitInterceptor } from "./api-rate-limit.interceptor";
import { RedisService } from "../redis/redis.service";

function ctxFor(user: unknown): { ctx: ExecutionContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } };
  const req = { user };
  const ctx = {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

const handler: CallHandler = { handle: () => of("ok") };

function make(incr: jest.Mock, limit = 3, windowSec = 60): ApiRateLimitInterceptor {
  process.env.API_RATE_LIMIT = String(limit);
  process.env.API_RATE_WINDOW_SEC = String(windowSec);
  return new ApiRateLimitInterceptor({ incr } as unknown as RedisService);
}

afterEach(() => {
  delete process.env.API_RATE_LIMIT;
  delete process.env.API_RATE_WINDOW_SEC;
});

describe("ApiRateLimitInterceptor", () => {
  it("counts a PAT request, sets X-RateLimit headers and passes through when under the limit", async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const { ctx, headers } = ctxFor({ userId: "u1", scopes: ["read"], tokenId: "tok1" });
    const out = await lastValueFrom(await make(incr).intercept(ctx, handler));
    expect(out).toBe("ok");
    expect(incr).toHaveBeenCalledWith(expect.stringMatching(/^api:rl:tok1:\d+$/), 60);
    expect(headers["X-RateLimit-Limit"]).toBe("3");
    expect(headers["X-RateLimit-Remaining"]).toBe("2"); // limit 3 - count 1
    expect(headers["X-RateLimit-Reset"]).toMatch(/^\d+$/);
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("rejects with 429 + Retry-After once the token exceeds the limit", async () => {
    const incr = jest.fn().mockResolvedValue(4); // limit 3 → 4 is over
    const { ctx, headers } = ctxFor({ userId: "u1", scopes: ["read"], tokenId: "tok1" });
    // intercept() itself rejects (before returning an observable) on an over-limit request.
    await expect(make(incr).intercept(ctx, handler)).rejects.toBeInstanceOf(HttpException);
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("does NOT rate-limit a browser session (no tokenId) or a public route (no user)", async () => {
    const incr = jest.fn();
    for (const user of [{ userId: "u1", scopes: ["*"] }, undefined]) {
      const { ctx, headers } = ctxFor(user);
      expect(await lastValueFrom(await make(incr).intercept(ctx, handler))).toBe("ok");
      expect(headers["X-RateLimit-Limit"]).toBeUndefined();
    }
    expect(incr).not.toHaveBeenCalled();
  });

  it("fails OPEN — a Redis error allows the request and reports full remaining", async () => {
    const incr = jest.fn().mockRejectedValue(new Error("redis down"));
    const { ctx, headers } = ctxFor({ userId: "u1", scopes: ["read"], tokenId: "tok1" });
    expect(await lastValueFrom(await make(incr).intercept(ctx, handler))).toBe("ok");
    expect(headers["X-RateLimit-Remaining"]).toBe("3"); // full budget on fail-open
  });

  it("fails OPEN when Redis HANGS (offline queue never settles) — the timeout races it to allow", async () => {
    jest.useFakeTimers();
    try {
      const incr = jest.fn().mockReturnValue(new Promise<number>(() => {})); // never settles
      const { ctx, headers } = ctxFor({ userId: "u1", scopes: ["read"], tokenId: "tok1" });
      const pending = make(incr).intercept(ctx, handler);
      await jest.advanceTimersByTimeAsync(400); // fire the internal Redis-timeout
      const out = await lastValueFrom(await pending);
      expect(out).toBe("ok");
      expect(headers["X-RateLimit-Remaining"]).toBe("3"); // allowed with full budget
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips non-HTTP contexts", async () => {
    const incr = jest.fn();
    const ctx = { getType: () => "ws" } as unknown as ExecutionContext;
    expect(await lastValueFrom(await make(incr).intercept(ctx, handler))).toBe("ok");
    expect(incr).not.toHaveBeenCalled();
  });
});
