import { buildCutoverHint, buildPreflight, classifyDbDataPlane, vxVolumeReason } from "./preflight";
import { planImport } from "./import-planner";
import type { ForeignApp, ForeignFleet, ImportOptions } from "./foreign-fleet";

describe("classifyDbDataPlane", () => {
  it("one-click for the 8 migrator engines", () => {
    for (const e of ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY", "MONGO", "CLICKHOUSE"]) {
      expect(classifyDbDataPlane(e).dataPlane).toBe("one-click");
    }
  });
  it("Mongo and ClickHouse move by the migrator too, in a stream above the cap — never a manual path, no internal code leaked", () => {
    for (const e of ["MONGO", "CLICKHOUSE"]) {
      const c = classifyDbDataPlane(e);
      expect(c.dataPlane).toBe("one-click");
      expect(c.reason).toMatch(/stream/);
      expect(c.reason).not.toMatch(/manual|by hand|requires-|S4b|no-logical-dump/i);
    }
  });
  it("blocked for LibSQL (plan blocks it; no target DB) and for an unrecognized engine", () => {
    // LibSQL matches the planner's blocker set → preflight must agree it is blocked, not 'manual'.
    expect(classifyDbDataPlane("LIBSQL")).toMatchObject({ dataPlane: "blocked" });
    expect(classifyDbDataPlane("UNKNOWN").dataPlane).toBe("blocked");
  });
  it("one-click reason names the migrator and says any size moves, never a manual path", () => {
    const c = classifyDbDataPlane("POSTGRES");
    expect(c.reason).toMatch(/migrator/i);
    expect(c.reason).toMatch(/any size/);
    expect(c.reason).toMatch(/stream/);
    expect(c.reason).not.toMatch(/manual|by hand/i);
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

describe("buildPreflight (streamed copy OFF: today's hub-staged text, byte-identical)", () => {
  const opts: ImportOptions = { sourceKind: "coolify", targetServerId: "t1" };
  beforeEach(() => {
    process.env.MIGRATION_VX_ENABLED = "false";
  });
  afterEach(() => {
    delete process.env.MIGRATION_VX_ENABLED;
  });

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
      { name: "ch", engine: "CLICKHOUSE", dataPlane: "one-click", reason: expect.any(String) },
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

  it("every other service gets the service-import note and no objectStore flag", () => {
    const p = buildPreflight(fleet({ services: [svc({ name: "plausible", templateSlug: "plausible" }), svc({ name: "nope", composeFile: "services: { web: { image: nginx } }" }), svc({ name: "minio-like", templateSlug: "minio-console-proxy" })] }), o);
    for (const s of p.services) expect(s.note).not.toMatch(/Object migration/);
    for (const s of p.services) expect(s.note).not.toBe(OTHER); // services are imported now (stopped compose apps), the old "not imported yet" note is gone
    for (const s of p.services) expect(s).not.toHaveProperty("objectStore"); // the key is absent, not false
  });
});

describe("buildPreflight — source backups and source health", () => {
  const o: ImportOptions = { sourceKind: "coolify" };
  const dbWithBackup = { sourceRef: "d1", name: "maria", engine: "MARIADB" as const, backupSchedule: { schedules: 1, interval: "daily", s3: true, targets: ["db-bucket"] } };

  it("a database with a scheduled backup says it is not carried, names the S3 target and carries the summary", () => {
    const p = buildPreflight(fleet({ databases: [dbWithBackup, { sourceRef: "d2", name: "plain", engine: "POSTGRES" as const }] }), o);
    expect(p.databases[0].reason).toMatch(/scheduled backup \(daily\) and uploads to the S3 target db-bucket: it is not carried - recreate it in Tugra's Backups/);
    expect(p.databases[0].backup).toEqual(dbWithBackup.backupSchedule);
    expect(p.databases[1]).not.toHaveProperty("backup");
    expect(p.databases[1].reason).not.toMatch(/scheduled backup/);
  });

  it("lists apps already failing at the source and leaves healthy ones out", () => {
    const a = (sourceRef: string, name: string, sourceHealth: ForeignApp["sourceHealth"]): ForeignApp => ({ sourceRef, name, kind: "git", buildPack: "nixpacks", serverRef: "s1", sourceHealth });
    const p = buildPreflight(fleet({ apps: [a("a1", "dead", { health: "exited", status: "exited:unhealthy", restartCount: 126368 }), a("a2", "ok", { health: "healthy", status: "running:healthy", restartCount: 0 }), a("a3", "loop", { health: "unknown", restartCount: 25 }), a("a4", "unchecked", { health: "unknown", restartCount: 0 })] }), o);
    expect(p.sourceHealth).toEqual([
      { itemRef: "app:s1:a1", name: "dead", health: "exited", status: "exited:unhealthy", restartCount: 126368 },
      { itemRef: "app:s1:a3", name: "loop", health: "unknown", restartCount: 25 },
    ]);
    expect(buildPreflight(fleet({ apps: [a("a2", "ok", { health: "healthy", restartCount: 0 })] }), o)).not.toHaveProperty("sourceHealth");
  });
});

describe("buildCutoverHint: service hosts (R13)", () => {
  const { fixtureByName } = jest.requireActual("./testing/service-fixtures") as typeof import("./testing/service-fixtures");
  const withServices = (names: string[], apps: Parameters<typeof fleet>[0] = {}) => fleet({ ...apps, services: names.map((n) => fixtureByName(n).svc) });

  it("the importer-carried service routes (a stack's UI and its collector endpoint) count as hosts to flip, listed apart", () => {
    const hint = buildCutoverHint(withServices(["signoz-hub", "beszel-hub"]));
    expect(hint.serviceHosts).toHaveLength(3);
    expect(hint.hosts).toBe(3);
    expect(hint.serviceHosts).toEqual([...hint.serviceHosts!].sort());
  });

  it("a host an app and a service share counts once in `hosts`; an app-only fleet has no serviceHosts key", () => {
    const [h] = buildCutoverHint(withServices(["beszel-hub"])).serviceHosts!;
    const app = { sourceRef: "a", name: "a", kind: "image" as const, buildPack: "image" as const, image: "x", domains: [{ host: h, primary: true }] };
    expect(buildCutoverHint(withServices(["beszel-hub"], { apps: [app] })).hosts).toBe(1);
    const only = buildCutoverHint(fleet({ apps: [app] }));
    expect(Object.prototype.hasOwnProperty.call(only, "serviceHosts")).toBe(false);
  });

  it("a service the import skips (no compose, gate refusal) brings no route", () => {
    const svc = { ...fixtureByName("beszel-hub").svc, composeFile: undefined };
    expect(buildCutoverHint(fleet({ services: [svc] })).serviceHosts).toBeUndefined();
  });

  it("the hint reaches the copy-mode preflight and never changes the plan hash", () => {
    const f = withServices(["signoz-hub"]);
    expect(buildPreflight(f, { sourceKind: "coolify" }).cutover?.serviceHosts).toHaveLength(2);
    expect(planImport(f, { sourceKind: "coolify" }).planHash).toBe(planImport(withServices(["signoz-hub"]), { sourceKind: "coolify" }).planHash);
  });
});

describe("buildCutoverHint (source-only cutover facts, advisory)", () => {
  const app = (name: string, hosts: string[]) => ({ sourceRef: name, name, kind: "image" as const, buildPack: "image" as const, image: "x", domains: hosts.map((host, i) => ({ host, primary: i === 0 })) });
  it("counts hosts, lists Coolify-generated ones and hosts whose www/bare sibling the source also served", () => {
    const f = fleet({ apps: [app("a", ["example.com", "www.example.com"]), app("b", ["app-ek8c4gk8s8kwk8go4kwc4skc.sytrase.com", "api.example.com"])] });
    expect(buildCutoverHint(f)).toEqual({
      hosts: 4,
      generatedHosts: ["app-ek8c4gk8s8kwk8go4kwc4skc.sytrase.com"],
      counterpartHosts: ["example.com", "www.example.com"],
    });
  });
  it("is attached to a copy-mode preflight but not a local-docker one, and never changes the import planHash", () => {
    const f = fleet({ apps: [app("a", ["example.com"])] });
    const copy: ImportOptions = { sourceKind: "coolify" };
    expect(buildPreflight(f, copy).cutover).toMatchObject({ hosts: 1 });
    expect(buildPreflight(f, { sourceKind: "local-docker" }).cutover).toBeUndefined();
    // the hint lives only in the (unhashed) preflight: the plan hash is a pure function of items + options
    expect(planImport(f, copy).planHash).toBe(planImport(f, copy).planHash);
    expect(JSON.stringify(planImport(f, copy))).not.toContain("generatedHosts");
  });
  it("makes no promise about certificates being carried over", () => {
    const f = fleet({ apps: [app("a", ["example.com"])] });
    expect(JSON.stringify(buildPreflight(f, { sourceKind: "coolify" }))).not.toMatch(/zero.downtime|certificates? (are|is|will be) (carried|copied|transferred)/i);
  });
});

describe("buildPreflight (streamed copy ON, the default)", () => {
  const opts: ImportOptions = { sourceKind: "coolify", targetServerId: "t1" };
  const web: ForeignApp = { sourceRef: "a1", name: "web", kind: "git", buildPack: "dockerfile", volumes: [{ mountPath: "/data", type: "named", name: "v" }, { mountPath: "/media", hostPath: "/srv/m", type: "bind" }] };
  afterEach(() => {
    delete process.env.MIGRATION_VX_ENABLED;
    delete process.env.MIGRATION_VX_PART_MIB;
  });

  it("declared volumes are `stream` rows with the exact unmeasured text and the fidelity line; no `manual-large` ever", () => {
    const pf = buildPreflight(fleet({ apps: [web] }), opts);
    const data = pf.volumes!.find((v) => v.mountPath === "/data")!;
    expect(data.dataPlane).toBe("stream");
    expect(data.reason).toBe(
      "Streamed by the migrator in resumable parts of about 128 MiB. The source container must be stopped first. Size is not measured yet: run the migrator with --dry-run to measure it and check free space on the target. The target needs roughly the compressed size while it copies and about the full data size again while it extracts.",
    );
    expect(data.fidelity).toBe(
      "Copied: files, directories, symlinks, hard links, numeric owner and group, mode, modification time. Not copied: extended attributes, ACLs, file capabilities, sockets (listed per volume), device nodes (the copy is refused).",
    );
    expect(pf.volumes!.every((v) => v.dataPlane !== "manual-large" && v.dataPlane !== "hub-staged")).toBe(true);
  });

  it("a bind mount adds the exact bind sentence; the legacy phrases are gone from the stream path", () => {
    const pf = buildPreflight(fleet({ apps: [web] }), opts);
    const media = pf.volumes!.find((v) => v.mountPath === "/media")!;
    expect(media.dataPlane).toBe("stream");
    expect(media.reason).toContain(
      "Bind mounts are refused unless you run the migrator with --allow-bind. Ownership and mode come from the archive headers; extended attributes, ACLs and file capabilities are not copied.",
    );
    const all = JSON.stringify(pf);
    expect(all).not.toContain("do not raise the cap");
    expect(all).not.toContain("tar + rsync/scp");
  });

  it("a measured volume gets the exact measured text (size, parts, needed and free GiB)", () => {
    const inv = new Map<string, number>([["web:/data", 10 * 1024 ** 3]]);
    const pf = buildPreflight(fleet({ apps: [web] }), opts, inv);
    const data = pf.volumes!.find((v) => v.mountPath === "/data")!;
    expect(data.reason).toMatch(/^About 10 GiB in about 80 parts\. The source must stay stopped for the whole copy \(downtime until you start the app on the target\)\. The target needs about 22 GiB free and /);
    // with the target's free space known the sentence is complete
    expect(vxVolumeReason(10 * 1024 ** 3, 100 * 1024 ** 3)).toBe(
      "About 10 GiB in about 80 parts. The source must stay stopped for the whole copy (downtime until you start the app on the target). The target needs about 22 GiB free and has 100 GiB.",
    );
  });

  it("the part size follows MIGRATION_VX_PART_MIB", () => {
    process.env.MIGRATION_VX_PART_MIB = "64";
    expect(vxVolumeReason(undefined)).toContain("parts of about 64 MiB");
  });

  it("the volume note describes the streamed copy and the explicit exclusion rule", () => {
    const pf = buildPreflight(fleet({ apps: [web] }), opts);
    expect(pf.volumeDataNote).toMatch(/streams their DATA in resumable parts/);
    expect(pf.volumeDataNote).toMatch(/excluded explicitly/);
    expect(pf.volumeDataNote).not.toMatch(/do not raise|rsync/);
  });

  it("databases: every engine says why volume copy is or is not offered; a volume-mode Postgres is a `volume` row", () => {
    const f = fleet({ databases: [{ sourceRef: "pg1", name: "pg", engine: "POSTGRES" }, { sourceRef: "m1", name: "maria", engine: "MARIADB" }, { sourceRef: "r1", name: "rd", engine: "REDIS" }] });
    const plain = buildPreflight(f, opts);
    expect(plain.databases.map((d) => d.dataPlane)).toEqual(["one-click", "one-click", "one-click"]);
    expect(plain.databases[0].reason).toMatch(/Volume copy for this database/);
    expect(plain.databases[1].reason).toMatch(/root password lives in the copied system tables/);
    expect(plain.databases[2].reason).toMatch(/copied logically/);
    const vol = buildPreflight(f, { ...opts, dbDataModes: { "database:_:pg1": "volume", "database:_:m1": "volume" } });
    expect(vol.databases[0]).toMatchObject({ dataPlane: "volume" });
    expect(vol.databases[0].reason).toMatch(/same image and major run on both sides/);
    expect(vol.databases[1]).toMatchObject({ dataPlane: "blocked" }); // volume mode is Postgres-only
  });

  it("the kill switch restores the legacy rows", () => {
    process.env.MIGRATION_VX_ENABLED = "false";
    const pf = buildPreflight(fleet({ apps: [web] }), opts);
    expect(pf.volumes!.find((v) => v.mountPath === "/data")!.dataPlane).toBe("hub-staged");
    expect(pf.volumes![0]).not.toHaveProperty("fidelity");
  });
});

describe("buildPreflight: source hosts", () => {
  it("lists the source servers by name with their classification facts and no address", () => {
    const f = fleet({ servers: [{ ref: "s1", name: "host-1", ip: "10.0.0.1", controlPlane: true, unreachableCount: 7, os: "Ubuntu 24.04" }, { ref: "s2" }] });
    const pf = buildPreflight(f, { sourceKind: "coolify" } as ImportOptions);
    expect(pf.hosts).toEqual([{ ref: "s1", name: "host-1", controlPlane: true, unreachableCount: 7, os: "Ubuntu 24.04" }, { ref: "s2" }]);
    expect(JSON.stringify(pf.hosts)).not.toContain("10.0.0.1");
  });
  it("a source with no servers has no host list", () => {
    expect(buildPreflight(fleet({ servers: [] }), { sourceKind: "coolify" } as ImportOptions).hosts).toBeUndefined();
  });
});

describe("buildPreflight: source projects (additive, outside planHash)", () => {
  const o: ImportOptions = { sourceKind: "coolify", targetServerId: "t1" };
  const base = { buildPack: "image" as const, kind: "image" as const, image: "x" };
  const tree = [
    { ref: "p-acme", name: "Acme", tags: [], environments: [{ ref: "p-acme#1", name: "production", isDefault: true }] },
    { ref: "p-beta", name: "beta", tags: [], environments: [{ ref: "p-beta#2", name: "production", isDefault: true }] },
    { ref: "p-empty", name: "Empty", tags: [], environments: [] },
  ];
  it("lists each project that holds something with its itemRefs, sorted by name; an empty project is left out", () => {
    const f = fleet({
      projects: tree,
      apps: [
        { ...base, sourceRef: "a1", name: "web", serverRef: "s1", projectRef: "p-acme", environmentRef: "p-acme#1" },
        { ...base, sourceRef: "a2", name: "api", serverRef: "s2", projectRef: "p-beta", environmentRef: "p-beta#2" },
        { ...base, sourceRef: "a3", name: "loose" },
      ],
      databases: [{ sourceRef: "d1", name: "db", engine: "POSTGRES", serverRef: "s1", projectRef: "p-acme", environmentRef: "p-acme#1" } as ForeignFleet["databases"][number]],
      services: [{ sourceRef: "sv1", name: "search", memberApps: [], memberDbs: [], serverRef: "s2", projectRef: "p-acme", environmentRef: "p-acme#1" }],
    });
    expect(buildPreflight(f, o).projects).toEqual([
      { ref: "p-acme", name: "Acme", itemRefs: ["app:s1:a1", "database:s1:d1", "service:s2:sv1"] },
      { ref: "p-beta", name: "beta", itemRefs: ["app:s2:a2"] },
    ]);
  });
  it("is absent without a project tree; a service placement is part of the plan hash", () => {
    expect(buildPreflight(fleet({ apps: [{ ...base, sourceRef: "a1", name: "web" }] }), o).projects).toBeUndefined();
    const noTree = fleet({ apps: [{ ...base, sourceRef: "a1", name: "web", projectRef: "p-acme", environmentRef: "p-acme#1" }] });
    // a service's project placement is applied, so (like apps and databases) it is part of the plan and its hash
    const svc = (extra: Record<string, string>) =>
      fleet({ projects: tree, services: [{ sourceRef: "sv1", name: "search", memberApps: [], memberDbs: [], serverRef: "s2", ...extra }] });
    expect(planImport(svc({ projectRef: "p-acme", environmentRef: "p-acme#1" }), o).planHash).not.toBe(planImport(svc({}), o).planHash);
    expect(buildPreflight(noTree, o).projects).toBeUndefined();
  });
});
