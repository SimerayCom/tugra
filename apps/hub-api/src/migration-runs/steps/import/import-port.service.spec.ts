import { ImportPortService, pinComposeMembers } from "./import-port.service";

function make(over: { opMeta?: unknown; cancelRequestedAt?: Date | null; statusView?: unknown } = {}) {
  const prisma = {
    importSession: { findUnique: jest.fn(), update: jest.fn() },
    migrationRun: { findMany: jest.fn().mockResolvedValue([]) },
    server: { findUnique: jest.fn().mockResolvedValue({ name: "box", proxyBind: "public", dnsCredentialId: "cred1", capabilities: ["deploy", "database"], teamId: "team1", os: "ubuntu", osVersion: "24.04" }) },
    metric: { findFirst: jest.fn().mockResolvedValue({ diskUsed: BigInt(30 * 1024 ** 3), diskTotal: BigInt(100 * 1024 ** 3), ts: new Date(Date.now() - 60_000) }) },
    backupDestination: { count: jest.fn().mockResolvedValue(2) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue({ meta: over.opMeta ?? {}, cancelRequestedAt: over.cancelRequestedAt ?? null }), findMany: jest.fn().mockResolvedValue([{ id: "op-9" }]) },
    application: { findUnique: jest.fn() },
    database: { findUnique: jest.fn() },
    deployment: { findMany: jest.fn() },
    bulkTask: { findFirst: jest.fn().mockResolvedValue(null) },
    migrationRunHint: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const source = { discover: jest.fn().mockResolvedValue({ servers: [], apps: [], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] }), close: jest.fn().mockResolvedValue(undefined), fetchServiceBundle: jest.fn() };
  const importer = { consentState: jest.fn().mockResolvedValue({ applies: true, standing: true, classes: ["env"], agentServerId: "srv" }), endSessionConsent: jest.fn().mockResolvedValue(undefined), openSession: jest.fn().mockResolvedValue({ source, session: { sourceKind: "coolify" } }), resolveMapping: jest.fn(), getMapping: jest.fn(), previewServices: jest.fn(), plan: jest.fn() };
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
  const apps = { stop: jest.fn(), deploy: jest.fn(), cancelDeployment: jest.fn(), setAutoDeploy: jest.fn(), prebuild: jest.fn(), setSource: jest.fn(), setComposeFile: jest.fn() };
  const dbs = { provision: jest.fn(), stop: jest.fn(), setImage: jest.fn() };
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

  it("target reports the free disk, the OS and the team's backup destinations (R7); a missing reading and a failed read are both said, never left out", async () => {
    const { svc, prisma } = make();
    const t = await svc.target("u1", { serverId: "srv1", hosts: [] });
    expect(t.disk).toMatchObject({ totalBytes: 100 * 1024 ** 3, freeBytes: 70 * 1024 ** 3 });
    expect(t.disk!.ageSec).toBeGreaterThanOrEqual(59);
    expect(t).toMatchObject({ os: "ubuntu", osVersion: "24.04", backupDestinations: 2 });
    expect(prisma.backupDestination.count).toHaveBeenCalledWith({ where: { teamId: "team1" } });
    // the server never reported a metric: the fact is `null` (the gate says so), never "free"
    prisma.metric.findFirst.mockResolvedValueOnce(null);
    expect((await svc.target("u1", { serverId: "srv1", hosts: [] })).disk).toBeNull();
    // the read itself failed: the fact is given as unreadable (null), not left out, so the gate can say so
    prisma.metric.findFirst.mockRejectedValueOnce(new Error("db down"));
    prisma.backupDestination.count.mockRejectedValueOnce(new Error("db down"));
    const t3 = await svc.target("u1", { serverId: "srv1", hosts: [] });
    expect(t3.disk).toBeNull();
    expect(t3.backupDestinations).toBeNull();
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

  it("sourceHealth reads the source's health through healthBaseline(), closes it, and is null for a source with none", async () => {
    const { svc, prisma, source } = make();
    const rows = [{ kind: "app", ref: "a1", health: "exited", restartCount: 5 }];
    (source as Record<string, unknown>).healthBaseline = jest.fn().mockResolvedValue(rows);
    expect(await svc.sourceHealth("u1", { sessionId: "s1", sourceKind: "coolify" })).toEqual(rows);
    delete (source as Record<string, unknown>).healthBaseline;
    expect(await svc.sourceHealth("u1", { sessionId: "s1", sourceKind: "dokploy" })).toBeNull();
    (source as Record<string, unknown>).healthBaseline = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(svc.sourceHealth("u1", { sessionId: "s1", sourceKind: "coolify" })).rejects.toThrow("boom");
    expect(source.close).toHaveBeenCalledTimes(3);
    expect(prisma.importSession.update).not.toHaveBeenCalled();
  });

  it("opSnapshot carries the plan's primary domain and image per item (null = none, absent = the plan did not say)", async () => {
    const { svc } = make({
      statusView: {
        tasks: [],
        plan: {
          items: [
            { itemRef: "app:_:w", kind: "app", dependsOn: [], proposed: { domain: null, image: "img/x:latest" } },
            { itemRef: "app:_:web", kind: "app", dependsOn: [], proposed: { domain: "web.example.test", image: null } },
            { itemRef: "database:_:d", kind: "database", dependsOn: [], proposed: { engine: "POSTGRES" } },
          ],
        },
      },
    });
    const snap = await svc.opSnapshot("u1", "op-1");
    expect(snap.planItems).toEqual([
      { itemRef: "app:_:w", kind: "app", dependsOn: [], domain: null, image: "img/x:latest" },
      { itemRef: "app:_:web", kind: "app", dependsOn: [], domain: "web.example.test", image: null },
      { itemRef: "database:_:d", kind: "database", dependsOn: [] },
    ]);
  });

  it("push-to-deploy: reads the app's switch (null when gone) and sets it through the apps service as the actor", async () => {
    const { svc, prisma, apps } = make();
    prisma.application.findUnique.mockResolvedValueOnce({ autoDeploy: true }).mockResolvedValueOnce({ autoDeploy: false }).mockResolvedValueOnce(null);
    expect(await svc.autoDeployState("u1", "a1")).toBe(true);
    expect(await svc.autoDeployState("u1", "a1")).toBe(false);
    expect(await svc.autoDeployState("u1", "a1")).toBeNull();
    await svc.setAutoDeploy("u1", "a1", false);
    expect(apps.setAutoDeploy).toHaveBeenCalledWith("u1", "a1", false);
  });

  it("prebuild builds without a deployment and reports whether anything was built", async () => {
    const { svc, apps } = make();
    apps.prebuild.mockResolvedValueOnce({ built: true }).mockResolvedValueOnce({ built: false, reason: "not-git" });
    expect(await svc.prebuild("u1", "a1")).toEqual({ built: true });
    expect(await svc.prebuild("u1", "a2")).toEqual({ built: false });
    expect(apps.prebuild).toHaveBeenCalledWith("u1", "a1");
  });

  it("pinImage pins only a floating IMAGE app, once, and never overrides a version tag or a digest", async () => {
    const { svc, prisma, apps } = make();
    const digest = `sha256:${"a".repeat(64)}`;
    prisma.application.findUnique.mockResolvedValueOnce({ source: "IMAGE", image: "ghcr.io/example/imageproxy:latest" });
    expect(await svc.pinImage("u1", "a1", digest)).toEqual({ pinned: true });
    expect(apps.setSource).toHaveBeenCalledWith("u1", "a1", { image: `ghcr.io/example/imageproxy@${digest}` });
    apps.setSource.mockClear();
    prisma.application.findUnique.mockResolvedValueOnce({ source: "IMAGE", image: "ghcr.io/example/imageproxy:1.4" });
    prisma.application.findUnique.mockResolvedValueOnce({ source: "IMAGE", image: `ghcr.io/example/imageproxy@${digest}` });
    prisma.application.findUnique.mockResolvedValueOnce({ source: "GIT", image: null });
    prisma.application.findUnique.mockResolvedValueOnce(null);
    for (let i = 0; i < 4; i++) expect(await svc.pinImage("u1", "a1", digest)).toEqual({ pinned: false });
    expect(await svc.pinImage("u1", "a1", "sha256:bad")).toEqual({ pinned: false });
    expect(apps.setSource).not.toHaveBeenCalled();
  });

  describe("serviceLinks", () => {
    const vol = (key: string, mount = "/data") => ({ key, policy: "copy", mounts: [{ service: "m", path: mount }] });
    const links = async (tasks: unknown[], apps: unknown[] = []) => {
      const { svc, prisma } = make();
      (prisma as Record<string, unknown>).bulkTask = { findMany: jest.fn().mockResolvedValue(tasks) };
      prisma.bulkOperation.findUnique.mockResolvedValue({ meta: {} });
      (prisma.application as Record<string, unknown>).findMany = jest.fn().mockImplementation(async (a: { select: Record<string, boolean> }) => (a.select.networks ? apps : [{ id: "s1", name: "search-a" }, { id: "st1", name: "store-a" }, { id: "p1", name: "public-a" }]));
      return svc.serviceLinks("u1", "op-1");
    };
    const svcTask = (itemRef: string, id: string, result: unknown) => ({ itemRef, kind: "service", status: "DONE", resourceType: "application", resourceId: id, result });
    const tasks = [
      svcTask("service:s:a", "s1", { members: ["search"], volumes: [vol("index")], privateNetwork: { network: "net-a" } }),
      svcTask("service:s:st", "st1", { members: ["minio"], volumes: [vol("minio-data")], privateNetwork: { network: "net-st" } }),
      svcTask("service:s:p", "p1", { members: ["search"], volumes: [], serviceDomains: { applied: 1, unmapped: [] }, hold: false }),
    ];
    const restore = () => { delete process.env.MIGRATION_VX_ENABLED; };
    afterEach(restore);

    it("flags a streamable copy volume that has no finished data task as still pending, but never an object store's volume", async () => {
      const out = await links(tasks);
      expect(out.map((l) => [l.name, l.objectStore, l.dataPending])).toEqual([["search-a", false, true], ["store-a", true, false], ["public-a", false, false]]);
    });
    it("is NOT pending when the volume stream is switched off: no target or data task can ever exist, VERIFY's acknowledgement path owns the volume", async () => {
      process.env.MIGRATION_VX_ENABLED = "false";
      const out = await links(tasks);
      expect(out.every((l) => !l.dataPending)).toBe(true);
    });
    it("marks a service with public domains and no private network as public (a held one is not)", async () => {
      const out = await links([...tasks, svcTask("service:s:h", "p1", { members: ["tunnel"], volumes: [], serviceDomains: { applied: 1, unmapped: [] }, hold: true })]);
      expect(out.map((l) => [l.itemRef, l.public])).toEqual([["service:s:a", false], ["service:s:st", false], ["service:s:p", true], ["service:s:h", false]]);
      expect(out.map((l) => [l.itemRef, l.hold])).toEqual([["service:s:a", false], ["service:s:st", false], ["service:s:p", false], ["service:s:h", true]]);
    });
    it("names the dark apps that joined the service's private network", async () => {
      const out = await links(tasks, [{ id: "w1", networks: ["net-a"] }, { id: "w2", networks: [] }]);
      expect(out.find((l) => l.itemRef === "service:s:a")!.dependants).toEqual(["w1"]);
    });
  });
});

describe("ImportPortService.sourceAgentGaps", () => {
  const plan = (hosts: unknown) => ({
    items: [{ itemRef: "app:srv-a:1", kind: "app" }, { itemRef: "database:srv-b:2", kind: "database" }],
    preflight: hosts ? { hosts } : undefined,
  });

  it("lists the source servers that have no online agent, through the plan route's placement facts", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValue(plan([{ ref: "srv-a", name: "Edge A", tugra: { serverId: "t1" }, agentOnline: true }, { ref: "srv-b", name: "Edge B", agentOnline: false }]));
    expect(await svc.sourceAgentGaps("u1", { sessionId: "s1", sourceKind: "coolify" })).toEqual({ gaps: [{ ref: "srv-b", name: "Edge B", state: "no_agent" }], unverified: false });
    expect(importer.plan).toHaveBeenCalledWith("u1", { sourceKind: "coolify", sessionId: "s1" });
  });

  it("is unverified when the plan route could not describe the servers", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValue(plan(undefined));
    expect(await svc.sourceAgentGaps("u1", { sessionId: "s1", sourceKind: "coolify" })).toMatchObject({ unverified: true });
  });

  it("gates Coolify only: another source answers no gap and reads nothing", async () => {
    const { svc, importer } = make();
    expect(await svc.sourceAgentGaps("u1", { sessionId: "s1", sourceKind: "dokploy" })).toEqual({ gaps: [], unverified: false });
    expect(importer.plan).not.toHaveBeenCalled();
  });

  it("leaves out the items the run's mapping excludes", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValue(plan([{ ref: "srv-a", name: "A", tugra: { serverId: "t1" }, agentOnline: true }, { ref: "srv-b", name: "B", agentOnline: false }]));
    const mapping = { version: 1, items: { "database:srv-b:2": { include: false } }, projects: {}, gitSources: {}, acks: [] };
    expect(await svc.sourceAgentGaps("u1", { sessionId: "s1", sourceKind: "coolify", mapping: mapping as never })).toEqual({ gaps: [], unverified: false });
  });
});

