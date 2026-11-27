import { describe, it, expect, vi } from "vitest";
import { decideTakeOver, guidedRunFor, isSessionTeam, needsTeamChoice } from "./coolify-take-over";
import type { MigrationRunSummary } from "./types";

const run = (o: Partial<MigrationRunSummary>): MigrationRunSummary => ({ id: "r1", targetServerId: "s1", topology: "swap-proxy", dryRun: false, status: "WAITING", createdAt: "2026-11-25T10:00:00Z", ...o }) as MigrationRunSummary;

describe("guidedRunFor", () => {
  it("is the newest live same-machine run for that server", () => {
    const runs = [run({ id: "old", createdAt: "2026-11-24T10:00:00Z" }), run({ id: "new", createdAt: "2026-11-26T10:00:00Z", status: "COMPLETED" }), run({ id: "mid" })];
    expect(guidedRunFor(runs, "s1")?.id).toBe("new");
  });
  it("ignores other servers, two-box runs, dry runs and runs that are stopped, undone or failed", () => {
    for (const bad of [
      run({ targetServerId: "other" }),
      run({ topology: "two-box" }),
      run({ dryRun: true }),
      ...(["ABORTED", "ABORTING", "ROLLED_BACK", "ROLLING_BACK", "REVERSED", "REVERSING", "FAILED", "DRY_RUN_DONE"] as const).map((status) => run({ status })),
    ]) {
      expect(guidedRunFor([bad], "s1")).toBeNull();
    }
    expect(guidedRunFor([], "s1")).toBeNull();
  });
});

describe("decideTakeOver", () => {
  const calls = (runs: MigrationRunSummary[]) => ({ listRuns: vi.fn(async () => runs) });
  it("no run and no takeover: start the agent-path session", async () => {
    expect(await decideTakeOver({ serverId: "s1", takeover: "none" }, calls([]))).toEqual({ kind: "start" });
  });
  it("a guided run opens the run (it drives the takeover), with the id encoded, whatever the takeover says", async () => {
    expect(await decideTakeOver({ serverId: "s1", takeover: "none" }, calls([run({ id: "r/9" })]))).toEqual({ kind: "open", href: "/import/runs/r%2F9" });
    expect(await decideTakeOver({ serverId: "s1", takeover: "TESTING" }, calls([run({})]))).toEqual({ kind: "open", href: "/import/runs/r1" });
    expect(await decideTakeOver({ serverId: "s1", takeover: "FAILED" }, calls([run({})]))).toEqual({ kind: "open", href: "/import/runs/r1" });
  });
  it("a takeover on record without a run opens its page", async () => {
    expect(await decideTakeOver({ serverId: "s1", takeover: "PLANNED" }, calls([]))).toEqual({ kind: "open", href: "/import/inplace?serverId=s1" });
    expect(await decideTakeOver({ serverId: "s1", takeover: "VERIFIED" }, calls([]))).toEqual({ kind: "open", href: "/import/inplace?serverId=s1" });
  });
  it("a takeover that was given back holds nothing: the row starts a new one instead of opening a page that cannot", async () => {
    expect(await decideTakeOver({ serverId: "s1", takeover: "GIVEN_BACK" }, calls([]))).toEqual({ kind: "start" });
  });
  it("a runs list that fails does not block: it falls back to start, or to the takeover on record", async () => {
    const broken = { listRuns: vi.fn(async () => { throw new Error("x"); }) };
    expect(await decideTakeOver({ serverId: "s1", takeover: "none" }, broken)).toEqual({ kind: "start" });
    expect(await decideTakeOver({ serverId: "s1", takeover: "SWAPPED" }, broken)).toEqual({ kind: "open", href: "/import/inplace?serverId=s1" });
  });
});

describe("team choice", () => {
  it("is needed only when the Coolify has more than one team with projects", () => {
    expect(needsTeamChoice(undefined)).toBe(false);
    expect(needsTeamChoice([])).toBe(false);
    expect(needsTeamChoice([{ ref: "1", name: "A" }])).toBe(false);
    expect(needsTeamChoice([{ ref: "1", name: "A" }, { ref: "2", name: "B" }])).toBe(true);
  });
  it("accepts only a team the session knows", () => {
    const teams = [{ ref: "1", name: "A" }];
    expect(isSessionTeam(teams, "1")).toBe(true);
    expect(isSessionTeam(teams, "9")).toBe(false);
    expect(isSessionTeam(teams, "")).toBe(false);
    expect(isSessionTeam(undefined, "1")).toBe(false);
  });
});
