import { planImport } from "./import-planner";
import { mapBuildPack } from "./buildpack-map";
import type { ForeignFleet, ImportOptions } from "./foreign-fleet";

describe("mapBuildPack", () => {
  it("maps known build packs to Tugra source + build type", () => {
    expect(mapBuildPack({ buildPack: "nixpacks" })).toEqual({ source: "GIT", buildType: "NIXPACKS" });
    expect(mapBuildPack({ buildPack: "railpack" })).toEqual({ source: "GIT", buildType: "RAILPACK" });
    expect(mapBuildPack({ buildPack: "static" })).toEqual({ source: "GIT", buildType: "STATIC" });
    expect(mapBuildPack({ buildPack: "dockerfile" })).toEqual({ source: "GIT", buildType: "DOCKERFILE" });
    expect(mapBuildPack({ buildPack: "herokuish" })).toEqual({ source: "GIT", buildType: "HEROKU" });
    expect(mapBuildPack({ buildPack: "paketo" })).toEqual({ source: "GIT", buildType: "HEROKU" });
    expect(mapBuildPack({ buildPack: "dockercompose" })).toEqual({ source: "COMPOSE" });
    expect(mapBuildPack({ buildPack: "image" })).toEqual({ source: "IMAGE" });
  });
  it("falls back for an unknown build pack, with a note (git → Nixpacks, else image)", () => {
    expect(mapBuildPack({ buildPack: "unknown", git: { url: "x" } })).toMatchObject({ source: "GIT", buildType: "NIXPACKS", note: expect.any(String) });
    expect(mapBuildPack({ buildPack: "unknown" })).toMatchObject({ source: "IMAGE", note: expect.any(String) });
  });
});

const fleet: ForeignFleet = {
  servers: [{ ref: "srv1", name: "box-1" }],
  apps: [
    { sourceRef: "a1", name: "web", kind: "git", buildPack: "nixpacks", serverRef: "srv1", git: { url: "https://git/x", branch: "main" }, domains: [{ host: "a.com", primary: true }, { host: "www.a.com" }], env: [{ key: "K" }], volumes: [{ mountPath: "/data", hostPath: "/srv/x", type: "bind" }], links: [{ kind: "database", ref: "d1", envKey: "DATABASE_URL" }] },
    { sourceRef: "a2", name: "stack", kind: "compose", buildPack: "dockercompose", serverRef: "srv1", composeFile: "services: {}", domains: [{ host: "b.com" }] },
    { sourceRef: "a3", name: "mystery", kind: "image", buildPack: "unknown", serverRef: "srv1", installCommand: "npm ci" },
  ],
  databases: [
    { sourceRef: "d1", name: "orders", engine: "POSTGRES", version: "16", image: "pgvector/pgvector:pg16", credentials: { username: "u", database: "orders", secretRef: "d1" }, serverRef: "srv1" },
    { sourceRef: "d2", name: "edge", engine: "LIBSQL", serverRef: "srv1" },
  ],
  services: [],
  volumes: [{ name: "shared", mountPath: "/shared", type: "named" }],
  sharedEnv: [],
  warnings: [],
};
const opts: ImportOptions = { sourceKind: "coolify", targetServerId: "t-srv" };

describe("planImport", () => {
  const plan = planImport(fleet, opts);

  it("plans every app, database and volume (standalone + app-owned); counts blockers", () => {
    // volumes: standalone "shared" + a1's bind mount = 2; blockers: LIBSQL db + un-importable a3 = 2
    expect(plan.totals).toEqual({ apps: 3, databases: 2, volumes: 2, blockers: 2 });
    expect(plan.sourceKind).toBe("coolify");
    expect(plan.mode).toBe("copy");
  });

  it("namespaces itemRefs by kind:server:ref so same-named resources never collide", () => {
    const refs = plan.items.map((i) => i.itemRef).sort();
    expect(refs).toEqual(
      ["app:srv1:a1", "app:srv1:a2", "app:srv1:a3", "database:srv1:d1", "database:srv1:d2", "volume:_:shared", "volume:srv1:/srv/x"].sort(),
    );
  });

  it("orders an app after its linked database and its volume (dependsOn derived)", () => {
    const a1 = plan.items.find((i) => i.itemRef === "app:srv1:a1")!;
    expect(a1.dependsOn).toEqual(expect.arrayContaining(["database:srv1:d1", "volume:srv1:/srv/x"]));
    expect(a1.proposed.domain).toBe("a.com"); // primary wins
    expect(a1.risks.map((r) => r.code)).toEqual(expect.arrayContaining(["app.domain.multi", "app.volume.bind"]));
  });

  it("blocks LIBSQL (no dump path) and an app with no image and no git", () => {
    expect(plan.items.find((i) => i.itemRef === "database:srv1:d2")!.risks.some((r) => r.level === "blocker")).toBe(true);
    const a3 = plan.items.find((i) => i.itemRef === "app:srv1:a3")!;
    expect(a3.risks.some((r) => r.code === "app.image.missing" && r.level === "blocker")).toBe(true);
    expect(a3.risks.map((r) => r.code)).toEqual(expect.arrayContaining(["app.buildpack", "app.installCommand"]));
  });

  it("keeps a custom DB image and warns to match the Mongo name; never leaks secret values", () => {
    const d1 = plan.items.find((i) => i.itemRef === "database:srv1:d1")!;
    expect(d1.proposed).toMatchObject({ engine: "POSTGRES", image: "pgvector/pgvector:pg16" });
    // the plan carries an env COUNT, never values
    expect(plan.items.find((i) => i.itemRef === "app:srv1:a1")!.proposed.envCount).toBe(1);
    expect(JSON.stringify(plan)).not.toContain("secretRef"); // refs stay out of the plan too
  });

  it("produces a deterministic planHash (same input → same hash)", () => {
    expect(plan.planHash).toMatch(/^[a-f0-9]{32}$/);
    expect(planImport(fleet, opts).planHash).toBe(plan.planHash);
  });

  it("carries source-level warnings through to the plan, but never into the planHash", () => {
    expect(plan.warnings).toEqual([]);
    const withWarn = planImport({ ...fleet, warnings: ["3 compose-managed container(s) skipped"] }, opts);
    expect(withWarn.warnings).toEqual(["3 compose-managed container(s) skipped"]);
    expect(withWarn.planHash).toBe(plan.planHash); // advisory warnings must not perturb the hash
  });
});

