import { CoolifySource, type CoolifyClient } from "./coolify.source";
import { coolifyHealth, coolifyHealthRows, coolifyRestartCount, coolifyVersionToken } from "./coolify-health";
import { buildCoolifyFleet } from "./coolify-map";

class Client implements CoolifyClient {
  calls: string[] = [];
  constructor(
    private readonly routes: Record<string, unknown>,
    private readonly texts: Record<string, string | Error> | null = null,
  ) {
    if (texts) this.getText = async (path: string) => {
      this.calls.push(path);
      const v = this.texts![path];
      if (v === undefined) throw new Error(`404 ${path}`);
      if (v instanceof Error) throw v;
      return v;
    };
  }
  getText?: (path: string) => Promise<string>;
  async get<T>(path: string): Promise<T> {
    this.calls.push(path);
    const v = this.routes[path];
    if (v === undefined) throw new Error(`404 ${path}`);
    if (v instanceof Error) throw v;
    return v as T;
  }
}

describe("coolify health mapping", () => {
  it("maps the status strings the real API prints", () => {
    expect(coolifyHealth("running:healthy")).toBe("healthy");
    expect(coolifyHealth("running:unknown")).toBe("unknown"); // no health check: nobody looked, not a pass
    expect(coolifyHealth("running:unhealthy")).toBe("unhealthy");
    expect(coolifyHealth("exited:unhealthy")).toBe("exited");
    expect(coolifyHealth("exited")).toBe("exited");
    expect(coolifyHealth("restarting:unhealthy")).toBe("unhealthy");
    expect(coolifyHealth("degraded:unhealthy")).toBe("unhealthy");
    expect(coolifyHealth("RUNNING:Healthy ")).toBe("healthy");
    for (const v of [undefined, null, 5, "", "starting", {}]) expect(coolifyHealth(v)).toBe("unknown");
  });

  it("reads the restart counter as an integer or null, never 0 for garbage", () => {
    expect(coolifyRestartCount(90001)).toBe(90001);
    expect(coolifyRestartCount("3")).toBe(3);
    for (const v of [undefined, null, -1, 1.5, "x", "1.5", NaN, Number.MAX_SAFE_INTEGER + 2]) expect(coolifyRestartCount(v)).toBeNull();
  });

  it("builds rows placed on their server, skipping rows without a uuid", () => {
    const rows = coolifyHealthRows("app", [{ uuid: "a1", status: "exited:unhealthy", restart_count: 9 }, { status: "running:healthy" }, { uuid: "a2", status: "running:healthy" }], new Map([["a1", "srv-1"]]));
    expect(rows).toEqual([
      { kind: "app", ref: "a1", serverRef: "srv-1", health: "exited", restartCount: 9 },
      { kind: "app", ref: "a2", health: "healthy", restartCount: null },
    ]);
  });

  it("accepts a version as plain text, a JSON string or v-prefixed, and nothing else", () => {
    expect(coolifyVersionToken("4.1.2")).toBe("4.1.2");
    expect(coolifyVersionToken('"4.1.2"\n')).toBe("4.1.2");
    expect(coolifyVersionToken("v4.7.5")).toBe("v4.7.5");
    expect(coolifyVersionToken("4.0.0-beta.442")).toBe("4.0.0-beta.442");
    for (const v of ["", "<html>login</html>", "latest", "4", "1.2.3.4.5", "4.1.2; rm -rf /", 4.1, null, undefined]) expect(coolifyVersionToken(v)).toBeNull();
  });
});

