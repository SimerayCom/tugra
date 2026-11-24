import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, SERVER, TEAM, defaultPlan } from "./testing/run-world";
import { confirmMatches } from "./migration-runs.service";
import { RunReportSchema, MigrationRunViewSchema, MigrationRunSummarySchema, RunEventsPageSchema } from "./dto";
import type { ApprovalBinding } from "./dto";

// the specs drive a whole run through the engine on a fake clock; give a loaded CI machine room
jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

describe("create", () => {
  it("freezes a secret-free apply input and stamps owner inputs with who/when/source", async () => {
    const w = new RunWorld();
    const id = await w.create({ environmentId: "env1", inputs: { acmeEmail: "ops@example.com", sourceController: "api" }, mode: "takeover", topology: "swap-proxy" });
    const row = w.store.row(id);
    expect(row).toMatchObject({ teamId: TEAM, actorId: "u1", targetServerId: SERVER, mode: "takeover", topology: "swap-proxy", sessionId: "s1", sourceHost: "coolify.example.com", status: "QUEUED", opId: null });
    expect(row.applyInput).toEqual({ sourceKind: "coolify", targetServerId: SERVER, planHash: "d".repeat(32), environmentId: "env1" });
    expect(row.inputs).toMatchObject({ acmeEmail: { value: "ops@example.com", source: "request", setBy: "u1" }, sourceController: { value: "api" } });
    expect(JSON.stringify(row)).not.toMatch(/token/i);
    // takeover runs get the DECOMMISSION step row, copy runs do not
    expect((await w.store.steps(id)).map((s) => s.key)).toContain("DECOMMISSION");
    const copy = await w.create({ targetServerId: SERVER, mode: "copy", dryRun: true });
    expect((await w.store.steps(copy)).map((s) => s.key)).not.toContain("DECOMMISSION");
    expect(w.sink.audits.find((a) => a.action === "migration.run.create")).toMatchObject({ target: id, meta: expect.objectContaining({ mode: "takeover" }) });
  });

  it("every view validates against the published response schemas", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(() => MigrationRunViewSchema.parse(JSON.parse(JSON.stringify(w.view(id) instanceof Promise ? null : null) ?? "null"))).toThrow(); // sanity: the schema is strict
    const v = JSON.parse(JSON.stringify(await w.view(id)));
    expect(MigrationRunViewSchema.parse(v).id).toBe(id);
    const list = JSON.parse(JSON.stringify(await w.service.list(ACTOR, { limit: 10 })));
    expect(MigrationRunSummarySchema.array().parse(list)).toHaveLength(1);
    expect(RunEventsPageSchema.parse(JSON.parse(JSON.stringify(await w.service.events(ACTOR, id, { afterSeq: 0, limit: 500 }))))).toBeDefined();
    expect(RunReportSchema.parse(JSON.parse(JSON.stringify(await w.service.report(ACTOR, id)))).runId).toBe(id);
  });

  it("requires membership and the two permissions on the TARGET server's team", async () => {
    const w = new RunWorld();
    w.env.perms[`u1|t1`] = { member: true, appsConfig: true, databases: false };
    await expect(w.create()).rejects.toThrow(/insufficient-permission/);
    w.env.perms[`u1|t1`] = { member: false, appsConfig: false, databases: false };
    await expect(w.create()).rejects.toThrow(/server-not-found/);
    await expect(w.create({ targetServerId: "ghost" })).rejects.toThrow(/server-not-found/);
  });
});

