import { StepDriver, makeRun } from "../../cutover/testing/step-driver";
import { OwnerInputsSchema, RunOptionsSchema } from "../../../core/dto";
import type { ImportStepsPort, OpSnapshot } from "../import-ports";
import { InMemoryRunHints } from "./run-hints";
import { PostPonrRelease, heldAutoDeployIds } from "./post-ponr";
import { buildSourceBaseline } from "./source-health";

const PONR = new Date("2026-11-20T09:00:00Z");

/** The few port calls the release makes, over a handful of apps: `web` (domain), `queue` and `mail` (no domain, workers). */
function fakePort() {
  const names: Record<string, string> = { a1: "web", a2: "queue", a3: "mail" };
  const switches = new Map<string, boolean>([["a1", false], ["a2", false], ["a3", false]]);
  const status = new Map<string, string>([["a1", "RUNNING"], ["a2", "NEW"], ["a3", "NEW"]]);
  const deploys: Array<{ appId: string; id: string; key: string; status: string; requestedBy: string }> = [];
  const calls: string[] = [];
  const failDeploy = new Set<string>();
  const op: OpSnapshot = {
    id: "op1",
    rolledBack: false,
    cancelRequested: false,
    tasks: ["a1", "a2", "a3"].map((id, i) => ({ itemRef: `app:_:${id}`, kind: "app", status: "DONE", resourceType: "application", resourceId: id, name: names[id], gitStatus: null, i } as never)),
    planItems: [
      { itemRef: "app:_:a1", kind: "app", dependsOn: [], domain: "web.example.test", image: null },
      { itemRef: "app:_:a2", kind: "app", dependsOn: [], domain: null, image: "ghcr.io/example/queue:latest" },
      { itemRef: "app:_:a3", kind: "app", dependsOn: [], domain: null, image: null },
    ],
  };
  const port = {
    opSnapshot: async () => op,
    appState: async (_u: string, id: string) => ({ exists: status.has(id), status: status.get(id) ?? "NEW", name: names[id] ?? null }),
    deployments: async (appId: string, prefix: string) => deploys.filter((d) => d.appId === appId && d.key.startsWith(prefix)).map(({ appId: _a, ...d }) => ({ ...d, trigger: "manual" })),
    deploy: async (u: string, appId: string, key: string) => {
      const prior = deploys.find((d) => d.appId === appId && d.key === key);
      if (prior) return { ...prior, trigger: "manual" };
      calls.push(`deploy:${appId}`);
      const failed = failDeploy.has(appId);
      const d = { appId, id: `dep-${deploys.length + 1}`, key, status: failed ? "FAILED" : "SUCCESS", requestedBy: u };
      deploys.push(d);
      if (!failed) status.set(appId, "RUNNING");
      return { ...d, trigger: "manual" };
    },
    cancelDeployment: async () => undefined,
    stopApp: async (_u: string, id: string) => {
      calls.push(`stop:${id}`);
      status.set(id, "STOPPED");
    },
    pinImage: async (_u: string, id: string, digest: string) => {
      calls.push(`pin:${id}:${digest}`);
      return { pinned: true };
    },
    autoDeployState: async (_u: string, id: string) => switches.get(id) ?? null,
    setAutoDeploy: async (_u: string, id: string, v: boolean) => {
      calls.push(`autoDeploy:${id}:${v ? "on" : "off"}`);
      switches.set(id, v);
    },
  };
  return { port: port as unknown as ImportStepsPort, switches, status, deploys, calls, failDeploy };
}

function setup(over: Parameters<typeof makeRun>[0] = {}, held: string[] = ["a1", "a2", "a3"]) {
  const f = fakePort();
  const hints = new InMemoryRunHints();
  const release = new PostPonrRelease(f.port, hints);
  const driver = new StepDriver(makeRun({ ponrAt: PONR, ...over }));
  driver.setStep("IMPORT", { status: "PASSED", compensation: { autoDeployHeld: held } });
  return { ...f, hints, release, driver, ctx: () => driver.contextFor("OBSERVE") };
}

