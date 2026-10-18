import { lastValueFrom, of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import {
  PaginationInterceptor,
  parseLimit,
  parseCursor,
  encodeCursor,
} from "./pagination.interceptor";

describe("pagination parse helpers", () => {
  it("parseLimit accepts a positive integer string and clamps to 200", () => {
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("500")).toBe(200); // clamp
    expect(parseLimit("200")).toBe(200);
  });
  it("parseLimit rejects everything non-integer-string → null (no pagination)", () => {
    for (const bad of ["0", "-1", "1.5", "1e3", "0x10", "abc", "", "  ", undefined, null, 10, ["1", "2"], { x: 1 }]) {
      expect(parseLimit(bad as unknown)).toBeNull();
    }
  });
  it("cursor round-trips and decodes defensively", () => {
    expect(parseCursor(encodeCursor(40))).toBe(40);
    expect(parseCursor(encodeCursor(0))).toBe(0);
    for (const bad of ["", "!!!!", "bm90YW51bWJlcg", undefined, null, 5, "a".repeat(80)]) {
      expect(parseCursor(bad as unknown)).toBe(0);
    }
  });
});

function ctxOf(opts: {
  type?: string;
  method?: string;
  query?: Record<string, unknown>;
  res?: { headersSent?: boolean; setHeader: jest.Mock };
}): ExecutionContext {
  const req = { method: opts.method ?? "GET", query: opts.query ?? {} };
  const res = opts.res ?? { headersSent: false, setHeader: jest.fn() };
  return {
    getType: () => opts.type ?? "http",
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const nextOf = (body: unknown): CallHandler => ({ handle: () => of(body) });
const reflectorOf = (paginated: boolean): Reflector =>
  ({ getAllAndOverride: () => paginated }) as unknown as Reflector;

describe("PaginationInterceptor", () => {
  const list = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }));

  const run = (reflector: Reflector, ctx: ExecutionContext, body: unknown) =>
    lastValueFrom(new PaginationInterceptor(reflector).intercept(ctx, nextOf(body)));

  it("passes through when the handler is NOT @Paginated", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const out = await run(reflectorOf(false), ctxOf({ query: { limit: "10" }, res }), list);
    expect(out).toBe(list);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("passes through on a non-GET method even when marked", async () => {
    const out = await run(reflectorOf(true), ctxOf({ method: "POST", query: { limit: "10" } }), list);
    expect(out).toBe(list);
  });

  it("passes through for a non-http context", async () => {
    const out = await run(reflectorOf(true), ctxOf({ type: "ws", query: { limit: "10" } }), list);
    expect(out).toBe(list);
  });

  it("marked + NO ?limit → full list unchanged, no headers (non-breaking)", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const out = await run(reflectorOf(true), ctxOf({ query: {}, res }), list);
    expect(out).toBe(list);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("marked + invalid ?limit → full list unchanged (lenient)", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const out = await run(reflectorOf(true), ctxOf({ query: { limit: "abc" }, res }), list);
    expect(out).toBe(list);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("marked + valid ?limit → first page + headers incl. X-Next-Cursor", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const out = (await run(reflectorOf(true), ctxOf({ query: { limit: "10" }, res }), list)) as unknown[];
    expect(out).toHaveLength(10);
    expect((out[0] as { id: string }).id).toBe("r0");
    expect(res.setHeader).toHaveBeenCalledWith("X-Total-Count", "25");
    expect(res.setHeader).toHaveBeenCalledWith("X-Limit", "10");
    const nextCall = res.setHeader.mock.calls.find((c) => c[0] === "X-Next-Cursor");
    expect(nextCall).toBeTruthy();
    expect(parseCursor(nextCall![1])).toBe(10);
  });

  it("the cursor walks to the exact last page, and the last page has NO X-Next-Cursor", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    // page 3 with limit 10 → offset 20 → items r20..r24 (5 items), no next cursor.
    const out = (await run(
      reflectorOf(true),
      ctxOf({ query: { limit: "10", cursor: encodeCursor(20) }, res }),
      list,
    )) as unknown[];
    expect(out.map((x) => (x as { id: string }).id)).toEqual(["r20", "r21", "r22", "r23", "r24"]);
    expect(res.setHeader).toHaveBeenCalledWith("X-Total-Count", "25");
    expect(res.setHeader.mock.calls.find((c) => c[0] === "X-Next-Cursor")).toBeFalsy();
  });

  it("an offset past the end returns [] with the total and no next cursor", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const out = (await run(
      reflectorOf(true),
      ctxOf({ query: { limit: "10", cursor: encodeCursor(999) }, res }),
      list,
    )) as unknown[];
    expect(out).toEqual([]);
    expect(res.setHeader).toHaveBeenCalledWith("X-Total-Count", "25");
    expect(res.setHeader.mock.calls.find((c) => c[0] === "X-Next-Cursor")).toBeFalsy();
  });

  it("leaves a NON-array body untouched (e.g. an audit page envelope)", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const envelope = { items: [1, 2, 3], cursor: "x" };
    const out = await run(reflectorOf(true), ctxOf({ query: { limit: "2" }, res }), envelope);
    expect(out).toBe(envelope);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("does nothing if headers were already sent", async () => {
    const res = { headersSent: true, setHeader: jest.fn() };
    const out = await run(reflectorOf(true), ctxOf({ query: { limit: "10" }, res }), list);
    expect(out).toBe(list);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("passes through a non-GET (e.g. HEAD) method", async () => {
    const out = await run(reflectorOf(true), ctxOf({ method: "HEAD", query: { limit: "10" } }), list);
    expect(out).toBe(list);
  });

  it("clamps an over-cap ?limit and echoes the effective value in X-Limit", async () => {
    const res = { headersSent: false, setHeader: jest.fn() };
    const out = (await run(reflectorOf(true), ctxOf({ query: { limit: "500" }, res }), list)) as unknown[];
    expect(out).toHaveLength(25); // list has 25 < clamp(200), so all returned
    expect(res.setHeader).toHaveBeenCalledWith("X-Limit", "200");
    expect(res.setHeader.mock.calls.find((c) => c[0] === "X-Next-Cursor")).toBeFalsy();
  });

  it("following X-Next-Cursor walks every page exactly once (no skip/dup)", async () => {
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const res = { headersSent: false, setHeader: jest.fn() };
      const page = (await run(
        reflectorOf(true),
        ctxOf({ query: { limit: "7", ...(cursor ? { cursor } : {}) }, res }),
        list,
      )) as unknown[];
      collected.push(...page);
      const next = res.setHeader.mock.calls.find((c) => c[0] === "X-Next-Cursor");
      if (!next) break;
      cursor = next[1] as string;
    }
    expect(collected).toEqual(list); // concatenation of all pages === original, in order
  });
});