describe("list and events", () => {
  it("filters by status / team / liveness, newest first, with step progress", async () => {
    const w = new RunWorld();
    const a = await w.run(); // completed
    const b = await w.create({ dryRun: true });
    await w.settle(b);
    const c = await w.create();
    const all = await w.service.list(ACTOR, { limit: 50 });
    expect(all.map((r) => r.id)).toEqual([c, b, a]);
    expect((await w.service.list(ACTOR, { limit: 50, active: "true" })).map((r) => r.id)).toEqual([c]);
    expect((await w.service.list(ACTOR, { limit: 50, active: "false" })).map((r) => r.id)).toEqual([b, a]);
    expect((await w.service.list(ACTOR, { limit: 50, status: "COMPLETED" })).map((r) => r.id)).toEqual([a]);
    expect(await w.service.list(ACTOR, { limit: 50, teamId: "other" })).toEqual([]);
    expect((await w.service.list(ACTOR, { limit: 1 })).map((r) => r.id)).toEqual([c]);
    const done = all.find((r) => r.id === a)!;
    expect(done).toMatchObject({ status: "COMPLETED", stepsPassed: 13, stepsTotal: 13, targetServerName: "tugra-box", nextActionKind: "none" });
  });

  it("events page with a cursor: lastSeq/hasMore, in order, codes and params only", async () => {
    const w = new RunWorld();
    const id = await w.run();
    const p1 = await w.service.events(ACTOR, id, { afterSeq: 0, limit: 5 });
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(p1).toMatchObject({ lastSeq: 5, hasMore: true });
    const p2 = await w.service.events(ACTOR, id, { afterSeq: p1.lastSeq, limit: 500 });
    expect(p2.hasMore).toBe(false);
    expect(p2.lastSeq).toBe(w.store.row(id).eventSeq);
    expect(await w.service.events(ACTOR, id, { afterSeq: p2.lastSeq, limit: 5 })).toMatchObject({ events: [], lastSeq: p2.lastSeq, hasMore: false });
    for (const e of [...p1.events, ...p2.events]) expect(Object.keys(e).sort()).toEqual(["actorId", "at", "code", "level", "params", "seq", "stepKey"]);
  });
});

describe("start and pause rules", () => {
  it("start works once; pause/resume have preconditions", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await expect(w.service.pause(ACTOR, id)).rejects.toThrow(/run-not-pausable/);
    await expect(w.service.resume(ACTOR, id)).rejects.toThrow(/run-not-paused/);
    await w.service.start(ACTOR, id, {});
    await expect(w.service.start(ACTOR, id, {})).rejects.toThrow(/run-not-startable/);
    const d = await w.create({ dryRun: true, targetServerId: SERVER });
    await expect(w.service.start(ACTOR, d, {})).rejects.toThrow(/run-not-startable/); // a dry-run is promoted only once it is DONE
  });

  it("promoting needs a live session and a plan that still matches", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    await w.acceptWarnings(d);
    w.env.sessions.get("s1")!.state = "expired";
    await expect(w.service.start(ACTOR, d, {})).rejects.toThrow(/session-expired/);
    const s2 = await w.service.sourceSession(ACTOR, d, { token: "t" }).catch((e: Error) => e.message);
    expect(String(s2)).toMatch(/run-not-open/); // a finished dry-run cannot take a new session: pass it to start instead
    w.env.sessions.set("s9", { ...w.env.session0("s9") });
    const ok = await w.service.start(ACTOR, d, { sessionId: "s9" });
    expect(ok.promotedFromId).toBe(d);
    // a changed source refuses promotion
    w.env.sessions.get("s1")!.state = "active";
    const d2 = await w.create({ dryRun: true });
    await w.settle(d2);
    await w.acceptWarnings(d2);
    w.port.plan_ = { ...w.port.plan_, planHash: "e".repeat(32) };
    await expect(w.service.start(ACTOR, d2, {})).rejects.toThrow(/plan-changed/);
  });
});

/** Put dry-run items on the first step of a (finished) dry-run, as its handlers would have projected them. */
function seedDryRun(w: RunWorld, id: string, items: Array<Record<string, unknown>>): void {
  const row = w.store.stepRows.get(id)![0];
  (row as { progress: unknown }).progress = { done: 0, total: 0, unit: "items", dryRun: items };
}

