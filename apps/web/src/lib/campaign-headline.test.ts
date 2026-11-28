import { describe, it, expect } from "vitest";
import type { CampaignRunPlan } from "@tugra/shared";
import { campaignHeadline, waveRanks } from "./campaign";

const plan: CampaignRunPlan[] = [
  { sourceServerRef: "a", kind: "in-place", targetServerId: "s1", topology: "swap-proxy", wave: 0 },
  { sourceServerRef: "b", kind: "in-place", targetServerId: "s2", topology: "swap-proxy", wave: 1 },
  { sourceServerRef: "c", kind: "in-place", targetServerId: "s3", topology: "swap-proxy", wave: 2 },
];
const view = (over: { driving?: boolean; status?: "draft" | "running" | "paused" | "done" | "cancelled" } = {}) => ({ plan, status: over.status ?? ("draft" as const), driving: over.driving ?? false });
const run = (id: string, status: string, dryRun = false) => ({ id, status, dryRun });

describe("campaignHeadline", () => {
  it("nothing started and not handed over: ready, with the one action to start", () => {
    const h = campaignHeadline([view()], [run("1", "QUEUED"), run("2", "QUEUED"), run("3", "QUEUED")], []);
    expect(h).toMatchObject({ kind: "ready", action: "start", queued: 3, canPause: false });
  });

  it("handed to the hub: no start action, a way to hold back", () => {
    const h = campaignHeadline([view({ driving: true, status: "running" })], [run("1", "RUNNING"), run("2", "QUEUED"), run("3", "QUEUED")], []);
    expect(h).toMatchObject({ kind: "moving", action: null, canPause: true });
  });

  it("paused after a start: continue, not start", () => {
    const h = campaignHeadline([view({ status: "paused" })], [run("1", "COMPLETED"), run("2", "QUEUED"), run("3", "QUEUED")], []);
    expect(h).toMatchObject({ kind: "paused", action: "continue" });
  });

  it("something waits for the owner: needs you, whatever else is going on", () => {
    const h = campaignHeadline([view({ driving: true, status: "running" })], [run("1", "WAITING"), run("2", "QUEUED"), run("3", "QUEUED")], ["1"]);
    expect(h).toMatchObject({ kind: "needs", needs: ["1"], canPause: true });
  });

  it("a failed run stops the line and is named; the rest is not offered a start while it is open", () => {
    const h = campaignHeadline([view({ driving: true, status: "paused" })], [run("1", "FAILED"), run("2", "QUEUED"), run("3", "QUEUED")], []);
    expect(h).toMatchObject({ kind: "failed", failedRunId: "1", action: null });
  });

  it("runs still being made: preparing, no action yet", () => {
    const h = campaignHeadline([view()], [run("1", "QUEUED")], []);
    expect(h).toMatchObject({ kind: "preparing", made: 1, total: 3, action: null });
  });

  it("every run completed: done; every campaign cancelled: cancelled", () => {
    expect(campaignHeadline([view({ status: "done" })], [run("1", "COMPLETED"), run("2", "COMPLETED"), run("3", "COMPLETED")], []).kind).toBe("done");
    expect(campaignHeadline([view({ status: "cancelled" })], [run("1", "ABORTED"), run("2", "ABORTED"), run("3", "ABORTED")], []).kind).toBe("cancelled");
  });

  it("finished dry runs: review, and no start (the owner promotes them one by one)", () => {
    const h = campaignHeadline([view()], [run("1", "DRY_RUN_DONE", true), run("2", "DRY_RUN_DONE", true), run("3", "DRY_RUN_DONE", true)], []);
    expect(h).toMatchObject({ kind: "review", action: null });
  });

  it("a viewer who cannot read the plan still gets a headline from the runs", () => {
    expect(campaignHeadline([], [run("1", "RUNNING"), run("2", "QUEUED")], []).kind).toBe("moving");
  });
});

describe("waveRanks", () => {
  it("ranks the plan's waves from one, whatever numbers the hub used", () => {
    const runs = [
      { id: "r1", targetServerId: "s1", inPlace: true, status: "QUEUED", createdAt: "2026-11-28T08:00:00.000Z" },
      { id: "r3", targetServerId: "s3", inPlace: true, status: "QUEUED", createdAt: "2026-11-28T08:02:00.000Z" },
    ];
    const r = waveRanks([{ plan, status: "draft" }], runs);
    expect(r.count).toBe(3);
    expect(r.rankOf.get("r1")).toBe(1);
    expect(r.rankOf.get("r3")).toBe(3);
  });
});
