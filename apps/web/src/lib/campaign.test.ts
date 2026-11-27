import { describe, it, expect } from "vitest";
import { campaignBody, campaignCancellable, campaignGuide, campaignOpenHref, campaignsOf, groupCampaigns, needsCampaign, placementFailureKey, placementsOf, pruneRebuild, rebuildChoicesOf, runsByWave, sourcesOfRun } from "./campaign";
import type { MigrationRunCreateInput } from "./types";

describe("placementsOf", () => {
  it("lists the placed servers in ref order with their kind and target, and leaves out one with no target", () => {
    expect(placementsOf({ placed: { s2: "t2", s1: "t1" }, placementKind: { s1: "in-place", s2: "other-server" } })).toEqual([
      { sourceServerRef: "s1", kind: "in-place", targetServerId: "t1" },
      { sourceServerRef: "s2", kind: "other-server", targetServerId: "t2" },
    ]);
    expect(placementsOf({ placed: {}, placementKind: {} })).toEqual([]);
  });
  it("a server with no recorded kind is a copy, never an in-place swap", () => {
    expect(placementsOf({ placed: { s1: "t1" }, placementKind: {} })[0].kind).toBe("other-server");
  });
});

describe("needsCampaign", () => {
  it("mixed placements and several same-machine servers need one; a single kind and one same-machine server do not", () => {
    expect(needsCampaign({ placementKind: { a: "in-place", b: "other-server" } })).toBe(true);
    expect(needsCampaign({ placementKind: { a: "in-place", b: "in-place" } })).toBe(true);
    expect(needsCampaign({ placementKind: { a: "in-place" } })).toBe(true); // a lone same-machine server is a campaign of one in-place run
    expect(needsCampaign({ placementKind: { a: "other-server", b: "other-server" } })).toBe(false);
    expect(needsCampaign({ placementKind: {} })).toBe(false);
    expect(needsCampaign(null)).toBe(false);
  });
  it("servers of several teams need one even when every server is copied: a run belongs to one team", () => {
    expect(needsCampaign({ placementKind: { a: "other-server", b: "other-server" }, multiTeam: true })).toBe(true);
    expect(needsCampaign({ placementKind: { a: "other-server" }, multiTeam: false })).toBe(false);
  });
});

