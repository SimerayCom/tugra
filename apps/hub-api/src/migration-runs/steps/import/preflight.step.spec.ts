import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, defaultPlan, H32 } from "../../core/testing/run-world";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import { preflightChecks, type PreflightObs } from "./preflight.step";
import { OwnerInputsSchema } from "../../core/dto";
import type { RunSnapshot } from "../../core/run-contract";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { TargetFacts } from "./import-ports";

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const blocker = (code: string): ImportPlanResponse =>
  defaultPlan({
    items: [
      { itemRef: "database:_:db1", kind: "database", name: "pg-main", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
      { itemRef: "app:_:web", kind: "app", name: "web", proposed: { domain: "web.example.com" }, risks: [{ level: "blocker", code, message: "x" }], dependsOn: ["database:_:db1"] },
    ],
  });

const stepOf = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "PREFLIGHT")!;

describe("PREFLIGHT gate", () => {
  it("an all-clear fleet passes without any approval and records hub-verified evidence", async () => {
    const w = new RunWorld();
    const id = await w.run();
    const pre = await stepOf(w, id);
    expect(pre.status).toBe("PASSED");
    expect(pre.gate?.passed).toBe(true);
    const codes = pre.gate!.checks.map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(["preflight.plan-fresh", "preflight.plan-summary", "preflight.agent-online", "preflight.acme-email-ok"]));
    expect(pre.gate!.checks.every((c) => c.evidence === "hub-verified")).toBe(true);
    expect(w.port.calls).toEqual(expect.not.arrayContaining(["cancel"]));
  });

  it("an ackable blocker parks the step on a typed approval; approving it lets the run continue", async () => {
    const w = new RunWorld();
    w.port.plan_ = blocker("app.env.unresolved");
    const id = await w.run();
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_APPROVAL");
    const v = await w.view(id);
    expect(v.nextAction.kind).toBe("approval");
    const b = v.nextAction.approval!;
    expect(b.ackable).toEqual(["preflight.blocker.app.env.unresolved"]);
    expect(b.requiredAcks).toEqual(b.ackable);
    expect(b.ponr).toBe(false);
    // approving without the required ack is refused
    await expect(w.service.approve(ACTOR, id, "PREFLIGHT", { boundHash: b.inputHash, acks: [] })).rejects.toThrow(/acks-required/);
    await expect(w.service.approve(ACTOR, id, "PREFLIGHT", { boundHash: b.inputHash, acks: ["something-else"] })).rejects.toThrow(/ack-not-allowed/);
    await w.service.approve(ACTOR, id, "PREFLIGHT", { boundHash: b.inputHash, acks: b.requiredAcks });
    await w.settle(id, "approve");
    expect(w.status(id)).toBe("COMPLETED");
    const pre = await stepOf(w, id);
    expect(pre.gate!.checks.find((c) => c.id === "preflight.blocker.app.env.unresolved")).toMatchObject({ status: "fail", acked: true });
  });

  it("a blocker the operator already acked in the frozen apply input does not block at all", async () => {
    const w = new RunWorld();
    w.port.plan_ = blocker("app.env.unresolved");
    const id = await w.run({ acks: [{ code: "app.env.unresolved", itemRef: "app:_:web" }] });
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a blocker on an item the mapping excludes is ignored", async () => {
    const w = new RunWorld();
    w.port.plan_ = blocker("db.engine.noImport");
    const mapping = { version: 1 as const, items: { "app:_:web": { include: false } }, projects: {}, gitSources: {}, acks: [] };
    w.port.mappingResult = { version: 1, effective: [], projects: [], gitSources: [], conflicts: [], orphans: [], mappingHash: "f".repeat(32), counts: { renamed: 0, moved: 0, excluded: 1, aliased: 0, newProjects: 0, newEnvironments: 0 } } as ResolvedMapping;
    const id = await w.run({ mapping, mappingHash: "f".repeat(32) });
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a plan that changed since the run was created is a hard, non-ackable failure", async () => {
    const w = new RunWorld();
    const id = await w.create();
    w.port.plan_ = defaultPlan({ planHash: "e".repeat(32) }); // the source changes between create and start
    await w.start(id);
    await w.settle(id);
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_OPERATOR");
    const g = (await stepOf(w, id)).gate!;
    expect(g.checks.find((c) => c.code === "preflight.plan-changed")).toMatchObject({ status: "fail" });
    expect(g.checks.some((c) => c.ackable)).toBe(false);
  });

  it("an expired source session waits for the token to be re-entered (nextAction session) and continues after source-session", async () => {
    const w = new RunWorld();
    w.port.session = "expired";
    const id = await w.run();
    const v = await w.view(id);
    expect(v.nextAction).toMatchObject({ kind: "session", stepKey: "PREFLIGHT" });
    expect(v.allowed.sourceSession).toBe(true);
    const res = await w.service.sourceSession(ACTOR, id, { token: "new-coolify-token" });
    expect(res.sessionId).toMatch(/^s-new-/);
    expect(w.store.row(id).sessionId).toBe(res.sessionId);
    expect(w.env.connects).toEqual([{ baseUrl: "https://coolify.example.com", teamId: "t1" }]);
    expect(JSON.stringify([await w.view(id), w.store.eventRows, w.sink.audits])).not.toContain("new-coolify-token");
    w.port.session = "active";
    await w.tick();
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("source-session falls back to https://<host> when the old session row is gone", async () => {
    const w = new RunWorld();
    const id = await w.create();
    w.env.sessions.delete("s1");
    await w.service.sourceSession(ACTOR, id, { token: "t" });
    expect(w.env.connects[0].baseUrl).toBe("https://coolify.example.com");
  });
});

describe("PREFLIGHT checks (pure)", () => {
  const run = (over: Partial<RunSnapshot> = {}): RunSnapshot =>
    ({
      id: "r1",
      mode: "copy",
      topology: "two-box",
      planHash: H32,
      inputs: OwnerInputsSchema.parse({}),
      applyInput: { sourceKind: "coolify", targetServerId: "srv1", planHash: H32 },
      ...over,
    }) as RunSnapshot;
  const target = (over: Partial<TargetFacts> = {}): TargetFacts => ({ serverName: "box", agentOnline: true, capabilities: ["deploy", "database"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [], ...over });
  const obs = (over: Partial<PreflightObs> = {}): PreflightObs => ({ session: "active", plan: defaultPlan(), planError: null, target: target(), mapping: null, storedMappingBlocks: false, services: null, ...over });
  const byId = (cs: ReturnType<typeof preflightChecks>, id: string) => cs.find((c) => c.id === id);

  it("reports the target's agent, missing capabilities, ACME email and non-public proxy", () => {
    const cs = preflightChecks(run(), obs({ target: target({ agentOnline: false, capabilities: ["deploy"], acmeEmailOk: false, proxyBind: "none" }) }));
    expect(byId(cs, "preflight.agent")).toMatchObject({ status: "fail", code: "preflight.agent-offline" });
    expect(byId(cs, "preflight.capabilities")).toMatchObject({ status: "fail", params: { capabilities: ["database"] } });
    expect(byId(cs, "preflight.acme-email")).toMatchObject({ status: "warn", ownerInput: "acmeEmail" });
    expect(byId(cs, "preflight.proxy-bind")).toMatchObject({ status: "warn", code: "preflight.proxy-not-public" });
  });

  it("an answered acmeEmail input satisfies the ACME check; the topology swap-proxy has no proxy-bind check", () => {
    const inputs = OwnerInputsSchema.parse({ acmeEmail: { value: "ops@example.com", source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });
    const cs = preflightChecks(run({ inputs, topology: "swap-proxy" }), obs({ target: target({ acmeEmailOk: false, proxyBind: "none" }) }));
    expect(byId(cs, "preflight.acme-email")).toMatchObject({ status: "pass", code: "preflight.acme-email-input" });
    expect(byId(cs, "preflight.proxy-bind")).toBeUndefined();
    const unknown = OwnerInputsSchema.parse({ acmeEmail: { value: "unknown", source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });
    expect(byId(preflightChecks(run({ inputs: unknown }), obs({ target: target({ acmeEmailOk: false }) })), "preflight.acme-email")?.status).toBe("warn");
  });

  it("DNS: no credential is manual guidance; zones missing warn; a flexible/off Cloudflare SSL mode blocks until acknowledged", () => {
    expect(byId(preflightChecks(run(), obs()), "preflight.dns")).toMatchObject({ status: "warn", code: "preflight.dns-manual" });
    const cs = preflightChecks(
      run(),
      obs({
        target: target({
          dnsCredential: true,
          zones: [
            { host: "a.example.com", zone: "example.com", sslMode: "flexible", lookupFailed: false },
            { host: "b.other.org", zone: null, sslMode: null, lookupFailed: false },
            { host: "c.err.io", zone: null, sslMode: null, lookupFailed: true },
          ],
        }),
      }),
    );
    expect(byId(cs, "preflight.dns-zone")).toMatchObject({ status: "warn", params: { count: 1 } });
    expect(byId(cs, "preflight.dns-lookup")).toMatchObject({ status: "warn" });
    expect(byId(cs, "preflight.cf-ssl-mode")).toMatchObject({ status: "fail", ackable: true, params: { zones: ["example.com:flexible"] } });
  });

  it("bind mounts are counted: refused by default (warn + ownerInput), pass once allowBind is answered", () => {
    const plan = defaultPlan({ preflight: { ...defaultPlan().preflight!, volumes: [{ app: "web", mountPath: "/data", type: "bind", dataPlane: "stream", reason: "" }] } });
    expect(byId(preflightChecks(run(), obs({ plan })), "preflight.bind-mounts")).toMatchObject({ status: "warn", code: "preflight.bind-mounts-refused", params: { count: 1 }, ownerInput: "allowBind" });
    const inputs = OwnerInputsSchema.parse({ allowBind: { value: true, source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });
    expect(byId(preflightChecks(run({ inputs }), obs({ plan })), "preflight.bind-mounts")).toMatchObject({ status: "pass" });
  });

  it("manual data, skipped services, object stores and generated hosts are warnings with counts", () => {
    const pf = {
      databases: [
        { name: "ch", engine: "CLICKHOUSE", dataPlane: "manual" as const, reason: "" },
        { name: "x", engine: "UNKNOWN", dataPlane: "blocked" as const, reason: "" },
      ],
      services: [
        { name: "minio", members: 1, note: "", objectStore: true as const, verdict: "importable" as const },
        { name: "odd", members: 1, note: "", verdict: "skipped" as const },
      ],
      appsWithVolumeData: 0,
      volumes: [{ app: "web", mountPath: "/m", dataPlane: "manual" as const, reason: "" }],
      cutover: { hosts: 3, generatedHosts: ["app-abc.sslip.io"], counterpartHosts: [] },
    };
    const cs = preflightChecks(run(), obs({ plan: defaultPlan({ preflight: pf }) }));
    for (const id of ["preflight.db-manual", "preflight.db-blocked", "preflight.services-skipped", "preflight.object-store", "preflight.volumes-manual", "preflight.generated-hosts"]) {
      expect(byId(cs, id)).toMatchObject({ status: "warn" });
    }
  });

  it("mapping problems fail: changed hash, orphans, errors and unacknowledged conflicts; a stored mapping nobody sent blocks too", () => {
    const cs = preflightChecks(run(), obs({ mapping: { hashChanged: true, orphans: 2, errors: ["name.taken"], unacked: ["name.exists"] }, storedMappingBlocks: false }));
    expect(cs.filter((c) => c.status === "fail").map((c) => c.code).sort()).toEqual(["preflight.mapping-changed", "preflight.mapping-conflict", "preflight.mapping-orphans", "preflight.mapping-unacked"]);
    expect(byId(preflightChecks(run(), obs({ storedMappingBlocks: true })), "preflight.mapping-required")).toMatchObject({ status: "fail" });
  });

  it("the live service probe is consent-gated: off by default, `unreadable` services warn once consented", () => {
    const plan = defaultPlan({ items: [...defaultPlan().items, { itemRef: "service:_:s1", kind: "service", name: "stack", proposed: {}, risks: [], dependsOn: [] }] });
    expect(byId(preflightChecks(run(), obs({ plan })), "preflight.live-probe")).toMatchObject({ status: "pass", code: "preflight.live-probe-off", ownerInput: "allowLiveShapeProbe" });
    const inputs = OwnerInputsSchema.parse({ allowLiveShapeProbe: { value: true, source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });
    const svc = { name: "stack", verdict: "importable", env: { resolved: [], missing: [], secretsAvailable: false } } as never;
    expect(byId(preflightChecks(run({ inputs }), obs({ plan, services: [svc] })), "preflight.live-probe")).toMatchObject({ status: "warn", code: "preflight.services-unreadable" });
  });

  it("an unreadable target is `unknown` (which fails where data would move)", () => {
    expect(byId(preflightChecks(run(), obs({ target: null })), "preflight.target")).toMatchObject({ status: "unknown" });
  });
});

describe("create refuses a stale plan", () => {
  it("409 plan-changed when the live plan hash differs from the reviewed one; nothing is created", async () => {
    const w = new RunWorld();
    w.port.plan_ = defaultPlan({ planHash: "e".repeat(32) });
    await expect(w.create()).rejects.toThrow(/plan-changed/);
    expect(w.store.runs.size).toBe(0);
  });
  it("an expired or foreign session is refused before anything is created", async () => {
    const w = new RunWorld();
    w.env.sessions.get("s1")!.state = "expired";
    await expect(w.create()).rejects.toThrow(/session-expired/);
    await expect(w.create({ sessionId: "nope" })).rejects.toThrow(/session-not-found/);
    expect(w.store.runs.size).toBe(0);
  });
});

describe("PREFLIGHT is read-only", () => {
  it("the whole dry-run reads the importer but calls none of its mutating methods", async () => {
    const w = new RunWorld();
    w.port.storedMapping = false;
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    expect(w.port.calls).toEqual([]);
    expect(w.port.reads).toEqual(expect.arrayContaining(["planHash", "sessionState", "plan", "target"]));
    expect(w.port.ops.size).toBe(0);
  });
});
