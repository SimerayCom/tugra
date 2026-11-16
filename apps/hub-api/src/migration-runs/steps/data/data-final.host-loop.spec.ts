import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import type { RunSnapshot } from "../../core/run-contract";
import { DATA_CODES, SOURCE_STATS_CHECK } from "./data-contract";
import { DataFinalHandler } from "./data-final.handler";
import { FINAL_HOST_LOOP_CODES, finalHostChecks, finalHostTally } from "./data-logic";
import { HOST_LOOP_CODES } from "./inventory/host-codes";
import { decodeHostReports } from "./inventory/host-view";
import { FakeHostReports } from "./inventory/testing/fake-host-reports";
import { MemoryCheckStore } from "./verify/check-store";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeObjectPort, copied, database, inspected, makeCtx, makeRun, makeSnap, volume, type CtxHarness } from "./testing/fakes";

const RUN = "cmrun00000001";
const FROZEN = { DATA_SEED: { status: "PASSED" as const }, FREEZE: { status: "PASSED" as const } };

const loopRun = (over: Parameters<typeof makeRun>[0] = {}): RunSnapshot => makeRun({ ...over, options: { sourceRunner: "coolify-host-loop", ...(over.options ?? {}) }, serverMap: { "host-a": "tgt-1", "host-b": "tgt-2", "host-c": "tgt-3" } });

/** Three source hosts, each with data to move: a database on host-a, a volume on host-b and host-c. */
const threeHosts = () =>
  makeSnap({
    tokenActive: true,
    apps: [],
    databases: [database("database:host-a:dbaaaaaaaaaaaaaaaaaaaaaa", { task: "none" })],
    volumes: [inspected("volume:host-b:appbbbbbbbbbbbbbbbbbbbbb:data"), inspected("volume:host-c:appccccccccccccccccccccc:data")],
  });

function build(run: RunSnapshot = loopRun()) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(threeHosts());
  const host = new SourceHostFake({ containers: [] });
  const reports = new FakeHostReports();
  const checks = new MemoryCheckStore();
  const handler = new DataFinalHandler(registry, data, new FakeObjectPort(), new FakeCaps(), new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs")), checks, reports);
  handler.onModuleInit();
  const ctx = (o: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "DATA_FINAL", run, ...o, steps: { ...FROZEN, ...(o.steps ?? {}) } });
  const loop = (ref: string, state: string, rc: number | null = null, code = "ok", step = "DATA_FINAL") => reports.set(RUN, { stepKey: step, sourceServerRef: ref, kind: "loop", state, payload: { code, rc } });
  return { handler, data, reports, ctx, loop, host, checks };
}

