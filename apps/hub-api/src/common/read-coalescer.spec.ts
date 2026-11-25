import { ReadCoalescer, ckey, setKey } from "./read-coalescer";
import { CoalesceInvalidateInterceptor } from "./coalesce.module";
import { of, throwError, lastValueFrom } from "rxjs";

describe("ReadCoalescer", () => {
  afterEach(() => jest.useRealTimers());

  it("shares one in-flight computation between concurrent callers", async () => {
    const c = new ReadCoalescer();
    let n = 0;
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++n), 20));
    const [a, b, d] = await Promise.all([c.run("k", slow), c.run("k", slow), c.run("k", slow)]);
    expect([a, b, d]).toEqual([1, 1, 1]);
    expect(n).toBe(1);
  });

  it("reuses the result inside the TTL and recomputes after it", async () => {
    jest.useFakeTimers({ now: 1_000 });
    const c = new ReadCoalescer();
    const fn = jest.fn(async () => Date.now());
    const first = await c.run("k", fn);
    jest.setSystemTime(2_000);
    expect(await c.run("k", fn)).toBe(first); // 1000 ms old
    jest.setSystemTime(3_000);
    expect(await c.run("k", fn)).toBe(3_000); // 2000 ms old > 1500
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never mixes different keys (different permitted sets)", async () => {
    const c = new ReadCoalescer();
    const a = await c.run(`fleet:latest:${setKey(["s1", "s2"])}`, async () => "team A rows");
    const b = await c.run(`fleet:latest:${setKey(["s3"])}`, async () => "team B rows");
    expect(a).toBe("team A rows");
    expect(b).toBe("team B rows");
  });

  it("setKey ignores order but not membership", () => {
    expect(setKey(["a", "b"])).toBe(setKey(["b", "a"]));
    expect(setKey(["a", "b"])).not.toBe(setKey(["a"]));
    expect(setKey(["ab", "c"])).not.toBe(setKey(["a", "bc"]));
  });

  it("does not cache errors", async () => {
    const c = new ReadCoalescer();
    await expect(c.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await c.run("k", async () => "ok")).toBe("ok");
  });

  it("invalidate drops stored results and stops an in-flight one from being stored", async () => {
    const c = new ReadCoalescer();
    await c.run("k", async () => 1);
    c.invalidate();
    expect(await c.run("k", async () => 2)).toBe(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inflight = c.run("j", async () => { await gate; return "old"; });
    c.invalidate(); // a write lands while the read is running
    release();
    expect(await inflight).toBe("old"); // its own callers still get it ...
    expect(await c.run("j", async () => "new")).toBe("new"); // ... but nobody after the write does
  });

  it("hashes very long keys and bounds the table", async () => {
    const c = new ReadCoalescer();
    await c.run("x".repeat(5000), async () => 1);
    for (let i = 0; i < 600; i++) await c.run(`k${i}`, async () => i);
    expect(c.size).toBeLessThanOrEqual(400);
  });
});

describe("CoalesceInvalidateInterceptor", () => {
  const ctx = (method: string) => ({ getType: () => "http", switchToHttp: () => ({ getRequest: () => ({ method }) }) }) as never;

  it("invalidates before and after a write, leaves reads alone", async () => {
    const c = new ReadCoalescer();
    const spy = jest.spyOn(c, "invalidate");
    const i = new CoalesceInvalidateInterceptor(c);
    await lastValueFrom(i.intercept(ctx("GET"), { handle: () => of(1) }));
    expect(spy).not.toHaveBeenCalled();
    await lastValueFrom(i.intercept(ctx("POST"), { handle: () => of(1) }));
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(lastValueFrom(i.intercept(ctx("DELETE"), { handle: () => throwError(() => new Error("x")) }))).rejects.toThrow("x");
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe("ckey", () => {
  it("never merges two different filters through a ':' inside a value", () => {
    expect(ckey("servers", "list", "u1", "a:b", "")).not.toBe(ckey("servers", "list", "u1", "a", "b"));
    expect(ckey("x", null, undefined, 3)).toBe("x:::3");
  });
});
