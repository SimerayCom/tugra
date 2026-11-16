import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import type { RunSnapshot } from "../../core/run-contract";
import { VX_409 } from "../../../importer/volume-stream/vx-constants";
import { DATA_CODES } from "./data-contract";
import { DataFinalHandler } from "./data-final.handler";
import { MAX_AUTO_OBJECT_STARTS } from "./handler-util";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeObjectPort, answered, copied, database, inspected, makeCtx, makeRun, makeSnap, volume, type CtxHarness } from "./testing/fakes";

const FROZEN = { DATA_SEED: { status: "PASSED" as const }, FREEZE: { status: "PASSED" as const } };

function build(run: RunSnapshot = makeRun()) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(makeSnap());
  const objects = new FakeObjectPort();
  const caps = new FakeCaps();
  const host = new SourceHostFake({ containers: [] });
  const runner = new MigratorRunner(host, data, caps, join(host.dir, "runs"));
  const handler = new DataFinalHandler(registry, data, objects, caps, runner);
  handler.onModuleInit();
  const ctx = (o: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "DATA_FINAL", run, steps: { ...FROZEN, ...(o.steps ?? {}) }, ...o, ...(o.steps ? { steps: { ...FROZEN, ...o.steps } } : {}) });
  return { registry, data, objects, caps, host, handler, ctx };
}

const attach = (id: string) => ({ DATA_SEED: { evidence: { attestations: [], attachments: [{ kind: "object-migration" as const, resourceId: id, byUserId: "user1", at: "x" }] } } });

describe("DataFinalHandler gates", () => {
  it("registers as DATA_FINAL (operator, UNDOABLE)", () => {
    expect(build().registry.require("DATA_FINAL")).toMatchObject({ kind: "operator", rollback: "UNDOABLE" });
  });

  it("will not act until FREEZE passed", async () => {
    const { handler, ctx } = build();
    const h = makeCtx({ key: "DATA_FINAL", run: makeRun(), steps: { FREEZE: { status: "WAITING_OPERATOR" } } });
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.passed).toBe(false);
    expect(pre.checks[0]).toMatchObject({ id: "frozen", code: "data-final.source-not-frozen" });
    expect(handler.preGate(ctx().ctx, await handler.observe(ctx().ctx)).passed).toBe(true);
  });

  it("structural blockers: agent runner off the same host, and volumes while the streamed copy is disabled", async () => {
    const run = makeRun({ options: { sourceRunner: "agent" } });
    const a = build(run);
    const ha = a.ctx({ run });
    expect(a.handler.preGate(ha.ctx, await a.handler.observe(ha.ctx)).checks.map((c) => c.id)).toContain("agent-same-host");
    const b = build();
    b.data.snap = makeSnap({ vxEnabled: false, volumes: [inspected("volume:s:a:data")] });
    const hb = b.ctx();
    expect(b.handler.preGate(hb.ctx, await b.handler.observe(hb.ctx)).checks.map((c) => c.id)).toContain("vx-disabled");
    a.host.dispose();
    b.host.dispose();
  });
});