describe("ImportPortService.sourceHosts", () => {
  const hosts = [
    { ref: "a", controlPlane: undefined, tugra: { serverId: "t1" } },
    { ref: "b", controlPlane: undefined, tugra: undefined },
    { ref: "cp", controlPlane: true, tugra: { serverId: "t9" } },
  ];
  const plan = {
    planHash: "h",
    items: [
      { itemRef: "app:a:web", kind: "app", name: "web", dependsOn: [] },
      { itemRef: "app:b:api", kind: "app", name: "api", dependsOn: [] },
      { itemRef: "volume:a:v", kind: "volume", name: "v", dependsOn: [] },
    ],
    preflight: { hosts },
  };
  it("reports the servers that have an item, with the control plane flag and the matched Tugra server (hosts with nothing are left out)", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValueOnce(plan);
    expect(await svc.sourceHosts("u1", { sessionId: "s1", sourceKind: "coolify" })).toEqual([
      { ref: "a", controlPlane: false, tugraServerId: "t1" },
      { ref: "b", controlPlane: false, tugraServerId: null },
    ]);
  });
  it("narrows to the servers a scope keeps", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValueOnce(plan);
    expect(await svc.sourceHosts("u1", { sessionId: "s1", sourceKind: "coolify", scope: { sourceServers: ["a"] } })).toEqual([{ ref: "a", controlPlane: false, tugraServerId: "t1" }]);
  });
  it("a second row matched to the machine the panel's agent runs on is the control plane box too (the swap is refused at create, not at the swap)", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValueOnce({ ...plan, preflight: { hosts, agentRead: { agentServerId: "t1" } } });
    expect(await svc.sourceHosts("u1", { sessionId: "s1", sourceKind: "coolify" })).toEqual([
      { ref: "a", controlPlane: true, tugraServerId: "t1" },
      { ref: "b", controlPlane: false, tugraServerId: null },
    ]);
  });
  it("a source that is not Coolify has no swap and reports nothing", async () => {
    const { svc, importer } = make();
    expect(await svc.sourceHosts("u1", { sessionId: "s1", sourceKind: "dokploy" })).toEqual([]);
    expect(importer.plan).not.toHaveBeenCalled();
  });
});

