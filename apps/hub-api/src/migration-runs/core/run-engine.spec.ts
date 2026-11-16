import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, SERVER, type StubScript } from "./testing/run-world";
import { makeGate, type StepKey } from "./run-contract";
import type { ApprovalBinding } from "./dto";

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const H64 = (c: string) => c.repeat(64);
const ponrBinding = (hash = H64("a")): ApprovalBinding => ({ inputHash: hash, ponr: true, confirm: "target-server", ttlSec: 1800, requiresDataRisk: true, ackable: [], requiredAcks: [], review: { hosts: 2 } });

/** The flips/restores a stand-in CUTOVER performed (the other stand-ins' acts are noise for the PONR specs). */
const flips = (w: RunWorld): string[] => w.effects.filter((e) => e === "flip" || e === "flip-before-ponr" || e === "dns-restore");

/** A world whose FREEZE freezes a fake source (restarted by abort) and whose CUTOVER flips behind a PONR approval on VERIFY. */
function cutoverWorld(extra: Partial<Record<StepKey, StubScript>> = {}) {
  const src = { running: true };
  let hash = H64("a");
  const w = new RunWorld({
    stubs: {
      FREEZE: {
        act: async (world, ctx) => {
          await ctx.recordCompensation({ frozen: true });
          src.running = false;
          world.done.add("FREEZE");
          return { outcome: "done" };
        },
        compensate: async (_w, ctx, how) => {
          if (how !== "abort") return { outcome: "nothing-to-do" };
          if (ctx.step.compensation?.frozen === true) src.running = true;
          return { outcome: "done" };
        },
      },
      VERIFY: { binding: () => ponrBinding(hash) },
      CUTOVER: {
        act: async (world, ctx) => {
          await ctx.markPonr();
          // the engine's crash invariant: ponrAt is persisted BEFORE the first flip
          world.effects.push(world.store.row(ctx.run.id).ponrAt ? "flip" : "flip-before-ponr");
          world.done.add("CUTOVER");
          return { outcome: "done" };
        },
        compensate: async (world, _ctx, how) => {
          if (how === "reverse") {
            world.effects.push("dns-restore");
            return { outcome: "done" };
          }
          return { outcome: "nothing-to-do" };
        },
      },
      ...extra,
    },
  });
  return { w, src, setHash: (h: string) => (hash = h) };
}