describe("DataFinalHandler with an operator-run migrator", () => {
  it("asks for the final run with the exact flags while work remains", async () => {
    const { handler, ctx, data } = build();
    data.snap = makeSnap({ volumes: [inspected("volume:s:a:data")], databases: [database("database:s:pg", { task: "none" })] });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false);
    const res = await handler.act(h.ctx, obs);
    expect(res).toMatchObject({
      outcome: "wait",
      wait: { kind: "operator", code: DATA_CODES.runMigrator, offersCommand: true, params: { phase: "final", pending: 2, flags: ["--arms", "all", "--resync", "--verify", "--verify-mode", "estimate", "--hub-outage-wait", "30m"] } },
    });
    expect(obs.progress).toEqual({ done: 0, total: 2, unit: "item" });
  });

  it("a stream that is running right now is polled, not re-requested", async () => {
    const { handler, ctx, data } = build();
    data.snap = makeSnap({ volumes: [inspected("volume:s:a:data", 10, 1, { state: "COPYING" })] });
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
  });

  it("a failed volume asks for a re-run (the copy resumes by part) and says how many things are failing", async () => {
    const { handler, ctx, data } = build();
    data.snap = makeSnap({ volumes: [inspected("volume:s:a:data", 10, 1, { state: "FAILED", error: VX_409.diverged }), copied("volume:s:b:data")] });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).checks.find((c) => c.code === DATA_CODES.finalVolumeDiverged)).toBeDefined();
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.runMigrator, params: { failing: 1, pending: 1 } } });
  });

  it("wraps up when everything is in: revokes the token, ends the capability this run added, and only then passes", async () => {
    const { handler, ctx, data, caps } = build();
    data.snap = makeSnap({ tokenActive: true, volumes: [copied("volume:s:a:data")], databases: [database("database:s:pg", { task: "done" })] });
    caps.granted.add("migrate");
    const h = ctx({ steps: { DATA_SEED: { compensation: { capAdded: true } } } });
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false); // data is in, but the step has not wrapped up yet
    expect(handler.postGate(h.ctx, obs).checks.map((c) => c.code)).toContain("data-final.wrap-up-pending");
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    expect(data.revoked).toBe(1);
    expect(caps.granted.has("migrate")).toBe(false);
    expect(h.comp.wrapped).toBe(true);
    expect(h.events.map((e) => e.code)).toContain("data-final.wrapped-up");

    const h2 = ctx({ steps: { DATA_SEED: { compensation: { capAdded: true } }, DATA_FINAL: { compensation: h.comp } } });
    expect(handler.postGate(h2.ctx, await handler.observe(h2.ctx)).passed).toBe(true);
  });

  it("never revokes a capability the owner had granted before the run", async () => {
    const { handler, ctx, data, caps } = build();
    data.snap = makeSnap({ volumes: [copied("volume:s:a:data")] });
    caps.granted.add("migrate");
    const h = ctx();
    await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(caps.granted.has("migrate")).toBe(true);
    expect(caps.log).not.toContain("release");
  });

  it("an unsupported engine and an excluded volume only warn: the step still completes, and both stay visible", async () => {
    const { handler, ctx, data } = build();
    data.snap = makeSnap({ databases: [database("database:s:mongo", { plane: "unsupported", engine: "MONGO" })], volumes: [volume("volume:s:x:data", { excluded: true, state: "EXCLUDED" })] });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const g = handler.postGate(h.ctx, obs);
    expect(g.checks.filter((c) => c.status === "warn")).toHaveLength(2);
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
  });

  it("entries that differ from the inspection block the wrap-up and are named", async () => {
    const { handler, ctx, data } = build();
    data.snap = makeSnap({ tokenActive: true, volumes: [inspected("volume:s:a:data", 10, 100, { state: "DONE", entries: 90 })] });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.finalEntriesMismatch } });
    expect(data.revoked).toBe(0);
    expect(h.comp.wrapped).toBeUndefined();
  });

  it("a crash right after the token was revoked but before the marker is harmless: the next tick wraps up again", async () => {
    const { handler, ctx, data } = build();
    data.snap = makeSnap({ tokenActive: false, volumes: [copied("volume:s:a:data")] });
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "done" });
    expect(data.revoked).toBe(1); // idempotent revoke
  });

  it("fails with a fixed code when the op is gone", async () => {
    const { handler, ctx } = build();
    await expect(handler.observe(ctx({ run: makeRun({ opId: null }) }).ctx)).rejects.toMatchObject({ code: DATA_CODES.opMissing });
  });
});