describe("ImportPortService.appRefs", () => {
  const plan = {
    planHash: "h",
    items: [
      { itemRef: "app:a:web", kind: "app", name: "web", dependsOn: [] },
      { itemRef: "app:b:api", kind: "app", name: "api", dependsOn: [] },
      { itemRef: "database:a:db", kind: "database", name: "db", dependsOn: [] },
      { itemRef: "service:a:stack", kind: "service", name: "stack", dependsOn: [] },
    ],
    preflight: { hosts: [{ ref: "a" }, { ref: "b" }] },
  };
  it("lists the plan's apps only (a database or a service stack is not an app to rebuild)", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValueOnce(plan);
    expect(await svc.appRefs("u1", { sessionId: "s1", sourceKind: "coolify" })).toEqual(["app:a:web", "app:b:api"]);
  });
  it("narrows to the apps a scope keeps", async () => {
    const { svc, importer } = make();
    importer.plan.mockResolvedValueOnce(plan);
    expect(await svc.appRefs("u1", { sessionId: "s1", sourceKind: "coolify", scope: { sourceServers: ["a"] } })).toEqual(["app:a:web"]);
  });

  describe("the consent for secret values of an agent session", () => {
    it("a run's apply keeps the consent: the runs, retries and promotion of one session share it", async () => {
      const { svc, executor } = make();
      const input = { sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "a".repeat(32) } as never;
      await svc.apply("u1", input);
      expect(executor.apply).toHaveBeenCalledWith("u1", input, { keepConsent: true });
    });

    it("consentState asks the importer for the session", async () => {
      const { svc, importer } = make();
      expect(await svc.consentState("u1", { sessionId: "s1", sourceKind: "coolify" })).toMatchObject({ applies: true, standing: true });
      expect(importer.consentState).toHaveBeenCalledWith("u1", "s1");
    });

    it("releaseConsent ends the consent when no run of the session is left to need it", async () => {
      const { svc, importer, prisma } = make();
      await svc.releaseConsent("u1", { sessionId: "s1" });
      expect(importer.endSessionConsent).toHaveBeenCalledWith("s1");
      expect(prisma.migrationRun.findMany.mock.calls[0][0].where.sessionId).toBe("s1");
    });

    it("releaseConsent keeps it while another run of the session is open or a finished dry run can still be promoted", async () => {
      const a = make();
      a.prisma.migrationRun.findMany.mockResolvedValueOnce([{ id: "r2", status: "QUEUED" }]);
      await a.svc.releaseConsent("u1", { sessionId: "s1" });
      expect(a.importer.endSessionConsent).not.toHaveBeenCalled();
      const b = make();
      b.prisma.migrationRun.findMany.mockResolvedValueOnce([{ id: "d1", status: "DRY_RUN_DONE" }]).mockResolvedValueOnce([]);
      await b.svc.releaseConsent("u1", { sessionId: "s1" });
      expect(b.importer.endSessionConsent).not.toHaveBeenCalled();
    });

    it("a dry run that was already promoted has nothing left to start: it no longer holds the consent", async () => {
      const { svc, importer, prisma } = make();
      prisma.migrationRun.findMany.mockResolvedValueOnce([{ id: "d1", status: "DRY_RUN_DONE" }]).mockResolvedValueOnce([{ promotedFromId: "d1" }]);
      await svc.releaseConsent("u1", { sessionId: "s1" });
      expect(importer.endSessionConsent).toHaveBeenCalledWith("s1");
    });
  });
});

