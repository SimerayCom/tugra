import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { PONR_APPROVAL_TTL_SEC, type RunSnapshot } from "../../core/run-contract";
import { CHECK_STORE, DATA_CODES, SOURCE_STATS_CHECK, VERIFY_APPROVAL_CHECK } from "./data-contract";
import { MEASURE_BUDGET_MS, MEASURE_TTL_MS, VerifyHandler } from "./verify.handler";
import { PARITY_CODES } from "./verify/db-stats";
import { MemoryCheckStore } from "./verify/check-store";
import { FakeDataPort, FakeDrift, FakeFlip, FakeObjectPort, FakeRuntime, FakeStats, NOW, copied, database, makeCtx, makeRun, makeSnap, measured, type CtxHarness } from "./testing/fakes";

function build(run: RunSnapshot = makeRun()) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(makeSnap({ volumes: [copied("volume:s:abc:data")], databases: [database("database:s:pg", { task: "done" })] }));
  const objects = new FakeObjectPort();
  const runtime = new FakeRuntime();
  runtime.rt = {
    apps: [{ itemRef: "app:s:abc", name: "web", status: "RUNNING", envUnresolved: 0, envDropped: 0 }],
    databases: [{ itemRef: "database:s:pg", name: "pg", status: "RUNNING" }],
    hosts: [{ hostname: "a.example.com", state: "READY", stateful: true, blockReason: null }],
    incomplete: [],
  };
  const stats = new FakeStats();
  stats.byRef.set("database:s:pg", measured("database:s:pg", [["public.t", 5]]));
  const flip = new FakeFlip();
  const drift = new FakeDrift();
  const checks = new MemoryCheckStore();
  const handler = new VerifyHandler(registry, data, objects, runtime, stats, flip, drift, checks);
  handler.onModuleInit();
  const ctx = (o: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "VERIFY", run, ...o });
  const reportSource = (rows: Array<[string, number]> = [["public.t", 5]]) =>
    checks.upsert({ runId: run.id, stepKey: "VERIFY", checkId: SOURCE_STATS_CHECK, subject: "database:s:pg", status: "unknown", evidenceKind: "migrator-reported", evidence: measured("database:s:pg", rows) as never });
  return { registry, data, objects, runtime, stats, flip, drift, checks, handler, ctx, reportSource, run };
}

const approval = (hash: string, over: Record<string, unknown> = {}) => ({ byUserId: "user1", at: NOW.toISOString(), boundHash: hash, acks: [] as string[], confirmedName: "target", acceptDataRisk: true, expiresAt: new Date(NOW.getTime() + PONR_APPROVAL_TTL_SEC * 1000).toISOString(), ...over });

describe("VerifyHandler registration and dry run", () => {
  it("registers as VERIFY (approval, FREE)", () => {
    expect(build().registry.require("VERIFY")).toMatchObject({ kind: "approval", rollback: "FREE" });
  });
  it("projects the plan without measuring anything", async () => {
    const { handler, ctx, stats, drift } = build();
    expect(await handler.dryRun(ctx({ run: makeRun({ dryRun: true }) }).ctx)).toEqual([
      { code: "verify.dry.plan", level: "info", params: { rowCountMode: "estimate", topology: "two-box", mode: "copy", approvalTtlSec: PONR_APPROVAL_TTL_SEC } },
    ]);
    expect(stats.calls).toEqual([]);
    expect(drift.calls).toBe(0);
  });
});

