import { describe, it, expect } from "vitest";
import { applyScopeToDoc, autoSelection, hostLeftOut, itemTeamRef, leftOutItemRefs, mappedTeamsOf, ownerSaidNotSame, ownerTugra, autoTargetOf, buildScope, defaultTeamId, inPlaceBlock, placementKindOf, restoreSelection, serializeSelection, serverReadiness, targetOf, scopePayload, emptySelection, hostOfItemRef, inScopeRefs, involvedHosts, missingDependencies, projectChoicesFor, scopedPlan, scopedNotes, scopeIssue, scopeServiceSkips, sourceProjectRows, sharedTargetHosts, partialInPlaceHosts, isControlPlaneHost, withoutInPlaceCopyNotes, type ScopeSelection } from "./import-scope";
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
  it("takes the allowed servers per source server: each one keeps only the targets of its own team, and two teams make a campaign", () => {
    const teamOf = (id: string) => (id.startsWith("a") ? "team-a" : "team-b");
    const allowed = (ref: string) => new Set(ref === "s1" ? ["a1"] : ["b1"]);
    const s = buildScope(plan(), all({ s1: "b1", s2: "b1" }), allowed, teamOf);
    expect(s.placed).toEqual({ s2: "b1" }); // s1's pick sits outside its team and is dropped
    const ok = buildScope(plan(), all({ s1: "a1", s2: "b1" }), allowed, teamOf);
    expect(ok.placed).toEqual({ s1: "a1", s2: "b1" });
    expect(ok.multiTeam).toBe(true);
  });
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
  it("targets in two teams are fine where a campaign carries the move (Coolify): one campaign per team", () => {
    expect(scopeIssue(plan(), buildScope(plan(), all({ s1: "t1", s2: "t3" })), teamOf, undefined, { multiTeamOk: true })).toBeNull();
  });
  it("the scope says when its placed servers sit in several teams, and not otherwise", () => {
    expect(buildScope(plan(), all({ s1: "t1", s2: "t3" }), undefined, teamOf).multiTeam).toBe(true);
    expect(buildScope(plan(), all({ s1: "t1", s2: "t2" }), undefined, teamOf).multiTeam).toBeUndefined();
    expect(buildScope(plan(), all({ s1: "t1", s2: "t3" })).multiTeam).toBeUndefined();
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
  it("opens with nothing ticked; a connected server ticked by the owner goes onto its own machine", () => {
    const a = autoSelection(matched());
    expect(a.mode).toBe("servers");
    expect([...a.hosts]).toEqual([]);
    expect(buildScope(matched(), a).placed).toEqual({});
    const s = buildScope(matched(), { ...a, hosts: new Set(["s1"]) });
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
  it("mixing same-machine and copied moves in one go is allowed: the hub makes a campaign of runs", () => {
    const scope = buildScope(matched(), all({ s1: "t1", s2: "t3" }));
    expect(scopeIssue(matched(), scope, () => "A")).toBeNull();
    expect(scopeIssue(matched(), buildScope(matched(), all({ s1: "t1", s2: "t2" })), () => "A")).toBeNull();
  });
  it("a pick that puts the Coolify box (or a Dokploy box) back on its own machine is refused, whatever the placement kind says", () => {
    const cp = matched();
    cp.preflight!.hosts![0].controlPlane = true;
    expect(scopeIssue(cp, buildScope(cp, all({ s1: "t1", s2: "t2" })), () => "A")).toBe("blocked");
    expect(scopeIssue(cp, buildScope(cp, all({ s1: "t3", s2: "t2" })), () => "A")).toBeNull();
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
  const teams = [{ id: "team1", name: "Simeray" }, { id: "team2", name: "Northwind" }];
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
    p.preflight!.sourceTeam = "northwind";
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
  it("scopes the notes like the items: an unhealthy app or an S3 backup of a left-out server is not this move's note", () => {
    const p = plan({
      warnings: ["source note", "app web is not healthy", "app api is not healthy", "database db has S3", "S3 explanation"],
      scopedWarnings: [
        { text: "app web is not healthy", itemRefs: [WEB] },
        { text: "app api is not healthy", itemRefs: [API] },
        { text: "database db has S3", itemRefs: [DB] },
        { text: "S3 explanation", itemRefs: [DB, "database:s2:other"] },
      ],
    });
    const only = inScopeRefs(p, sel({ mode: "servers", hosts: new Set(["s1"]) }));
    expect(scopedPlan(p, only).warnings).toEqual(["source note", "app web is not healthy", "database db has S3", "S3 explanation"]);
    expect(scopedNotes(p, new Set([API]))).toEqual(["source note", "app api is not healthy"]);
  });
  it("is the very same plan object when nothing is left out", () => {
    const p = plan();
    expect(scopedPlan(p, inScopeRefs(p, emptySelection()))).toBe(p);
  });
});

describe("scopedPlan follows the item that owns a row, not its name", () => {
  // the same names on two servers (dev and prod): an app "api", a database "postgres", a stack "stack"
  const A_API = "app:s1:api";
  const B_API = "app:s2:api";
  const A_PG = "database:s1:pg";
  const B_PG = "database:s2:pg";
  const A_STACK = "service:s1:stack";
  const B_STACK = "service:s2:stack";
  const twin = (): ImportPlan =>
    plan({
      items: [item(A_API, "app", "api"), item(B_API, "app", "api"), item(A_PG, "database", "postgres"), item(B_PG, "database", "postgres"), item(A_STACK, "service", "stack"), item(B_STACK, "service", "stack")],
      preflight: {
        databases: [
          { name: "postgres", itemRef: A_PG, engine: "POSTGRES", dataPlane: "one-click", reason: "A" },
          { name: "postgres", itemRef: B_PG, engine: "POSTGRES", dataPlane: "manual", reason: "B" },
        ],
        services: [
          { name: "stack", itemRef: A_STACK, members: 1, note: "A" },
          { name: "stack", itemRef: B_STACK, members: 2, note: "B" },
        ],
        appsWithVolumeData: 2,
        volumes: [
          { app: "api", itemRef: A_API, mountPath: "/a", dataPlane: "stream", reason: "A" },
          { app: "api", itemRef: B_API, mountPath: "/b", dataPlane: "stream", reason: "B" },
        ],
        hosts: [{ ref: "s1", name: "Box One" }, { ref: "s2", name: "Box Two" }],
      },
    });

  it("a scope of one server keeps only that server's rows when two servers share names", () => {
    const p = twin();
    const sp = scopedPlan(p, inScopeRefs(p, sel({ mode: "servers", hosts: new Set(["s1"]) })));
    expect(sp.preflight?.databases.map((d) => d.reason)).toEqual(["A"]);
    expect(sp.preflight?.services.map((d) => d.note)).toEqual(["A"]);
    expect(sp.preflight?.volumes?.map((v) => v.reason)).toEqual(["A"]);
  });

  it("the in-place split gives each part only its own server's rows", () => {
    const p = twin();
    const moved = scopedPlan(p, new Set([B_API, B_PG, B_STACK]));
    expect(moved.preflight?.databases.map((d) => d.reason)).toEqual(["B"]);
    expect(moved.preflight?.volumes?.map((v) => v.reason)).toEqual(["B"]);
  });

  it("rows with no itemRef (an older hub) are still matched by name", () => {
    const p = twin();
    const old = { ...p, preflight: { ...p.preflight!, databases: p.preflight!.databases.map(({ itemRef: _r, ...d }) => d) } } as ImportPlan;
    const sp = scopedPlan(old, inScopeRefs(old, sel({ mode: "servers", hosts: new Set(["s1"]) })));
    expect(sp.preflight?.databases).toHaveLength(2); // both named "postgres": name is all there is to go by
  });
});

describe("a Coolify team the owner left out of the mapping is never in scope", () => {
  const T1 = { ref: "1", name: "Acme" };
  const T2 = { ref: "2", name: "Beta" };
  const teamed = (teamMap: Record<string, string | null> | undefined): ImportPlan => {
    const p = plan();
    return {
      ...p,
      preflight: {
        ...p.preflight!,
        ...(teamMap ? { teamMap } : {}),
        hosts: [{ ref: "s1", name: "Box One", team: T1 }, { ref: "s2", name: "Box Two", team: T2 }],
        projects: [
          { ref: "p-acme", name: "Acme", itemRefs: [WEB, DB, SVC], team: T1 },
          { ref: "p-beta", name: "Beta", itemRefs: [API, API_DB], team: T2 },
        ],
      },
    } as ImportPlan;
  };

  it("an item's team is its project's, else its server's", () => {
    const p = teamed({ "1": "t1", "2": null });
    expect(itemTeamRef(p, WEB)).toBe("1");
    expect(itemTeamRef(p, API)).toBe("2");
    expect(itemTeamRef(p, "app:s2:loose")).toBe("2"); // no project: its server's team
  });

  it("'everything' leaves the items of a left-out team out, volumes included, and so does every other mode", () => {
    const p = teamed({ "1": "t1", "2": null });
    expect([...leftOutItemRefs(p)].sort()).toEqual([API, API_DB]);
    const all = inScopeRefs(p, emptySelection());
    expect(all.has(API)).toBe(false);
    expect(all.has(API_DB)).toBe(false);
    expect(all.has(WEB)).toBe(true);
    expect(all.has(VOL)).toBe(true); // web's volume stays with web
    expect(inScopeRefs(p, sel({ mode: "servers", hosts: new Set(["s1", "s2"]) })).has(API)).toBe(false);
    expect(inScopeRefs(p, sel({ mode: "projects", projects: new Set(["p-beta"]) })).size).toBe(0);
    expect(inScopeRefs(p, sel({ mode: "servers", hosts: new Set(["s2"]), extra: new Set([API]) })).has(API)).toBe(false); // not even pulled in as a dependency
  });

  it("without a mapping, or with every team mapped, nothing is left out", () => {
    expect(leftOutItemRefs(teamed(undefined)).size).toBe(0);
    expect(leftOutItemRefs(teamed({ "1": "t1", "2": "t2" })).size).toBe(0);
    expect(inScopeRefs(teamed(undefined), emptySelection()).size).toBe(plan().items.length);
  });

  it("a server of a left-out team says so, and the Tugra teams of what is in scope come from the mapping", () => {
    const p = teamed({ "1": "t1", "2": null });
    expect(hostLeftOut(p, "s2")).toBe(true);
    expect(hostLeftOut(p, "s1")).toBe(false);
    expect(mappedTeamsOf(p, inScopeRefs(p, emptySelection()))).toEqual(["t1"]);
    expect(mappedTeamsOf(teamed(undefined), new Set([WEB]))).toEqual([]);
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

describe("an owner's own answer is carried forward", () => {
  const owner = (serverId: string, name: string) => ({ serverId, name, teamId: "team1", via: "owner" as const, confidence: "probable" as const });
  const withHosts = (hosts: NonNullable<ImportPlan["preflight"]>["hosts"]): ImportPlan => ({ ...plan(), preflight: { ...plan().preflight!, hosts } });
  const confirmed = withHosts([
    { ref: "s1", name: "Box One", tugra: owner("t1", "Target A"), match: { status: "probable", linkedBy: "user", evidence: [] } },
    { ref: "s2", name: "Box Two", tugra: { serverId: "t2", name: "Target B", teamId: "team1", via: "reported-ip", confidence: "probable" }, match: { status: "probable", linkedBy: "auto", evidence: [] } },
  ]);

  it("a machine the owner confirmed is the target by itself, a merely probable one stays unplaced", () => {
    expect(ownerTugra(confirmed, "s1")?.serverId).toBe("t1");
    expect(ownerTugra(confirmed, "s2")).toBeUndefined();
    expect(autoTargetOf(confirmed, "s1")).toBe("t1");
    expect(autoTargetOf(confirmed, "s2")).toBe("");
    expect(targetOf(confirmed, emptySelection(), "s1")).toBe("t1");
    expect(targetOf(confirmed, emptySelection(), "s2")).toBe("");
  });

  it("it is placed in place, and the owner can still pick another server", () => {
    expect(placementKindOf(confirmed, "s1", "t1")).toBe("in-place");
    const sel: ScopeSelection = { ...emptySelection(), mode: "servers", hosts: new Set(["s1"]), placement: { s1: "t2" } };
    expect(targetOf(confirmed, sel, "s1")).toBe("t2");
  });

  it("the Coolify host itself is never placed on itself, even when answered", () => {
    const cp = withHosts([{ ref: "s1", name: "Box One", controlPlane: true, tugra: owner("t1", "Target A"), match: { status: "probable", linkedBy: "user", evidence: [] } }]);
    expect(autoTargetOf(cp, "s1")).toBe("");
  });

  it("the confirmed servers are not ticked when the step opens either", () => {
    const sel = autoSelection(confirmed);
    expect([...sel.hosts]).toEqual([]);
  });

  it("'not the same' is remembered as an answer too", () => {
    const no = withHosts([{ ref: "s1", name: "Box One", match: { status: "none", linkedBy: "user", evidence: [] } }, { ref: "s2", name: "Box Two" }]);
    expect(ownerSaidNotSame(no, "s1")).toBe(true);
    expect(ownerSaidNotSame(no, "s2")).toBe(false);
    expect(ownerSaidNotSame(confirmed, "s1")).toBe(false);
  });
});

describe("everything of one Coolify team", () => {
  it("is the items of that team's projects only, with what they need pulled in on request", () => {
    const sel: ScopeSelection = { ...emptySelection(), everythingOf: ["p-beta"] };
    expect([...inScopeRefs(plan(), sel)].sort()).toEqual([API, API_DB]);
    expect([...inScopeRefs(plan(), { ...sel, extra: new Set([DB]) })].sort()).toEqual([API, API_DB, DB].sort());
  });

  it("without a team it is still the whole source", () => {
    expect(inScopeRefs(plan(), emptySelection()).size).toBe(plan().items.length);
  });

  it("is a narrowed scope sent to the hub as that team's projects, never as the whole source", () => {
    const sel: ScopeSelection = { ...emptySelection(), everythingOf: ["p-beta", "p-acme"] };
    const scope = buildScope(plan(), sel);
    expect(scope.narrowed).toBe(false); // both projects hold every placeable item here
    const one = buildScope(plan(), { ...emptySelection(), everythingOf: ["p-beta"] });
    expect(one.narrowed).toBe(true);
    expect(scopePayload(one)).toEqual({ projects: ["p-beta"] });
    expect(scopePayload(buildScope(plan(), emptySelection()))).toBeUndefined();
  });

  it("a team's pulled-in dependencies travel as include", () => {
    const sel: ScopeSelection = { ...emptySelection(), everythingOf: ["p-beta"], extra: new Set([DB]) };
    expect(scopePayload(buildScope(plan(), sel))).toEqual({ projects: ["p-beta"], include: [DB] });
  });

  it("the step opens ticking nothing, however many shown servers are connected", () => {
    const p: ImportPlan = { ...plan(), preflight: { ...plan().preflight!, hosts: [{ ref: "s1", name: "Box One", tugra: { serverId: "t1", name: "A", teamId: "team1", via: "public-ip", confidence: "certain" } }, { ref: "s2", name: "Box Two", tugra: { serverId: "t2", name: "B", teamId: "team1", via: "public-ip", confidence: "certain" } }] } };
    expect([...autoSelection(p).hosts]).toEqual([]);
    expect(autoSelection(p).mode).toBe("servers");
    expect([...autoSelection(p, new Set(["s2"])).hosts]).toEqual([]); // one shown server is "everything", nothing ticked
  });
});

describe("two source servers on one Tugra machine", () => {
  const both = (): ImportPlan => {
    const p = plan();
    p.preflight!.hosts = [
      { ref: "s1", name: "Box One", tugra: { serverId: "t1", name: "Target A", teamId: "team1", via: "public-ip", confidence: "certain" } },
      { ref: "s2", name: "Box Two", tugra: { serverId: "t1", name: "Target A", teamId: "team1", via: "public-ip", confidence: "certain" } },
    ];
    return p;
  };
  const teamOf = () => "team1";
  const everything = (placement: Record<string, string>) => buildScope(both(), sel({ mode: "everything", placement }), undefined, teamOf);
  it("two rows matched to one server, both on their own machine, are refused and name both", () => {
    const sc = everything({ s1: "t1", s2: "t1" });
    expect(sc.placementKind).toEqual({ s1: "in-place", s2: "in-place" });
    expect(sharedTargetHosts(both(), sc)).toEqual(["s1", "s2"]);
    expect(scopeIssue(both(), sc, teamOf)).toBe("shared");
  });
  it("a copy onto the machine another source server stays on is refused too, whichever row is listed first", () => {
    const p = both();
    p.preflight!.hosts![1] = { ref: "s2", name: "Box Two" };
    const sc = buildScope(p, sel({ mode: "everything", placement: { s1: "t1", s2: "t1" } }), undefined, teamOf);
    expect(sc.placementKind).toEqual({ s1: "in-place", s2: "other-server" });
    expect(scopeIssue(p, sc, teamOf)).toBe("shared");
  });
  it("copies of several source servers onto one other server are fine", () => {
    const sc = buildScope(plan(), sel({ mode: "everything", placement: { s1: "t9", s2: "t9" } }), undefined, teamOf);
    expect(sharedTargetHosts(plan(), sc)).toBeNull();
    expect(scopeIssue(plan(), sc, teamOf)).toBeNull();
  });
});

describe("a same-machine server moves whole", () => {
  const p = matched();
  const teamOf = () => "team1";
  it("a project that holds only some of a same-machine server's items blocks Continue", () => {
    const q = matched();
    q.items = [...q.items, item("app:s1:extra", "app", "extra")];
    const sc = buildScope(q, sel({ mode: "projects", projects: new Set(["p-acme"]), placement: { s1: "t1" } }), undefined, teamOf);
    expect(sc.placementKind.s1).toBe("in-place");
    expect(partialInPlaceHosts(q, sc)).toEqual(["s1"]);
    expect(scopeIssue(q, sc, teamOf)).toBe("partial");
    // the same pick copied to another server is allowed
    const copied = buildScope(q, sel({ mode: "projects", projects: new Set(["p-acme"]), placement: { s1: "t9" } }), undefined, teamOf);
    expect(copied.placementKind.s1).toBe("other-server");
    expect(scopeIssue(q, copied, teamOf)).toBeNull();
  });
});

describe("a second row for the machine Coolify runs on", () => {
  it("is the control plane box too: a row matched to the agent's own server cannot stay in place", () => {
    const p = matched();
    p.preflight!.agentRead = { transport: "agent", agentServerId: "t1", schemaVersion: null, coolifyImage: null, readAt: "", counts: { teams: 1, projects: 1, servers: 2, applications: 1, databases: 0, services: 0 } } as never;
    expect(isControlPlaneHost(p, "s1")).toBe(true);
    expect(inPlaceBlock(p, "s1")).toBe("control-plane");
    expect(autoTargetOf(p, "s1")).toBe("");
    expect(placementKindOf(p, "s1", "t1")).toBe("other-server");
    expect(isControlPlaneHost(p, "s2")).toBe(false);
    expect(isControlPlaneHost(matched(), "s1")).toBe(false);
  });
  it("an uncertain match to the agent's server is not the control plane (the hub uses only sure and probable matches)", () => {
    const p = matched();
    p.preflight!.agentRead = { transport: "agent", agentServerId: "t1", schemaVersion: null, coolifyImage: null, readAt: "", counts: { teams: 1, projects: 1, servers: 2, applications: 1, databases: 0, services: 0 } } as never;
    const h = p.preflight!.hosts!.find((x) => x.ref === "s1")!;
    h.match = { status: "ambiguous", linkedBy: null, evidence: [] } as never;
    expect(isControlPlaneHost(p, "s1")).toBe(false);
    h.match = { status: "probable", linkedBy: null, evidence: [] } as never;
    expect(isControlPlaneHost(p, "s1")).toBe(true);
  });
});

describe("withoutInPlaceCopyNotes", () => {
  const cov = (): ImportPlan => {
    const p = plan();
    p.preflight!.coverage = {
      apps: [
        { itemRef: "service:s1:minio", name: "storage-minio", notCarried: [{ field: "objectData", reason: "the store's data volume is not streamed", level: "warn" }, { field: "volume:minio-data", reason: "a host folder bind is carried as a named volume", level: "warn" }] },
        { itemRef: "service:s1:meili", name: "meili", notCarried: [{ field: "volume:meili", reason: "starts empty", level: "info" }, { field: "agent.ports", reason: "published ports are not carried", level: "warn" }] },
        { itemRef: "service:s2:minio", name: "other-minio", notCarried: [{ field: "objectData", reason: "x", level: "warn" }] },
        { itemRef: "app:s1:web", name: "web", notCarried: [{ field: "volume:data", reason: "kept", level: "info" }] },
      ],
    } as never;
    return p;
  };
  const scope = { placementKind: { s1: "in-place", s2: "other-server" } } as never;

  it("takes the copy-path notes (object data, volumes) out of a stack that stays in place and keeps the rest", () => {
    const out = withoutInPlaceCopyNotes(cov(), scope).preflight!.coverage!.apps;
    expect(out.find((a) => a.itemRef === "service:s1:minio")).toBeUndefined();
    expect(out.find((a) => a.itemRef === "service:s1:meili")!.notCarried.map((n) => n.field)).toEqual(["agent.ports"]);
  });
  it("keeps every note of a stack that moves to another server, and of an app", () => {
    const out = withoutInPlaceCopyNotes(cov(), scope).preflight!.coverage!.apps;
    expect(out.find((a) => a.itemRef === "service:s2:minio")!.notCarried.map((n) => n.field)).toEqual(["objectData"]);
    expect(out.find((a) => a.itemRef === "app:s1:web")!.notCarried.map((n) => n.field)).toEqual(["volume:data"]);
  });
  it("changes nothing without a scope or when nothing stays", () => {
    const p = cov();
    expect(withoutInPlaceCopyNotes(p, null)).toBe(p);
    expect(withoutInPlaceCopyNotes(p, { placementKind: { s1: "other-server" } } as never)).toBe(p);
  });
});
