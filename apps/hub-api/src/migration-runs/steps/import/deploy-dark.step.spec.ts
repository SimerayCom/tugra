import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld } from "../../core/testing/run-world";

// the specs drive a whole run through the engine on a fake clock; give a loaded CI machine room
jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const dd = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "DEPLOY_DARK")!;

describe("DEPLOY_DARK", () => {
  it("starts the databases first, then deploys each app once under migrun:<run>:<app>, services excluded", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    const order = w.port.calls.filter((c) => c.startsWith("startDb:") || c.startsWith("deploy:"));
    expect(order[0].startsWith("startDb:")).toBe(true);
    expect(order.slice(1).every((c) => c.startsWith("deploy:"))).toBe(true);
    const keys = w.port.deploys.map((d) => d.key);
    expect(keys).toHaveLength(2);
    for (const d of w.port.deploys) expect(d.key).toBe(`migrun:${id}:${d.appId}`);
    expect([...w.port.apps.values()].every((a) => a.status === "RUNNING")).toBe(true);
    const comp = w.store.step(id, "DEPLOY_DARK").compensation as { dbIds: string[]; appIds: string[] };
    expect(comp.dbIds).toHaveLength(1);
    expect(comp.appIds).toHaveLength(2);
    expect((await dd(w, id)).progress).toMatchObject({ unit: "app", done: 3, total: 3 });
  });

  it("an offline target agent parks the step on a gate and nothing is started", async () => {
    const w = new RunWorld();
    let online = true;
    const orig = w.port.target.bind(w.port);
    // PREFLIGHT (which asks about the plan's hosts) sees the agent online; DEPLOY_DARK (no hosts) finds it dropped
    w.port.target = async (u, i) => ({ ...(await orig(u, i)), agentOnline: (i?.hosts.length ?? 0) > 0 ? true : online });
    online = false;
    const id = await w.create();
    await w.start(id);
    await w.settle(id);
    expect(w.stepStatus(id, "DEPLOY_DARK")).toBe("WAITING_OPERATOR");
    expect((await w.view(id)).nextAction).toMatchObject({ kind: "gate", stepKey: "DEPLOY_DARK", code: "deploy-dark.agent-offline" });
    expect(w.port.calls.some((c) => c.startsWith("startDb") || c.startsWith("deploy:"))).toBe(false);
    online = true;
    await w.tick();
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a database that fails to start fails the step before any app is deployed", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await w.start(id);
    w.port.failStartDb.add("database-2");
    await w.settle(id);
    expect(w.store.row(id).failureCode).toBe("deploy-dark.db-failed");
    expect(w.port.calls.some((c) => c.startsWith("deploy:"))).toBe(false);
    w.port.failStartDb.clear();
    await w.service.retry(ACTOR, id, "DEPLOY_DARK", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a failed app deploy stops the step; retry deploys it again under a NEW numbered key (the old row never re-runs)", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await w.start(id);
    w.port.failDeployApps.add("app-3");
    await w.settle(id);
    expect(w.store.row(id).failureCode).toBe("deploy-dark.app-failed");
    expect(w.port.deploys.find((d) => d.appId === "app-3")).toMatchObject({ key: `migrun:${id}:app-3`, status: "FAILED" });
    await w.service.retry(ACTOR, id, "DEPLOY_DARK", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.deploys.filter((d) => d.appId === "app-3").map((d) => d.key)).toEqual([`migrun:${id}:app-3`, `migrun:${id}:app-3:1`]);
    expect(w.port.deploys.filter((d) => d.appId !== "app-3")).toHaveLength(1);
  });

  it("deploys in batches of three and re-enters until every app is up", async () => {
    const w = new RunWorld();
    const items = Array.from({ length: 7 }, (_, i) => ({ itemRef: `app:_:a${i}`, kind: "app" as const, name: `app-${i}`, proposed: {}, risks: [], dependsOn: [] }));
    w.port.plan_ = { ...w.port.plan_, items };
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.deploys).toHaveLength(7);
    expect(new Set(w.port.deploys.map((d) => d.key)).size).toBe(7);
  });

  it("a deploy whose idempotency key was taken by someone else is refused (never adopts a foreign deployment)", async () => {
    const w = new RunWorld();
    const orig = w.port.deploy.bind(w.port);
    w.port.deploy = async (u, a, k) => ({ ...(await orig(u, a, k))!, requestedBy: "somebody-else" });
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("deploy-dark.key-collision");
  });

  it("abort stops exactly the apps and databases the step recorded, never removes them", async () => {
    const w = new RunWorld({ stubs: { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    const comp = w.store.step(id, "DEPLOY_DARK").compensation as { dbIds: string[]; appIds: string[] };
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    const stops = w.port.calls.filter((c) => c.startsWith("stopApp:") || c.startsWith("stopDb:")).sort();
    expect(stops).toEqual([...comp.appIds.map((a) => `stopApp:${a}`), ...comp.dbIds.map((d) => `stopDb:${d}`)].sort());
    expect(w.stepStatus(id, "DEPLOY_DARK")).toBe("COMPENSATED");
    expect(w.port.calls.some((c) => c.startsWith("rollback"))).toBe(false);
  });

  it("a failed stop during abort fails the abort (retryable) instead of pretending Coolify is authoritative", async () => {
    const w = new RunWorld({ stubs: { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    const orig = w.port.stopApp.bind(w.port);
    w.port.stopApp = async () => {
      throw new Error("agent offline");
    };
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("FAILED");
    expect(w.store.row(id).failureCode).toBe("deploy-dark.stop-failed");
    w.port.stopApp = orig;
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
  });

  it("abort while deploys are still QUEUED cancels them: no app comes up after the run is ABORTED", async () => {
    const w = new RunWorld();
    w.port.queueDeploys = true;
    const id = await w.create();
    await w.start(id);
    const pass = w.engine.drive(id);
    for (let i = 0; i < 2000 && w.port.deploys.length < 2; i++) await new Promise((r) => setImmediate(r));
    expect(w.port.deploys.map((d) => d.status)).toEqual(["QUEUED", "QUEUED"]);
    await w.service.abort(ACTOR, id, { confirmName: id });
    w.engine.interrupt(id);
    await pass;
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(w.port.calls.filter((c) => c.startsWith("cancelDeploy:"))).toHaveLength(2);
    w.port.settleDeploys(); // the queue drains once the abort is over
    expect([...w.port.apps.values()].some((a) => a.status === "RUNNING")).toBe(false);
  });

  it("abort with a deployment that cannot be cancelled fails retryably, and a second abort stops the app once it settled", async () => {
    const w = new RunWorld();
    w.port.queueDeploys = true;
    w.port.runQueued = true; // a build in flight: RUNNING, not cancellable
    const id = await w.create();
    await w.start(id);
    const pass = w.engine.drive(id);
    for (let i = 0; i < 2000 && w.port.deploys.length < 2; i++) await new Promise((r) => setImmediate(r));
    await w.service.abort(ACTOR, id, { confirmName: id });
    w.engine.interrupt(id);
    await pass;
    await w.settle(id);
    expect(w.status(id)).toBe("FAILED");
    expect(w.store.row(id).failureCode).toBe("deploy-dark.deploy-active");
    w.port.settleDeploys(); // the deployments finish: the apps are RUNNING now
    expect([...w.port.apps.values()].every((a) => a.status === "RUNNING")).toBe(true);
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect([...w.port.apps.values()].some((a) => a.status === "RUNNING")).toBe(false);
  });

  it("a database left PROVISIONING by a dead hub fails the step after the patience instead of polling forever; retry provisions it again", async () => {
    const w = new RunWorld();
    let stuck = true;
    const origState = w.port.dbState.bind(w.port);
    w.port.dbState = async (u, dbId) => {
      const s = await origState(u, dbId);
      return stuck && s.exists && s.status !== "RUNNING" ? { ...s, status: "PROVISIONING" } : s;
    };
    const origStart = w.port.startDb.bind(w.port);
    w.port.startDb = async (u, dbId) => {
      stuck = false;
      return origStart(u, dbId);
    };
    const id = await w.create();
    await w.start(id);
    await w.settle(id);
    expect(w.store.row(id).failureCode).toBe("deploy-dark.db-stuck");
    expect((await dd(w, id)).allowed.retry).toBe(true);
    expect(w.port.calls.some((c) => c.startsWith("startDb:") || c.startsWith("deploy:"))).toBe(false);
    expect(w.clock.t).toBeGreaterThanOrEqual(Date.parse("2026-11-23T08:10:00.000Z"));
    await w.service.retry(ACTOR, id, "DEPLOY_DARK", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.calls.filter((c) => c.startsWith("startDb:"))).toHaveLength(1);
  });

  it("dry-run projects the order from the plan and writes nothing", async () => {
    const w = new RunWorld();
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    expect((await dd(w, id)).progress!.dryRun).toEqual([{ code: "deploy-dark.order", level: "info", params: { databases: 1, apps: 2, services: 0 } }]);
    expect(w.port.calls).toEqual([]);
  });
});
