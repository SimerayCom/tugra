import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import type { RunSnapshot } from "../../core/run-contract";
import { DATA_CODES, type FreezeRecord } from "./data-contract";
import { FreezeHandler, STOP_CONFIRM_TIMEOUT_MS, UNRESOLVED_CHECK, buildStopList, controllerOf } from "./freeze.handler";
import { SourceHostFake, ctrId } from "./testing/source-host-fake";
import { estimateWindow, windowExtrasOf } from "./data-logic";
import { FakeCaps, FakeDataPort, FakeSourceApi, NOW, answered, inspected, makeCtx, makeRun, makeSnap, type CtxHarness } from "./testing/fakes";

const A = ctrId("a");
const B = ctrId("b");
const C = ctrId("c");
const D = ctrId("d");
const APPROVAL = { byUserId: "user1", at: "2026-11-20T09:59:00.000Z", boundHash: "f".repeat(64), acks: [], confirmedName: "cmrun00000001", acceptDataRisk: false, expiresAt: null };

const fleet = () => [
  { id: A, name: "abc-170000000000", image: "ghcr.io/x/web:1", ports: "0.0.0.0:80->80/tcp", running: true },
  { id: B, name: "def-170000000001", image: "ghcr.io/x/api:2", ports: "", running: true },
  { id: C, name: "unrelated", image: "postgres:16", ports: "", running: true },
  { id: D, name: "svc1-170000000002", image: "redis:7", ports: "", running: false }, // the service's container, already stopped
];

function build(run: RunSnapshot, host = new SourceHostFake({ containers: fleet() })) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(
    makeSnap({
      apps: [
        { itemRef: "app:s:abc", name: "web" },
        { itemRef: "app:s:def", name: "api" },
      ],
      services: [{ itemRef: "service:s:svc1", name: "cache" }],
    }),
  );
  const api = new FakeSourceApi();
  const caps = new FakeCaps();
  const handler = new FreezeHandler(registry, data, api, host, caps);
  handler.onModuleInit();
  const ctx = (o: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "FREEZE", run, steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" } }, ...o });
  return { registry, data, api, caps, host, handler, ctx };
}

const manualRun = (o: Parameters<typeof makeRun>[0] = {}) => makeRun(o);
const apiRun = (o: Parameters<typeof makeRun>[0] = {}) => makeRun({ ...o, inputs: { sourceController: answered("api" as const) } });
const agentRun = (o: Parameters<typeof makeRun>[0] = {}) => makeRun({ topology: "swap-proxy", ...o, inputs: { sourceController: answered("agent" as const) } });

describe("buildStopList / controllerOf", () => {
  it("lists apps and services with a coolify uuid, never databases, sorted", () => {
    const l = buildStopList({
      apps: [{ itemRef: "app:s:zzz", name: "z" }, { itemRef: "app:s:abc", name: null }, { itemRef: "weird", name: "w" }],
      services: [{ itemRef: "service:s:svc1", name: "cache" }],
    });
    expect(l.map((s) => [s.itemRef, s.kind, s.name])).toEqual([
      ["app:s:abc", "application", "abc"],
      ["app:s:zzz", "application", "z"],
      ["service:s:svc1", "service", "cache"],
    ]);
  });
  it("a physically copied database is stopped too (its files are only consistent when it is down); a logical one keeps running for its dump", () => {
    const l = buildStopList({
      apps: [{ itemRef: "app:s:abc", name: "web" }],
      services: [],
      databases: [
        { itemRef: "database:s:phys", name: "pg-phys", plane: "volume" },
        { itemRef: "database:s:logical", name: "pg-logical", plane: "logical" },
        { itemRef: "database:s:mongo", name: "m", plane: "unsupported" },
      ],
    });
    expect(l.map((s) => [s.itemRef, s.kind])).toEqual([["app:s:abc", "application"], ["database:s:phys", "database"]]);
  });
  it("the controller defaults to manual and treats `unknown` as the default", () => {
    expect(controllerOf(makeRun())).toBe("manual");
    expect(controllerOf(makeRun({ inputs: { sourceController: answered("unknown" as never) } }))).toBe("manual");
    expect(controllerOf(apiRun())).toBe("api");
  });
  it("registers as FREEZE (approval, UNDOABLE)", () => {
    expect(build(manualRun()).registry.require("FREEZE")).toMatchObject({ kind: "approval", rollback: "UNDOABLE" });
  });
});

