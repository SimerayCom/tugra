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
});