describe("PostPonrRelease.run", () => {
  it("starts the held workers (once, under the run's own key) and leaves the ordinary app alone", async () => {
    const s = setup();
    const r = await s.release.run(s.ctx());
    expect(r).toEqual({ workersStarted: 2, workersFailed: 0, autoDeployRestored: 3 });
    expect(s.deploys.map((d) => [d.appId, d.key]).sort()).toEqual([["a2", "migrun:run1:a2"], ["a3", "migrun:run1:a3"]]);
    expect(s.status.get("a2")).toBe("RUNNING");
    expect(s.driver.eventCodes()).toEqual(expect.arrayContaining(["release.workers-started", "release.auto-deploy-restored", "release.webhooks-repoint"]));
    expect(s.driver.events.find((e) => e.code === "release.workers-started")?.params).toEqual({ count: 2 });
  });

  it("is idempotent: a second release starts nothing, switches nothing and says nothing", async () => {
    const s = setup();
    await s.release.run(s.ctx());
    const events = s.driver.events.length;
    const calls = s.calls.length;
    expect(await s.release.run(s.ctx())).toEqual({ workersStarted: 0, workersFailed: 0, autoDeployRestored: 0 });
    expect(s.driver.events).toHaveLength(events);
    expect(s.calls).toHaveLength(calls);
  });

  it("restores only the switches IMPORT recorded: an app that was off before the run stays off", async () => {
    const s = setup({}, ["a1"]);
    const r = await s.release.run(s.ctx());
    expect(r?.autoDeployRestored).toBe(1);
    expect(s.switches).toEqual(new Map([["a1", true], ["a2", false], ["a3", false]]));
  });

  it("refuses before the point of no return, in a dry-run, and while the run is being aborted, rolled back or reversed", async () => {
    for (const over of [{ ponrAt: null }, { dryRun: true }, { status: "ABORTING" as const }, { status: "ABORTED" as const }, { status: "ROLLING_BACK" as const }, { status: "REVERSING" as const }, { status: "REVERSED" as const }, { opId: null }]) {
      const s = setup(over);
      expect(await s.release.run(s.ctx())).toBeNull();
      expect(s.calls).toEqual([]);
      expect(s.driver.events).toEqual([]);
    }
  });

  it("start-dark and exclude have no held workers to start; push-to-deploy is restored, except for a worker the run excludes", async () => {
    const policy = (v: string) => ({ inputs: OwnerInputsSchema.parse({ workerPolicy: { value: v, source: "request", setBy: "u1", at: "2026-11-20T00:00:00.000Z" } }) });
    const dark = setup(policy("start-dark"));
    expect(await dark.release.run(dark.ctx())).toEqual({ workersStarted: 0, workersFailed: 0, autoDeployRestored: 3 });
    expect(dark.deploys).toEqual([]);
    // a2 and a3 are excluded workers: Tugra created them but a push must never deploy what this run promised not to run
    const excl = setup(policy("exclude"));
    expect(await excl.release.run(excl.ctx())).toEqual({ workersStarted: 0, workersFailed: 0, autoDeployRestored: 1 });
    expect(excl.deploys).toEqual([]);
    expect(excl.switches).toEqual(new Map([["a1", true], ["a2", false], ["a3", false]]));
  });

  it("an operator mark decides what a worker is", async () => {
    const s = setup();
    await s.hints.upsert("run1", [
      { kind: "worker-mark", key: "app:_:a2", scope: "", value: "web", evidence: "operator-attested" },
      { kind: "worker-mark", key: "app:_:a1", scope: "", value: "job-runner", evidence: "operator-attested" }, // a1 serves a domain: the mark cannot hold it
    ]);
    await s.release.run(s.ctx());
    expect(s.deploys.map((d) => d.appId).sort()).toEqual(["a3"]);
  });

  it("a worker that fails to start is reported once and is not rebuilt in a loop", async () => {
    const s = setup();
    s.failDeploy.add("a3");
    const r = await s.release.run(s.ctx());
    expect(r).toMatchObject({ workersStarted: 1, workersFailed: 1 });
    expect(s.driver.events.filter((e) => e.code === "release.worker-failed").map((e) => e.params)).toEqual([{ name: "mail" }]);
    const again = await s.release.run(s.ctx());
    expect(again).toMatchObject({ workersStarted: 0, workersFailed: 1 });
    expect(s.deploys.filter((d) => d.appId === "a3")).toHaveLength(1);
    expect(s.driver.events.filter((e) => e.code === "release.worker-failed")).toHaveLength(1);
  });

  it("starts workers deployConcurrency at a time", async () => {
    const s = setup({ options: RunOptionsSchema.parse({ deployConcurrency: 1 }) });
    let now = 0;
    let max = 0;
    const orig = (s.port as unknown as { deploy: (u: string, a: string, k: string) => Promise<unknown> }).deploy;
    (s.port as unknown as { deploy: unknown }).deploy = async (u: string, a: string, k: string) => {
      now++;
      max = Math.max(max, now);
      await new Promise((r) => setImmediate(r));
      const d = await orig(u, a, k);
      now--;
      return d;
    };
    await s.release.run(s.ctx());
    expect(max).toBe(1);
    expect(s.deploys).toHaveLength(2);
  });

  it("reads the held ids from IMPORT's compensation and tolerates a missing or garbled one", () => {
    const d = new StepDriver(makeRun());
    d.setStep("IMPORT", { compensation: { autoDeployHeld: ["a", 3, null, "b"] } });
    expect(heldAutoDeployIds(d.contextFor("OBSERVE"))).toEqual(["a", "b"]);
    d.setStep("IMPORT", { compensation: { autoDeployHeld: "x" } });
    expect(heldAutoDeployIds(d.contextFor("OBSERVE"))).toEqual([]);
    d.setStep("IMPORT", { compensation: null });
    expect(heldAutoDeployIds(d.contextFor("OBSERVE"))).toEqual([]);
  });
});