describe("FREEZE approval binding and gates", () => {
  it("binds the approval to the controller, the stop list and the CURRENT estimate, and asks for the run id", async () => {
    const { handler, ctx, data } = build(manualRun());
    data.snap.volumes = [inspected("volume:s:a:data", 3 * 1024 ** 3)];
    const want = estimateWindow(data.snap, NOW, windowExtrasOf(manualRun(), data.snap)).freezeToFlipSec;
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const b = (await handler.approvalBinding(h.ctx, obs))!;
    expect(b).toMatchObject({ ponr: false, confirm: "run-id", ttlSec: null, requiresDataRisk: false, ackable: [], requiredAcks: [] });
    expect(b.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(b.review).toMatchObject({ controller: "manual", apps: 2, services: 1, stopList: ["web", "api", "cache"], estimateSec: want, keepsStopped: true });

    // different facts (a bigger volume) change what was reviewed, so the approval would be void
    data.snap.volumes = [inspected("volume:s:a:data", 30 * 1024 ** 3)];
    const h2 = ctx();
    expect((await handler.approvalBinding(h2.ctx, await handler.observe(h2.ctx)))!.inputHash).not.toBe(b.inputHash);
    // and a different controller does too
    const api = build(apiRun());
    api.data.snap.volumes = [inspected("volume:s:a:data", 3 * 1024 ** 3)];
    const h3 = api.ctx({ run: apiRun() });
    expect((await api.handler.approvalBinding(h3.ctx, await api.handler.observe(h3.ctx)))!.inputHash).not.toBe(b.inputHash);
  });

  it("waits for the DNS TTL (timer), unless the owner chose to skip it knowingly", async () => {
    const run = manualRun();
    const { handler, ctx } = build(run);
    const notBefore = new Date(NOW.getTime() + 3600_000);
    const h = ctx({ steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "PASSED", notBefore } } });
    const pre = handler.preGate(h.ctx, await handler.observe(h.ctx));
    expect(pre.passed).toBe(false);
    expect(pre.wait).toEqual({ kind: "timer", notBefore: notBefore.toISOString(), code: "freeze.ttl-wait" });

    const skip = makeRun({ options: { ttlPolicy: "skip-ack" } });
    const s = build(skip);
    const hs = s.ctx({ run: skip, steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "PASSED", notBefore } } });
    const ps = s.handler.preGate(hs.ctx, await s.handler.observe(hs.ctx));
    expect(ps.passed).toBe(true);
    expect(ps.checks[0]).toMatchObject({ status: "warn", code: "freeze.ttl-skipped" });

    h.clock.now = new Date(notBefore.getTime() + 1);
    expect(handler.preGate(h.ctx, await handler.observe(h.ctx)).passed).toBe(true);
  });

  it("swap-proxy has no DNS wait; a seed that did not pass blocks; an unprepared DNS blocks", async () => {
    const swap = manualRun({ topology: "swap-proxy" });
    const a = build(swap);
    const ha = a.ctx({ run: swap, steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "PENDING" } } });
    expect(a.handler.preGate(ha.ctx, await a.handler.observe(ha.ctx)).passed).toBe(true);
    const b = build(manualRun());
    const hb = b.ctx({ steps: { DATA_SEED: { status: "WAITING_OPERATOR" }, DNS_PREPARE: { status: "RUNNING" } } });
    const pb = b.handler.preGate(hb.ctx, await b.handler.observe(hb.ctx));
    expect(pb.passed).toBe(false);
    expect(pb.checks.map((c) => c.code).filter((c) => c !== "freeze.tick-gap-within").sort()).toEqual(["freeze.data-seed-not-passed", "freeze.dns-not-prepared"]);
  });

  it("an api controller that cannot be used, and an agent controller off the same host, block before anything happens", async () => {
    const a = build(apiRun());
    a.api.availability = { ok: false, reason: "session-expired" };
    const ha = a.ctx({ run: apiRun() });
    const pa = a.handler.preGate(ha.ctx, await a.handler.observe(ha.ctx));
    expect(pa.checks[0]).toMatchObject({ status: "fail", code: DATA_CODES.freezeApiUnavailable, params: { reason: "session-expired" }, ownerInput: "sourceController" });
    const run = agentRun({ topology: "two-box" });
    const b = build(run);
    const hb = b.ctx({ run });
    expect(b.handler.preGate(hb.ctx, await b.handler.observe(hb.ctx)).checks[0].code).toBe(DATA_CODES.agentNeedsSameHost);
  });
});

