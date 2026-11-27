import { HttpException } from "@nestjs/common";
import { StepFailure } from "../../core/run-contract";
import type { RunTakeoverState } from "../../../coolify-inplace/inplace-run";
import { makeCtx, makeRun } from "../data/testing/fakes";
import { checkKey } from "../data/data-logic";
import { InPlaceCutover, type InPlaceCutoverObs } from "./inplace-cutover";

const base: RunTakeoverState = {
  id: "tk1",
  status: "TESTING",
  failureCode: null,
  items: [{ itemRef: "app:s:web", name: "web", buildMode: "reuse-image", domains: [{ host: "web.example.com", tempCheck: "ok", finalCheck: "pending", cert: "pending" }] }],
  gate: { ok: true },
  pending: 0,
  certWorkLeft: true,
  verified: false,
  proxy: {} as never,
  bindBefore: "public",
};
const st = (over: Partial<RunTakeoverState>): RunTakeoverState => ({ ...base, ...over });
const swapped = st({ status: "SWAPPED", items: [{ ...base.items[0], domains: [{ host: "web.example.com", tempCheck: "ok", finalCheck: "ok", cert: "fallback" }] }] });

function build() {
  const port = {
    runPrepare: jest.fn(async (..._a: unknown[]) => base),
    runSwap: jest.fn(async (..._a: unknown[]) => swapped),
    runVerify: jest.fn(async (..._a: unknown[]) => swapped),
    runGiveBack: jest.fn(async (..._a: unknown[]) => st({ status: "GIVEN_BACK" })),
  };
  const world = { createSwap: jest.fn(async () => ({ state: "PLANNED" })), setSwapState: jest.fn(async () => undefined) };
  const h = new InPlaceCutover(port as never, world as never);
  const run = { ...makeRun({ topology: "swap-proxy", mode: "takeover" }), inPlace: true };
  const approved = { VERIFY: { status: "PASSED" as const, approval: { byUserId: "u1", at: "2026-11-28T10:00:00.000Z", boundHash: "x", acks: [], confirmedName: "edge", acceptDataRisk: false, expiresAt: null } } };
  return { h, port, world, run, approved };
}
const obsOf = (s: RunTakeoverState): InPlaceCutoverObs => ({ opId: "op1", servers: [], swap: null, inPlace: s });
const httpError = (status: number, code: string) => new HttpException({ statusCode: status, message: code, code }, status);

describe("CUTOVER of an in-place run: an agent that is offline for a moment", () => {
  it("is a wait while the takeover is healthy (the swap was made and its own timer keeps working), not a failure for good", async () => {
    const t = build();
    t.port.runVerify.mockRejectedValueOnce(httpError(422, "takeover_server_offline"));
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { inPlaceSwapAt: "2026-11-19T10:00:00.000Z" } } }, now: new Date("2026-11-19T10:05:00.000Z") });
    await expect(t.h.act(ctx, obsOf(swapped))).resolves.toMatchObject({ outcome: "continue" });
  });
  it("after the certificate deadline it fails, and the failure can be retried", async () => {
    const t = build();
    t.port.runVerify.mockRejectedValueOnce(httpError(422, "takeover_server_offline"));
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { inPlaceSwapAt: "2026-11-19T10:00:00.000Z" } } }, now: new Date("2026-11-19T11:00:00.000Z") });
    await expect(t.h.act(ctx, obsOf(swapped))).rejects.toMatchObject({ retryable: true });
  });
  it("an offline agent at the swap refuses it with a retryable failure (nothing was taken)", async () => {
    const t = build();
    t.port.runSwap.mockRejectedValueOnce(httpError(422, "takeover_server_offline"));
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved });
    await expect(t.h.act(ctx, obsOf(base))).rejects.toMatchObject({ retryable: true });
  });
});

