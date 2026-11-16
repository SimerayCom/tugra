import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, SERVER, TEAM } from "../../core/testing/run-world";
import { InMemoryRunHints, type RunHint } from "./baseline/run-hints";
import { item, safetyWorld } from "./testing/safety-world";

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
    const id = await w.create({ options: { ...w.createBody().options, deployConcurrency: 2 } });
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
    const id = await w.create({ options: { ...w.createBody().options, deployConcurrency: 2 } });
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

// ───────────────────────────── grup-7 safety rules ─────────────────────────────

const DIGEST = `sha256:${"d".repeat(64)}`;
const appIdOf = (w: RunWorld, name: string) => [...w.port.apps.values()].find((a) => a.name === name)!.id;
const deployed = (w: RunWorld) => w.port.deploys.map((d) => w.port.apps.get(d.appId)!.name).sort();

describe("DEPLOY_DARK workers (R26/C13)", () => {
  const items = [item("app:_:web", "web", { source: "GIT", domain: "web.example.test" }), item("app:_:queue", "queue-worker", { source: "GIT", domain: null })];

  it("a domainless worker is not deployed before the cutover and does not hold the step back", async () => {
    const { w } = safetyWorld(items);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(deployed(w)).toEqual(["web"]);
    expect(w.port.apps.get(appIdOf(w, "queue-worker"))!.status).toBe("NEW");
    const step = await dd(w, id);
    expect(step.gate!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "deploy-dark.workers-held", params: { count: 1 } }), expect.objectContaining({ code: "deploy-dark.summary", params: expect.objectContaining({ apps: 1, appsUp: 1 }) })]));
    expect(step.progress).toMatchObject({ done: 1, total: 1 });
    const comp = w.store.step(id, "DEPLOY_DARK").compensation as { appIds: string[] };
    expect(comp.appIds).toEqual([appIdOf(w, "web")]); // an abort has nothing of the worker's to stop
  });

  it("an operator mark makes a domain-bearing app a worker and a domainless one a normal app", async () => {
    const { w, hints } = safetyWorld(items);
    const mark = (key: string, value: string): RunHint => ({ kind: "worker-mark", key, scope: "", value, evidence: "operator-attested" });
    await hints.upsert("pending", []);
    const id = await w.create();
    await hints.upsert(id, [mark("app:_:web", "job-runner"), mark("app:_:queue", "web")]);
    await w.start(id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
    expect(deployed(w)).toEqual(["queue-worker"]);
  });

  it("a promoted run reads the marks its dry-run was given", async () => {
    const { w, hints } = safetyWorld(items);
    const dry = await w.create({ dryRun: true });
    await hints.upsert(dry, [
      { kind: "worker-mark", key: "app:_:web", scope: "", value: "job-runner", evidence: "operator-attested" },
      { kind: "worker-mark", key: "app:_:queue", scope: "", value: "web", evidence: "operator-attested" },
    ]);
    await w.settle(dry);
    const real = (await w.service.start(ACTOR, dry, {})).id;
    expect(real).not.toBe(dry);
    await w.settle(real);
    expect(deployed(w)).toEqual(["queue-worker"]);
  });

  it("start-dark deploys the worker like any app; exclude never deploys it", async () => {
    const a = safetyWorld(items);
    const ida = await a.w.run({ inputs: { workerPolicy: "start-dark" } });
    expect(a.w.status(ida)).toBe("COMPLETED");
    expect(deployed(a.w)).toEqual(["queue-worker", "web"]);
    const b = safetyWorld(items);
    const idb = await b.w.run({ inputs: { workerPolicy: "exclude" } });
    expect(b.w.status(idb)).toBe("COMPLETED");
    expect(deployed(b.w)).toEqual(["web"]);
    expect((await dd(b.w, idb)).gate!.checks.map((c) => c.code)).toContain("deploy-dark.workers-excluded");
  });

  it("an app whose plan item does not say whether it has a domain is never held", async () => {
    const { w } = safetyWorld([item("app:_:a", "unknown-domain", { source: "GIT" })]);
    const id = await w.run();
    expect(deployed(w)).toEqual(["unknown-domain"]);
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("an abort before the cutover never starts a worker (and a worker that was never started needs no stop)", async () => {
    const { w } = safetyWorld(items, new InMemoryRunHints(), { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } });
    const id = await w.run();
    expect(w.stepStatus(id, "DEPLOY_DARK")).toBe("PASSED");
    expect(w.status(id)).not.toBe("COMPLETED");
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    const worker = appIdOf(w, "queue-worker");
    expect(w.port.deploys.some((d) => d.appId === worker)).toBe(false);
    expect(w.port.calls.some((c) => c === `stopApp:${worker}`)).toBe(false);
    expect(w.port.apps.get(appIdOf(w, "web"))!.status).toBe("STOPPED"); // the ordinary app was stopped by the abort
    expect(w.port.apps.get(worker)!.status).toBe("NEW");
  });

  it("the dry-run projects the workers it would hold and does not count them as apps", async () => {
    const { w } = safetyWorld(items);
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    const dry = (await dd(w, id)).progress?.dryRun ?? [];
    expect(dry).toEqual(expect.arrayContaining([expect.objectContaining({ code: "deploy-dark.order", params: expect.objectContaining({ apps: 1 }) }), expect.objectContaining({ code: "deploy-dark.workers-held", params: { count: 1 } })]));
  });
});

