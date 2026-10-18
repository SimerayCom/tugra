import { seedTasks, dependencyGate, deriveOpStatus, SKIP_NON_APP, type TaskStatus } from "./import-executor.logic";
import type { ForeignFleet, ImportPlan } from "./foreign-fleet";

const fleet: ForeignFleet = {
  servers: [{ ref: "srv1" }],
  apps: [
    { sourceRef: "c1", name: "web", kind: "image", buildPack: "image", image: "nginx", serverRef: "srv1" },
    { sourceRef: "c2", name: "api", kind: "image", buildPack: "image", image: "node", serverRef: "srv1" },
  ],
  databases: [],
  services: [],
  volumes: [],
  sharedEnv: [],
  warnings: [],
};

const plan: ImportPlan = {
  sourceKind: "local-docker",
  mode: "copy",
  warnings: [],
  planHash: "a".repeat(32),
  totals: { apps: 3, databases: 0, volumes: 1, blockers: 1 },
  items: [
    { itemRef: "app:srv1:c1", kind: "app", name: "web", proposed: {}, risks: [], dependsOn: ["volume:srv1:/data"] },
    { itemRef: "app:srv1:c2", kind: "app", name: "api", proposed: {}, risks: [{ level: "blocker", code: "x", message: "m" }], dependsOn: [] },
    { itemRef: "volume:srv1:/data", kind: "volume", name: "/data", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "app:srv1:ghost", kind: "app", name: "ghost", proposed: {}, risks: [], dependsOn: [] },
  ],
};

describe("seedTasks (local-docker)", () => {
  const seeds = seedTasks(plan, fleet);
  const byRef = (r: string) => seeds.find((s) => s.itemRef === r)!;

  it("makes a runnable adopt task for a clean app item (container ref + original name only)", () => {
    expect(byRef("app:srv1:c1")).toMatchObject({
      run: true,
      kind: "app",
      adopt: { container: "c1", originalName: "web" },
      dependsOn: ["volume:srv1:/data"],
    });
  });

  it("skips a blocked app, a non-app item, and an app with no matching source container", () => {
    expect(byRef("app:srv1:c2")).toMatchObject({ run: false, skipReason: "blocked by a plan risk" });
    expect(byRef("volume:srv1:/data")).toMatchObject({ run: false, skipReason: SKIP_NON_APP });
    expect(byRef("app:srv1:ghost")).toMatchObject({ run: false });
    expect(byRef("app:srv1:ghost").skipReason).toContain("no source container");
  });

  it("carries no secret material (adopt params are a container ref + name)", () => {
    expect(JSON.stringify(seeds)).not.toMatch(/password|secret/i);
  });
});

describe("dependencyGate", () => {
  const S = (pairs: Array<[string, TaskStatus]>) => new Map(pairs);
  it("ready when every dep is DONE/SKIPPED or not in this operation", () => {
    expect(dependencyGate(["a", "b", "x"], S([["a", "DONE"], ["b", "SKIPPED"]]))).toBe("ready");
    expect(dependencyGate([], S([]))).toBe("ready");
  });
  it("waits when a dep is still pending/running", () => {
    expect(dependencyGate(["a"], S([["a", "RUNNING"]]))).toBe("wait");
    expect(dependencyGate(["a"], S([["a", "PENDING"]]))).toBe("wait");
  });
  it("blocks when a dep failed/cancelled/rolled back", () => {
    expect(dependencyGate(["a"], S([["a", "FAILED"]]))).toBe("blocked");
    expect(dependencyGate(["a"], S([["a", "CANCELLED"]]))).toBe("blocked");
    expect(dependencyGate(["a", "b"], S([["a", "DONE"], ["b", "ROLLED_BACK"]]))).toBe("blocked");
  });
});

describe("deriveOpStatus", () => {
  it("RUNNING while any task is active", () => {
    expect(deriveOpStatus(["DONE", "PENDING"])).toBe("RUNNING");
    expect(deriveOpStatus(["RUNNING"])).toBe("RUNNING");
  });
  it("SUCCEEDED when all done/skipped/rolled-back (or empty)", () => {
    expect(deriveOpStatus(["DONE", "SKIPPED"])).toBe("SUCCEEDED");
    expect(deriveOpStatus([])).toBe("SUCCEEDED");
    expect(deriveOpStatus(["ROLLED_BACK", "SKIPPED"])).toBe("SUCCEEDED");
  });
  it("FAILED when all failed, PARTIAL when some also succeeded", () => {
    expect(deriveOpStatus(["FAILED", "SKIPPED"])).toBe("FAILED");
    expect(deriveOpStatus(["FAILED", "DONE"])).toBe("PARTIAL");
  });
  it("CANCELLED when cancelled and nothing failed", () => {
    expect(deriveOpStatus(["CANCELLED", "SKIPPED"])).toBe("CANCELLED");
    expect(deriveOpStatus(["CANCELLED", "DONE"])).toBe("CANCELLED");
  });
});