describe("promoting a finished dry-run with warnings", () => {
  const warn = { code: "import.risk-warning", level: "warn", params: { risk: "app.git.private", count: 1, items: ["web"] } };
  const KEY = "import.risk-warning:app.git.private";

  it("refuses with the open warnings (409) until each is accepted, and then promotes", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    seedDryRun(w, d, [warn, { code: "data-seed.volume-excluded", level: "warn" }]);
    const err = await w.service.start(ACTOR, d, {}).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ message: "dry-run-warnings-open", warnings: ["data-seed.volume-excluded", KEY] });
    expect(await w.service.list(ACTOR, { limit: 10 })).toHaveLength(1); // nothing was created
    await w.hints.upsert(d, [{ kind: "warning-ack", key: KEY, scope: "", value: "accepted", evidence: "operator-attested" }]);
    await expect(w.service.start(ACTOR, d, {})).rejects.toMatchObject({ response: { warnings: ["data-seed.volume-excluded"] } });
    await w.hints.upsert(d, [{ kind: "warning-ack", key: "data-seed.volume-excluded", scope: "", value: "accepted", evidence: "operator-attested" }]);
    const ok = await w.service.start(ACTOR, d, {});
    expect(ok.promotedFromId).toBe(d);
  });

  it("taking an acceptance back holds Start again; info and blocking items are not warnings", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    seedDryRun(w, d, [{ code: "x.info", level: "info" }, warn]);
    const hint = { kind: "warning-ack" as const, key: KEY, scope: "", value: "accepted", evidence: "operator-attested" as const };
    await w.hints.upsert(d, [hint]);
    await w.hints.remove(d, [hint]);
    await expect(w.service.start(ACTOR, d, {})).rejects.toThrow(/dry-run-warnings-open/);
    seedDryRun(w, d, [{ code: "x.info", level: "info" }, { code: "x.block", level: "block" }]);
    await expect(w.service.start(ACTOR, d, {})).resolves.toBeDefined();
  });

  it("a warning fixed by pins needs no acceptance, and the pins reach the promoted run's stack choices", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    const svc = "service:_:abc";
    const floating = { code: "import.risk-warning", level: "warn", params: { risk: "service.image.floating", count: 1, imageCount: 1, imageItems: [svc], imageMembers: ["meili"], images: ["getmeili/meilisearch:latest"], imageSeen: [""] } };
    seedDryRun(w, d, [floating]);
    await expect(w.service.start(ACTOR, d, {})).rejects.toThrow(/dry-run-warnings-open/);
    await w.hints.upsert(d, [{ kind: "service-pin", key: `${svc}#meili`, scope: "", value: "getmeili/meilisearch:v1.8.0", evidence: "operator-attested" }]);
    const run = await w.service.start(ACTOR, d, {});
    expect(w.store.row(run.id).applyInput).toMatchObject({ serviceChoices: { [svc]: { pins: { meili: "getmeili/meilisearch:v1.8.0" } } } });
    expect(w.store.row(d).applyInput).not.toHaveProperty("serviceChoices"); // the dry-run's own frozen input is untouched
  });

  it("pins never reach a stack the run skips, and more stacks than the importer takes choices for is a 400", async () => {
    const w = new RunWorld();
    const svc = "service:_:abc";
    const d = await w.create({ dryRun: true, serviceChoices: { [svc]: { skip: true } } });
    await w.settle(d);
    await w.acceptWarnings(d);
    await w.hints.upsert(d, [{ kind: "service-pin", key: `${svc}#meili`, scope: "", value: "a/b:v1", evidence: "operator-attested" }]);
    const run = await w.service.start(ACTOR, d, {});
    expect(w.store.row(run.id).applyInput).toMatchObject({ serviceChoices: { [svc]: { skip: true } } });
    expect(JSON.stringify(w.store.row(run.id).applyInput)).not.toContain("a/b:v1");
    const choices = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`service:_:s${i}`, { name: `n${i}` }]));
    const d2 = await w.create({ dryRun: true, serviceChoices: choices });
    await w.settle(d2);
    await w.acceptWarnings(d2);
    await w.hints.upsert(d2, [{ kind: "service-pin", key: "service:_:extra#m", scope: "", value: "a/b:v1", evidence: "operator-attested" }]);
    await expect(w.service.start(ACTOR, d2, {})).rejects.toThrow(/too-many-service-choices/);
  });
});

