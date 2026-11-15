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

    it("reports a dangerous key like __proto__ in invalidKeys (strict mode) instead of carrying it; values stay null-proto", async () => {
      const client = new FakeClient({ "/applications/app-1/envs": [{ key: "__proto__", real_value: "x" }, { key: "NORMAL", value: "y" }] });
      const res = await new CoolifySource(client).fetchSecrets("app-1");
      expect(Object.keys(res.values)).toEqual(["NORMAL"]);
      expect(res.invalidKeys).toEqual(["__proto__"]);
      expect(res.unresolved).toEqual([]);
      expect(Object.getPrototypeOf(res.values)).toBeNull();
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
    expect(await new CoolifySource(client).fetchAppExtras("app-1")).toMatchObject({ unmapped: [{ field: "customLabels", reason: "the label block could not be parsed" }] });
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

describe("CoolifySource.discover — strict env report (names + reason codes, never values)", () => {
  const base = {
    "/servers": [{ uuid: "srv-a" }],
    "/servers/srv-a/resources": [{ uuid: "app-1" }, { uuid: "app-2" }],
    "/applications": [
      { uuid: "app-1", name: "web", build_pack: "nixpacks", git_repository: "o/r" },
      { uuid: "app-2", name: "api", build_pack: "nixpacks", git_repository: "o/r2" },
    ],
    "/databases": [],
    "/services": [],
    "/applications/app-1/storages": [],
    "/applications/app-2/storages": [],
  };

  it("builds envReport per app from the same /envs read (preview twins counted, values dropped, shared-unexpanded flagged)", async () => {
    const client = new FakeClient({
      ...base,
      "/applications/app-1/envs": [
        { key: "DATABASE_URL", value: "postgres://u:hunter2@h/db", real_value: "postgres://u:hunter2@h/db" },
        { key: "SHARED", value: "{{team.SHARED}}", real_value: "{{team.SHARED}}", is_shared: true },
        { key: "BAD KEY", value: "x" },
        { key: "DATABASE_URL", value: "postgres://u:preview@h/db", is_preview: true },
      ],
      "/applications/app-2/envs": [{ key: "A" }, { key: "B", is_coolify: true }],
    });
    const fleet = await new CoolifySource(client).discover();
    const web = fleet.apps.find((a) => a.sourceRef === "app-1")!;
    const api = fleet.apps.find((a) => a.sourceRef === "app-2")!;
    expect(web.envReport).toEqual({ total: 3, previewSkipped: 1, unresolved: [{ key: "SHARED", reason: "SHARED_UNEXPANDED" }], invalidKeys: ["BAD KEY"], tokenReadOnly: false });
    expect(api.envReport).toEqual({ total: 2, previewSkipped: 0, unresolved: [{ key: "A", reason: "NO_VALUE" }, { key: "B", reason: "MAGIC" }], invalidKeys: [], tokenReadOnly: true });
    // no extra GET: exactly one /envs read per app
    expect(client.calls.filter((c) => c.endsWith("/envs"))).toHaveLength(2);
    const json = JSON.stringify(fleet);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("preview@h");
  });

  it("a per-app envs fetch failure omits envReport and adds a fixed warning — never silently clean", async () => {
    const client = new FakeClient({ ...base, "/applications/app-1/envs": new Error("502 boom"), "/applications/app-2/envs": [{ key: "OK", value: "v" }] });
    const fleet = await new CoolifySource(client).discover();
    expect(fleet.apps.find((a) => a.sourceRef === "app-1")!.envReport).toBeUndefined();
    expect(fleet.apps.find((a) => a.sourceRef === "app-2")!.envReport).toMatchObject({ total: 1, tokenReadOnly: false });
    expect(fleet.warnings).toContain("env: could not read variables for web");
    expect(fleet.warnings.join("\n")).not.toContain("502");
  });

  it("runs the env reads with bounded concurrency", async () => {
    const apps = Array.from({ length: 30 }, (_, i) => ({ uuid: `a${i}`, name: `app${i}`, build_pack: "nixpacks", git_repository: "o/r" }));
    let inflight = 0;
    let peak = 0;
    const client: { get<T>(p: string): Promise<T> } = {
      async get<T>(path: string): Promise<T> {
        if (path === "/servers") return [] as T;
        if (path === "/applications") return apps as T;
        if (path === "/databases" || path === "/services") return [] as T;
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return [] as T;
      },
    };
    await new CoolifySource(client).discover();
    expect(peak).toBeLessThanOrEqual(16); // DISCOVER_CONCURRENCY (8) x the two parallel per-app reads
  });
});

describe("CoolifySource.fetchSecrets — strict reason tags", () => {
  it("tags each unresolved key with its reason, counts preview twins and drops invalid keys into invalidKeys", async () => {
    const client = new FakeClient({
      "/applications/app-1/envs": [
        { key: "OK", value: "v" },
        { key: "LOCKED" },
        { key: "SHARED", is_shared: true },
        { key: "MAGIC", is_coolify: true },
        { key: "UNEXPANDED", value: "{{environment.X}}", real_value: "{{environment.X}}" },
        { key: "A=B", value: "x" },
        { key: "OK", value: "preview", is_preview: true },
      ],
    });
    const res = await new CoolifySource(client).fetchSecrets("app-1");
    expect(res.values).toEqual({ OK: "v" });
    expect(Object.fromEntries(res.unresolved.map((u) => [u.key, u.reason]))).toEqual({ LOCKED: "NO_VALUE", SHARED: "SHARED_UNEXPANDED", MAGIC: "MAGIC", UNEXPANDED: "SHARED_UNEXPANDED" });
    expect(res.invalidKeys).toEqual(["A=B"]);
    expect(res.previewSkipped).toBe(1);
  });

  it("a clean app has neither invalidKeys nor previewSkipped (shape unchanged)", async () => {
    const res = await new CoolifySource(new FakeClient({ "/applications/app-1/envs": [{ key: "A", value: "1" }] })).fetchSecrets("app-1");
    expect(res).toEqual({ values: { A: "1" }, unresolved: [], flags: undefined } as never);
  });
});

describe("CoolifySource.fetchServiceBundle", () => {
  const SECRET = "SYNTH-SECRET-1";
  const httpErr = (status: number) => Object.assign(new Error(`Coolify API error ${status} body-with-${SECRET}`), { status });

  it("carries real_value over value, the magic secrets and user vars; drops preview twins, SERVICE_URL/FQDN and other is_coolify rows", async () => {
    const client = new FakeClient({
      "/services/svc-1/envs": [
        { key: "SERVICE_PASSWORD_MEILI", value: "pw", is_coolify: true },
        { key: "SERVICE_USER_MINIO", value: "root" },
        { key: "SERVICE_URL_MEILI_7700", value: "http://x", is_coolify: true },
        { key: "SERVICE_FQDN_MEILI", value: "x", is_coolify: true },
        { key: "COOLIFY_RESOURCE_UUID", value: "u", is_coolify: true },
        { key: "MINIO_SERVER_URL", value: "raw", real_value: "resolved", is_literal: true },
        { key: "MINIO_SERVER_URL", value: "preview", is_preview: true },
        { key: "EMPTY", value: "" },
        { key: "NOVALUE" },
        { key: "__proto__", value: "p" },
      ],
      "/services/svc-1/storages": { file_storages: [{ fs_path: "/data/coolify/services/svc-1/clickhouse/config.xml", content: "<a/>", is_directory: false }, { fs_path: "/data/coolify/services/svc-1/dir", is_directory: true }, { fs_path: "/x/nocontent" }], persistent_storages: [] },
    });
    const b = (await new CoolifySource(client).fetchServiceBundle("svc-1"))!;
    expect(Object.getPrototypeOf(b.values)).toBeNull();
    expect(Object.keys(b.values).sort()).toEqual(["EMPTY", "MINIO_SERVER_URL", "SERVICE_PASSWORD_MEILI", "SERVICE_USER_MINIO", "__proto__"]);
    expect(b.values.MINIO_SERVER_URL).toBe("resolved");
    expect(b.values.EMPTY).toBe("");
    expect(b.unresolved).toEqual(["NOVALUE"]);
    expect(b.flags!.MINIO_SERVER_URL).toEqual({ literal: true });
    expect(b.files).toEqual([{ path: "clickhouse/config.xml", content: "<a/>" }]);
  });

  it("403/404 on the envs endpoint returns undefined (not a throw)", async () => {
    for (const status of [401, 403, 404]) {
      const client = new FakeClient({ "/services/svc-1/envs": httpErr(status) });
      await expect(new CoolifySource(client).fetchServiceBundle("svc-1")).resolves.toBeUndefined();
    }
    await expect(new CoolifySource(new FakeClient({})).fetchServiceBundle("svc-1")).resolves.toBeUndefined(); // FakeClient: "404 <path>"
  });

  it("any other error is re-thrown with the FIXED message and never echoes the client error", async () => {
    const client = new FakeClient({ "/services/svc-1/envs": httpErr(500) });
    const err = await new CoolifySource(client).fetchServiceBundle("svc-1").catch((e: Error) => e);
    expect((err as Error).message).toBe("service variables could not be read");
    expect(String((err as Error).message)).not.toContain(SECRET);
    const storagesFail = new FakeClient({ "/services/svc-1/envs": [], "/services/svc-1/storages": httpErr(500) });
    await expect(new CoolifySource(storagesFail).fetchServiceBundle("svc-1")).rejects.toThrow("service variables could not be read");
  });

  it("a missing /storages endpoint leaves files undefined; the envs still carry", async () => {
    const client = new FakeClient({ "/services/svc-1/envs": [{ key: "A", value: "1" }], "/services/svc-1/storages": httpErr(404) });
    const b = (await new CoolifySource(client).fetchServiceBundle("svc-1"))!;
    expect(b.files).toBeUndefined();
    expect(b.values.A).toBe("1");
  });

  it("discover: a /services list row that already has its members and raw compose skips the detail GET (fallback kept)", async () => {
    const client = new FakeClient({
      "/servers": [{ uuid: "srv-a" }],
      "/servers/srv-a/resources": [],
      "/applications": [],
      "/databases": [],
      "/services": [{ uuid: "s1", name: "full", applications: [], databases: [], docker_compose_raw: "services:\n  a:\n    image: x:1\n" }, { uuid: "s2", name: "bare" }],
      "/services/s2": { uuid: "s2", name: "bare", applications: [{ uuid: "m1", name: "a" }], databases: [] },
    });
    const fleet = await new CoolifySource(client).discover();
    expect(client.calls).not.toContain("/services/s1");
    expect(client.calls).toContain("/services/s2");
    expect(fleet.services.map((x) => x.name)).toEqual(["full", "bare"]);
    expect(fleet.services[0].composeFile).toContain("services:");
  });
});
