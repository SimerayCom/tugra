import { moveOffPhaseIsActive, moveOffStageOf, moveOffSteps, type MoveOffMoves, type MoveOffServerRow } from "./coolify-move";

const row = (o: Partial<MoveOffServerRow>): MoveOffServerRow => ({
  serverId: "s",
  name: "n",
  agentOnline: true,
  coolify: true,
  isCoolifyHub: false,
  takeover: "none",
  cleanup: "none",
  stage: "takeover",
  ...o,
});
const noMoves: MoveOffMoves = { total: 0, active: 0, completed: 0, failed: 0, latestPhase: null };

describe("moveOffStageOf", () => {
  it("the Coolify host is always the hub, whatever else is true", () => {
    expect(moveOffStageOf(row({ isCoolifyHub: true, takeover: "VERIFIED", cleanup: "CLEANED" }))).toBe("hub");
  });
  it("a server Coolify does not know has nothing to move", () => {
    expect(moveOffStageOf(row({ coolify: false }))).toBe("not_coolify");
  });
  it("an offline agent comes before anything else", () => {
    expect(moveOffStageOf(row({ agentOnline: false }))).toBe("agent");
    expect(moveOffStageOf(row({ agentOnline: false, takeover: "VERIFIED" }))).toBe("agent");
  });
  it("walks takeover, cleanup, done", () => {
    expect(moveOffStageOf(row({}))).toBe("takeover");
    expect(moveOffStageOf(row({ takeover: "FAILED" }))).toBe("takeover");
    expect(moveOffStageOf(row({ takeover: "GIVEN_BACK" }))).toBe("takeover");
    expect(moveOffStageOf(row({ takeover: "SWAPPED" }))).toBe("takeover");
    expect(moveOffStageOf(row({ takeover: "VERIFIED" }))).toBe("cleanup");
    expect(moveOffStageOf(row({ takeover: "VERIFIED", cleanup: "CLEANED" }))).toBe("done");
  });
  it("a cleaned server is done even if its agent is now gone", () => {
    expect(moveOffStageOf(row({ agentOnline: false, cleanup: "CLEANED" }))).toBe("done");
  });
});

describe("moveOffSteps", () => {
  it("counts only Coolify servers that are not the hub", () => {
    const rows = [
      row({ stage: "done" }),
      row({ stage: "cleanup" }),
      row({ stage: "takeover" }),
      row({ stage: "hub", isCoolifyHub: true }),
      row({ stage: "not_coolify", coolify: false }),
    ];
    const [t, c, p, s] = moveOffSteps(rows, noMoves, "2026-11-25T00:00:00Z");
    expect(t).toMatchObject({ step: "takeover", done: 2, total: 3, complete: false });
    expect(c).toMatchObject({ step: "cleanup", done: 1, total: 3, complete: false });
    expect(p).toMatchObject({ step: "consolidate", total: 0, complete: false });
    expect(s).toMatchObject({ step: "shutdown", done: 0 });
  });
  it("nothing to move is never reported as complete", () => {
    const [t, c] = moveOffSteps([], noMoves, null);
    expect(t.complete).toBe(false);
    expect(c.complete).toBe(false);
  });
  it("shutdown is ready only once every server is cleaned, Coolify was read, nothing runs on the host and no campaign run is open", () => {
    const done = [row({ stage: "done" }), row({ stage: "done" })];
    const none = { host: 0, runs: 0 };
    expect(moveOffSteps(done, noMoves, "2026-11-25T00:00:00Z", none)[3].done).toBe(1);
    expect(moveOffSteps(done, noMoves, null, none)[3].done).toBe(0);
    expect(moveOffSteps([...done, row({ stage: "cleanup" })], noMoves, "x", none)[3].done).toBe(0);
    // apps still on the Coolify host, a host that could not be read, a campaign run that is not complete
    expect(moveOffSteps(done, noMoves, "x", { host: 2, runs: 0 })[3].done).toBe(0);
    expect(moveOffSteps(done, noMoves, "x", { host: null, runs: 0 })[3].done).toBe(0);
    expect(moveOffSteps(done, noMoves, "x", { host: 0, runs: 1 })[3].done).toBe(0);
    expect(moveOffSteps(done, noMoves, "x")[3].done).toBe(0);
  });
  it("a Coolify host with no managed server settles once its own apps are moved", () => {
    const hubOnly = [row({ stage: "hub", isCoolifyHub: true })];
    expect(moveOffSteps(hubOnly, noMoves, "x", { host: 3, runs: 0 })[3].done).toBe(0);
    expect(moveOffSteps(hubOnly, noMoves, "x", { host: 0, runs: 0 })[3].done).toBe(1);
  });
  it("consolidation completes only after a move ran and none is running or failed", () => {
    expect(moveOffSteps([], { ...noMoves, total: 2, completed: 2 }, null)[2].complete).toBe(true);
    expect(moveOffSteps([], { ...noMoves, total: 2, completed: 1, active: 1 }, null)[2].complete).toBe(false);
    expect(moveOffSteps([], { ...noMoves, total: 2, completed: 1, failed: 1 }, null)[2].complete).toBe(false);
  });
});

describe("moveOffPhaseIsActive", () => {
  it("knows running phases", () => {
    for (const p of ["QUEUED", "PRECHECK", "MOVING", "VERIFYING", "CUTOVER", "ROLLING_BACK"]) expect(moveOffPhaseIsActive(p)).toBe(true);
    for (const p of ["COMPLETED", "FAILED", "ROLLED_BACK"]) expect(moveOffPhaseIsActive(p)).toBe(false);
  });
});
