import { VERIFY_APPROVAL_CHECK } from "../data/data-contract";
import { DataSeedHandler } from "../data/data-seed.handler";
import { DataFinalHandler } from "../data/data-final.handler";
import { FreezeHandler } from "../data/freeze.handler";
import { VerifyHandler } from "../data/verify.handler";
import { makeCtx, makeRun, stepSnap } from "../data/testing/fakes";
import { TlsPreissueHandler } from "../cutover/tls-preissue.handler";
import { DecommissionHandler } from "../cutover/decommission.handler";
import { CutoverHandler } from "../cutover/cutover.handler";
import { DeployDarkStep } from "../import/deploy-dark.step";
import type { RunSnapshot } from "../../core/run-contract";
import type { RunTakeoverState } from "../../../coolify-inplace/inplace-run";
import { InPlaceRunSteps } from "./inplace-run.steps";

const bare = <T extends object>(c: { prototype: T }): T => Object.create(c.prototype) as T;
const inPlaceRun = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({ ...makeRun({ topology: "swap-proxy", mode: "takeover" }), inPlace: true, ...over });
const classicSwap = makeRun({ topology: "swap-proxy", mode: "takeover" });

const tested: RunTakeoverState = {
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

describe("which steps an in-place run skips", () => {
  it("copies nothing and freezes nothing: DATA_SEED, FREEZE, DATA_FINAL and TLS_PREISSUE do not apply, and Coolify is not stopped by DECOMMISSION", () => {
    expect(bare(DataSeedHandler).applicable(inPlaceRun())).toBe(false);
    expect(bare(FreezeHandler).applicable(inPlaceRun())).toBe(false);
    expect(bare(DataFinalHandler).applicable(inPlaceRun())).toBe(false);
    expect(bare(TlsPreissueHandler).applicable(inPlaceRun())).toBe(false);
    expect(bare(DecommissionHandler).applicable(inPlaceRun())).toBe(false);
  });
  it("the classic same-host swap (with its data copy) is untouched, and so is a two-box run that merely carries the flag", () => {
    for (const run of [classicSwap, { ...makeRun({ topology: "two-box", mode: "takeover" }), inPlace: true } as RunSnapshot]) {
      expect(bare(DataSeedHandler).applicable(run)).toBe(true);
      expect(bare(FreezeHandler).applicable(run)).toBe(true);
      expect(bare(DataFinalHandler).applicable(run)).toBe(true);
      expect(bare(TlsPreissueHandler).applicable(run)).toBe(true);
      expect(bare(DecommissionHandler).applicable(run)).toBe(true);
    }
  });
});

describe("CUTOVER hands an in-place run to the in-place engine and nothing else", () => {
  const engine = {
    state: jest.fn(async () => tested),
    preGate: jest.fn(() => ({ passed: true, checks: [] })),
    postGate: jest.fn(() => ({ passed: true, checks: [] })),
    act: jest.fn(async () => ({ outcome: "done" as const })),
    compensate: jest.fn(async () => ({ outcome: "done" as const })),
  };
  const handler = (): CutoverHandler => {
    const h = bare(CutoverHandler) as unknown as Record<string, unknown>;
    h.inplace = engine;
    return h as unknown as CutoverHandler;
  };
  it("preGate, act, postGate and compensate delegate; the classic paths are not reached", async () => {
    const h = handler();
    const { ctx } = makeCtx({ key: "CUTOVER", run: inPlaceRun() });
    const obs = { opId: "op1", inPlace: tested } as never;
    h.preGate(ctx, obs);
    h.postGate(ctx, obs);
    await h.act(ctx, obs);
    await h.compensate(ctx, "reverse");
    expect(engine.preGate).toHaveBeenCalled();
    expect(engine.postGate).toHaveBeenCalled();
    expect(engine.act).toHaveBeenCalled();
    expect(engine.compensate).toHaveBeenCalledWith(ctx, "reverse");
  });
  it("a cleanup does nothing, in place or not", async () => {
    const { ctx } = makeCtx({ key: "CUTOVER", run: inPlaceRun() });
    expect(await handler().compensate(ctx, "cleanup")).toEqual({ outcome: "nothing-to-do" });
  });
  it("the dry run says it is an in-place takeover", async () => {
    const h = handler() as unknown as { dryRun(ctx: unknown): Promise<Array<{ code: string }>>; world: unknown; plans: unknown };
    (h as { world: unknown }).world = { opApps: async () => [], serverFacts: async () => null, runtimeCtx: undefined, getSwap: async () => null, exec: async () => ({ exitCode: 0, output: "" }) };
    const { ctx } = makeCtx({ key: "CUTOVER", run: inPlaceRun() });
    const items = await h.dryRun(ctx).catch(() => [] as Array<{ code: string }>);
    expect(items.map((i) => i.code)).toContain("cutover.dry.inplace");
  });
});

describe("DEPLOY_DARK hands an in-place run to the in-place engine: no build, no database, no service is started", () => {
  const port = { target: jest.fn(async () => ({ agentOnline: true })), opSnapshot: jest.fn() };
  const state = jest.fn(async () => tested);
  const steps = { state, dryRun: () => [{ code: "deploy-dark.inplace-plan", level: "info" }], preGate: jest.fn(() => ({ passed: true, checks: [] })), postGate: jest.fn(() => ({ passed: true, checks: [] })), act: jest.fn(async () => ({ outcome: "done" })), compensate: jest.fn(async () => ({ outcome: "done" })) };
  const make = () => new DeployDarkStep({ register: jest.fn() } as never, port as never, undefined, steps as unknown as InPlaceRunSteps);
  it("observe reads the takeover and never the op's apps; every other method delegates", async () => {
    const h = make();
    const { ctx } = makeCtx({ key: "DEPLOY_DARK", run: inPlaceRun() });
    const obs = await h.observe(ctx);
    expect(obs.inPlace).toBe(tested);
    expect(port.opSnapshot).not.toHaveBeenCalled();
    expect(await h.dryRun(ctx)).toEqual([{ code: "deploy-dark.inplace-plan", level: "info" }]);
    h.preGate(ctx, obs);
    h.postGate(ctx, obs);
    await h.act(ctx, obs);
    await h.compensate(ctx, "abort");
    expect(steps.preGate).toHaveBeenCalledWith(ctx, true);
    expect(steps.postGate).toHaveBeenCalledWith(tested);
    expect(steps.act).toHaveBeenCalledWith(ctx);
    expect(steps.compensate).toHaveBeenCalledWith(ctx, "abort");
  });
  it("only an abort undoes it, like the classic step", async () => {
    const { ctx } = makeCtx({ key: "DEPLOY_DARK", run: inPlaceRun() });
    steps.compensate.mockClear();
    expect(await make().compensate(ctx, "cleanup")).toEqual({ outcome: "nothing-to-do" });
    expect(steps.compensate).not.toHaveBeenCalled();
  });
  it("without the flag the classic observe runs (the op is read)", async () => {
    port.opSnapshot.mockRejectedValueOnce(new Error("classic path reached"));
    const { ctx } = makeCtx({ key: "DEPLOY_DARK", run: classicSwap });
    await expect(make().observe(ctx)).rejects.toThrow("classic path reached");
  });
});

describe("VERIFY of an in-place run reviews the takeover's test and binds the approval to it", () => {
  const store = (marker?: { boundHash: string; approvalAt: string }) => ({
    list: jest.fn(async () => (marker ? [{ runId: "r", stepKey: "VERIFY", checkId: VERIFY_APPROVAL_CHECK, subject: "", status: "pass", evidenceKind: "operator-attested", evidence: marker, at: new Date() }] : [])),
    upsert: jest.fn(async () => undefined),
  });
  const verify = (checks: ReturnType<typeof store>, st: RunTakeoverState | null) => {
    const steps = new InPlaceRunSteps({ runState: async () => st } as never);
    const none = {} as never;
    return new VerifyHandler({ register: jest.fn() } as never, none, none, none, none, none, none, checks as never, steps);
  };
  it("the approval is a PONR approval bound to the takeover, with no data-risk to accept, naming the server to confirm", async () => {
    const h = verify(store(), tested);
    const { ctx } = makeCtx({ key: "VERIFY", run: inPlaceRun() });
    const obs = await h.observe(ctx);
    expect(obs.flip.planHash).toBe("inplace:tk1");
    expect(obs.flip.statefulHosts).toEqual([]);
    const b = await h.approvalBinding(ctx, obs);
    expect(b).toMatchObject({ ponr: true, confirm: "target-server+source-host", requiresDataRisk: false, ackable: [], requiredAcks: [] });
    expect(h.preGate(ctx, obs).passed).toBe(true);
  });
  it("a domain that fails its test blocks the review and no acknowledgement can accept it", async () => {
    const failed: RunTakeoverState = { ...tested, items: [{ ...tested.items[0], domains: [{ host: "web.example.com", tempCheck: "failed", finalCheck: "pending", cert: "pending" }] }] };
    const h = verify(store(), failed);
    const { ctx } = makeCtx({ key: "VERIFY", run: inPlaceRun() });
    const obs = await h.observe(ctx);
    expect(h.preGate(ctx, obs).passed).toBe(false);
    expect((await h.approvalBinding(ctx, obs))?.ackable).toEqual([]);
  });
  it("an app left out of the takeover is something the owner must accept by name in the approval", async () => {
    const left: RunTakeoverState = { ...tested, items: [...tested.items, { itemRef: "app:s:old", name: "old", buildMode: "reuse-image", skipped: true, issues: ["container_absent"], domains: [] }] };
    const h = verify(store(), left);
    const { ctx } = makeCtx({ key: "VERIFY", run: inPlaceRun() });
    const obs = await h.observe(ctx);
    const b = await h.approvalBinding(ctx, obs);
    expect(b?.requiredAcks).toHaveLength(1);
    expect(h.preGate(ctx, obs).passed).toBe(true);
    // without the acknowledgement the act refuses
    const { ctx: c2 } = makeCtx({ key: "VERIFY", run: inPlaceRun() });
    expect(await h.act({ ...c2, approval: { boundHash: obs.bindingHash as string, acks: [], at: "2026-11-20T10:00:00.000Z", expiresAt: null, byUserId: "u", acceptDataRisk: false, confirmName: "x" } } as never, obs)).toMatchObject({ outcome: "fail", code: "verify.unacknowledged" });
  });
  it("no takeover yet: the review is blocked and no approval can be asked for", async () => {
    const h = verify(store(), null);
    const { ctx } = makeCtx({ key: "VERIFY", run: inPlaceRun() });
    const obs = await h.observe(ctx);
    expect(obs.bindingHash).toBeNull();
    expect(h.preGate(ctx, obs).passed).toBe(false);
    expect(await h.approvalBinding(ctx, obs)).toBeNull();
  });
  it("the stored approval passes the step only for this exact takeover state", async () => {
    const first = await verify(store(), tested).observe(makeCtx({ key: "VERIFY", run: inPlaceRun() }).ctx);
    const marker = { boundHash: first.bindingHash as string, approvalAt: "2026-11-20T09:55:00.000Z" };
    const c = makeCtx({ key: "VERIFY", run: inPlaceRun(), steps: { VERIFY: stepSnap("VERIFY", { approval: { at: marker.approvalAt, boundHash: marker.boundHash } as never }) } } as never);
    const h = verify(store(marker), tested);
    const obs = await h.observe(c.ctx);
    expect(h.postGate(c.ctx, obs).passed).toBe(true);
    // the takeover changed (a domain stopped answering): the same approval no longer matches
    const changed: RunTakeoverState = { ...tested, items: [{ ...tested.items[0], domains: [{ host: "web.example.com", tempCheck: "failed", finalCheck: "pending", cert: "pending" }] }] };
    const h2 = verify(store(marker), changed);
    expect(h2.postGate(c.ctx, await h2.observe(c.ctx)).passed).toBe(false);
  });
});
