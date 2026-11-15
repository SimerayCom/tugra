import { buildPreflight, classifyDbDataPlane } from "./preflight";
import type { ForeignFleet, ImportOptions } from "./foreign-fleet";

describe("classifyDbDataPlane", () => {
  it("one-click for the 6 migrator engines", () => {
    for (const e of ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY"]) {
      expect(classifyDbDataPlane(e).dataPlane).toBe("one-click");
    }
  });
  it("manual (config imports, data by hand) for Mongo/ClickHouse — no internal code leaked", () => {
    for (const e of ["MONGO", "CLICKHOUSE"]) {
      const c = classifyDbDataPlane(e);
      expect(c.dataPlane).toBe("manual");
      expect(c.reason).not.toMatch(/requires-|S4b|no-logical-dump/); // never leak internal slice codes
    }
  });
  it("blocked for LibSQL (plan blocks it; no target DB) and for an unrecognized engine", () => {
    // LibSQL matches the planner's blocker set → preflight must agree it is blocked, not 'manual'.
    expect(classifyDbDataPlane("LIBSQL")).toMatchObject({ dataPlane: "blocked" });
    expect(classifyDbDataPlane("UNKNOWN").dataPlane).toBe("blocked");
  });
  it("one-click reason names the migrator + the size cap (no over-promise)", () => {
    const c = classifyDbDataPlane("POSTGRES");
    expect(c.reason).toMatch(/migrator/i);
    expect(c.reason).toMatch(/MiB/);
  });
});

function fleet(over: Partial<ForeignFleet> = {}): ForeignFleet {
  return {
    servers: [{ ref: "s1" }],
    apps: [],
    databases: [],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
    ...over,
  };
}

describe("buildPreflight", () => {
  const opts: ImportOptions = { sourceKind: "coolify", targetServerId: "t1" };

  it("classifies every database and surfaces services the plan drops", () => {
    const f = fleet({
      databases: [
        { sourceRef: "d1", name: "pg", engine: "POSTGRES" },
        { sourceRef: "d2", name: "ch", engine: "CLICKHOUSE" },
      ],
      services: [{ sourceRef: "svc1", name: "signoz", memberApps: ["a1"], memberDbs: ["d2"] }],
      apps: [{ sourceRef: "a1", name: "web", kind: "git", buildPack: "dockerfile", volumes: [{ mountPath: "/data", type: "named", name: "v" }] }],
    });
    const pf = buildPreflight(f, opts);
    expect(pf.databases).toEqual([
      { name: "pg", engine: "POSTGRES", dataPlane: "one-click", reason: expect.any(String) },
      { name: "ch", engine: "CLICKHOUSE", dataPlane: "manual", reason: expect.any(String) },
    ]);
    expect(pf.services).toEqual([{ name: "signoz", members: 2, note: expect.stringMatching(/not imported/i), verdict: "skipped" }]);
    expect(pf.appsWithVolumeData).toBe(1);
    expect(pf.volumeDataNote).toMatch(/upload their DATA to the hub/i); // v1: manual upload before first deploy
    expect(pf.volumeDataNote).not.toMatch(/the migrator copies/i); // never claim an automated migrator volume step (not shipped)
    expect(pf.volumeDataNote).toMatch(/empty/i); // the mounts are still declared empty; the data is uploaded
    expect(pf.volumes).toEqual([expect.objectContaining({ app: "web", mountPath: "/data", type: "named", dataPlane: "hub-staged" })]);
  });

  it("does not claim volumes are declared for a compose-only fleet; its volume is a manual row", () => {
    const f = fleet({ apps: [{ sourceRef: "a1", name: "web", kind: "compose", buildPack: "dockercompose", composeFile: "services: {}", volumes: [{ mountPath: "/data", type: "named", name: "v" }] }] });
    const pf = buildPreflight(f, opts);
    expect(pf.appsWithVolumeData).toBe(1); // the app does carry volume data…
    expect(pf.volumeDataNote).toMatch(/manually/i); // …which must be copied manually (compose-managed, not declared)
    expect(pf.volumeDataNote).not.toMatch(/the migrator copies/i);
    expect(pf.volumeDataNote).not.toMatch(/declared on the new apps/i); // nothing is declared (compose volumes live in the compose file)
    expect(pf.volumes).toEqual([expect.objectContaining({ app: "web", dataPlane: "manual", reason: expect.stringMatching(/compose-managed/) })]);
  });

  it("classifies a measured over-cap volume as manual-large and flags a bind's ownership caveat", () => {
    const f = fleet({ apps: [{ sourceRef: "a1", name: "web", kind: "git", buildPack: "dockerfile", volumes: [{ mountPath: "/data", type: "named", name: "v" }, { mountPath: "/media", hostPath: "/srv/m", type: "bind" }] }] });
    const inv = new Map<string, number>([["web:/data", 10 * 1024 * 1024], ["web:/media", 900 * 1024 * 1024]]);
    const pf = buildPreflight(f, opts, inv);
    const data = pf.volumes!.find((v) => v.mountPath === "/data")!;
    const media = pf.volumes!.find((v) => v.mountPath === "/media")!;
    expect(data).toMatchObject({ type: "named", dataPlane: "hub-staged" });
    expect(media).toMatchObject({ type: "bind", dataPlane: "manual-large" });
    expect(media.reason).toMatch(/exceeds/i);
    expect(data.reason).not.toMatch(/ownership/i); // ownership caveat is bind-only
  });

  it("local-docker adopts volumes in place → no volume-data caveat", () => {
    const f = fleet({ apps: [{ sourceRef: "a1", name: "web", kind: "image", buildPack: "image", volumes: [{ mountPath: "/data", type: "named", name: "v" }] }] });
    const pf = buildPreflight(f, { sourceKind: "local-docker" });
    expect(pf.appsWithVolumeData).toBe(0);
    expect(pf.volumeDataNote).toBeUndefined();
  });
});

