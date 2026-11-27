import { CoolifySource, mapLimit, type CoolifyClient } from "./coolify.source";
import { planImport } from "../import-planner";

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

  describe("discover: Coolify project tree", () => {
    it("places every app and database in its Coolify project / environment (like the Dokploy tree)", async () => {
      const fleet = await new CoolifySource(new FakeClient({
        "/servers": [{ uuid: "srv-a", name: "box", ip: "1.2.3.4" }],
        "/servers/srv-a/resources": [{ uuid: "app-1" }, { uuid: "db-1" }, { uuid: "app-2" }],
        "/applications": [
          { uuid: "app-1", name: "shopfront-api", build_pack: "dockerfile", ports_exposes: "3000", environment_id: 39 },
          { uuid: "app-2", name: "loose", build_pack: "dockerfile", ports_exposes: "3000", environment_id: 999 },
        ],
        "/databases": [{ uuid: "db-1", name: "shopfront-postgres", database_type: "standalone-postgresql", image: "postgres:16", environment_id: 39 }],
        "/services": [],
        "/projects": [{ uuid: "p-shop", name: "Shopfront" }, { uuid: "p-notely", name: "Notely" }],
        "/projects/p-shop": { uuid: "p-shop", name: "Shopfront", environments: [{ id: 40, name: "staging" }, { id: 39, name: "production" }] },
        "/projects/p-notely": { uuid: "p-notely", name: "Notely", environments: [{ id: 38, name: "production" }] },
      })).discover();
      expect(fleet.projects).toEqual([
        { ref: "p-shop", name: "Shopfront", description: undefined, tags: [], environments: [
          { ref: "p-shop#40", name: "staging", isDefault: false },
          { ref: "p-shop#39", name: "production", isDefault: true },
        ] },
        { ref: "p-notely", name: "Notely", description: undefined, tags: [], environments: [{ ref: "p-notely#38", name: "production", isDefault: true }] },
      ]);
      expect(fleet.apps.find((a) => a.sourceRef === "app-1")).toMatchObject({ projectRef: "p-shop", environmentRef: "p-shop#39" });
      expect(fleet.databases[0]).toMatchObject({ projectRef: "p-shop", environmentRef: "p-shop#39" });
      // an environment that is not in any readable project stays unplaced (team default), never guessed
      expect(fleet.apps.find((a) => a.sourceRef === "app-2")?.projectRef).toBeUndefined();
    });

    it("places a service in its Coolify project / environment too (list row or detail read carries the environment)", async () => {
      const fleet = await new CoolifySource(new FakeClient({
        "/servers": [{ uuid: "srv-a", name: "box", ip: "1.2.3.4" }],
        "/servers/srv-a/resources": [],
        "/applications": [],
        "/databases": [],
        "/services": [{ uuid: "svc-1", name: "search", service_type: "meilisearch", environment_id: 39 }, { uuid: "svc-2", name: "loose-stack", environment_id: 999 }],
        "/services/svc-1": { uuid: "svc-1", name: "search", service_type: "meilisearch", applications: [{ uuid: "m-1" }], databases: [] },
        "/services/svc-2": { uuid: "svc-2", name: "loose-stack", environment_id: 38, applications: [{ uuid: "m-2" }], databases: [] },
        "/projects": [{ uuid: "p-acme", name: "Acme" }],
        "/projects/p-acme": { uuid: "p-acme", name: "Acme", environments: [{ id: 39, name: "production" }, { id: 38, name: "staging" }] },
      })).discover();
      // svc-1 has its environment on the list row only; the detail read dropped it
      expect(fleet.services.find((x) => x.sourceRef === "svc-1")).toMatchObject({ projectRef: "p-acme", environmentRef: "p-acme#39" });
      // svc-2: the detail read wins over an unknown list value (a row that names a readable environment is placed)
      expect(fleet.services.find((x) => x.sourceRef === "svc-2")).toMatchObject({ projectRef: "p-acme", environmentRef: "p-acme#38" });
    });

    it("places a service stack in its project too, so a whole project can be selected with its stacks", async () => {
      const fleet = await new CoolifySource(new FakeClient({
        "/servers": [{ uuid: "srv-a", name: "box", ip: "1.2.3.4" }],
        "/servers/srv-a/resources": [{ uuid: "svc-1" }],
        "/applications": [],
        "/databases": [],
        "/services": [{ uuid: "svc-1", name: "search", service_type: "meilisearch", environment_id: 7, applications: [], databases: [], docker_compose_raw: "services: {}" }],
        "/projects": [{ uuid: "p-acme", name: "Acme" }],
        "/projects/p-acme": { uuid: "p-acme", name: "Acme", environments: [{ id: 7, name: "production" }] },
      })).discover();
      expect(fleet.services[0]).toMatchObject({ sourceRef: "svc-1", projectRef: "p-acme", environmentRef: "p-acme#7" });
    });

    it("an unreadable project list leaves the fleet unplaced and says so", async () => {
      const fleet = await new CoolifySource(new FakeClient({
        "/servers": [], "/applications": [], "/databases": [], "/services": [], "/projects": new Error("403 nope"),
      })).discover();
      expect(fleet.projects).toBeUndefined();
      expect(fleet.warnings.join(" ")).toMatch(/could not read projects/);
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

    it("reads each database's scheduled backups and the S3 storages read-only, keeps names only and never an S3 secret", async () => {
      const c = new FakeClient({
        "/servers": [{ uuid: "srv-a", name: "box" }],
        "/servers/srv-a/resources": [{ uuid: "db-1" }, { uuid: "db-2" }, { uuid: "db-3" }],
        "/applications": [],
        "/databases": [
          { uuid: "db-1", name: "orders", database_type: "standalone-postgresql", image: "postgres:16" },
          { uuid: "db-2", name: "cache", database_type: "standalone-redis", image: "redis:7" },
          { uuid: "db-3", name: "plain", database_type: "standalone-mysql", image: "mysql:8" },
        ],
        "/services": [],
        "/databases/db-1/storages": [],
        "/databases/db-2/storages": [],
        "/databases/db-3/storages": [],
        "/databases/db-1/backups": [{ uuid: "b1", enabled: true, save_s3: true, frequency: "daily", s3_storage_id: 3, s3_storage_uuid: "s3-x", secret: "SHOULD-NOT-LEAK" }],
        "/databases/db-3/backups": [],
        "/s3-storages": [{ id: 3, uuid: "s3-x", name: "prod-bucket", region: "eu", key: "AKIAHIDDEN", secret: "S3-SECRET-VALUE" }],
      });
      const fleet = await new CoolifySource(c).discover();
      expect(c.calls).not.toContain("/databases/db-2/backups"); // Redis has no scheduled backup in Coolify
      expect(fleet.databases.find((d) => d.sourceRef === "db-1")!.backupSchedule).toEqual({ schedules: 1, interval: "daily", s3: true, targets: ["prod-bucket"] });
      expect(fleet.databases.find((d) => d.sourceRef === "db-3")!.backupSchedule).toBeUndefined();
      expect(JSON.stringify(fleet)).not.toMatch(/AKIAHIDDEN|S3-SECRET-VALUE|SHOULD-NOT-LEAK/);
      expect(fleet.warnings.join("\n")).not.toMatch(/could not read the scheduled backups/);
    });

    it("says so once when a backup list cannot be read (not for a 404: that Coolify has no such endpoint)", async () => {
      const routes = {
        "/servers": [{ uuid: "srv-a" }],
        "/servers/srv-a/resources": [],
        "/applications": [],
        "/databases": [{ uuid: "db-1", name: "a", database_type: "standalone-postgresql" }, { uuid: "db-2", name: "b", database_type: "standalone-postgresql" }],
        "/services": [],
        "/databases/db-1/storages": [],
        "/databases/db-2/storages": [],
      };
      const missing = await new CoolifySource(new FakeClient(routes)).discover(); // both backups routes 404
      expect(missing.warnings.join("\n")).not.toMatch(/scheduled backups/);
      const denied = await new CoolifySource(new FakeClient({ ...routes, "/databases/db-1/backups": new Error("500 boom"), "/databases/db-2/backups": [] })).discover();
      expect(denied.warnings.filter((w) => /scheduled backups/.test(w))).toEqual(["could not read the scheduled backups of 1 database(s) — a backup schedule they have is not shown in the plan"]);
    });

    it("keeps the health of each app (status + restart count) from the list row", async () => {
      const c = new FakeClient({
        "/servers": [{ uuid: "srv-a" }],
        "/servers/srv-a/resources": [{ uuid: "app-1" }],
        "/applications": [{ uuid: "app-1", name: "dead-api", build_pack: "dockerimage", docker_registry_image_name: "nginx", status: "exited:unhealthy", restart_count: 126368 }],
        "/databases": [],
        "/services": [],
        "/applications/app-1/envs": [],
        "/applications/app-1/storages": [],
      });
      const fleet = await new CoolifySource(c).discover();
      expect(fleet.apps[0].sourceHealth).toEqual({ health: "exited", status: "exited:unhealthy", restartCount: 126368 });
      expect(fleet.warnings).toContain("app dead-api is not healthy at the source (exited:unhealthy, 126368 restarts): it migrates as it is, so check it before migrating");
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

  describe("Coolify 4.7.5 shapes", () => {
    const base = {
      "/servers": [{ uuid: "srv-a", name: "box" }],
      "/servers/srv-a/resources": [{ uuid: "app-1" }, { uuid: "svc-1" }],
      "/databases": [],
    };
    // A plain-token 4.7.5 list row: the gated keys (commands, labels, compose) are ABSENT, and so are is_static / is_spa.
    const row475 = { uuid: "app-1", name: "site", build_pack: "nixpacks", git_repository: "o/site", git_branch: "main", publish_directory: "/dist", ports_exposes: "80", fqdn: "https://site.example.test" };

    it("reads is_static / is_spa from settings.* of the detail GET for a nixpacks app, one extra GET", async () => {
      const client = new FakeClient({
        ...base,
        "/applications": [row475],
        "/applications/app-1": { ...row475, settings: { is_static: true, is_spa: false } },
        "/applications/app-1/envs": [],
        "/applications/app-1/storages": [],
        "/services": [],
      });
      const fleet = await new CoolifySource(client).discover();
      expect(fleet.apps[0]).toMatchObject({ kind: "git", buildPack: "static", publishDirectory: "/dist", staticSpa: false });
      expect(client.calls.filter((c) => c === "/applications/app-1")).toHaveLength(1);
    });

    it("also reads the settings of a railpack and a static app; a dockerfile / image app takes the detail GET only for its container name prefix", async () => {
      const apps = [
        { ...row475, uuid: "r", build_pack: "railpack" },
        { ...row475, uuid: "s", build_pack: "static" },
        { ...row475, uuid: "d", build_pack: "dockerfile" },
        { uuid: "i", build_pack: "dockerimage", docker_registry_image_name: "nginx" },
      ];
      const routes: Record<string, unknown> = { ...base, "/applications": apps, "/services": [], "/applications/r": { settings: { is_static: true } }, "/applications/s": { settings: { is_spa: false } } };
      for (const a of apps) {
        routes[`/applications/${a.uuid}/envs`] = [];
        routes[`/applications/${a.uuid}/storages`] = [];
      }
      const client = new FakeClient(routes);
      const fleet = await new CoolifySource(client).discover();
      expect(fleet.apps.map((a) => a.buildPack)).toEqual(["static", "static", "dockerfile", "image"]);
      expect(fleet.apps[1].staticSpa).toBe(false);
      // one GET each (never two): r and s for the static flags (+ prefix), d and i for the prefix alone
      expect(client.calls.filter((c) => /^\/applications\/[a-z]$/.test(c)).sort()).toEqual(["/applications/d", "/applications/i", "/applications/r", "/applications/s"]);
    });

    describe("custom container name prefix (settings.custom_container_name_prefix)", () => {
      const detail = (over: Record<string, unknown>) => ({ ...row475, settings: { is_static: false, is_spa: false, ...over } });
      const routesFor = (apps: unknown[], extra: Record<string, unknown> = {}) => {
        const r: Record<string, unknown> = { ...base, "/applications": apps, "/services": [], ...extra };
        for (const a of apps as Array<{ uuid: string }>) {
          r[`/applications/${a.uuid}/envs`] = [];
          r[`/applications/${a.uuid}/storages`] = [];
        }
        return r;
      };

      it("is read from the detail GET for ANY build pack and lands on the discovered app", async () => {
        const dockerfile = { ...row475, uuid: "df", build_pack: "dockerfile" };
        const image = { uuid: "im", build_pack: "dockerimage", docker_registry_image_name: "nginx" };
        const client = new FakeClient(
          routesFor([row475, dockerfile, image], {
            "/applications/app-1": detail({ custom_container_name_prefix: "site-prod" }),
            "/applications/df": detail({ custom_container_name_prefix: "shop" }),
            "/applications/im": detail({ custom_container_name_prefix: null }),
          }),
        );
        const fleet = await new CoolifySource(client).discover();
        expect(fleet.apps.map((a) => [a.sourceRef, a.containerPrefix])).toEqual([["app-1", "site-prod"], ["df", "shop"], ["im", undefined]]);
        expect(client.calls.filter((c) => /^\/applications\/(app-1|df|im)$/.test(c)).sort()).toEqual(["/applications/app-1", "/applications/df", "/applications/im"]);
      });

      it("a row that already carries the setting (nested or flat, even null) and a 4.1.2 to 4.6 row spend no detail GET", async () => {
        const nested = { ...row475, uuid: "n", build_pack: "dockerfile", settings: { custom_container_name_prefix: "shop" } };
        const flat = { ...row475, uuid: "f", build_pack: "dockerfile", custom_container_name_prefix: null };
        const legacy = { ...row475, uuid: "l", build_pack: "dockerfile", is_static: false };
        const client = new FakeClient(routesFor([nested, flat, legacy]));
        const fleet = await new CoolifySource(client).discover();
        expect(fleet.apps.map((a) => [a.sourceRef, a.containerPrefix])).toEqual([["n", "shop"], ["f", undefined], ["l", undefined]]);
        expect(client.calls.filter((c) => /^\/applications\/[a-z]$/.test(c))).toEqual([]);
      });

      it("a value that is not a plain name, or equals the uuid, is dropped (the app is then matched by its uuid)", async () => {
        const apps = [{ ...row475, uuid: "a", build_pack: "dockerfile" }, { ...row475, uuid: "b", build_pack: "dockerfile" }, { ...row475, uuid: "c", build_pack: "dockerfile" }];
        const client = new FakeClient(
          routesFor(apps, {
            "/applications/a": detail({ custom_container_name_prefix: "x; reboot" }),
            "/applications/b": detail({ custom_container_name_prefix: "b" }),
            "/applications/c": detail({ custom_container_name_prefix: "  shop  " }),
          }),
        );
        const fleet = await new CoolifySource(client).discover();
        expect(fleet.apps.map((a) => a.containerPrefix)).toEqual([undefined, undefined, "shop"]);
      });

      it("a detail read that fails says so, naming what may be missed", async () => {
        const client = new FakeClient(routesFor([{ ...row475, build_pack: "dockerfile" }], { "/applications/app-1": new Error("429 slow down") }));
        const fleet = await new CoolifySource(client).discover();
        expect(fleet.warnings).toContain("could not read the container name settings of site — if it has a custom container name prefix, its container may not be found by name");
        expect(fleet.apps[0].containerPrefix).toBeUndefined();
      });

      it("the plan item carries it as proposed.containerPrefix, inside the plan hash (a different prefix is a different plan)", async () => {
        const mk = async (prefix: string | null) => {
          const client = new FakeClient(routesFor([{ ...row475, build_pack: "dockerfile" }], { "/applications/app-1": detail({ custom_container_name_prefix: prefix }) }));
          return planImport(await new CoolifySource(client).discover(), { sourceKind: "coolify" });
        };
        const withPrefix = await mk("shop");
        const without = await mk(null);
        expect(withPrefix.items.find((i) => i.kind === "app")!.proposed).toMatchObject({ containerPrefix: "shop" });
        expect(without.items.find((i) => i.kind === "app")!.proposed).not.toHaveProperty("containerPrefix");
        expect(withPrefix.planHash).not.toBe(without.planHash);
      });
    });

    it("keeps reading the top-level flags of 4.1.2 to 4.6 and does not spend a detail GET when the row already has them", async () => {
      const client = new FakeClient({
        ...base,
        "/applications": [{ ...row475, is_static: true, is_spa: true }],
        "/applications/app-1/envs": [],
        "/applications/app-1/storages": [],
        "/services": [],
      });
      const fleet = await new CoolifySource(client).discover();
      expect(fleet.apps[0].buildPack).toBe("static");
      expect(client.calls).not.toContain("/applications/app-1");
    });

    it("a detail read that fails (or has no settings) keeps the list row and says so only on a failure", async () => {
      const routes = { ...base, "/applications": [row475], "/applications/app-1/envs": [], "/applications/app-1/storages": [], "/services": [] };
      const failed = await new CoolifySource(new FakeClient({ ...routes, "/applications/app-1": new Error("429 slow down") })).discover();
      expect(failed.apps[0].buildPack).toBe("nixpacks");
      expect(failed.warnings).toContain("could not read the static-site settings of site — a static site may be planned as a regular build");
      const plain = await new CoolifySource(new FakeClient({ ...routes, "/applications/app-1": { ...row475 } })).discover();
      expect(plain.apps[0].buildPack).toBe("nixpacks");
      expect(plain.warnings.filter((w) => /static-site/.test(w))).toEqual([]);
    });

    it("warns, naming what is not carried and the fix, when the rows carry no sensitive keys; stays quiet when they do", async () => {
      const routes = { ...base, "/applications": [{ ...row475, build_pack: "dockerfile" }], "/applications/app-1/envs": [], "/applications/app-1/storages": [], "/services": [] };
      const hidden = await new CoolifySource(new FakeClient(routes)).discover();
      const w = hidden.warnings.find((x) => /read:sensitive/.test(x) && /not be carried|NOT be carried/.test(x));
      expect(w).toBeDefined();
      expect(w).toMatch(/1 application\(s\)/);
      expect(w).toMatch(/start commands/);
      expect(w).toMatch(/team admin or owner/);
      const visible = await new CoolifySource(new FakeClient({ ...routes, "/applications": [{ ...row475, build_pack: "dockerfile", install_command: null, build_command: null, start_command: null }] })).discover();
      expect(visible.warnings.filter((x) => /sensitive fields/.test(x))).toEqual([]);
    });

    it("service list rows carry no members or compose: the detail GET supplies them, members the compose dropped are skipped, the server name comes from the detail", async () => {
      const client = new FakeClient({
        ...base,
        "/applications": [],
        "/services": [{ uuid: "svc-1", name: "stack", service_type: "plausible" }],
        "/services/svc-1": {
          uuid: "svc-1",
          name: "stack",
          docker_compose_raw: "services:\n  web:\n    image: x:1\n",
          destination: { server: { uuid: "srv-a", name: "box-detail" } },
          applications: [
            { uuid: "sa-1", name: "web", fqdn: "https://svc.example.test:8000" },
            { uuid: "sa-old", name: "gone", is_removed_from_compose: true },
          ],
          databases: [
            { uuid: "sd-1", name: "pg", is_removed_from_compose: false },
            { uuid: "sd-old", name: "old-db", is_removed_from_compose: true },
          ],
        },
      });
      const fleet = await new CoolifySource(client).discover();
      const svc = fleet.services[0];
      expect(svc.memberApps).toEqual(["sa-1"]);
      expect(svc.memberDbs).toEqual(["sd-1"]);
      expect(svc.members!.map((m) => m.name)).toEqual(["pg", "web"]);
      expect(svc.composeFile).toContain("services:");
      expect(svc.serverName).toBe("box-detail");
      expect(client.calls).toContain("/services/svc-1");
    });

    it("the old inventory shape (members + compose already on the list row) still skips the detail GET", async () => {
      const client = new FakeClient({
        ...base,
        "/applications": [],
        "/services": [{ uuid: "svc-1", name: "stack", docker_compose_raw: "services: {}", applications: [{ uuid: "sa-1", name: "web" }], databases: [] }],
      });
      const fleet = await new CoolifySource(client).discover();
      expect(fleet.services[0].memberApps).toEqual(["sa-1"]);
      expect(client.calls).not.toContain("/services/svc-1");
    });

    it("locked variables (is_shown_once) are reported LOCKED, never as a token problem", async () => {
      const client = new FakeClient({
        ...base,
        "/applications": [{ ...row475, build_pack: "dockerfile" }],
        "/services": [],
        "/applications/app-1/envs": [{ key: "ONLY_SECRET", is_shown_once: true }],
        "/applications/app-1/storages": [],
      });
      const fleet = await new CoolifySource(client).discover();
      expect(fleet.apps[0].envReport).toEqual({ total: 1, previewSkipped: 0, unresolved: [{ key: "ONLY_SECRET", reason: "LOCKED" }], invalidKeys: [], tokenReadOnly: false });
    });

    it("fetchSecrets tags a locked variable LOCKED and still carries the readable ones", async () => {
      const client = new FakeClient({ "/applications/app-1/envs": [{ key: "A", value: "1", real_value: "1" }, { key: "B", is_shown_once: true }] });
      const out = await new CoolifySource(client).fetchSecrets("app-1");
      expect(out.values).toEqual({ A: "1" });
      expect(out.unresolved).toEqual([{ key: "B", secret: true, reason: "LOCKED", ref: undefined }]);
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

describe("CoolifySource.fetchDbConfigFile", () => {
  it("does ONE GET of the database and returns the redis.conf text as is", async () => {
    const client = new FakeClient({ "/databases/db-1": { uuid: "db-1", database_type: "standalone-redis", redis_conf: "maxmemory 1gb\nappendonly yes\n" } });
    expect(await new CoolifySource(client).fetchDbConfigFile("db-1")).toBe("maxmemory 1gb\nappendonly yes\n");
    expect(client.calls).toEqual(["/databases/db-1"]);
  });

  it("a row without the text (plain token), a blank text or a non-object gives undefined; a client error propagates", async () => {
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": { uuid: "db-1" } })).fetchDbConfigFile("db-1")).toBeUndefined();
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": { uuid: "db-1", redis_conf: "  \n" } })).fetchDbConfigFile("db-1")).toBeUndefined();
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": [] })).fetchDbConfigFile("db-1")).toBeUndefined();
    await expect(new CoolifySource(new FakeClient({ "/databases/db-1": new Error("500 boom") })).fetchDbConfigFile("db-1")).rejects.toThrow("500 boom");
  });

  it("reads the field of the database's own engine (from the type, the image or the executor's hint)", async () => {
    const row = { uuid: "db-1", postgres_conf: "max_connections=10\n", mysql_conf: "[mysqld]\nx=1\n", redis_conf: "r" };
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": { ...row, database_type: "standalone-postgresql" } })).fetchDbConfigFile("db-1")).toBe("max_connections=10\n");
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": { ...row, image: "mysql:8" } })).fetchDbConfigFile("db-1")).toBe("[mysqld]\nx=1\n");
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": row })).fetchDbConfigFile("db-1", "MYSQL")).toBe("[mysqld]\nx=1\n");
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": { uuid: "db-1", keydb_conf: "k" } })).fetchDbConfigFile("db-1", "KEYDB")).toBe("k");
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": { uuid: "db-1", mongo_conf: "m" } })).fetchDbConfigFile("db-1", "MONGO")).toBe("m");
    expect(await new CoolifySource(new FakeClient({ "/databases/db-1": row })).fetchDbConfigFile("db-1", "DRAGONFLY")).toBeUndefined();
  });

  it("encodes the ref in the path", async () => {
    const client = new FakeClient({ "/databases/a%2Fb": { uuid: "x", redis_conf: "x" } });
    await new CoolifySource(client).fetchDbConfigFile("a/b");
    expect(client.calls).toEqual(["/databases/a%2Fb"]);
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
