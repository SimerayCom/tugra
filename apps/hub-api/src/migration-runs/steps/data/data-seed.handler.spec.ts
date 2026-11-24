import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { DataSeedHandler } from "./data-seed.handler";
import { DATA_CODES } from "./data-contract";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeObjectPort, answered, inspected, makeCtx, makeRun, makeSnap, volume, database, type CtxHarness } from "./testing/fakes";
import type { RunSnapshot } from "../../core/run-contract";

function build(run: RunSnapshot = makeRun(), host?: SourceHostFake) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(makeSnap({ volumes: [volume("volume:s:a:data")] }));
  const objects = new FakeObjectPort();
  const caps = new FakeCaps();
  const fakeHost = host ?? new SourceHostFake({ containers: [] });
  const runner = new MigratorRunner(fakeHost, data, caps, join(fakeHost.dir, "runs"));
  const handler = new DataSeedHandler(registry, data, objects, runner);
  handler.onModuleInit();
  const ctx = (extra: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "DATA_SEED", run, ...extra });
  return { registry, data, objects, caps, host: fakeHost, handler, ctx, run };
}

describe("DataSeedHandler registration", () => {
  it("registers itself under DATA_SEED with the manifest's kind, rollback and skippable flag", () => {
    const { registry } = build();
    const h = registry.require("DATA_SEED");
    expect(h).toMatchObject({ key: "DATA_SEED", kind: "operator", rollback: "UNDOABLE", skippable: true });
    expect(h.applicable(makeRun())).toBe(true);
  });
});

describe("DataSeedHandler with an operator-run migrator", () => {
  it("asks the operator to run the dry-run, with the exact flags, and records the downtime estimate", async () => {
    const { handler, ctx } = build();
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false); // nothing inspected yet: never passes by default
    expect(handler.preGate(h.ctx, obs).passed).toBe(true);
    const res = await handler.act(h.ctx, obs);
    expect(res).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: DATA_CODES.runMigrator, offersCommand: true, params: { phase: "inspect", flags: ["--arms", "all", "--dry-run", "--measure-dbs"], pending: 1 } } });
    expect(h.patches).toHaveLength(1);
    expect((h.patches[0].windowEstimate as { freezeToFlipSec: number | null }).freezeToFlipSec).toBeNull(); // the size is not known yet
    expect(obs.progress).toEqual({ done: 0, total: 1, unit: "volume" });
  });

  it("passes once every in-scope volume has an inventory and a disk verdict, and then acts as `done`", async () => {
    const { handler, ctx, data } = build();
    data.snap.volumes = [inspected("volume:s:a:data", 2 * 1024 ** 3, 50)];
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(true);
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    const est = h.patches[0].windowEstimate as { freezeToFlipSec: number; basis: Array<{ code: string }> };
    expect(est.freezeToFlipSec).toBeGreaterThan(0);
    expect(est.basis.map((b) => b.code)).toContain("data-seed.estimate.rate-assumed");
  });

  it("does not rewrite an unchanged estimate on every tick", async () => {
    const { handler, ctx, data } = build();
    data.snap.volumes = [inspected("volume:s:a:data")];
    const first = ctx();
    await handler.act(first.ctx, await handler.observe(first.ctx));
    const second = ctx({ run: makeRun({ windowEstimate: first.patches[0].windowEstimate as never }) });
    await handler.act(second.ctx, await handler.observe(second.ctx));
    expect(second.patches).toHaveLength(0);
  });

  it("a failing volume (missing source, no disk) keeps the step parked with the failing code, not `done`", async () => {
    const { handler, ctx, data } = build();
    data.snap.volumes = [inspected("volume:s:a:data", 1, 1, { disk: { ok: false, unknown: false } })];
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false);
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: DATA_CODES.seedDiskInsufficient, params: { failing: 1 } } });
  });

  it("an explicitly excluded volume does not block", async () => {
    const { handler, ctx, data } = build();
    data.snap.volumes = [volume("volume:s:a:data", { excluded: true, state: "EXCLUDED" })];
    const h = ctx();
    expect(handler.postGate(h.ctx, await handler.observe(h.ctx)).passed).toBe(true);
  });

  it("the warm database seed asks for the databases-only run when (and only when) the option is on", async () => {
    const { handler, data, ctx } = build(makeRun({ options: { warmDbSeed: true } }));
    data.snap.volumes = [inspected("volume:s:a:data")];
    data.snap.databases = [database("database:s:pg", { task: "none" })];
    const h = ctx({ run: makeRun({ options: { warmDbSeed: true } }) });
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.runMigrator, params: { phase: "warm-db", flags: ["--arms", "databases"] } } });
    data.snap.databases[0].task = "done";
    const h2 = ctx({ run: makeRun({ options: { warmDbSeed: true } }) });
    expect(handler.postGate(h2.ctx, await handler.observe(h2.ctx)).passed).toBe(true);
  });

  it("fails with a fixed code when the op is gone", async () => {
    const { handler, ctx } = build();
    const h = ctx({ run: makeRun({ opId: null }) });
    await expect(handler.observe(h.ctx)).rejects.toMatchObject({ code: DATA_CODES.opMissing });
  });
});

