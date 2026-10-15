import { CallHandler, ConflictException, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";

const PENDING = "\u0000pending";
// Mock crypto: a prefix so tests can see the payload is encrypted before it reaches Redis.
const enc = (s: string) => `enc:${s}`;
const dec = (s: string) => s.replace(/^enc:/, "");
const crypto = { encrypt: enc, decrypt: dec } as unknown as CryptoService;

function ctxFor(opts: { method?: string; key?: string; userId?: string; statusCode?: number; tokenId?: string } = {}): {
  ctx: ExecutionContext;
  status: jest.Mock;
} {
  const status = jest.fn();
  const req = {
    method: opts.method ?? "POST",
    headers: opts.key ? { "idempotency-key": opts.key } : {},
    user: opts.userId === null ? undefined : { userId: opts.userId ?? "u1", tokenId: opts.tokenId },
    originalUrl: "/api/v1/apps/app1/deploy?x=1",
    body: { a: 1 },
  };
  const ctx = {
    getType: () => "http",
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ status, statusCode: opts.statusCode ?? 201 }) }),
  } as unknown as ExecutionContext;
  return { ctx, status };
}

function make(redis: Partial<{ client: { set: jest.Mock }; get: jest.Mock; set: jest.Mock; del: jest.Mock }>) {
  const r = {
    client: redis.client ?? { set: jest.fn() },
    get: redis.get ?? jest.fn(),
    set: redis.set ?? jest.fn().mockResolvedValue(undefined),
    del: redis.del ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisService;
  return { interceptor: new IdempotencyInterceptor(r, crypto), redis: r };
}

const handlerOf = (body: unknown): CallHandler => ({ handle: () => of(body) });

describe("IdempotencyInterceptor", () => {
  it("first request claims the key (SET NX, short TTL) and stores the ENCRYPTED {status, body}", async () => {
    const setClient = jest.fn().mockResolvedValue("OK");
    const { interceptor, redis } = make({ client: { set: setClient } });
    const { ctx } = ctxFor({ key: "k1", statusCode: 201 });
    const out = await lastValueFrom(await interceptor.intercept(ctx, handlerOf({ id: "a1" })));
    expect(out).toEqual({ id: "a1" });
    expect(setClient.mock.calls[0]).toEqual([expect.stringMatching(/^idem:/), PENDING, "EX", 120, "NX"]); // short claim TTL
    const [, payload, resultTtl] = (redis.set as jest.Mock).mock.calls[0];
    expect(payload.startsWith("enc:")).toBe(true); // encrypted at rest, never plaintext
    expect(JSON.parse(dec(payload))).toEqual({ status: 201, body: { id: "a1" } });
    expect(resultTtl).toBe(86400); // result lives 24h
  });

  it("captures the DYNAMIC response status and does NOT cache a non-2xx (releases the key)", async () => {
    const setClient = jest.fn().mockResolvedValue("OK");
    const del = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn();
    const { interceptor } = make({ client: { set: setClient }, del, set });
    const { ctx } = ctxFor({ key: "k1", statusCode: 429 }); // e.g. a handler that set res.status(429)
    await lastValueFrom(await interceptor.intercept(ctx, handlerOf({ error: "rate limited" })));
    expect(set).not.toHaveBeenCalled(); // never cached
    expect(del).toHaveBeenCalled(); // key released so a retry re-runs
  });

  it("replays the stored result on a retry (handler NOT run) with the original status", async () => {
    const setClient = jest.fn().mockResolvedValue(null); // key already exists
    const get = jest.fn().mockResolvedValue(enc(JSON.stringify({ status: 201, body: { id: "a1" } })));
    const { interceptor } = make({ client: { set: setClient }, get });
    const { ctx, status } = ctxFor({ key: "k1" });
    const handler = { handle: jest.fn() } as unknown as CallHandler;
    const out = await lastValueFrom(await interceptor.intercept(ctx, handler));
    expect(out).toEqual({ id: "a1" });
    expect(status).toHaveBeenCalledWith(201);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it("409s a second request while the first is still in flight", async () => {
    const setClient = jest.fn().mockResolvedValue(null);
    const get = jest.fn().mockResolvedValue(PENDING);
    const { interceptor } = make({ client: { set: setClient }, get });
    const { ctx } = ctxFor({ key: "k1" });
    await expect(interceptor.intercept(ctx, handlerOf({}))).rejects.toBeInstanceOf(ConflictException);
  });

  it("scopes the key to the credential — a different tokenId produces a different Redis key", async () => {
    const setA = jest.fn().mockResolvedValue("OK");
    const setB = jest.fn().mockResolvedValue("OK");
    await lastValueFrom(await make({ client: { set: setA } }).interceptor.intercept(ctxFor({ key: "k1", tokenId: "tokA" }).ctx, handlerOf({})));
    await lastValueFrom(await make({ client: { set: setB } }).interceptor.intercept(ctxFor({ key: "k1", tokenId: "tokB" }).ctx, handlerOf({})));
    expect(setA.mock.calls[0][0]).not.toBe(setB.mock.calls[0][0]); // different token → different key
  });

  it("passes through with no Idempotency-Key, on a non-POST, and with no user — never touching Redis", async () => {
    const setClient = jest.fn();
    for (const opts of [{ key: undefined }, { key: "k1", method: "GET" }, { key: "k1", userId: null as unknown as string }]) {
      const { interceptor } = make({ client: { set: setClient } });
      const { ctx } = ctxFor(opts);
      expect(await lastValueFrom(await interceptor.intercept(ctx, handlerOf("ok")))).toBe("ok");
    }
    expect(setClient).not.toHaveBeenCalled();
  });

  it("fails OPEN when the Redis claim errors — the request runs normally", async () => {
    const setClient = jest.fn().mockRejectedValue(new Error("redis down"));
    const { interceptor } = make({ client: { set: setClient } });
    const { ctx } = ctxFor({ key: "k1" });
    expect(await lastValueFrom(await interceptor.intercept(ctx, handlerOf("ran")))).toBe("ran");
  });

  it("releases the key when the handler errors so the client can retry", async () => {
    const setClient = jest.fn().mockResolvedValue("OK");
    const del = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = make({ client: { set: setClient }, del });
    const { ctx } = ctxFor({ key: "k1" });
    const handler: CallHandler = { handle: () => throwError(() => new Error("boom")) };
    await expect(lastValueFrom(await interceptor.intercept(ctx, handler))).rejects.toThrow("boom");
    expect(del).toHaveBeenCalled();
  });
});
