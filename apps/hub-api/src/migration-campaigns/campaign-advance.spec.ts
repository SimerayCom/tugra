import type { CampaignRunPlan } from "@tugra/shared";
import { decideAdvance, reachedSafePoint, runOfPlan, type AdvanceRun } from "./campaign-advance";
import { swapInFlight } from "../migration-runs/core/swap-turn";

const plan = (...waves: Array<[string, CampaignRunPlan["kind"], number]>): CampaignRunPlan[] =>
  waves.map(([target, kind, wave]) => ({ sourceServerRef: `ref-${target}`, kind, targetServerId: target, topology: kind === "in-place" ? "swap-proxy" : "two-box", wave }));

let n = 0;
const run = (target: string, o: Partial<Omit<AdvanceRun, "steps">> & { steps?: Array<[string, string, boolean?]> } = {}): AdvanceRun => {
  const { steps, ...rest } = o;
  n += 1;
  return { id: `r-${target}-${n}`, status: "QUEUED", targetServerId: target, inPlace: true, dryRun: false, createdAt: new Date(2026, 10, 28, 8, 0, n), steps: (steps ?? []).map(([key, status, approved]) => ({ key, status, ...(approved ? { approved } : {}) })), ...rest };
};
const VERIFY_WAITING: Array<[string, string]> = [["DEPLOY_DARK", "PASSED"], ["VERIFY", "WAITING_APPROVAL"]];

describe("decideAdvance (Start all)", () => {
  const p3 = plan(["s1", "in-place", 0], ["s2", "in-place", 1], ["s3", "in-place", 2]);

  it("starts only the first wave while nothing has run", () => {
    const rs = [run("s1"), run("s2"), run("s3")];
    const d = decideAdvance(p3, rs);
    expect(d.start).toEqual([rs[0].id]);
    expect(d.hold).toBeNull();
    expect(d.finished).toBe(false);
  });

  it("starts the next wave once the earlier in-place run waits for the owner's approval (the pre-swap steps overlap)", () => {
    const rs = [run("s1", { status: "WAITING", steps: VERIFY_WAITING }), run("s2"), run("s3")];
    expect(decideAdvance(p3, rs).start).toEqual([rs[1].id]);
  });

  it("does not start the next wave while the earlier run is still testing", () => {
    const rs = [run("s1", { status: "RUNNING", steps: [["DEPLOY_DARK", "RUNNING"], ["VERIFY", "PENDING"]] }), run("s2"), run("s3")];
    expect(decideAdvance(p3, rs).start).toEqual([]);
  });

  it("keeps going through every wave once each earlier one is safe, never two ahead of a wave that is not", () => {
    const rs = [run("s1", { status: "WAITING", steps: VERIFY_WAITING }), run("s2"), run("s3")];
    // s2 is queued and s3 waits behind it: s2 has not reached its safe point yet
    expect(decideAdvance(p3, rs).start).toEqual([rs[1].id]);
    const later = [rs[0], { ...rs[1], status: "WAITING", steps: [{ key: "VERIFY", status: "WAITING_APPROVAL" }] }, rs[2]] as AdvanceRun[];
    expect(decideAdvance(p3, later).start).toEqual([rs[2].id]);
  });

  it("a copy (another server) wave must complete before the next one starts", () => {
    const pl = plan(["new1", "other-server", 0], ["s1", "in-place", 1]);
    const copy = run("new1", { inPlace: false, status: "WAITING", steps: VERIFY_WAITING });
    const inp = run("s1");
    expect(decideAdvance(pl, [copy, inp]).start).toEqual([]);
    expect(decideAdvance(pl, [{ ...copy, status: "COMPLETED" }, inp]).start).toEqual([inp.id]);
  });

  it("holds every later wave when a run failed, paused or ended, and says which", () => {
    const failed = decideAdvance(p3, [run("s1", { status: "FAILED" }), run("s2"), run("s3")]);
    expect(failed.start).toEqual([]);
    expect(failed.hold).toMatchObject({ code: "run-failed" });
    expect(decideAdvance(p3, [run("s1", { status: "PAUSED" }), run("s2"), run("s3")]).hold?.code).toBe("run-paused");
    expect(decideAdvance(p3, [run("s1", { status: "ABORTED" }), run("s2"), run("s3")]).hold?.code).toBe("run-ended");
  });

  it("a finished dry run is not started here: the owner promotes it", () => {
    const d = decideAdvance(p3, [run("s1", { status: "DRY_RUN_DONE", dryRun: true }), run("s2"), run("s3")]);
    expect(d.start).toEqual([]);
    expect(d.hold?.code).toBe("dry-run-pending");
  });

  it("waits while a planned run is not created yet, but still starts the waves before it", () => {
    const rs = [run("s1"), run("s2")];
    const d = decideAdvance(p3, rs);
    expect(d.start).toEqual([rs[0].id]);
    expect(d.hold).toEqual({ code: "runs-pending", runId: null });
  });

  it("the run of a plan item is the newest of its kind and target (a promoted dry run is replaced)", () => {
    const old = run("s1", { status: "DRY_RUN_DONE", dryRun: true });
    const real = run("s1", { status: "QUEUED" });
    expect(runOfPlan(p3[0], [old, real])?.id).toBe(real.id);
    expect(decideAdvance(plan(["s1", "in-place", 0]), [old, real]).start).toEqual([real.id]);
  });

  it("is finished once every planned run completed", () => {
    const rs = [run("s1", { status: "COMPLETED" }), run("s2", { status: "COMPLETED" }), run("s3", { status: "COMPLETED" })];
    expect(decideAdvance(p3, rs)).toEqual({ start: [], hold: null, finished: true });
  });

  it("starts the runs of one wave together", () => {
    const pl = plan(["s1", "in-place", 0], ["s2", "in-place", 0]);
    const rs = [run("s1"), run("s2")];
    expect(decideAdvance(pl, rs).start).toEqual([rs[0].id, rs[1].id]);
  });
});