describe("DataSeedHandler object migrations", () => {
  const attach = (id: string) => ({ DATA_SEED: { evidence: { attestations: [], attachments: [{ kind: "object-migration" as const, resourceId: id, byUserId: "user1", at: "2026-11-20T09:00:00Z" }] } } });

  it("starts the seed pass of an attached migration, then waits while it runs, then passes when it is seeded", async () => {
    const { handler, ctx, objects, data } = build();
    data.snap.volumes = [];
    objects.add({ id: "om1" });
    const h = ctx({ steps: attach("om1") });
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false);
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    expect(objects.calls).toEqual(["seed:om1"]);

    // the runner is working: observe says SEEDING -> nothing is started twice
    const h2 = ctx({ steps: attach("om1") });
    expect(await handler.act(h2.ctx, await handler.observe(h2.ctx))).toEqual({ outcome: "continue", pollAfterMs: 10_000 });
    expect(objects.calls).toEqual(["seed:om1"]);

    objects.views.get("om1")!.status = "SEEDED";
    objects.views.get("om1")!.buckets[0].status = "SEEDED";
    const h3 = ctx({ steps: attach("om1") });
    const obs3 = await handler.observe(h3.ctx);
    expect(handler.postGate(h3.ctx, obs3).passed).toBe(true);
    expect(await handler.act(h3.ctx, obs3)).toEqual({ outcome: "done" });
  });

  it("a rejected start is a retryable failure with a fixed code; a vanished migration is a hard one", async () => {
    const { handler, ctx, objects, data } = build();
    data.snap.volumes = [];
    objects.add({ id: "om1" });
    objects.failStart = true;
    const h = ctx({ steps: attach("om1") });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.seedObjectStartRejected, retryable: true });
    const g = ctx({ steps: attach("om-gone") });
    expect(await handler.act(g.ctx, await handler.observe(g.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.seedObjectGone, retryable: false });
    expect(handler.postGate(g.ctx, await handler.observe(g.ctx)).passed).toBe(false);
  });

  it("a migration with a blocker is never started and the gate names it", async () => {
    const { handler, ctx, objects, data } = build();
    data.snap.volumes = [];
    objects.add({ id: "om1", blockers: 1 });
    const h = ctx({ steps: attach("om1") });
    const obs = await handler.observe(h.ctx);
    const res = await handler.act(h.ctx, obs);
    expect(objects.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.seedObjectBlocked } });
  });
});

