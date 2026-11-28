import { buildCoolifyFleet } from "./coolify-map";
import { planImport } from "../import-planner";

/** Two source servers: the one the owner moves (North) and one he leaves out (the other team's). */
const apps = [
  { uuid: "a-north", name: "north-api", build_pack: "nixpacks", git_repository: "o/r", status: "exited:unhealthy", restart_count: 3 },
  { uuid: "a-sf", name: "reelhub-api", build_pack: "nixpacks", git_repository: "o/r", status: "exited:unhealthy", restart_count: 126368 },
  { uuid: "a-ok", name: "fine", build_pack: "nixpacks", git_repository: "o/r", status: "running:healthy", restart_count: 0 },
];
const dbs = [
  { uuid: "d-north", name: "db-north", database_type: "standalone-postgresql", image: "postgres:16" },
  { uuid: "d-decl", name: "db-ledger", database_type: "standalone-postgresql", image: "postgres:16" },
];
const backup = { enabled: true, save_s3: true, frequency: "daily", s3_storage_id: 7 };

const fleet = () =>
  buildCoolifyFleet({
    servers: [{ uuid: "s-north", name: "north" }, { uuid: "s-other", name: "other" }] as never,
    resourcesByServer: { "s-north": ["a-north", "d-north"], "s-other": ["a-sf", "a-ok", "d-decl"] },
    apps,
    databases: dbs,
    services: [],
    envsByResource: {},
    volumesByResource: {},
    backupsByResource: { "d-north": [backup], "d-decl": [backup] },
    s3Storages: [{ id: 7, name: "Infra Simeray" }] as never,
  });

describe("the plan's notes know which items they are about (a narrowed review shows only its own)", () => {
  it("an unhealthy app and a database's S3 backup each carry the itemRef of their own item", () => {
    const f = fleet();
    const refs = (re: RegExp) => f.scopedWarnings!.filter((w) => re.test(w.text)).map((w) => [w.text.split(" ").slice(0, 2).join(" "), w.itemRefs]);
    expect(refs(/not healthy at the source/)).toEqual([["app north-api", ["app:s-north:a-north"]], ["app reelhub-api", ["app:s-other:a-sf"]]]);
    expect(refs(/uploads to S3/)).toEqual([["database db-north", ["database:s-north:d-north"]], ["database db-ledger", ["database:s-other:d-decl"]]]);
    // the shared explanation belongs to every database it applies to
    expect(f.scopedWarnings!.find((w) => /does not carry the backup schedules/.test(w.text))!.itemRefs).toEqual(["database:s-north:d-north", "database:s-other:d-decl"]);
  });

  it("every scoped note is also in `warnings`, and the plan carries them (outside the hash)", () => {
    const f = fleet();
    for (const w of f.scopedWarnings!) expect(f.warnings).toContain(w.text);
    const a = planImport(f, { sourceKind: "coolify" });
    const b = planImport({ ...f, scopedWarnings: undefined }, { sourceKind: "coolify" });
    expect(a.scopedWarnings).toEqual(f.scopedWarnings);
    expect(b.scopedWarnings).toBeUndefined();
    expect(a.planHash).toBe(b.planHash);
    // every itemRef a note names is a real plan item
    const known = new Set(a.items.map((i) => i.itemRef));
    for (const w of f.scopedWarnings!) for (const r of w.itemRefs) expect(known.has(r)).toBe(true);
  });

  it("there is no cap on the unhealthy notes in the plan: the review caps what it shows after it scoped them", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ uuid: `a${i}`, name: `app${i}`, build_pack: "nixpacks", git_repository: "o/r", status: "exited:unhealthy", restart_count: 1 }));
    const f = buildCoolifyFleet({ servers: [], resourcesByServer: {}, apps: many, databases: [], services: [], envsByResource: {}, volumesByResource: {} });
    expect(f.warnings.filter((w) => /not healthy at the source/.test(w))).toHaveLength(25);
  });
});