describe("VerifyHandler.observe", () => {
  it("compares what the migrator reported with what the hub measured, and persists the hub's measurement", async () => {
    const { handler, ctx, reportSource, checks, stats } = build();
    await reportSource();
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(stats.calls).toEqual(["database:s:pg"]);
    const parity = obs.suite.find((c) => c.checkId === "db-logical-parity")!;
    expect(parity).toMatchObject({ status: "pass", code: PARITY_CODES.match, evidence: "migrator-reported" });
    const rows = await checks.list(h.ctx.run.id, "VERIFY");
    expect(rows.map((r) => r.checkId).sort()).toEqual(["source-drift-probe", "source-stats", "target-stats"]);
    expect(rows.find((r) => r.checkId === "target-stats")).toMatchObject({ evidenceKind: "hub-verified", subject: "database:s:pg" });
  });

  it("an unreported source is `unknown`, a lost row is a failure", async () => {
    const a = build();
    const ha = a.ctx();
    expect((await a.handler.observe(ha.ctx)).suite.find((c) => c.checkId === "db-logical-parity")).toMatchObject({ status: "unknown", code: PARITY_CODES.sourceUnavailable, ackable: true });
    const b = build();
    await b.reportSource([["public.t", 9]]);
    expect((await b.handler.observe(b.ctx().ctx)).suite.find((c) => c.checkId === "db-logical-parity")).toMatchObject({ status: "fail", code: PARITY_CODES.mismatch, ackable: false });
  });

  it("reuses a fresh target measurement and a fresh drift probe, and re-measures when stale or when the source was re-reported", async () => {
    const { handler, ctx, reportSource, stats, drift } = build();
    await reportSource();
    const h = ctx();
    await handler.observe(h.ctx);
    h.clock.now = new Date(NOW.getTime() + 60_000);
    await handler.observe(h.ctx);
    expect(stats.calls).toHaveLength(1);
    expect(drift.calls).toBe(1);

    h.clock.now = new Date(NOW.getTime() + MEASURE_TTL_MS + 1000);
    await handler.observe(h.ctx);
    expect(stats.calls).toHaveLength(2);
    expect(drift.calls).toBe(2);
  });

  it("a source re-reported after the target measurement forces a fresh target measurement", async () => {
    const { handler, ctx, reportSource, stats, checks } = build();
    await reportSource();
    const h = ctx();
    await handler.observe(h.ctx);
    expect(stats.calls).toHaveLength(1);
    // the migrator ran again (DATA_FINAL retry): the stored source row is newer than the cached target row
    await checks.upsert({ runId: h.ctx.run.id, stepKey: "VERIFY", checkId: SOURCE_STATS_CHECK, subject: "database:s:pg", status: "unknown", evidenceKind: "migrator-reported", evidence: measured("database:s:pg", [["public.t", 5]]) as never, at: new Date(NOW.getTime() + 5000) });
    await handler.observe(h.ctx);
    expect(stats.calls).toHaveLength(2);
  });

  it("a bounded budget per tick: databases beyond it stay `not measured yet` (blocking, not ackable) and are picked up next tick", async () => {
    const { handler, ctx, data, stats, reportSource } = build();
    data.snap.databases = [database("database:s:pg", { task: "done" }), database("database:s:pg2", { task: "done" })];
    await reportSource();
    stats.delayMs = 20;
    const orig = Date.now;
    let t = orig();
    // the first measurement "takes" longer than the budget
    jest.spyOn(Date, "now").mockImplementation(() => {
      t += MEASURE_BUDGET_MS * 0.6;
      return t;
    });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    jest.restoreAllMocks();
    expect(obs.measuredPending).toBeGreaterThan(0);
    const g = handler.preGate(h.ctx, obs);
    expect(g.passed).toBe(false);
    expect(g.wait).toMatchObject({ kind: "operator", params: { pending: obs.measuredPending } });
  });

  it("only measures databases that arrived, and never an unsupported engine", async () => {
    const { handler, ctx, data, stats } = build();
    data.snap.databases = [database("database:s:a", { task: "none" }), database("database:s:m", { task: "done", plane: "unsupported", engine: "MONGO" }), database("database:s:p", { task: "done", plane: "volume" })];
    await handler.observe(ctx().ctx);
    expect(stats.calls).toEqual([]);
  });
});