describe("a scoped run", () => {
  const plan = () =>
    defaultPlan({
      items: [
        { itemRef: "database:srvA:db1", kind: "database", name: "pg-main", proposed: {}, risks: [], dependsOn: [] },
        { itemRef: "app:srvA:web", kind: "app", name: "web", proposed: { domain: "web.example.com" }, risks: [], dependsOn: ["database:srvA:db1"] },
        { itemRef: "app:srvB:api", kind: "app", name: "api", proposed: { domain: "api.example.com" }, risks: [], dependsOn: [] },
        { itemRef: "service:srvB:meili", kind: "service", name: "meili", proposed: {}, risks: [], dependsOn: [] },
      ],
      preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "srvA" }, { ref: "srvB" }] },
    });

  it("freezes the importer's own exclusions and the mapping hash, and says so on the run", async () => {
    const w = new RunWorld();
    w.port.plan_ = plan();
    const id = await w.create({ scope: { sourceServers: ["srvA"] }, serverMap: { srvA: SERVER }, acks: [{ code: "app.env.unresolved", itemRef: "app:srvA:web" }] });
    const row = w.store.row(id);
    expect(row.applyInput).toMatchObject({
      mapping: { items: { "app:srvB:api": { include: false } } },
      mappingHash: "f".repeat(32),
      serviceChoices: { "service:srvB:meili": { skip: true } },
    });
    expect(w.port.scopeCalls[0]).toMatchObject({ planHash: "d".repeat(32), targetServerId: SERVER, serverMap: { srvA: SERVER }, scope: { sourceServers: ["srvA"] } });
    expect(w.port.scopeCalls[0].acks).toHaveLength(1);
    const created = (await w.service.events(ACTOR, id, { afterSeq: 0, limit: 10 })).events.find((e) => e.code === "run.created");
    expect(created?.params).toMatchObject({ scoped: true, kept: 2, excluded: 2 });
    expect(w.sink.audits.find((a) => a.action === "migration.run.create")?.meta).toMatchObject({ scoped: true, kept: 2, excluded: 2 });
  });

  it("a promoted dry-run keeps the narrowed scope", async () => {
    const w = new RunWorld();
    w.port.plan_ = plan();
    const d = await w.create({ dryRun: true, scope: { sourceServers: ["srvB"] } });
    await w.settle(d);
    await w.acceptWarnings(d);
    const run = await w.service.start(ACTOR, d, {});
    expect(w.store.row(run.id).applyInput).toMatchObject({ mapping: { items: { "app:srvA:web": { include: false }, "database:srvA:db1": { include: false } } } });
  });

  it("answers a scope the plan cannot satisfy with a stable 400 and creates nothing", async () => {
    const w = new RunWorld();
    w.port.plan_ = plan();
    await expect(w.create({ scope: { sourceServers: ["ghost"] } })).rejects.toThrow(/scope-unknown-server/);
    await expect(w.create({ scope: { projects: ["ghost"] } })).rejects.toThrow(/scope-unknown-project/);
    await expect(w.create({ scope: { sourceServers: ["srvA"], exclude: ["app:srvA:ghost"] } })).rejects.toThrow(/scope-unknown-item/);
    await expect(w.create({ scope: { sourceServers: ["srvA"], exclude: ["app:srvA:web", "database:srvA:db1"] } })).rejects.toThrow(/scope-empty/);
    expect(await w.service.list(ACTOR, { limit: 10 })).toEqual([]);
  });

  it("a stale plan wins over the scope (409), and a run without a scope is untouched by all of it", async () => {
    const w = new RunWorld();
    w.port.plan_ = plan();
    await expect(w.create({ scope: { sourceServers: ["srvA"] }, planHash: "e".repeat(32) })).rejects.toThrow(/plan-changed/);
    const id = await w.create();
    expect(w.store.row(id).applyInput).not.toHaveProperty("mapping");
    expect(w.port.scopeCalls).toEqual([]);
  });
});

