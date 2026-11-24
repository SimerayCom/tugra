import { describe, it, expect } from "vitest";
import { applyScopeToDoc, buildScope, emptySelection, hostOfItemRef, initialSelection, inScopeRefs, involvedHosts, missingDependencies, projectChoicesFor, scopedPlan, scopeIssue, scopeServiceSkips, sourceProjectRows, type ScopeSelection } from "./import-scope";
import { emptyDoc } from "./import-mapping";
import type { ImportPlan, ImportPlanItem } from "./types";

const item = (itemRef: string, kind: ImportPlanItem["kind"], name: string, over: Partial<ImportPlanItem> = {}): ImportPlanItem => ({ itemRef, kind, name, proposed: {}, risks: [], dependsOn: [], ...over });

// two source servers (s1, s2) and two projects (Acme: web + db + search stack, Beta: api on s2)
const WEB = "app:s1:web";
const DB = "database:s1:db";
const API = "app:s2:api";
const API_DB = "database:s2:apidb";
const SVC = "service:s1:search";
const VOL = "volume:s1:data";
const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 2, databases: 2, volumes: 1, blockers: 1, services: 1 },
  items: [
    item(WEB, "app", "web", { dependsOn: [DB, VOL] }),
    item(DB, "database", "db"),
    item(VOL, "volume", "data"),
    item(API, "app", "api", { dependsOn: [API_DB, DB], risks: [{ level: "blocker", code: "app.env.unresolved", message: "x" }] }),
    item(API_DB, "database", "apidb"),
    item(SVC, "service", "search"),
  ],
  preflight: {
    databases: [
      { name: "db", engine: "POSTGRES", dataPlane: "one-click", reason: "" },
      { name: "apidb", engine: "POSTGRES", dataPlane: "one-click", reason: "" },
    ],
    services: [{ name: "search", members: 1, note: "" }],
    appsWithVolumeData: 0,
    hosts: [{ ref: "s1", name: "Box One" }, { ref: "s2", name: "Box Two" }],
    projects: [
      { ref: "p-acme", name: "Acme", itemRefs: [WEB, DB, SVC] },
      { ref: "p-beta", name: "Beta", itemRefs: [API, API_DB] },
    ],
  },
  ...over,
});

const sel = (over: Partial<ScopeSelection>): ScopeSelection => ({ ...emptySelection(), ...over });

describe("hostOfItemRef", () => {
  it("reads the source server, `_` when unknown", () => {
    expect(hostOfItemRef("app:s1:web")).toBe("s1");
    expect(hostOfItemRef("app:_:web")).toBe("_");
    expect(hostOfItemRef("garbage")).toBe("_");
  });
});

describe("sourceProjectRows", () => {
  it("counts what each project holds from the plan", () => {
    expect(sourceProjectRows(plan())).toEqual([
      { ref: "p-acme", name: "Acme", apps: 1, databases: 1, services: 1 },
      { ref: "p-beta", name: "Beta", apps: 1, databases: 1, services: 0 },
    ]);
  });
  it("is empty without a project tree", () => {
    const p = plan();
    expect(sourceProjectRows({ ...p, preflight: { ...p.preflight!, projects: undefined } })).toEqual([]);
  });
});

describe("inScopeRefs", () => {
  it("everything keeps every item", () => {
    expect(inScopeRefs(plan(), emptySelection()).size).toBe(6);
  });
  it("a source server selects what runs on it, with the volumes its apps carry", () => {
    const r = inScopeRefs(plan(), sel({ mode: "servers", hosts: new Set(["s2"]) }));
    expect([...r].sort()).toEqual([API, API_DB].sort());
    const r1 = inScopeRefs(plan(), sel({ mode: "servers", hosts: new Set(["s1"]) }));
    expect([...r1].sort()).toEqual([DB, SVC, VOL, WEB].sort());
  });
  it("a project selects its items on any server (a service stack included)", () => {
    expect([...inScopeRefs(plan(), sel({ mode: "projects", projects: new Set(["p-acme"]) }))].sort()).toEqual([DB, SVC, VOL, WEB].sort());
  });
  it("several projects add up; nothing picked is empty; extras are added", () => {
    expect(inScopeRefs(plan(), sel({ mode: "projects", projects: new Set(["p-acme", "p-beta"]) })).size).toBe(6);
    expect(inScopeRefs(plan(), sel({ mode: "projects" })).size).toBe(0);
    expect(inScopeRefs(plan(), sel({ mode: "servers", hosts: new Set(["s2"]), extra: new Set([DB]) })).has(DB)).toBe(true);
  });
});