describe("RunEngine: the happy path", () => {
  it("drives all 13 steps to COMPLETED, releases the server and the lease, writes the report", async () => {
    const w = new RunWorld();
    const id = await w.create();
    expect(w.store.row(id).activeKey).toBe(`srv:${SERVER}`);
    await w.start(id);
    await w.settle(id);
    const v = await w.view(id);
    expect(v.status).toBe("COMPLETED");
    expect(v.steps.filter((s) => s.key !== "DECOMMISSION").every((s) => s.status === "PASSED")).toBe(true);
    const row = w.store.row(id);
    expect(row.activeKey).toBeNull();
    expect(row.ownerId).toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect((row.report as { runId?: string }).runId).toBe(id);
    expect(w.store.codes(id)).toEqual(expect.arrayContaining(["run.created", "run.started", "step.entered", "step.passed", "run.completed"]));
    // exactly one apply, one remap, one deploy per app
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(1);
    expect(w.port.calls.filter((c) => c.startsWith("remapApply"))).toHaveLength(1);
    expect(w.port.calls.filter((c) => c.startsWith("deploy:"))).toHaveLength(2);
    expect(w.sink.notes.map((n) => n.kind)).toContain("completed");
  });

  it("events carry strictly increasing sequence numbers", async () => {
    const w = new RunWorld();
    const id = await w.run();
    const seqs = w.store.eventRows.filter((e) => e.runId === id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(w.store.row(id).eventSeq).toBe(seqs.length);
  });

  it("a second real run on the same target server is refused while the first is live, allowed once it is done", async () => {
    const w = new RunWorld();
    const a = await w.create();
    await expect(w.create()).rejects.toThrow(/server-has-live-run/);
    await w.start(a);
    await w.settle(a);
    await expect(w.create()).resolves.toBeDefined();
  });
});

describe("RunEngine: dry-run writes nothing outside its own rows", () => {
  it("projects every step, ends DRY_RUN_DONE, never acts and never holds the server", async () => {
    const w = new RunWorld();
    const id = await w.create({ dryRun: true });
    expect(w.store.row(id).activeKey).toBeNull();
    await w.settle(id);
    const v = await w.view(id);
    expect(v.status).toBe("DRY_RUN_DONE");
    expect(v.steps.filter((s) => s.key !== "DECOMMISSION").every((s) => s.status === "PASSED" && s.progress?.dryRun !== undefined)).toBe(true);
    expect(w.port.calls).toEqual([]); // not one mutating call on the importer/apps/dbs
    expect(w.effects).toEqual([]);
    expect(w.compensations).toEqual([]);
    expect(w.dryRuns).toHaveLength(9); // every stand-in step was only projected
    expect(w.store.row(id).ownerId).toBeNull();
    // a real run may start on the same server meanwhile
    await expect(w.create()).resolves.toBeDefined();
  });

  it("a dry-run of a fleet with problems reports them as blocking items without failing", async () => {
    const w = new RunWorld();
    w.port.target_.agentOnline = false;
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    const pre = (await w.view(id)).steps.find((s) => s.key === "PREFLIGHT")!;
    expect(pre.progress?.dryRun?.some((i) => i.code === "preflight.agent-offline" && i.level === "block")).toBe(true);
    expect(pre.gate?.passed).toBe(false);
    expect(await w.view(id)).toMatchObject({ status: "DRY_RUN_DONE" });
  });

  it("a dry-run is promoted into a NEW real run with the same frozen inputs", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true, inputs: { allowBind: true } });
    await w.settle(d);
    const promoted = await w.service.start(ACTOR, d, {});
    expect(promoted.id).not.toBe(d);
    expect(promoted.promotedFromId).toBe(d);
    expect(promoted.dryRun).toBe(false);
    expect(promoted.inputs.allowBind?.value).toBe(true);
    expect(w.store.codes(promoted.id)).toContain("run.promoted");
    await w.settle(promoted.id);
    expect(w.status(promoted.id)).toBe("COMPLETED");
    expect(w.status(d)).toBe("DRY_RUN_DONE");
  });
});