describe("ImportPortService.pinExactImage (R11): the exact image the source runs, written into the record the import created", () => {
  const D1 = `sha256:${"1".repeat(64)}`;
  it("an image app: pinned when the ref is a pin of its own image; another repository, a digest-pinned image and a non-image app are left alone", async () => {
    const { svc, prisma, apps } = make();
    prisma.application.findUnique.mockResolvedValueOnce({ source: "IMAGE", image: "getmeili/meilisearch:latest" });
    expect(await svc.pinExactImage("u1", { kind: "app", id: "a1", ref: `getmeili/meilisearch:latest@${D1}` })).toEqual({ pinned: true });
    expect(apps.setSource).toHaveBeenCalledWith("u1", "a1", { image: `getmeili/meilisearch:latest@${D1}` });
    prisma.application.findUnique.mockResolvedValueOnce({ source: "IMAGE", image: "getmeili/meilisearch:latest" });
    expect(await svc.pinExactImage("u1", { kind: "app", id: "a1", ref: `evil/other:latest@${D1}` })).toEqual({ pinned: false });
    prisma.application.findUnique.mockResolvedValueOnce({ source: "IMAGE", image: `getmeili/meilisearch:latest@sha256:${"2".repeat(64)}` });
    expect(await svc.pinExactImage("u1", { kind: "app", id: "a1", ref: `getmeili/meilisearch:latest@${D1}` })).toEqual({ pinned: false });
    prisma.application.findUnique.mockResolvedValueOnce({ source: "GIT", image: null });
    expect(await svc.pinExactImage("u1", { kind: "app", id: "a1", ref: `x/y:latest@${D1}` })).toEqual({ pinned: false });
    expect(apps.setSource).toHaveBeenCalledTimes(1);
  });
  it("a database: only one that was never started takes it", async () => {
    const { svc, prisma, dbs } = make();
    dbs.setImage.mockResolvedValue({ changed: true });
    prisma.database.findUnique.mockResolvedValueOnce({ image: "postgres:16", status: "NEW" });
    expect(await svc.pinExactImage("u1", { kind: "database", id: "d1", ref: `postgres:16-alpine@${D1}` })).toEqual({ pinned: true });
    expect(dbs.setImage).toHaveBeenCalledWith("u1", "d1", `postgres:16-alpine@${D1}`);
    prisma.database.findUnique.mockResolvedValueOnce({ image: "postgres:16", status: "RUNNING" });
    expect(await svc.pinExactImage("u1", { kind: "database", id: "d1", ref: `postgres:16-alpine@${D1}` })).toEqual({ pinned: false });
    expect(dbs.setImage).toHaveBeenCalledTimes(1);
  });
  it("a compose stack: each member of that repository gets its pin in the stored compose", async () => {
    const { svc, prisma, apps } = make();
    prisma.application.findUnique.mockResolvedValueOnce({ source: "COMPOSE", composeFile: "services:\n  s:\n    image: getmeili/meilisearch:latest\n  r:\n    image: redis:7.2\n" });
    expect(await svc.pinExactImage("u1", { kind: "service", id: "a1", members: { s: `getmeili/meilisearch:latest@${D1}`, r: `evil/redis:7.2@${D1}` } })).toEqual({ pinned: true });
    const written = apps.setComposeFile.mock.calls[0][2] as string;
    expect(written).toContain(`image: getmeili/meilisearch:latest@${D1}`);
    expect(written).toContain("image: redis:7.2\n");
  });
  it("pinComposeMembers: nothing to change, an unparsable compose and a member the compose lacks give null", () => {
    expect(pinComposeMembers("services:\n  s:\n    image: x/y:1\n", { s: "x/y:1" })).toBeNull();
    expect(pinComposeMembers("services:\n  s:\n    image: x/y:1\n", { nope: `x/y:1@${D1}` })).toBeNull();
    expect(pinComposeMembers("::: not yaml [", { s: `x/y:1@${D1}` })).toBeNull();
  });
  it("startDb writes the exact image of a never-started database right before it starts it, and still starts it when nothing was recorded", async () => {
    const { svc, prisma, dbs } = make();
    dbs.provision.mockResolvedValue({ status: "RUNNING", name: "pg" });
    prisma.bulkTask.findFirst.mockResolvedValue({ opId: "op-1" });
    (prisma.migrationRun as unknown as { findUnique: jest.Mock }).findUnique = jest.fn().mockResolvedValue({ id: "run1", promotedFromId: null });
    prisma.migrationRunHint.findMany.mockResolvedValue([{ runId: "run1", kind: "exact-image", value: `postgres:16-alpine@${D1} 16.4` }]);
    prisma.bulkTask.findFirst.mockResolvedValueOnce({ opId: "op-1" }).mockResolvedValueOnce({ itemRef: "database:s:d1" });
    prisma.database.findUnique.mockResolvedValue({ image: "postgres:16", status: "NEW" });
    dbs.setImage.mockResolvedValue({ changed: true });
    expect(await svc.startDb("u1", "d1")).toEqual({ exists: true, status: "RUNNING", name: "pg" });
    expect(dbs.setImage).toHaveBeenCalledWith("u1", "d1", `postgres:16-alpine@${D1}`);
    expect(dbs.setImage.mock.invocationCallOrder[0]).toBeLessThan(dbs.provision.mock.invocationCallOrder[0]);
  });
});