describe("DataSeedHandler with the same-host (agent) runner", () => {
  const sameHost = () => makeRun({ topology: "swap-proxy", options: { sourceRunner: "agent" } });

  it("two-box + agent is refused by the pre-gate before anything is dispatched", async () => {
    const run = makeRun({ options: { sourceRunner: "agent" } });
    const { handler, ctx, host } = build(run);
    const h = ctx({ run });
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.passed).toBe(false);
    expect(pre.checks[0].code).toBe(DATA_CODES.agentNeedsSameHost);
    expect(host.runs).toEqual([]);
    host.dispose();
  });

  it("launches the dry-run through the agent: grants the capability, rotates the token, records the launch, never puts the token on a docker/curl line", async () => {
    const run = sameHost();
    const { handler, ctx, host, caps, data } = build(run);
    const h = ctx({ run });
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toEqual({ outcome: "continue", pollAfterMs: 5_000 });
    expect(caps.log).toEqual(["ensure:added"]);
    expect(h.comp.capAdded).toBe(true);
    expect(h.comp.launch).toMatchObject({ seq: 1, phase: "inspect" });
    expect(data.tokens).toBe(1);
    const launch = host.runs.find((r) => r.script.includes("TUGRA_RUN_EOF"))!;
    expect(launch.capability).toBe("migrate");
    expect(launch.serverId).toBe("srv-target");
    expect(launch.script.split(data.lastToken!).length - 1).toBe(1);
    expect(launch.script).toContain("'--arms' 'all' '--dry-run'");
    expect(h.events.map((e) => e.code)).toContain("data-seed.migrator-launched");
    host.dispose();
  });

  it("resumes after a hub restart: the recorded launch is polled, a running migrator is waited for and never relaunched", async () => {
    const run = sameHost();
    const first = build(run);
    const h1 = first.ctx({ run });
    await first.handler.act(h1.ctx, await first.handler.observe(h1.ctx));
    const launches = first.data.tokens;

    // "restart": a fresh handler, the compensation the first one wrote fed back in
    const second = build(run, first.host);
    second.data.snap = first.data.snap;
    const h2 = second.ctx({ run, steps: { DATA_SEED: { compensation: h1.comp } } });
    const obs = await second.handler.observe(h2.ctx);
    // the fake migrator.sh finished instantly; wait for the rc file, then the inventory is "posted" by the world
    for (let i = 0; i < 50 && obs.launcher?.state !== "finished"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      Object.assign(obs, await second.handler.observe(h2.ctx));
    }
    expect(obs.launcher?.state).toBe("finished");
    second.data.snap.volumes = [inspected("volume:s:a:data")];
    const obs2 = await second.handler.observe(h2.ctx);
    expect(second.handler.postGate(h2.ctx, obs2).passed).toBe(true);
    expect(first.data.tokens).toBe(launches); // nothing relaunched
    first.host.dispose();
  });

  it("an explicit retry after a fatal migrator exit launches again instead of failing with the same exit; the launch budget renews", async () => {
    const run = sameHost();
    const { handler, ctx, host } = build(run);
    const comp = { launchSeq: 3, launchBudgetFrom: 0, launch: { seq: 3, phase: "inspect", at: "x", tag: "seed" } };
    const fatal = { state: "finished" as const, rc: 3, result: null };
    const tick = ctx({ run, steps: { DATA_SEED: { compensation: comp } } });
    const o1 = await handler.observe(tick.ctx);
    o1.launcher = fatal;
    expect(await handler.act(tick.ctx, o1)).toMatchObject({ outcome: "fail", code: DATA_CODES.finalMigratorExit });
    const retry = ctx({ run, trigger: "retry", steps: { DATA_SEED: { compensation: comp } } });
    const o2 = await handler.observe(retry.ctx);
    o2.launcher = fatal;
    expect(await handler.act(retry.ctx, o2)).toMatchObject({ outcome: "continue" });
    expect(retry.comp).toMatchObject({ launchSeq: 4, launchBudgetFrom: 3, launch: { seq: 4, phase: "inspect", tag: "seed" } });
    host.dispose();
  });

  it("gives up after the launch budget instead of looping, with a retryable fixed code", async () => {
    const run = sameHost();
    const { handler, ctx, host } = build(run);
    const h = ctx({ run, steps: { DATA_SEED: { compensation: { launchSeq: 3, launch: { seq: 3, phase: "inspect", at: "2026-11-20T09:00:00Z" } } } } });
    const obs = await handler.observe(h.ctx);
    obs.launcher = { state: "died" };
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "fail", code: DATA_CODES.launcherFailed, params: { reason: "too-many-launches" }, retryable: true });
    host.dispose();
  });

  it("refuses when the hub's public URL is unknown, and when the owner may not grant the capability", async () => {
    const run = sameHost();
    const a = build(run);
    a.data.snap.hubBase = null;
    const savedEnv = process.env.HUB_PUBLIC_URL;
    delete process.env.HUB_PUBLIC_URL;
    const ha = a.ctx({ run });
    expect(await a.handler.act(ha.ctx, await a.handler.observe(ha.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.hubUrlUnknown });
    if (savedEnv !== undefined) process.env.HUB_PUBLIC_URL = savedEnv;

    const b = build(run);
    b.caps.deny = true;
    const hb = b.ctx({ run });
    expect(await b.handler.act(hb.ctx, await b.handler.observe(hb.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.capabilityDenied, retryable: false });
    expect(b.data.tokens).toBe(0); // no token was rotated for a launch that could not happen
    a.host.dispose();
    b.host.dispose();
  });
});