describe("RunEngine: parking and re-observing", () => {
  it("parks on a blocked gate (agent offline), then resumes by itself when the world is fixed", async () => {
    const w = new RunWorld();
    w.port.target_.agentOnline = false;
    const id = await w.run();
    expect(w.status(id)).toBe("WAITING");
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_OPERATOR");
    const v = await w.view(id);
    expect(v.nextAction).toMatchObject({ kind: "gate", stepKey: "PREFLIGHT", code: "preflight.blocked" });
    expect(v.steps[0].gate?.checks.find((c) => c.code === "preflight.agent-offline")?.status).toBe("fail");
    const waiting = w.store.codes(id).filter((c) => c === "step.waiting");
    await w.tick(3); // the periodic loop re-observes; nothing changed, so no new event
    expect(w.store.codes(id).filter((c) => c === "step.waiting")).toEqual(waiting);
    w.port.target_.agentOnline = true;
    w.clock.advance(120_000); // past the rate-limiter memo of parked ticks
    await w.tick();
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a timer wait wakes once notBefore passed and not before", async () => {
    let open = false;
    const w = new RunWorld({
      stubs: {
        DNS_PREPARE: {
          act: async (world, ctx) => {
            if (!open) return { outcome: "wait", wait: { kind: "timer", notBefore: new Date(ctx.now().getTime() + 3_600_000).toISOString(), code: "dns.ttl-wait" } };
            world.done.add("DNS_PREPARE");
            return { outcome: "done" };
          },
        },
      },
    });
    const id = await w.run();
    expect(w.stepStatus(id, "DNS_PREPARE")).toBe("WAITING_TIMER");
    expect((await w.view(id)).nextAction).toMatchObject({ kind: "timer", code: "dns.ttl-wait" });
    await w.tick(2);
    expect(w.stepStatus(id, "DNS_PREPARE")).toBe("WAITING_TIMER");
    w.clock.advance(3_700_000);
    open = true;
    await w.tick();
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("an operator step is only re-observed on a tick: its act is not re-entered until retry/evidence/attach/approve", async () => {
    let acts = 0;
    const w = new RunWorld({
      stubs: {
        DATA_FINAL: {
          act: async (world) => {
            acts += 1;
            if (!world.done.has("DATA_FINAL.ready")) return { outcome: "wait", wait: { kind: "operator", code: "data.run-migrator", offersCommand: true } };
            world.done.add("DATA_FINAL");
            return { outcome: "done" };
          },
        },
      },
    });
    const id = await w.run();
    expect(w.stepStatus(id, "DATA_FINAL")).toBe("WAITING_OPERATOR");
    expect(acts).toBe(1);
    await w.tick(4);
    expect(acts).toBe(1); // ticks only observe
    w.done.add("DATA_FINAL.ready");
    await w.service.retry(ACTOR, id, "DATA_FINAL", {});
    await w.settle(id, "retry");
    expect(acts).toBe(2);
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("an `continue` act is polled (clamped) until its post-gate passes", async () => {
    let n = 0;
    const w = new RunWorld({
      stubs: {
        DATA_SEED: {
          act: async (world) => {
            n += 1;
            if (n < 4) return { outcome: "continue", pollAfterMs: 10 };
            world.done.add("DATA_SEED");
            return { outcome: "done" };
          },
        },
      },
    });
    const id = await w.run();
    expect(n).toBe(4);
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.clock.sleeps).toBeGreaterThanOrEqual(3);
  });

  it("a step whose applicable() is false is SKIPPED with a code", async () => {
    const w = new RunWorld({ stubs: { DNS_PREPARE: { applicable: (r) => r.topology !== "swap-proxy" } } });
    const id = await w.run({ topology: "swap-proxy" });
    const v = await w.view(id);
    expect(v.steps.find((s) => s.key === "DNS_PREPARE")).toMatchObject({ status: "SKIPPED", skippedCode: "step.not-applicable" });
    expect(v.status).toBe("COMPLETED");
  });
});

describe("RunEngine: pause, resume and lost authorization", () => {
  it("pause stops forward progress at the next boundary, resume continues", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    expect(w.status(id)).toBe("WAITING");
    await w.service.pause(ACTOR, id);
    await w.settle(id);
    expect(w.status(id)).toBe("PAUSED");
    expect(w.store.codes(id)).toContain("run.paused");
    w.done.add("go");
    await w.tick(2);
    expect(w.status(id)).toBe("PAUSED"); // paused: the scheduler does not touch it
    await w.service.resume(ACTOR, id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("an actor who lost apps:config pauses the run with run.auth-lost and nothing further happens", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    w.env.perms[`u1|t1`] = { member: true, appsConfig: false, databases: true };
    w.done.add("go");
    const before = w.port.calls.length;
    await w.tick();
    expect(w.status(id)).toBe("PAUSED");
    expect(w.store.codes(id)).toContain("run.auth-lost");
    expect(w.sink.notes.map((n) => n.kind)).toContain("auth-lost");
    expect(w.port.calls.length).toBe(before);
    w.env.perms[`u1|t1`] = { member: true, appsConfig: true, databases: true };
    await w.service.resume(ACTOR, id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
  });
});

describe("RunEngine: abort before the point of no return", () => {
  it("compensates in REVERSE step order and leaves the (fake) source running", async () => {
    const { w, src } = cutoverWorld({ VERIFY: { binding: () => ponrBinding() } });
    const id = await w.run();
    expect(w.stepStatus(id, "VERIFY")).toBe("WAITING_APPROVAL");
    expect(src.running).toBe(false); // FREEZE has frozen it
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(src.running).toBe(true);
    expect(w.store.row(id).activeKey).toBeNull();
    expect(w.store.row(id).ponrAt).toBeNull();
    expect(w.port.calls).toEqual(expect.arrayContaining(["cancel:op-1"]));
    const abortOrder = w.compensations.filter((c) => c.endsWith(":abort")).map((c) => c.split(":")[0]);
    const idx = (k: string) => abortOrder.indexOf(k);
    expect(idx("FREEZE")).toBeLessThan(idx("DATA_SEED"));
    expect(w.port.calls.some((c) => c.startsWith("stopApp")) && w.port.calls.some((c) => c.startsWith("stopDb"))).toBe(true);
    expect(w.port.calls.some((c) => c.startsWith("remapUndo"))).toBe(true);
    expect(w.stepStatus(id, "FREEZE")).toBe("COMPENSATED");
    expect(w.store.codes(id)).toEqual(expect.arrayContaining(["run.abort.requested", "run.aborted"]));
    // nothing was ever deleted
    expect(w.port.calls.some((c) => c.startsWith("rollback"))).toBe(false);
  });

  it("abort needs the typed run id and is refused for an unknown/foreign run", async () => {
    const { w } = cutoverWorld();
    const id = await w.run();
    await expect(w.service.abort(ACTOR, id, { confirmName: "nope" })).rejects.toThrow(/bad-confirmation/);
    await expect(w.service.abort({ ...ACTOR, userId: "intruder" }, id, { confirmName: id })).rejects.toThrow(/run-not-found/);
    expect(w.status(id)).toBe("WAITING");
  });

  it("abort of a not-yet-started run ends ABORTED immediately and frees the server", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    await expect(w.create()).resolves.toBeDefined();
  });

  it("a compensation that fails marks the run FAILED (retryable by aborting again), keeping the others' progress", async () => {
    let fail = true;
    const { w } = cutoverWorld({
      DATA_SEED: { compensate: async () => (fail ? { outcome: "failed", code: "data.cancel-failed" } : { outcome: "done" }) },
    });
    const id = await w.run();
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("FAILED");
    expect(w.store.row(id).failureCode).toBe("data.cancel-failed");
    fail = false;
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
  });

  it("manual compensation outcomes are kept as operator actions in the run's report", async () => {
    const { w } = cutoverWorld({ FREEZE: { compensate: async () => ({ outcome: "manual", manual: [{ code: "freeze.restart-sources", params: { count: 2 } }] }) } });
    const id = await w.run();
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    const rep = await w.service.report(ACTOR, id);
    expect(rep.manual).toEqual([{ code: "freeze.restart-sources", params: { count: 2 } }]);
    expect(rep.status).toBe("ABORTED");
    expect(await w.service.reportMarkdown(ACTOR, id)).toContain("freeze.restart-sources (count=2)");
  });
});

describe("RunEngine: the point of no return", () => {
  async function toVerify() {
    const t = cutoverWorld();
    const id = await t.w.run();
    expect(t.w.stepStatus(id, "VERIFY")).toBe("WAITING_APPROVAL");
    return { ...t, id };
  }

  it("the PONR approval is hash-bound, typed and expires after 30 minutes", async () => {
    const { w, id, setHash } = await toVerify();
    const b = (await w.view(id)).nextAction.approval!;
    expect(b.ponr).toBe(true);
    await expect(w.service.approve(ACTOR, id, "VERIFY", { boundHash: H64("b"), acks: [], confirmName: "tugra-box", acceptDataRisk: true })).rejects.toThrow(/approval-stale/);
    await expect(w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "wrong", acceptDataRisk: true })).rejects.toThrow(/bad-confirmation/);
    await expect(w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box" })).rejects.toThrow(/data-risk-required/);
    await w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box", acceptDataRisk: true });
    const stored = w.store.step(id, "VERIFY").approval as { expiresAt: string };
    expect(Date.parse(stored.expiresAt) - w.clock.t).toBe(30 * 60_000);
    // what was reviewed changed: the approval is void and the step goes back to waiting (nothing is flipped)
    setHash(H64("c"));
    await w.settle(id, "approve");
    expect(w.stepStatus(id, "VERIFY")).toBe("WAITING_APPROVAL");
    expect(w.store.codes(id)).toContain("approval.void");
    expect(flips(w)).toEqual([]);
  });

  it("an approval older than its ttl is void (approval.expired)", async () => {
    const { w, id } = await toVerify();
    const b = (await w.view(id)).nextAction.approval!;
    await w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box", acceptDataRisk: true });
    w.clock.advance(31 * 60_000);
    await w.settle(id, "approve");
    expect(w.store.codes(id)).toContain("approval.expired");
    expect(w.stepStatus(id, "VERIFY")).toBe("WAITING_APPROVAL");
    expect(w.status(id)).toBe("WAITING");
  });

  it("MCP can never give the PONR approval (403 human-confirmation-required)", async () => {
    const { w, id } = await toVerify();
    const b = (await w.view(id)).nextAction.approval!;
    await expect(w.service.approve({ ...ACTOR, channel: "mcp" }, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box", acceptDataRisk: true })).rejects.toThrow(/human-confirmation-required/);
    expect(w.stepStatus(id, "VERIFY")).toBe("WAITING_APPROVAL");
  });

  it("CUTOVER persists ponrAt BEFORE the first flip; abort is refused afterwards, reverse is the way back", async () => {
    const { w, id } = await toVerify();
    const b = (await w.view(id)).nextAction.approval!;
    // the approved VERIFY lets the flow reach CUTOVER; the stub flips and stays post-PONR in OBSERVE
    await w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box", acceptDataRisk: true });
    await w.settle(id, "approve");
    expect(flips(w)).toEqual(["flip"]); // never "flip-before-ponr"
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.store.row(id).ponrAt).not.toBeNull();
    expect(w.store.codes(id)).toContain("run.ponr.reached");
    await expect(w.service.abort(ACTOR, id, { confirmName: id })).rejects.toThrow(/run-past-ponr/);
  });

  it("abort racing the PONR: whichever wins, a flip never happens after an abort was requested", async () => {
    const { w, id } = await toVerify();
    const b = (await w.view(id)).nextAction.approval!;
    await w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box", acceptDataRisk: true });
    // the abort lands in the window after the approval but before the engine reaches CUTOVER
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id, "tick");
    expect(w.status(id)).toBe("ABORTED");
    expect(flips(w)).toEqual([]);
    expect(w.store.row(id).ponrAt).toBeNull();
  });

  it("markPonr loses to an abort that is already requested, and is idempotent once set", async () => {
    const w = new RunWorld({
      stubs: {
        CUTOVER: {
          act: async (world, ctx) => {
            await world.store.updateRun(ctx.run.id, {}, { abortRequested: true }); // the abort lands mid-step
            await ctx.markPonr();
            world.effects.push("flip");
            return { outcome: "done" };
          },
        },
      },
    });
    const id = await w.run();
    expect(flips(w)).toEqual([]);
    expect(w.store.row(id).ponrAt).toBeNull();
  });

  it("reverse after the PONR restores via the LOSSY steps only, needs admin scope and ends REVERSED with guidance", async () => {
    let observeStays = true;
    const { w } = cutoverWorld({
      OBSERVE: { applicable: () => observeStays, act: async () => ({ outcome: "wait", wait: { kind: "timer", notBefore: new Date(w0().clock.t + 1_800_000).toISOString(), code: "observe.window" } }) },
    });
    const w0 = () => w;
    const id = await w.create();
    await w.start(id);
    await w.settle(id);
    const b = (await w.view(id)).nextAction.approval!;
    await w.service.approve(ACTOR, id, "VERIFY", { boundHash: b.inputHash, acks: [], confirmName: "tugra-box", acceptDataRisk: true });
    await w.settle(id, "approve");
    expect(w.stepStatus(id, "OBSERVE")).toBe("WAITING_TIMER");
    expect(w.store.row(id).ponrAt).not.toBeNull();
    await expect(w.service.reverse({ ...ACTOR, scopes: ["deploy"] }, id, { confirmName: id, acknowledgeDataLoss: true })).rejects.toThrow(/insufficient-scope/);
    await expect(w.service.reverse(ACTOR, id, { confirmName: "x", acknowledgeDataLoss: true })).rejects.toThrow(/bad-confirmation/);
    await w.service.reverse(ACTOR, id, { confirmName: id, acknowledgeDataLoss: true });
    await w.settle(id);
    observeStays = false;
    expect(w.status(id)).toBe("REVERSED");
    expect(flips(w)).toEqual(["flip", "dns-restore"]);
    const lossy = w.compensations.filter((c) => c.endsWith(":reverse")).map((c) => c.split(":")[0]);
    expect(lossy.sort()).toEqual(["CUTOVER", "OBSERVE"]);
    expect((await w.service.report(ACTOR, id)).manual).toEqual([{ code: "run.reverse-sync-guidance" }]);
    expect(w.store.row(id).activeKey).toBeNull();
  });

  it("reverse before the PONR is refused", async () => {
    const { w } = cutoverWorld();
    const id = await w.run();
    await expect(w.service.reverse(ACTOR, id, { confirmName: id, acknowledgeDataLoss: true })).rejects.toThrow(/run-before-ponr/);
  });
});

describe("RunEngine: failures, retry and skip", () => {
  it("a StepFailure fails the step and the run with a stable code; retry re-enters; internal errors never leak text", async () => {
    let n = 0;
    const w = new RunWorld({
      stubs: {
        DATA_SEED: {
          act: async (world) => {
            n += 1;
            if (n === 1) throw new Error("secret-token-ABC leaked in a message");
            world.done.add("DATA_SEED");
            return { outcome: "done" };
          },
        },
      },
    });
    const id = await w.run();
    expect(w.status(id)).toBe("FAILED");
    expect(w.stepStatus(id, "DATA_SEED")).toBe("FAILED");
    expect(w.store.row(id)).toMatchObject({ failureStep: "DATA_SEED", failureCode: "step.internal-error" });
    const dump = JSON.stringify([w.store.eventRows, await w.view(id)]);
    expect(dump).not.toContain("secret-token-ABC");
    expect((await w.view(id)).nextAction).toMatchObject({ kind: "failed", code: "step.internal-error" });
    await w.service.retry(ACTOR, id, "DATA_SEED", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.store.row(id).failureCode).toBeNull();
    expect(w.store.step(id, "DATA_SEED").attempt).toBe(2);
  });

  it("act returning fail with retryable=false hides retry from the view but abort still works", async () => {
    const w = new RunWorld({ stubs: { DATA_SEED: { act: async () => ({ outcome: "fail", code: "data.volume-diverged", params: { volume: "v1" }, retryable: false }) } } });
    const id = await w.run();
    const s = (await w.view(id)).steps.find((x) => x.key === "DATA_SEED")!;
    expect(s.lastError).toBe("data.volume-diverged");
    expect(s.allowed.retry).toBe(false);
    await expect(w.service.retry(ACTOR, id, "DATA_SEED", {})).rejects.toThrow(/step-not-retryable/);
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
  });

  it("a done act whose post-gate still fails is step.post-gate-failed", async () => {
    const w = new RunWorld({ stubs: { DATA_SEED: { act: async () => ({ outcome: "done" }) } } });
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("step.post-gate-failed");
  });

  it("only skippable steps can be skipped; skipping a started rehearsal compensates it first", async () => {
    const w = new RunWorld({ stubs: { DATA_SEED: { blocked: () => true } } });
    const id = await w.run();
    expect(w.stepStatus(id, "DATA_SEED")).toBe("WAITING_OPERATOR");
    await expect(w.service.skip(ACTOR, id, "FREEZE", {})).rejects.toThrow(/step-not-skippable/);
    await w.service.skip(ACTOR, id, "DATA_SEED", { reason: "no rehearsal" });
    expect(w.stepStatus(id, "DATA_SEED")).toBe("SKIPPED");
    expect(w.store.step(id, "DATA_SEED").lastError).toBe("step.skipped-by-operator");
    expect(w.compensations).toContain("DATA_SEED:abort");
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.sink.audits.find((a) => a.action === "migration.run.skip")?.meta).toMatchObject({ step: "DATA_SEED", reason: "no rehearsal" });
  });

  it("a handler without registration fails a real run (never silently passes) but is only `unknown` in a dry-run", async () => {
    const w = new RunWorld({ stubKeys: [] });
    expect(w.registry.missing("copy").length).toBe(9);
    const id = await w.create();
    await expect(w.service.start(ACTOR, id, {})).rejects.toMatchObject({ response: expect.objectContaining({ message: "steps-unavailable" }) });
    const d = await w.create({ dryRun: true, targetServerId: SERVER });
    await w.settle(d);
    const v = await w.view(d);
    expect(v.status).toBe("DRY_RUN_DONE");
    expect(v.steps.find((s) => s.key === "DATA_SEED")?.progress?.dryRun?.[0]).toMatchObject({ code: "step.handler-unavailable", level: "unknown" });
  });
});

describe("RunEngine: evidence, attachments, inputs and the migrator command", () => {
  const dataWorld = () =>
    new RunWorld({
      stubs: {
        DATA_FINAL: {
          act: async () => ({ outcome: "wait", wait: { kind: "operator", code: "data.run-migrator", offersCommand: true, attest: ["source-quiesced"] } }),
        },
      },
    });

  it("an attestation is recorded only for a check the wait lists; the command is minted once through the facade", async () => {
    const w = dataWorld();
    const id = await w.run();
    expect(w.stepStatus(id, "DATA_FINAL")).toBe("WAITING_OPERATOR");
    await expect(w.service.evidence(ACTOR, id, "DATA_FINAL", { checkId: "other" })).rejects.toThrow(/attest-not-allowed/);
    const v = await w.service.evidence(ACTOR, id, "DATA_FINAL", { checkId: "source-quiesced", note: "stopped at 10:00" });
    expect(v.steps.find((s) => s.key === "DATA_FINAL")!.evidence.attestations).toHaveLength(1);
    const cmd = await w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false }, "https://hub.example.com");
    expect(cmd).toMatchObject({ stepKey: "DATA_FINAL", opId: "op-1", shownOnce: true });
    expect(w.port.calls).toContain("mint:op-1:mint");
    // the credential is in the response only: never in a view, an event or an audit entry
    expect(JSON.stringify([await w.view(id), w.store.eventRows, w.sink.audits])).not.toContain("TOKEN");
    await expect(w.service.command(ACTOR, id, "FREEZE", { reissue: false }, "https://hub.example.com")).rejects.toThrow(/step-has-no-command/);
  });

  it("an object migration is attached to DATA_SEED/DATA_FINAL (same team only, deduplicated)", async () => {
    const w = dataWorld();
    w.env.objectMigrations.set("om1", { id: "om1", teamId: "t1", createdById: "u1" });
    w.env.objectMigrations.set("om2", { id: "om2", teamId: "other", createdById: "u9" });
    const id = await w.run();
    await w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "object-migration", resourceId: "om1" });
    await w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "object-migration", resourceId: "om1" });
    expect(w.store.step(id, "DATA_FINAL").evidence).toMatchObject({ attachments: [{ kind: "object-migration", resourceId: "om1" }] });
    await expect(w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "object-migration", resourceId: "om2" })).rejects.toThrow(/resource-not-found/);
    await expect(w.service.attach(ACTOR, id, "PREFLIGHT", { kind: "object-migration", resourceId: "om1" })).rejects.toThrow(/step-not-attachable/);
  });

  it("owner inputs are stamped with provenance and unblock the step that needed them", async () => {
    const w = new RunWorld({ stubs: { TLS_PREISSUE: { blocked: (x) => !x.done.has("email") } } });
    const id = await w.run();
    expect(w.stepStatus(id, "TLS_PREISSUE")).toBe("WAITING_OPERATOR");
    const v = await w.service.setInputs(ACTOR, id, { acmeEmail: "ops@example.com", allowBind: "unknown" });
    expect(v.inputs.acmeEmail).toMatchObject({ value: "ops@example.com", source: "request", setBy: "u1" });
    expect(v.inputs.allowBind?.value).toBe("unknown");
    expect(w.store.codes(id).filter((c) => c === "run.input.set")).toHaveLength(2);
    w.done.add("email");
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
  });
});

