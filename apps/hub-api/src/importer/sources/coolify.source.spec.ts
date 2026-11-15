import { CoolifySource, mapLimit, type CoolifyClient } from "./coolify.source";

class FakeClient implements CoolifyClient {
  calls: string[] = [];
  constructor(private routes: Record<string, unknown>) {}
  async get<T>(path: string): Promise<T> {
    this.calls.push(path);
    if (!(path in this.routes)) throw new Error(`404 ${path}`);
    const v = this.routes[path];
    if (v instanceof Error) throw v;
    return v as T;
  }
}

describe("CoolifySource", () => {
  describe("verify", () => {
    it("ok when /servers returns an array", async () => {
      const src = new CoolifySource(new FakeClient({ "/servers": [] }));
      await expect(src.verify()).resolves.toEqual({ ok: true });
    });
    it("not ok (with detail) when the request fails or the shape is wrong", async () => {
      await expect(new CoolifySource(new FakeClient({ "/servers": new Error("401 Unauthorized") })).verify()).resolves.toMatchObject({ ok: false, detail: expect.stringContaining("401") });
      await expect(new CoolifySource(new FakeClient({ "/servers": { not: "an array" } })).verify()).resolves.toMatchObject({ ok: false });
    });
  });

  describe("discover", () => {
    const client = new FakeClient({
      "/servers": [{ uuid: "srv-a", name: "box", ip: "1.2.3.4" }],
      "/servers/srv-a/resources": [{ uuid: "app-1" }, { uuid: "db-1" }],
      "/applications": [{ uuid: "app-1", name: "web", build_pack: "nixpacks", git_repository: "o/r", git_branch: "main", ports_exposes: "3000", fqdn: "https://web.example.com" }],
      "/databases": [{ uuid: "db-1", name: "orders", database_type: "standalone-postgresql", image: "postgres:16", postgres_user: "u", postgres_db: "orders" }],
      "/services": [{ uuid: "svc-1" }],
      "/services/svc-1": { uuid: "svc-1", name: "stack", service_type: "plausible", applications: [{ uuid: "sa-1" }], databases: [{ uuid: "sd-1" }] },
      // the /envs list merges a preview twin of SECRET_KEY — it must be filtered, not doubled
      "/applications/app-1/envs": [{ key: "SECRET_KEY" }, { key: "SERVICE_FQDN_WEB", is_coolify: true }, { key: "SECRET_KEY", is_preview: true }],
      "/applications/app-1/storages": [{ name: "web-data", mount_path: "/data", host_path: null }],
      // the REAL Coolify /storages shape: { persistent_storages, file_storages }
      "/databases/db-1/storages": { persistent_storages: [{ name: "pg-data", mount_path: "/var/lib/postgresql/data", host_path: null }], file_storages: [] },
    });

    it("enumerates the fleet, maps resources, derives placement, de-dupes preview envs, loads service members", async () => {
      const src = new CoolifySource(client);
      const fleet = await src.discover();
      expect(fleet.servers).toEqual([{ ref: "srv-a", name: "box", ip: "1.2.3.4" }]);
      expect(fleet.apps[0]).toMatchObject({ sourceRef: "app-1", kind: "git", buildPack: "nixpacks", serverRef: "srv-a", ports: [3000] });
      expect(fleet.apps[0].env!.map((e) => e.key)).toEqual(["SECRET_KEY", "SERVICE_FQDN_WEB"]); // preview twin dropped
      expect(fleet.apps[0].volumes).toEqual([{ name: "web-data", hostPath: undefined, mountPath: "/data", type: "named", ownerRef: "app-1" }]);
      expect(fleet.databases[0]).toMatchObject({ sourceRef: "db-1", engine: "POSTGRES", serverRef: "srv-a", credentials: { username: "u", database: "orders", secretRef: "db-1" } });
      // the real-shaped {persistent_storages} /storages response was unwrapped
      expect(fleet.databases[0].volumes).toEqual([{ name: "pg-data", hostPath: undefined, mountPath: "/var/lib/postgresql/data", type: "named", ownerRef: "db-1" }]);
      // service members came from the /services/{uuid} detail fetch
      expect(fleet.services[0]).toMatchObject({ sourceRef: "svc-1", templateSlug: "plausible", memberApps: ["sa-1"], memberDbs: ["sd-1"] });
    });

    it("never carries a secret value in the discovered fleet", async () => {
      const fleet = await new CoolifySource(client).discover();
      expect(JSON.stringify(fleet)).not.toMatch(/password/i);
    });

    it("degrades gracefully when a per-resource endpoint 404s (partial fleet, no throw)", async () => {
      const partial = new FakeClient({
        "/servers": [{ uuid: "srv-a" }],
        // no /servers/srv-a/resources, no /services, no envs/storages → all safe()-fallback
        "/applications": [{ uuid: "app-1", name: "web", build_pack: "nixpacks", git_repository: "o/r" }],
        "/databases": [],
      });
      const fleet = await new CoolifySource(partial).discover();
      expect(fleet.apps).toHaveLength(1);
      expect(fleet.apps[0].serverRef).toBeUndefined(); // placement unknown without the resources call
      expect(fleet.apps[0].env).toEqual([]);
      // the failed enrichment calls are surfaced honestly, not silently swallowed
      expect(fleet.warnings.length).toBeGreaterThan(0);
      expect(fleet.warnings.some((w) => /import plan may be incomplete/.test(w))).toBe(true);
    });
  });

  describe("fetchSecrets (read:sensitive env resolution)", () => {
    it("returns resolved values (real_value preferred) and reports unresolvable keys", async () => {
      const client = new FakeClient({
        "/applications/app-1/envs": [
          { key: "PLAIN", value: "v1" },
          { key: "SHARED", is_shared: true, value: "{{team.X}}", real_value: "resolved-x" }, // real_value wins
          { key: "LOCKED", is_shown_once: true }, // no value exposed even to sensitive tokens → unresolved
          { key: "PLAIN", value: "preview-copy", is_preview: true }, // preview twin → skipped
        ],
      });
      const res = await new CoolifySource(client).fetchSecrets("app-1");
      expect(res.values).toEqual({ PLAIN: "v1", SHARED: "resolved-x" });
      expect(res.unresolved.map((e) => e.key)).toEqual(["LOCKED"]);
    });

    it("keeps a dangerous key like __proto__ as a real entry (null-proto values), never silently dropped", async () => {
      const client = new FakeClient({ "/applications/app-1/envs": [{ key: "__proto__", real_value: "x" }, { key: "NORMAL", value: "y" }] });
      const res = await new CoolifySource(client).fetchSecrets("app-1");
      expect(Object.keys(res.values).sort()).toEqual(["NORMAL", "__proto__"]);
      expect(res.values["__proto__"]).toBe("x");
      expect(res.unresolved).toEqual([]);
    });

    it("reports every key unresolved when the token lacks read:sensitive (no values returned)", async () => {
      const client = new FakeClient({ "/applications/app-1/envs": [{ key: "A" }, { key: "B", is_shared: true }] });
      const res = await new CoolifySource(client).fetchSecrets("app-1");
      expect(res.values).toEqual({});
      expect(res.unresolved.map((e) => e.key).sort()).toEqual(["A", "B"]);
    });

    it("capabilities are read-only (api)", () => {
      expect(new CoolifySource(new FakeClient({})).capabilities()).toEqual({ apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false });
    });
  });
});

