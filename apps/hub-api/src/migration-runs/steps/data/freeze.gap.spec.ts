import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import type { RunSnapshot } from "../../core/run-contract";
import { FreezeHandler, TICK_GAP_CHECK, TICK_GAP_CODES } from "./freeze.handler";
import { SourceHostFake } from "./testing/source-host-fake";
import { estimateWindowDetail, tickGapOf, windowExtrasOf } from "./data-logic";
import { FakeCaps, FakeDataPort, FakeSourceApi, NOW, answered, inspected, makeCtx, makeRun, makeSnap, volume, type CtxHarness } from "./testing/fakes";

const APPROVAL = { byUserId: "user1", at: "2026-11-20T09:59:00.000Z", boundHash: "f".repeat(64), acks: [], confirmedName: "cmrun00000001", acceptDataRisk: false, expiresAt: null };
const ATTEST = { checkId: TICK_GAP_CHECK, byUserId: "user1", at: "2026-11-20T09:58:00.000Z" };

const runWith = (accepted: number | "unset", o: Parameters<typeof makeRun>[0] = {}): RunSnapshot =>
  makeRun({ ...o, inputs: { ...(accepted === "unset" ? { tickGapAcceptMinutes: undefined } : { tickGapAcceptMinutes: answered(accepted) }) } });

