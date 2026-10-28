import { ImportExecutorService } from "./import-executor.service";
import { planImport } from "./import-planner";
import type { ForeignFleet } from "./foreign-fleet";

// Let the async fan-out (void this.fanout(...)) drain against immediately-resolving mocks.
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function fleet(): ForeignFleet {
  return {
    servers: [{ ref: "srv-a", name: "box", ip: "1.2.3.4" }],
    apps: [{ sourceRef: "app-1", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "o/r", branch: "main" }, ports: [3000], serverRef: "srv-a", env: [], volumes: [], domains: [] }],
    databases: [{ sourceRef: "db-1", name: "orders", engine: "POSTGRES", version: "16", serverRef: "srv-a" }],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}

const DB_ITEMREF = "database:srv-a:db-1";

function harness(over: { priorImported?: Array<{ itemRef: string; resourceId: string; resourceType: string }>; liveDbIds?: string[]; gitSources?: Array<{ id: string }> } = {}) {
  let seq = 0;
  const created: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1" }) },
    bulkOperation: {
      findFirst: jest.fn().mockResolvedValue(null), // assertNoInflight: nothing in progress
      create: jest.fn().mockResolvedValue({ id: "op-1" }),
      findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }), // worker cancel check
      update: jest.fn().mockResolvedValue({}),
    },
    bulkTask: {
      findMany: jest.fn().mockResolvedValue(over.priorImported ?? []), // alreadyImported
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const t = { id: `task-${seq++}`, ...data };
        created.push({ id: t.id, data });
        return Promise.resolve(t);
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), // claim succeeds
    },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue((over.liveDbIds ?? []).map((id) => ({ id }))) },
    gitSource: { findMany: jest.fn().mockResolvedValue(over.gitSources ?? []) }, // İş 2: team GitSources for private-repo auto-link
  };
  const source = {
    discover: jest.fn().mockResolvedValue(fleet()),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const importer = { openSession: jest.fn().mockResolvedValue({ source }) };
  const apps = { create: jest.fn().mockResolvedValue({ id: "app-new", name: "web" }) };
  const dbs = { create: jest.fn().mockResolvedValue({ id: "db-new", name: "orders" }) };
  const migrationTokens = { issue: jest.fn(), reissue: jest.fn(), revoke: jest.fn().mockResolvedValue(false), validate: jest.fn() };
  const svc = new ImportExecutorService(
    prisma as never,
    {} as never, // migrator (unused in coolify path)
    access as never,
    audit as never,
    importer as never,
    apps as never,
    dbs as never,
    migrationTokens as never,
    {} as never, // crypto (unused on this path)
  );
  return { svc, prisma, source, apps, dbs, created };
}

function input() {
  const planHash = planImport(fleet(), { sourceKind: "coolify" }).planHash;
  return { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash };
}

describe("ImportExecutorService.applyCoolify — database provisioning (S1)", () => {
  it("provisions an empty Tugra database for a coolify DB item and records the sourceRef→resourceId mapping", async () => {
    const { svc, dbs, apps, prisma, source } = harness();
    const res = await svc.apply("user-1", input());
    expect(res.opId).toBe("op-1");
    await flush();

    // The database is created (deploy:false path) with the source engine/version on the TARGET server.
    expect(dbs.create).toHaveBeenCalledTimes(1);
    expect(dbs.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "orders", serverId: "srv-tugra", engine: "POSTGRES", version: "16" }));
    // And the mapping row is persisted so the migrator can later restore INTO it.
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE", resourceType: "database", resourceId: "db-new" }) }));
    // The app is still copied in the same run.
    expect(apps.create).toHaveBeenCalledTimes(1);
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE", resourceType: "application", resourceId: "app-new" }) }));
    expect(source.close).toHaveBeenCalled();
  });

  it("is idempotent: a DB already provisioned by a prior run (still live) is SKIPPED, not duplicated", async () => {
    const { svc, dbs, created } = harness({
      priorImported: [{ itemRef: DB_ITEMREF, resourceId: "db-existing", resourceType: "database" }],
      liveDbIds: ["db-existing"],
    });
    await svc.apply("user-1", input());
    await flush();

    expect(dbs.create).not.toHaveBeenCalled();
    const dbTask = created.find((c) => c.data.itemRef === DB_ITEMREF)!;
    expect(dbTask.data.status).toBe("SKIPPED");
    expect(String(dbTask.data.output)).toMatch(/already imported/);
  });

  it("still provisions when the prior-run DB was deleted since (stale mapping does not block re-provision)", async () => {
    const { svc, dbs } = harness({
      priorImported: [{ itemRef: DB_ITEMREF, resourceId: "db-existing", resourceType: "database" }],
      liveDbIds: [], // the earlier DB no longer exists
    });
    await svc.apply("user-1", input());
    await flush();
    expect(dbs.create).toHaveBeenCalledTimes(1);
  });
});

