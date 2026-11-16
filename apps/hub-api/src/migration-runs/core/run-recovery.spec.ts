import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, type StubScript } from "./testing/run-world";
import { isTerminal } from "./run-logic";
import type { ApprovalBinding } from "./dto";
import type { RunStatus } from "./run-contract";

// the specs drive a whole run through the engine on a fake clock; give a loaded CI machine room
jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

/** Recovery ticks (the periodic loop) until the run is settled or stuck waiting for a human. */
async function converge(w: RunWorld, id: string, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await w.tick();
    w.clock.advance(20_000);
    const st = w.status(id) as RunStatus;
    if (isTerminal(st) || st === "PAUSED") return;
  }
}

const cutover: StubScript = {
  act: async (world, ctx) => {
    await ctx.markPonr();
    world.effects.push(world.store.row(ctx.run.id).ponrAt ? "flip" : "flip-before-ponr");
    world.done.add("CUTOVER");
    return { outcome: "done" };
  },
};

describe("crash at EVERY persisted boundary: the run converges and each external effect happens at most once", () => {
  it("kills the driver before each owned write of a whole run, re-drives under a new boot id, and checks the invariants", async () => {
    let boundaries = 0;
    let adoptedWindow = 0;
    for (let k = 1; k < 600; k++) {
      const w = new RunWorld({ stubs: { CUTOVER: cutover } });
      const id = await w.create();
      await w.start(id);
      const dying = w.bootId;
      w.store.killAfterOwnedWrites(k, dying);
      await w.engine.drive(id);
      if (!w.store.isDead(dying)) {
        // k is past the last write of an uninterrupted run: the loop has covered every boundary
        expect(w.status(id)).toBe("COMPLETED");
        break;
      }
      boundaries += 1;
      w.restart();
      await converge(w, id);

      const label = `crash point ${k}`;
      expect({ k, status: w.status(id) }).toEqual({ k, status: "COMPLETED" });
      const row = w.store.row(id);
      // the server is free again (a crash right after the final status write may leave a stale, harmless ownerId)
      expect({ k, activeKey: row.activeKey }).toEqual({ k, activeKey: null });
      expect(w.store.eventRows.filter((e) => e.runId === id).map((e) => e.seq)).toEqual(Array.from({ length: row.eventSeq }, (_, i) => i + 1));

      // IMPORT: one live op with every task done; a crash inside the apply window redoes it at most once
      const applies = w.port.calls.filter((c) => c === "apply").length;
      expect({ label, applies: applies <= 2 }).toEqual({ label, applies: true });
      if (applies === 2) {
        adoptedWindow += 1;
        expect(w.port.calls.filter((c) => c.startsWith("rollback:")).length).toBe(1);
      }
      const live = [...w.port.ops.values()].filter((o) => !o.rolledBack);
      expect({ label, liveOps: live.length }).toEqual({ label, liveOps: 1 });
      expect(live[0].tasks.every((t) => t.status === "DONE" || t.status === "SKIPPED")).toBe(true);
      expect(row.opId).toBe(live[0].id);

      // exactly-once effects
      const only = (prefix: string) => w.port.calls.filter((c) => c.startsWith(prefix));
      expect({ label, remap: only("remapApply").length }).toEqual({ label, remap: 1 });
      expect({ label, deploys: only("deploy:").length }).toEqual({ label, deploys: 2 });
      expect(new Set(only("deploy:")).size).toBe(2);
      expect(only("startDb:").length).toBe(1);
      expect({ label, flips: w.effects.filter((e) => e === "flip" || e === "flip-before-ponr") }).toEqual({ label, flips: ["flip"] });
      expect(w.store.codes(id).filter((c) => c === "run.recovered").length).toBeLessThanOrEqual(1);
    }
    expect(boundaries).toBeGreaterThan(60);
    expect(adoptedWindow).toBeGreaterThanOrEqual(1); // the apply->record window was really exercised
  }, 120_000);
});

