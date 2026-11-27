import { HttpException } from "@nestjs/common";
import { StepFailure } from "../../core/run-contract";
import type { RunTakeoverState } from "../../../coolify-inplace/inplace-run";
import { makeCtx, makeRun } from "../data/testing/fakes";
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