describe("planImport — volume declare honesty (Portability-V1)", () => {
  const withVols: ForeignFleet = {
    servers: [{ ref: "s", name: "box" }],
    apps: [
      { sourceRef: "named", name: "named", kind: "git", buildPack: "nixpacks", serverRef: "s", git: { url: "g" }, volumes: [{ mountPath: "/data", type: "named" }, { mountPath: "/etc/x.conf", type: "file" }] },
      { sourceRef: "bindapp", name: "bindapp", kind: "git", buildPack: "nixpacks", serverRef: "s", git: { url: "g" }, volumes: [{ mountPath: "/media", hostPath: "/srv/m", type: "bind" }] },
      { sourceRef: "composed", name: "composed", kind: "compose", buildPack: "dockercompose", serverRef: "s", composeFile: "services: {}", volumes: [{ mountPath: "/data", type: "named" }] },
    ],
    databases: [], services: [], volumes: [], sharedEnv: [], warnings: [],
  };
  const plan = planImport(withVols, { sourceKind: "coolify" });
  const app = (ref: string) => plan.items.find((i) => i.itemRef === ref)!;

  it("describes an empty-but-declared named volume and no longer claims conversion; reports skipped mounts", () => {
    const a = app("app:s:named");
    const named = a.risks.find((r) => r.code === "app.volume.named")!;
    expect(named.message).toMatch(/EMPTY named volume/);
    expect(named.message).toMatch(/upload its DATA to the hub/i); // P3 v1: manual tar+curl upload, NOT an automated migrator step
    expect(named.message).not.toMatch(/converted/i);
    expect(named.message).not.toMatch(/the migrator('s)? volume step/i); // never claim an automated step that isn't shipped
    expect(a.proposed.volumeMounts).toBe(1); // the file mount is skipped; the named mount is declared
    expect(a.risks.find((r) => r.code === "app.volume.skipped")!.message).toMatch(/file-mount/);
  });

  it("describes a bind as an empty named volume at the container path (host folder not mounted)", () => {
    const b = app("app:s:bindapp");
    const bind = b.risks.find((r) => r.code === "app.volume.bind")!;
    expect(bind.message).toMatch(/EMPTY named volume/);
    expect(bind.message).not.toMatch(/converted/i);
    expect(b.proposed.volumeMounts).toBe(1);
  });

  it("does not declare volumes for a compose app; flags that they live in the compose file", () => {
    const c = app("app:s:composed");
    expect(c.proposed.volumeMounts).toBe(0);
    expect(c.risks.some((r) => r.code === "app.volume.compose")).toBe(true);
    expect(c.risks.some((r) => r.code === "app.volume.bind" || r.code === "app.volume.named")).toBe(false);
  });

  it("local-docker (carried) keeps the re-attach wording and declares no mapper-derived mounts", () => {
    const carried = planImport({ ...withVols, apps: [withVols.apps[0]] }, { sourceKind: "local-docker" });
    const a = carried.items.find((i) => i.itemRef === "app:s:named")!;
    const named = a.risks.find((r) => r.code === "app.volume.named")!;
    expect(named.message).toMatch(/re-attached/);
    expect(a.proposed.volumeMounts).toBeUndefined(); // the mapper is not run for local-docker (it adopts in place)
  });

  it("does not claim a volume is declared when every mount of the app is skipped", () => {
    const f: ForeignFleet = {
      servers: [{ ref: "s", name: "b" }],
      apps: [{ sourceRef: "x", name: "x", kind: "git", buildPack: "nixpacks", serverRef: "s", git: { url: "g" }, volumes: [{ mountPath: "/my data", type: "named" }] }],
      databases: [], services: [], volumes: [], sharedEnv: [], warnings: [],
    };
    const a = planImport(f, { sourceKind: "coolify" }).items.find((i) => i.itemRef === "app:s:x")!;
    expect(a.risks.some((r) => r.code === "app.volume.named")).toBe(false); // the only mount was skipped (invalid-path)
    expect(a.risks.find((r) => r.code === "app.volume.skipped")!.message).toMatch(/invalid-path/);
    expect(a.proposed.volumeMounts).toBe(0);
  });

  it("keeps planHash independent of the source's mount discovery order", () => {
    const mk = (vols: unknown[]): ForeignFleet => ({
      servers: [{ ref: "s", name: "b" }],
      apps: [{ sourceRef: "x", name: "x", kind: "git", buildPack: "nixpacks", serverRef: "s", git: { url: "g" }, volumes: vols as never }],
      databases: [], services: [], volumes: [], sharedEnv: [], warnings: [],
    });
    const vols = [{ mountPath: "/a", type: "file" }, { mountPath: "/b/../c", type: "named" }];
    const forward = planImport(mk(vols), { sourceKind: "coolify" }).planHash;
    const reversed = planImport(mk([...vols].reverse()), { sourceKind: "coolify" }).planHash;
    expect(forward).toBe(reversed);
  });
});

describe("planImport — private GitHub-App repos (İş 2)", () => {
  const gh: ForeignFleet = {
    servers: [{ ref: "s", name: "box" }],
    apps: [
      { sourceRef: "priv", name: "priv", kind: "git", buildPack: "nixpacks", serverRef: "s", git: { url: "https://github.com/o/r.git", provider: "github" } },
      { sourceRef: "pub", name: "pub", kind: "git", buildPack: "nixpacks", serverRef: "s", git: { url: "https://github.com/o/pub.git" } },
    ],
    databases: [], services: [], volumes: [], sharedEnv: [], warnings: [],
  };
  const plan = planImport(gh, { sourceKind: "coolify" });

  it("warns (not blocks) that a private GitHub repo will be auto-linked to a connected GitHub App", () => {
    const priv = plan.items.find((i) => i.itemRef === "app:s:priv")!;
    const r = priv.risks.find((x) => x.code === "app.git.private");
    expect(r).toBeDefined();
    expect(r!.level).toBe("warn"); // never a blocker — the import proceeds and auto-links when possible
  });

  it("does NOT warn for a plain (public) git URL", () => {
    const pub = plan.items.find((i) => i.itemRef === "app:s:pub")!;
    expect(pub.risks.some((x) => x.code === "app.git.private")).toBe(false);
  });
});

describe("planImport — compose source blocker (git-sourced compose)", () => {
  const compose = (over: Record<string, unknown>) =>
    planImport({ ...fleet, databases: [], apps: [{ sourceRef: "c", name: "c", kind: "compose", buildPack: "dockercompose", serverRef: "srv1", ...over }] }, opts).items.find((i) => i.kind === "app")!;
  const codes = (item: { risks: Array<{ code: string }> }) => item.risks.map((r) => r.code);

  it("does NOT raise app.compose.missing for a git-compose (no composeFile, git source with composePath)", () => {
    const it1 = compose({ git: { url: "https://github.com/acme/playtolk.git", branch: "main", composePath: "docker-compose.prod.yml" } });
    expect(codes(it1)).not.toContain("app.compose.missing");
    expect(it1.risks.some((r) => r.level === "blocker")).toBe(false);
  });

  it("STILL raises app.compose.missing when there is neither a composeFile nor a git source", () => {
    expect(codes(compose({}))).toContain("app.compose.missing");
  });

  it("a raw compose (composeFile set) plans without the blocker", () => {
    const it2 = compose({ composeFile: "services: {}" });
    expect(codes(it2)).not.toContain("app.compose.missing");
    expect(codes(it2)).toContain("app.compose");
  });

  it("a git-compose is honest: deploy-time validation note, and warns per-service domains aren't carried; no path warn when composePath is known", () => {
    const it3 = compose({
      git: { url: "https://github.com/acme/playtolk.git", branch: "main", composePath: "docker-compose.prod.yml", provider: "github" },
      domains: [{ host: "playtolk.com", primary: true, serviceRef: "playtolk-web" }],
    });
    expect(it3.risks.find((r) => r.code === "app.compose")?.message).toMatch(/cloned from git and validated at deploy/i);
    expect(codes(it3)).toContain("app.compose.domains"); // per-service domains deferred → warned, not silently lost
    expect(it3.risks.find((r) => r.code === "app.compose.domains")?.message).toContain("playtolk-web");
    expect(codes(it3)).not.toContain("app.compose.path"); // composePath is known
  });

  it("a git-compose with an UNKNOWN composePath (e.g. a tokenless Coolify git-compose) warns instead of silently defaulting", () => {
    const it4 = compose({ git: { url: "https://github.com/acme/x.git", branch: "main" } });
    expect(codes(it4)).not.toContain("app.compose.missing"); // allowed…
    expect(codes(it4)).toContain("app.compose.path"); // …but the compose path is flagged, not silently docker-compose.yml
  });
});