describe("crash during an ABORT and during a dry-run", () => {
  it("an abort killed at every boundary converges to ABORTED with the (fake) source running again", async () => {
    let boundaries = 0;
    for (let k = 1; k < 200; k++) {
      const src = { running: true };
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
              if (how === "abort" && ctx.step.compensation?.frozen === true) src.running = true;
              return how === "abort" ? { outcome: "done" } : { outcome: "nothing-to-do" };
            },
          },
          TLS_PREISSUE: { blocked: (x) => !x.done.has("go") },
        },
      });
      const id = await w.run();
      expect(w.status(id)).toBe("WAITING");
      expect(src.running).toBe(false);
      await w.service.abort(ACTOR, id, { confirmName: id });
      const dying = w.bootId;
      w.store.killAfterOwnedWrites(k, dying);
      await w.engine.drive(id);
      if (!w.store.isDead(dying)) {
        expect(w.status(id)).toBe("ABORTED");
        break;
      }
      boundaries += 1;
      w.restart();
      await converge(w, id);
      expect({ k, status: w.status(id) }).toEqual({ k, status: "ABORTED" });
      expect({ k, running: src.running }).toEqual({ k, running: true });
      expect(w.store.row(id).activeKey).toBeNull();
      expect(w.port.calls.some((c) => c.startsWith("rollback:"))).toBe(false); // abort never deletes
    }
    expect(boundaries).toBeGreaterThan(10);
  }, 60_000);

  it("a dry-run killed at every boundary still ends DRY_RUN_DONE and never acts", async () => {
    let boundaries = 0;
    for (let k = 1; k < 200; k++) {
      const w = new RunWorld();
      const id = await w.create({ dryRun: true });
      const dying = w.bootId;
      w.store.killAfterOwnedWrites(k, dying);
      await w.engine.drive(id);
      if (!w.store.isDead(dying)) {
        expect(w.status(id)).toBe("DRY_RUN_DONE");
        break;
      }
      boundaries += 1;
      w.restart();
      await converge(w, id);
      expect({ k, status: w.status(id) }).toEqual({ k, status: "DRY_RUN_DONE" });
      expect(w.port.calls).toEqual([]);
      expect(w.effects).toEqual([]);
    }
    expect(boundaries).toBeGreaterThan(20);
  }, 60_000);
});

