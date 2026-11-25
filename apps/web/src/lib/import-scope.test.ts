import { describe, it, expect } from "vitest";
import { applyScopeToDoc, autoSelection, autoTargetOf, buildScope, defaultTeamId, inPlaceBlock, placementKindOf, restoreSelection, serializeSelection, serverReadiness, targetOf, scopePayload, emptySelection, hostOfItemRef, inScopeRefs, involvedHosts, missingDependencies, projectChoicesFor, scopedPlan, scopeIssue, scopeServiceSkips, sourceProjectRows, type ScopeSelection } from "./import-scope";
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

const all = (placement: Record<string, string>): ScopeSelection => sel({ placement });

describe("buildScope", () => {
  it("everything on one server: no serverMap, the default is that server", () => {
    const s = buildScope(plan(), all({ s1: "t1", s2: "t1" }));
    expect(s.narrowed).toBe(false);
    expect(s.serverMap).toBeUndefined();
    expect(s.defaultServerId).toBe("t1");
  });
  it("two source servers on two Tugra servers send a serverMap listing every involved source server", () => {
    const s = buildScope(plan(), all({ s1: "t1", s2: "t2" }));
    expect(s.serverMap).toEqual({ s1: "t1", s2: "t2" });
    expect(s.placed).toEqual({ s1: "t1", s2: "t2" });
  });
  it("a server pick narrows the scope and only that server is placed", () => {
    const s = buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s2"]), placement: { s2: "t2" } }));
    expect(s.narrowed).toBe(true);
    expect(s.serverMap).toBeUndefined();
    expect(s.defaultServerId).toBe("t2");
  });
  it("an involved server with no pick and no match has no target: nothing falls back to another server", () => {
    const s = buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s1"]) }));
    expect(s.defaultServerId).toBe("");
    expect(s.placed).toEqual({});
    expect(s.serverMap).toBeUndefined();
  });
  it("a pick outside the chosen team's servers is dropped", () => {
    const s = buildScope(plan(), all({ s1: "t1", s2: "t3" }), new Set(["t1", "t2"]));
    expect(s.placed).toEqual({ s1: "t1" });
  });
});

describe("scopeIssue", () => {
  const teamOf = (id: string) => ({ t1: "A", t2: "A", t3: "B" })[id];
  it("nothing picked blocks", () => {
    expect(scopeIssue(plan(), buildScope(plan(), sel({ mode: "servers" })), teamOf)).toBe("nothing");
  });
  it("targets in two teams block; one team is fine", () => {
    expect(scopeIssue(plan(), buildScope(plan(), all({ s1: "t1", s2: "t3" })), teamOf)).toBe("teams");
    expect(scopeIssue(plan(), buildScope(plan(), all({ s1: "t1", s2: "t2" })), teamOf)).toBeNull();
  });
  it("a source server without a target blocks, even when the others have one", () => {
    expect(scopeIssue(plan(), buildScope(plan(), sel({})), teamOf)).toBe("target");
    expect(scopeIssue(plan(), buildScope(plan(), all({ s1: "t1" })), teamOf)).toBe("target");
  });
  it("a target that cannot take apps blocks", () => {
    const readinessOf = (id: string) => (id === "t2" ? ("offline" as const) : ("ready" as const));
    expect(scopeIssue(plan(), buildScope(plan(), all({ s1: "t1", s2: "t2" })), teamOf, readinessOf)).toBe("unready");
    expect(scopeIssue(plan(), buildScope(plan(), all({ s1: "t1", s2: "t1" })), teamOf, readinessOf)).toBeNull();
  });
});

// the hub found s1 on Tugra server t1 (public address) and s2 on t2 (private range only)
const matched = (): ImportPlan => {
  const p = plan();
  p.preflight!.hosts = [
    { ref: "s1", name: "Box One", tugra: { serverId: "t1", name: "Target A", teamId: "team1", via: "public-ip", confidence: "certain" } },
    { ref: "s2", name: "Box Two", tugra: { serverId: "t2", name: "Target B", teamId: "team1", via: "reported-ip", confidence: "probable" } },
  ];
  return p;
};