describe("CoolifySource version and health baseline", () => {
  it("verify reports the version when /version answers text, and still verifies when it does not", async () => {
    expect(await new CoolifySource(new Client({ "/servers": [] }, { "/version": "4.1.2" })).verify()).toEqual({ ok: true, version: "4.1.2" });
    expect(await new CoolifySource(new Client({ "/servers": [] }, { "/version": new Error("403") })).verify()).toEqual({ ok: true });
    expect(await new CoolifySource(new Client({ "/servers": [] }, { "/version": "<html></html>" })).verify()).toEqual({ ok: true });
    expect(await new CoolifySource(new Client({ "/servers": [] })).verify()).toEqual({ ok: true }); // a client with no text reader
  });

  it("a failed /servers is still a failed verification (the version never rescues it)", async () => {
    expect(await new CoolifySource(new Client({ "/servers": new Error("401") }, { "/version": "4.1.2" })).verify()).toMatchObject({ ok: false });
  });

  const routes = {
    "/servers": [{ uuid: "srv-a" }, { uuid: "srv-b" }],
    "/servers/srv-a/resources": [{ uuid: "app-1" }, { uuid: "db-1" }],
    "/servers/srv-b/resources": new Error("500"),
    "/applications": [
      { uuid: "app-1", status: "running:healthy", restart_count: 0 },
      { uuid: "app-2", status: "exited:unhealthy", restart_count: 90001 },
    ],
    "/databases": [{ uuid: "db-1", status: "running:healthy" }],
    "/services": [{ uuid: "svc-1", status: "running:unknown" }],
  };

  it("healthBaseline reads status and restart counts of apps, databases and services, placed on their servers", async () => {
    const rows = await new CoolifySource(new Client(routes)).healthBaseline();
    expect(rows).toEqual([
      { kind: "app", ref: "app-1", serverRef: "srv-a", health: "healthy", restartCount: 0 },
      { kind: "app", ref: "app-2", health: "exited", restartCount: 90001 }, // srv-b's list failed: no serverRef, not a throw
      { kind: "database", ref: "db-1", serverRef: "srv-a", health: "healthy", restartCount: null },
      { kind: "service", ref: "svc-1", health: "unknown", restartCount: null },
    ]);
  });

  it("a failed core list throws (a half-read baseline would call the missing apps healthy); a missing services list does not", async () => {
    await expect(new CoolifySource(new Client({ ...routes, "/applications": new Error("500") })).healthBaseline()).rejects.toThrow();
    await expect(new CoolifySource(new Client({ ...routes, "/databases": new Error("500") })).healthBaseline()).rejects.toThrow();
    const noServices = await new CoolifySource(new Client({ ...routes, "/services": new Error("403") })).healthBaseline();
    expect(noServices.map((r) => r.kind)).toEqual(["app", "app", "database"]);
  });
});

/**
 * R4/C18: the real fleet runs Coolify 4.1.2, the importer's field names were verified on 4.4.6. These rows have the shape
 * the 4.1.2 inventory returns (every field the mapper reads is present there; invented names, no real project data), and the
 * mapper must carry them without a thrown error or a lost resource.
 */
describe("a 4.1.2 shaped fleet maps without loss", () => {
  it("apps with Dockerfile builds, dockerimage apps with the placeholder repo, service sub-apps with ports, and databases", () => {
    const fleet = buildCoolifyFleet({
      servers: [{ uuid: "srv-a", name: "host-1", ip: "192.0.2.10" }],
      resourcesByServer: { "srv-a": ["app-a", "app-img", "app-svc", "db-a"] },
      apps: [
        { uuid: "app-a", name: "app-a", build_pack: "dockerfile", git_repository: "org/mono", git_branch: "main", base_directory: "/apps/api", dockerfile_location: "/Dockerfile", ports_exposes: "3000", fqdn: "https://a.example.test,http://a.example.test", watch_paths: "apps/api/**" },
        { uuid: "app-img", name: "app-img", build_pack: "dockerimage", git_repository: "coollabsio/coolify", git_branch: "main", docker_registry_image_name: "ghcr.io/example/imageproxy", docker_registry_image_tag: "latest", ports_exposes: "8080", fqdn: "https://img.example.test" },
        { uuid: "app-svc", name: "app-svc", build_pack: "dockerfile", git_repository: "org/mono", git_branch: "main", ports_exposes: "8080", fqdn: "https://svc.example.test:8080" },
      ],
      databases: [{ uuid: "db-a", name: "db-a", database_type: "standalone-postgresql", image: "postgres:18-alpine", postgres_user: "u", postgres_db: "d" }],
      services: [],
      envsByResource: {},
      volumesByResource: {},
    });
    expect(fleet.apps.map((a) => a.sourceRef)).toEqual(["app-a", "app-img", "app-svc"]);
    expect(fleet.apps.find((a) => a.sourceRef === "app-a")).toMatchObject({ kind: "git", buildPack: "dockerfile", serverRef: "srv-a", ports: [3000] });
    expect(fleet.apps.find((a) => a.sourceRef === "app-a")?.domains).toHaveLength(1); // the http and https variants of one host collapse
    expect(fleet.apps.find((a) => a.sourceRef === "app-img")).toMatchObject({ kind: "image", buildPack: "image" });
    expect(fleet.apps.find((a) => a.sourceRef === "app-svc")?.domains?.[0]).toMatchObject({ host: "svc.example.test", port: 8080 });
    expect(fleet.databases[0]).toMatchObject({ engine: "POSTGRES", serverRef: "srv-a" });
  });
});
