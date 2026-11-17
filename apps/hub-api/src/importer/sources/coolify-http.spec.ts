import { CoolifyHttpClient, coolifyErrorHint } from "./coolify-http";
import { LimitsRegistry, RateLimitedError, AUTH_401_TRIP, type Clock } from "./request-limits";
import type { RawGetResponse } from "./guarded-get";

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

const json = (status: number, body: unknown, retryAfter?: string): RawGetResponse => ({ status, retryAfter: retryAfter ?? null, body: Buffer.from(JSON.stringify(body)) });

const build = (answers: RawGetResponse[]) => {
  const clock = new FakeClock();
  const seen: Array<{ url: string; auth: string }> = [];
  let i = 0;
  const client = new CoolifyHttpClient("https://coolify.example.com", "secret-token", {
    limits: new LimitsRegistry(clock).for("https://coolify.example.com", "secret-token"),
    transport: async (url, headers) => {
      seen.push({ url: url.pathname, auth: headers.Authorization });
      return answers[Math.min(i++, answers.length - 1)];
    },
  });
  return { client, clock, seen };
};

describe("CoolifyHttpClient 429 handling", () => {
  it("honours Retry-After and returns the retried answer", async () => {
    const { client, clock, seen } = build([json(429, { message: "Too Many Attempts." }, "3"), json(200, [{ uuid: "a" }])]);
    await expect(client.get("/servers")).resolves.toEqual([{ uuid: "a" }]);
    expect(clock.slept).toEqual([3_000]);
    expect(seen.map((s) => s.url)).toEqual(["/api/v1/servers", "/api/v1/servers"]);
    expect(seen[0].auth).toBe("Bearer secret-token");
  });

  it("getText is retried the same way", async () => {
    const { client } = build([json(429, {}, "1"), { status: 200, body: Buffer.from("4.7.5") }]);
    await expect(client.getText("/version")).resolves.toBe("4.7.5");
  });

  it("a persistent 429 ends in the stable rate-limited error, never a body or token", async () => {
    const { client } = build([json(429, { message: "secret-token leaked" }, "1")]);
    const err = (await client.get("/servers").catch((e: unknown) => e)) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.code).toBe("rate-limited");
    expect(err.message).toContain("429");
    expect(err.message).not.toContain("secret-token");
  });

  it("a lockout-length Retry-After fails at once without waiting", async () => {
    const { client, clock, seen } = build([json(429, {}, "900")]);
    await expect(client.get("/servers")).rejects.toMatchObject({ code: "rate-limited", retryAfterSec: 900 });
    expect(clock.slept).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("stops sending after repeated 401s and keeps the status in the message", async () => {
    const { client, seen } = build([json(401, { message: "Unauthenticated." })]);
    for (let i = 0; i < AUTH_401_TRIP; i++) await expect(client.get("/servers")).rejects.toThrow(/API error 401/);
    await expect(client.get("/servers")).rejects.toThrow(/API error 401.*paused/);
    expect(seen).toHaveLength(AUTH_401_TRIP);
  });

  it("the other statuses are unchanged: 403 carries the hint, 404 and 5xx pass through", async () => {
    await expect(build([json(403, {})]).client.get("/servers")).rejects.toThrow(/API error 403 \(token valid but not authorized/);
    await expect(build([json(404, {})]).client.get("/x")).rejects.toThrow(/^Coolify API error 404$/);
    await expect(build([json(500, {})]).client.get("/x")).rejects.toThrow(/^Coolify API error 500$/);
  });

  it("a non-JSON 200 is still reported", async () => {
    const { client } = build([{ status: 200, body: Buffer.from("<html>") }]);
    await expect(client.get("/servers")).rejects.toThrow(/non-JSON/);
  });
});

describe("coolifyErrorHint", () => {
  it("401 names an invalid/revoked token or a creator who left the team", () => {
    expect(coolifyErrorHint(401)).toMatch(/invalid or revoked/);
    expect(coolifyErrorHint(401)).toMatch(/left the team/);
  });
  it("403 lists every cause Coolify 4.7.5 uses", () => {
    const h = coolifyErrorHint(403);
    expect(h).toMatch(/API is enabled/);
    expect(h).toMatch(/Allowed IPs/);
    expect(h).toMatch(/this hub/);
    expect(h).toMatch(/admin or owner/);
    expect(h).toMatch(/limited to selected projects or environments/);
    expect(h).toMatch(/\/servers/);
    expect(h).toMatch(/more access than you have in this team/);
  });
  it("429 names the 200/min limit and other statuses add nothing", () => {
    expect(coolifyErrorHint(429)).toMatch(/200 requests a minute/);
    expect(coolifyErrorHint(500)).toBe("");
  });
});