describe("PostPonrRelease.undo (a reverse puts Coolify back in charge)", () => {
  it("stops the workers and switches push-to-deploy back off", async () => {
    const s = setup();
    await s.release.run(s.ctx());
    s.calls.length = 0;
    const r = await s.release.undo(s.ctx());
    expect(r).toEqual({ changed: 5, failed: 0 });
    expect(s.status.get("a2")).toBe("STOPPED");
    expect(s.status.get("a3")).toBe("STOPPED");
    expect(s.status.get("a1")).toBe("RUNNING"); // an ordinary app keeps running dark
    expect([...s.switches.values()]).toEqual([false, false, false]);
  });

  it("is idempotent and counts a failed stop", async () => {
    const s = setup();
    await s.release.run(s.ctx());
    await s.release.undo(s.ctx());
    expect(await s.release.undo(s.ctx())).toEqual({ changed: 0, failed: 0 });
    const s2 = setup();
    await s2.release.run(s2.ctx());
    (s2.port as unknown as { stopApp: unknown }).stopApp = async () => {
      throw new Error("agent offline");
    };
    expect((await s2.release.undo(s2.ctx())).failed).toBe(2);
  });
});

describe("PostPonrRelease: digest pin, verify, retry and the withheld set", () => {
  const D = `sha256:${"c".repeat(64)}`;

  it("pins a held worker's floating image to the recorded digest right before it is started", async () => {
    const s = setup();
    await s.hints.upsert("run1", [{ kind: "image-pin", key: "ghcr.io/example/queue:latest", scope: "", value: D, evidence: "operator-attested" }]);
    await s.release.run(s.ctx());
    const order = s.calls.filter((c) => c.startsWith("pin:") || c === "deploy:a2");
    expect(order).toEqual([`pin:a2:${D}`, "deploy:a2"]);
    expect(s.driver.events.find((e) => e.code === "deploy-dark.image-pinned")?.params).toEqual({ name: "queue" });
  });

  it("verify: running, starting (queued, or not started yet) and failed workers are told apart; the baseline excuses one already failing at the source", async () => {
    const s = setup();
    expect(await s.release.verify(s.ctx())).toMatchObject({ total: 2, running: 0, starting: ["queue", "mail"], failed: [] }); // nothing started yet
    s.failDeploy.add("a3");
    await s.release.run(s.ctx());
    expect(await s.release.verify(s.ctx())).toEqual({ total: 2, running: 1, starting: [], failed: ["mail"], failedAtSource: [] });
    s.driver.run.sourceBaseline = buildSourceBaseline([{ kind: "app", ref: "a3", health: "exited", restartCount: 9 }], new Date("2026-11-20T08:00:00Z"));
    expect(await s.release.verify(s.ctx())).toEqual({ total: 2, running: 1, starting: [], failed: [], failedAtSource: ["mail"] });
  });

  it("verify: a started worker that is not RUNNING, and one whose app vanished, are failures", async () => {
    const s = setup();
    await s.release.run(s.ctx());
    s.status.set("a2", "STOPPED");
    s.status.delete("a3");
    expect(await s.release.verify(s.ctx())).toMatchObject({ running: 0, failed: ["queue", "mail"] });
  });

  it("verify answers null when the run may not release yet, and when there is nothing to hold", async () => {
    for (const over of [{ ponrAt: null }, { dryRun: true }, { status: "ABORTED" as const }, { opId: null }]) {
      const s = setup(over);
      expect(await s.release.verify(s.ctx())).toBeNull();
    }
    const s = setup({ inputs: OwnerInputsSchema.parse({ workerPolicy: { value: "start-dark", source: "request", setBy: "u1", at: "2026-11-20T00:00:00.000Z" } }) });
    expect(await s.release.verify(s.ctx())).toBeNull();
  });

  it("a retry rebuilds a worker whose start failed once, under a new numbered key; a plain pass still does not", async () => {
    const s = setup();
    s.failDeploy.add("a3");
    await s.release.run(s.ctx());
    s.failDeploy.clear();
    await s.release.run(s.ctx());
    expect(s.deploys.filter((d) => d.appId === "a3")).toHaveLength(1);
    const r = await s.release.run(s.ctx(), { retry: true });
    expect(r).toMatchObject({ workersStarted: 1 });
    expect(s.deploys.filter((d) => d.appId === "a3").map((d) => d.key)).toEqual(["migrun:run1:a3", "migrun:run1:a3:1"]);
    expect(await s.release.verify(s.ctx())).toMatchObject({ running: 2, failed: [] });
  });

  it("withheldAppIds names the held and the excluded workers, so nothing else starts them before the cutover", async () => {
    const s = setup();
    expect([...(await s.release.withheldAppIds(s.ctx()))].sort()).toEqual(["a2", "a3"]);
    const ex = setup({ inputs: OwnerInputsSchema.parse({ workerPolicy: { value: "exclude", source: "request", setBy: "u1", at: "2026-11-20T00:00:00.000Z" } }) });
    expect([...(await ex.release.withheldAppIds(ex.ctx()))].sort()).toEqual(["a2", "a3"]);
    const dark = setup({ inputs: OwnerInputsSchema.parse({ workerPolicy: { value: "start-dark", source: "request", setBy: "u1", at: "2026-11-20T00:00:00.000Z" } }) });
    expect([...(await dark.release.withheldAppIds(dark.ctx()))]).toEqual([]);
    const none = setup({ opId: null });
    expect([...(await none.release.withheldAppIds(none.ctx()))]).toEqual([]);
  });
});