describe("DataFinalHandler object migrations", () => {
  const view = (status: string, bucket: string) => ({ id: "om1", status, buckets: [{ srcBucket: "media", selected: true, status: bucket, diffMissing: null, diffDiffer: null, diffExtra: null }] });

  it("runs the final pass (the writers are frozen), then the diff, then lets the step wrap up", async () => {
    const { handler, ctx, objects } = build();
    objects.add(view("SEEDED", "SEEDED"));
    const h = ctx({ steps: attach("om1") });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    expect(objects.calls).toEqual(["final:om1"]);

    // the final pass finished: the runner reports FINAL -> verify
    objects.views.get("om1")!.status = "FINAL";
    objects.views.get("om1")!.buckets[0].status = "FINAL";
    const h2 = ctx({ steps: attach("om1") });
    expect(await handler.act(h2.ctx, await handler.observe(h2.ctx))).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    expect(objects.calls).toEqual(["final:om1", "verify:om1"]);

    objects.views.get("om1")!.status = "DONE";
    objects.views.get("om1")!.buckets[0].status = "VERIFIED";
    const h3 = ctx({ steps: attach("om1") });
    const obs3 = await handler.observe(h3.ctx);
    expect(handler.postGate(h3.ctx, obs3).checks.find((c) => c.id.startsWith("bucket"))?.status).toBe("pass");
    expect(await handler.act(h3.ctx, obs3)).toEqual({ outcome: "done" });
  });

  it("a bucket the diff says DIFFERS is not verified again by itself: the operator decides, and retry re-runs the final pass", async () => {
    const { handler, ctx, objects } = build();
    objects.add({ id: "om1", status: "FINAL", buckets: [{ srcBucket: "media", selected: true, status: "DIFFERS", diffMissing: 2, diffDiffer: 0, diffExtra: 0 }] });
    const h = ctx({ steps: attach("om1") });
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.finalObjectDiffers } });
    expect(objects.calls).toEqual([]);
    const r = ctx({ steps: attach("om1"), trigger: "retry" });
    await handler.act(r.ctx, await handler.observe(r.ctx));
    expect(objects.calls).toEqual(["final:om1"]);
  });

  it("a failing pass is retried automatically only a few times, then it is reported", async () => {
    const { handler, ctx, objects } = build();
    objects.add({ id: "om1", status: "FAILED", buckets: [{ srcBucket: "media", selected: true, status: "FAILED", diffMissing: null, diffDiffer: null, diffExtra: null }] });
    let comp: Record<string, unknown> = {};
    for (let i = 0; i < MAX_AUTO_OBJECT_STARTS + 2; i++) {
      objects.views.get("om1")!.status = "FAILED";
      objects.views.get("om1")!.buckets[0].status = "FAILED";
      const h = ctx({ steps: { ...attach("om1"), DATA_FINAL: { compensation: comp } } });
      await handler.act(h.ctx, await handler.observe(h.ctx));
      comp = h.comp;
    }
    expect(objects.calls.filter((c) => c.startsWith("final:"))).toHaveLength(MAX_AUTO_OBJECT_STARTS);
    // an explicit retry is always honoured
    objects.views.get("om1")!.status = "FAILED";
    objects.views.get("om1")!.buckets[0].status = "FAILED";
    const r = ctx({ steps: { ...attach("om1"), DATA_FINAL: { compensation: comp } }, trigger: "retry" });
    await handler.act(r.ctx, await handler.observe(r.ctx));
    expect(objects.calls.filter((c) => c.startsWith("final:"))).toHaveLength(MAX_AUTO_OBJECT_STARTS + 1);
  });

  it("an object migration that is still seeding is DATA_SEED's business: the final pass is not started on it", async () => {
    const { handler, ctx, objects } = build();
    objects.add({ id: "om1", status: "PREFLIGHTED" });
    const h = ctx({ steps: attach("om1") });
    await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(objects.calls).toEqual([]);
  });

  it("a vanished migration fails hard; a rejected start is retryable", async () => {
    const { handler, ctx, objects } = build();
    const g = ctx({ steps: attach("gone") });
    expect(await handler.act(g.ctx, await handler.observe(g.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.seedObjectGone, retryable: false });
    objects.add(view("SEEDED", "SEEDED"));
    objects.failStart = true;
    const h = ctx({ steps: attach("om1") });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.seedObjectStartRejected, retryable: true });
  });
});