describe("matched servers", () => {
  it("only a sure (public address) match is a target by itself; a probable one is only offered", () => {
    expect(autoTargetOf(matched(), "s1")).toBe("t1");
    expect(autoTargetOf(matched(), "s2")).toBe("");
    expect(autoTargetOf(plan(), "s1")).toBe("");
  });
  it("the pick wins over the match, and a target outside the allowed team is not used", () => {
    expect(targetOf(matched(), sel({ placement: { s1: "t9" } }), "s1")).toBe("t9");
    expect(targetOf(matched(), sel({}), "s1", new Set(["t2"]))).toBe("");
  });
  it("opens on the connected servers, ticked and on their own machine; the rest is unticked and unplaced", () => {
    const a = autoSelection(matched());
    expect(a.mode).toBe("servers");
    expect([...a.hosts]).toEqual(["s1"]);
    const s = buildScope(matched(), a);
    expect(s.placed).toEqual({ s1: "t1" });
    expect(s.placementKind).toEqual({ s1: "in-place" });
  });
  it("nothing matched: nothing ticked, nothing placed, never the first server", () => {
    const a = autoSelection(plan());
    expect(a.mode).toBe("servers");
    expect(a.hosts.size).toBe(0);
    expect(buildScope(plan(), a).placed).toEqual({});
  });
  it("a one-server source opens on everything", () => {
    const one = plan({ items: plan().items.filter((i) => i.itemRef.includes(":s1:")) });
    one.preflight!.hosts = [{ ref: "s1", name: "Box One" }];
    expect(autoSelection(one).mode).toBe("everything");
  });
  it("labels the target: the matched machine is in place, any other server is another server", () => {
    expect(placementKindOf(matched(), "s1", "t1")).toBe("in-place");
    expect(placementKindOf(matched(), "s1", "t2")).toBe("other-server");
    expect(placementKindOf(matched(), "s2", "t2")).toBe("in-place");
    expect(placementKindOf(plan(), "s1", "t1")).toBe("other-server");
  });
  it("the Coolify box itself and a non-Coolify source never move in place", () => {
    const cp = matched();
    cp.preflight!.hosts![0].controlPlane = true;
    expect(inPlaceBlock(cp, "s1")).toBe("control-plane");
    expect(autoTargetOf(cp, "s1")).toBe("");
    expect(placementKindOf(cp, "s1", "t1")).toBe("other-server");
    const dk = { ...matched(), sourceKind: "dokploy" };
    expect(inPlaceBlock(dk, "s1")).toBe("unsupported-source");
    expect(autoTargetOf(dk, "s1")).toBe("");
  });
  it("a Dokploy box with no server of its own is matched through the panel verdict", () => {
    const dk = { ...plan(), sourceKind: "dokploy" } as ImportPlan;
    dk.preflight!.panel = { tugra: { serverId: "t1", name: "Target A", teamId: "team1", via: "hostname", confidence: "probable" } };
    expect(placementKindOf(dk, "_", "t1")).toBe("other-server");
  });
  it("mixing same-machine and copied moves in one go is blocked", () => {
    const scope = buildScope(matched(), all({ s1: "t1", s2: "t3" }));
    expect(scopeIssue(matched(), scope, () => "A")).toBe("mixed");
    expect(scopeIssue(matched(), buildScope(matched(), all({ s1: "t1", s2: "t2" })), () => "A")).toBeNull();
  });
  it("a pick that puts the Coolify box (or a Dokploy box) back on its own machine is refused, whatever the placement kind says", () => {
    const cp = matched();
    cp.preflight!.hosts![0].controlPlane = true;
    expect(scopeIssue(cp, buildScope(cp, all({ s1: "t1", s2: "t2" })), () => "A")).toBe("blocked");
    expect(scopeIssue(cp, buildScope(cp, all({ s1: "t3", s2: "t2" })), () => "A")).toBe("mixed");
    expect(scopeIssue(cp, buildScope(cp, all({ s1: "t3", s2: "t3" })), () => "A")).toBeNull();
    const dk = { ...matched(), sourceKind: "dokploy" } as ImportPlan;
    expect(scopeIssue(dk, buildScope(dk, all({ s1: "t1", s2: "t3" })), () => "A")).toBe("blocked");
  });
});

describe("serverReadiness", () => {
  it("needs the agent connected and the deploy grant", () => {
    expect(serverReadiness({ status: "ONLINE", capabilities: ["deploy"] })).toBe("ready");
    expect(serverReadiness({ status: "PENDING", capabilities: ["deploy"] })).toBe("pending");
    expect(serverReadiness({ status: "OFFLINE", capabilities: ["deploy"] })).toBe("offline");
    expect(serverReadiness({ status: "ONLINE", capabilities: ["backup"] })).toBe("no-deploy");
    expect(serverReadiness({ status: "ONLINE", capabilities: [] })).toBe("no-deploy");
    expect(serverReadiness({})).toBe("ready");
  });
});

