import { ImportPortService } from "./import-port.service";

function make(over: { opMeta?: unknown; cancelRequestedAt?: Date | null; statusView?: unknown } = {}) {
  const prisma = {
    importSession: { findUnique: jest.fn(), update: jest.fn() },
    server: { findUnique: jest.fn().mockResolvedValue({ name: "box", proxyBind: "public", dnsCredentialId: "cred1", capabilities: ["deploy", "database"] }) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue({ meta: over.opMeta ?? {}, cancelRequestedAt: over.cancelRequestedAt ?? null }), findMany: jest.fn().mockResolvedValue([{ id: "op-9" }]) },
    application: { findUnique: jest.fn() },
    database: { findUnique: jest.fn() },
    deployment: { findMany: jest.fn() },
  };
  const source = { discover: jest.fn().mockResolvedValue({ servers: [], apps: [], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] }), close: jest.fn().mockResolvedValue(undefined), fetchServiceBundle: jest.fn() };
  const importer = { openSession: jest.fn().mockResolvedValue({ source, session: { sourceKind: "coolify" } }), resolveMapping: jest.fn(), getMapping: jest.fn(), previewServices: jest.fn(), plan: jest.fn() };
  const executor = {
    apply: jest.fn().mockResolvedValue({ opId: "op-1" }),
    status: jest.fn().mockResolvedValue(over.statusView ?? { tasks: [], plan: null }),
    cancel: jest.fn(),
    rollback: jest.fn(),
    mintMigrationToken: jest.fn().mockResolvedValue({ expiresAt: new Date("2026-11-24T00:00:00Z"), command: "CMD", commands: { dryRun: "a", run: "b", resume: "c" } }),
    reissueMigrationToken: jest.fn().mockResolvedValue({ expiresAt: new Date("2026-11-24T00:00:00Z"), command: "CMD2" }),
    remapEnvPlan: jest.fn(),
    remapEnvApply: jest.fn(),
    remapEnvUndo: jest.fn(),
  };
  const apps = { stop: jest.fn(), deploy: jest.fn(), cancelDeployment: jest.fn() };
  const dbs = { provision: jest.fn(), stop: jest.fn() };
  const agentWs = { isOnline: jest.fn().mockReturnValue(true) };
  const proxyConfig = { resolveFor: jest.fn().mockResolvedValue({ acmeEmail: "ops@acme-corp.dev" }) };
  const dns = { findZoneFor: jest.fn() };
  const svc = new ImportPortService(prisma as never, importer as never, executor as never, apps as never, dbs as never, agentWs as never, proxyConfig as never, dns as never);
  return { svc, prisma, importer, executor, apps, dbs, agentWs, proxyConfig, dns, source };
}