describe("FREEZE with the manual controller", () => {
  it("opens the window, prints the stop list and waits for the operator's attestation", async () => {
    const { handler, ctx } = build(manualRun());
    const h = ctx({ approval: APPROVAL });
    const obs = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false);
    const res = await handler.act(h.ctx, obs);
    expect(res).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: DATA_CODES.freezeManual, attest: ["source-quiesced"], params: { count: 3 } } });
    expect(h.patches[0]).toEqual({ freezeStartedAt: NOW });
    expect(h.patches[1]).toMatchObject({ windowEstimate: { estimatedAt: NOW.toISOString() } }); // the report compares the estimate with the measured window
    expect(h.comp.freeze).toEqual({ controller: "manual" });
    // still nothing attested: the step is not quiesced, whatever the world looks like
    const h2 = ctx({ approval: APPROVAL, steps: { FREEZE: { compensation: h.comp } } });
    expect(handler.postGate(h2.ctx, await handler.observe(h2.ctx)).passed).toBe(false);
  });

  it("an attestation completes the step, labelled operator-attested", async () => {
    const { handler, ctx } = build(manualRun());
    const att = { attestations: [{ checkId: "source-quiesced", byUserId: "user1", at: NOW.toISOString() }], attachments: [] };
    const h = ctx({ approval: APPROVAL, steps: { FREEZE: { compensation: { freeze: { controller: "manual" } }, evidence: att } } });
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    const g = handler.postGate(h.ctx, obs);
    expect(g.passed).toBe(true);
    expect(g.checks[0]).toMatchObject({ code: DATA_CODES.freezeQuiesced, evidence: "operator-attested" });
  });

  it("an attestation for another check does not count", async () => {
    const { handler, ctx } = build(manualRun());
    const h = ctx({ approval: APPROVAL, steps: { FREEZE: { compensation: { freeze: { controller: "manual" } }, evidence: { attestations: [{ checkId: "something-else", byUserId: "u", at: "x" }], attachments: [] } } } });
    expect(handler.postGate(h.ctx, await handler.observe(h.ctx)).passed).toBe(false);
  });

  it("with --stop-source the migrator freezes the writers itself: the step completes, labelled migrator-reported", async () => {
    const run = manualRun({ options: { stopSource: true } });
    const { handler, ctx } = build(run);
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "done" });
    const h2 = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: h.comp } } });
    const g = handler.postGate(h2.ctx, await handler.observe(h2.ctx));
    expect(g.passed).toBe(true);
    expect(g.checks[0].evidence).toBe("migrator-reported");
  });

  it("a scheduled freeze waits for its time (timer) and does not open the window early", async () => {
    const at = new Date(NOW.getTime() + 7200_000).toISOString();
    const run = manualRun({ options: { freezeAt: at } });
    const { handler, ctx } = build(run);
    const h = ctx({ run, approval: APPROVAL });
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toEqual({ outcome: "wait", wait: { kind: "timer", notBefore: at, code: DATA_CODES.freezeScheduled } });
    expect(h.patches).toEqual([]);
    expect(h.comp.freeze).toBeUndefined();
  });

  it("refuses to act without a validated approval", async () => {
    const { handler, ctx } = build(manualRun());
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: "freeze.approval-missing" });
    expect(h.patches).toEqual([]);
  });

  it("abort can only print what to restart (the hub never stopped anything)", async () => {
    const { handler, ctx } = build(manualRun());
    expect(await handler.compensate(ctx({ steps: { FREEZE: { compensation: { freeze: { controller: "manual" } } } } }).ctx, "abort")).toMatchObject({ outcome: "manual", manual: [{ code: DATA_CODES.freezeRestartManual }] });
    expect(await handler.compensate(ctx().ctx, "abort")).toEqual({ outcome: "nothing-to-do" });
    expect(await handler.compensate(ctx().ctx, "reverse")).toEqual({ outcome: "nothing-to-do" });
  });
});

