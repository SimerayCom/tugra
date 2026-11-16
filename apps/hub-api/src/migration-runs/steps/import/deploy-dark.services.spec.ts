import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld } from "../../core/testing/run-world";
import type { ServiceStartMode } from "../../core/run-contract";
import { InMemoryRunHints } from "./baseline/run-hints";
import type { ImportStepsPort, ServiceLink } from "./import-ports";
import { planServiceStart, type ServiceFacts } from "./deploy-dark-services";
import { item, safetyWorld } from "./testing/safety-world";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

// Neutral invented names: a search-engine service and a converter service, a web app that needs the first, a worker.
const items = [item("app:_:web", "web", { source: "GIT", domain: "web.example.test" }), item("app:_:queue", "queue-worker", { source: "GIT", domain: null })];

interface Svc {
  name: string;
  /** names of the apps that joined the service's network */
  deps: string[];
  minio?: boolean;
  /** the service serves public domains of its own (no private network) */
  pub?: boolean;
  pending?: boolean;
  /** the import created it on hold (a tunnel connector) */
  hold?: boolean;
}

/** The op's imported services: a stopped compose app each (as the importer leaves them) plus the port's `serviceLinks`. */
function withServices(w: RunWorld, services: Svc[]): { pending: Set<string> } {
  const pending = new Set(services.filter((s) => s.pending).map((s) => s.name));
  for (const s of services) w.port.apps.set(`svc-${s.name}`, { id: `svc-${s.name}`, name: s.name, status: "NEW" });
  const idOf = (name: string) => [...w.port.apps.values()].find((a) => a.name === name && !a.id.startsWith("svc-"))?.id;
  (w.port as ImportStepsPort).serviceLinks = async (): Promise<ServiceLink[]> =>
    services.map((s) => ({ itemRef: `service:_:${s.name}`, appId: `svc-${s.name}`, name: s.name, objectStore: !!s.minio, dependants: s.deps.map(idOf).filter((x): x is string => !!x), dataPending: pending.has(s.name), public: !!s.pub, hold: !!s.hold }));
  return { pending };
}
const deploys = (w: RunWorld) => w.port.deploys.map((d) => w.port.apps.get(d.appId)!.name);
const options = (w: RunWorld, o: { serviceStart: ServiceStartMode }) => ({ ...w.createBody().options, ...o });
const dd = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "DEPLOY_DARK")!;