describe("CUTOVER of an in-place run: a swap that was put back by itself", () => {
  const putBack = st({ status: "FAILED", failureCode: "swap_start_failed" });
  it("fails with a failure the owner can retry, and one whose put-back failed is not retryable", async () => {
    const t = build();
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved });
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toBeInstanceOf(StepFailure);
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toMatchObject({ retryable: true });
    await expect(t.h.act(ctx, obsOf(st({ status: "FAILED", failureCode: "give_back_failed" })))).rejects.toMatchObject({ retryable: false });
  });
  it("a retry plans and tests the takeover again, then takes the ports with the approval still standing", async () => {
    const t = build();
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    const r = await t.h.act(ctx, obsOf(putBack));
    expect(t.port.runPrepare).toHaveBeenCalledTimes(1);
    expect(t.port.runSwap).toHaveBeenCalledTimes(1);
    expect(t.port.runPrepare.mock.invocationCallOrder[0]).toBeLessThan(t.port.runSwap.mock.invocationCallOrder[0]);
    expect(r.outcome).toBe("continue");
  });
  it("the fresh test must pass first: a domain that fails it stops the retry before any port is taken", async () => {
    const t = build();
    t.port.runPrepare.mockResolvedValueOnce(st({ gate: { ok: false, code: "test_failed", host: "web.example.com" } }));
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toMatchObject({ retryable: true });
    expect(t.port.runSwap).not.toHaveBeenCalled();
  });
  it("without the owner's VERIFY approval nothing is re-tested or swapped", async () => {
    const t = build();
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: { VERIFY: { status: "PASSED", approval: null } }, trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toBeInstanceOf(StepFailure);
    expect(t.port.runPrepare).not.toHaveBeenCalled();
    expect(t.port.runSwap).not.toHaveBeenCalled();
  });
});

describe("CUTOVER of an in-place run: a retry after the certificates were not issued", () => {
  it("asks for new attempts only when the owner retried the step, never on a plain poll", async () => {
    const t = build();
    const poll = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "tick" });
    await t.h.act(poll.ctx, obsOf(swapped));
    expect(t.port.runVerify).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { retry: false });
    const retry = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    await t.h.act(retry.ctx, obsOf(swapped));
    expect(t.port.runVerify).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { retry: true });
  });
});

describe("CUTOVER of an in-place run: a retry plans a new takeover that the owner never reviewed", () => {
  const putBack = st({ status: "FAILED", failureCode: "swap_start_failed" });
  const leftOut = { itemRef: "app:s:blog", name: "blog", buildMode: "reuse-image" as const, skipped: true, issues: ["adopt_failed" as never], domains: [{ host: "blog.example.com", tempCheck: "pending" as const, finalCheck: "pending" as const, cert: "pending" as const }] };
  const withLeftOut = st({ items: [...base.items, leftOut as never] });
  const ack = (...acks: string[]) => ({ VERIFY: { status: "PASSED" as const, approval: { ...build().approved.VERIFY.approval, acks } } });

  it("an app left out by a transient failure of the new plan (a domain that would lose its address) is refused, the new plan is given back and the ports stay with Coolify", async () => {
    const t = build();
    t.port.runPrepare.mockResolvedValueOnce(withLeftOut);
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toMatchObject({ code: "cutover.inplace-plan-changed", params: { apps: "blog", hosts: "-" }, retryable: true });
    expect(t.port.runSwap).not.toHaveBeenCalled();
    expect(t.port.runGiveBack).toHaveBeenCalledTimes(1);
  });
  it("the same app is fine when the owner accepted it by name in VERIFY", async () => {
    const t = build();
    t.port.runPrepare.mockResolvedValueOnce(withLeftOut);
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: ack(checkKey("inplace-app", "app:s:blog")), trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(putBack))).resolves.toMatchObject({ outcome: "continue" });
    expect(t.port.runSwap).toHaveBeenCalledTimes(1);
  });
  it("a different set of domains than the reviewed takeover served is refused as well", async () => {
    const t = build();
    t.port.runPrepare.mockResolvedValueOnce(st({ items: [{ ...base.items[0], domains: [{ host: "other.example.com", tempCheck: "ok", finalCheck: "pending", cert: "pending" }] }] }));
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toMatchObject({ code: "cutover.inplace-plan-changed", params: { apps: "-", hosts: "other.example.com, web.example.com" } });
    expect(t.port.runSwap).not.toHaveBeenCalled();
  });
  it("a refusal that cannot give the new plan back says so and is not retryable", async () => {
    const t = build();
    t.port.runPrepare.mockResolvedValueOnce(withLeftOut);
    t.port.runGiveBack.mockResolvedValueOnce(st({ status: "FAILED", failureCode: "give_back_failed" }));
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(putBack))).rejects.toMatchObject({ code: "cutover.inplace-give-back-failed", retryable: false });
  });
  it("after a refusal the next retry plans again and compares with the reviewed hosts, not with the refused plan", async () => {
    const t = build();
    const given = st({ status: "GIVEN_BACK", items: withLeftOut.items });
    const steps = { ...t.approved, CUTOVER: { compensation: { inPlaceDriftRefused: true, inPlaceReviewedHosts: ["web.example.com"] } } };
    // the app's adoption works this time: the plan is the reviewed one again
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps, trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(given))).resolves.toMatchObject({ outcome: "continue" });
    expect(t.port.runPrepare).toHaveBeenCalledTimes(1);
    expect(t.port.runSwap).toHaveBeenCalledTimes(1);
    // and still failing: refused again
    const t2 = build();
    t2.port.runPrepare.mockResolvedValueOnce(withLeftOut);
    const again = makeCtx({ key: "CUTOVER", run: t2.run, steps, trigger: "retry" });
    await expect(t2.h.act(again.ctx, obsOf(given))).rejects.toMatchObject({ code: "cutover.inplace-plan-changed" });
    expect(t2.port.runSwap).not.toHaveBeenCalled();
  });
  it("without a retry a given-back takeover stays given back (no new plan is made)", async () => {
    const t = build();
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { inPlaceDriftRefused: true } } }, trigger: "tick" });
    await expect(t.h.act(ctx, obsOf(st({ status: "GIVEN_BACK" })))).rejects.toMatchObject({ code: "cutover.inplace-reversed" });
    expect(t.port.runPrepare).not.toHaveBeenCalled();
  });
});