describe("hub restart scenarios", () => {
  it("a parked run is adopted by the new boot (run.recovered), keeps waiting and then completes when the world allows", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    expect(w.status(id)).toBe("WAITING");
    const oldOwner = w.store.row(id).ownerId;
    w.restart();
    await w.tick();
    expect(w.store.row(id).ownerId).toBe(w.bootId);
    expect(w.store.row(id).ownerId).not.toBe(oldOwner);
    expect(w.store.codes(id).filter((c) => c === "run.recovered")).toHaveLength(1);
    expect(w.status(id)).toBe("WAITING");
    w.done.add("go");
    await w.tick();
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(1); // no second import
  });

  it("the recovery loop never drives a run this process is already driving", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await w.start(id);
    const p = w.engine.drive(id);
    expect(w.engine.isDriving(id)).toBe(true);
    expect(await w.recovery.tick(w.clock.now())).toEqual([]);
    await p;
  });

  it("a PAUSED run stays paused across a restart and can be aborted afterwards", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    await w.service.pause(ACTOR, id);
    await w.settle(id);
    w.restart();
    await w.tick(3);
    expect(w.status(id)).toBe("PAUSED");
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
  });

  it("an interrupted ABORT is finished by the next boot: compensation is idempotent", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    await w.service.abort(ACTOR, id, { confirmName: id });
    const dying = w.bootId;
    w.store.killAfterOwnedWrites(3, dying);
    await w.engine.drive(id);
    expect(w.store.isDead(dying)).toBe(true);
    expect(w.status(id)).toBe("ABORTING");
    w.restart();
    await converge(w, id);
    expect(w.status(id)).toBe("ABORTED");
    expect(w.store.row(id).activeKey).toBeNull();
    // the stop calls are state-guarded: a second pass over the same resources stops nothing twice
    const stops = w.port.calls.filter((c) => c.startsWith("stopApp:") || c.startsWith("stopDb:"));
    expect(new Set(stops).size).toBe(stops.length);
  });

  it("a crash during reverse is resumed (REVERSING is drivable)", async () => {
    const hash = "a".repeat(64);
    const ponr: ApprovalBinding = { inputHash: hash, ponr: true, confirm: "target-server", ttlSec: 1800, requiresDataRisk: false, ackable: [], requiredAcks: [], review: {} };
    const w = new RunWorld({
      stubs: {
        VERIFY: { binding: () => ponr },
        CUTOVER: cutover,
        OBSERVE: { act: async (world) => ({ outcome: "wait", wait: { kind: "timer", notBefore: new Date(world.clock.t + 3_600_000).toISOString(), code: "observe.window" } }) },
      },
    });
    const id = await w.run();
    await w.service.approve(ACTOR, id, "VERIFY", { boundHash: hash, acks: [], confirmName: "tugra-box" });
    await w.settle(id, "approve");
    expect(w.stepStatus(id, "OBSERVE")).toBe("WAITING_TIMER");
    await w.service.reverse(ACTOR, id, { confirmName: id, acknowledgeDataLoss: true });
    const dying = w.bootId;
    w.store.killAfterOwnedWrites(2, dying);
    await w.engine.drive(id);
    expect(w.status(id)).toBe("REVERSING");
    w.restart();
    await converge(w, id);
    expect(w.status(id)).toBe("REVERSED");
  });

  it("IMPORT whose fan-out died with the hub: cancel, wait for the stale tasks, roll back, apply a FRESH op", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await w.start(id);
    // PREFLIGHT passes, IMPORT applies (op-1) and the process dies while the fan-out is still PENDING/RUNNING
    const dying = w.bootId;
    // the apply -> op id recorded -> patchRun are owned writes; die right after the op id is persisted
    let died = false;
    const orig = w.store.updateRun.bind(w.store);
    w.store.updateRun = async (rid, guard, patch) => {
      const r = await orig(rid, guard, patch);
      if (patch.opId && !died) {
        died = true;
        w.store.killAfterOwnedWrites(1, dying);
      }
      return r;
    };
    await w.engine.drive(id);
    expect(w.store.isDead(dying)).toBe(true);
    expect(w.store.row(id).opId).toBe("op-1");
    w.restart();
    await converge(w, id);
    expect(w.status(id)).toBe("COMPLETED");
    const order = w.port.calls.filter((c) => c === "apply" || c.startsWith("cancel:") || c.startsWith("rollback:"));
    expect(order).toEqual(["apply", "cancel:op-1", "rollback:op-1", "apply"]);
    const row = w.store.row(id);
    expect(row.opId).toBe("op-2");
    expect(row.opHistory).toEqual(["op-1"]);
    expect(w.store.codes(id)).toEqual(expect.arrayContaining(["import.redo", "run.recovered"]));
    expect(w.port.ops.get("op-1")!.rolledBack).toBe(true);
    // no leaked resources from the first op
    expect([...w.port.apps.keys()].length).toBe(2);
  });

  it("IMPORT retry after failed tasks is rollback + re-apply on a fresh op, at most twice", async () => {
    const w = new RunWorld();
    w.port.failItems.add("app:_:web");
    const id = await w.run();
    expect(w.status(id)).toBe("FAILED");
    expect(w.store.row(id).failureCode).toBe("import.tasks-failed");
    await w.service.retry(ACTOR, id, "IMPORT", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(2);
    expect(w.port.calls.filter((c) => c.startsWith("rollback:"))).toEqual(["rollback:op-1"]);

    // exhausted: three failures in a row
    const w2 = new RunWorld();
    const id2 = await w2.create();
    await w2.start(id2);
    for (let i = 0; i < 3; i++) {
      w2.port.failItems.add("app:_:web");
      await w2.settle(id2, i === 0 ? "tick" : "retry");
      expect(w2.status(id2)).toBe("FAILED");
      if (i < 2) await w2.service.retry(ACTOR, id2, "IMPORT", {});
    }
    expect(w2.store.row(id2).failureCode).toBe("import.tasks-failed");
    await w2.service.retry(ACTOR, id2, "IMPORT", {});
    await w2.settle(id2, "retry");
    expect(w2.store.row(id2).failureCode).toBe("import.retry-exhausted");
    await expect(w2.service.retry(ACTOR, id2, "IMPORT", {})).rejects.toThrow(/step-not-retryable/);
  });
});