describe("FREEZE with the api controller", () => {
  it("records what it is about to stop BEFORE the first stop, stops each resource, then verifies the state back from the API", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    const h = ctx({ run, approval: APPROVAL });
    let recordedAtFirstStop: unknown;
    const origStop = api.stop.bind(api);
    api.stop = async (...a: Parameters<typeof origStop>) => {
      recordedAtFirstStop ??= structuredClone(h.comp.freeze);
      return origStop(...a);
    };
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toEqual({ outcome: "continue", pollAfterMs: 5_000 });
    expect((recordedAtFirstStop as FreezeRecord).api!.map((i) => i.uuid)).toEqual(["abc", "def", "svc1"]);
    expect(api.calls.filter((c) => c.startsWith("stop:"))).toEqual(["stop:application:abc", "stop:application:def", "stop:service:svc1"]);
    expect(h.comp.stopRequestedAt).toBe(NOW.toISOString());

    // next tick: everything reads `stopped` from the API (hub-verified) -> the post gate passes
    const h2 = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: h.comp } } });
    const obs = await handler.observe(h2.ctx);
    expect(obs.states).toEqual({ total: 3, stopped: 3, running: 0, unknown: 0 });
    const g = handler.postGate(h2.ctx, obs);
    expect(g.passed).toBe(true);
    expect(g.checks[0].evidence).toBe("hub-verified");
    expect(await handler.act(h2.ctx, obs)).toEqual({ outcome: "done" });
    expect(api.calls.filter((c) => c.startsWith("stop:"))).toHaveLength(3); // not stopped twice
  });

  it("does not ask Coolify to stop what is already stopped", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    api.states.set("abc", "stopped");
    const h = ctx({ run, approval: APPROVAL });
    await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(api.calls.filter((c) => c.startsWith("stop:"))).toEqual(["stop:application:def", "stop:service:svc1"]);
  });

  it("a stop Coolify refuses fails with a fixed code; forbidden is not retryable (the token cannot write)", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    api.failStop.set("def", "forbidden");
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.freezeApiFailed, params: { reason: "forbidden", itemRef: "app:s:def" }, retryable: false });
    api.failStop.set("def", "unreachable");
    const h2 = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: h.comp } } });
    expect(await handler.act(h2.ctx, await handler.observe(h2.ctx))).toMatchObject({ outcome: "fail", retryable: true });
  });

  it("a stop Coolify rate-limits fails with the stable rate-limited reason and is retryable (the limit lifts on its own)", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    api.failStop.set("def", "rate-limited");
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.freezeApiFailed, params: { reason: "rate-limited", itemRef: "app:s:def" }, retryable: true });
  });

  it("a stop that is accepted but never takes effect fails after the confirmation window", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    api.stopsTakeEffect = false;
    const h = ctx({ run, approval: APPROVAL });
    await handler.act(h.ctx, await handler.observe(h.ctx));
    const later = new Date(NOW.getTime() + STOP_CONFIRM_TIMEOUT_MS + 1000);
    const h2 = ctx({ run, approval: APPROVAL, now: later, steps: { FREEZE: { compensation: h.comp } } });
    const obs = await handler.observe(h2.ctx);
    expect(handler.postGate(h2.ctx, obs).passed).toBe(false);
    expect(await handler.act(h2.ctx, obs)).toMatchObject({ outcome: "fail", code: DATA_CODES.freezeStillRunning, retryable: true });
    // within the window it keeps polling instead
    const h3 = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: h.comp } } });
    expect(await handler.act(h3.ctx, await handler.observe(h3.ctx))).toMatchObject({ outcome: "continue" });
  });

  it("an explicit retry after the confirmation window timed out sends the stops again instead of failing at once", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    api.stopsTakeEffect = false;
    const h = ctx({ run, approval: APPROVAL });
    await handler.act(h.ctx, await handler.observe(h.ctx));
    const later = new Date(NOW.getTime() + STOP_CONFIRM_TIMEOUT_MS + 1000);
    const h2 = ctx({ run, approval: APPROVAL, now: later, steps: { FREEZE: { compensation: h.comp } } });
    expect(await handler.act(h2.ctx, await handler.observe(h2.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.freezeStillRunning, retryable: true });

    api.stopsTakeEffect = true; // the resource that ignored the first stop obeys the second
    api.calls.length = 0;
    const h3 = ctx({ run, approval: APPROVAL, now: later, trigger: "retry", steps: { FREEZE: { compensation: h.comp } } });
    expect(await handler.act(h3.ctx, await handler.observe(h3.ctx))).toMatchObject({ outcome: "continue" });
    expect(api.calls.filter((c) => c.startsWith("stop:")).length).toBeGreaterThan(0);
    expect(h3.comp.stopRequestedAt).toBe(later.toISOString()); // a fresh window
    const h4 = ctx({ run, approval: APPROVAL, now: later, steps: { FREEZE: { compensation: h3.comp } } });
    expect(await handler.act(h4.ctx, await handler.observe(h4.ctx))).toEqual({ outcome: "done" });
  });

  it("a resource the owner had already stopped is never recorded, so an abort never starts it", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    api.states.set("def", "stopped"); // stopped on Coolify on purpose, before the freeze
    const h = ctx({ run, approval: APPROVAL });
    await handler.act(h.ctx, await handler.observe(h.ctx));
    const rec = h.comp.freeze as FreezeRecord;
    expect(rec.api!.map((a) => a.uuid).sort()).toEqual(["abc", "svc1"]);
    expect(api.calls).not.toContain("stop:application:def");
    api.calls.length = 0;
    expect(await handler.compensate(ctx({ steps: { FREEZE: { compensation: h.comp } } }).ctx, "abort")).toEqual({ outcome: "done" });
    expect(api.calls).toEqual(["start:application:abc", "start:service:svc1"]);
    expect(api.states.get("def")).toBe("stopped");
  });

  it("when every stop-list item was already stopped nothing is recorded to restart and the freeze completes", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    for (const u of ["abc", "def", "svc1"]) api.states.set(u, "stopped");
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "done" });
    expect(h.comp.freeze).toEqual({ controller: "api", api: [] });
    expect(api.calls.filter((c) => c.startsWith("stop:"))).toEqual([]);
  });

  it("with nothing to stop the freeze completes", async () => {
    const run = apiRun();
    const { handler, ctx, data } = build(run);
    data.snap.apps = [];
    data.snap.services = [];
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "done" });
    expect(h.comp.freeze).toEqual({ controller: "api", api: [] });
  });

  it("abort starts exactly what was recorded, and reports a failed restart", async () => {
    const run = apiRun();
    const { handler, ctx, api } = build(run);
    const rec: FreezeRecord = { controller: "api", api: [{ kind: "application", uuid: "abc", itemRef: "app:s:abc" }, { kind: "service", uuid: "svc1", itemRef: "service:s:svc1" }] };
    expect(await handler.compensate(ctx({ steps: { FREEZE: { compensation: { freeze: rec } } } }).ctx, "abort")).toEqual({ outcome: "done" });
    expect(api.calls).toEqual(["start:application:abc", "start:service:svc1"]);
    api.failStart.set("svc1", "unreachable");
    const res = await handler.compensate(ctx({ steps: { FREEZE: { compensation: { freeze: rec } } } }).ctx, "abort");
    expect(res).toMatchObject({ outcome: "failed", code: DATA_CODES.freezeRestartFailed, params: { count: 1, items: ["service:s:svc1"] } });
  });
});

