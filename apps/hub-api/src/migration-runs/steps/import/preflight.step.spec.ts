import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, defaultPlan, H32 } from "../../core/testing/run-world";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import { PreflightStep, preflightChecks, type PreflightObs } from "./preflight.step";
import { OwnerInputsSchema } from "../../core/dto";
import type { RunSnapshot } from "../../core/run-contract";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { TargetFacts } from "./import-ports";

// the specs drive a whole run through the engine on a fake clock; give a loaded CI machine room
jest.setTimeout(30_000);

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
  const target = (over: Partial<TargetFacts> = {}): TargetFacts => ({ serverName: "box", agentOnline: true, capabilities: ["deploy", "database", "backup"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [], ...over });
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
    const inputs = OwnerInputsSchema.parse({ acmeEmail: { value: "ops@acme-corp.dev", source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });
    const cs = preflightChecks(run({ inputs, topology: "swap-proxy" }), obs({ target: target({ acmeEmailOk: false, proxyBind: "none" }) }));
    expect(byId(cs, "preflight.acme-email")).toMatchObject({ status: "pass", code: "preflight.acme-email-input" });
    expect(byId(cs, "preflight.proxy-bind")).toBeUndefined();
    const placeholder = OwnerInputsSchema.parse({ acmeEmail: { value: "ops@example.com", source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });
    expect(byId(preflightChecks(run({ inputs: placeholder }), obs({ target: target({ acmeEmailOk: false }) })), "preflight.acme-email")).toMatchObject({ status: "warn", code: "preflight.acme-email-invalid", ownerInput: "acmeEmail" });
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

  it("a service's host-path bind (a MinIO data directory) counts toward the same bind-mount acknowledgement", () => {
    const base = defaultPlan();
    const plan = defaultPlan({ preflight: { ...base.preflight!, volumes: [{ app: "web", mountPath: "/data", type: "bind", dataPlane: "stream", reason: "" }], services: [{ name: "minio", members: 1, note: "", objectStore: true, volumes: [{ key: "minio-data", dataPlane: "not-carried", origin: "host-bind" }, { key: "other", dataPlane: "hub-staged" }] }] } });
    expect(byId(preflightChecks(run(), obs({ plan })), "preflight.bind-mounts")).toMatchObject({ status: "warn", code: "preflight.bind-mounts-refused", params: { count: 2 }, ownerInput: "allowBind" });
    const onlyService = defaultPlan({ preflight: { ...base.preflight!, services: [{ name: "minio", members: 1, note: "", volumes: [{ key: "minio-data", dataPlane: "not-carried", origin: "host-bind" }] }] } });
    expect(byId(preflightChecks(run(), obs({ plan: onlyService })), "preflight.bind-mounts")).toMatchObject({ status: "warn", params: { count: 1 }, ownerInput: "allowBind" });
    expect(byId(preflightChecks(run(), obs({ plan: defaultPlan({ preflight: { ...base.preflight!, services: [{ name: "minio", members: 1, note: "", volumes: [{ key: "named", dataPlane: "hub-staged" }] }] } }) })), "preflight.bind-mounts")).toBeUndefined();
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

describe("PREFLIGHT source version gate (R4/C18)", () => {
  const verCheck = async (w: RunWorld, id: string) => (await stepOf(w, id)).gate!.checks.find((c) => c.id === "preflight.source-version");
  const events = async (w: RunWorld, id: string) => (await w.service.events(ACTOR, id, { afterSeq: 0, limit: 500 })).events;

  it("a supported version passes (source-reported evidence) and is the version the run shows", async () => {
    const w = new RunWorld();
    w.port.version_ = "4.1.2";
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(await verCheck(w, id)).toMatchObject({ status: "pass", code: "preflight.source-version-ok", params: { version: "4.1.2" }, evidence: "source-api-reported" });
    expect((await w.view(id)).sourceVersion).toBe("4.1.2");
    expect((await w.view(id)).sourceVersionVerdict).toBe("supported");
  });

  it("a version older than the oldest supported blocks and cannot be acknowledged", async () => {
    const w = new RunWorld();
    w.port.version_ = "4.0.9";
    const id = await w.run();
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_OPERATOR");
    expect(await verCheck(w, id)).toMatchObject({ status: "fail", code: "preflight.source-version-too-old", params: { version: "4.0.9", min: "4.1.2" } });
    expect((await verCheck(w, id))?.ackable).toBeUndefined();
    expect((await w.view(id)).nextAction).toMatchObject({ kind: "gate", stepKey: "PREFLIGHT", code: "preflight.blocked" });
  });

  it("a pre-release of the minimum is older than the minimum", async () => {
    const w = new RunWorld();
    w.port.version_ = "4.1.2-beta.9";
    const id = await w.run();
    expect(await verCheck(w, id)).toMatchObject({ status: "fail", code: "preflight.source-version-too-old" });
  });

  it("a version newer than the newest tested warns and waits for the operator to accept it", async () => {
    const w = new RunWorld();
    w.port.version_ = "4.8.0";
    const id = await w.run();
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_APPROVAL");
    const b = (await w.view(id)).nextAction.approval!;
    expect(b.ackable).toEqual(["preflight.source-version"]);
    expect(b.requiredAcks).toEqual(["preflight.source-version"]);
    await w.service.approve(ACTOR, id, "PREFLIGHT", { boundHash: b.inputHash, acks: b.requiredAcks });
    await w.settle(id, "approve");
    expect(w.status(id)).toBe("COMPLETED");
    expect(await verCheck(w, id)).toMatchObject({ status: "fail", acked: true, code: "preflight.source-version-newer", params: { version: "4.8.0", tested: "4.7.5" } });
  });

  it("a version the source did not report is a warning (the hub verified it could not read one), never a pass", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(await verCheck(w, id)).toMatchObject({ status: "warn", code: "preflight.source-version-unknown", params: { tested: "4.7.5" }, evidence: "hub-verified" });
    expect((await w.view(id)).sourceVersionVerdict).toBe("unknown");
  });

  it("PREFLIGHT refreshes the version when it was unknown at create, writes it to the run and says so once", async () => {
    const w = new RunWorld();
    const id = await w.create();
    expect((await w.view(id)).sourceVersion).toBeNull();
    w.port.version_ = "4.7.5";
    await w.start(id);
    await w.settle(id);
    expect((await w.view(id)).sourceVersion).toBe("4.7.5");
    const sv = (await events(w, id)).filter((e) => e.code === "run.source-version");
    expect(sv).toHaveLength(1);
    expect(sv[0]).toMatchObject({ level: "info", params: { version: "4.7.5", verdict: "supported" } });
  });

  it("an upgrade or downgrade of the source between create and PREFLIGHT is judged by what PREFLIGHT reads now", async () => {
    const w = new RunWorld();
    w.port.version_ = "4.7.5";
    const id = await w.create();
    w.port.version_ = "4.0.1"; // the source was rolled back
    await w.start(id);
    await w.settle(id);
    expect(await verCheck(w, id)).toMatchObject({ status: "fail", code: "preflight.source-version-too-old" });
    expect((await w.view(id)).sourceVersion).toBe("4.0.1");
  });

  it("a failed live read falls back to the version stored at create", async () => {
    const w = new RunWorld();
    w.port.version_ = "4.1.2";
    const id = await w.create();
    w.port.throwVersion = true;
    await w.start(id);
    await w.settle(id);
    expect(w.status(id)).toBe("COMPLETED");
    expect(await verCheck(w, id)).toMatchObject({ status: "pass", params: { version: "4.1.2" } });
  });

  it("a token the source does not accept as a version is ignored", async () => {
    const w = new RunWorld();
    const id = await w.create();
    w.port.version_ = "x y\u0001";
    await w.start(id);
    await w.settle(id);
    expect((await w.view(id)).sourceVersion).toBeNull();
  });

  it("Dokploy has no supported range: no version check at all", () => {
    const cs = preflightChecks({ ...baseRun(), sourceKind: "dokploy" } as RunSnapshot, baseObs({ sourceVersion: "0.30.10" }));
    expect(cs.find((c) => c.id === "preflight.source-version")).toBeUndefined();
  });
});

describe("PREFLIGHT source health baseline (R28/R52)", () => {
  type Rows = Array<{ kind: "app" | "database" | "service"; ref: string; serverRef?: string; health: "healthy" | "unhealthy" | "unknown" | "exited"; restartCount: number | null }>;
  const rows: Rows = [
    { kind: "app", ref: "web", health: "exited", restartCount: 90001 },
    { kind: "app", ref: "static", health: "unknown", restartCount: 0 },
    { kind: "app", ref: "not-in-the-plan", health: "unhealthy", restartCount: 9 },
  ];
  const withHealth = (w: RunWorld, read: () => Promise<Rows | null>) => {
    (w.port as unknown as { sourceHealth: typeof read }).sourceHealth = read;
  };
  const check = async (w: RunWorld, id: string, cid: string) => (await stepOf(w, id)).gate!.checks.find((c) => c.id === cid);

  it("records the baseline on the run and tells which planned apps were already failing at the source", async () => {
    const w = new RunWorld();
    withHealth(w, async () => rows);
    const id = await w.run();
    expect(w.status(id)).toBe("COMPLETED");
    expect(await check(w, id, "preflight.baseline")).toMatchObject({ status: "pass", code: "preflight.baseline-captured", params: { resources: 3, unhealthy: 1 }, evidence: "source-api-reported" });
    expect(await check(w, id, "preflight.source-unhealthy")).toMatchObject({ status: "warn", params: { count: 1, items: ["web"] } });
    const stored = w.store.row(id).sourceBaseline as { entries: Array<{ ref: string; health: string }> };
    expect(stored.entries.map((e) => [e.ref, e.health]).sort()).toEqual([["not-in-the-plan", "unhealthy"], ["static", "unknown"], ["web", "exited"]]);
    expect((await w.view(id)).baselineAt).not.toBeNull();
  });

  it("a baseline that cannot be read warns (nothing to judge against) and does not block", async () => {
    for (const read of [async () => null, async () => Promise.reject(new Error("source down"))]) {
      const w = new RunWorld();
      withHealth(w, read as never);
      const id = await w.run();
      expect(w.status(id)).toBe("COMPLETED");
      expect(await check(w, id, "preflight.baseline")).toMatchObject({ status: "warn", code: "preflight.baseline-unavailable" });
      expect(w.store.row(id).sourceBaseline).toBeNull();
    }
  });

  it("a port with no health read at all says nothing about a baseline", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(await check(w, id, "preflight.baseline")).toBeUndefined();
  });

  it("the baseline stays as it was once PREFLIGHT passed (the source is stopped later; a new reading would be wrong)", async () => {
    const w = new RunWorld();
    withHealth(w, async () => rows);
    const id = await w.run();
    const before = JSON.stringify(w.store.row(id).sourceBaseline);
    withHealth(w, async () => rows.map((r) => ({ ...r, health: "exited" as const })));
    await w.tick(3);
    expect(JSON.stringify(w.store.row(id).sourceBaseline)).toBe(before);
  });

  it("the dry-run reads the baseline too and writes only the run's own row", async () => {
    const w = new RunWorld();
    withHealth(w, async () => rows);
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    const dry = (await stepOf(w, id)).progress?.dryRun ?? [];
    expect(dry).toEqual(expect.arrayContaining([expect.objectContaining({ code: "preflight.baseline-captured", level: "info" }), expect.objectContaining({ code: "preflight.source-unhealthy", level: "warn" })]));
    expect(w.port.calls).toEqual([]);
  });
});

function baseRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "r1",
    mode: "copy",
    topology: "two-box",
    planHash: H32,
    sourceKind: "coolify",
    targetServerId: "srv1",
    serverMap: {},
    sourceVersion: null,
    sourceBaseline: null,
    inputs: OwnerInputsSchema.parse({}),
    options: { deployWaves: "single", deployConcurrency: undefined },
    applyInput: { sourceKind: "coolify", targetServerId: "srv1", planHash: H32 },
    ...over,
  } as unknown as RunSnapshot;
}
function baseObs(over: Partial<PreflightObs> = {}): PreflightObs {
  return { session: "active", plan: defaultPlan(), planError: null, target: { serverName: "box", agentOnline: true, capabilities: ["deploy", "database", "backup"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [] }, mapping: null, storedMappingBlocks: false, services: null, ...over };
}

describe("PREFLIGHT safety checks over the plan (R11, R26/C13, R27/C5)", () => {
  const D = `sha256:${"c".repeat(64)}`;
  const plan = (items: Array<{ itemRef: string; kind: string; name: string; proposed: Record<string, unknown> }>) => defaultPlan({ items: items.map((i) => ({ ...i, risks: [], dependsOn: [] })) as never });
  const byId = (cs: ReturnType<typeof preflightChecks>, id: string) => cs.find((c) => c.id === id);
  const answered = (k: string, value: string) => OwnerInputsSchema.parse({ [k]: { value, source: "request", setBy: "u1", at: "2026-11-23T00:00:00.000Z" } });

  it("the unpinned check carries the images (item, member, the image the source writes, the version it shows) for the result screen's pin", () => {
    const p = plan([
      { itemRef: "app:s1:img", kind: "app", name: "proxy", proposed: { source: "IMAGE", image: "img/proxy:latest", domain: "p.example.test" } },
      { itemRef: "service:s1:svc", kind: "service", name: "search", proposed: { imageFloating: ["meili"] } },
    ]);
    const withRows = { ...p, preflight: { ...p.preflight!, services: [{ name: "search", itemRef: "service:s1:svc", floating: [{ member: "meili", image: "getmeili/meilisearch:latest", seen: "getmeili/meilisearch:v1.8.0" }], members: 1, note: "" }] } } as never;
    const check = byId(preflightChecks(baseRun(), baseObs({ plan: withRows })), "preflight.images");
    expect(check?.params).toMatchObject({
      imageCount: 2,
      imageItems: ["app:s1:img", "service:s1:svc"],
      imageMembers: ["", "meili"],
      images: ["img/proxy:latest", "getmeili/meilisearch:latest"],
      imageSeen: ["", "getmeili/meilisearch:v1.8.0"],
    });
    // a pin recorded on the dry run (service-pin hint) counts as pinned for the member
    const hints = [{ kind: "service-pin" as const, key: "service:s1:svc#meili", scope: "", value: "getmeili/meilisearch:v1.8.0", evidence: "operator-attested" as const }];
    expect(byId(preflightChecks(baseRun(), baseObs({ plan: withRows, hints })), "preflight.images")?.params).toMatchObject({ count: 1, imageItems: ["app:s1:img"] });
  });

  it("floating image apps and service members with no recorded digest fail with an acknowledgement; a recorded digest passes", () => {
    const p = plan([
      { itemRef: "app:s1:img", kind: "app", name: "proxy", proposed: { source: "IMAGE", image: "img/proxy:latest", domain: "p.example.test" } },
      { itemRef: "service:s1:svc", kind: "service", name: "search", proposed: { imageFloating: ["meili"] } },
    ]);
    const open = byId(preflightChecks(baseRun(), baseObs({ plan: p })), "preflight.images");
    expect(open).toMatchObject({ status: "fail", code: "preflight.images-unpinned", ackable: true, params: { count: 2, items: ["proxy", "search/meili"] } });
    const run = baseRun({ applyInput: { sourceKind: "coolify", targetServerId: "srv1", planHash: H32, serviceChoices: { "service:s1:svc": { pins: { meili: `getmeili/meilisearch@${D}` } } } } as never });
    const hints = [{ kind: "image-pin" as const, key: "img/proxy:latest", scope: "s1", value: D, evidence: "host-loop-reported" as const }];
    expect(byId(preflightChecks(run, baseObs({ plan: p, hints })), "preflight.images")).toMatchObject({ status: "pass", code: "preflight.images-pinned", params: { count: 2 } });
    expect(byId(preflightChecks(run, baseObs({ plan: p, hints: [] })), "preflight.images")).toMatchObject({ status: "fail", params: { count: 1, items: ["proxy"] } });
  });

  it("an in-place takeover keeps the exact image Coolify runs: no floating-image approval, a pass line instead", () => {
    const p = plan([
      { itemRef: "app:s1:img", kind: "app", name: "proxy", proposed: { source: "IMAGE", image: "img/proxy:latest", domain: "p.example.test" } },
      { itemRef: "service:s1:svc", kind: "service", name: "search", proposed: { imageFloating: ["meili"] } },
    ]);
    const check = byId(preflightChecks(baseRun({ inPlace: true, topology: "swap-proxy" } as never), baseObs({ plan: p })), "preflight.images");
    expect(check).toMatchObject({ status: "pass", code: "preflight.images-kept-exact", params: { count: 2 } });
    expect(check?.ackable).toBeUndefined();
  });

  it("no floating image, no check", () => {
    expect(byId(preflightChecks(baseRun(), baseObs()), "preflight.images")).toBeUndefined();
  });

  const workerPlan = plan([
    { itemRef: "app:_:web", kind: "app", name: "web", proposed: { source: "GIT", domain: "web.example.test" } },
    { itemRef: "app:_:queue", kind: "app", name: "queue-worker", proposed: { source: "GIT", domain: null } },
    { itemRef: "app:_:peer", kind: "app", name: "internal-api", proposed: { source: "GIT", domain: null } },
  ]);
  const aliasInput = { sourceKind: "coolify", targetServerId: "srv1", planHash: H32, mapping: { version: 1, items: { "app:_:peer": { containerAlias: "api.internal" } }, projects: {}, gitSources: {}, acks: [] }, mappingHash: "f".repeat(32) };

  it("apps without a domain are workers held until after the cutover (an aliased internal API is not one)", () => {
    const c = byId(preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan })), "preflight.workers");
    expect(c).toMatchObject({ status: "pass", code: "preflight.workers-held", params: { count: 1, items: ["queue-worker"] } });
  });

  it("the policy changes what the check says; start-dark is a warning because duplicate side effects are possible", () => {
    const at = (v: string) => byId(preflightChecks(baseRun({ applyInput: aliasInput as never, inputs: answered("workerPolicy", v) }), baseObs({ plan: workerPlan })), "preflight.workers");
    expect(at("exclude")).toMatchObject({ status: "pass", code: "preflight.workers-excluded" });
    expect(at("start-dark")).toMatchObject({ status: "warn", code: "preflight.workers-start-dark" });
    expect(at("unknown")).toMatchObject({ code: "preflight.workers-held" }); // the fail-closed default
  });

  it("an operator mark moves an app in or out of the worker set", () => {
    const hints = [
      { kind: "worker-mark" as const, key: "app:_:peer", scope: "", value: "job-runner", evidence: "operator-attested" as const },
      { kind: "worker-mark" as const, key: "app:_:queue", scope: "", value: "web", evidence: "operator-attested" as const },
    ];
    const c = byId(preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan, hints })), "preflight.workers");
    expect(c).toMatchObject({ params: { count: 1, items: ["internal-api"] } });
  });

  it("a job-runner mark on an app that serves a domain fails the check: a cutover host cannot be held back", () => {
    const hints = [{ kind: "worker-mark" as const, key: "app:_:web", scope: "", value: "job-runner", evidence: "operator-attested" as const }];
    const checks = preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan, hints }));
    expect(byId(checks, "preflight.job-runner-domain")).toMatchObject({ status: "fail", code: "preflight.job-runner-has-domain", params: { count: 1, items: ["web"] } });
    expect(byId(checks, "preflight.workers")).toMatchObject({ params: { count: 1, items: ["queue-worker"] } }); // the marked app is not held
    expect(byId(preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan })), "preflight.job-runner-domain")).toBeUndefined();
  });

  it("a mark that matches no app of the plan fails the check, so a typo cannot leave the real worker running next to the source", () => {
    const typo = { kind: "worker-mark" as const, key: "app:_:queu", scope: "", value: "job-runner", evidence: "operator-attested" as const };
    const checks = preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan, hints: [typo] }));
    expect(byId(checks, "preflight.worker-mark-unmatched")).toMatchObject({ status: "fail", code: "preflight.worker-mark-unmatched", params: { count: 1, items: ["app:_:queu"] } });
    // a mark on a database item is no app mark either
    const dbMark = { ...typo, key: "database:_:db" };
    expect(byId(preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan, hints: [dbMark] })), "preflight.worker-mark-unmatched")).toMatchObject({ status: "fail" });
    // a mark that names a real app, and no mark at all, raise nothing
    const good = { ...typo, key: "app:_:queue" };
    expect(byId(preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan, hints: [good] })), "preflight.worker-mark-unmatched")).toBeUndefined();
    expect(byId(preflightChecks(baseRun({ applyInput: aliasInput as never }), baseObs({ plan: workerPlan })), "preflight.worker-mark-unmatched")).toBeUndefined();
  });

  it("a domain the plan does not state is never read as 'no domain'", () => {
    const p = plan([{ itemRef: "app:_:a", kind: "app", name: "a", proposed: { source: "GIT" } }]);
    expect(byId(preflightChecks(baseRun(), baseObs({ plan: p })), "preflight.workers")).toBeUndefined();
  });

  it("the builds inside the freeze window are a warning with an estimate; with earlyBuild they are done before it", () => {
    const apps = Array.from({ length: 6 }, (_, i) => ({ itemRef: `app:_:g${i}`, kind: "app", name: `g${i}`, proposed: { source: "GIT", domain: `g${i}.example.test` } }));
    const p = plan(apps);
    const inside = byId(preflightChecks(baseRun(), baseObs({ plan: p })), "preflight.deploy-window");
    expect(inside).toMatchObject({ status: "warn", code: "preflight.deploy-window-inside", params: { builds: 6, minutes: 27 } });
    const early = byId(preflightChecks(baseRun({ options: { deployWaves: "earlyBuild" } as never }), baseObs({ plan: p })), "preflight.deploy-window");
    expect(early).toMatchObject({ status: "pass", code: "preflight.deploy-window-early", params: { builds: 6, minutes: 3 } });
    const two = byId(preflightChecks(baseRun({ options: { deployWaves: "single", deployConcurrency: 2 } as never }), baseObs({ plan: p })), "preflight.deploy-window");
    expect((two!.params as { minutes: number }).minutes).toBeLessThan(27);
    expect(byId(preflightChecks(baseRun(), baseObs()), "preflight.deploy-window")).toBeUndefined();
  });
});