describe("DEPLOY_DARK services (C14/R30)", () => {
  const svcs: Svc[] = [{ name: "search", deps: ["web"] }, { name: "converter", deps: [] }];

  it("by default starts the service a dark app depends on BEFORE that app and keeps the unused one stopped", async () => {
    const { w } = safetyWorld(items);
    withServices(w, svcs);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(deploys(w)).toEqual(["search", "web"]); // the service first, then the app; the unused service and the held worker never
    expect(w.port.apps.get("svc-converter")!.status).toBe("NEW");
    expect(w.port.deploys.find((d) => d.appId === "svc-search")!.key).toBe(`migrun:${id}:svc-search`);
    const step = await dd(w, id);
    expect(step.gate!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "deploy-dark.services-kept", params: { count: 1 } }), expect.objectContaining({ code: "deploy-dark.services-summary", params: { services: 1, servicesUp: 1, kept: 1 } })]));
    expect(step.progress).toMatchObject({ done: 2, total: 2 });
  });

  it("the apps wait until the service RUNS: with its deploy still queued no app is deployed", async () => {
    const { w } = safetyWorld(items);
    withServices(w, svcs);
    w.port.queueDeploys = true;
    const id = await w.create();
    await w.start(id);
    const pass = w.engine.drive(id);
    for (let i = 0; i < 2000 && w.port.deploys.length < 1; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    expect(deploys(w)).toEqual(["search"]); // the web app is held behind the service
    w.port.settleDeploys();
    w.port.queueDeploys = false;
    for (let i = 0; i < 2000 && !deploys(w).includes("web"); i++) await new Promise((r) => setImmediate(r));
    expect(deploys(w)).toEqual(["search", "web"]);
    w.engine.interrupt(id);
    await pass;
  });

  it("serviceStart none starts no service and all starts every one", async () => {
    const a = safetyWorld(items);
    withServices(a.w, svcs);
    const ida = await a.w.run({ options: options(a.w, { serviceStart: "none" }) });
    expect(a.w.status(ida)).toBe("COMPLETED");
    expect(deploys(a.w)).toEqual(["web"]);
    const b = safetyWorld(items);
    withServices(b.w, svcs);
    const idb = await b.w.run({ options: options(b.w, { serviceStart: "all" }) });
    expect(b.w.status(idb)).toBe("COMPLETED");
    expect(deploys(b.w).slice(0, 2).sort()).toEqual(["converter", "search"]);
    expect(deploys(b.w).at(-1)).toBe("web");
  });

  it("serviceStart all never starts a held tunnel connector service", async () => {
    const { w } = safetyWorld(items);
    withServices(w, [{ name: "tunnel", deps: [], pub: true, hold: true }, { name: "search", deps: ["web"] }]);
    const id = await w.run({ options: options(w, { serviceStart: "all" }) });
    expect(w.status(id)).toBe("COMPLETED");
    expect(deploys(w)).toEqual(["search", "web"]);
    expect(w.port.apps.get("svc-tunnel")!.status).toBe("NEW");
  });

  it("a service only a held worker needs stays stopped: the worker does not run before the cutover", async () => {
    const { w } = safetyWorld(items);
    withServices(w, [{ name: "mailer-queue", deps: ["queue-worker"] }, { name: "search", deps: ["web"] }]);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(deploys(w)).toEqual(["search", "web"]);
  });

  it("an object store a dark app depends on is started under every policy (the app was rewritten to it); one nobody uses only under mirror", async () => {
    const store: Svc[] = [{ name: "object-store", deps: ["web"], minio: true }];
    const a = safetyWorld(items);
    withServices(a.w, store);
    await a.w.run();
    expect(deploys(a.w)).toEqual(["object-store", "web"]);
    const idle = safetyWorld(items);
    withServices(idle.w, [{ name: "idle-store", deps: [], minio: true }]);
    await idle.w.run();
    expect(deploys(idle.w)).toEqual(["web"]);
    const b = safetyWorld(items);
    withServices(b.w, store);
    const id = await b.w.run({ inputs: { minioPolicy: "mirror" } });
    expect(b.w.status(id)).toBe("COMPLETED");
    expect(deploys(b.w)).toEqual(["object-store", "web"]);
  });

  it("a service with public domains of its own is started too (its cutover hosts would otherwise park on a stopped service), before the apps", async () => {
    const { w } = safetyWorld(items);
    withServices(w, [{ name: "public-search", deps: [], pub: true }, { name: "converter", deps: [] }]);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(deploys(w)).toEqual(["public-search", "web"]);
    expect(w.port.apps.get("svc-converter")!.status).toBe("NEW");
  });

  it("a service whose data has not arrived is never started on an empty volume: the step fails and nothing is deployed", async () => {
    const { w } = safetyWorld(items);
    const { pending } = withServices(w, [{ name: "search", deps: ["web"], pending: true }]);
    const id = await w.create();
    await w.start(id);
    await w.settle(id);
    expect(w.store.row(id).failureCode).toBe("deploy-dark.service-data-pending");
    expect(w.port.deploys).toEqual([]);
    pending.clear(); // the data finished
    await w.service.retry(ACTOR, id, "DEPLOY_DARK", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(deploys(w)).toEqual(["search", "web"]);
  });

  it("a failed service deploy stops the step before any app; retry deploys it again under a NEW numbered key", async () => {
    const { w } = safetyWorld(items);
    withServices(w, svcs);
    w.port.failDeployApps.add("svc-search");
    const id = await w.create();
    await w.start(id);
    await w.settle(id);
    expect(w.store.row(id).failureCode).toBe("deploy-dark.service-failed");
    expect(deploys(w)).toEqual(["search"]);
    await w.service.retry(ACTOR, id, "DEPLOY_DARK", {});
    await w.settle(id, "retry");
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.deploys.filter((d) => d.appId === "svc-search").map((d) => d.key)).toEqual([`migrun:${id}:svc-search`, `migrun:${id}:svc-search:1`]);
  });

  it("an abort stops the services this step started along with the apps and databases", async () => {
    const { w } = safetyWorld(items, new InMemoryRunHints(), { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } });
    withServices(w, svcs);
    const id = await w.run();
    const comp = w.store.step(id, "DEPLOY_DARK").compensation as { appIds: string[]; serviceIds: string[] };
    expect(comp.serviceIds).toEqual(["svc-search"]);
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(w.port.apps.get("svc-search")!.status).toBe("STOPPED");
    expect(w.port.calls.some((c) => c === "stopApp:svc-converter")).toBe(false); // never started, never stopped
  });

  it("a port that cannot say which services exist starts none (the old behaviour)", async () => {
    const { w } = safetyWorld(items);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(deploys(w)).toEqual(["web"]);
  });

  it("the dry-run reports the choice and writes nothing", async () => {
    const { w } = safetyWorld([...items, { itemRef: "service:_:search", kind: "service", name: "search", proposed: {}, risks: [], dependsOn: [] } as never]);
    const id = await w.create({ dryRun: true, options: options(w, { serviceStart: "all" }) });
    await w.settle(id);
    expect((await dd(w, id)).progress?.dryRun).toEqual(expect.arrayContaining([{ code: "deploy-dark.service-start", level: "info", params: { mode: "all", services: 1 } }]));
    expect(w.port.calls).toEqual([]);
  });
});