describe("FREEZE with the agent controller (same host, against a fake source host)", () => {
  it("records the identity of the running containers first, stops exactly those, and verifies they are down through the agent", async () => {
    const run = agentRun();
    const { handler, ctx, host, caps } = build(run);
    host.setRunning(B, false); // already stopped before the run: it must never be started later
    const h = ctx({ run, approval: APPROVAL });
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    const rec = h.comp.freeze as FreezeRecord;
    expect(rec.controller).toBe("agent");
    expect(rec.containers!.map((c) => [c.id, c.name, c.image])).toEqual([[A, "abc-170000000000", "ghcr.io/x/web:1"]]);
    expect(host.container(A).running).toBe(false);
    expect(host.container(C).running).toBe(true); // unrelated container untouched
    expect(host.runs.every((r) => r.capability === "migrate")).toBe(true);
    expect(host.forbiddenCalls()).toEqual([]);
    expect(h.comp.capAdded).toBe(true);
    expect(caps.granted.has("migrate")).toBe(true); // kept until the flow ends (needed to verify / restart)

    const h2 = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: h.comp } } });
    const obs2 = await handler.observe(h2.ctx);
    expect(obs2.states).toEqual({ total: 1, stopped: 1, running: 0, unknown: 0 });
    expect(handler.postGate(h2.ctx, obs2).passed).toBe(true);
    host.dispose();
  });

  it("on a two-box run it stops the source's containers through the source host's own agent, never through the target", async () => {
    const run = agentRun({ topology: "two-box", options: { sourceRunner: "agent", sourceHostServers: { s: "srv-src" } } });
    const { handler, ctx, host } = build(run);
    const h = ctx({ run, approval: APPROVAL });
    const obs = await handler.observe(h.ctx);
    expect(handler.preGate(h.ctx, obs).checks.map((c) => c.id)).not.toContain("agent-same-host");
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    expect(host.container(A).running).toBe(false);
    expect(host.runs.length).toBeGreaterThan(0);
    expect(new Set(host.runs.map((r) => r.serverId))).toEqual(new Set(["srv-src"]));
    host.dispose();
  });

  it("on a two-box run with several source machines nothing is stopped and the multi-host code is returned", async () => {
    const run = agentRun({ topology: "two-box", options: { sourceRunner: "agent", sourceHostServers: { s: "srv-1", t: "srv-2" } } });
    const { handler, ctx, host } = build(run);
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.agentMultiSourceHost, retryable: false });
    expect(host.runs).toEqual([]);
    host.dispose();
  });

  it("after a crash between the record and the stop it re-stops the RECORDED containers without discovering again", async () => {
    const run = agentRun();
    const { handler, ctx, host } = build(run);
    const rec: FreezeRecord = { controller: "agent", containers: [{ id: A, name: "abc-170000000000", image: "ghcr.io/x/web:1", ports: "", itemRef: "app:s:abc" }] };
    const h = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: { freeze: rec } } } });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "done" });
    expect(host.runs.some((r) => r.script.includes("docker ps"))).toBe(false);
    expect(host.container(A).running).toBe(false);
    host.dispose();
  });

  it("a container whose identity changed is a `mismatch` failure and is not stopped", async () => {
    const run = agentRun();
    const { handler, ctx, host } = build(run);
    const rec: FreezeRecord = { controller: "agent", containers: [{ id: A, name: "abc-170000000000", image: "evil:latest", ports: "", itemRef: "app:s:abc" }] };
    const h = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: { freeze: rec } } } });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.freezeContainerMismatch });
    expect(host.container(A).running).toBe(true);
    host.dispose();
  });

  it("a stop that fails is reported with the container names and is retryable", async () => {
    const run = agentRun();
    const { handler, ctx, host } = build(run, new SourceHostFake({ containers: fleet(), failStop: [A] }));
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.freezeAgentFailed, params: { count: 1, names: ["abc-170000000000"] }, retryable: true });
    host.dispose();
  });

  it("a stop-list item no container matches fails closed: nothing is stopped or recorded until the operator accepts exactly that", async () => {
    const run = agentRun();
    const { handler, ctx, host } = build(run, new SourceHostFake({ containers: fleet().filter((c) => c.id !== D) })); // the service has no container under a known name
    const h = ctx({ run, approval: APPROVAL });
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: DATA_CODES.freezeContainerUnresolved, params: { count: 1, of: 3, names: ["cache"] }, attest: [UNRESOLVED_CHECK] } });
    expect(h.comp.freeze).toBeUndefined();
    expect(host.container(A).running).toBe(true);
    expect(host.runs.some((r) => r.script.includes("docker stop"))).toBe(false);

    // the operator looked at the host and accepts it: the rest is stopped, and the evidence is downgraded and says so
    const ha = ctx({ run, approval: APPROVAL, steps: { FREEZE: { evidence: { attestations: [{ checkId: UNRESOLVED_CHECK, byUserId: "user1", at: "x" }], attachments: [] } } } });
    expect(await handler.act(ha.ctx, await handler.observe(ha.ctx))).toEqual({ outcome: "done" });
    expect((ha.comp.freeze as FreezeRecord).unresolved).toEqual(["cache"]);
    expect(host.container(A).running).toBe(false);
    const hb = ctx({ run, approval: APPROVAL, steps: { FREEZE: { compensation: ha.comp } } });
    const g = handler.postGate(hb.ctx, await handler.observe(hb.ctx));
    expect(g.passed).toBe(true);
    expect(g.checks.find((c) => c.id === "source-quiesced")).toMatchObject({ status: "pass", evidence: "operator-attested" });
    expect(g.checks.find((c) => c.id === "containers-unresolved")).toMatchObject({ status: "warn", params: { count: 1, names: ["cache"] } });
    host.dispose();
  });

  it("a stop list that resolves to no container at all does not pass as quiesced", async () => {
    const run = agentRun();
    const { handler, ctx, host } = build(run, new SourceHostFake({ containers: [{ id: C, name: "unrelated", image: "postgres:16", ports: "", running: true }] }));
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.freezeContainerUnresolved, params: { count: 3, of: 3 } } });
    expect(h.comp.freeze).toBeUndefined();
    host.dispose();
  });

  it("refuses when the owner may not grant the capability; nothing is discovered or stopped", async () => {
    const run = agentRun();
    const { handler, ctx, host, caps } = build(run);
    caps.deny = true;
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.capabilityDenied, retryable: false });
    expect(host.runs).toEqual([]);
    host.dispose();
  });

  it("abort starts exactly the recorded containers, ends the capability it added, and never starts an impostor", async () => {
    const run = agentRun();
    const { handler, ctx, host, caps } = build(run);
    const h = ctx({ run, approval: APPROVAL });
    await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(host.container(A).running).toBe(false);

    const hc = ctx({ run, steps: { FREEZE: { compensation: h.comp } } });
    expect(await handler.compensate(hc.ctx, "abort")).toEqual({ outcome: "done" });
    expect(host.container(A).running).toBe(true);
    expect(caps.granted.has("migrate")).toBe(false); // least privilege: the grant ends with the restart
    expect(host.forbiddenCalls()).toEqual([]);

    // a recreated container with the same name: reported for the operator, not started
    await host.run("srv", "docker stop " + A, "migrate", 10_000);
    host.recreate(A, ctrId("e"));
    const res = await handler.compensate(hc.ctx, "abort");
    expect(res).toMatchObject({ outcome: "manual", manual: [{ code: DATA_CODES.freezeRestartManual, params: { controller: "agent", names: ["abc-170000000000"] } }] });
    expect(host.container(ctrId("e")).running).toBe(false);
    host.dispose();
  });

  it("an agent that is offline is a fixed, retryable failure", async () => {
    const run = agentRun();
    const { handler, ctx, host } = build(run);
    host.run = async () => {
      class AgentOfflineException extends Error {}
      throw new AgentOfflineException("agent is offline");
    };
    const h = ctx({ run, approval: APPROVAL });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: DATA_CODES.agentOffline, retryable: true });
    host.dispose();
  });
});