describe("DEPLOY_DARK image pins (R11)", () => {
  const items = [item("app:src-a:img", "proxy", { source: "IMAGE", image: "ghcr.io/example/imageproxy:latest", domain: "img.example.test" })];

  it("a floating image app is pinned to the digest the source runs before it is deployed", async () => {
    const hints = new InMemoryRunHints();
    const { w } = safetyWorld(items, hints);
    const pinned: Array<[string, string]> = [];
    (w.port as unknown as { pinImage: (u: string, a: string, d: string) => Promise<{ pinned: boolean }> }).pinImage = async (_u, appId, digest) => {
      w.port.calls.push(`pin:${appId}`);
      pinned.push([appId, digest]);
      return { pinned: true };
    };
    const id = await w.create();
    await hints.upsert(id, [{ kind: "image-pin", key: "ghcr.io/example/imageproxy:latest", scope: "src-a", value: DIGEST, evidence: "host-loop-reported" }]);
    await w.start(id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
    expect(pinned).toEqual([[appIdOf(w, "proxy"), DIGEST]]);
    const order = w.port.calls.filter((c) => c.startsWith("pin:") || c.startsWith("deploy:"));
    expect(order[0].startsWith("pin:")).toBe(true);
    expect(order[1].startsWith("deploy:")).toBe(true);
    expect((await w.service.events(ACTOR, id, { afterSeq: 0, limit: 500 })).events.some((e) => e.code === "deploy-dark.image-pinned")).toBe(true);
  });

  it("with no recorded digest the image is deployed as it is (PREFLIGHT made the operator accept that)", async () => {
    const { w } = safetyWorld(items);
    let called = 0;
    (w.port as unknown as { pinImage: () => Promise<{ pinned: boolean }> }).pinImage = async () => {
      called++;
      return { pinned: true };
    };
    const id = await w.run({ acks: [] });
    expect(called).toBe(0);
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_APPROVAL"); // unpinned: needs the operator's acceptance
  });
});

describe("DEPLOY_DARK build concurrency per target server (R25)", () => {
  const items = ["a", "b", "c", "d"].map((n, i) => item(`app:${i < 2 ? "src-a" : "src-b"}:${n}`, `app-${n}`, { source: "GIT", domain: `${n}.example.test` }));

  /** Records how many deploys are in flight at once, overall and per target server. */
  function meter(w: RunWorld, serverOf: (appName: string) => string) {
    let now = 0;
    let max = 0;
    const perServer = new Map<string, number>();
    const maxPer = new Map<string, number>();
    const orig = w.port.deploy.bind(w.port);
    w.port.deploy = async (u, appId, key) => {
      const server = serverOf(w.port.apps.get(appId)!.name);
      now++;
      perServer.set(server, (perServer.get(server) ?? 0) + 1);
      max = Math.max(max, now);
      maxPer.set(server, Math.max(maxPer.get(server) ?? 0, perServer.get(server)!));
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const d = await orig(u, appId, key);
      now--;
      perServer.set(server, perServer.get(server)! - 1);
      return d;
    };
    return { max: () => max, maxPer: () => Object.fromEntries(maxPer) };
  }
  const opts = (w: RunWorld, n: number) => ({ ...w.createBody().options, deployConcurrency: n });
  const serverMap = { "src-a": "srv2", "src-b": "srv3" };
  const withServers = (w: RunWorld) => {
    for (const [id, name] of [["srv2", "host-2"], ["srv3", "host-3"]] as const) w.env.serversById.set(id, { id, name, teamId: TEAM });
  };
  const place = (name: string) => (["app-a", "app-b"].includes(name) ? "srv2" : "srv3");

  it("the default is one build at a time on a server", async () => {
    const { w } = safetyWorld(items);
    const m = meter(w, () => SERVER);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(deployed(w)).toHaveLength(4);
    expect(m.max()).toBe(1);
  });

  it("deployConcurrency allows that many at once on a server", async () => {
    const { w } = safetyWorld(items);
    const m = meter(w, () => SERVER);
    const id = await w.run({ options: opts(w, 2) });
    expect(w.status(id)).toBe("COMPLETED");
    expect(m.max()).toBe(2);
  });

  it("a multi-host run builds on each target server in parallel, but never more than the limit on one", async () => {
    const { w } = safetyWorld(items);
    withServers(w);
    const m = meter(w, place);
    const id = await w.run({ serverMap, options: opts(w, 1) });
    expect(w.status(id)).toBe("COMPLETED");
    expect(m.max()).toBe(2);
    expect(m.maxPer()).toEqual({ srv2: 1, srv3: 1 });
  });

  it("every target server's agent must be online, not only the default one", async () => {
    const { w } = safetyWorld(items);
    withServers(w);
    const orig = w.port.target.bind(w.port);
    w.port.target = async (u, i) => ({ ...(await orig(u, i)), agentOnline: i?.serverId === "srv3" && i.hosts.length === 0 ? false : true });
    const id = await w.run({ serverMap });
    expect(w.stepStatus(id, "DEPLOY_DARK")).toBe("WAITING_OPERATOR");
    expect(w.port.deploys).toHaveLength(0);
  });
});
