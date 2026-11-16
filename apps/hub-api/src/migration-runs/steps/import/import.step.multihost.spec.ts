/** IMPORT on a multi-host run (grup-7, R12): the serverMap reaches the importer, and an unplaced source server fails closed. */
import { Logger } from "@nestjs/common";
import { RunWorld, SERVER, TEAM, defaultPlan } from "../../core/testing/run-world";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const MAP = { "src-a": "srv2", "src-b": "srv3" };
const world = (): RunWorld => {
  const w = new RunWorld();
  for (const [id, name] of [["srv2", "host-2"], ["srv3", "host-3"]] as const) w.env.serversById.set(id, { id, name, teamId: TEAM });
  w.port.plan_ = defaultPlan({
    items: [
      { itemRef: "database:src-a:db1", kind: "database", name: "db-big", proposed: {}, risks: [], dependsOn: [] },
      { itemRef: "app:src-a:web", kind: "app", name: "app-a", proposed: {}, risks: [], dependsOn: ["database:src-a:db1"] },
      { itemRef: "app:src-b:api", kind: "app", name: "app-b", proposed: {}, risks: [], dependsOn: [] },
    ],
    totals: { apps: 2, databases: 1, volumes: 0, blockers: 0 },
  });
  return w;
};
const importStep = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "IMPORT")!;
const spyApply = (w: RunWorld): unknown[] => {
  const seen: unknown[] = [];
  const orig = w.port.apply.bind(w.port);
  w.port.apply = async (u, input) => {
    seen.push(input);
    return orig(u, input);
  };
  return seen;
};

describe("IMPORT with a serverMap", () => {
  it("hands the run's serverMap to the importer next to the frozen input; the frozen input itself stays map-free", async () => {
    const w = world();
    const seen = spyApply(w);
    const id = await w.run({ serverMap: MAP });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sourceKind: "coolify", targetServerId: SERVER, serverMap: MAP });
    expect(w.store.row(id).applyInput).not.toHaveProperty("serverMap");
    expect(w.store.row(id).opId).toBe("op-1");
  });

  it("a single-target run sends no serverMap at all (byte-identical to before)", async () => {
    const w = world();
    const seen = spyApply(w);
    await w.run();
    expect(seen[0]).not.toHaveProperty("serverMap");
  });

  it("fails closed: a source server the map does not place stops the step before apply, naming the servers", async () => {
    const w = world();
    const seen = spyApply(w);
    const id = await w.run({ serverMap: { "src-a": "srv2" } });
    expect(seen).toHaveLength(0);
    expect(w.port.calls).not.toContain("apply");
    const gate = JSON.stringify((await importStep(w, id)).gate ?? (await w.view(id)));
    expect(gate).toContain("import.server-unmapped");
    expect(gate).toContain("src-b");
  });

  it("an explicit service choice (own target, or skipped) places that service, so it never counts as unplaced", async () => {
    const w = world();
    w.port.plan_ = defaultPlan({
      items: [
        { itemRef: "app:src-a:web", kind: "app", name: "app-a", proposed: {}, risks: [], dependsOn: [] },
        { itemRef: "service:src-z:s1", kind: "service", name: "svc-1", proposed: { verdict: "importable" }, risks: [], dependsOn: [] },
        { itemRef: "service:src-y:s2", kind: "service", name: "svc-2", proposed: { verdict: "importable" }, risks: [], dependsOn: [] },
      ],
      totals: { apps: 1, databases: 0, volumes: 0, blockers: 0 },
    });
    const seen = spyApply(w);
    await w.run({ serverMap: { "src-a": "srv2" }, serviceChoices: { "service:src-z:s1": { targetServerId: "srv3" }, "service:src-y:s2": { skip: true } } });
    expect(seen).toHaveLength(1);
  });

  it("dry-run projects the placement and blocks on an unplaced source server", async () => {
    const w = world();
    const ok = await w.create({ dryRun: true, serverMap: MAP });
    await w.settle(ok);
    const okItems = (await importStep(w, ok)).progress!.dryRun!;
    expect(okItems).toContainEqual(expect.objectContaining({ code: "import.placement", level: "info", params: { targets: 3, sources: 2 } }));
    expect(okItems.map((i) => i.code)).not.toContain("import.server-unmapped");

    const bad = await w.create({ dryRun: true, serverMap: { "src-a": "srv2" } });
    await w.settle(bad);
    const items = (await importStep(w, bad)).progress!.dryRun!;
    expect(items).toContainEqual(expect.objectContaining({ code: "import.server-unmapped", level: "block", params: { count: 1, servers: ["src-b"] } }));
    expect(w.port.calls).toEqual([]);
  });

  it("a single-target dry-run has no placement line", async () => {
    const w = world();
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    expect((await importStep(w, id)).progress!.dryRun!.map((i) => i.code)).not.toContain("import.placement");
  });
});