describe("buildPreflight — strict env + git hosts (additive, outside planHash)", () => {
  const app = (over: Partial<ForeignFleet["apps"][number]> = {}): ForeignFleet["apps"][number] => ({ sourceRef: "a", name: "web", kind: "git", buildPack: "nixpacks", serverRef: "s1", ...over });
  const o: ImportOptions = { sourceKind: "coolify" };

  it("counts apps whose API token cannot read variable values (only when the source reports envReport)", () => {
    const rep = (tokenReadOnly: boolean) => ({ total: 1, previewSkipped: 0, unresolved: [], invalidKeys: [], tokenReadOnly });
    const p = buildPreflight(fleet({ apps: [app({ envReport: rep(true) }), app({ sourceRef: "b", envReport: rep(true) }), app({ sourceRef: "c", envReport: rep(false) })] }), o);
    expect(p.env).toEqual({ tokenReadOnlyApps: 2 });
    expect(buildPreflight(fleet({ apps: [app()] }), { sourceKind: "dokploy" })).not.toHaveProperty("env");
  });

  it("lists git hosts with app counts (github.com x74 + a gitlab host) from https, scp and ssh:// URLs", () => {
    const apps = [
      ...Array.from({ length: 3 }, (_, i) => app({ sourceRef: `g${i}`, git: { url: "https://github.com/o/r.git" } })),
      app({ sourceRef: "s1", git: { url: "git@github.com:o/r2.git" } }),
      app({ sourceRef: "l1", git: { url: "https://gitlab.example.org/x/y.git" } }),
      app({ sourceRef: "n1" }), // no git
    ];
    expect(buildPreflight(fleet({ apps }), o).git).toEqual({ hosts: [{ host: "github.com", apps: 4 }, { host: "gitlab.example.org", apps: 1 }] });
    expect(buildPreflight(fleet({ apps: [app()] }), o)).not.toHaveProperty("git");
  });
});

describe("buildPreflight — MinIO services point at Object migration (everything else byte-identical)", () => {
  const o: ImportOptions = { sourceKind: "coolify" };
  const OTHER = "service stack (compose / one-click) — not imported yet; recreate it on Tugra and copy its volume data manually (rsync; quiesce the source first)";
  const svc = (over: Partial<ForeignFleet["services"][number]>): ForeignFleet["services"][number] => ({ sourceRef: "x", name: "svc", memberApps: ["a"], memberDbs: [], ...over });

  it("a service with templateSlug minio, or a minio/minio image in its compose file, gets the Object migration note", () => {
    const p = buildPreflight(fleet({ services: [svc({ name: "simeray-storage", templateSlug: "minio" }), svc({ name: "storage-xcinex", composeFile: "services:\n  minio:\n    image: minio/minio:RELEASE.2025\n" })] }), o);
    for (const s of p.services) expect(s.note).toMatch(/^object data is not copied by this import - use Object migration/);
    expect(p.services.every((s) => s.objectStore === true)).toBe(true);
    expect(p.services[0].note).toMatch(/not versions, IAM users, replication or notifications/);
  });

  it("every other service keeps the existing note byte-identical", () => {
    const p = buildPreflight(fleet({ services: [svc({ name: "plausible", templateSlug: "plausible" }), svc({ name: "nope", composeFile: "services: { web: { image: nginx } }" }), svc({ name: "minio-like", templateSlug: "minio-console-proxy" })] }), o);
    expect(p.services.map((s) => s.note)).toEqual([OTHER, OTHER, OTHER]);
    for (const s of p.services) expect(s).not.toHaveProperty("objectStore"); // the key is absent, not false
  });
});
