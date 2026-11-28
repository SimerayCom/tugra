import { ConflictException, Logger } from "@nestjs/common";
import { ACTOR, CrashError, RunWorld } from "../../core/testing/run-world";

// the specs drive a whole run through the engine on a fake clock; give a loaded CI machine room
jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const remap = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "REMAP_ENV")!;

describe("REMAP_ENV", () => {
  it("auto-approves a clean preview: one apply bound to the reviewed plan hash, no approval", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c.startsWith("remapApply"))).toEqual(["remapApply:op-1"]);
    expect(w.store.step(id, "REMAP_ENV").approval).toBeNull();
    expect(w.store.step(id, "REMAP_ENV").compensation).toMatchObject({ remapStarted: true, remapPlanHash: "e".repeat(64) });
  });

  it("manual keys make it attended: the operator acknowledges them through a hash-bound approval", async () => {
    const w = new RunWorld();
    w.port.remapPlan_ = { planHash: "e".repeat(64), appsToWrite: 1, needsManualKeys: 3, needsManualApps: 2 };
    const id = await w.run();
    expect(w.stepStatus(id, "REMAP_ENV")).toBe("WAITING_APPROVAL");
    const b = (await w.view(id)).nextAction.approval!;
    expect(b).toMatchObject({ ponr: false, confirm: "none", ackable: ["remap.needs-manual"], requiredAcks: ["remap.needs-manual"], review: { apps: 2, keys: 3, rewrites: 1 } });
    expect(w.port.calls.some((c) => c.startsWith("remapApply"))).toBe(false);
    // the review changed (another key now needs manual work): the old binding no longer matches
    w.port.remapPlan_ = { planHash: "e".repeat(64), appsToWrite: 1, needsManualKeys: 4, needsManualApps: 2 };
    await expect(w.service.approve(ACTOR, id, "REMAP_ENV", { boundHash: b.inputHash, acks: ["remap.needs-manual"] })).rejects.toThrow(/approval-stale/);
    const b2 = (await w.view(id)).nextAction.approval;
    const fresh = await w.service.get(ACTOR, id);
    void fresh;
    await w.settle(id); // re-park to refresh the stored binding
    const bb = (await w.view(id)).nextAction.approval!;
    expect(bb.inputHash).not.toBe(b.inputHash);
    void b2;
    await w.service.approve(ACTOR, id, "REMAP_ENV", { boundHash: bb.inputHash, acks: ["remap.needs-manual"] });
    await w.settle(id, "approve");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c.startsWith("remapApply"))).toHaveLength(1);
  });

  it("the approval names the apps, keys and reasons that need the owner, as parallel lists, never a value", async () => {
    const w = new RunWorld();
    w.port.remapPlan_ = {
      planHash: "e".repeat(64),
      appsToWrite: 1,
      needsManualKeys: 2,
      needsManualApps: 1,
      manual: [
        { app: "api", key: "DATABASE_URL", reason: "unresolved-uuid-host" },
        { app: "api", key: "REDIS_HOST", reason: "app-link-review" },
      ],
    };
    const id = await w.run();
    const b = (await w.view(id)).nextAction.approval!;
    expect(b.review).toMatchObject({ apps: 1, keys: 2, manualApps: ["api", "api"], manualKeys: ["DATABASE_URL", "REDIS_HOST"], manualReasons: ["unresolved-uuid-host", "app-link-review"] });
    const check = (await remap(w, id)).gate!.checks.find((c) => c.id === "remap.needs-manual");
    expect(check?.params).toMatchObject({ manualKeys: ["DATABASE_URL", "REDIS_HOST"] });
  });

  it("an in-place run asks the plan with the in-place flag, and is not asked anything when only unchanged references are left", async () => {
    const w = new RunWorld();
    w.port.remapPlan_ = { planHash: "e".repeat(64), appsToWrite: 1, needsManualKeys: 0, needsManualApps: 0, manual: [], infoKeys: 2 };
    const id = await w.create();
    const row = w.store.runs.get(id) as unknown as { inPlace: boolean; topology: string };
    row.inPlace = true;
    row.topology = "swap-proxy";
    await w.start(id);
    await w.settle(id);
    expect(w.port.remapPlanOpts).toContainEqual({ inPlace: true });
    expect(w.store.step(id, "REMAP_ENV").approval).toBeNull();
    expect((await remap(w, id)).status).not.toBe("WAITING_APPROVAL");
  });

  it("nothing to rewrite but manual keys pending: still needs the acknowledgement, and never calls apply", async () => {
    const w = new RunWorld();
    w.port.remapPlan_ = { planHash: "e".repeat(64), appsToWrite: 0, needsManualKeys: 1, needsManualApps: 1 };
    const id = await w.run();
    expect(w.stepStatus(id, "REMAP_ENV")).toBe("WAITING_APPROVAL");
    await w.approveCurrent(id);
    await w.settle(id, "approve");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.some((c) => c.startsWith("remapApply"))).toBe(false);
  });

  it("an import that provisioned nothing has nothing to remap", async () => {
    const w = new RunWorld();
    w.port.remapNothing = true;
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect((await remap(w, id)).gate!.checks[0].code).toBe("remap-env.nothing-to-do");
  });

  it("a plan that changed between review and apply (409) fails retryably; nothing was written", async () => {
    const w = new RunWorld();
    const orig = w.port.remapApply.bind(w.port);
    w.port.remapApply = async () => {
      throw new ConflictException("the plan has changed since you reviewed it");
    };
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("remap-env.plan-changed");
    expect((await remap(w, id)).allowed.retry).toBe(true);
    w.port.remapApply = orig;
    await w.service.retry(ACTOR, id, "REMAP_ENV", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a partial apply fails; retry undoes it and applies again from a clean state", async () => {
    const w = new RunWorld();
    w.port.remapFailed = 1;
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("remap-env.partial");
    expect(w.store.step(id, "REMAP_ENV").compensation).toMatchObject({ remapPartial: true });
    w.port.remapFailed = 0;
    await w.service.retry(ACTOR, id, "REMAP_ENV", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c.startsWith("remapUndo") || c.startsWith("remapApply"))).toEqual(["remapApply:op-1", "remapUndo:op-1", "remapApply:op-1"]);
  });

  it("a hub crash in the middle of the apply is not accepted as a finished remap: the next boot undoes it and applies again", async () => {
    const w = new RunWorld();
    const dying = w.bootId;
    const orig = w.port.remapApply.bind(w.port);
    let crashed = false;
    w.port.remapApply = async (u, opId, token) => {
      if (crashed) return orig(u, opId, token);
      crashed = true;
      // the undo record is committed and some apps rewritten, then the process dies before the loop finishes
      w.port.calls.push(`remapApply:${opId}`);
      w.port.remapPendingBy.set(opId, true);
      w.store.killAfterOwnedWrites(1, dying);
      throw new CrashError();
    };
    const id = await w.create();
    await w.start(id);
    await w.engine.drive(id);
    expect(w.store.isDead(dying)).toBe(true);
    expect(w.store.step(id, "REMAP_ENV").compensation).toMatchObject({ remapStarted: true });
    expect(w.store.step(id, "REMAP_ENV").compensation).not.toMatchObject({ remapDone: true });
    w.restart();
    for (let i = 0; i < 60 && w.status(id) !== "COMPLETED"; i++) {
      await w.tick();
      w.clock.advance(20_000);
    }
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c.startsWith("remapUndo") || c.startsWith("remapApply"))).toEqual(["remapApply:op-1", "remapUndo:op-1", "remapApply:op-1"]);
    expect(w.store.step(id, "REMAP_ENV").compensation).toMatchObject({ remapDone: true });
  });

  it("abort undoes an applied remap (and only an applied one)", async () => {
    const w = new RunWorld({ stubs: { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.port.calls).toContain("remapUndo:op-1");
    expect(w.stepStatus(id, "REMAP_ENV")).toBe("COMPENSATED");

    const w2 = new RunWorld({ stubs: { DATA_FINAL: { blocked: (x) => !x.done.has("go") } } });
    const id2 = await w2.run();
    await w2.service.abort(ACTOR, id2, { confirmName: id2 });
    await w2.settle(id2);
    expect(w2.port.calls.some((c) => c.startsWith("remapUndo"))).toBe(false); // REMAP_ENV never started
  });
});

describe("REMAP_ENV: multi-host dry-run (grup-7)", () => {
  it("says the rewrite runs per host when the run has more than one target; a single-target run has no such line", async () => {
    const w = new RunWorld();
    w.env.serversById.set("srv2", { id: "srv2", name: "host-2", teamId: "t1" });
    w.env.serversById.set("srv3", { id: "srv3", name: "host-3", teamId: "t1" });
    const multi = await w.create({ dryRun: true, serverMap: { "src-a": "srv2", "src-b": "srv3" } });
    await w.settle(multi);
    expect((await remap(w, multi)).progress!.dryRun).toContainEqual({ code: "remap-env.per-host", level: "info", params: { targets: 3 } });
    const single = await w.create({ dryRun: true });
    await w.settle(single);
    expect((await remap(w, single)).progress!.dryRun!.map((i) => i.code)).toEqual(["remap-env.projected-after-import"]);
  });
});
