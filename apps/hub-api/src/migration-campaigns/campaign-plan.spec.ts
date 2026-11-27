import type { SourcePlacement } from "@tugra/shared";
import { checkPlacements, deriveCampaignStatus, inPlaceLock, newCampaignLabel, placementViews, planCampaign, refsOfRun, serverMapOfRun, suggestedPlacement, withRebuild, type PlacementHostFact, type PlacementTarget } from "./campaign-plan";

const fact = (o: Partial<PlacementHostFact> & { ref: string }): PlacementHostFact => ({
  name: o.ref,
  controlPlane: false,
  matchStatus: "certain",
  linkedBy: "auto",
  evidence: [],
  matchedServerId: `srv-${o.ref}`,
  agentOnline: true,
  ...o,
});
const target = (id: string, o: Partial<PlacementTarget> = {}): [string, PlacementTarget] => [id, { id, teamId: "t1", ready: true, ...o }];
const targets = (...ids: string[]) => new Map(ids.map((i) => target(i)));

describe("inPlaceLock and suggestion", () => {
  it("a certain match with an online agent is open and preselected", () => {
    const f = fact({ ref: "a" });
    expect(inPlaceLock(f)).toBeNull();
    expect(suggestedPlacement(f)).toBe("in-place");
  });
  it("the control plane box is locked and goes elsewhere", () => {
    const f = fact({ ref: "cp", controlPlane: true });
    expect(inPlaceLock(f)).toBe("control_plane");
    expect(suggestedPlacement(f)).toBe("other-server");
  });
  it("control plane wins over every other lock", () => {
    expect(inPlaceLock(fact({ ref: "cp", controlPlane: true, matchStatus: "none", matchedServerId: null, agentOnline: false }))).toBe("control_plane");
  });
  it("no match means there is no agent on the box", () => {
    expect(inPlaceLock(fact({ ref: "n", matchStatus: "none", matchedServerId: null, agentOnline: false }))).toBe("agent_missing");
  });
  it("a verdict with no server behind it is also agent_missing", () => {
    expect(inPlaceLock(fact({ ref: "n", matchStatus: "probable", matchedServerId: null, agentOnline: false }))).toBe("agent_missing");
  });
  it("an ambiguous match is locked and nothing is preselected", () => {
    const f = fact({ ref: "x", matchStatus: "ambiguous", matchedServerId: null, agentOnline: false });
    expect(inPlaceLock(f)).toBe("match_uncertain");
    expect(suggestedPlacement(f)).toBeNull();
  });
  it("an offline agent locks in place", () => {
    expect(inPlaceLock(fact({ ref: "o", agentOnline: false }))).toBe("agent_offline");
  });
  it("a probable match may be chosen but is never preselected", () => {
    const f = fact({ ref: "p", matchStatus: "probable" });
    expect(inPlaceLock(f)).toBeNull();
    expect(suggestedPlacement(f)).toBeNull();
  });
  it("views carry the verdict and no address", () => {
    const v = placementViews([fact({ ref: "a", evidence: [{ kind: "ip", equal: true }] })]);
    expect(v[0]).toMatchObject({ sourceServerRef: "a", matchStatus: "certain", inPlaceLocked: null, suggested: "in-place", matchedServerId: "srv-a" });
    expect(JSON.stringify(v)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe("checkPlacements", () => {
  const facts = [fact({ ref: "a" }), fact({ ref: "b" }), fact({ ref: "cp", controlPlane: true }), fact({ ref: "x", matchStatus: "ambiguous", matchedServerId: null, agentOnline: false })];
  const T = targets("srv-a", "srv-b", "srv-cp", "new1", "new2");

  it("accepts a mixed placement and fills the in-place target from the match", () => {
    const r = checkPlacements(
      [
        { sourceServerRef: "a", kind: "in-place", targetServerId: null },
        { sourceServerRef: "cp", kind: "other-server", targetServerId: "new1" },
      ],
      facts,
      T,
    );
    const placed = [{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" }, { sourceServerRef: "cp", kind: "other-server", targetServerId: "new1" }];
    expect(r).toEqual({ ok: true, teamId: "t1", teams: [{ teamId: "t1", placements: placed }], placements: placed });
  });
  it("refuses an empty placement", () => {
    expect(checkPlacements([], facts, T)).toMatchObject({ ok: false, code: "placement_empty" });
  });
  it("refuses a source server named twice", () => {
    const p: SourcePlacement[] = [
      { sourceServerRef: "a", kind: "in-place", targetServerId: null },
      { sourceServerRef: "a", kind: "other-server", targetServerId: "new1" },
    ];
    expect(checkPlacements(p, facts, T)).toMatchObject({ ok: false, code: "placement_duplicate", ref: "a" });
  });
  it("refuses a source server the plan does not have", () => {
    expect(checkPlacements([{ sourceServerRef: "zzz", kind: "in-place", targetServerId: null }], facts, T)).toMatchObject({ ok: false, code: "placement_unknown_source" });
  });
  it("refuses in place for the control plane box, with the reason", () => {
    expect(checkPlacements([{ sourceServerRef: "cp", kind: "in-place", targetServerId: null }], facts, T)).toMatchObject({ ok: false, code: "placement_in_place_locked", reason: "control_plane" });
  });
  it("refuses in place for an ambiguous match", () => {
    expect(checkPlacements([{ sourceServerRef: "x", kind: "in-place", targetServerId: null }], facts, T)).toMatchObject({ ok: false, code: "placement_in_place_locked", reason: "match_uncertain" });
  });
  it("refuses an in-place choice that names another target (never replaced silently)", () => {
    expect(checkPlacements([{ sourceServerRef: "a", kind: "in-place", targetServerId: "new1" }], facts, T)).toMatchObject({ ok: false, code: "placement_in_place_target_mismatch" });
  });
  it("accepts an in-place choice that names its own matched server", () => {
    expect(checkPlacements([{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" }], facts, T)).toMatchObject({ ok: true });
  });
  it("another server needs a target", () => {
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: null }], facts, T)).toMatchObject({ ok: false, code: "placement_target_missing" });
  });
  it("another server may not be the machine the source runs on", () => {
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: "srv-a" }], facts, T)).toMatchObject({ ok: false, code: "placement_other_is_source_host" });
  });
  it("another server must exist", () => {
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: "ghost" }], facts, T)).toMatchObject({ ok: false, code: "placement_target_unknown" });
  });
  it("another server must be ready", () => {
    const t = new Map([target("new1", { ready: false })]);
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: "new1" }], facts, t)).toMatchObject({ ok: false, code: "placement_target_not_ready" });
  });
  it("a server of a mapped Coolify team must land in the Tugra team it was mapped to", () => {
    const mapped = [fact({ ref: "a", mappedTeamId: "t2" })];
    const t = new Map([target("new1", { teamId: "t1" }), target("new2", { teamId: "t2" })]);
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: "new1" }], mapped, t)).toMatchObject({ ok: false, code: "placement_team_mismatch", ref: "a" });
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: "new2" }], mapped, t)).toMatchObject({ ok: true, teamId: "t2" });
    // a same-machine server matched in another team is refused the same way
    const inPlace = new Map([target("srv-a", { teamId: "t1" })]);
    expect(checkPlacements([{ sourceServerRef: "a", kind: "in-place", targetServerId: null }], mapped, inPlace)).toMatchObject({ ok: false, code: "placement_team_mismatch" });
  });
  it("without a mapping the team of the target is not checked against anything", () => {
    const t = new Map([target("new1", { teamId: "t9" })]);
    expect(checkPlacements([{ sourceServerRef: "a", kind: "other-server", targetServerId: "new1" }], [fact({ ref: "a" })], t)).toMatchObject({ ok: true, teamId: "t9" });
  });
  it("an in-place server whose agent is not a ready target is refused", () => {
    const t = new Map([target("srv-a", { ready: false })]);
    expect(checkPlacements([{ sourceServerRef: "a", kind: "in-place", targetServerId: null }], facts, t)).toMatchObject({ ok: false, code: "placement_target_not_ready" });
  });
  it("targets in different teams are grouped by team, in ref order, and the placements stay whole", () => {
    const t = new Map([target("srv-a"), target("new1", { teamId: "t2" })]);
    const p: SourcePlacement[] = [
      { sourceServerRef: "a", kind: "in-place", targetServerId: null },
      { sourceServerRef: "b", kind: "other-server", targetServerId: "new1" },
    ];
    const r = checkPlacements(p, facts, t);
    expect(r).toMatchObject({ ok: true, teamId: "t1" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.teams).toEqual([
      { teamId: "t1", placements: [{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" }] },
      { teamId: "t2", placements: [{ sourceServerRef: "b", kind: "other-server", targetServerId: "new1" }] },
    ]);
    expect(r.placements).toHaveLength(2);
  });
  it("one team is one group; an error on any placement of a multi-team choice still wins", () => {
    const one = checkPlacements([{ sourceServerRef: "a", kind: "in-place", targetServerId: null }], facts, new Map([target("srv-a")]));
    expect(one).toMatchObject({ ok: true, teams: [{ teamId: "t1" }] });
    const t = new Map([target("srv-a"), target("new1", { teamId: "t2", ready: false })]);
    const p: SourcePlacement[] = [
      { sourceServerRef: "a", kind: "in-place", targetServerId: null },
      { sourceServerRef: "b", kind: "other-server", targetServerId: "new1" },
    ];
    expect(checkPlacements(p, facts, t)).toMatchObject({ ok: false, code: "placement_target_not_ready", ref: "b" });
  });
});

describe("planCampaign", () => {
  it("one in-place server is one swap-proxy run", () => {
    expect(planCampaign([{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" }])).toEqual([{ sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a", topology: "swap-proxy", wave: 0 }]);
  });
  it("other-server placements travel in one two-box run, in-place servers each get their own wave after it", () => {
    const plan = planCampaign([
      { sourceServerRef: "c", kind: "in-place", targetServerId: "srv-c" },
      { sourceServerRef: "z", kind: "other-server", targetServerId: "n2" },
      { sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" },
      { sourceServerRef: "m", kind: "other-server", targetServerId: "n1" },
    ]);
    expect(plan.map((r) => [r.kind, r.topology, r.wave, refsOfRun(r)])).toEqual([
      ["other-server", "two-box", 0, ["m", "z"]],
      ["in-place", "swap-proxy", 1, ["a"]],
      ["in-place", "swap-proxy", 2, ["c"]],
    ]);
    expect(plan[0].targetServerId).toBe("n1");
  });
  it("is deterministic whatever order the choices come in", () => {
    const p: SourcePlacement[] = [
      { sourceServerRef: "b", kind: "in-place", targetServerId: "srv-b" },
      { sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" },
    ];
    expect(planCampaign(p)).toEqual(planCampaign([...p].reverse()));
  });
  it("a single other-server source carries no refs list", () => {
    expect(planCampaign([{ sourceServerRef: "a", kind: "other-server", targetServerId: "n1" }])[0].sourceServerRefs).toBeUndefined();
  });
  it("a server map exists only when the group spans several targets", () => {
    const p: SourcePlacement[] = [
      { sourceServerRef: "a", kind: "other-server", targetServerId: "n1" },
      { sourceServerRef: "b", kind: "other-server", targetServerId: "n2" },
    ];
    expect(serverMapOfRun(planCampaign(p)[0], p)).toEqual({ a: "n1", b: "n2" });
    const same: SourcePlacement[] = [
      { sourceServerRef: "a", kind: "other-server", targetServerId: "n1" },
      { sourceServerRef: "b", kind: "other-server", targetServerId: "n1" },
    ];
    expect(serverMapOfRun(planCampaign(same)[0], same)).toBeUndefined();
  });
});

describe("withRebuild", () => {
  const mixed = planCampaign([
    { sourceServerRef: "a", kind: "in-place", targetServerId: "srv-a" },
    { sourceServerRef: "b", kind: "in-place", targetServerId: "srv-b" },
    { sourceServerRef: "o", kind: "other-server", targetServerId: "n1" },
  ]);
  const apps = new Set(["app:a:one", "app:a:two", "app:b:three", "app:o:four"]);
  it("hands each in-place run the apps of its own server, in the order given, once each", () => {
    const r = withRebuild(mixed, ["app:b:three", "app:a:two", "app:a:one", "app:a:two"], apps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runs.find((x) => x.sourceServerRef === "a")?.rebuild).toEqual(["app:a:two", "app:a:one"]);
    expect(r.runs.find((x) => x.sourceServerRef === "b")?.rebuild).toEqual(["app:b:three"]);
  });
  it("a run with no chosen app carries no list at all (and no choice leaves the plan as it was)", () => {
    const r = withRebuild(mixed, ["app:a:one"], apps);
    expect(r.ok && r.runs.find((x) => x.sourceServerRef === "b")).not.toHaveProperty("rebuild");
    expect(withRebuild(mixed, [], apps)).toEqual({ ok: true, runs: mixed });
  });
  it("an app the plan does not have is refused, naming it", () => {
    expect(withRebuild(mixed, ["app:a:ghost"], apps)).toEqual({ ok: false, code: "placement_rebuild_unknown_item", ref: "app:a:ghost" });
  });
  it("an app on a server that is copied to another server is refused (it is built there anyway)", () => {
    expect(withRebuild(mixed, ["app:o:four"], apps)).toEqual({ ok: false, code: "placement_rebuild_not_in_place", ref: "app:o:four" });
  });
  it("does not change the plan it was given", () => {
    const copy = JSON.parse(JSON.stringify(mixed));
    withRebuild(mixed, ["app:a:one"], apps);
    expect(mixed).toEqual(copy);
  });
});

describe("campaign label and status", () => {
  it("label is readable and fits the run schema", () => {
    const l = newCampaignLabel(new Date("2026-11-26T14:32:00Z"), () => 0.5);
    expect(l).toMatch(/^campaign-20261126-1432-[a-z0-9]{4}$/);
    expect(l.length).toBeLessThanOrEqual(80);
  });
  it("status follows the runs", () => {
    expect(deriveCampaignStatus("draft", ["QUEUED", "QUEUED"])).toBe("draft");
    expect(deriveCampaignStatus("draft", ["COMPLETED", "COMPLETED"])).toBe("done");
    expect(deriveCampaignStatus("draft", ["COMPLETED", "RUNNING"])).toBe("running");
    expect(deriveCampaignStatus("running", ["COMPLETED", "FAILED"])).toBe("paused");
    expect(deriveCampaignStatus("running", ["COMPLETED", "QUEUED"])).toBe("paused");
    expect(deriveCampaignStatus("draft", ["WAITING"])).toBe("running");
  });
  it("a cancelled campaign stays cancelled", () => {
    expect(deriveCampaignStatus("cancelled", ["COMPLETED"])).toBe("cancelled");
  });
  it("no runs keeps the stored status", () => {
    expect(deriveCampaignStatus("draft", [])).toBe("draft");
  });
});
