import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import type { RunSnapshot } from "../../core/run-contract";
import { DATA_CODES } from "./data-contract";
import { FreezeHandler, UNRESOLVED_CHECK, hostLoopFreeze, stopHostsOf } from "./freeze.handler";
import { HOST_LOOP_CODES } from "./inventory/host-codes";
import { FakeHostReports } from "./inventory/testing/fake-host-reports";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeSourceApi, answered, makeCtx, makeRun, makeSnap, type CtxHarness } from "./testing/fakes";

const RUN = "cmrun00000001";
const APPROVAL = { byUserId: "user1", at: "2026-11-20T09:59:00.000Z", boundHash: "f".repeat(64), acks: [], confirmedName: RUN, acceptDataRisk: false, expiresAt: null };
const id = (c: string) => c.repeat(64);

const loopRun = (o: Parameters<typeof makeRun>[0] = {}): RunSnapshot => makeRun({ ...o, options: { sourceRunner: "coolify-host-loop", ...(o.options ?? {}) }, inputs: { sourceController: answered("agent" as const) } });

function build(run: RunSnapshot = loopRun(), apps = [{ itemRef: "app:srv-a:uuaaaaaaaaaaaaaaaaaaaaaa", name: "web" }, { itemRef: "app:srv-b:uubbbbbbbbbbbbbbbbbbbbbb", name: "worker" }]) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(makeSnap({ apps, services: [] }));
  const reports = new FakeHostReports();
  const handler = new FreezeHandler(registry, data, new FakeSourceApi(), new SourceHostFake({ containers: [] }), new FakeCaps(), reports);
  handler.onModuleInit();
  const ctx = (o: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "FREEZE", run, steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" } }, approval: APPROVAL, ...o });
  const stopped = (ref: string) => reports.set(RUN, { stepKey: "FREEZE", sourceServerRef: ref, kind: "freeze", state: "stopped", payload: { recorded: [{ id: id("a"), name: "n", image: "i", ports: "", itemRef: `app:${ref}:x` }], stopped: { [id("a")]: "stopped" }, started: {}, unresolved: [], outcome: "done", errorCode: null, action: "freeze" } });
  return { handler, data, reports, ctx, stopped };
}