describe("FREEZE of an app with a custom container name prefix", () => {
  const UUID = "x8kc0sw4cw0c0ooc0o4gg0ck";
  const E = ctrId("e");
  const prefixed = () => [
    { id: A, name: "shop-20261110T153012", image: "ghcr.io/x/web:1", ports: "", running: true }, // <prefix>-<timestamp>, NOT <uuid>-<timestamp>
    { id: B, name: "shopx-20261110T153012", image: "ghcr.io/x/other:1", ports: "", running: true }, // another app whose name merely starts the same
    { id: C, name: "shop-pr-3", image: "ghcr.io/x/web:1", ports: "", running: true }, // a preview
    { id: E, name: "unrelated", image: "postgres:16", ports: "", running: true },
  ];
  const buildPrefixed = (containerPrefix: string | undefined) => {
    const registry = new StepHandlerRegistryService();
    const host = new SourceHostFake({ containers: prefixed() });
    const data = new FakeDataPort(makeSnap({ apps: [{ itemRef: `app:s:${UUID}`, name: "web", ...(containerPrefix ? { containerPrefix } : {}) }], services: [] }));
    const handler = new FreezeHandler(registry, data, new FakeSourceApi(), host, new FakeCaps());
    handler.onModuleInit();
    return { handler, host };
  };
  const ctxOf = (run: RunSnapshot) => makeCtx({ key: "FREEZE", run, approval: APPROVAL, steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" } } });

  it("the stop list carries the prefix", () => {
    expect(buildStopList({ apps: [{ itemRef: `app:s:${UUID}`, name: "web", containerPrefix: "shop" }, { itemRef: "app:s:abc", name: "w" }], services: [] }).map((s) => [s.itemRef, s.containerPrefix])).toEqual([
      ["app:s:abc", undefined],
      [`app:s:${UUID}`, "shop"],
    ]);
  });

  it("the agent controller discovers, records and stops exactly the <prefix>-<timestamp> container", async () => {
    const run = agentRun();
    const { handler, host } = buildPrefixed("shop");
    const h = ctxOf(run);
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
    const rec = h.comp.freeze as FreezeRecord;
    expect(rec.containers!.map((c) => [c.id, c.name])).toEqual([[A, "shop-20261110T153012"]]);
    expect(host.container(A).running).toBe(false);
    for (const id of [B, C, E]) expect(host.container(id).running).toBe(true); // look-alikes and unrelated containers untouched
    expect(host.forbiddenCalls()).toEqual([]);
    host.dispose();
  });

  it("without the prefix the same host leaves the app unresolved: fail closed, nothing stopped (what the freeze did before)", async () => {
    const run = agentRun();
    const { handler, host } = buildPrefixed(undefined);
    const h = ctxOf(run);
    const obs = await handler.observe(h.ctx);
    const res = await handler.act(h.ctx, obs);
    expect(res).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.freezeContainerUnresolved } });
    expect(host.container(A).running).toBe(true);
    host.dispose();
  });
});

describe("FREEZE.dryRun", () => {
  it("projects the plan and the stop list without touching the source", async () => {
    const { handler, ctx, api, host } = build(apiRun());
    const items = await handler.dryRun(ctx({ run: apiRun({ dryRun: true }) }).ctx);
    expect(items[0]).toMatchObject({ code: "freeze.dry.plan", params: { controller: "api" } });
    expect(items[1]).toMatchObject({ code: DATA_CODES.freezeStopList, level: "info", params: { count: 3 } });
    expect(api.calls).toEqual([]);
    expect(host.runs).toEqual([]);
    const noOp = await handler.dryRun(ctx({ run: agentRun({ dryRun: true, opId: null, topology: "two-box" }) }).ctx);
    expect(noOp.some((i) => i.level === "block")).toBe(true);
    host.dispose();
  });
});
