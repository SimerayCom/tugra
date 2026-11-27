import { buildPreflight } from "./preflight";
import { planImport } from "./import-planner";
import { buildCaproverFleet, type CaproverAppDefinition } from "./sources/caprover-map";
import { caproverDefinitions } from "./__fixtures__/caprover.fixture";

const fleet = () => buildCaproverFleet({ definitions: caproverDefinitions() as unknown as CaproverAppDefinition[], rootDomain: "captain.example.com" });

describe("CapRover preflight: data is copied by hand", () => {
  it("marks every database and volume as manual, never migrator-assisted or hub-staged", () => {
    const pre = buildPreflight(fleet(), { sourceKind: "caprover" });
    expect(pre.databases.length).toBeGreaterThan(0);
    for (const d of pre.databases) expect(d.dataPlane).toBe("manual");
    expect((pre.volumes ?? []).length).toBeGreaterThan(0);
    for (const v of pre.volumes ?? []) expect(v.dataPlane).toBe("manual");
    expect(pre.volumeDataNote).toContain("CapRover");
    expect(JSON.stringify(pre)).not.toMatch(/migrator/i);
  });

  it("blocks a volume-copy choice for a CapRover database at plan time", () => {
    const f = fleet();
    const pg = f.databases.find((d) => d.engine === "POSTGRES")!;
    const plan = planImport(f, { sourceKind: "caprover", dbDataModes: { [`database:_:${pg.sourceRef}`]: "volume" } });
    const item = plan.items.find((i) => i.itemRef === `database:_:${pg.sourceRef}`)!;
    expect(item.risks.some((r) => r.level === "blocker" && r.code === "db.volume.source")).toBe(true);
  });
});
