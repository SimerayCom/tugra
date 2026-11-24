import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { largeJsonBody } from "./large-json";

function fakeReq(method: string, url: string, body: string, type = "application/json") {
  const r = Readable.from([Buffer.from(body)]) as unknown as Record<string, unknown>;
  r.method = method;
  r.url = url;
  r.headers = { "content-type": type };
  r.destroy = jest.fn();
  return r;
}
function fakeRes() {
  const res = { statusCode: 200, headers: {} as Record<string, string>, ended: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b: string) { this.ended = b; } };
  return res;
}
const run = (mw: ReturnType<typeof largeJsonBody>, req: unknown, res = fakeRes()) =>
  new Promise<{ next: boolean; res: ReturnType<typeof fakeRes>; req: Record<string, unknown> }>((resolve) => {
    let called = false;
    mw(req as never, res as unknown as ServerResponse, () => {
      called = true;
      resolve({ next: true, res, req: req as Record<string, unknown> });
    });
    setTimeout(() => !called && resolve({ next: false, res, req: req as Record<string, unknown> }), 50);
  });

describe("largeJsonBody", () => {
  const mw = largeJsonBody("/api/v1/monitors/import/kuma/", 1000);

  it("parses a JSON POST under the prefix and marks it parsed", async () => {
    const out = await run(mw, fakeReq("POST", "/api/v1/monitors/import/kuma/preview?x=1", '{"a":1}'));
    expect(out.next).toBe(true);
    expect(out.req.body).toEqual({ a: 1 });
    expect(out.req._body).toBe(true);
  });

  it("ignores other paths, methods and content types", async () => {
    for (const req of [
      fakeReq("POST", "/api/v1/monitors", '{"a":1}'),
      fakeReq("GET", "/api/v1/monitors/import/kuma/preview", ""),
      fakeReq("POST", "/api/v1/monitors/import/kuma/preview", "x", "text/plain"),
    ]) {
      const out = await run(mw, req);
      expect(out.next).toBe(true);
      expect(out.req.body).toBeUndefined();
    }
  });

  it("answers 413 beyond the cap and does not continue", async () => {
    const out = await run(mw, fakeReq("POST", "/api/v1/monitors/import/kuma/apply", JSON.stringify({ a: "x".repeat(2000) })));
    expect(out.next).toBe(false);
    expect(out.res.statusCode).toBe(413);
  });

  it("answers 400 for invalid JSON", async () => {
    const out = await run(mw, fakeReq("POST", "/api/v1/monitors/import/kuma/apply", "{nope"));
    expect(out.next).toBe(false);
    expect(out.res.statusCode).toBe(400);
  });
});