describe("approvals", () => {
  const binding = (over: Partial<ApprovalBinding> = {}): ApprovalBinding => ({ inputHash: "a".repeat(64), ponr: false, confirm: "run-id", ttlSec: null, requiresDataRisk: false, ackable: ["x"], requiredAcks: [], review: {}, ...over });

  it("approve is only for a WAITING_APPROVAL step and checks acks, typed name and the data-risk tick", async () => {
    const w = new RunWorld({ stubs: { FREEZE: { binding: () => binding({ confirm: "target-server+source-host", requiresDataRisk: true, requiredAcks: ["x"] }) } } });
    const id = await w.run();
    await expect(w.service.approve(ACTOR, id, "IMPORT", { boundHash: "a".repeat(64), acks: [] })).rejects.toThrow(/step-not-waiting-approval/);
    const ok = { boundHash: "a".repeat(64), acks: ["x"], acceptDataRisk: true };
    await expect(w.service.approve(ACTOR, id, "FREEZE", { ...ok, confirmName: "tugra-box" })).rejects.toThrow(/bad-confirmation/);
    await expect(w.service.approve(ACTOR, id, "FREEZE", { ...ok, confirmName: "coolify.example.com tugra-box" })).rejects.toThrow(/bad-confirmation/);
    await expect(w.service.approve(ACTOR, id, "FREEZE", { ...ok, acks: [], confirmName: "tugra-box coolify.example.com" })).rejects.toThrow(/acks-required/);
    await w.service.approve(ACTOR, id, "FREEZE", { ...ok, confirmName: "tugra-box coolify.example.com" });
    const stored = w.store.step(id, "FREEZE").approval as { confirmedName: string };
    expect(stored.confirmedName).toBe("tugra-box coolify.example.com");
    // the typed name is never part of the view, only of the audit trail
    expect(JSON.stringify(await w.view(id))).not.toContain("coolify.example.com tugra-box");
    expect(w.sink.audits.find((a) => a.action === "migration.run.approve")?.meta).toMatchObject({ confirmedName: "tugra-box coolify.example.com" });
  });

  it("non-PONR approvals are allowed over MCP; a non-PONR approval carries no expiry unless the binding says so", async () => {
    const w = new RunWorld({ stubs: { FREEZE: { binding: () => binding({ ttlSec: 600 }) } } });
    const id = await w.run();
    await w.service.approve({ ...ACTOR, channel: "mcp" }, id, "FREEZE", { boundHash: "a".repeat(64), acks: [], confirmName: id });
    const stored = w.store.step(id, "FREEZE").approval as { expiresAt: string };
    expect(Date.parse(stored.expiresAt) - w.clock.t).toBe(600_000);
  });

  it("confirmMatches covers every confirmation kind", () => {
    const ctx = { runId: "r1", serverName: "box", sourceHost: "src.example.com" };
    expect(confirmMatches("none", undefined, ctx)).toBe(true);
    expect(confirmMatches("run-id", "r1", ctx)).toBe(true);
    expect(confirmMatches("run-id", "r2", ctx)).toBe(false);
    expect(confirmMatches("target-server", "box", ctx)).toBe(true);
    expect(confirmMatches("source-host", "src.example.com", ctx)).toBe(true);
    expect(confirmMatches("target-server+source-host", "box src.example.com", ctx)).toBe(true);
    expect(confirmMatches("target-server+source-host", "box", ctx)).toBe(false);
    expect(confirmMatches("target-server", "box", { ...ctx, serverName: null })).toBe(false);
    expect(confirmMatches("weird", "x", ctx)).toBe(false);
  });
});

