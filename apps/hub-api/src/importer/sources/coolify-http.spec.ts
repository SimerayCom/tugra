import { CoolifyHttpClient, classifyCoolify403, coolifyErrorHint } from "./coolify-http";
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

// The real Coolify 4.7.5 403 bodies (app/Http/Middleware: ApiAllowed, ApiIpAllowed, ApiAbility, EnsureTokenBelongsToCurrentTeamMember).
const BODY_IP = { success: false, message: "You are not allowed to access the API." };
const BODY_DISABLED = { success: false, message: "API is disabled." };
const BODY_SCOPED = { message: "This API token is limited to selected projects, environments, or resources, so it cannot use this endpoint." };
const BODY_EXCEEDS = { message: "This API token has more access than you have in this team. Revoke it and create a new token." };
const BODY_ABILITY = { message: "Missing required permissions: read" };

const build = (answers: RawGetResponse[], egressIp?: () => Promise<string | null>) => {
  const clock = new FakeClock();
  const seen: Array<{ url: string; auth: string }> = [];
  let i = 0;
  const client = new CoolifyHttpClient("https://coolify.example.com", "secret-token", {
    limits: new LimitsRegistry(clock).for("https://coolify.example.com", "secret-token"),
    egressIp,
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

describe("Coolify 4xx messages and the single matching 403 cause", () => {
  const fail = async (status: number, b: unknown, egress?: () => Promise<string | null>) => {
    const err = await build([json(status, b)], egress).client.get("/servers").catch((e: unknown) => e as Error);
    return (err as Error).message;
  };

  it("keeps the message in the error and names Allowed IPs plus this hub's egress IP", async () => {
    const m = await fail(403, BODY_IP, async () => "203.0.113.7");
    expect(m).toMatch(/^Coolify API error 403: "You are not allowed to access the API\." \(/);
    expect(m).toContain("203.0.113.7");
    expect(m).toContain("Settings > Advanced > Allowed IPs");
    expect(m).toMatch(/reverse proxy or Cloudflare/);
    expect(m).toMatch(/real client IP/);
    // ONE cause only
    expect(m).not.toMatch(/API is enabled|selected projects|more access|admin or owner/);
  });

  it("with the egress IP unknown or its lookup failing, the hint still says where to find it and the error is the same", async () => {
    for (const egress of [async () => null, async () => { throw new Error("db down"); }, undefined]) {
      const m = await fail(403, BODY_IP, egress);
      expect(m).toContain('"You are not allowed to access the API."');
      expect(m).toMatch(/import wizard/);
      expect(m).toContain("Allowed IPs");
    }
  });

  it("API disabled, scoped token, more-access and missing-ability each get exactly their own hint", async () => {
    const disabled = await fail(403, BODY_DISABLED);
    expect(disabled).toMatch(/: "API is disabled\." \(the API is switched off/);
    expect(disabled).not.toMatch(/Allowed IPs|selected projects/);

    const scoped = await fail(403, BODY_SCOPED);
    expect(scoped).toMatch(/limited to selected projects or environments/);
    expect(scoped).toMatch(/whole team/);
    expect(scoped).not.toMatch(/Allowed IPs|switched off/);

    const exceeds = await fail(403, BODY_EXCEEDS);
    expect(exceeds).toMatch(/more access than its creator now has/);
    expect(exceeds).not.toMatch(/Allowed IPs|selected projects/);

    const ability = await fail(403, BODY_ABILITY);
    expect(ability).toMatch(/Missing required permissions: read/);
    expect(ability).toMatch(/lacks an ability/);
    expect(ability).not.toMatch(/Allowed IPs|selected projects/);
  });

  it("an unrecognised 403 message falls back to listing every cause, with the message kept", async () => {
    const m = await fail(403, { message: "Forbidden by policy." });
    expect(m).toContain('"Forbidden by policy."');
    expect(m).toMatch(/Allowed IPs/);
    expect(m).toMatch(/selected projects or environments/);
  });

  it("the egress IP is only looked up for a 403", async () => {
    const egress = jest.fn(async () => "203.0.113.7");
    await fail(404, { message: "Not found." }, egress);
    await fail(401, { message: "Unauthenticated." }, egress);
    expect(egress).not.toHaveBeenCalled();
  });

  it("other 4xx keep their message (a 404 / 422 reason) and 5xx do not", async () => {
    expect(await fail(404, { message: "Application not found." })).toBe('Coolify API error 404: "Application not found."');
    expect(await fail(422, { message: "Validation failed.", errors: { name: ["x"] } })).toBe('Coolify API error 422: "Validation failed."');
    expect(await fail(500, { message: "Server Error: SQLSTATE[HY000] at /var/www/html/secret.php" })).toBe("Coolify API error 500");
  });

  it("the token and anything shaped like one never reach the message", async () => {
    const m = await fail(403, { message: "Token secret-token is invalid; 12|abcdefghijklmnopqrstuvwxyz0123456789ABCD" });
    expect(m).not.toContain("secret-token");
    expect(m).not.toContain("abcdefghijklmnop");
    expect(m).toContain("[redacted]");
  });

  it("a non-JSON or messageless body adds nothing", async () => {
    const { client } = build([{ status: 403, body: Buffer.from("<html>Forbidden</html>") }]);
    await expect(client.get("/servers")).rejects.toThrow(/^Coolify API error 403 \(token valid but not authorized/);
  });

  it("classifyCoolify403 maps each real body and anything else to unknown", () => {
    expect(classifyCoolify403(BODY_IP.message)).toBe("allowed-ips");
    expect(classifyCoolify403(BODY_DISABLED.message)).toBe("api-disabled");
    expect(classifyCoolify403(BODY_SCOPED.message)).toBe("scoped-token");
    expect(classifyCoolify403(BODY_EXCEEDS.message)).toBe("exceeds-access");
    expect(classifyCoolify403(BODY_ABILITY.message)).toBe("ability");
    expect(classifyCoolify403("This API token is limited to selected projects, environments, or resources, so it cannot use th…")).toBe("scoped-token"); // the ~100-char cut
    expect(classifyCoolify403("")).toBe("unknown");
    expect(classifyCoolify403(null)).toBe("unknown");
    expect(classifyCoolify403("nope")).toBe("unknown");
  });

  it("the paused-after-401 message still carries the status and the 401 hint", async () => {
    const { client } = build([json(401, { message: "Unauthenticated." })]);
    for (let i = 0; i < AUTH_401_TRIP; i++) await client.get("/servers").catch(() => undefined);
    await expect(client.get("/servers")).rejects.toThrow(/API error 401 \(check the API token.*paused/);
  });
});