describe("VerifyHandler approval binding and gates", () => {
  it("binds a point-of-no-return approval: 30 minutes, the target server's name, the data-risk acknowledgement for stateful hosts", async () => {
    const { handler, ctx, reportSource } = build();
    await reportSource();
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const b = (await handler.approvalBinding(h.ctx, obs))!;
    expect(b).toMatchObject({ ponr: true, confirm: "target-server", ttlSec: PONR_APPROVAL_TTL_SEC, requiresDataRisk: true, ackable: [], requiredAcks: [] });
    expect(b.inputHash).toBe(obs.bindingHash);
    expect(b.review).toMatchObject({ hosts: 1, statefulHosts: ["app.example.com"], blocked: 0, needsAck: 0 });
    // takeover: the source instance host must be typed as well
    const t = build(makeRun({ mode: "takeover" }));
    await t.reportSource();
    const ht = t.ctx({ run: makeRun({ mode: "takeover" }) });
    expect((await t.handler.approvalBinding(ht.ctx, await t.handler.observe(ht.ctx)))!.confirm).toBe("target-server+source-host");
  });

  it("no stateful host means no data-risk acknowledgement", async () => {
    const { handler, ctx, reportSource, flip } = build();
    await reportSource();
    flip.lite = { ...flip.lite, statefulHosts: [] };
    const h = ctx();
    expect((await handler.approvalBinding(h.ctx, await handler.observe(h.ctx)))!.requiresDataRisk).toBe(false);
  });

  it("there is nothing to approve while the flip plan cannot be computed", async () => {
    const { handler, ctx, reportSource, flip } = build();
    await reportSource();
    flip.lite = { planHash: null, hosts: [], statefulHosts: [], unavailable: "flip-plan-error" };
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(await handler.approvalBinding(h.ctx, obs)).toBeNull();
    const g = handler.preGate(h.ctx, obs);
    expect(g.passed).toBe(false);
    expect(g.wait).toMatchObject({ kind: "operator", code: DATA_CODES.verifyFlipPlan });
  });

  it("ackable findings are listed for the human and do not block the gate; a lost row does", async () => {
    const { handler, ctx, drift, reportSource, runtime } = build();
    await reportSource();
    drift.result = "unknown";
    runtime.rt.apps[0].status = "STOPPED";
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const b = (await handler.approvalBinding(h.ctx, obs))!;
    expect(b.ackable.length).toBe(2);
    expect(b.requiredAcks).toEqual(b.ackable);
    expect(handler.preGate(h.ctx, obs).passed).toBe(true); // a person decides

    const lost = build();
    await lost.reportSource([["public.t", 9]]);
    const hl = lost.ctx();
    const g = lost.handler.preGate(hl.ctx, await lost.handler.observe(hl.ctx));
    expect(g.passed).toBe(false);
    expect(g.wait).toMatchObject({ kind: "operator", code: PARITY_CODES.mismatch });
  });

  it("marks the acknowledged checks `acked` once the approval carries them", async () => {
    const { handler, ctx, drift, reportSource } = build();
    await reportSource();
    drift.result = "changed";
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const id = obs.suite.find((c) => c.checkId === "source-drift")!.id;
    const withAck = ctx({ approval: approval(obs.bindingHash!, { acks: [id] }) });
    const g = handler.preGate(withAck.ctx, obs);
    expect(g.checks.find((c) => c.id === id)).toMatchObject({ status: "fail", acked: true });
  });

  it("the binding does not move with counters that change while a dark app runs", async () => {
    const { handler, ctx, reportSource, stats } = build();
    await reportSource();
    const h = ctx();
    const a = (await handler.observe(h.ctx)).bindingHash;
    stats.byRef.set("database:s:pg", measured("database:s:pg", [["public.t", 6]])); // a dark app wrote one row: warn, but the status changes
    h.clock.now = new Date(NOW.getTime() + MEASURE_TTL_MS + 1000);
    const b = (await handler.observe(h.ctx)).bindingHash;
    expect(b).not.toBe(a); // pass -> warn IS a change of what the human reviewed
    stats.byRef.set("database:s:pg", measured("database:s:pg", [["public.t", 7]]));
    h.clock.now = new Date(NOW.getTime() + 2 * MEASURE_TTL_MS + 2000);
    expect((await handler.observe(h.ctx)).bindingHash).toBe(b); // warn -> warn with other numbers: unchanged
  });
});