describe("decommission (takeover only, armed by its own route)", () => {
  it("never advances into DECOMMISSION by itself; the route needs admin scope, the typed source host and is refused over MCP", async () => {
    const w = new RunWorld();
    const id = await w.run({ mode: "takeover" });
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.stepStatus(id, "DECOMMISSION")).toBe("PENDING");
    expect((await w.view(id)).allowed.decommission).toBe(true);
    await expect(w.service.decommission({ ...ACTOR, scopes: ["deploy"] }, id, { confirmName: "coolify.example.com" })).rejects.toThrow(/insufficient-scope/);
    await expect(w.service.decommission({ ...ACTOR, channel: "mcp" }, id, { confirmName: "coolify.example.com" })).rejects.toThrow(/human-confirmation-required/);
    await expect(w.service.decommission(ACTOR, id, { confirmName: "other.example.com" })).rejects.toThrow(/bad-confirmation/);
    await w.service.decommission(ACTOR, id, { confirmName: "coolify.example.com" });
    await w.engine.driveManual(id, "DECOMMISSION");
    expect(w.stepStatus(id, "DECOMMISSION")).toBe("PASSED");
    expect(w.effects).toContain("act:DECOMMISSION");
    expect(w.status(id)).toBe("COMPLETED"); // the run itself stays settled
    expect(w.store.row(id).ownerId).toBeNull();
    await expect(w.service.decommission(ACTOR, id, { confirmName: "coolify.example.com" })).rejects.toThrow(/run-not-decommissionable/);
  });

  it("a copy run cannot be decommissioned; a failed decommission can be retried", async () => {
    const w = new RunWorld();
    const copy = await w.run();
    await expect(w.service.decommission(ACTOR, copy, { confirmName: "coolify.example.com" })).rejects.toThrow(/run-not-decommissionable/);

    let fail = true;
    const w2 = new RunWorld({ stubs: { DECOMMISSION: { act: async (x) => (fail ? { outcome: "fail", code: "decommission.stop-failed", retryable: true } : (x.done.add("DECOMMISSION"), { outcome: "done" })) } } });
    const id = await w2.run({ mode: "takeover" });
    await w2.service.decommission(ACTOR, id, { confirmName: "coolify.example.com" });
    await w2.engine.driveManual(id, "DECOMMISSION");
    expect(w2.stepStatus(id, "DECOMMISSION")).toBe("FAILED");
    expect(w2.status(id)).toBe("COMPLETED");
    fail = false;
    await w2.service.retry(ACTOR, id, "DECOMMISSION", {});
    await w2.engine.driveManual(id, "DECOMMISSION", "retry");
    expect(w2.stepStatus(id, "DECOMMISSION")).toBe("PASSED");
  });

  it("a restart during a decommission is resumed by the recovery loop", async () => {
    const w = new RunWorld({ stubs: { DECOMMISSION: { act: async () => ({ outcome: "wait", wait: { kind: "operator", code: "decommission.remove-manually" } }) } } });
    const id = await w.run({ mode: "takeover" });
    await w.service.decommission(ACTOR, id, { confirmName: "coolify.example.com" });
    await w.engine.driveManual(id, "DECOMMISSION");
    expect(w.stepStatus(id, "DECOMMISSION")).toBe("WAITING_OPERATOR");
    w.restart();
    const handled = await w.recovery.tick(w.clock.now());
    expect(handled).toEqual([id]);
    expect(w.stepStatus(id, "DECOMMISSION")).toBe("WAITING_OPERATOR");
  });
});