describe("FREEZE with the coolify-host-loop runner (host-loop controller)", () => {
  it("applies only to the agent controller of a host-loop run, and does not need the same-host topology", async () => {
    expect(hostLoopFreeze(loopRun())).toBe(true);
    expect(hostLoopFreeze(makeRun({ options: { sourceRunner: "coolify-host-loop" } }))).toBe(false); // manual controller: the operator stops by hand
    expect(hostLoopFreeze(makeRun({ inputs: { sourceController: answered("agent" as const) } }))).toBe(false); // operator runner
    const { handler, ctx } = build(); // two-box topology: the same-host agent controller would refuse it
    const h = ctx();
    expect(handler.preGate(h.ctx, await handler.observe(h.ctx)).checks.map((c) => c.id)).not.toContain("agent-same-host");
  });

  it("groups the stop list by the host that runs each item; an item with no known host cannot be placed", () => {
    const { byHost, unplaced } = stopHostsOf([
      { itemRef: "app:srv-a:u1", kind: "application", uuid: "u1", name: "a1" },
      { itemRef: "app:srv-a:u2", kind: "application", uuid: "u2", name: "a2" },
      { itemRef: "app:_:u3", kind: "application", uuid: "u3", name: "a3" },
    ]);
    expect([...byHost.keys()]).toEqual(["srv-a"]);
    expect(byHost.get("srv-a")).toHaveLength(2);
    expect(unplaced.map((u) => u.name)).toEqual(["a3"]);
  });

  it("opens the window, records only the controller, and waits for the host-loop script with the host counts", async () => {
    const { handler, ctx } = build();
    const h = ctx();
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: HOST_LOOP_CODES.freezeRun, offersCommand: true, commandKind: "host-loop", params: { hosts: 2, pending: 2, failing: 0, items: 2 } } });
    expect(h.patches.some((p) => p.freezeStartedAt)).toBe(true);
    expect(h.comp.freeze).toEqual({ controller: "host-loop", hosts: ["srv-a", "srv-b"] });
  });

  it("is quiesced only when EVERY host with stop items reported its recorded containers stopped (evidence: host-loop-reported)", async () => {
    const { handler, ctx, stopped } = build();
    stopped("srv-a");
    const h = ctx();
    let obs = await handler.observe(h.ctx);
    let gate = handler.postGate(h.ctx, obs);
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]).toMatchObject({ id: "source-quiesced", status: "unknown", params: { remaining: 1, controller: "host-loop" }, evidence: "host-loop-reported" });
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { params: { pending: 1 } } });
    stopped("srv-b");
    obs = await handler.observe(h.ctx);
    gate = handler.postGate(h.ctx, obs);
    expect(gate.passed).toBe(true);
    expect(gate.checks[0]).toMatchObject({ status: "pass", code: DATA_CODES.freezeQuiesced, evidence: "host-loop-reported" });
    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "done" });
  });

  it("a host whose stop failed (a mismatch or a failed docker stop) fails the gate with the host named", async () => {
    const { handler, ctx, stopped, reports } = build();
    stopped("srv-a");
    reports.set(RUN, { stepKey: "FREEZE", sourceServerRef: "srv-b", kind: "freeze", state: "stop-failed", payload: { recorded: [], stopped: { [id("b")]: "mismatch" }, started: {}, unresolved: [], outcome: "done", errorCode: null, action: "freeze" } });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const gate = handler.postGate(h.ctx, obs);
    expect(gate.passed).toBe(false);
    expect(gate.checks).toContainEqual(expect.objectContaining({ code: HOST_LOOP_CODES.freezeHostFailed, status: "fail", subject: "srv-b", params: { host: "srv-b", state: "stop-failed", code: "stop-failed" } }));
    expect(await handler.act(h.ctx, obs)).toMatchObject({ wait: { code: HOST_LOOP_CODES.freezeRun, params: { failing: 1, names: ["srv-b"] } } });
  });

  it("a stop-list item no container matched blocks until the operator attests it; the script is then minted with the guard lifted", async () => {
    const { handler, ctx, stopped, reports } = build();
    stopped("srv-a");
    reports.set(RUN, { stepKey: "FREEZE", sourceServerRef: "srv-b", kind: "freeze", state: "error", payload: { recorded: [], stopped: {}, started: {}, unresolved: ["app:srv-b:uubbbbbbbbbbbbbbbbbbbbbb"], outcome: "error", errorCode: "unresolved-items", action: "freeze" } });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { code: DATA_CODES.freezeContainerUnresolved, attest: [UNRESOLVED_CHECK], offersCommand: true, commandKind: "host-loop", params: { count: 1, of: 2, names: ["worker"] } } });
    expect(h.events.map((e) => e.code)).toContain(DATA_CODES.freezeContainerUnresolved);
    // an `unresolved-items` error is not a host failure: it is the operator's decision to make
    expect(handler.postGate(h.ctx, obs).checks.map((c) => c.code)).not.toContain(HOST_LOOP_CODES.freezeHostFailed);

    const accepted = ctx({ steps: { DATA_SEED: { status: "PASSED" }, DNS_PREPARE: { status: "SKIPPED" }, FREEZE: { evidence: { attestations: [{ checkId: UNRESOLVED_CHECK, byUserId: "user1", at: "2026-11-20T10:00:00.000Z" }], attachments: [] } } } });
    expect(await handler.act(accepted.ctx, await handler.observe(accepted.ctx))).toMatchObject({ wait: { code: HOST_LOOP_CODES.freezeRun } }); // now re-run the script

    // the re-run stopped it with the item accepted: quiesced, and the accepted item stays visible as an operator-attested warning
    reports.set(RUN, { stepKey: "FREEZE", sourceServerRef: "srv-b", kind: "freeze", state: "stopped", payload: { recorded: [{ id: id("b"), name: "n", image: "i", ports: "", itemRef: "app:srv-b:x" }], stopped: { [id("b")]: "stopped" }, started: {}, unresolved: ["app:srv-b:uubbbbbbbbbbbbbbbbbbbbbb"], outcome: "done", errorCode: null, action: "freeze" } });
    const gate = handler.postGate(accepted.ctx, await handler.observe(accepted.ctx));
    expect(gate.passed).toBe(true);
    expect(gate.checks).toContainEqual(expect.objectContaining({ id: "containers-unresolved", status: "warn", evidence: "operator-attested" }));
  });

  it("an item whose source host is unknown fails closed and the dry-run blocks it", async () => {
    const { handler, ctx } = build(loopRun(), [{ itemRef: "app:srv-a:uuaaaaaaaaaaaaaaaaaaaaaa", name: "web" }, { itemRef: "app:_:uuccccccccccccccccccccc", name: "mystery" }]);
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: HOST_LOOP_CODES.freezeNoHost, retryable: false, params: { count: 1, names: ["mystery"] } });
    expect(await handler.dryRun(h.ctx)).toEqual(expect.arrayContaining([expect.objectContaining({ code: HOST_LOOP_CODES.freezeNoHost, level: "block" }), expect.objectContaining({ code: HOST_LOOP_CODES.freezeDryPlan, params: { hosts: 1, items: 1 } })]));
  });

  it("nothing to stop is done at once", async () => {
    const { handler, ctx } = build(loopRun(), []);
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "done" });
  });

  it("abort names the hosts that still have recorded containers stopped (the operator runs the script with TUGRA_LOOP_ACTION=unfreeze)", async () => {
    const { handler, ctx, stopped, reports } = build();
    stopped("srv-a");
    stopped("srv-b");
    reports.set(RUN, { stepKey: "FREEZE", sourceServerRef: "srv-b", kind: "freeze", state: "restarted", payload: { recorded: [{ id: id("a"), name: "n", image: "i", ports: "", itemRef: "app:srv-b:x" }], stopped: {}, started: { [id("a")]: "started" }, unresolved: [], outcome: "done", errorCode: null, action: "unfreeze" } });
    const h = ctx({ steps: { FREEZE: { compensation: { freeze: { controller: "host-loop", hosts: ["srv-a", "srv-b"] } } } } });
    expect(await handler.compensate(h.ctx, "abort")).toEqual({ outcome: "manual", manual: [{ code: HOST_LOOP_CODES.freezeUnfreeze, params: { hosts: ["srv-a"], count: 1 } }] });
    reports.rows = reports.rows.filter((r) => r.sourceServerRef !== "srv-a");
    expect(await handler.compensate(h.ctx, "abort")).toEqual({ outcome: "nothing-to-do" });
    expect(await handler.compensate(ctx().ctx, "abort")).toEqual({ outcome: "nothing-to-do" }); // never froze
  });
});
