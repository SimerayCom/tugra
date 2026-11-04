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
    expect(pf.services).toEqual([{ name: "signoz", members: 2, note: expect.stringMatching(/not imported/i) }]);
    expect(pf.appsWithVolumeData).toBe(1);
    expect(pf.volumeDataNote).toMatch(/not copied/i);
  });

  it("local-docker adopts volumes in place → no volume-data caveat", () => {
    const f = fleet({ apps: [{ sourceRef: "a1", name: "web", kind: "image", buildPack: "image", volumes: [{ mountPath: "/data", type: "named", name: "v" }] }] });
    const pf = buildPreflight(f, { sourceKind: "local-docker" });
    expect(pf.appsWithVolumeData).toBe(0);
    expect(pf.volumeDataNote).toBeUndefined();
  });
});