describe("CUTOVER of an in-place run: waiting for the agent and retrying the certificates", () => {
  it("an offline agent is said once, as an event, while the step waits", async () => {
    const t = build();
    t.port.runVerify.mockRejectedValue(httpError(422, "takeover_server_offline"));
    const { ctx, events } = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { inPlaceSwapAt: "2026-11-19T10:00:00.000Z" } } }, now: new Date("2026-11-19T10:05:00.000Z") });
    await t.h.act(ctx, obsOf(swapped));
    expect(events.filter((e) => e.code === "cutover.inplace-agent-offline")).toHaveLength(1);
    // the next poll (the flag is stored with the step) does not repeat it
    const next = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { inPlaceSwapAt: "2026-11-19T10:00:00.000Z", inPlaceOfflineNoted: true } } }, now: new Date("2026-11-19T10:06:00.000Z") });
    await t.h.act(next.ctx, obsOf(swapped));
    expect(next.events.filter((e) => e.code === "cutover.inplace-agent-offline")).toHaveLength(0);
  });
  it("a retry of a swap older than the certificate deadline gets its own time: it is not failed for age before the new attempts are looked at", async () => {
    const t = build();
    const pending = st({ ...swapped, certWorkLeft: true });
    t.port.runVerify.mockResolvedValue(pending);
    const old = { CUTOVER: { compensation: { inPlaceSwapAt: "2026-11-19T10:00:00.000Z" } } };
    const { ctx } = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, ...old }, now: new Date("2026-11-19T12:00:00.000Z"), trigger: "retry" });
    await expect(t.h.act(ctx, obsOf(swapped))).resolves.toMatchObject({ outcome: "continue" });
    expect(t.port.runVerify).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { retry: true });
  });
  it("a retry that met a busy takeover is not lost: the next plain poll still asks for the new attempts", async () => {
    const t = build();
    t.port.runVerify.mockRejectedValueOnce(httpError(409, "takeover_busy"));
    const first = makeCtx({ key: "CUTOVER", run: t.run, steps: t.approved, trigger: "retry" });
    await expect(t.h.act(first.ctx, obsOf(swapped))).resolves.toMatchObject({ outcome: "continue" });
    expect(first.comp.inPlaceRetryPending).toBe(true);
    // the next poll is a plain tick, with the step's stored compensation
    const next = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { ...first.comp } } }, trigger: "tick" });
    await t.h.act(next.ctx, obsOf(swapped));
    expect(t.port.runVerify).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { retry: true });
    expect(next.comp.inPlaceRetryPending).toBe(false);
    // once the pass ran, a further plain poll does not ask again
    const last = makeCtx({ key: "CUTOVER", run: t.run, steps: { ...t.approved, CUTOVER: { compensation: { ...next.comp } } }, trigger: "tick" });
    await t.h.act(last.ctx, obsOf(swapped));
    expect(t.port.runVerify).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { retry: false });
  });
});
