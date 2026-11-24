import { BeszelClient, BeszelError } from "./beszel-client";
import type { RawGetResponse, RawTransport } from "../importer/sources/guarded-get";

const json = (status: number, body: unknown): RawGetResponse => ({ status, body: Buffer.from(JSON.stringify(body)) });

function fake(routes: Array<[RegExp, (url: URL, headers: Record<string, string>, body?: string) => RawGetResponse]>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const transport: RawTransport = async (url, headers, init) => {
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET", headers, body: init?.body });
    const hit = routes.find(([re]) => re.test(url.pathname));
    if (!hit) return json(404, { message: "not found" });
    return hit[1](url, headers, init?.body);
  };
  return { transport, calls };
}

describe("BeszelClient.login", () => {
  it("posts the credentials as JSON to the users collection and keeps the token for later calls", async () => {
    const { transport, calls } = fake([
      [/collections\/users\/auth-with-password$/, () => json(200, { token: "tok123" })],
      [/collections\/systems\/records$/, (_u, h) => json(200, { items: h.Authorization === "tok123" ? [{ id: "s1", name: "n", host: "h", status: "up" }] : [], totalPages: 1 })],
      [/collections\/alerts\/records$/, () => json(200, { items: [], totalPages: 1 })],
      [/collections\/user_settings\/records$/, () => json(200, { items: [], totalPages: 1 })],
    ]);
    const c = new BeszelClient("https://beszel.example.com/", { transport });
    await c.login("me@example.com", "pw");
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/collections/users/auth-with-password" });
    expect(JSON.parse(calls[0].body!)).toEqual({ identity: "me@example.com", password: "pw" });
    expect((await c.snapshot()).systems).toHaveLength(1);
  });

  it("falls back to a superuser and then reports bad credentials without echoing the password", async () => {
    const { transport, calls } = fake([
      [/collections\/users\/auth-with-password$/, () => json(400, { message: "Failed to authenticate." })],
      [/_superusers\/auth-with-password$/, () => json(400, { message: "Failed to authenticate." })],
    ]);
    const c = new BeszelClient("https://beszel.example.com", { transport });
    const err = await c.login("me@example.com", "s3cret-pw").catch((e) => e);
    expect(err).toBeInstanceOf(BeszelError);
    expect(err.code).toBe("badCredentials");
    expect(String(err.message)).not.toContain("s3cret-pw");
    expect(calls.map((x) => x.url)).toEqual(["/api/collections/users/auth-with-password", "/api/collections/_superusers/auth-with-password"]);
  });

  it("logs in through _superusers when the users collection refuses", async () => {
    const { transport } = fake([
      [/collections\/users\/auth-with-password$/, () => json(400, { message: "x" })],
      [/_superusers\/auth-with-password$/, () => json(200, { token: "su" })],
    ]);
    await expect(new BeszelClient("https://beszel.example.com", { transport }).login("a", "b")).resolves.toBeUndefined();
  });

  it("says it is not a Beszel hub when the users collection is missing", async () => {
    const { transport } = fake([]);
    const err = await new BeszelClient("https://example.com", { transport }).login("a", "b").catch((e) => e);
    expect(err.code).toBe("notBeszel");
  });

  it("refuses loopback and metadata addresses before any request", () => {
    expect(() => new BeszelClient("http://127.0.0.1:8090")).toThrow();
    expect(() => new BeszelClient("http://169.254.169.254")).toThrow();
  });
});

describe("BeszelClient reads", () => {
  const authed = async (routes: Parameters<typeof fake>[0]) => {
    const f = fake([[/auth-with-password$/, () => json(200, { token: "t" })], ...routes]);
    const c = new BeszelClient("https://beszel.example.com", { transport: f.transport });
    await c.login("a", "b");
    return { c, ...f };
  };

  it("merges webhooks and emails of every settings row and tolerates missing settings access", async () => {
    const { c } = await authed([
      [/systems\/records$/, () => json(200, { items: [], totalPages: 1 })],
      [/alerts\/records$/, () => json(200, { items: [{ id: "a", system: "s", name: "CPU", value: 80, min: 5 }, { id: "", system: "s", name: "x" }], totalPages: 1 })],
      [/user_settings\/records$/, () => json(200, { items: [{ settings: { webhooks: ["a://x", " a://x "], emails: ["e@example.com"] } }, { settings: { webhooks: ["b://y"] } }], totalPages: 1 })],
    ]);
    const snap = await c.snapshot();
    expect(snap.alerts).toEqual([{ id: "a", system: "s", name: "CPU", value: 80, min: 5 }]);
    expect(snap.webhooks.sort()).toEqual(["a://x", "b://y"]);
    expect(snap.emails).toEqual(["e@example.com"]);
    const { c: c2 } = await authed([
      [/systems\/records$/, () => json(200, { items: [], totalPages: 1 })],
      [/alerts\/records$/, () => json(200, { items: [], totalPages: 1 })],
      [/user_settings\/records$/, () => json(403, { message: "no" })],
    ]);
    expect((await c2.snapshot()).webhooks).toEqual([]);
  });

  it("pages through a collection", async () => {
    const items = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, name: "n", host: "h", status: "up" }));
    const { c, calls } = await authed([
      [/systems\/records$/, (u) => (u.searchParams.get("page") === "1" ? json(200, { items: items(200, 0), totalPages: 2 }) : json(200, { items: items(5, 200), totalPages: 2 }))],
      [/alerts\/records$/, () => json(200, { items: [], totalPages: 1 })],
      [/user_settings\/records$/, () => json(200, { items: [], totalPages: 1 })],
    ]);
    expect((await c.snapshot()).systems).toHaveLength(205);
    expect(calls.filter((x) => x.url.includes("systems/records")).length).toBe(2);
  });

  it("asks for stats of one system by resolution and never interpolates an odd id into the filter", async () => {
    const { c, calls } = await authed([[/system_stats\/records$/, () => json(200, { items: [{ created: "2026-11-20 10:00:00.000Z", type: "480m", stats: { cpu: 3 } }], totalPages: 1 })]]);
    const rows = await c.stats("abc123", ["1m", "480m"]);
    expect(rows).toEqual([{ created: "2026-11-20 10:00:00.000Z", type: "480m", stats: { cpu: 3 } }]);
    const q = decodeURIComponent(calls[calls.length - 1].url.replace(/\+/g, " "));
    expect(q).toContain("system='abc123' && (type='1m' || type='480m')");
    expect(await c.stats("x' || 1=1 || '", ["1m"])).toEqual([]);
  });
});