describe("ImportPortService", () => {
  it("sessionState: active / expired / revoked / missing / someone else's", async () => {
    const { svc, prisma } = make();
    const future = new Date(Date.now() + 60_000);
    prisma.importSession.findUnique.mockResolvedValueOnce({ actorId: "u1", status: "active", expiresAt: future });
    expect(await svc.sessionState("u1", "s1")).toBe("active");
    prisma.importSession.findUnique.mockResolvedValueOnce({ actorId: "u1", status: "active", expiresAt: new Date(Date.now() - 1) });
    expect(await svc.sessionState("u1", "s1")).toBe("expired");
    prisma.importSession.findUnique.mockResolvedValueOnce({ actorId: "u1", status: "revoked", expiresAt: future });
    expect(await svc.sessionState("u1", "s1")).toBe("expired");
    prisma.importSession.findUnique.mockResolvedValueOnce({ actorId: "other", status: "active", expiresAt: future });
    expect(await svc.sessionState("u1", "s1")).toBe("missing");
    prisma.importSession.findUnique.mockResolvedValueOnce(null);
    expect(await svc.sessionState("u1", "s1")).toBe("missing");
    expect(await svc.sessionState("u1", null)).toBe("missing");
  });

  it("plan/planHash/previewServices read the source but write NOTHING (not even the session's lastUsedAt)", async () => {
    const { svc, prisma, importer, source } = make();
    const a = await svc.plan("u1", { sessionId: "s1", sourceKind: "coolify" });
    expect(a.planHash).toMatch(/^[a-f0-9]{32}$/);
    expect(await svc.planHash("u1", { sessionId: "s1", sourceKind: "coolify" })).toBe(a.planHash);
    await svc.previewServices("u1", { sessionId: "s1", sourceKind: "coolify" });
    expect(prisma.importSession.update).not.toHaveBeenCalled();
    expect(importer.plan).not.toHaveBeenCalled(); // the importer's own plan() would touch lastUsedAt
    expect(source.close).toHaveBeenCalledTimes(3);
  });

  it("sourceVersion reads the version through verify(), closes the source, writes nothing and never returns the token", async () => {
    const { svc, prisma, source } = make();
    (source as Record<string, unknown>).verify = jest.fn().mockResolvedValue({ ok: true, version: "4.1.2" });
    expect(await svc.sourceVersion("u1", { sessionId: "s1", sourceKind: "coolify" })).toBe("4.1.2");
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(prisma.importSession.update).not.toHaveBeenCalled();
    (source as Record<string, unknown>).verify = jest.fn().mockResolvedValue({ ok: true });
    expect(await svc.sourceVersion("u1", { sessionId: "s1", sourceKind: "coolify" })).toBeNull();
    (source as Record<string, unknown>).verify = jest.fn().mockResolvedValue({ ok: false, version: "4.1.2", detail: "unreachable" });
    expect(await svc.sourceVersion("u1", { sessionId: "s1", sourceKind: "coolify" })).toBeNull();
    (source as Record<string, unknown>).verify = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(svc.sourceVersion("u1", { sessionId: "s1", sourceKind: "coolify" })).rejects.toThrow("boom");
    expect(source.close).toHaveBeenCalledTimes(4); // closed on every path
  });

  it("plan is memoized briefly, planHash never is", async () => {
    const { svc, importer } = make();
    await svc.plan("u1", { sessionId: "s1", sourceKind: "coolify" });
    await svc.plan("u1", { sessionId: "s1", sourceKind: "coolify" });
    expect(importer.openSession).toHaveBeenCalledTimes(1);
    await svc.planHash("u1", { sessionId: "s1", sourceKind: "coolify" });
    await svc.planHash("u1", { sessionId: "s1", sourceKind: "coolify" });
    expect(importer.openSession).toHaveBeenCalledTimes(3);
    await svc.plan("u1", { sessionId: "s1", sourceKind: "coolify", dbDataModes: { "database:_:x": "volume" } });
    expect(importer.openSession).toHaveBeenCalledTimes(4); // another key
  });

  it("storedMappingExists is false for an empty document", async () => {
    const { svc, importer } = make();
    importer.getMapping.mockResolvedValueOnce({ doc: null });
    expect(await svc.storedMappingExists("u1", "s1")).toBe(false);
    importer.getMapping.mockResolvedValueOnce({ doc: { items: {}, projects: {}, gitSources: {}, acks: [] } });
    expect(await svc.storedMappingExists("u1", "s1")).toBe(false);
    importer.getMapping.mockResolvedValueOnce({ doc: { items: { "app:_:a": { name: "x" } }, projects: {}, gitSources: {}, acks: [] } });
    expect(await svc.storedMappingExists("u1", "s1")).toBe(true);
  });

  it("target reports agent, capabilities, ACME validity and Cloudflare zone coverage (lookup failures are flagged, not thrown)", async () => {
    const { svc, dns, agentWs, proxyConfig } = make();
    dns.findZoneFor.mockImplementation(async (_u: string, _c: string, host: string) => {
      if (host === "boom.example.com") throw new Error("429");
      return host === "web.example.com" ? { zoneName: "example.com", sslMode: "full" } : null;
    });
    const t = await svc.target("u1", { serverId: "srv1", hosts: ["web.example.com", "x.other.org", "boom.example.com", "web.example.com"] });
    expect(t).toMatchObject({ serverName: "box", agentOnline: true, capabilities: ["deploy", "database"], acmeEmailOk: true, proxyBind: "public", dnsCredential: true });
    expect(t.zones).toEqual([
      { host: "web.example.com", zone: "example.com", sslMode: "full", lookupFailed: false },
      { host: "x.other.org", zone: null, sslMode: null, lookupFailed: false },
      { host: "boom.example.com", zone: null, sslMode: null, lookupFailed: true },
    ]);
    agentWs.isOnline.mockReturnValue(false);
    proxyConfig.resolveFor.mockResolvedValue({ acmeEmail: "admin@example.com" }); // a placeholder address is not a real one
    expect(await svc.target("u1", { serverId: "srv1", hosts: [] })).toMatchObject({ agentOnline: false, acmeEmailOk: false });
  });

  it("opSnapshot reads the op through the executor and its meta flags", async () => {
    const view = {
      tasks: [
        { itemRef: "app:_:web", kind: "app", status: "DONE", resourceType: "application", resourceId: "a1", name: "web", git: { status: "needs_source" } },
        { itemRef: "database:_:db", kind: "database", status: "PENDING", resourceType: null, resourceId: null, name: null },
      ],
      plan: { items: [{ itemRef: "app:_:web", kind: "app", dependsOn: ["database:_:db"] }, { itemRef: 5, kind: "x" }] },
    };
    const { svc } = make({ opMeta: { rolledBackAt: "2026-11-23T08:00:00Z" }, cancelRequestedAt: new Date(), statusView: view });
    const snap = await svc.opSnapshot("u1", "op-1");
    expect(snap).toMatchObject({ id: "op-1", rolledBack: true, cancelRequested: true });
    expect(snap.tasks[0]).toMatchObject({ resourceId: "a1", gitStatus: "needs_source" });
    expect(snap.tasks[1].gitStatus).toBeNull();
    expect(snap.planItems).toEqual([{ itemRef: "app:_:web", kind: "app", dependsOn: ["database:_:db"] }]);
  });

  it("opsSince is scoped to the actor, the server and the import kind", async () => {
    const { svc, prisma } = make();
    expect(await svc.opsSince("u1", "srv1", new Date("2026-11-23T08:00:00Z"))).toEqual(["op-9"]);
    expect(prisma.bulkOperation.findMany.mock.calls[0][0].where).toMatchObject({ kind: "import", actorId: "u1", meta: { path: ["serverId"], equals: "srv1" } });
  });

  it("opItems maps tasks to report rows with fixed codes (never the task's free-text message)", async () => {
    const view = {
      tasks: [
        { itemRef: "app:_:a", kind: "app", status: "DONE", resourceType: "application", resourceId: "a", name: "a" },
        { itemRef: "database:_:d", kind: "database", status: "SKIPPED", resourceType: null, resourceId: null, name: "d", message: "secret reason text" },
        { itemRef: "app:_:f", kind: "app", status: "FAILED_VERIFY", resourceType: null, resourceId: null, name: "f" },
        { itemRef: "data:volume:app:_:a:/x", kind: "data", status: "DONE", resourceType: null, resourceId: null, name: null },
        { itemRef: "volume:_:v", kind: "volume", status: "SKIPPED", resourceType: null, resourceId: null, name: "v" },
      ],
      plan: null,
    };
    const { svc } = make({ statusView: view });
    const items = await svc.opItems("u1", "op-1");
    expect(items).toEqual([
      { kind: "app", name: "a", outcome: "moved", code: null, evidence: "hub-verified" },
      { kind: "database", name: "d", outcome: "skipped", code: "import.task-skipped", evidence: "hub-verified" },
      { kind: "app", name: "f", outcome: "failed", code: "import.task-failed-verify", evidence: "hub-verified" },
      { kind: "volume", name: "data:volume:app:_:a:/x", outcome: "moved", code: null, evidence: "hub-verified" },
    ]);
    expect(JSON.stringify(items)).not.toContain("secret reason text");
  });

  it("mintCommand mints or reissues and passes the certs flag", async () => {
    const { svc, executor } = make();
    expect(await svc.mintCommand("u1", "op-1", "https://hub", { reissue: false, certs: true })).toMatchObject({ command: "CMD", commands: { run: "b" } });
    expect(executor.mintMigrationToken).toHaveBeenCalledWith("u1", "op-1", "https://hub", { certs: true });
    expect(await svc.mintCommand("u1", "op-1", "https://hub", { reissue: true, certs: false })).toEqual({ expiresAt: new Date("2026-11-24T00:00:00Z"), command: "CMD2" });
    expect(executor.reissueMigrationToken).toHaveBeenCalledWith("u1", "op-1", "https://hub", { certs: false });
  });

  it("remap: pending flag from the undo record, summary counts, apply result and undo outcome", async () => {
    const m = make({ opMeta: { remapUndo: { appliedAt: "x" } } });
    expect(await m.svc.remapPending("u1", "op-1")).toBe(true);
    const m2 = make({ opMeta: { remapUndo: { appliedAt: "x", undoneAt: "y" } } });
    expect(await m2.svc.remapPending("u1", "op-1")).toBe(false);
    m.executor.remapEnvPlan.mockResolvedValue({ planHash: "e".repeat(64), apps: [{ changes: [1], needsManual: [] }, { changes: [], needsManual: [1, 2] }, { changes: [1], needsManual: [1] }] });
    expect(await m.svc.remapPlan("u1", "op-1")).toEqual({ planHash: "e".repeat(64), appsToWrite: 2, needsManualKeys: 3, needsManualApps: 2 });
    m.executor.remapEnvApply.mockResolvedValue({ applied: false, failed: [{}], linkFailed: [{}, {}] });
    expect(await m.svc.remapApply("u1", "op-1", "tok")).toEqual({ applied: false, failed: 1, linkFailed: 2 });
    m.executor.remapEnvApply.mockResolvedValue({ applied: false, failed: [], linkFailed: [{}] });
    expect((await m.svc.remapApply("u1", "op-1", "tok")).applied).toBe(true); // a link failure leaves the env written
    m.executor.remapEnvUndo.mockResolvedValue({ undone: false });
    expect(await m.svc.remapUndo("u1", "op-1")).toBe(false);
  });

  it("app/db state tolerate a deleted resource; deploy passes the idempotency key and maps the row", async () => {
    const { svc, prisma, apps, dbs } = make();
    prisma.application.findUnique.mockResolvedValueOnce({ status: "RUNNING", name: "web" }).mockResolvedValueOnce(null);
    expect(await svc.appState("u1", "a1")).toEqual({ exists: true, status: "RUNNING", name: "web" });
    expect(await svc.appState("u1", "a1")).toEqual({ exists: false, status: "NEW", name: null });
    prisma.database.findUnique.mockResolvedValueOnce({ status: "STOPPED", name: "pg" });
    expect(await svc.dbState("u1", "d1")).toEqual({ exists: true, status: "STOPPED", name: "pg" });
    dbs.provision.mockResolvedValue({ status: "RUNNING", name: "pg" });
    expect(await svc.startDb("u1", "d1")).toEqual({ exists: true, status: "RUNNING", name: "pg" });
    apps.deploy.mockResolvedValue({ id: "dep1", idempotencyKey: "migrun:r:a", status: "SUCCESS", trigger: "manual", requestedBy: "u1" });
    expect(await svc.deploy("u1", "a1", "migrun:r:a")).toEqual({ id: "dep1", key: "migrun:r:a", status: "SUCCESS", trigger: "manual", requestedBy: "u1" });
    expect(apps.deploy).toHaveBeenCalledWith("u1", "a1", undefined, "migrun:r:a");
    prisma.deployment.findMany.mockResolvedValue([{ id: "d", idempotencyKey: "migrun:r:a", status: "FAILED", trigger: "manual", requestedBy: "u1" }]);
    expect(await svc.deployments("a1", "migrun:r:a")).toEqual([{ id: "d", key: "migrun:r:a", status: "FAILED", trigger: "manual", requestedBy: "u1" }]);
    expect(prisma.deployment.findMany.mock.calls[0][0].where).toEqual({ appId: "a1", idempotencyKey: { startsWith: "migrun:r:a" } });
    apps.cancelDeployment.mockResolvedValue({ id: "d" });
    await expect(svc.cancelDeployment("u1", "a1", "d")).resolves.toBeUndefined();
    expect(apps.cancelDeployment).toHaveBeenCalledWith("u1", "a1", "d");
  });
});