describe("DataSeedHandler.compensate", () => {
  it("abort revokes the token, aborts live transfers, cancels active object migrations and ends the capability it added", async () => {
    const run = makeRun({ topology: "swap-proxy", options: { sourceRunner: "agent" } });
    const { handler, ctx, data, objects, caps, host } = build(run);
    data.snap.volumes = [volume("volume:s:a:data", { state: "COPYING" }), volume("volume:s:b:data", { state: "DONE" }), volume("volume:s:c:data", { state: "FAILED" }), volume("volume:s:d:data", { state: "APPLYING" })];
    objects.add({ id: "om1", status: "SEEDING" });
    objects.views.get("om1")!.buckets[0].status = "SEEDING";
    const h = ctx({
      run,
      steps: { DATA_SEED: { evidence: { attestations: [], attachments: [{ kind: "object-migration", resourceId: "om1", byUserId: "user1", at: "x" }] }, compensation: { capAdded: true, launchSeq: 1, launch: { seq: 1, phase: "inspect", at: "x" } } } },
    });
    const res = await handler.compensate(h.ctx, "abort");
    expect(res).toEqual({ outcome: "done" });
    expect(data.revoked).toBe(1);
    expect(data.aborted.sort()).toEqual(["volume:s:a:data", "volume:s:c:data"]); // never the DONE one, never one that is APPLYING
    expect(objects.calls).toEqual(["cancel:om1"]);
    expect(caps.log).toEqual(["ensure:added", "release"]);
    expect(host.runs.some((r) => r.script.includes("docker stop -t 30"))).toBe(true);
    expect(host.forbiddenCalls()).toEqual([]);
    host.dispose();
  });

  it("cleanup and reverse have nothing to undo; abort of a run that never imported does nothing", async () => {
    const { handler, ctx, data } = build();
    const h = ctx();
    expect(await handler.compensate(h.ctx, "cleanup")).toEqual({ outcome: "nothing-to-do" });
    expect(await handler.compensate(h.ctx, "reverse")).toEqual({ outcome: "nothing-to-do" });
    expect(await handler.compensate(ctx({ run: makeRun({ opId: null }) }).ctx, "abort")).toEqual({ outcome: "nothing-to-do" });
    expect(data.revoked).toBe(0);
  });

  it("an abort that could not finish says so (the engine keeps the compensation for a retry)", async () => {
    const { handler, ctx, data } = build();
    data.revokeToken = async () => {
      throw new Error("db down");
    };
    expect(await handler.compensate(ctx().ctx, "abort")).toMatchObject({ outcome: "failed", code: "data-seed.abort-incomplete" });
  });
});

describe("DataSeedHandler.dryRun", () => {
  it("projects without touching anything", async () => {
    const { handler, ctx, data, objects } = build();
    const items = await handler.dryRun(ctx({ run: makeRun({ dryRun: true, opId: null }) }).ctx);
    expect(items).toEqual([{ code: "data-seed.dry.plan", level: "info", params: { runner: "operator", warmDbSeed: false, flags: ["--arms", "all", "--dry-run", "--measure-dbs"] } }]);
    expect(data.tokens + data.revoked + data.aborted.length + objects.calls.length).toBe(0);
    const withOp = await handler.dryRun(ctx({ run: makeRun({ dryRun: true }) }).ctx);
    expect(withOp.some((i) => i.code === DATA_CODES.seedVolumeNotInspected && i.level === "unknown")).toBe(true);
    expect(withOp.some((i) => i.code === DATA_CODES.seedEstimate)).toBe(true);
    // the result screen's summary card reads the data size and the copy time next to the window
    expect(withOp.find((i) => i.code === DATA_CODES.seedEstimate)?.params).toEqual(expect.objectContaining({ bytes: expect.any(Number), copySeconds: expect.any(Number) }));
    const bad = await handler.dryRun(ctx({ run: makeRun({ dryRun: true, opId: null, options: { sourceRunner: "agent" } }) }).ctx);
    expect(bad.some((i) => i.level === "block")).toBe(true);
  });
});

void answered;