describe("several campaigns from one create", () => {
  const view = (o: Record<string, unknown> = {}) => ({ id: "c1", teamId: "t1", label: "wave 1", sessionId: null, status: "draft" as const, plan: [], runIds: ["r1"], createdAt: "2026-11-26T10:00:00Z", ...o });
  it("lists every campaign made, or the one an older hub answers with", () => {
    const a = view();
    const b = view({ id: "c2", teamId: "t2" });
    expect(campaignsOf({ ...a, campaigns: [a, b] }).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(campaignsOf(a).map((c) => c.id)).toEqual(["c1"]);
    expect(campaignsOf({ ...a, campaigns: [] }).map((c) => c.id)).toEqual(["c1"]);
  });
  it("opens the report of the label (it holds the runs of every campaign under it)", () => {
    expect(campaignOpenHref(view({ label: "a&b" }))).toBe("/import/runs/campaign?c=a%26b");
  });
  it("groups the campaigns of one label into one line: runs added, teams counted, the state that needs the owner first, newest first", () => {
    const rows = groupCampaigns([
      view({ id: "c1", teamId: "t1", status: "done", runIds: ["r1"], createdAt: "2026-11-26T10:00:00Z" }),
      view({ id: "c2", teamId: "t2", status: "paused", runIds: ["r2", "r3"], createdAt: "2026-11-26T10:00:01Z" }),
      view({ id: "c3", teamId: "t3", label: "other", status: "cancelled", runIds: [], createdAt: "2026-11-27T10:00:00Z" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["other", "wave 1"]);
    expect(rows[1]).toMatchObject({ status: "paused", runs: 3, teams: 2, createdAt: "2026-11-26T10:00:01Z", ids: ["c1", "c2"] });
    expect(rows[0]).toMatchObject({ status: "cancelled", runs: 0, teams: 1 });
  });
  it("rolls the states up in the order paused, running, draft, done, cancelled", () => {
    const st = (...s: Array<"draft" | "running" | "paused" | "done" | "cancelled">) => groupCampaigns(s.map((status, i) => view({ id: `c${i}`, teamId: `t${i}`, status })))[0].status;
    expect(st("done", "running", "draft")).toBe("running");
    expect(st("done", "draft")).toBe("draft");
    expect(st("done", "cancelled")).toBe("done");
    expect(st("cancelled", "cancelled")).toBe("cancelled");
    expect(st("running", "paused")).toBe("paused");
  });
});

describe("campaignBody", () => {
  const run = {
    sessionId: "s1",
    sourceKind: "coolify",
    targetServerId: "t1",
    planHash: "a".repeat(32),
    mode: "copy",
    topology: "swap-proxy",
    dryRun: true,
    options: { observeMinutes: 30 },
    inputs: { acmeEmail: "unknown" },
    serverMap: { s1: "t1" },
    scope: { sourceServers: ["s1"] },
    campaign: " wave-1 ",
    acks: [{ code: "app.env.unresolved", itemRef: "app:s:web" }],
  } as unknown as MigrationRunCreateInput;
  it("keeps the shared run fields, the first step's pick, and drops what the placement decides", () => {
    const b = campaignBody(run, [{ sourceServerRef: "s1", kind: "in-place", targetServerId: "t1" }]);
    expect(b).toEqual({
      sessionId: "s1",
      planHash: "a".repeat(32),
      placements: [{ sourceServerRef: "s1", kind: "in-place", targetServerId: "t1" }],
      label: "wave-1",
      confirm: 1,
      mode: "copy",
      dryRun: true,
      options: { observeMinutes: 30 },
      inputs: { acmeEmail: "unknown" },
      acks: [{ code: "app.env.unresolved", itemRef: "app:s:web" }],
      scope: { sourceServers: ["s1"] },
    });
    for (const k of ["targetServerId", "topology", "serverMap", "mapping", "mappingHash", "campaign"]) expect(b).not.toHaveProperty(k);
  });
  it("confirm is the number of source servers placed", () => {
    const b = campaignBody(run, [
      { sourceServerRef: "a", kind: "in-place", targetServerId: "t1" },
      { sourceServerRef: "b", kind: "other-server", targetServerId: "t2" },
      { sourceServerRef: "c", kind: "other-server", targetServerId: "t2" },
    ]);
    expect(b.confirm).toBe(3);
    expect(b.placements).toHaveLength(3);
  });
  it("carries the data modes and the pick of the first step, and none when the whole servers move", () => {
    const b = campaignBody({ ...run, dbDataModes: { "database:s:pg": "volume" }, scope: { projects: ["p1"], include: ["app:s:x"] } } as MigrationRunCreateInput, [{ sourceServerRef: "a", kind: "in-place", targetServerId: "t1" }]);
    expect(b.dbDataModes).toEqual({ "database:s:pg": "volume" });
    expect(b.scope).toEqual({ projects: ["p1"], include: ["app:s:x"] });
    expect(campaignBody({ ...run, scope: undefined } as MigrationRunCreateInput, [{ sourceServerRef: "a", kind: "in-place", targetServerId: "t1" }])).not.toHaveProperty("scope");
  });
  it("sends no label when none was typed", () => {
    expect(campaignBody({ ...run, campaign: "  " }, [{ sourceServerRef: "a", kind: "in-place", targetServerId: "t1" }])).not.toHaveProperty("label");
  });
});

describe("runs and failures", () => {
  it("groups runs by wave in order and lists a run's source servers", () => {
    const g = runsByWave([
      { sourceServerRef: "b", kind: "in-place", targetServerId: "t", topology: "swap-proxy", wave: 2 },
      { sourceServerRef: "a", sourceServerRefs: ["a", "c"], kind: "other-server", targetServerId: "t", topology: "two-box", wave: 0 },
    ]);
    expect(g.map((x) => x.wave)).toEqual([0, 2]);
    expect(sourcesOfRun(g[0].runs[0])).toEqual(["a", "c"]);
    expect(sourcesOfRun(g[1].runs[0])).toEqual(["b"]);
  });
  it("a known refusal has its own line and an unknown one a generic line", () => {
    expect(placementFailureKey("placement_target_not_ready")).toBe("placement.failure.placement_target_not_ready");
    expect(placementFailureKey("something_new")).toBe("placement.failure.unknown");
    // a move onto servers of several teams is no longer refused: the old code reads as an unknown refusal
    expect(placementFailureKey("placement_teams_differ")).toBe("placement.failure.unknown");
  });
});

describe("rebuild choice", () => {
  const items = [
    { itemRef: "app:a:web", kind: "app" as const, name: "web" },
    { itemRef: "app:a:blog", kind: "app" as const, name: "blog" },
    { itemRef: "database:a:pg", kind: "database" as const, name: "pg" },
    { itemRef: "service:a:stack", kind: "service" as const, name: "stack" },
    { itemRef: "app:b:api", kind: "app" as const, name: "api" },
  ];
  const inPlace = { sourceServerRef: "a", kind: "in-place" as const, targetServerId: "t1", topology: "swap-proxy" as const, wave: 1 };
  const other = { sourceServerRef: "b", kind: "other-server" as const, targetServerId: "t2", topology: "two-box" as const, wave: 0 };

  it("offers the apps of the same-machine run only", () => {
    expect(rebuildChoicesOf(inPlace, items)).toEqual([{ itemRef: "app:a:web", name: "web" }, { itemRef: "app:a:blog", name: "blog" }]);
    expect(rebuildChoicesOf(other, items)).toEqual([]);
  });
  it("keeps to the apps in scope", () => {
    expect(rebuildChoicesOf(inPlace, items, new Set(["app:a:blog"]))).toEqual([{ itemRef: "app:a:blog", name: "blog" }]);
  });
  it("prunes a choice no same-machine run offers any more (never sends one the hub would refuse)", () => {
    expect(pruneRebuild(["app:a:web", "app:b:api", "app:a:ghost"], [other, inPlace], items)).toEqual(["app:a:web"]);
    expect(pruneRebuild(["app:a:web"], null, items)).toEqual([]);
    expect(pruneRebuild(["app:a:web"], [other], items)).toEqual([]);
  });
  it("the campaign body carries the choice once, and nothing when none", () => {
    const run = { sessionId: "s1", planHash: "h".repeat(32), mode: "copy" } as never;
    const pl = [{ sourceServerRef: "a", kind: "in-place" as const, targetServerId: "t1" }];
    expect(campaignBody(run, pl, ["app:a:web", "app:a:web", "app:a:blog"]).rebuild).toEqual(["app:a:web", "app:a:blog"]);
    expect(campaignBody(run, pl)).not.toHaveProperty("rebuild");
    expect(campaignBody(run, pl, [])).not.toHaveProperty("rebuild");
  });
  it("the new refusals have a line of their own", () => {
    expect(placementFailureKey("placement_rebuild_not_in_place")).toBe("placement.failure.placement_rebuild_not_in_place");
    expect(placementFailureKey("placement_rebuild_unknown_item")).toBe("placement.failure.placement_rebuild_unknown_item");
  });
});

describe("campaignGuide", () => {
  const plan = [
    { sourceServerRef: "b", kind: "other-server" as const, targetServerId: "new1", topology: "two-box" as const, wave: 0 },
    { sourceServerRef: "a", kind: "in-place" as const, targetServerId: "srv-a", topology: "swap-proxy" as const, wave: 1 },
    { sourceServerRef: "c", kind: "in-place" as const, targetServerId: "srv-c", topology: "swap-proxy" as const, wave: 2 },
  ];
  const run = (id: string, targetServerId: string, inPlace: boolean, status: string, createdAt = "2026-11-28T10:00:00Z") => ({ id, targetServerId, inPlace, status, createdAt });
  const draft = { plan, status: "draft" as const };
  it("numbers each run by its wave and points at the first one that can start, once the waves before it completed", () => {
    const runs = [run("r0", "new1", false, "DRY_RUN_DONE"), run("r1", "srv-a", true, "QUEUED"), run("r2", "srv-c", true, "QUEUED")];
    const g = campaignGuide([draft], runs);
    expect([...g.waveOf]).toEqual([["r0", 0], ["r1", 1], ["r2", 2]]);
    expect([...g.next]).toEqual(["r0"]);
    const after = campaignGuide([draft], [run("r0", "new1", false, "COMPLETED"), run("r1", "srv-a", true, "QUEUED"), run("r2", "srv-c", true, "QUEUED")]);
    expect([...after.next]).toEqual(["r1"]);
  });
  it("a wave still moving or failed holds the ones after it", () => {
    expect(campaignGuide([draft], [run("r0", "new1", false, "RUNNING"), run("r1", "srv-a", true, "QUEUED")]).next.size).toBe(0);
    expect(campaignGuide([draft], [run("r0", "new1", false, "FAILED"), run("r1", "srv-a", true, "QUEUED")]).next.size).toBe(0);
  });
  it("a promoted dry run is replaced by the real run it made (the newest run of the wave)", () => {
    const runs = [run("dry", "srv-a", true, "DRY_RUN_DONE", "2026-11-28T10:00:00Z"), run("real", "srv-a", true, "RUNNING", "2026-11-28T11:00:00Z"), run("r0", "new1", false, "COMPLETED")];
    const g = campaignGuide([draft], runs);
    expect(g.next.size).toBe(0);
    expect(g.waveOf.get("dry")).toBe(1);
    expect(g.waveOf.get("real")).toBe(1);
  });
  it("a cancelled or finished campaign has nothing to start next, and only another one can be cancelled", () => {
    const runs = [run("r0", "new1", false, "QUEUED")];
    expect(campaignGuide([{ plan, status: "cancelled" }], runs).next.size).toBe(0);
    expect(campaignGuide([{ plan, status: "done" }], runs).next.size).toBe(0);
    expect(campaignCancellable({ status: "draft" })).toBe(true);
    expect(campaignCancellable({ status: "paused" })).toBe(true);
    expect(campaignCancellable({ status: "cancelled" })).toBe(false);
    expect(campaignCancellable({ status: "done" })).toBe(false);
  });
});