describe("DATA_FINAL with the coolify-host-loop runner (R32-FINAL)", () => {
  it("waits on the host-loop script (commandKind host-loop), not on the single-host migrator, and records the hosts BEFORE the operator can run it", async () => {
    const { handler, ctx, host } = build();
    const h = ctx();
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({
      outcome: "wait",
      wait: { kind: "operator", code: FINAL_HOST_LOOP_CODES.run, offersCommand: true, commandKind: "host-loop", params: { phase: "final", hosts: 3, failing: 0, finished: 0, names: [] } },
    });
    expect((res as { wait: { code: string } }).wait.code).not.toBe(DATA_CODES.runMigrator);
    expect(h.comp.loopHosts).toEqual(["host-a", "host-b", "host-c"]); // an abort needs them
    host.dispose();
  });

  it("one dead host is a clear failure that NAMES the host, and the hosts that finished are reported next to it", async () => {
    const { handler, ctx, loop, data, host } = build();
    data.snap.volumes = [inspected("volume:host-b:appbbbbbbbbbbbbbbbbbbbbb:data"), copied("volume:host-c:appccccccccccccccccccccc:data")];
    loop("host-a", "unreachable", null, "ssh-timeout");
    loop("host-b", "running");
    loop("host-c", "finished", 0);
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toMatchObject({
      outcome: "wait",
      wait: { code: FINAL_HOST_LOOP_CODES.hostFailed, commandKind: "host-loop", offersCommand: true, params: { failing: 1, names: ["host-a"], finished: 1, finishedNames: ["host-c"], hosts: 3 } },
    });
    const post = handler.postGate(h.ctx, obs);
    expect(post.passed).toBe(false);
    expect(post.checks).toContainEqual(expect.objectContaining({ status: "fail", code: HOST_LOOP_CODES.hostFailed, subject: "host-a", evidence: "host-loop-reported", params: { host: "host-a", state: "unreachable", code: "ssh-timeout" } }));
    expect(post.checks).toContainEqual(expect.objectContaining({ status: "pass", code: HOST_LOOP_CODES.hostOk, subject: "host-c" }));
    expect(post.checks).toContainEqual(expect.objectContaining({ status: "unknown", code: HOST_LOOP_CODES.hostPending, subject: "host-b" }));
    host.dispose();
  });

  it("a finished migrator with a failing exit code and a migrator that died are dead hosts too", async () => {
    const { handler, ctx, loop, host } = build();
    loop("host-a", "finished", 2, "migrator-exit");
    loop("host-b", "died", null, "vanished");
    const h = ctx();
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "wait", wait: { code: FINAL_HOST_LOOP_CODES.hostFailed, params: { failing: 2, names: ["host-a", "host-b"] } } });
    host.dispose();
  });

  it("a DATA_SEED report of a host is not a DATA_FINAL report: the final pass has its own status per host", async () => {
    const { handler, ctx, loop, host } = build();
    loop("host-a", "unreachable", null, "ssh-timeout", "DATA_SEED");
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).checks.map((c) => c.code)).not.toContain(HOST_LOOP_CODES.hostFailed);
    expect(await handler.act(h.ctx, obs)).toMatchObject({ wait: { code: FINAL_HOST_LOOP_CODES.run, params: { failing: 0 } } });
    host.dispose();
  });

  it("a later report of the script overwrites the dead state: the host is no longer named once it finished, and the step wraps up when all the data is in", async () => {
    const { handler, ctx, loop, data, host, checks } = build();
    loop("host-a", "unreachable", null, "ssh-timeout");
    loop("host-a", "finished", 0);
    loop("host-b", "finished", 0);
    loop("host-c", "finished", 0);
    data.snap = makeSnap({ tokenActive: true, apps: [], databases: [database("database:host-a:dbaaaaaaaaaaaaaaaaaaaaaa", { task: "done", finishedAt: NOW_ISO })], volumes: [copied("volume:host-b:appbbbbbbbbbbbbbbbbbbbbb:data"), copied("volume:host-c:appccccccccccccccccccccc:data")] });
    // the migrator's source-side report of the database has reached the hub (the step holds the wrap-up for it)
    await checks.upsert({ runId: RUN, stepKey: "VERIFY", checkId: SOURCE_STATS_CHECK, subject: "database:host-a:dbaaaaaaaaaaaaaaaaaaaaaa", status: "unknown", evidenceKind: "migrator-reported", evidence: {}, at: new Date(NOW_ISO) });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).checks.every((c) => c.status !== "fail")).toBe(true);
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "done" });
    expect(data.revoked).toBe(1);
    host.dispose();
  });

  it("a plan that names no source host cannot loop: the step fails with a fixed code and the dry-run blocks", async () => {
    const { handler, ctx, data, host } = build(makeRun({ options: { sourceRunner: "coolify-host-loop" } }));
    data.snap = makeSnap({ tokenActive: true, apps: [], volumes: [inspected("volume:_:appbbbbbbbbbbbbbbbbbbbbb:data")] });
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: HOST_LOOP_CODES.noHosts, retryable: false });
    expect(await handler.dryRun(h.ctx)).toContainEqual(expect.objectContaining({ code: HOST_LOOP_CODES.noHosts, level: "block" }));
    host.dispose();
  });

  it("the dry-run shows the loop plan", async () => {
    const { handler, ctx, host } = build();
    const h = ctx();
    expect(await handler.dryRun(h.ctx)).toContainEqual(expect.objectContaining({ code: FINAL_HOST_LOOP_CODES.dryPlan, level: "info", params: expect.objectContaining({ hosts: 3 }) }));
    host.dispose();
  });

  it("abort names the hosts that may still run the final copy, revokes the token, and keeps the stop-source reminder", async () => {
    const { handler, ctx, loop, data, host } = build(loopRun({ options: { stopSource: true } }));
    loop("host-a", "running");
    loop("host-b", "finished", 0);
    const offered = { steps: { DATA_FINAL: { compensation: { loopHosts: ["host-a", "host-b", "host-c"] } } } };
    const res = await handler.compensate(ctx(offered).ctx, "abort");
    expect(res).toEqual({ outcome: "manual", manual: [{ code: FINAL_HOST_LOOP_CODES.stopMigrators, params: { hosts: ["host-a", "host-c"], count: 2 } }, { code: DATA_CODES.finalStopSourceManual }] });
    expect(data.revoked).toBe(1);
    host.dispose();
  });

  it("abort of a run whose script was never offered has nothing to name", async () => {
    const { handler, ctx, host } = build();
    expect(await handler.compensate(ctx().ctx, "abort")).toEqual({ outcome: "done" });
    host.dispose();
  });

  it("the operator runner is unchanged: the single-host migrator wait, no command kind", async () => {
    const { handler, ctx, host } = build(makeRun());
    const h = ctx();
    const res = (await handler.act(h.ctx, await handler.observe(h.ctx))) as { wait: { code: string; commandKind?: string } };
    expect(res.wait.code).toBe(DATA_CODES.runMigrator);
    expect(res.wait.commandKind).toBeUndefined();
    host.dispose();
  });
});

const NOW_ISO = "2026-11-20T10:00:00.000Z";

describe("finalHostTally / finalHostChecks", () => {
  const snap = threeHosts();
  const view = (rows: Array<[string, string, number | null]>) =>
    decodeHostReports(rows.map(([ref, state, rc], i) => ({ id: `r${i}`, runId: RUN, stepKey: "DATA_FINAL", sourceServerRef: ref, kind: "loop" as const, state, payload: { code: "x", rc }, reportedAt: new Date(NOW_ISO) })));

  it("splits the hosts that hold data into finished, failed and still pending (a host without data is not a host of the pass)", () => {
    const v = view([["host-a", "failed", null], ["host-b", "finished", 0]]);
    expect(finalHostTally(["host-a", "host-b", "host-c", "host-z"], snap, v)).toEqual({ hosts: ["host-a", "host-b", "host-c"], ok: ["host-b"], failed: ["host-a"], pending: ["host-c"] });
  });

  it("a host that never reported has no check of its own (its data checks speak), the others one each", () => {
    const v = view([["host-a", "failed", null]]);
    expect(finalHostChecks(["host-a", "host-b"], snap, v).map((c) => [c.subject, c.status])).toEqual([["host-a", "fail"]]);
    expect(volume("v").itemRef).toBe("v");
  });
});