describe("defaultTeamId", () => {
  const servers = [
    { id: "t1", name: "A", teamId: "team1" },
    { id: "t2", name: "B", teamId: "team2" },
    { id: "t3", name: "C", teamId: "team2" },
  ];
  const teams = [{ id: "team1", name: "Simeray" }, { id: "team2", name: "Olgu Bey" }];
  it("is the team that owns the most connected servers", () => {
    const p = matched();
    p.preflight!.hosts = [
      { ref: "s1", tugra: { serverId: "t2", name: "B", teamId: "team2", via: "public-ip", confidence: "certain" } },
      { ref: "s2", tugra: { serverId: "t3", name: "C", teamId: "team2", via: "public-ip", confidence: "certain" } },
    ];
    expect(defaultTeamId(p, servers, teams)).toBe("team2");
  });
  it("else the team named like the source team; else the only team; else none (never the first)", () => {
    const p = plan();
    expect(defaultTeamId(p, servers, teams)).toBe("");
    p.preflight!.sourceTeam = "olgu bey";
    expect(defaultTeamId(p, servers, teams)).toBe("team2");
    expect(defaultTeamId(plan(), servers.slice(0, 1), teams)).toBe("team1");
  });
  it("a tie between teams is not resolved for the user", () => {
    const p = plan();
    p.preflight!.hosts = [
      { ref: "s1", tugra: { serverId: "t1", name: "A", teamId: "team1", via: "public-ip", confidence: "certain" } },
      { ref: "s2", tugra: { serverId: "t2", name: "B", teamId: "team2", via: "public-ip", confidence: "certain" } },
    ];
    expect(defaultTeamId(p, servers, teams)).toBe("");
  });
});

describe("serializeSelection / restoreSelection", () => {
  it("round-trips a selection as names and ids only", () => {
    const s = sel({ mode: "servers", hosts: new Set(["s2", "s1"]), projects: new Set(["p"]), extra: new Set([DB]), placement: { s1: "t1" }, teamId: "team1" });
    const raw = serializeSelection(s);
    expect(raw).not.toMatch(/token|password/i);
    const back = restoreSelection(raw)!;
    expect(back.mode).toBe("servers");
    expect([...back.hosts].sort()).toEqual(["s1", "s2"]);
    expect([...back.extra]).toEqual([DB]);
    expect(back.placement).toEqual({ s1: "t1" });
    expect(back.teamId).toBe("team1");
  });
  it("reads nothing back from a value that is not a selection", () => {
    for (const bad of [null, "", "x", "{}", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, mode: "x", hosts: [], projects: [], extra: [], placement: {} }), JSON.stringify({ v: 1, mode: "servers", hosts: [1], projects: [], extra: [], placement: {} }), JSON.stringify({ v: 1, mode: "servers", hosts: [], projects: [], extra: [], placement: { a: 1 } })]) {
      expect(restoreSelection(bad)).toBeUndefined();
    }
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

describe("scopePayload", () => {
  it("is undefined when the whole source moves", () => {
    expect(scopePayload(buildScope(plan(), all({ s1: "t1", s2: "t1" })))).toBeUndefined();
    expect(scopePayload(null)).toBeUndefined();
  });
  it("a server pick sends the picked source servers; picking every server is the whole source", () => {
    expect(scopePayload(buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s1"]) })))).toEqual({ sourceServers: ["s1"] });
    expect(scopePayload(buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s2", "s1"]) })))).toBeUndefined();
  });
  it("a project pick sends the projects, and what was pulled in on top rides as include", () => {
    const p = scopePayload(buildScope(plan(), sel({ mode: "projects", projects: new Set(["p-beta"]), extra: new Set([DB]) })));
    expect(p).toEqual({ projects: ["p-beta"], include: [DB] });
  });
  it("sends nothing it did not pick", () => {
    const p = scopePayload(buildScope(plan(), sel({ mode: "servers", hosts: new Set(["s2"]) })));
    expect(p).toEqual({ sourceServers: ["s2"] });
    expect(p).not.toHaveProperty("projects");
    expect(p).not.toHaveProperty("include");
  });
});
