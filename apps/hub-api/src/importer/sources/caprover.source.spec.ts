import { CaproverSource, type CaproverClient } from "./caprover.source";
import { CaproverHttpClient, caproverLogin } from "./caprover-http";
import type { RawGetResponse, RawTransport } from "./guarded-get";
import { CAPROVER_SENTINELS, caproverAppsAnswer } from "../__fixtures__/caprover.fixture";

const APPS_PATH = "/v2/user/apps/appDefinitions";
const fake = (answer: unknown = caproverAppsAnswer()): { client: CaproverClient; get: jest.Mock } => {
  const get = jest.fn(async (path: string) => {
    if (path !== APPS_PATH) throw new Error(`404 ${path}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { client: { get } as CaproverClient, get };
};

describe("CaproverSource", () => {
  it("is API-only: no ssh, no dump, no volume read", () => {
    expect(new CaproverSource(fake().client).capabilities()).toEqual({ apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false });
  });

  it("verify: ok on an app list, a clear detail on a wrong URL or a failure", async () => {
    await expect(new CaproverSource(fake().client).verify()).resolves.toEqual({ ok: true });
    const odd = await new CaproverSource(fake({ nope: 1 }).client).verify();
    expect(odd).toMatchObject({ ok: false });
    expect(odd.detail).toMatch(/dashboard address/);
    const bad = await new CaproverSource(fake(new Error("CapRover API error 401 (check the dashboard password)")).client).verify();
    expect(bad).toEqual({ ok: false, detail: "CapRover API error 401 (check the dashboard password)" });
  });

  it("probe counts apps and databases from one read", async () => {
    const { client, get } = fake();
    const src = new CaproverSource(client);
    await expect(src.probe()).resolves.toEqual({ apps: 5, databases: 2, services: 0, sensitive: null });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("discover maps the whole answer and never carries a secret", async () => {
    const fleet = await new CaproverSource(fake().client).discover();
    expect(fleet.apps.map((a) => a.sourceRef).sort()).toEqual(["api", "blog", "pg-pool", "uploader"]);
    expect(fleet.databases.map((d) => d.sourceRef).sort()).toEqual(["cache", "db"]);
    const text = JSON.stringify(fleet);
    for (const s of CAPROVER_SENTINELS) expect(text).not.toContain(s);
  });

  it("discover re-reads so a plan reflects the source now, while the secret reads reuse the read", async () => {
    const { client, get } = fake();
    const src = new CaproverSource(client);
    await src.discover();
    await src.fetchSecrets("api");
    await src.fetchDbCredentials("db");
    await src.fetchBasicAuthCredentials("uploader");
    expect(get).toHaveBeenCalledTimes(1);
    await src.discover();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("a failed discover is an error (bad login or URL), not an empty fleet", async () => {
    await expect(new CaproverSource(fake(new Error("CapRover API error 401 (x)")).client).discover()).rejects.toThrow(/401/);
  });

  it("a failed read is not cached: the next call tries again", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(caproverAppsAnswer());
    const src = new CaproverSource({ get } as CaproverClient);
    await expect(src.fetchSecrets("api")).rejects.toThrow("boom");
    await expect(src.fetchSecrets("api")).resolves.toMatchObject({ values: { NODE_ENV: "production" } });
  });

  describe("secret path (server-side only)", () => {
    const src = () => new CaproverSource(fake().client);

    it("fetchSecrets returns the real env values on a null-prototype map; an unknown ref yields none", async () => {
      const r = await src().fetchSecrets("api");
      expect(r.values.DATABASE_URL).toBe("postgres://app:DBPW_SENTINEL@srv-captain--db:5432/app");
      expect(Object.getPrototypeOf(r.values)).toBeNull();
      expect(r.unresolved).toEqual([]);
      expect(Object.keys((await src().fetchSecrets("nope")).values)).toEqual([]);
    });

    it("fetchDbCredentials reads the engine's env; undefined for an unknown ref or a database with no password", async () => {
      await expect(src().fetchDbCredentials("db")).resolves.toEqual({ user: "app", password: "DBPW_SENTINEL", rootPassword: undefined, database: "app" });
      await expect(src().fetchDbCredentials("cache")).resolves.toBeUndefined();
      await expect(src().fetchDbCredentials("nope")).resolves.toBeUndefined();
    });

    it("fetchBasicAuthCredentials returns the app's http auth, undefined when it has none", async () => {
      await expect(src().fetchBasicAuthCredentials("uploader")).resolves.toEqual([{ user: "admin", password: "HTTPPW_SENTINEL" }]);
      await expect(src().fetchBasicAuthCredentials("api")).resolves.toBeUndefined();
    });
  });
});

// ── transport: login + auth errors ─────────────────────────────────────────────────────────────────────

const answer = (status: number, body: unknown): RawGetResponse => ({ status, retryAfter: null, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });
const recorder = (res: RawGetResponse) => {
  const calls: Array<{ url: URL; headers: Record<string, string>; init?: { method?: string; body?: string } }> = [];
  const transport: RawTransport = async (url, headers, init) => {
    calls.push({ url, headers, init });
    return res;
  };
  return { calls, transport };
};
const BASE = "https://captain.example.com";

describe("caproverLogin", () => {
  it("posts the password once to /api/v2/login with the captain namespace and returns the token", async () => {
    const { calls, transport } = recorder(answer(200, { status: 100, description: "Login succeeded", data: { token: "SESSION_TOKEN_SENTINEL" } }));
    await expect(caproverLogin(BASE, "dash-pw", transport)).resolves.toBe("SESSION_TOKEN_SENTINEL");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe("https://captain.example.com/api/v2/login");
    expect(calls[0].init).toEqual({ method: "POST", body: JSON.stringify({ password: "dash-pw" }) });
    expect(calls[0].headers["x-namespace"]).toBe("captain");
    expect(calls[0].headers["x-captain-auth"]).toBeUndefined();
  });

  it.each([1105, 1106, 1102])("a wrong password (envelope status %i) is a 401 that never echoes the password", async (status) => {
    const { transport } = recorder(answer(200, { status, description: "Password is incorrect: dash-pw" }));
    const err = await caproverLogin(BASE, "dash-pw", transport).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^CapRover API error 401 /);
    expect((err as Error).message).not.toContain("dash-pw");
  });

  it("an http 401 is the same refusal; a 429 asks to wait", async () => {
    const e401 = await caproverLogin(BASE, "x", recorder(answer(401, {})).transport).catch((e: Error) => e);
    expect((e401 as Error).message).toMatch(/^CapRover API error 401 \(check the dashboard password/);
    const e429 = await caproverLogin(BASE, "x", recorder(answer(429, {})).transport).catch((e: Error) => e);
    expect((e429 as Error).message).toMatch(/^CapRover API error 429 \(rate limited/);
  });

  it("an HTML page (not a CapRover) and an answer without a token are plain errors", async () => {
    await expect(caproverLogin(BASE, "x", recorder(answer(200, "<html>hi</html>")).transport)).rejects.toThrow(/non-JSON/);
    await expect(caproverLogin(BASE, "x", recorder(answer(200, { status: 100, data: {} })).transport)).rejects.toThrow(/did not return a login token/);
    await expect(caproverLogin(BASE, "x", recorder(answer(200, { hello: 1 })).transport)).rejects.toThrow(/unexpected response/);
  });

  it("refuses a redirect-free private target before sending the password", async () => {
    const transport = jest.fn();
    await expect(caproverLogin("http://169.254.169.254/", "x", transport as never)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("CaproverHttpClient", () => {
  it("sends the login token in x-captain-auth with the namespace, and returns the envelope data", async () => {
    const { calls, transport } = recorder(answer(200, { status: 100, data: { appDefinitions: [] } }));
    const client = new CaproverHttpClient(BASE, "TOK", transport);
    await expect(client.get(APPS_PATH)).resolves.toEqual({ appDefinitions: [] });
    expect(calls[0].url.href).toBe("https://captain.example.com/api/v2/user/apps/appDefinitions");
    expect(calls[0].headers).toMatchObject({ "x-captain-auth": "TOK", "x-namespace": "captain" });
  });

  it("an expired or invalid token (envelope 1106, or http 401/403) says to connect again", async () => {
    for (const res of [answer(200, { status: 1106, description: "token expired" }), answer(401, {}), answer(403, {})]) {
      const err = await new CaproverHttpClient(BASE, "TOK", recorder(res).transport).get(APPS_PATH).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/^CapRover API error (401|403) \(check the dashboard password; connect again/);
      expect((err as Error).message).not.toContain("TOK");
    }
  });

  it("another envelope error keeps only the status number", async () => {
    const err = await new CaproverHttpClient(BASE, "TOK", recorder(answer(200, { status: 1000, description: "internal path /root/x" })).transport).get(APPS_PATH).catch((e: Error) => e);
    expect((err as Error).message).toBe("CapRover API error 400 (CapRover status 1000)");
  });
});