describe("safe point and swap turn", () => {
  it("a run past its approval or already switching is safe; a queued, testing or copy run is not", () => {
    expect(reachedSafePoint(run("a", { status: "WAITING", steps: VERIFY_WAITING }))).toBe(true);
    expect(reachedSafePoint(run("a", { status: "RUNNING", steps: [["VERIFY", "PASSED"], ["CUTOVER", "RUNNING"]] }))).toBe(true);
    expect(reachedSafePoint(run("a", { status: "RUNNING", steps: [["VERIFY", "RUNNING"]] }))).toBe(false);
    expect(reachedSafePoint(run("a"))).toBe(false);
    expect(reachedSafePoint(run("a", { inPlace: false, status: "WAITING", steps: VERIFY_WAITING }))).toBe(false);
  });

  it("swapInFlight: approved or switching counts, waiting for the approval or done does not", () => {
    const base = { inPlace: true };
    expect(swapInFlight({ ...base, status: "WAITING", steps: [{ key: "VERIFY", status: "WAITING_APPROVAL" }] })).toBe(false);
    expect(swapInFlight({ ...base, status: "WAITING", steps: [{ key: "VERIFY", status: "WAITING_APPROVAL", approved: true }] })).toBe(true);
    expect(swapInFlight({ ...base, status: "RUNNING", steps: [{ key: "VERIFY", status: "PASSED" }, { key: "CUTOVER", status: "RUNNING" }] })).toBe(true);
    expect(swapInFlight({ ...base, status: "WAITING", steps: [{ key: "VERIFY", status: "PASSED" }, { key: "CUTOVER", status: "WAITING_TIMER" }] })).toBe(true);
    expect(swapInFlight({ ...base, status: "RUNNING", steps: [{ key: "VERIFY", status: "PASSED" }, { key: "CUTOVER", status: "PASSED" }, { key: "OBSERVE", status: "WAITING_TIMER" }] })).toBe(false);
    expect(swapInFlight({ ...base, status: "FAILED", steps: [{ key: "VERIFY", status: "PASSED" }, { key: "CUTOVER", status: "FAILED" }] })).toBe(true);
    expect(swapInFlight({ ...base, status: "ABORTED", steps: [{ key: "VERIFY", status: "PASSED" }, { key: "CUTOVER", status: "FAILED" }] })).toBe(false);
    expect(swapInFlight({ inPlace: false, status: "RUNNING", steps: [{ key: "CUTOVER", status: "RUNNING" }] })).toBe(false);
  });
});