describe("mapLimit", () => {
  it("preserves order and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]); // order preserved
    expect(peak).toBeLessThanOrEqual(3); // bounded concurrency
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it("handles an empty list without spawning work", async () => {
    const fn = jest.fn();
    expect(await mapLimit([], 8, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("CoolifySource.fetchSecrets — per-variable flags", () => {
  it("fills flags from the same row, carries a multiline value, and omits flags when the rows carry none", async () => {
    const withFlags = new CoolifySource(
      new FakeClient({
        "/applications/app-1/envs": [
          { key: "PEM", value: "l1\nl2", is_multiline: true, is_literal: true },
          { key: "API", value: "v", is_buildtime: true, is_runtime: false },
          { key: "PLAIN", value: "p" },
        ],
      }),
    );
    const res = await withFlags.fetchSecrets("app-1");
    expect(res.values.PEM).toBe("l1\nl2");
    expect(res.flags).toEqual({ PEM: { multiline: true, literal: true }, API: { buildTime: true, runtime: false } });
    const none = await new CoolifySource(new FakeClient({ "/applications/app-1/envs": [{ key: "PLAIN", value: "p" }] })).fetchSecrets("app-1");
    expect(none.flags).toBeUndefined();
  });
});

describe("CoolifySource.fetchAppExtras", () => {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  // Hand-built Coolify v4 shape; field names/encodings UNVERIFIED until the live lab check (spec G3-C section 11).
  const row = (over: Record<string, unknown>) => ({ uuid: "app-1", name: "web", build_pack: "dockerfile", ...over });

  it("does ONE GET of the application and decodes labels + the Dockerfile for a dockerfile app", async () => {
    const client = new FakeClient({ "/applications/app-1": row({ custom_labels: b64("traefik.enable=true\nteam=core"), dockerfile: "FROM node:20\nCMD [\"x\"]\n" }) });
    const extras = await new CoolifySource(client).fetchAppExtras("app-1");
    expect(client.calls).toEqual(["/applications/app-1"]);
    expect(extras).toEqual({ unmapped: [], labels: [{ key: "traefik.enable", value: "true" }, { key: "team", value: "core" }], dockerfile: "FROM node:20\nCMD [\"x\"]\n" });
  });

  it("falls back to dockerfile_raw when dockerfile is empty", async () => {
    const client = new FakeClient({ "/applications/app-1": row({ dockerfile: "", dockerfile_raw: "FROM x" }) });
    expect((await new CoolifySource(client).fetchAppExtras("app-1"))?.dockerfile).toBe("FROM x");
  });

  it("reads the Dockerfile only for build_pack dockerfile", async () => {
    const client = new FakeClient({ "/applications/app-1": row({ build_pack: "nixpacks", dockerfile: "FROM x" }) });
    expect((await new CoolifySource(client).fetchAppExtras("app-1"))?.dockerfile).toBeUndefined();
  });

  it("an unparsable label block becomes a fixed unmapped note, never an error", async () => {
    const client = new FakeClient({ "/applications/app-1": row({ custom_labels: "just words with no pairs" }) });
    expect(await new CoolifySource(client).fetchAppExtras("app-1")).toEqual({ unmapped: [{ field: "customLabels", reason: "the label block could not be parsed" }] });
  });

  it("a plain-token response with the text stripped yields an empty result", async () => {
    const client = new FakeClient({ "/applications/app-1": row({ custom_labels: null, dockerfile: null }) });
    expect(await new CoolifySource(client).fetchAppExtras("app-1")).toEqual({ unmapped: [] });
  });

  it("a non-object response gives undefined; a client error propagates", async () => {
    expect(await new CoolifySource(new FakeClient({ "/applications/app-1": "oops" })).fetchAppExtras("app-1")).toBeUndefined();
    await expect(new CoolifySource(new FakeClient({ "/applications/app-1": new Error("403 Forbidden") })).fetchAppExtras("app-1")).rejects.toThrow("403");
  });

  it("encodes the ref in the path", async () => {
    const client = new FakeClient({ "/applications/a%2Fb": row({}) });
    await new CoolifySource(client).fetchAppExtras("a/b");
    expect(client.calls).toEqual(["/applications/a%2Fb"]);
  });
});