describe("DataFinalHandler with the same-host (agent) runner", () => {
  const sameHost = () => makeRun({ topology: "swap-proxy", options: { sourceRunner: "agent" } });

  it("launches the final run through the agent and records it", async () => {
    const run = sameHost();
    const { handler, ctx, data, host, caps } = build(run);
    data.snap = makeSnap({ volumes: [inspected("volume:s:a:data")], databases: [database("database:s:pg", { task: "none" })] });
    const h = ctx({ run });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    const launch = host.runs.find((r) => r.script.includes("TUGRA_RUN_EOF"))!;
    expect(launch.script).toContain("'--resync' '--verify' '--verify-mode' 'estimate'");
    expect(h.comp.launch).toMatchObject({ seq: 1, phase: "final" });
    expect(caps.log).toEqual(["ensure:added"]);
    host.dispose();
  });

  it("a migrator that finished with a fatal exit (auth, skew...) fails with its exit code, not a loop", async () => {
    const run = sameHost();
    const { handler, ctx, data, host } = build(run);
    data.snap = makeSnap({ databases: [database("database:s:pg", { task: "none" })] });
    const h = ctx({ run, steps: { DATA_FINAL: { compensation: { launchSeq: 1, launch: { seq: 1, phase: "final", at: "x" } } } } });
    const obs = await handler.observe(h.ctx);
    obs.launcher = { state: "finished", rc: 3, result: { exit: 3, code: "auth", counts: {}, items: [] } };
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "fail", code: DATA_CODES.finalMigratorExit, params: { exit: 3, code: "auth" }, retryable: true });
    host.dispose();
  });

  it("a running migrator is polled; a partial (exit 1) finish with work left relaunches to resume", async () => {
    const run = sameHost();
    const { handler, ctx, data, host } = build(run);
    data.snap = makeSnap({ databases: [database("database:s:pg", { task: "none" })] });
    const comp = { launchSeq: 1, launch: { seq: 1, phase: "final", at: "x" } };
    const h = ctx({ run, steps: { DATA_FINAL: { compensation: comp } } });
    const obs = await handler.observe(h.ctx);
    obs.launcher = { state: "running" };
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    obs.launcher = { state: "finished", rc: 1, result: null };
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    expect(h.comp.launchSeq).toBe(2);
    host.dispose();
  });
});

describe("DataFinalHandler.compensate", () => {
  it("abort cancels everything in flight, revokes the token and ends the migrator it launched", async () => {
    const run = makeRun({ topology: "swap-proxy", options: { sourceRunner: "agent" } });
    const { handler, ctx, data, objects, host, caps } = build(run);
    data.snap = makeSnap({ volumes: [volume("volume:s:a:data", { state: "COPYING" }), volume("volume:s:b:data", { state: "DONE" })] });
    objects.add({ id: "om1", status: "FINALIZING", buckets: [{ srcBucket: "media", selected: true, status: "FINALIZING", diffMissing: null, diffDiffer: null, diffExtra: null }] });
    const h = ctx({ run, steps: { ...attach("om1"), DATA_FINAL: { compensation: { launchSeq: 1, launch: { seq: 1, phase: "final", at: "x" } } } } });
    expect(await handler.compensate(h.ctx, "abort")).toEqual({ outcome: "done" });
    expect(data.aborted).toEqual(["volume:s:a:data"]);
    expect(data.revoked).toBe(1);
    expect(objects.calls).toEqual(["cancel:om1"]);
    expect(host.runs.some((r) => r.script.includes("docker stop -t 30"))).toBe(true);
    expect(caps.granted.has("migrate")).toBe(false);
    host.dispose();
  });

  it("with --stop-source the operator must restart what the migrator stopped (the hub does not know which)", async () => {
    const run = makeRun({ options: { stopSource: true } });
    const { handler, ctx } = build(run);
    expect(await handler.compensate(ctx({ run }).ctx, "abort")).toEqual({ outcome: "manual", manual: [{ code: DATA_CODES.finalStopSourceManual }] });
  });

  it("cleanup and reverse are not its business; an incomplete abort is reported", async () => {
    const { handler, ctx, data } = build();
    expect(await handler.compensate(ctx().ctx, "cleanup")).toEqual({ outcome: "nothing-to-do" });
    expect(await handler.compensate(ctx().ctx, "reverse")).toEqual({ outcome: "nothing-to-do" });
    data.abortTransfers = async () => {
      throw new Error("x");
    };
    data.snap = makeSnap({ volumes: [volume("volume:s:a:data", { state: "COPYING" })] });
    expect(await handler.compensate(ctx().ctx, "abort")).toMatchObject({ outcome: "failed", code: "data-final.abort-incomplete" });
  });
});

describe("DataFinalHandler.dryRun", () => {
  it("shows the flags and what would move, and changes nothing", async () => {
    const { handler, ctx, data, objects } = build();
    data.snap = makeSnap({ volumes: [inspected("volume:s:a:data")], databases: [database("database:s:m", { plane: "unsupported", engine: "MONGO" })] });
    const items = await handler.dryRun(ctx({ run: makeRun({ dryRun: true }) }).ctx);
    expect(items[0]).toMatchObject({ code: "data-final.dry.plan", params: { runner: "operator", stopSource: false } });
    expect(items.some((i) => i.code === DATA_CODES.finalDbUnsupported && i.level === "warn")).toBe(true);
    expect(data.tokens + data.revoked + data.aborted.length + objects.calls.length).toBe(0);
    void answered;
  });
});
