import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { ACTOR, RunWorld, defaultPlan } from "../../core/testing/run-world";
import { CLEANUP_REQUEST_KEY } from "../../core/run-engine.service";
import { TEAM } from "../../core/testing/run-world";
import { item, safetyWorld } from "./testing/safety-world";
import { InMemoryRunHints } from "./baseline/run-hints";

// the specs drive a whole run through the engine on a fake clock; give a loaded CI machine room
jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const importStep = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "IMPORT")!;

describe("IMPORT", () => {
  it("applies the frozen secret-free input exactly once and records the op on the run", async () => {
    const w = new RunWorld();
    const id = await w.create({ environmentId: "env1", acks: [{ code: "app.env.unresolved" }], dbDataModes: { "database:_:db1": "volume" } });
    const seen: unknown[] = [];
    const orig = w.port.apply.bind(w.port);
    w.port.apply = async (u, input) => {
      seen.push(input);
      return orig(u, input);
    };
    await w.start(id);
    await w.settle(id);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", environmentId: "env1", dbDataModes: { "database:_:db1": "volume" } });
    expect(JSON.stringify(seen[0])).not.toMatch(/token|password|secret/i);
    expect(w.store.row(id).opId).toBe("op-1");
    expect((await importStep(w, id)).progress).toMatchObject({ unit: "item" });
    expect(w.store.step(id, "IMPORT").compensation).toMatchObject({ applyDone: true });
  });

  it("an op that is still fanning out is polled, not re-applied", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(1);
    expect(w.clock.sleeps).toBeGreaterThan(0);
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a rollback that finds leftovers fails with import.rollback-incomplete (no silent duplicate on re-apply)", async () => {
    const w = new RunWorld();
    w.port.failItems.add("app:_:web");
    const orig = w.port.rollbackOp.bind(w.port);
    w.port.rollbackOp = async (u, op, o) => {
      await orig(u, op, o);
      const t = w.port.ops.get(op)!.tasks.find((x) => x.status === "ROLLED_BACK" || x.status === "DONE");
      if (t) t.status = "DONE"; // the importer skipped one resource ("rollback skipped: ...")
    };
    const id = await w.run();
    await w.service.retry(ACTOR, id, "IMPORT", {});
    await w.settle(id, "retry");
    expect(w.store.row(id).failureCode).toBe("import.rollback-incomplete");
    expect((await importStep(w, id)).allowed.retry).toBe(false);
  });

  it("apply refusals become deterministic codes: plan-changed is final, a coded conflict keeps its code", async () => {
    const w = new RunWorld();
    w.port.failApplyWith = new ConflictException("the plan changed since it was previewed - re-run the plan and review again");
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("import.plan-changed");
    expect((await importStep(w, id)).allowed.retry).toBe(false);

    const w2 = new RunWorld();
    w2.port.failApplyWith = new ConflictException({ statusCode: 409, message: "x", code: "import.mapping_required" });
    const id2 = await w2.run();
    expect(w2.store.row(id2).failureCode).toBe("import.apply.mapping-required");
    expect(w2.store.step(id2, "IMPORT").compensation).toMatchObject({ applyStartedAt: null }); // the service answered: no op was created

    const w3 = new RunWorld();
    w3.port.failApplyWith = new ForbiddenException("insufficient permission for this team");
    const id3 = await w3.run();
    expect(w3.store.row(id3).failureCode).toBe("import.apply.http-403");
    expect(w3.store.step(id3, "IMPORT").compensation).toMatchObject({ applyStartedAt: null }); // a definitive refusal created no op

    // an UNKNOWN failure (not an HTTP answer) may have created the op: the marker stays so a retry adopts it
    const w4 = new RunWorld();
    w4.port.failApplyWith = new Error("socket hang up") as never;
    const id4 = await w4.run();
    expect(w4.store.row(id4).failureCode).toBe("import.apply.failed");
    expect(w4.store.step(id4, "IMPORT").compensation).toMatchObject({ applyStartedAt: expect.any(String) });
  });

  it("a git app that still needs a source is a warning, not a failure", async () => {
    const w = new RunWorld();
    w.port.gitStatus.set("app:_:web", "needs_source");
    const id = await w.run();
    const g = (await importStep(w, id)).gate!;
    expect(g.passed).toBe(true);
    expect(g.checks.find((c) => c.code === "import.git-needs-source")).toMatchObject({ status: "warn", params: { count: 1 } });
  });

  it("earlyStateless deploys only the apps that depend on nothing, right after the import; DEPLOY_DARK then skips them", async () => {
    const w = new RunWorld();
    const id = await w.run({ options: { ...w.createBody().options, deployWaves: "earlyStateless" } });
    expect(w.status(id)).toBe("COMPLETED");
    const deploys = w.port.calls.filter((c) => c.startsWith("deploy:"));
    expect(deploys).toHaveLength(2); // one per app, each exactly once overall
    const staticApp = [...w.port.ops.get("op-1")!.tasks].find((t) => t.name === "static-site")!.resourceId!;
    expect(deploys[0].startsWith(`deploy:${staticApp}:`)).toBe(true); // the stateless one went first, during IMPORT
    expect(w.store.step(id, "IMPORT").compensation).toMatchObject({ earlyAppIds: [staticApp] });
  });

  it("dry-run projects counts and unacked blockers without touching the importer", async () => {
    const w = new RunWorld();
    w.port.plan_ = defaultPlan({ items: [{ itemRef: "app:_:web", kind: "app", name: "web", proposed: {}, risks: [{ level: "blocker", code: "db.engine.noImport", message: "x" }], dependsOn: [] }] });
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    const items = (await importStep(w, id)).progress!.dryRun!;
    expect(items.map((i) => i.code)).toEqual(expect.arrayContaining(["import.projection", "import.plan-fresh", "import.item-skipped"]));
    expect(w.port.calls).toEqual([]);
  });
});