describe("involvedHosts / missingDependencies", () => {
  it("only the source servers with something in scope are involved", () => {
    const inScope = inScopeRefs(plan(), sel({ mode: "projects", projects: new Set(["p-beta"]) }));
    expect(involvedHosts(plan(), inScope).map((h) => h.ref)).toEqual(["s2"]);
  });
  it("an app that links to a database left out is reported with who needs it", () => {
    const inScope = inScopeRefs(plan(), sel({ mode: "projects", projects: new Set(["p-beta"]) }));
    expect(missingDependencies(plan(), inScope)).toEqual([{ itemRef: DB, name: "db", neededBy: ["api"] }]);
    expect(missingDependencies(plan(), inScopeRefs(plan(), emptySelection()))).toEqual([]);
  });
});

describe("buildScope", () => {
  it("everything on one server: no serverMap, the default is that server", () => {
    const s = buildScope(plan(), initialSelection(plan(), "t1"), "t1");
    expect(s.narrowed).toBe(false);
    expect(s.serverMap).toBeUndefined();
    expect(s.defaultServerId).toBe("t1");
  });
  it("two source servers on two Tugra servers send a serverMap listing every involved source server", () => {
    const s = buildScope(plan(), { ...initialSelection(plan(), "t1"), placement: { s1: "t1", s2: "t2" } }, "t1");
    expect(s.serverMap).toEqual({ s1: "t1", s2: "t2" });
  });
  it("a server pick narrows the scope and only that server is placed", () => {
    const s = buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s2"]), placement: { s2: "t2" } }), "t1");
    expect(s.narrowed).toBe(true);
    expect(s.serverMap).toBeUndefined();
    expect(s.defaultServerId).toBe("t2");
  });
  it("an involved server with no pick falls back to the given server", () => {
    expect(buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s1"]) }), "t9").defaultServerId).toBe("t9");
  });
});

describe("scopeIssue", () => {
  const teamOf = (id: string) => ({ t1: "A", t2: "A", t3: "B" })[id];
  it("nothing picked blocks", () => {
    expect(scopeIssue(plan(), buildScope(plan(), sel({ mode: "servers" }), "t1"), teamOf)).toBe("nothing");
  });
  it("targets in two teams block; one team is fine", () => {
    expect(scopeIssue(plan(), buildScope(plan(), { ...initialSelection(plan(), "t1"), placement: { s1: "t1", s2: "t3" } }, "t1"), teamOf)).toBe("teams");
    expect(scopeIssue(plan(), buildScope(plan(), { ...initialSelection(plan(), "t1"), placement: { s1: "t1", s2: "t2" } }, "t1"), teamOf)).toBeNull();
  });
  it("a missing target blocks", () => {
    expect(scopeIssue(plan(), buildScope(plan(), initialSelection(plan(), ""), ""), teamOf)).toBe("target");
  });
});

describe("applyScopeToDoc / scopeServiceSkips / scopedPlan", () => {
  const inScope = inScopeRefs(plan(), sel({ mode: "projects", projects: new Set(["p-beta"]) }));
  it("excludes the apps and databases that are out of scope and nothing else", () => {
    const d = applyScopeToDoc(emptyDoc(), plan(), inScope);
    expect(d.items).toEqual({ [WEB]: { include: false }, [DB]: { include: false } });
  });
  it("an explicit in-scope include clears a stored exclude", () => {
    const stored = { ...emptyDoc(), items: { [API]: { include: false } } };
    expect(applyScopeToDoc(stored, plan(), inScope).items[API]).toBeUndefined();
  });
  it("skips the out-of-scope service stacks", () => {
    expect(scopeServiceSkips(plan(), inScope)).toEqual({ [SVC]: { skip: true } });
    expect(scopeServiceSkips(plan(), inScopeRefs(plan(), emptySelection()))).toEqual({});
  });
  it("the scoped plan keeps the hash, recounts, drops the blockers of what is left out, and trims the named lists", () => {
    const only = inScopeRefs(plan(), sel({ mode: "servers", hosts: new Set(["s1"]) }));
    const sp = scopedPlan(plan(), only);
    expect(sp.planHash).toBe("a".repeat(32));
    expect(sp.totals).toEqual({ apps: 1, databases: 1, volumes: 1, blockers: 0, services: 1 });
    expect(sp.preflight?.databases.map((d) => d.name)).toEqual(["db"]);
    expect(sp.items.map((i) => i.itemRef).sort()).toEqual([DB, SVC, VOL, WEB].sort());
  });
  it("is the very same plan object when nothing is left out", () => {
    const p = plan();
    expect(scopedPlan(p, inScopeRefs(p, emptySelection()))).toBe(p);
  });
});

describe("projectChoicesFor", () => {
  it("existing projects first, then what the import creates and the source's own names, each once and marked new", () => {
    const r = projectChoicesFor([{ name: "Shop" }], [{ name: "shop", willCreate: false }, { name: "Billing", willCreate: true }, { name: "Kept", willCreate: false }], ["Acme", "billing"]);
    expect(r).toEqual([{ name: "Shop" }, { name: "Billing", isNew: true }, { name: "Kept" }, { name: "Acme", isNew: true }]);
  });
  it("works with nothing known", () => {
    expect(projectChoicesFor([], undefined, [])).toEqual([]);
  });
});