function build(run: RunSnapshot, snap = makeSnap({ apps: [{ itemRef: "app:s:abc", name: "web", source: "GIT" }, { itemRef: "app:s:def", name: "api", source: "IMAGE" }], services: [] })) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(snap);
  const host = new SourceHostFake({ containers: [] });
  const handler = new FreezeHandler(registry, data, new FakeSourceApi(), host, new FakeCaps());
  handler.onModuleInit();
  const ctx = (o: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness =>
    makeCtx({ key: "FREEZE", run, steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" } }, approval: APPROVAL, ...o });
  return { handler, data, ctx, host };
}

describe("tickGapOf", () => {
  it("rounds the gap up to whole minutes and compares it with what the owner accepts", () => {
    expect(tickGapOf(60, 1)).toEqual({ gapMinutes: 1, acceptedMinutes: 1, over: false });
    expect(tickGapOf(61, 1)).toEqual({ gapMinutes: 2, acceptedMinutes: 1, over: true });
    expect(tickGapOf(1, 0)).toMatchObject({ gapMinutes: 1, over: true }); // the default 0: any gap needs the attestation
  });
  it("an unknown estimate is never inside the tolerance", () => {
    expect(tickGapOf(null, 10_080)).toEqual({ gapMinutes: null, acceptedMinutes: 10_080, over: true });
  });
});

describe("FREEZE: the estimated write gap against tickGapAcceptMinutes (N2)", () => {
  it("the owner default (0) means any gap needs the typed attestation: the pre-gate parks the step and offers it", async () => {
    const { handler, ctx, host } = build(runWith("unset"));
    const h = ctx();
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.passed).toBe(false);
    expect(pre.checks).toContainEqual(expect.objectContaining({ id: "freeze.tick-gap", status: "fail", code: TICK_GAP_CODES.exceeded, attestable: [TICK_GAP_CHECK], ownerInput: "tickGapAcceptMinutes" }));
    expect(pre.wait).toMatchObject({ kind: "operator", code: TICK_GAP_CODES.exceeded, attest: [TICK_GAP_CHECK], params: { acceptedMinutes: 0, writers: 2 } });
    expect(pre.wait).not.toHaveProperty("offersCommand");
    host.dispose();
  });

  it("an over-the-limit gap passes once the attestation is recorded on the step, and stays visible as a warning", async () => {
    const { handler, ctx, host } = build(runWith(0));
    const h = ctx({ steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" }, FREEZE: { evidence: { attestations: [ATTEST], attachments: [] } } } });
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.passed).toBe(true);
    expect(pre.checks).toContainEqual(expect.objectContaining({ id: "freeze.tick-gap", status: "warn", code: TICK_GAP_CODES.attested, evidence: "operator-attested" }));
    host.dispose();
  });

  it("a gap inside the accepted minutes needs nothing; one minute over needs the attestation", async () => {
    const probe = build(runWith(0));
    const snap = probe.data.snap;
    const gap = tickGapOf(estimateWindowDetail(snap, NOW, windowExtrasOf(runWith(0), snap)).estimate.freezeToFlipSec, 0).gapMinutes!;
    expect(gap).toBeGreaterThan(0);
    probe.host.dispose();

    const within = build(runWith(gap));
    const hw = within.ctx();
    const pw = within.handler.preGate(hw.ctx, await within.handler.observe(hw.ctx));
    expect(pw.passed).toBe(true);
    expect(pw.checks).toContainEqual(expect.objectContaining({ id: "freeze.tick-gap", status: "pass", code: TICK_GAP_CODES.within }));
    within.host.dispose();

    const over = build(runWith(gap - 1));
    const ho = over.ctx();
    expect(over.handler.preGate(ho.ctx, await over.handler.observe(ho.ctx)).checks).toContainEqual(expect.objectContaining({ status: "fail", code: TICK_GAP_CODES.exceeded, params: expect.objectContaining({ gapMinutes: gap, acceptedMinutes: gap - 1 }) }));
    over.host.dispose();
  });

  it("an estimate that cannot be told yet (an unmeasured volume) is over any tolerance", async () => {
    const { handler, ctx, host } = build(runWith(10_080), makeSnap({ apps: [{ itemRef: "app:s:abc", name: "web" }], volumes: [volume("volume:s:a:data")] }));
    const h = ctx();
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.checks).toContainEqual(expect.objectContaining({ code: TICK_GAP_CODES.exceeded, params: expect.objectContaining({ gapMinutes: null }) }));
    host.dispose();
  });

  it("a run that stops no writer has no write gap to accept", async () => {
    const { handler, ctx, host } = build(runWith(0), makeSnap({ apps: [], services: [] }));
    const h = ctx();
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.checks.map((c) => c.id)).not.toContain("freeze.tick-gap");
    host.dispose();
  });

  it("act refuses to open the window without the attestation, and with it opens the window and records the accepted gap once", async () => {
    const { handler, ctx, host } = build(runWith(0));
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: "freeze.tick-gap-not-accepted", retryable: true });
    expect(h.patches.some((p) => p.freezeStartedAt)).toBe(false);

    const a = ctx({ steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" }, FREEZE: { evidence: { attestations: [ATTEST], attachments: [] } } } });
    await handler.act(a.ctx, await handler.observe(a.ctx));
    expect(a.patches.some((p) => p.freezeStartedAt)).toBe(true);
    expect(a.events.filter((e) => e.code === TICK_GAP_CODES.attested)).toHaveLength(1);
    expect(a.events.find((e) => e.code === TICK_GAP_CODES.attested)).toMatchObject({ level: "warn", params: { acceptedMinutes: 0, writers: 2 } });
    // the next tick of the same step does not say it again
    const b = ctx({ steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" }, FREEZE: { evidence: { attestations: [ATTEST], attachments: [] }, compensation: a.comp } } });
    await handler.act(b.ctx, await handler.observe(b.ctx));
    expect(b.events.filter((e) => e.code === TICK_GAP_CODES.attested)).toHaveLength(0);
    host.dispose();
  });
});

describe("FREEZE approval: the full window estimate (R27/C5/R38) and the write gap", () => {
  it("shows every term of the estimate: data, builds, starts, health, ACME, bytes and the 2x bytes through the hub", async () => {
    const snap = makeSnap({
      apps: [{ itemRef: "app:s:abc", name: "web", source: "GIT" }, { itemRef: "app:s:def", name: "api", source: "GIT" }, { itemRef: "app:s:ghi", name: "img", source: "IMAGE" }],
      services: [],
      volumes: [inspected("volume:s:a:data", 3 * 1024 ** 3)],
    });
    const run = runWith(0);
    const { handler, ctx, host } = build(run, snap);
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const b = (await handler.approvalBinding(h.ctx, obs))!;
    const t = estimateWindowDetail(snap, NOW, windowExtrasOf(run, snap)).terms;
    expect(t.buildSec).toBe(2 * 240); // two git builds, one at a time
    expect(t.startSec).toBe(3 * 25);
    expect(t.healthSec).toBeGreaterThan(0);
    expect(t.acmeSec).toBeGreaterThan(0);
    expect(t.hubBytes).toBe(2 * 3 * 1024 ** 3);
    expect(b.review).toMatchObject({
      estimateSec: obs.estimateSec,
      estimateDataSec: t.dataSec,
      estimateBuildSec: t.buildSec,
      estimateStartSec: t.startSec,
      estimateHealthSec: t.healthSec,
      estimateAcmeSec: t.acmeSec,
      estimateBytes: 3 * 1024 ** 3,
      estimateHubBytes: 2 * 3 * 1024 ** 3,
      writeGapSec: obs.estimateSec,
      tickGapAcceptedSec: 0,
      tickGapNeedsAttestation: true,
    });
    expect(obs.estimateSec).toBe(t.dataSec + t.buildSec + t.startSec + t.healthSec + t.acmeSec);
    host.dispose();
  });

  it("an accepted gap changes what was reviewed (the hash), so an approval of the old tolerance is void", async () => {
    const a = build(runWith(0));
    const b = build(runWith(30));
    const ha = a.ctx();
    const hb = b.ctx();
    const ba = (await a.handler.approvalBinding(ha.ctx, await a.handler.observe(ha.ctx)))!;
    const bb = (await b.handler.approvalBinding(hb.ctx, await b.handler.observe(hb.ctx)))!;
    expect(ba.inputHash).not.toBe(bb.inputHash);
    expect(bb.review).toMatchObject({ tickGapAcceptedSec: 1800, tickGapNeedsAttestation: false });
    a.host.dispose();
    b.host.dispose();
  });
});