describe("planServiceStart", () => {
  const link = (name: string, deps: string[], o: Partial<ServiceLink> = {}): ServiceFacts => ({ link: { itemRef: `service:_:${name}`, appId: `a-${name}`, name, objectStore: false, dependants: deps, dataPending: false, ...o }, name, status: "NEW", exists: true, deployments: [], server: "srv" });
  const names = new Map([["w1", "web"], ["w2", "api"]]);
  it("is sorted by name, lists the dark apps that need each service and ignores the ones that are not required", () => {
    const rows = planServiceStart("dependencies", "hold", [link("zeta", ["w2", "w1"]), link("alpha", ["held"]), link("beta", [])], new Set(["w1", "w2"]), names);
    expect(rows.map((r) => [r.name, r.start, r.why])).toEqual([["alpha", false, "unused"], ["beta", false, "unused"], ["zeta", true, "dependency"]]);
    expect(rows[2].dependants).toEqual(["api", "web"]);
  });
  it("none and all ignore the dependencies; an object store needs the mirror policy unless every service is asked for", () => {
    const f = [link("a", ["w1"]), link("store", ["w1"], { objectStore: true })];
    expect(planServiceStart("none", "mirror", f, new Set(["w1"]), names).every((r) => !r.start)).toBe(true);
    expect(planServiceStart("all", "hold", f, new Set(), names).every((r) => r.start)).toBe(true);
    for (const p of ["hold", "external", "mirror"] as const) expect(planServiceStart("dependencies", p, f, new Set(["w1"]), names).map((r) => [r.name, r.why])).toEqual([["a", "dependency"], ["store", "dependency"]]);
    const idle = [link("idle-store", [], { objectStore: true })];
    expect(planServiceStart("dependencies", "hold", idle, new Set(["w1"]), names)[0]).toMatchObject({ start: false, why: "minio-held" });
    expect(planServiceStart("dependencies", "external", idle, new Set(["w1"]), names)[0].start).toBe(false);
    expect(planServiceStart("dependencies", "mirror", idle, new Set(["w1"]), names)[0].start).toBe(false); // nobody depends on it and it has no domain
    // a held dependant is not required, so it does not pull the store up
    expect(planServiceStart("dependencies", "hold", f, new Set(), names).every((r) => !r.start)).toBe(true);
  });
  it("a HELD service (tunnel connector) never starts, in any mode: a second connector on the live tunnel would split production traffic", () => {
    const f = [link("tunnel", [], { hold: true, public: true }), link("search", ["w1"])];
    for (const mode of ["dependencies", "all"] as const) {
      const rows = planServiceStart(mode, "hold", f, new Set(["w1"]), names);
      expect(rows.find((r) => r.name === "tunnel")).toMatchObject({ start: false, why: "held" });
      expect(rows.find((r) => r.name === "search")!.start).toBe(true);
    }
    expect(planServiceStart("none", "hold", f, new Set(["w1"]), names).every((r) => !r.start)).toBe(true);
  });
  it("a service with public domains of its own starts in dependencies mode (its hosts are cutover hosts), a held or domain-less one does not", () => {
    const f = [link("public-search", [], { public: true }), link("plain", []), link("public-store", [], { public: true, objectStore: true })];
    const rows = planServiceStart("dependencies", "hold", f, new Set(["w1"]), names);
    expect(rows.map((r) => [r.name, r.start, r.why])).toEqual([["plain", false, "unused"], ["public-search", true, "public"], ["public-store", false, "minio-held"]]);
    expect(planServiceStart("dependencies", "mirror", f, new Set(["w1"]), names).find((r) => r.name === "public-store")).toMatchObject({ start: true, why: "public" });
    expect(planServiceStart("none", "hold", f, new Set(), names).every((r) => !r.start)).toBe(true);
  });
});
