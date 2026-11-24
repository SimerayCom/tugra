import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CoolifyControl, GuardedHttpTransport } from "./coolify-control";
import { GuardedHttpGet } from "./guarded-get";
import { AUTH_401_TRIP, LimitsRegistry, type Clock } from "./request-limits";

// The SSRF guard refuses loopback by design, which is the only place a spec can listen: replace just the guard so the REAL
// transports (header extraction, redirect and body handling) run against a local socket.
jest.mock("./ssrf-guard", () => ({
  assertAllowedUrl: (raw: string) => new URL(raw),
  guardedLookup: undefined,
}));

class FakeClock implements Clock {
  t = 1_700_000_000_000;
  slept: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.slept.push(ms);
    this.t += ms;
  }
}

type Handler = (method: string, url: string) => { status: number; headers?: Record<string, string>; body?: unknown };

let server: Server;
let base: string;
let handler: Handler;
const seen: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    const out = handler(req.method ?? "", req.url ?? "");
    res.writeHead(out.status, { "Content-Type": "application/json", ...out.headers });
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
});

describe("real POST transport", () => {
  it("sends a JSON body with its length and parses the JSON answer", async () => {
    let received = "";
    const orig = handler;
    server.once("request", (req) => {
      req.on("data", (c) => (received += c));
    });
    handler = (method) => ({ status: method === "POST" ? 200 : 405, body: { token: "t" } });
    const client = new GuardedHttpGet(base, { apiPrefix: "/api", label: "X", headers: () => ({}) });
    await expect(client.postJson("/login", { identity: "a", password: "b" })).resolves.toEqual({ token: "t" });
    expect(seen[0]).toEqual({ method: "POST", url: "/api/login" });
    expect(JSON.parse(received)).toEqual({ identity: "a", password: "b" });
    handler = orig;
  });

  it("still refuses a redirect on a POST", async () => {
    handler = () => ({ status: 302, headers: { Location: "http://127.0.0.1:1/" } });
    const client = new GuardedHttpGet(base, { apiPrefix: "/api", label: "X", headers: () => ({}) });
    await expect(client.postJson("/login", {})).rejects.toThrow(/redirect/);
  });
});

describe("real GET transport", () => {
  it("reads the Retry-After header off a 429 (not the 10 s default) and retries", async () => {
    let n = 0;
    handler = () => (n++ === 0 ? { status: 429, headers: { "Retry-After": "7" }, body: { message: "Too many" } } : { status: 200, body: [{ uuid: "a" }] });
    const clock = new FakeClock();
    const http = new GuardedHttpGet(base, {
      apiPrefix: "/api/v1",
      label: "Coolify",
      headers: () => ({ Authorization: "Bearer t-get" }),
      limits: new LimitsRegistry(clock).for(base, "t-get"),
    });
    await expect(http.get("/servers")).resolves.toEqual([{ uuid: "a" }]);
    expect(clock.slept).toEqual([7_000]);
    expect(seen.map((s) => s.url)).toEqual(["/api/v1/servers", "/api/v1/servers"]);
  });

  it("refuses a redirect", async () => {
    handler = () => ({ status: 302, headers: { Location: "http://127.0.0.1:1/x" } });
    const http = new GuardedHttpGet(base, { apiPrefix: "/api/v1", label: "Coolify", headers: () => ({}) });
    await expect(http.get("/servers")).rejects.toThrow(/redirect/);
  });
});

describe("real control transport", () => {
  it("reads the Retry-After header off a 429 and retries the POST", async () => {
    let n = 0;
    handler = () => (n++ === 0 ? { status: 429, headers: { "Retry-After": "4" }, body: { message: "Too many" } } : { status: 200, body: { message: "ok" } });
    const clock = new FakeClock();
    const control = new CoolifyControl(new GuardedHttpTransport(base, "t-ctl", new LimitsRegistry(clock).for(base, "t-ctl")));
    await control.stop("application", "abc");
    expect(clock.slept).toEqual([4_000]);
    expect(seen).toEqual([
      { method: "POST", url: "/api/v1/applications/abc/stop?docker_cleanup=false" },
      { method: "POST", url: "/api/v1/applications/abc/stop?docker_cleanup=false" },
    ]);
  });

  it("a locally paused token is the retryable rate-limited code, not forbidden/unauthorized", async () => {
    handler = () => ({ status: 401, body: { message: "Unauthenticated." } });
    const clock = new FakeClock();
    const control = new CoolifyControl(new GuardedHttpTransport(base, "t-bad", new LimitsRegistry(clock).for(base, "t-bad")));
    for (let i = 0; i < AUTH_401_TRIP; i++) await expect(control.state("application", "abc")).rejects.toMatchObject({ code: "unauthorized" });
    const before = seen.length;
    await expect(control.state("application", "abc")).rejects.toMatchObject({ code: "rate-limited" });
    await expect(control.stop("application", "abc")).rejects.toMatchObject({ code: "rate-limited" });
    expect(seen.length).toBe(before); // nothing was sent while paused
  });

  it("a POST 404 retried as GET that answers 405 stays not-found (the 4.7.5 shape)", async () => {
    handler = (method) =>
      method === "POST"
        ? { status: 404, body: { message: "Resource not found." } }
        : { status: 405, headers: { Allow: "POST" }, body: { message: "This endpoint has changed to a POST request." } };
    const control = new CoolifyControl(new GuardedHttpTransport(base, "t-nf", new LimitsRegistry(new FakeClock()).for(base, "t-nf")));
    await expect(control.start("database", "gone")).rejects.toMatchObject({ code: "not-found" });
    expect(seen.map((s) => s.method)).toEqual(["POST", "GET"]);
  });
});