function rollbackHarness(opts: { dbStatus?: string; restores?: number; backups?: number } = {}) {
  const dbTask = { id: "t-db", itemRef: DB_ITEMREF, kind: "database", status: "DONE", resourceType: "database", resourceId: "db-1", result: { name: "orders" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation: null };
  const op = { id: "op-1", kind: "import", actorId: "user-1", planId: "h", meta: { sourceKind: "coolify", serverId: "srv-tugra" }, cancelRequestedAt: null, createdAt: new Date(), tasks: [dbTask] };
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op), update: jest.fn().mockResolvedValue({}) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1" }) },
    database: { findUnique: jest.fn().mockResolvedValue({ id: "db-1", status: opts.dbStatus ?? "NEW" }) },
    restore: { count: jest.fn().mockResolvedValue(opts.restores ?? 0) },
    backup: { count: jest.fn().mockResolvedValue(opts.backups ?? 0) },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const dbs = { remove: jest.fn().mockResolvedValue(undefined), create: jest.fn() };
  const migrationTokens = { revoke: jest.fn().mockResolvedValue(false) };
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, {} as never, {} as never, dbs as never, migrationTokens as never, {} as never);
  return { svc, prisma, dbs, migrationTokens };
}

describe("ImportExecutorService.rollback — database teardown guard (S1)", () => {
  it("tears down a still-EMPTY provisioned database (status NEW, no restores/backups) and revokes the migration token", async () => {
    const { svc, dbs, prisma, migrationTokens } = rollbackHarness();
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).toHaveBeenCalledWith("user-1", "db-1");
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ROLLED_BACK" }) }));
    expect(migrationTokens.revoke).toHaveBeenCalledWith("op-1", "user-1"); // revoked under the acting user (visible in their audit log)
    // Persistent terminal marker so a token can never be minted/validated for a rolled-back op (even if revoke was missed).
    expect(prisma.bulkOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ meta: expect.objectContaining({ rolledBackAt: expect.any(String) }) }) }));
  });

  it("NEVER tears down a database that has been started since import (status != NEW)", async () => {
    const { svc, dbs, prisma } = rollbackHarness({ dbStatus: "RUNNING" });
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).not.toHaveBeenCalled();
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ output: expect.stringMatching(/remove it manually/) }) }));
  });

  it("NEVER tears down a database that has data restored into it (restore history present)", async () => {
    const { svc, dbs } = rollbackHarness({ dbStatus: "NEW", restores: 1 });
    await svc.rollback("user-1", "op-1");
    expect(dbs.remove).not.toHaveBeenCalled();
  });
});

describe("ImportExecutorService.resolveGitSourceId — private GitHub-App auto-link (İş 2)", () => {
  const ghApp = { sourceRef: "a", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "https://github.com/o/r.git", provider: "github" } };
  // resolveGitSourceId is private — call it directly for a focused unit test of the link policy.
  const resolve = (svc: ImportExecutorService, app: unknown): Promise<string | undefined> =>
    (svc as unknown as { resolveGitSourceId(s: string, a: unknown): Promise<string | undefined> }).resolveGitSourceId("srv-tugra", app);

  it("auto-links to the team's single GitSource for a github-provider repo", async () => {
    const { svc, prisma } = harness({ gitSources: [{ id: "gs-1" }] });
    await expect(resolve(svc, ghApp)).resolves.toBe("gs-1");
    // scoped to the TARGET server's team AND only installed sources (an un-installed one would break deploy).
    expect(prisma.gitSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ teamId: "team-1", installationId: { not: null } }) }));
  });

  it("does not link when the team has NO GitSource (the plan's warning covers it)", async () => {
    const { svc } = harness({ gitSources: [] });
    await expect(resolve(svc, ghApp)).resolves.toBeUndefined();
  });

  it("does not auto-pick when the team has MULTIPLE GitSources (ambiguous → left for manual link)", async () => {
    const { svc } = harness({ gitSources: [{ id: "gs-1" }, { id: "gs-2" }] });
    await expect(resolve(svc, ghApp)).resolves.toBeUndefined();
  });

  it("never links a non-github git app (full URL / public clone) — no GitSource lookup at all", async () => {
    const { svc, prisma } = harness({ gitSources: [{ id: "gs-1" }] });
    await expect(resolve(svc, { ...ghApp, git: { url: "https://github.com/o/r.git" } })).resolves.toBeUndefined();
    expect(prisma.gitSource.findMany).not.toHaveBeenCalled();
  });

  it("is best-effort: a lookup failure yields no link so the import still proceeds", async () => {
    const { svc, prisma } = harness({ gitSources: [{ id: "gs-1" }] });
    prisma.server.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(resolve(svc, ghApp)).resolves.toBeUndefined();
  });

  it("end-to-end: runCopyApp passes the resolved gitSourceId into apps.create for a github-provider import", async () => {
    const { svc, apps, source } = harness({ gitSources: [{ id: "gs-1" }] });
    const base = fleet();
    const ghFleet = { ...base, databases: [], apps: [{ ...base.apps[0], git: { url: "https://github.com/o/r.git", provider: "github" } }] };
    source.discover.mockResolvedValue(ghFleet);
    const planHash = planImport(ghFleet, { sourceKind: "coolify" }).planHash;
    await svc.apply("user-1", { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash });
    await flush();
    expect(apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ gitSourceId: "gs-1" }));
  });

  it("end-to-end: an ordinary (non-github) import never sends a gitSourceId to apps.create", async () => {
    const { svc, apps } = harness({ gitSources: [{ id: "gs-1" }] });
    await svc.apply("user-1", input());
    await flush();
    expect(apps.create).toHaveBeenCalledTimes(1);
    expect(apps.create.mock.calls[0][1].gitSourceId).toBeUndefined();
  });
});