describe("PREFLIGHT target readiness for every target server (R7)", () => {
  const GiB = 1024 ** 3;
  const reading = (freeGib: number, totalGib = 100, ageSec = 30) => ({ freeBytes: freeGib * GiB, totalBytes: totalGib * GiB, ageSec });
  const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({ serverName: "box", agentOnline: true, capabilities: ["deploy", "database", "backup"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [], ...over });
  const items = [
    { itemRef: "database:h1:db1", kind: "database", name: "db-a", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
    { itemRef: "database:h2:db2", kind: "database", name: "db-b", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
    { itemRef: "app:h2:web", kind: "app", name: "web", proposed: { domain: "web.example.test" }, risks: [], dependsOn: [] },
  ];
  const plan = () => defaultPlan({ items: items as never });
  const multi = (over: Partial<RunSnapshot> = {}) => baseRun({ targetServerId: "srv1", serverMap: { h1: "srv1", h2: "srv2" }, ...over });
  const byId = (cs: ReturnType<typeof preflightChecks>, id: string) => cs.find((c) => c.id === id);

  it("a low-disk target FAILS (ackable); a roomy one passes; no reading at all is said, never read as free", () => {
    const low = preflightChecks(baseRun(), baseObs({ target: facts({ disk: reading(4) }) }));
    expect(byId(low, "preflight.disk.srv1")).toMatchObject({ status: "fail", code: "preflight.disk-low", ackable: true, params: { server: "box", freeGib: 4, totalGib: 100, minGib: 10 } });
    // a big disk that is nearly full fails on the share, not on the floor
    const full = preflightChecks(baseRun(), baseObs({ target: facts({ disk: reading(40, 1000) }) }));
    expect(byId(full, "preflight.disk.srv1")).toMatchObject({ status: "fail", code: "preflight.disk-low" });
    const ok = preflightChecks(baseRun(), baseObs({ target: facts({ disk: reading(60) }) }));
    expect(byId(ok, "preflight.disk.srv1")).toMatchObject({ status: "pass", code: "preflight.disk-ok" });
    const none = preflightChecks(baseRun(), baseObs({ target: facts({ disk: null }) }));
    expect(byId(none, "preflight.disk.srv1")).toMatchObject({ status: "warn", code: "preflight.disk-unknown" });
    // a reading from hours ago is not a reading of the disk as it is now
    const stale = preflightChecks(baseRun(), baseObs({ target: facts({ disk: reading(60, 100, 4 * 3600) }) }));
    expect(byId(stale, "preflight.disk.srv1")).toMatchObject({ status: "warn", code: "preflight.disk-unknown" });
    // a port that cannot say gives no check at all
    expect(byId(preflightChecks(baseRun(), baseObs({ target: facts() })), "preflight.disk.srv1")).toBeUndefined();
  });

  it("the approval binding of a low-disk target does not move with the live reading", async () => {
    const w = new RunWorld();
    const step = new PreflightStep(w.registry, w.port);
    const bind = async (freeGib: number) => step.approvalBinding({ run: baseRun() } as never, baseObs({ target: facts({ disk: reading(freeGib) }) }));
    const a = await bind(4);
    const b = await bind(3.2);
    expect(a).not.toBeNull();
    // both are failing readings: the number moved, what the operator accepts did not
    expect(preflightChecks(baseRun(), baseObs({ target: facts({ disk: reading(3.2) }) })).find((c) => c.id === "preflight.disk.srv1")!.params).toMatchObject({ freeGib: 3.2 });
    expect(b!.inputHash).toBe(a!.inputHash);
    // a different shortfall (a second target's disk) is a different approval
    const two = await step.approvalBinding({ run: baseRun({ serverMap: { h1: "srv1", h2: "srv2" } }) } as never, baseObs({ plan: defaultPlan(), target: facts({ disk: reading(4) }), extraTargets: [{ serverId: "srv2", facts: facts({ serverName: "box-2", disk: reading(2) }) }] }));
    expect(two!.inputHash).not.toBe(a!.inputHash);
  });

  it("every server of the serverMap is checked, one check per target, and an unreadable one is unknown", () => {
    const cs = preflightChecks(multi(), baseObs({ plan: plan(), target: facts({ disk: reading(60) }), extraTargets: [{ serverId: "srv2", facts: facts({ serverName: "box-2", disk: reading(3) }) }] }));
    expect(byId(cs, "preflight.disk.srv1")).toMatchObject({ status: "pass" });
    expect(byId(cs, "preflight.disk.srv2")).toMatchObject({ status: "fail", subject: "box-2", params: { server: "box-2" } });
    const unreadable = preflightChecks(multi(), baseObs({ plan: plan(), target: facts(), extraTargets: [{ serverId: "srv2", facts: null }] }));
    expect(byId(unreadable, "preflight.target.srv2")).toMatchObject({ status: "unknown", code: "preflight.target-unreadable" });
  });

  it("the approval accepts one target's shortfall by its own check id, not the whole run's", () => {
    const cs = preflightChecks(multi(), baseObs({ plan: plan(), target: facts({ disk: reading(3) }), extraTargets: [{ serverId: "srv2", facts: facts({ serverName: "box-2", disk: reading(2) }) }] }));
    expect(cs.filter((c) => c.code === "preflight.disk-low").map((c) => [c.id, c.ackable])).toEqual([["preflight.disk.srv1", true], ["preflight.disk.srv2", true]]);
  });

  it("databases that land on a server without the backup capability fail (ackable) and name the databases; without a destination they warn", () => {
    const cs = preflightChecks(
      multi(),
      baseObs({ plan: plan(), target: facts({ backupDestinations: 1 }), extraTargets: [{ serverId: "srv2", facts: facts({ serverName: "box-2", capabilities: ["deploy", "database"], backupDestinations: 0 }) }] }),
    );
    // srv1 gets db-a and can back it up to a destination
    expect(byId(cs, "preflight.backup-destination.srv1")).toMatchObject({ status: "pass", code: "preflight.backup-destination-ok", params: { count: 1, destinations: 1 } });
    // srv2 gets db-b but cannot back it up at all
    expect(byId(cs, "preflight.backup-capability.srv2")).toMatchObject({ status: "fail", ackable: true, code: "preflight.backup-capability-missing", params: { server: "box-2", count: 1, items: ["db-b"] } });
    const noDest = preflightChecks(baseRun(), baseObs({ target: facts({ backupDestinations: 0 }) }));
    expect(byId(noDest, "preflight.backup-destination.srv1")).toMatchObject({ status: "warn", code: "preflight.backup-destination-missing", params: { count: 1, items: ["pg-main"] } });
    // a target that receives no database has nothing to back up: no check for it
    const noDbs = preflightChecks(multi(), baseObs({ plan: defaultPlan({ items: [items[2]] as never }), target: facts(), extraTargets: [{ serverId: "srv2", facts: facts({ capabilities: ["deploy"] }) }] }));
    expect(noDbs.some((c) => c.id.startsWith("preflight.backup"))).toBe(false);
  });

  it("a backup-destination read that failed is said, not skipped", () => {
    const cs = preflightChecks(multi(), baseObs({ plan: plan(), target: facts({ backupDestinations: null, disk: null }) }));
    expect(byId(cs, "preflight.backup-destination.srv1")).toMatchObject({ status: "warn", code: "preflight.backup-destination-unknown", params: { server: "box", count: 1 } });
    expect(byId(cs, "preflight.disk.srv1")).toMatchObject({ status: "warn", code: "preflight.disk-unknown" });
  });

  it("a very new OS release on a target is flagged, an older one and an unlisted distribution are not", () => {
    const flag = (os: string, osVersion: string | null) => byId(preflightChecks(baseRun(), baseObs({ target: facts({ os, osVersion }) })), "preflight.target-os.srv1");
    expect(flag("ubuntu", "26.04")).toMatchObject({ status: "warn", code: "preflight.target-os-new", params: { os: "ubuntu 26.04", tested: "ubuntu 24.04, debian 12" } });
    expect(flag("Ubuntu 26.04.1 LTS", null)).toMatchObject({ status: "warn" });
    expect(flag("ubuntu", "24.04")).toBeUndefined();
    expect(flag("ubuntu", "22.04")).toBeUndefined();
    expect(flag("alpine", "3.20")).toBeUndefined();
  });

  it("a whole run parks on an approval for a low disk and the approval lets it continue", async () => {
    const w = new RunWorld();
    w.port.target_ = { ...w.port.target_, disk: reading(2) };
    const id = await w.run();
    expect(w.stepStatus(id, "PREFLIGHT")).toBe("WAITING_APPROVAL");
    const b = (await w.view(id)).nextAction.approval!;
    expect(b.requiredAcks).toEqual(["preflight.disk.srv1"].map((x) => expect.stringMatching(/^preflight\.disk\./)));
    await w.service.approve(ACTOR, id, "PREFLIGHT", { boundHash: b.inputHash, acks: b.requiredAcks });
    await w.settle(id, "approve");
    expect(w.status(id)).toBe("COMPLETED");
  });
});

describe("PREFLIGHT source host classification (R5)", () => {
  const plan = (hosts: Array<Record<string, unknown>>, items: Array<{ itemRef: string; kind: string; name: string }>) =>
    defaultPlan({ items: items.map((i) => ({ ...i, proposed: {}, risks: [], dependsOn: [] })) as never, preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts } as never });
  const byId = (cs: ReturnType<typeof preflightChecks>, id: string) => cs.find((c) => c.id === id);
  const two = [
    { itemRef: "app:ha:a", kind: "app", name: "app-a" },
    { itemRef: "app:hb:b", kind: "app", name: "app-b" },
    { itemRef: "app:hc:c", kind: "app", name: "app-c" },
  ];

  it("flags a host with a high unreachable count and a very new OS, and counts the host that carries nothing as skipped", () => {
    const cs = preflightChecks(
      baseRun(),
      baseObs({
        plan: plan(
          [
            { ref: "ha", name: "host-1", unreachableCount: 40, os: "Ubuntu 24.04.4 LTS" },
            { ref: "hb", name: "host-2", unreachableCount: 1, os: "Ubuntu 26.04.1 LTS" },
            { ref: "hc", name: "host-3", unreachableCount: 2 },
            { ref: "hd", name: "host-empty", unreachableCount: 900 },
          ],
          two,
        ),
      }),
    );
    expect(byId(cs, "preflight.hosts")).toMatchObject({ status: "pass", params: { hosts: 4, empty: 1, osReported: 2, refs: ["ha", "hb", "hc", "hd"], names: ["host-1", "host-2", "host-3", "host-empty"] } });
    expect(byId(cs, "preflight.host-flaky")).toMatchObject({ status: "warn", params: { count: 1, items: ["host-1 (40)"] } });
    expect(byId(cs, "preflight.host-os-new")).toMatchObject({ status: "warn", params: { count: 1, items: ["host-2: ubuntu 26.04"], tested: "ubuntu 24.04, debian 12" } });
    // the empty host is only informed about: its flaky count is no concern of this run
    expect(byId(cs, "preflight.host-empty")).toMatchObject({ status: "pass", params: { count: 1, items: ["host-empty"] } });
    expect(cs.filter((c) => c.code === "preflight.host-flaky")).toHaveLength(1);
  });

  it("warns (never blocks) about a moved host that reports no operating system, and names only the moved ones", () => {
    const cs = preflightChecks(baseRun(), baseObs({ plan: plan([{ ref: "ha", name: "host-1", os: "Ubuntu 24.04.4 LTS" }, { ref: "hb", name: "host-2" }, { ref: "hc" }, { ref: "hd", name: "idle-no-os" }], two) }));
    expect(byId(cs, "preflight.host-os-unknown")).toMatchObject({ status: "warn", code: "preflight.host-os-unknown", params: { count: 2, items: ["host-2", "hc"] } });
    expect(byId(cs, "preflight.host-os-unknown")).not.toHaveProperty("ackable");
    const all = preflightChecks(baseRun(), baseObs({ plan: plan([{ ref: "ha", name: "host-1", os: "Ubuntu 24.04.4 LTS" }], two.slice(0, 1)) }));
    expect(byId(all, "preflight.host-os-unknown")).toBeUndefined();
  });

  it("marks the control-plane host: a warning when the run moves things off it, plain information when it carries nothing", () => {
    const moves = preflightChecks(baseRun(), baseObs({ plan: plan([{ ref: "ha", name: "host-1", controlPlane: true }, { ref: "hb", name: "host-2" }], two) }));
    expect(byId(moves, "preflight.host-control-plane")).toMatchObject({ status: "warn", code: "preflight.host-control-plane-moves", subject: "host-1", params: { host: "host-1", items: 1 } });
    const idle = preflightChecks(baseRun(), baseObs({ plan: plan([{ ref: "hz", name: "host-cp", controlPlane: true }, { ref: "ha", name: "host-1" }], two) }));
    expect(byId(idle, "preflight.host-control-plane")).toMatchObject({ status: "pass", code: "preflight.host-control-plane", params: { host: "host-cp", items: 0 } });
  });

  it("a host the mapping leaves out is not part of this run at all (not even as an empty one); a plan without host facts says nothing", () => {
    const run = baseRun({ applyInput: { sourceKind: "coolify", targetServerId: "srv1", planHash: H32, mapping: { version: 1, items: { "app:hb:b": { include: false }, "app:hc:c": { include: false } }, projects: {}, gitSources: {}, acks: [] }, mappingHash: "f".repeat(32) } as never });
    const cs = preflightChecks(run, baseObs({ plan: plan([{ ref: "ha", name: "host-1" }, { ref: "hb", name: "host-2" }, { ref: "hc", name: "host-3" }], two) }));
    expect(byId(cs, "preflight.host-empty")).toBeUndefined();
    expect(byId(cs, "preflight.hosts")).toMatchObject({ params: { hosts: 1, empty: 0, refs: ["ha"], names: ["host-1"] } });
    expect(preflightChecks(baseRun(), baseObs()).some((c) => c.id.startsWith("preflight.host"))).toBe(false);
  });

  it("every worker is listed in full for the panel, beyond the ten names the sentence shows", () => {
    const apps = Array.from({ length: 14 }, (_, n) => ({ itemRef: `app:ha:w${n}`, kind: "app", name: `worker-${n}`, proposed: { domain: null }, risks: [], dependsOn: [] }));
    const cs = preflightChecks(baseRun(), baseObs({ plan: defaultPlan({ items: apps as never }) }));
    const w = byId(cs, "preflight.workers")!;
    expect((w.params as { items: string[] }).items).toHaveLength(10);
    expect((w.params as { workers: string[] }).workers).toHaveLength(14);
    expect(w.params).toMatchObject({ count: 14, policy: "hold-dark" });
  });
});

describe("PREFLIGHT judges the run's own items only (scoped runs)", () => {
  const D = `sha256:${"c".repeat(64)}`;
  void D;
  const byId = (cs: ReturnType<typeof preflightChecks>, id: string) => cs.find((c) => c.id === id);
  // server `ha` is this run's; server `hb` (another team's) is left out by the scope: its apps by mapping rows, its stacks by `skip`
  const items = [
    { itemRef: "app:ha:web", kind: "app", name: "web", proposed: { domain: "web.example.test", source: "IMAGE", image: "ghcr.io/x/web@sha256:" + "a".repeat(64) }, risks: [], dependsOn: [] },
    { itemRef: "database:ha:db", kind: "database", name: "pg", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
    { itemRef: "app:hb:other", kind: "app", name: "other", proposed: { domain: "other.example.test", source: "IMAGE", image: "nginx:latest" }, risks: [], dependsOn: ["volume:hb:v1"] },
    { itemRef: "volume:hb:v1", kind: "volume", name: "v1", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "service:hb:stack", kind: "service", name: "stack", proposed: { imageFloating: ["redis"] }, risks: [], dependsOn: [] },
  ];
  const pf = {
    databases: [
      { name: "pg", itemRef: "database:ha:db", engine: "POSTGRES", dataPlane: "one-click" as const, reason: "" },
      { name: "pg", itemRef: "database:hb:db", engine: "CLICKHOUSE", dataPlane: "manual" as const, reason: "" },
    ],
    services: [{ name: "stack", itemRef: "service:hb:stack", members: 1, note: "", verdict: "skipped" as const, objectStore: true as const, volumes: [{ key: "d", dataPlane: "n", origin: "host-bind" as const }] }],
    appsWithVolumeData: 0,
    volumes: [{ app: "other", itemRef: "app:hb:other", mountPath: "/data", type: "bind" as const, dataPlane: "manual" as const, reason: "" }],
    cutover: { hosts: 2, generatedHosts: ["app-zzz.sslip.io"], counterpartHosts: [] },
    hosts: [
      { ref: "ha", name: "host-a" },
      { ref: "hb", name: "host-b", controlPlane: true, unreachableCount: 99 },
    ],
  };
  const plan = () => defaultPlan({ items: items as never, preflight: pf as never });
  const scoped = (over: Partial<RunSnapshot> = {}) =>
    baseRun({
      applyInput: {
        sourceKind: "coolify",
        targetServerId: "srv1",
        planHash: H32,
        mapping: { version: 1, items: { "app:hb:other": { include: false } }, projects: {}, gitSources: {}, acks: [] },
        mappingHash: "f".repeat(32),
        serviceChoices: { "service:hb:stack": { skip: true } },
      } as never,
      ...over,
    });

  it("another server's images, stacks, binds, manual data and hosts never reach the checks", () => {
    const cs = preflightChecks(scoped(), baseObs({ plan: plan() }));
    const ids = cs.map((c) => c.id);
    expect(ids).not.toContain("preflight.images");
    expect(ids).not.toContain("preflight.bind-mounts");
    expect(ids).not.toContain("preflight.db-manual");
    expect(ids).not.toContain("preflight.services-skipped");
    expect(ids).not.toContain("preflight.object-store");
    expect(ids).not.toContain("preflight.volumes-manual");
    expect(ids).not.toContain("preflight.generated-hosts");
    expect(ids).not.toContain("preflight.host-control-plane");
    expect(ids).not.toContain("preflight.host-flaky");
    expect(byId(cs, "preflight.hosts")).toMatchObject({ params: { hosts: 1, refs: ["ha"] } });
    expect(byId(cs, "preflight.plan")).toMatchObject({ params: { apps: 1, databases: 1, services: 0, volumes: 0 } });
    expect(cs.filter((c) => c.ackable)).toEqual([]);
  });

  it("the same plan without a scope still reports all of it (nothing is hidden from a whole-fleet run)", () => {
    const cs = preflightChecks(baseRun(), baseObs({ plan: plan() }));
    const ids = cs.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["preflight.images", "preflight.bind-mounts", "preflight.db-manual", "preflight.services-skipped", "preflight.object-store", "preflight.volumes-manual", "preflight.generated-hosts", "preflight.host-control-plane"]));
  });

  it("a row without an itemRef is matched by name to the kept items; a name no item has stays", () => {
    const old = { ...pf, databases: [{ name: "pg", engine: "POSTGRES", dataPlane: "manual" as const, reason: "" }, { name: "ghost", engine: "X", dataPlane: "blocked" as const, reason: "" }] };
    const cs = preflightChecks(scoped(), baseObs({ plan: defaultPlan({ items: items as never, preflight: old as never }) }));
    expect(byId(cs, "preflight.db-manual")).toMatchObject({ params: { count: 1, items: ["pg"] } });
    expect(byId(cs, "preflight.db-blocked")).toMatchObject({ params: { count: 1, items: ["ghost"] } });
  });

  it("the plan blockers of a left-out service are not asked either", () => {
    const withBlocker = items.map((i) => (i.itemRef === "service:hb:stack" ? { ...i, risks: [{ level: "blocker", code: "service.x", message: "x" }] } : i));
    const cs = preflightChecks(scoped(), baseObs({ plan: defaultPlan({ items: withBlocker as never, preflight: pf as never }) }));
    expect(cs.some((c) => c.id.startsWith("preflight.blocker."))).toBe(false);
  });

  describe("an in-place takeover", () => {
    const floating = [
      { itemRef: "app:ha:web", kind: "app", name: "web", proposed: { domain: "web.example.test", source: "IMAGE", image: "nginx:latest" }, risks: [], dependsOn: [] },
      { itemRef: "app:ha:api", kind: "app", name: "api", proposed: { domain: null }, risks: [], dependsOn: [] },
      { itemRef: "database:ha:db", kind: "database", name: "pg", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
    ];
    const ppf = {
      databases: [{ name: "pg", itemRef: "database:ha:db", engine: "POSTGRES", dataPlane: "manual" as const, reason: "" }],
      services: [{ name: "s", itemRef: "service:ha:s", members: 1, note: "", objectStore: true as const, volumes: [{ key: "d", dataPlane: "n", origin: "host-bind" as const }] }],
      appsWithVolumeData: 0,
      volumes: [{ app: "web", itemRef: "app:ha:web", mountPath: "/m", type: "bind" as const, dataPlane: "manual" as const, reason: "" }],
      cutover: { hosts: 1, generatedHosts: ["web.example.test"], counterpartHosts: [] },
    };
    const iplan = () => defaultPlan({ items: floating as never, preflight: ppf as never });
    const dns = { serverName: "box", agentOnline: true, capabilities: ["deploy", "database"], acmeEmailOk: true, proxyBind: "public" as const, dnsCredential: false, zones: [], disk: { freeBytes: 1, totalBytes: 100 * 1024 ** 3, ageSec: 5 }, backupDestinations: 0 };
    const cs = () => preflightChecks(baseRun({ inPlace: true, topology: "swap-proxy" } as never), baseObs({ plan: iplan(), target: dns }));

    it("asks nothing about floating images, workers, builds, binds, copied data, DNS, disk or backup destinations", () => {
      const out = cs();
      const ids = out.map((c) => c.id);
      for (const gone of ["preflight.workers", "preflight.deploy-window", "preflight.bind-mounts", "preflight.db-manual", "preflight.volumes-manual", "preflight.object-store", "preflight.generated-hosts", "preflight.dns", "preflight.live-probe"]) expect(ids).not.toContain(gone);
      expect(ids.some((i) => i.startsWith("preflight.disk.") || i.startsWith("preflight.backup-"))).toBe(false);
      expect(out.filter((c) => c.ackable || c.status === "fail")).toEqual([]);
    });

    it("says in one line that every app keeps Coolify's exact image, and in one that backups come after the move", () => {
      const out = cs();
      expect(byId(out, "preflight.images")).toMatchObject({ status: "pass", code: "preflight.images-kept-exact" });
      expect(byId(out, "preflight.backups")).toMatchObject({ status: "pass", code: "preflight.backups-after-move", params: { count: 1 } });
      expect(out.find((c) => c.code === "preflight.images-unpinned")).toBeUndefined();
    });

    it("still needs the Cloudflare SSL mode of a zone (new certificates) and a working agent", () => {
      const t = { ...dns, agentOnline: false, dnsCredential: true, zones: [{ host: "web.example.test", zone: "example.test", sslMode: "flexible" }] } as never;
      const out = preflightChecks(baseRun({ inPlace: true, topology: "swap-proxy" } as never), baseObs({ plan: iplan(), target: t }));
      expect(byId(out, "preflight.agent")).toMatchObject({ status: "fail" });
      expect(byId(out, "preflight.cf-ssl-mode")).toMatchObject({ status: "fail", ackable: true });
      expect(byId(out, "preflight.dns")).toBeUndefined();
    });

    it("a copy run on the same plan keeps asking all of it", () => {
      const out = preflightChecks(baseRun(), baseObs({ plan: iplan(), target: dns }));
      const ids = out.map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining(["preflight.images", "preflight.bind-mounts", "preflight.db-manual", "preflight.dns"]));
      expect(byId(out, "preflight.images")).toMatchObject({ code: "preflight.images-unpinned" });
    });
  });
});