describe("IMPORT abort covers what IMPORT itself left behind", () => {
  it("earlyStateless: an abort before DEPLOY_DARK starts stops the apps the early wave deployed", async () => {
    const w = new RunWorld({ stubs: { DNS_PREPARE: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run({ options: { ...w.createBody().options, deployWaves: "earlyStateless" } });
    expect(w.stepStatus(id, "DEPLOY_DARK")).toBe("PENDING");
    const early = (w.store.step(id, "IMPORT").compensation as { earlyAppIds: string[] }).earlyAppIds;
    expect(early).toHaveLength(1);
    expect(w.port.apps.get(early[0])!.status).toBe("RUNNING");
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(w.port.apps.get(early[0])!.status).toBe("STOPPED");
    expect(w.port.calls).toContain(`stopApp:${early[0]}`);
  });

  it("earlyStateless: an early deployment still queued at abort is cancelled and never brings the app up", async () => {
    const w = new RunWorld({ stubs: { DNS_PREPARE: { blocked: (x) => !x.done.has("go") } } });
    w.port.queueDeploys = true;
    const id = await w.create({ options: { ...w.createBody().options, deployWaves: "earlyStateless" } });
    await w.start(id);
    const pass = w.engine.drive(id);
    for (let i = 0; i < 2000 && !w.port.deploys.length; i++) await new Promise((r) => setImmediate(r));
    expect(w.port.deploys).toHaveLength(1);
    await w.service.abort(ACTOR, id, { confirmName: id });
    w.engine.interrupt(id);
    await pass;
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    w.port.settleDeploys(); // the queue drains after the abort finished
    expect(w.port.deploys[0].status).toBe("CANCELLED");
    expect([...w.port.apps.values()].some((a) => a.status === "RUNNING")).toBe(false);
  });

  it("a crash between apply and recording the op id, then an abort: the orphan op is adopted, cancelled, and cleanable", async () => {
    const w = new RunWorld();
    const dying = w.bootId;
    const orig = w.port.apply.bind(w.port);
    w.port.apply = async (u, input) => {
      const r = await orig(u, input);
      w.store.killAfterOwnedWrites(1, dying); // the process dies right after the importer accepted the apply
      return r;
    };
    const id = await w.create();
    await w.start(id);
    await w.engine.drive(id);
    expect(w.store.isDead(dying)).toBe(true);
    expect(w.store.row(id).opId).toBeNull();
    w.restart();
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(w.port.calls).toContain("cancel:op-1");
    expect(w.store.row(id).opId).toBe("op-1");
    expect(w.store.codes(id)).toContain("import.op-adopted");
    // the adopted op makes the run cleanable
    await w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: [] });
    await w.settle(id);
    expect(w.status(id)).toBe("ROLLED_BACK");
    expect(w.port.calls).toContain("rollback:op-1:run-owned");
  });
});

describe("IMPORT abort and cleanup", () => {
  async function abortedWorld() {
    const w = new RunWorld({ stubs: { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    expect(w.status(id)).toBe("WAITING");
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    return { w, id };
  }

  it("abort cancels the op (revoking its token) but deletes nothing; the Tugra copies stay, stopped", async () => {
    const { w } = await abortedWorld();
    expect(w.port.calls).toContain("cancel:op-1");
    expect(w.port.calls.some((c) => c.startsWith("rollback:"))).toBe(false);
    expect([...w.port.apps.values()].every((a) => a.status === "STOPPED")).toBe(true);
    expect([...w.port.dbs.values()].every((d) => d.status === "STOPPED")).toBe(true);
    expect(w.port.apps.size + w.port.dbs.size).toBe(3);
  });

  it("cleanup needs admin scope + the typed run id, records the request for IMPORT and rolls back with the run-owned allowance", async () => {
    const { w, id } = await abortedWorld();
    await expect(w.service.cleanup({ ...ACTOR, scopes: ["deploy"] }, id, { confirmName: id, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/insufficient-scope/);
    await expect(w.service.cleanup(ACTOR, id, { confirmName: "x", includeData: false, dataConfirmNames: [] })).rejects.toThrow(/bad-confirmation/);
    const v = await w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: ["ignored"] });
    expect(v.status).toBe("ROLLING_BACK");
    expect(w.store.row(id).activeKey).toBe("srv:srv1"); // cleanup re-takes the server
    expect((w.store.step(id, "IMPORT").compensation as Record<string, unknown>)[CLEANUP_REQUEST_KEY]).toEqual({ includeData: false, dataConfirmNames: [] });
    await w.settle(id);
    // the started DB holds data: without includeData + its typed name it is kept and reported for manual removal
    expect(w.status(id)).toBe("ROLLED_BACK");
    expect(w.port.calls).toContain("rollback:op-1:run-owned");
    expect(w.port.apps.size).toBe(0);
    expect(w.port.dbs.size).toBe(1);
    expect((await w.service.report(ACTOR, id)).manual).toEqual([{ code: "import.cleanup-kept", params: { name: "pg-main", kind: "database" } }]);
    expect(w.store.row(id).activeKey).toBeNull();
  });

  it("includeData with the typed name removes the data-bearing database too", async () => {
    const { w, id } = await abortedWorld();
    await w.service.cleanup(ACTOR, id, { confirmName: id, includeData: true, dataConfirmNames: ["pg-main"] });
    await w.settle(id);
    expect(w.status(id)).toBe("ROLLED_BACK");
    expect(w.port.calls).toContain("rollback:op-1:run-owned:data");
    expect(w.port.dbs.size).toBe(0);
    expect((await w.service.report(ACTOR, id)).manual).toEqual([]);
  });

  it("cleanup is refused when another live run holds the server, and for a run that was not aborted", async () => {
    const { w, id } = await abortedWorld();
    const other = await w.create();
    await expect(w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/server-has-live-run/);
    expect(w.status(id)).toBe("ABORTED");
    await w.service.abort(ACTOR, other, { confirmName: other });
    await w.settle(other);
    const fresh = await w.create();
    await expect(w.service.cleanup(ACTOR, fresh, { confirmName: fresh, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/run-not-cleanable/);
  });
});

// ───────────────────────────── grup-7 safety rules ─────────────────────────────

type SafetyWorld = ReturnType<typeof safetyWorld>["w"];
const items = [
  item("app:src-a:web", "web", { source: "GIT", domain: "web.example.test" }),
  item("app:src-a:api", "api", { source: "GIT", domain: "api.example.test" }),
  item("app:src-b:queue", "queue-worker", { source: "GIT", domain: null }),
];
const idOf = (w: SafetyWorld, name: string) => [...w.port.apps.values()].find((a) => a.name === name)!.id;
const callsOf = (w: SafetyWorld, prefix: string) => w.port.calls.filter((c) => c.startsWith(prefix));

/** push-to-deploy switches (every app is created ON unless named in `off`) and a prebuild that records its calls. */
function wire(w: SafetyWorld, opts: { off?: string[]; prebuild?: (appId: string) => Promise<{ built: boolean }> } = {}) {
  const sw = new Map<string, boolean>();
  const port = w.port as unknown as Record<string, unknown>;
  port.autoDeployState = async (_u: string, id: string) => (w.port.apps.has(id) ? (sw.get(id) ?? !(opts.off ?? []).includes(w.port.apps.get(id)!.name)) : null);
  port.setAutoDeploy = async (_u: string, id: string, v: boolean) => {
    w.port.calls.push(`autoDeploy:${id}:${v ? "on" : "off"}`);
    sw.set(id, v);
  };
  port.prebuild = async (_u: string, id: string) => {
    w.port.calls.push(`prebuild:${id}`);
    return opts.prebuild ? opts.prebuild(id) : { built: true };
  };
  return sw;
}
const earlyOpts = (w: SafetyWorld, over: Record<string, unknown>) => ({ ...w.createBody().options, ...over });

describe("IMPORT push-to-deploy hold (R17/R64)", () => {
  it("switches push-to-deploy off for every imported app before anything is deployed, and records the ids first", async () => {
    const { w } = safetyWorld(items);
    const sw = wire(w);
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyStateless" }) });
    expect(w.status(id)).toBe("COMPLETED");
    const offs = callsOf(w, "autoDeploy:").filter((c) => c.endsWith(":off"));
    expect(offs).toHaveLength(3);
    const firstDeploy = w.port.calls.findIndex((c) => c.startsWith("deploy:"));
    expect(w.port.calls.indexOf(offs[offs.length - 1])).toBeLessThan(firstDeploy);
    expect([...sw.values()].every((v) => v === false)).toBe(true);
    const comp = w.store.step(id, "IMPORT").compensation as { autoDeployHeld: string[] };
    expect([...comp.autoDeployHeld].sort()).toEqual([idOf(w, "api"), idOf(w, "queue-worker"), idOf(w, "web")].sort());
    const step = await importStep(w, id);
    expect(step.gate!.checks).toContainEqual(expect.objectContaining({ id: "import.auto-deploy", status: "pass", code: "import.auto-deploy-held" }));
    expect((await w.service.events(ACTOR, id, { afterSeq: 0, limit: 500 })).events.find((e) => e.code === "import.auto-deploy-held")?.params).toEqual({ count: 3 });
  });

  it("an app that already had push-to-deploy off is left alone: never touched, never recorded (so never switched on later)", async () => {
    const { w } = safetyWorld(items);
    wire(w, { off: ["api"] });
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(callsOf(w, "autoDeploy:")).toHaveLength(2);
    const comp = w.store.step(id, "IMPORT").compensation as { autoDeployHeld: string[] };
    expect(comp.autoDeployHeld).not.toContain(idOf(w, "api"));
  });

  it("a failing switch fails the step retryably, and the retry switches the rest without re-switching the done ones", async () => {
    const { w } = safetyWorld(items);
    const sw = wire(w);
    const set = (w.port as unknown as { setAutoDeploy: (u: string, id: string, v: boolean) => Promise<void> }).setAutoDeploy;
    let fail = true;
    (w.port as unknown as { setAutoDeploy: unknown }).setAutoDeploy = async (u: string, id: string, v: boolean) => {
      if (fail && w.port.apps.get(id)!.name === "api") throw new Error("denied");
      return set(u, id, v);
    };
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("import.auto-deploy.failed");
    fail = false;
    await w.service.retry(ACTOR, id, "IMPORT", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect([...sw.values()].every((v) => v === false)).toBe(true);
    const comp = w.store.step(id, "IMPORT").compensation as { autoDeployHeld: string[] };
    expect(new Set(comp.autoDeployHeld).size).toBe(3);
  });

  it("without the capability (a port that cannot read or set the switch) nothing is checked", async () => {
    const { w } = safetyWorld(items);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect((await importStep(w, id)).gate!.checks.map((c) => c.id)).not.toContain("import.auto-deploy");
  });
});

describe("IMPORT earlyBuild (R27/C5)", () => {
  it("builds every app image, workers included, during IMPORT, nothing started; DEPLOY_DARK then starts only the ordinary apps", async () => {
    const { w } = safetyWorld(items);
    wire(w);
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyBuild" }) });
    expect(w.status(id)).toBe("COMPLETED");
    expect(callsOf(w, "prebuild:").sort()).toEqual([idOf(w, "api"), idOf(w, "queue-worker"), idOf(w, "web")].map((a) => `prebuild:${a}`).sort());
    const lastBuild = Math.max(...callsOf(w, "prebuild:").map((c) => w.port.calls.indexOf(c)));
    const firstDeploy = w.port.calls.findIndex((c) => c.startsWith("deploy:"));
    expect(lastBuild).toBeLessThan(firstDeploy); // every build finished before the first start
    expect(w.port.deploys.map((d) => d.appId).sort()).toEqual([idOf(w, "api"), idOf(w, "web")].sort()); // the worker stays held
    expect((await importStep(w, id)).gate!.checks).toContainEqual(expect.objectContaining({ id: "import.early-build", status: "pass", code: "import.early-build-done", params: { built: 3, total: 3 } }));
  });

  it("IMPORT does not pass while images are still to be built", async () => {
    const { w } = safetyWorld(items);
    wire(w, { prebuild: async () => Promise.reject(new Error("docker build failed")) });
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyBuild" }) });
    expect(w.stepStatus(id, "IMPORT")).toBe("FAILED");
    expect(w.store.row(id).failureCode).toBe("import.early-build-failed");
    expect(w.port.deploys).toHaveLength(0);
  });

  it("a retry rebuilds only the images that are not built yet", async () => {
    const { w } = safetyWorld(items);
    let broken = true;
    wire(w, { prebuild: async (id) => (broken && w.port.apps.get(id)!.name === "api" ? Promise.reject(new Error("x")) : { built: true }) });
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyBuild" }) });
    expect(w.stepStatus(id, "IMPORT")).toBe("FAILED");
    const before = callsOf(w, "prebuild:").length;
    broken = false;
    await w.service.retry(ACTOR, id, "IMPORT", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    const again = callsOf(w, "prebuild:").slice(before);
    expect(again.sort()).toEqual([`prebuild:${idOf(w, "api")}`, `prebuild:${idOf(w, "queue-worker")}`].sort()); // `web` was built before the failure and is not built again
  });

  it("an app with nothing to build (an image app) is simply recorded, not an error", async () => {
    const { w } = safetyWorld(items);
    wire(w, { prebuild: async () => ({ built: false }) });
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyBuild" }) });
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("builds run deployConcurrency at a time per TARGET server, the servers in parallel", async () => {
    const run = async (serverMap: Record<string, string> | undefined, n: number) => {
      const { w } = safetyWorld(items.slice(0, 2).concat(item("app:src-b:c", "c", { source: "GIT", domain: "c.example.test" }), item("app:src-b:d", "d", { source: "GIT", domain: "d.example.test" })));
      for (const [sid, name] of [["srv2", "host-2"], ["srv3", "host-3"]] as const) w.env.serversById.set(sid, { id: sid, name, teamId: TEAM });
      const serverOf = (name: string) => (serverMap ? (["web", "api"].includes(name) ? "srv2" : "srv3") : "srv1");
      let now = 0;
      let max = 0;
      const per = new Map<string, number>();
      const maxPer = new Map<string, number>();
      wire(w, {
        prebuild: async (id) => {
          const sv = serverOf(w.port.apps.get(id)!.name);
          now++;
          per.set(sv, (per.get(sv) ?? 0) + 1);
          max = Math.max(max, now);
          maxPer.set(sv, Math.max(maxPer.get(sv) ?? 0, per.get(sv)!));
          for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
          now--;
          per.set(sv, per.get(sv)! - 1);
          return { built: true };
        },
      });
      const id = await w.run({ ...(serverMap ? { serverMap } : {}), options: earlyOpts(w, { deployWaves: "earlyBuild", deployConcurrency: n }) });
      expect(w.status(id)).toBe("COMPLETED");
      return { max, maxPer: Object.fromEntries(maxPer) };
    };
    expect((await run(undefined, 1)).max).toBe(1);
    expect((await run(undefined, 2)).max).toBe(2);
    const multi = await run({ "src-a": "srv2", "src-b": "srv3" }, 1);
    expect(multi.max).toBe(2);
    expect(multi.maxPer).toEqual({ srv2: 1, srv3: 1 });
  });

  it("an abort mid-build stops cleanly: nothing was started, so nothing needs stopping", async () => {
    const { w } = safetyWorld(items, undefined, { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } });
    wire(w);
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyBuild" }) });
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(callsOf(w, "stopApp:").some((c) => c.endsWith(idOf(w, "queue-worker")))).toBe(false);
  });
});

describe("IMPORT earlyStateless never starts a held worker (R26/C13)", () => {
  it("deploys the stateless apps that serve traffic, not the queue worker", async () => {
    const { w } = safetyWorld(items);
    const id = await w.run({ options: earlyOpts(w, { deployWaves: "earlyStateless" }) });
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.deploys.map((d) => d.appId).sort()).toEqual([idOf(w, "api"), idOf(w, "web")].sort());
    const comp = w.store.step(id, "IMPORT").compensation as { earlyAppIds: string[] };
    expect(comp.earlyAppIds).not.toContain(idOf(w, "queue-worker"));
  });
});

describe("IMPORT pins floating images before any deploy path (R11)", () => {
  const DIGEST = `sha256:${"e".repeat(64)}`;
  const imgItems = [
    item("app:src-a:img", "proxy", { source: "IMAGE", image: "ghcr.io/example/imageproxy:latest", domain: "img.example.test" }),
    item("app:src-a:tunnel", "tunnel-agent", { source: "IMAGE", image: "ghcr.io/example/tunnel", domain: null }),
  ];
  const pins = [
    { kind: "image-pin" as const, key: "ghcr.io/example/imageproxy:latest", scope: "src-a", value: DIGEST, evidence: "host-loop-reported" as const },
    { kind: "image-pin" as const, key: "ghcr.io/example/tunnel", scope: "", value: DIGEST, evidence: "operator-attested" as const },
  ];
  const record = (w: SafetyWorld) => {
    const pinned: Array<[string, string]> = [];
    const done = new Set<string>();
    (w.port as unknown as { pinImage: unknown }).pinImage = async (_u: string, appId: string, digest: string) => {
      w.port.calls.push(`pin:${appId}`);
      if (done.has(appId)) return { pinned: false };
      done.add(appId);
      pinned.push([w.port.apps.get(appId)!.name, digest]);
      return { pinned: true };
    };
    return pinned;
  };

  it("an app the early wave deploys, and a worker that is only released after the point of no return, are both pinned first", async () => {
    const hints = new InMemoryRunHints();
    const { w } = safetyWorld(imgItems, hints);
    const pinned = record(w);
    const id = await w.create({ options: earlyOpts(w, { deployWaves: "earlyStateless" }) });
    await hints.upsert(id, pins);
    await w.start(id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
    // the held worker (no domain) is pinned at IMPORT although nothing deploys it before the cutover
    expect(pinned.sort()).toEqual([["proxy", DIGEST], ["tunnel-agent", DIGEST]]);
    const firstDeploy = w.port.calls.findIndex((c) => c.startsWith("deploy:"));
    expect(w.port.calls.filter((c) => c.startsWith("pin:")).length).toBeGreaterThan(0);
    expect(w.port.calls.findIndex((c) => c.startsWith("pin:") && c.endsWith(idOf(w, "tunnel-agent")))).toBeLessThan(firstDeploy);
    expect(w.port.calls.findIndex((c) => c.startsWith("pin:") && c.endsWith(idOf(w, "proxy")))).toBeLessThan(firstDeploy);
    expect(w.port.deploys.map((d) => d.appId)).toEqual([idOf(w, "proxy")]); // the worker stays stopped
  });

  it("the step does not pass until the pins are applied, and a failing pin fails it retryably", async () => {
    const hints = new InMemoryRunHints();
    const { w } = safetyWorld(imgItems, hints);
    record(w);
    let fail = true;
    const orig = (w.port as unknown as { pinImage: (u: string, a: string, d: string) => Promise<{ pinned: boolean }> }).pinImage;
    (w.port as unknown as { pinImage: unknown }).pinImage = async (u: string, a: string, d: string) => {
      if (fail) throw new Error("registry denied");
      return orig(u, a, d);
    };
    const id = await w.create();
    await hints.upsert(id, pins);
    await w.start(id);
    await w.settle(id);
    expect(w.store.row(id).failureCode).toBe("import.image-pin.failed");
    expect(w.port.deploys).toEqual([]);
    fail = false;
    await w.service.retry(ACTOR, id, "IMPORT", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("an image on a version tag is never touched, even when a digest was recorded for that exact ref", async () => {
    const hints = new InMemoryRunHints();
    const { w } = safetyWorld([item("app:src-a:v", "versioned", { source: "IMAGE", image: "ghcr.io/example/app:1.2.3", domain: "v.example.test" })], hints);
    const pinned = record(w);
    const id = await w.create();
    await hints.upsert(id, [{ kind: "image-pin", key: "ghcr.io/example/app:1.2.3", scope: "", value: DIGEST, evidence: "operator-attested" }]);
    await w.start(id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
    expect(pinned).toEqual([]);
    expect(w.port.calls.some((c) => c.startsWith("pin:"))).toBe(false);
  });
});