describe("RunEngine: re-authorization and secrecy", () => {
  it("a foreign actor cannot read, drive or list another user's run", async () => {
    const w = new RunWorld();
    const id = await w.run();
    const other = { ...ACTOR, userId: "intruder" };
    await expect(w.service.get(other, id)).rejects.toThrow(/run-not-found/);
    await expect(w.service.events(other, id, { afterSeq: 0, limit: 10 })).rejects.toThrow(/run-not-found/);
    await expect(w.service.pause(other, id)).rejects.toThrow(/run-not-found/);
    await expect(w.service.report(other, id)).rejects.toThrow(/run-not-found/);
    expect(await w.service.list(other, { limit: 50 })).toEqual([]);
    expect(await w.service.list(ACTOR, { limit: 50 })).toHaveLength(1);
  });

  it("a read-only token cannot drive; a deploy token cannot clean up", async () => {
    const w = new RunWorld();
    const id = await w.run();
    await expect(w.service.pause({ ...ACTOR, scopes: ["read"] }, id)).rejects.toThrow(/insufficient-scope/);
    await expect(w.service.cleanup({ ...ACTOR, scopes: ["deploy"] }, id, { confirmName: id, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/insufficient-scope/);
    await expect(w.service.create({ ...ACTOR, scopes: ["deploy"] }, w.createBody())).rejects.toThrow(/insufficient-scope/);
  });

  it("views and events never carry a secret-looking value", async () => {
    const w = new RunWorld();
    const id = await w.run();
    await w.service.sourceSession(ACTOR, id, { token: "tugra_mig_SUPERSECRET" }).catch(() => undefined);
    const dump = JSON.stringify([await w.view(id), w.store.eventRows, w.sink.audits, await w.service.report(ACTOR, id)]);
    expect(dump).not.toMatch(/tugra_mig_|SUPERSECRET/);
  });
});
