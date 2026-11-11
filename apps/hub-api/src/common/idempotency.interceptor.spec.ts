import { CallHandler, ConflictException, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, throwError, Subject } from "rxjs";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";

const PENDING = "\u0000pending";
// Mock crypto: a prefix so tests can see the payload is encrypted before it reaches Redis.
const enc = (s: string) => `enc:${s}`;
const dec = (s: string) => s.replace(/^enc:/, "");
const crypto = { encrypt: enc, decrypt: dec } as unknown as CryptoService;

const isScript = (c: unknown[], needle: string) => typeof c[0] === "string" && (c[0] as string).includes(needle);

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

function make(redis: Partial<{ client: { set: jest.Mock; eval?: jest.Mock }; get: jest.Mock; set: jest.Mock; del: jest.Mock }>) {
  const client = redis.client ?? { set: jest.fn() };
  if (!(client as { eval?: jest.Mock }).eval) (client as { eval: jest.Mock }).eval = jest.fn().mockResolvedValue(1);
  const r = {
    client,
    get: redis.get ?? jest.fn(),
    set: redis.set ?? jest.fn().mockResolvedValue(undefined),
    del: redis.del ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisService;
  return { interceptor: new IdempotencyInterceptor(r, crypto), redis: r, evalMock: (client as { eval: jest.Mock }).eval };
}

const handlerOf = (body: unknown): CallHandler => ({ handle: () => of(body) });

describe("IdempotencyInterceptor", () => {
  it("first request claims an OWNED lease (SET NX, PENDING:<token>, short TTL) and stores the ENCRYPTED result on its own key", async () => {
    const setClient = jest.fn().mockResolvedValue("OK");
    const { interceptor, evalMock } = make({ client: { set: setClient } });
    const { ctx } = ctxFor({ key: "k1", statusCode: 201 });
    const out = await lastValueFrom(await interceptor.intercept(ctx, handlerOf({ id: "a1" })));
    expect(out).toEqual({ id: "a1" });
    const [claimKey, claimVal, ...claimRest] = setClient.mock.calls[0];
    expect(claimKey).toMatch(/^idem:/);
    expect(claimVal).toMatch(/^\u0000pending:/); // an owned lease, never a bare PENDING
    expect(claimRest).toEqual(["EX", 120, "NX"]); // short claim TTL
    // result stored via a compare-and-SET guarded on OUR claim value (only if we still own the key)
    const storeCall = evalMock.mock.calls.find((c) => isScript(c, "'set'"));
    expect(storeCall).toBeDefined();
    expect(storeCall![1]).toBe(1); // one key
    expect(storeCall![2]).toMatch(/^idem:/); // KEYS[1]
    expect(storeCall![3]).toBe(claimVal); // ARGV[1] = our token → ownership guard
    expect((storeCall![4] as string).startsWith("enc:")).toBe(true); // ARGV[2] encrypted at rest, never plaintext
    expect(JSON.parse(dec(storeCall![4] as string))).toEqual({ status: 201, body: { id: "a1" } });
    expect(storeCall![5]).toBe("86400"); // ARGV[3] result lives 24h
  });

  it("captures the DYNAMIC status and does NOT cache a non-2xx — releases the key (compare-and-DEL on our token)", async () => {
    const setClient = jest.fn().mockResolvedValue("OK");
    const { interceptor, evalMock } = make({ client: { set: setClient } });
    const { ctx } = ctxFor({ key: "k1", statusCode: 429 }); // e.g. a handler that set res.status(429)
    await lastValueFrom(await interceptor.intercept(ctx, handlerOf({ error: "rate limited" })));
    expect(evalMock.mock.calls.some((c) => isScript(c, "'set'"))).toBe(false); // never cached
    const delCall = evalMock.mock.calls.find((c) => isScript(c, "'del'"));
    expect(delCall).toBeDefined();
    expect(delCall![3]).toMatch(/^\u0000pending:/); // only deletes if the key is still OURS
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

  it("409s a retry while the first is still in flight (the stored value is a PENDING:<token> lease)", async () => {
    const setClient = jest.fn().mockResolvedValue(null);
    const get = jest.fn().mockResolvedValue(`${PENDING}:some-other-token`);
    const { interceptor } = make({ client: { set: setClient }, get });
    const { ctx } = ctxFor({ key: "k1" });
    await expect(interceptor.intercept(ctx, handlerOf({}))).rejects.toBeInstanceOf(ConflictException);
  });

  it("re-claims (never runs UNGUARDED) when the claim expired between NX and GET; 409 if another request took it", async () => {
    // A: first NX fails (key exists), GET is null (expired in the gap), the re-claim NX succeeds → we own it,
    //    so the handler runs ONCE under a lease (the old code ran it with no claim at all).
    const setA = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    const getA = jest.fn().mockResolvedValue(null);
    const { interceptor: iA } = make({ client: { set: setA }, get: getA });
    const handlerA = { handle: jest.fn(() => of({ id: "x" })) } as unknown as CallHandler;
    const outA = await lastValueFrom(await iA.intercept(ctxFor({ key: "k1", statusCode: 201 }).ctx, handlerA));
    expect(outA).toEqual({ id: "x" });
    expect(handlerA.handle).toHaveBeenCalledTimes(1);
    expect(setA).toHaveBeenCalledTimes(2); // claim + re-claim (both NX)

    // B: first NX fails, GET null, the re-claim NX ALSO fails → another request owns it now → 409.
    const setB = jest.fn().mockResolvedValue(null);
    const getB = jest.fn().mockResolvedValue(null);
    const { interceptor: iB } = make({ client: { set: setB }, get: getB });
    await expect(iB.intercept(ctxFor({ key: "k1" }).ctx, handlerOf({}))).rejects.toBeInstanceOf(ConflictException);
  });

  it("extends the claim via a heartbeat while a long handler runs, and stops when it settles", async () => {
    jest.useFakeTimers();
    try {
      const setClient = jest.fn().mockResolvedValue("OK");
      const { interceptor, evalMock } = make({ client: { set: setClient } });
      const subj = new Subject<unknown>();
      const obs = await interceptor.intercept(ctxFor({ key: "k1", statusCode: 201 }).ctx, { handle: () => subj.asObservable() });
      const sub = obs.subscribe({ error: () => {} });
      // advance past one heartbeat while the handler is still running → an EXTEND (compare-and-expire) fired
      await jest.advanceTimersByTimeAsync(41_000);
      const extendsWhileRunning = evalMock.mock.calls.filter((c) => isScript(c, "expire")).length;
      expect(extendsWhileRunning).toBeGreaterThanOrEqual(1);
      // settle the handler → heartbeat torn down, result stored, no more EXTENDs
      subj.next({ id: "a1" });
      subj.complete();
      await jest.advanceTimersByTimeAsync(130_000);
      expect(evalMock.mock.calls.filter((c) => isScript(c, "expire")).length).toBe(extendsWhileRunning);
      expect(evalMock.mock.calls.some((c) => isScript(c, "'set'"))).toBe(true); // result stored on completion
      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
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

  it("releases the key when the handler errors (compare-and-DEL) so the client can retry", async () => {
    const setClient = jest.fn().mockResolvedValue("OK");
    const { interceptor, evalMock } = make({ client: { set: setClient } });
    const { ctx } = ctxFor({ key: "k1" });
    const handler: CallHandler = { handle: () => throwError(() => new Error("boom")) };
    await expect(lastValueFrom(await interceptor.intercept(ctx, handler))).rejects.toThrow("boom");
    expect(evalMock.mock.calls.some((c) => isScript(c, "'del'"))).toBe(true);
  });

  it("refuses (409) rather than running UNGUARDED when GET fails after NX said the key exists", async () => {
    const setClient = jest.fn().mockResolvedValue(null); // key exists
    const get = jest.fn().mockRejectedValue(new Error("redis read blip"));
    const { interceptor } = make({ client: { set: setClient }, get });
    const handler = { handle: jest.fn() } as unknown as CallHandler;
    await expect(interceptor.intercept(ctxFor({ key: "k1" }).ctx, handler)).rejects.toBeInstanceOf(ConflictException);
    expect(handler.handle).not.toHaveBeenCalled(); // never double-executes on an unreadable-but-present key
  });

  it("drops a corrupt/undecryptable stored result and re-runs UNDER A LEASE (not unguarded)", async () => {
    const setClient = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("OK"); // exists, then re-claim wins
    const get = jest.fn().mockResolvedValue("not-valid-json-after-decrypt"); // decrypt→parse throws
    const del = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = make({ client: { set: setClient }, get, del });
    const handler = { handle: jest.fn(() => of({ id: "re" })) } as unknown as CallHandler;
    const out = await lastValueFrom(await interceptor.intercept(ctxFor({ key: "k1", statusCode: 201 }).ctx, handler));
    expect(out).toEqual({ id: "re" });
    expect(del).toHaveBeenCalled(); // corrupt result removed
    expect(handler.handle).toHaveBeenCalledTimes(1); // re-run, once, with a fresh lease
    expect(setClient).toHaveBeenCalledTimes(2); // claim + re-claim
  });

  it("stops the heartbeat on handler error (finalize) and does not keep extending", async () => {
    jest.useFakeTimers();
    try {
      const setClient = jest.fn().mockResolvedValue("OK");
      const { interceptor, evalMock } = make({ client: { set: setClient } });
      const subj = new Subject<unknown>();
      const obs = await interceptor.intercept(ctxFor({ key: "k1" }).ctx, { handle: () => subj.asObservable() });
      const sub = obs.subscribe({ error: () => {} });
      await jest.advanceTimersByTimeAsync(41_000); // one heartbeat while running
      const extendsBefore = evalMock.mock.calls.filter((c) => isScript(c, "expire")).length;
      expect(extendsBefore).toBeGreaterThanOrEqual(1);
      subj.error(new Error("boom")); // handler fails → finalize clears the interval, DEL releases the key
      await jest.advanceTimersByTimeAsync(130_000);
      expect(evalMock.mock.calls.filter((c) => isScript(c, "expire")).length).toBe(extendsBefore); // no more EXTENDs
      expect(evalMock.mock.calls.some((c) => isScript(c, "'del'"))).toBe(true); // released on error
      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });
});