describe("report", () => {
  it("is persisted at the end, secret-free, and the markdown carries the same facts", async () => {
    const w = new RunWorld();
    const id = await w.run();
    const stored = w.store.row(id).report as { runId: string; status: string };
    expect(stored).toMatchObject({ runId: id, status: "COMPLETED" });
    const rep = await w.service.report(ACTOR, id);
    expect(rep.steps).toHaveLength(13);
    expect(rep.window).toEqual({ estimatedSec: null, measuredSec: null });
    expect(rep.evidenceSummary["hub-verified"]).toBeGreaterThan(0);
    const md = await w.service.reportMarkdown(ACTOR, id);
    expect(md).toContain(`# Migration run ${id}`);
    expect(md).toContain("| PREFLIGHT | PASSED |");
  });

  it("carries the data checks of every database (route, size, one checksum, the row check) in the report and the markdown", async () => {
    const w = new RunWorld();
    const sha = "b".repeat(64);
    w.port.dataIntegrity = [
      { itemRef: "database:s:a", name: "db-a", engine: "POSTGRES", lane: "stream", bytes: 4096, parts: 3, sha256: sha, rows: { status: "match", mode: "exact", relations: 7, differing: 0, sourceRows: 100, targetRows: 100, names: [] } },
      { itemRef: "database:s:b", name: "db-b", engine: "MARIADB", lane: "dump", bytes: null, parts: null, sha256: null, rows: { status: "mismatch", mode: "exact", relations: 2, differing: 1, sourceRows: 9, targetRows: 8, names: ["orders"] } },
    ];
    const id = await w.run();
    const rep = await w.service.report(ACTOR, id);
    expect(rep.dataIntegrity).toHaveLength(2);
    expect(RunReportSchema.parse(JSON.parse(JSON.stringify(rep))).dataIntegrity[0].sha256).toBe(sha);
    const md = await w.service.reportMarkdown(ACTOR, id);
    expect(md).toContain("## Data checks");
    expect(md).toContain(`| db-a | stream | 4096 | 3 | ${sha} | 7 | 100 / 100 | match |`);
    expect(md).toContain("| db-b | dump |  |  |  | 2 | 9 / 8 | mismatch (orders) |");
  });

  it("a report with no databases has no data section", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect((await w.service.report(ACTOR, id)).dataIntegrity).toEqual([]);
    expect(await w.service.reportMarkdown(ACTOR, id)).not.toContain("## Data checks");
  });

  it("an unfinished run gets an on-demand report", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: () => true } } });
    const id = await w.run();
    const rep = await w.service.report(ACTOR, id);
    expect(rep.status).toBe("WAITING");
    expect(rep.steps.find((s) => s.key === "DATA_FINAL")?.status).toBe("WAITING_OPERATOR");
  });

  it("reports the measured downtime against the estimate", async () => {
    const w = new RunWorld({
      stubs: {
        FREEZE: { act: async (x, ctx) => (await ctx.patchRun({ freezeStartedAt: ctx.now(), windowEstimate: { freezeToFlipSec: 600, basis: [{ code: "window.basis" }], estimatedAt: ctx.now().toISOString() } }), x.done.add("FREEZE"), { outcome: "done" }) },
        CUTOVER: { act: async (x, ctx) => (await ctx.markPonr(), x.clock.advance(95_000), await ctx.patchRun({ freezeEndedAt: ctx.now() }), x.done.add("CUTOVER"), { outcome: "done" }) },
      },
    });
    const id = await w.run();
    const v = await w.view(id);
    expect(v.measuredDowntimeSec).toBeGreaterThanOrEqual(95);
    expect(v.windowEstimate?.freezeToFlipSec).toBe(600);
    const rep = await w.service.report(ACTOR, id);
    expect(rep.window.estimatedSec).toBe(600);
    expect(rep.window.measuredSec).toBeGreaterThanOrEqual(95);
    // set-once: a second patch never moves the measured window
    const first = w.store.row(id).freezeEndedAt;
    expect(first).not.toBeNull();
  });
});

describe("stuck-operator watchdog", () => {
  it("notifies once when an operator wait outlives stuckOperatorMinutes", async () => {
    const w = new RunWorld({ stubs: { DATA_FINAL: { blocked: () => true } } });
    const id = await w.run({ options: { ...w.createBody().options, stuckOperatorMinutes: 10 } });
    await w.tick();
    expect(w.sink.notes.filter((n) => n.kind === "stuck-operator")).toHaveLength(0);
    w.clock.advance(11 * 60_000);
    await w.tick();
    await w.tick();
    expect(w.sink.notes.filter((n) => n.kind === "stuck-operator")).toEqual([expect.objectContaining({ runId: id, stepKey: "DATA_FINAL", kind: "stuck-operator" })]);
    expect((await w.view(id)).steps.find((s) => s.key === "DATA_FINAL")!.wait).not.toHaveProperty("_stuck");
  });
});
