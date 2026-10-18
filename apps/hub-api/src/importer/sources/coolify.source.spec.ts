import { CoolifySource, type CoolifyClient } from "./coolify.source";

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

  it("fetchSecrets is not wired yet (throws clearly)", async () => {
    await expect(new CoolifySource(new FakeClient({})).fetchSecrets("db-1")).rejects.toThrow(/not wired/);
    expect(new CoolifySource(new FakeClient({})).capabilities()).toEqual({ apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false });
  });
});
