import { describe, it, expect } from "vitest";
import { campaignBody, needsCampaign, placementFailureKey, placementsOf, runsByWave, sourcesOfRun } from "./campaign";
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
    expect(needsCampaign({ placementKind: { a: "in-place" } })).toBe(false);
    expect(needsCampaign({ placementKind: { a: "other-server", b: "other-server" } })).toBe(false);
    expect(needsCampaign({ placementKind: {} })).toBe(false);
    expect(needsCampaign(null)).toBe(false);
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
  it("keeps the shared run fields and drops what the placement decides", () => {
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
    });
    for (const k of ["targetServerId", "topology", "serverMap", "scope", "mapping", "mappingHash", "campaign"]) expect(b).not.toHaveProperty(k);
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
  });
});