describe("VerifyHandler.act and postGate", () => {
  async function approved() {
    const t = build();
    await t.reportSource();
    const h0 = t.ctx();
    const obs0 = await t.handler.observe(h0.ctx);
    return { ...t, obs0, hash: obs0.bindingHash! };
  }

  it("persists every verdict with its evidence kind, writes the approval marker, and only then passes", async () => {
    const t = await approved();
    const pre = t.ctx();
    expect(t.handler.postGate(pre.ctx, t.obs0).passed).toBe(false); // an unapproved review never passes
    const h = t.ctx({ approval: approval(t.hash) });
    const obs = await t.handler.observe(h.ctx);
    expect(await t.handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    const rows = await t.checks.list(h.ctx.run.id, "VERIFY");
    const by = (id: string) => rows.filter((r) => r.checkId === id);
    expect(by("volume-parity")[0]).toMatchObject({ status: "pass", evidenceKind: "migrator-reported" });
    expect(by("db-logical-parity")[0]).toMatchObject({ status: "pass", evidenceKind: "migrator-reported", subject: "database:s:pg" });
    expect(by("app-running")[0].evidenceKind).toBe("hub-verified");
    expect(by(VERIFY_APPROVAL_CHECK)[0]).toMatchObject({ status: "pass", evidenceKind: "operator-attested", evidence: { boundHash: t.hash, byUserId: "user1", acceptDataRisk: true } });
    expect(h.events.map((e) => e.code)).toContain("verify.report-persisted");

    // the next observation of the same, approved state passes
    const h2 = t.ctx({ approval: approval(t.hash), steps: { VERIFY: { approval: approval(t.hash) } } });
    expect(t.handler.postGate(h2.ctx, await t.handler.observe(h2.ctx)).passed).toBe(true);
  });

  it("an approval that expired (30 min) or was bound to another review no longer passes", async () => {
    const t = await approved();
    const h = t.ctx({ approval: approval(t.hash), steps: { VERIFY: { approval: approval(t.hash) } } });
    await t.handler.act(h.ctx, await t.handler.observe(h.ctx));
    const stored = approval(t.hash);
    const later = t.ctx({ now: new Date(NOW.getTime() + (PONR_APPROVAL_TTL_SEC + 1) * 1000), steps: { VERIFY: { approval: stored } } });
    expect(t.handler.postGate(later.ctx, await t.handler.observe(later.ctx)).passed).toBe(false);
    const other = t.ctx({ steps: { VERIFY: { approval: approval(t.hash, { at: "2026-11-20T09:00:00.000Z" }) } } });
    expect(t.handler.postGate(other.ctx, await t.handler.observe(other.ctx)).passed).toBe(false); // a different approval record
    t.flip.lite = { ...t.flip.lite, planHash: "c".repeat(32) };
    const changed = t.ctx({ steps: { VERIFY: { approval: stored } } });
    expect(t.handler.postGate(changed.ctx, await t.handler.observe(changed.ctx)).passed).toBe(false); // the plan moved under it
  });

  it("refuses without an approval, with a stale hash, or with an acknowledgement missing", async () => {
    const t = await approved();
    const none = t.ctx();
    expect(await t.handler.act(none.ctx, await t.handler.observe(none.ctx))).toMatchObject({ outcome: "fail", code: "verify.approval-stale" });
    const stale = t.ctx({ approval: approval("0".repeat(64)) });
    expect(await t.handler.act(stale.ctx, await t.handler.observe(stale.ctx))).toMatchObject({ outcome: "fail", code: "verify.approval-stale" });

    t.drift.result = "unknown";
    const h = t.ctx({ approval: approval("x"), now: new Date(NOW.getTime() + MEASURE_TTL_MS + 1000) }); // the cached "same" probe is stale by now
    const obs = await t.handler.observe(h.ctx);
    const unacked = t.ctx({ approval: approval(obs.bindingHash!), now: h.clock.now });
    expect(await t.handler.act(unacked.ctx, obs)).toMatchObject({ outcome: "fail", code: "verify.unacknowledged", params: { blocked: 0, pending: 1 } });
    const acked = t.ctx({ approval: approval(obs.bindingHash!, { acks: [obs.suite.find((c) => c.checkId === "source-drift")!.id] }), now: h.clock.now });
    expect(await t.handler.act(acked.ctx, obs)).toEqual({ outcome: "done" });
    const rows = await t.checks.list(acked.ctx.run.id, "VERIFY");
    expect(rows.find((r) => r.checkId === "source-drift")).toMatchObject({ status: "unknown", evidence: { acked: true } });
  });

  it("never acts on a review that has a blocking failure, even with an approval", async () => {
    const t = build();
    await t.reportSource([["public.t", 1]]); // the target has more... flip it: a LOSS
    t.stats.byRef.set("database:s:pg", measured("database:s:pg", [["public.t", 0]]));
    t.stats.byRef.set("database:s:pg", measured("database:s:pg", [["public.t", 0]]));
    const h0 = t.ctx();
    const obs0 = await t.handler.observe(h0.ctx);
    const h = t.ctx({ approval: approval(obs0.bindingHash!) });
    expect(await t.handler.act(h.ctx, obs0)).toMatchObject({ outcome: "fail", code: "verify.unacknowledged", params: { blocked: 1 } });
    expect((await t.checks.list(h.ctx.run.id, "VERIFY")).some((r) => r.checkId === VERIFY_APPROVAL_CHECK)).toBe(false);
  });

  it("loses the lease: nothing is persisted", async () => {
    const t = await approved();
    const h = t.ctx({ approval: approval(t.hash) });
    const obs = await t.handler.observe(h.ctx);
    h.lose();
    await expect(t.handler.act(h.ctx, obs)).rejects.toMatchObject({ name: "RunLeaseLostError" });
    expect((await t.checks.list(h.ctx.run.id, "VERIFY")).some((r) => r.checkId === VERIFY_APPROVAL_CHECK)).toBe(false);
  });

  it("compensate has nothing to undo (FREE)", async () => {
    const t = build();
    for (const how of ["abort", "cleanup", "reverse"] as const) expect(await t.handler.compensate(t.ctx().ctx, how)).toEqual({ outcome: "nothing-to-do" });
  });
});

describe("the evidence rows hold no secret", () => {
  it("nothing in a persisted row looks like a credential or a token", async () => {
    const t = build();
    await t.reportSource();
    const h0 = t.ctx();
    const obs = await t.handler.observe(h0.ctx);
    const h = t.ctx({ approval: approval(obs.bindingHash!) });
    await t.handler.act(h.ctx, obs);
    const dump = JSON.stringify([...(await t.checks.list(h.ctx.run.id, "VERIFY"))]);
    expect(dump).not.toMatch(/tugra_mig_|password|secret|Bearer/i);
    void CHECK_STORE;
  });
});
