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

function harness(over: { dbCreds?: (ref: string) => { user?: string; password?: string; rootPassword?: string; database?: string } | undefined | Promise<unknown>; takenHostPorts?: number[]; priorImported?: Array<{ itemRef: string; resourceId: string; resourceType: string }>; liveDbIds?: string[]; liveAppIds?: string[]; gitSources?: Array<{ id: string }>; fleet?: ForeignFleet; carriedSource?: { id: string } | null; clusterId?: string | null; upsert?: jest.Mock; secrets?: (ref: string) => { values: Record<string, string>; unresolved: [] }; findOrCreateProject?: jest.Mock } = {}) {
  let seq = 0;
  const created: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1", clusterId: over.clusterId ?? null }) },
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
    application: { findMany: jest.fn().mockResolvedValue((over.liveAppIds ?? []).map((id) => ({ id }))) },
    database: {
      findMany: jest.fn().mockResolvedValue((over.liveDbIds ?? []).map((id) => ({ id }))),
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { hostPort: number } }) => ((over.takenHostPorts ?? []).includes(where.hostPort) ? { id: "db-other" } : null)),
    },
    gitSource: { findMany: jest.fn().mockResolvedValue(over.gitSources ?? []), findFirst: jest.fn().mockResolvedValue(over.carriedSource === undefined ? { id: "gs-new" } : over.carriedSource) }, // İş 2: team GitSources for private-repo auto-link
  };
  const source = {
    discover: jest.fn().mockResolvedValue(over.fleet ?? fleet()),
    fetchSecrets: jest.fn().mockImplementation(async (ref: string) => (over.secrets ? over.secrets(ref) : { values: {}, unresolved: [] })),
    close: jest.fn().mockResolvedValue(undefined),
    ...(over.dbCreds ? { fetchDbCredentials: jest.fn().mockImplementation(async (ref: string) => over.dbCreds!(ref)) } : {}),
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const importer = { openSession: jest.fn().mockResolvedValue({ source }) };
  const apps = { create: jest.fn().mockResolvedValue({ id: "app-new", name: "web" }), setVolumes: jest.fn().mockResolvedValue(undefined), setBuild: jest.fn().mockResolvedValue(undefined), setWatchPaths: jest.fn().mockResolvedValue(undefined), setAutoDeploy: jest.fn().mockResolvedValue(undefined), setLimits: jest.fn().mockResolvedValue(undefined), setContainerCommand: jest.fn().mockResolvedValue(undefined), setClusterConfig: jest.fn().mockResolvedValue(undefined) };
  const gitSources = { upsertForImport: over.upsert ?? jest.fn().mockResolvedValue("gs-new") };
  // Tree find-or-create: in-memory + idempotent (same name → same ids), like the real ProjectsService.findOrCreateForImport.
  const treeIds = new Map<string, string>();
  const projects = {
    findOrCreateForImport: over.findOrCreateProject ?? jest.fn().mockImplementation(async (_u: string, _t: string, spec: { name: string; environments: Array<{ name: string }> }) => {
      const first = !treeIds.has(`p:${spec.name}`);
      const idOf = (k: string) => { if (!treeIds.has(k)) treeIds.set(k, `id-${treeIds.size}`); return treeIds.get(k)!; };
      const environments: Record<string, string> = {};
      const createdEnvironments: string[] = [];
      for (const e of spec.environments) { if (!treeIds.has(`e:${spec.name}:${e.name}`)) createdEnvironments.push(e.name); environments[e.name] = idOf(`e:${spec.name}:${e.name}`); }
      return { projectId: idOf(`p:${spec.name}`), created: first, environments, createdEnvironments };
    }),
  };
  const dbs = { create: jest.fn().mockResolvedValue({ id: "db-new", name: "orders" }), createForImport: jest.fn().mockResolvedValue({ id: "db-new", name: "orders" }), setLimits: jest.fn().mockResolvedValue(undefined) };
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
    gitSources as never,
    projects as never,
  );
  return { svc, prisma, source: source as typeof source & { fetchDbCredentials?: jest.Mock }, apps, dbs, created, gitSources, projects };
}

function input(f: ForeignFleet = fleet()) {
  const planHash = planImport(f, { sourceKind: "coolify" }).planHash;
  return { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash };
}

describe("ImportExecutorService.applyRemote — database provisioning (S1)", () => {
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
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, {} as never, {} as never, dbs as never, migrationTokens as never, {} as never, {} as never, {} as never);
  return { svc, prisma, dbs, migrationTokens };
}

describe("ImportExecutorService.applyRemote — app volume declare (Portability-V1)", () => {
  // Single-app, no-DB coolify fleet whose app carries `volumes`; run apply and return the app's DONE payload.
  async function applyWithVolumes(
    volumes: unknown[],
    over: Parameters<typeof harness>[0] = {},
    appOver: Record<string, unknown> = {},
  ) {
    const h = harness(over);
    const base = fleet();
    const f = { ...base, databases: [], apps: [{ ...base.apps[0], volumes, ...appOver }] } as unknown as ForeignFleet;
    h.source.discover.mockResolvedValue(f);
    const planHash = planImport(f, { sourceKind: "coolify" }).planHash;
    await h.svc.apply("user-1", { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash });
    await flush();
    const appDone = h.prisma.bulkTask.update.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((a) => a.data.resourceType === "application");
    return { ...h, appDone, result: appDone?.data.result as Record<string, unknown> | undefined };
  }

  it("declares the app's named + bind volumes as empty named volumes after create (sorted, source paths/names dropped)", async () => {
    const { apps, result } = await applyWithVolumes([
      { name: "7f3e_X", mountPath: "/data", type: "named" },
      { hostPath: "/srv/media", mountPath: "/media", type: "bind" },
    ]);
    expect(apps.setVolumes).toHaveBeenCalledTimes(1);
    expect(apps.setVolumes).toHaveBeenCalledWith("user-1", "app-new", [
      { name: "data", path: "/data" },
      { name: "media", path: "/media" },
    ]);
    expect(result?.volumes).toMatchObject({ declared: 2, skipped: 0 });
  });

  it("leaves a volume-less app's result byte-identical and never calls setVolumes", async () => {
    const { apps, result } = await applyWithVolumes([]);
    expect(apps.setVolumes).not.toHaveBeenCalled();
    expect(result).toEqual({ name: "web", appId: "app-new", unresolvedEnv: 0 });
  });

  it("never reflects a bind's source host path onto the target, and never uses host mounts", async () => {
    const { apps } = await applyWithVolumes([{ hostPath: "/var/run/docker.sock", mountPath: "/sock", type: "bind" }]);
    expect(apps.setVolumes).toHaveBeenCalledWith("user-1", "app-new", [{ name: "sock", path: "/sock" }]);
    expect(JSON.stringify(apps.setVolumes.mock.calls)).not.toContain("docker.sock");
    expect((apps as Record<string, unknown>).setHostMounts).toBeUndefined(); // this slice never calls setHostMounts
  });

  it("keeps the task DONE (not FAILED) and records the error if declaring volumes throws — no duplicate app on retry", async () => {
    const h = harness();
    h.apps.setVolumes.mockRejectedValueOnce(new Error("cluster has no swarm manager to pin this stateful app to"));
    const base = fleet();
    const f = { ...base, databases: [], apps: [{ ...base.apps[0], volumes: [{ mountPath: "/data", type: "named" }] }] } as unknown as ForeignFleet;
    h.source.discover.mockResolvedValue(f);
    const planHash = planImport(f, { sourceKind: "coolify" }).planHash;
    await h.svc.apply("user-1", { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash });
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(1); // app created exactly once (no orphan/duplicate)
    const appDone = h.prisma.bulkTask.update.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((a) => a.data.resourceType === "application");
    expect(appDone?.data.status).toBe("DONE");
    expect(appDone?.data.resourceId).toBe("app-new");
    expect((appDone?.data.result as Record<string, unknown>).volumes).toMatchObject({ declared: 0, error: expect.stringMatching(/swarm/) });
    expect(appDone?.data.output).toMatch(/declare FAILED/); // the failure is surfaced on the task, not silently DONE
  });

  it("does not declare volumes for a compose-source app (they live in its compose file)", async () => {
    const { apps, result } = await applyWithVolumes(
      [{ mountPath: "/data", type: "named" }],
      {},
      { kind: "compose", buildPack: "dockercompose", composeFile: "services: {}", git: undefined },
    );
    expect(apps.setVolumes).not.toHaveBeenCalled();
    expect(result?.volumes).toMatchObject({ declared: 0, skipped: 1 });
  });

  it("records skipped file mounts and does not call setVolumes when nothing is declarable", async () => {
    const { apps, result } = await applyWithVolumes([{ mountPath: "/etc/app.conf", type: "file" }]);
    expect(apps.setVolumes).not.toHaveBeenCalled();
    expect(result?.volumes).toMatchObject({ declared: 0, skipped: 1 });
  });

  it("is idempotent: an app already imported (still live) is SKIPPED and setVolumes is not re-invoked", async () => {
    const h = harness({ priorImported: [{ itemRef: "app:srv-a:app-1", resourceId: "app-existing", resourceType: "application" }], liveAppIds: ["app-existing"] });
    const base = fleet();
    const f = { ...base, databases: [], apps: [{ ...base.apps[0], volumes: [{ mountPath: "/data", type: "named" }] }] } as unknown as ForeignFleet;
    h.source.discover.mockResolvedValue(f);
    const planHash = planImport(f, { sourceKind: "coolify" }).planHash;
    await h.svc.apply("user-1", { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash });
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(h.apps.setVolumes).not.toHaveBeenCalled();
  });
});

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

// S0 generalized the source-kind gate from `=== "coolify"` to a COPY_MODE_KINDS set. This pins the destructive
// branch: a copy-mode (remote) import created a FRESH app → remove it; a local-docker import adopted a live
// container in place → un-adopt it (rename back). A second remote source (dokploy) must take the remove branch,
// not the unadopt branch — the bug this refactor prevents.
function appRollbackHarness(sourceKind: string, compensation: unknown) {
  const appTask = { id: "t-app", itemRef: "app:srv-a:app-1", kind: "app", status: "DONE", resourceType: "application", resourceId: "app-1", result: { name: "web" }, output: null, startedAt: new Date(), finishedAt: new Date(), compensation };
  const op = { id: "op-1", kind: "import", actorId: "user-1", planId: "h", meta: { sourceKind, serverId: "srv-tugra" }, cancelRequestedAt: null, createdAt: new Date(), tasks: [appTask] };
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op), update: jest.fn().mockResolvedValue({}) },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1" }) },
    application: { findUnique: jest.fn().mockResolvedValue({ id: "app-1" }) },
    deployment: { count: jest.fn().mockResolvedValue(0) }, // not (re)deployed since import
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const migrator = { unadopt: jest.fn().mockResolvedValue(undefined) };
  const apps = { remove: jest.fn().mockResolvedValue(undefined) };
  const migrationTokens = { revoke: jest.fn().mockResolvedValue(false) };
  const svc = new ImportExecutorService(prisma as never, migrator as never, access as never, audit as never, {} as never, apps as never, {} as never, migrationTokens as never, {} as never, {} as never, {} as never);
  return { svc, apps, migrator, prisma };
}

describe("ImportExecutorService.rollback — copy-mode vs adopt-in-place teardown (S0 source generalization)", () => {
  it("a copy-mode (coolify) app is fully removed via apps.remove, never un-adopted", async () => {
    const { svc, apps, migrator, prisma } = appRollbackHarness("coolify", null);
    await svc.rollback("user-1", "op-1");
    expect(apps.remove).toHaveBeenCalledWith("user-1", "app-1");
    expect(migrator.unadopt).not.toHaveBeenCalled();
    expect(prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ROLLED_BACK" }) }));
  });

  it("a local-docker (adopt-in-place) app is un-adopted via the migrator, never removed", async () => {
    const { svc, apps, migrator } = appRollbackHarness("local-docker", { originalName: "web-orig" });
    await svc.rollback("user-1", "op-1");
    expect(migrator.unadopt).toHaveBeenCalledWith("user-1", "srv-tugra", "app-1", "web-orig");
    expect(apps.remove).not.toHaveBeenCalled();
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


// ── L2-APPLY: GitHub-App carry + link, and post-create setters ─────────────────────────────────────────────
const PRIV = "-----BEGIN RSA PRIVATE KEY-----\nSECRET-PRIVATE-KEY-BODY\n-----END RSA PRIVATE KEY-----";
const CLIENT_SECRET = "SECRET-CLIENT-SECRET";
const WEBHOOK_SECRET = "SECRET-WEBHOOK-SECRET";
const providerSecrets = (ref: string): { values: Record<string, string>; unresolved: [] } =>
  ref === "gitProvider:gh-1"
    ? { values: { privateKey: PRIV, clientSecret: CLIENT_SECRET, webhookSecret: WEBHOOK_SECRET, clientId: "Iv1.abc" }, unresolved: [] }
    : { values: {}, unresolved: [] };

function ghFleet(appOver: Record<string, unknown> = {}, providers?: ForeignFleet["gitProviders"]): ForeignFleet {
  const base = fleet();
  return {
    ...base,
    databases: [],
    gitProviders: providers ?? [{ ref: "gh-1", kind: "github", appId: "4242", appSlug: "my-app", installationId: "777", htmlUrl: "https://github.com/apps/my-app", appName: "My App" }],
    apps: [{ ...base.apps[0], git: { url: "https://github.com/o/r.git", branch: "main", provider: "github" }, gitProviderRef: "gh-1", ...appOver }],
  };
}
const run = async (h: ReturnType<typeof harness>, f: ForeignFleet) => {
  await h.svc.apply("user-1", input(f));
  await flush();
};

describe("ImportExecutorService — GitHub App carry + link (L2-APPLY)", () => {
  it("upserts the provider into a GitSource on the TARGET team and links the app by gitProviderRef", async () => {
    const f = ghFleet();
    const h = harness({ fleet: f, secrets: providerSecrets, gitSources: [{ id: "x1" }, { id: "x2" }] }); // 2 team sources → exactly-one heuristic would NOT link
    await run(h, f);
    expect(h.source.fetchSecrets).toHaveBeenCalledWith("gitProvider:gh-1");
    expect(h.gitSources.upsertForImport).toHaveBeenCalledTimes(1);
    expect(h.gitSources.upsertForImport).toHaveBeenCalledWith("user-1", "team-1", expect.objectContaining({ appId: "4242", appSlug: "my-app", installationId: "777", privateKey: PRIV, name: "My App" }));
    // verified on the target team + installed before linking
    expect(h.prisma.gitSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "gs-new", teamId: "team-1" }) }));
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ gitSourceId: "gs-new" }));
  });

  it("a git-sourced COMPOSE with a gitProviderRef links to the carried GitSource and wires gitUrl + composePath (no composeFile/baseDirectory)", async () => {
    const f = ghFleet({ kind: "compose", buildPack: "dockercompose", git: { url: "https://github.com/o/r.git", branch: "main", composePath: "docker-compose.prod.yml", provider: "github" } });
    const h = harness({ fleet: f, secrets: providerSecrets, gitSources: [{ id: "x1" }, { id: "x2" }] });
    await run(h, f);
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const input = h.apps.create.mock.calls[0][1];
    expect(input).toMatchObject({ source: "COMPOSE", gitUrl: "https://github.com/o/r.git", composePath: "docker-compose.prod.yml", gitSourceId: "gs-new" });
    expect(input.composeFile).toBeUndefined();
    expect(input.baseDirectory).toBeUndefined();
  });

  it("falls back to the exactly-one-installed heuristic when the app has no gitProviderRef", async () => {
    const f = ghFleet({ gitProviderRef: undefined }, []);
    const h = harness({ fleet: f, gitSources: [{ id: "gs-only" }] });
    await run(h, f);
    expect(h.gitSources.upsertForImport).not.toHaveBeenCalled();
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ gitSourceId: "gs-only" }));
  });

  it("stays UNLINKED when a ref'd app's carried GitSource is not on the target team / not installed (never links to an unrelated App)", async () => {
    const f = ghFleet();
    const h = harness({ fleet: f, secrets: providerSecrets, carriedSource: null, gitSources: [{ id: "gs-only" }] });
    await run(h, f);
    // the app cloned through a SPECIFIC App we could not verify installed → unlinked, NOT linked to gs-only
    expect(h.apps.create.mock.calls[0][1].gitSourceId).toBeUndefined();
  });

  it("degrades gracefully when the source yields no private key: provider skipped, warning on the op, app still imported unlinked", async () => {
    const f = ghFleet();
    const h = harness({ fleet: f }); // fetchSecrets → {} (no privateKey)
    await run(h, f);
    expect(h.gitSources.upsertForImport).not.toHaveBeenCalled();
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    expect(h.apps.create.mock.calls[0][1].gitSourceId).toBeUndefined();
    const meta = h.prisma.bulkOperation.create.mock.calls[0][0].data.meta;
    expect(meta.warnings).toEqual([expect.stringMatching(/gh-1.*no private key/)]);
    expect(h.prisma.bulkTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE", resourceType: "application" }) }));
  });

  it("degrades gracefully when the upsert throws (never aborts the import, never echoes the error)", async () => {
    const f = ghFleet();
    const upsert = jest.fn().mockRejectedValue(new Error(`boom ${PRIV}`));
    const h = harness({ fleet: f, secrets: providerSecrets, upsert, gitSources: [] });
    await run(h, f);
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const meta = h.prisma.bulkOperation.create.mock.calls[0][0].data.meta;
    expect(JSON.stringify(meta.warnings)).not.toContain("SECRET");
    expect(meta.warnings).toEqual([expect.stringMatching(/could not be carried/)]);
  });

  it("is idempotent: a retry upserts again with the same (team, appId) input and the app-duplicate guard still holds", async () => {
    const f = ghFleet();
    const h1 = harness({ fleet: f, secrets: providerSecrets });
    await run(h1, f);
    // second apply: the app was already imported by a prior (live) op → SKIPPED, no duplicate; the provider upsert is idempotent by key
    const h2 = harness({ fleet: f, secrets: providerSecrets, priorImported: [{ itemRef: "app:srv-a:app-1", resourceId: "app-old", resourceType: "application" }], liveAppIds: ["app-old"] });
    await run(h2, f);
    expect(h2.apps.create).not.toHaveBeenCalled();
    expect(h2.gitSources.upsertForImport.mock.calls[0]).toEqual(h1.gitSources.upsertForImport.mock.calls[0]);
  });

  it("SECRET LEAK: privateKey/clientSecret/webhookSecret never appear in any BulkTask write, the op meta/plan, audit, or logger", async () => {
    const f = ghFleet();
    const h = harness({ fleet: f, secrets: providerSecrets });
    const logger = (h.svc as unknown as { logger: Record<string, (...a: unknown[]) => void> }).logger;
    const logSpies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => jest.spyOn(logger, m as never) as unknown as jest.SpyInstance);
    logSpies.forEach((sp) => sp.mockImplementation(() => undefined));
    await run(h, f);
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const everything = JSON.stringify({
      taskCreates: h.prisma.bulkTask.create.mock.calls,
      taskUpdates: h.prisma.bulkTask.update.mock.calls,
      opCreate: h.prisma.bulkOperation.create.mock.calls,
      opUpdate: h.prisma.bulkOperation.update.mock.calls,
      logs: logSpies.map((s) => s.mock.calls),
      appCreate: h.apps.create.mock.calls,
    });
    for (const needle of ["SECRET-PRIVATE-KEY-BODY", "BEGIN RSA PRIVATE KEY", CLIENT_SECRET, WEBHOOK_SECRET]) expect(everything).not.toContain(needle);
    // and the audit trail (op + import.apply) carries none either
    const auditCalls = (h.svc as unknown as { audit: { log: jest.Mock } }).audit.log.mock.calls;
    expect(JSON.stringify(auditCalls)).not.toContain("SECRET");
  });
});

describe("ImportExecutorService — post-create setters (L2-APPLY)", () => {
  const cfgApp = {
    autoDeploy: false,
    watchPaths: ["apps/api/**"],
    limits: { memoryMb: 512, cpus: 1 },
    containerCommand: ["node", "server.js", "--token=SECRET-ARG"],
    dockerBuildTarget: "prod",
    buildPack: "dockerfile",
    replicas: 3,
  };
  const lastResult = (h: ReturnType<typeof harness>) => {
    const call = h.prisma.bulkTask.update.mock.calls.map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data).find((d: Record<string, unknown>) => d.status === "DONE" && d.resourceType === "application")!;
    return call as { result: { postCreate?: { applied: string[]; unmapped: Array<{ field: string; reason: string }> } }; output?: string };
  };

  it("applies the mapped setters on the created app and records applied + unmapped (names/reasons only)", async () => {
    const base = fleet();
    const f: ForeignFleet = { ...base, databases: [], apps: [{ ...base.apps[0], ...cfgApp } as never] };
    const h = harness({ fleet: f });
    await run(h, f);
    expect(h.apps.setAutoDeploy).toHaveBeenCalledWith("user-1", "app-new", false);
    expect(h.apps.setWatchPaths).toHaveBeenCalledWith("user-1", "app-new", ["apps/api/**"]);
    expect(h.apps.setLimits).toHaveBeenCalledWith("user-1", "app-new", expect.objectContaining({ memoryMb: 512 }));
    expect(h.apps.setBuild).toHaveBeenCalledWith("user-1", "app-new", expect.objectContaining({ dockerBuildTarget: "prod" }));
    expect(h.apps.setContainerCommand).toHaveBeenCalledTimes(1);
    expect(h.apps.setClusterConfig).not.toHaveBeenCalled(); // no cluster target
    const r = lastResult(h);
    expect(r.result.postCreate!.applied.sort()).toEqual(["autoDeploy", "build", "containerCommand", "limits", "watchPaths"]);
    expect(r.result.postCreate!.unmapped).toEqual([expect.objectContaining({ field: "replicas" })]);
    expect(r.output).toMatch(/config not carried: replicas/);
    expect(JSON.stringify(r)).not.toContain("SECRET-ARG"); // argv values never recorded
  });

  it("never auto-applies replicas (setClusterConfig would convert the app to a swarm service) — records it unmapped even with a cluster target", async () => {
    const base = fleet();
    const f: ForeignFleet = { ...base, databases: [], apps: [{ ...base.apps[0], replicas: 3 } as never] };
    const h = harness({ fleet: f, clusterId: "cl-1" });
    await run(h, f);
    expect(h.apps.setClusterConfig).not.toHaveBeenCalled();
    expect(lastResult(h).result.postCreate!.unmapped).toEqual([expect.objectContaining({ field: "replicas" })]);
  });

  it("is best-effort: a setter failure never reaches the outer catch (task still DONE with the app id, no duplicate on retry)", async () => {
    const base = fleet();
    const f: ForeignFleet = { ...base, databases: [], apps: [{ ...base.apps[0], ...cfgApp } as never] };
    const h = harness({ fleet: f, clusterId: "cl-1" });
    h.apps.setWatchPaths.mockRejectedValue(new Error("db error with SECRET-ARG"));
    h.apps.setLimits.mockRejectedValue(new Error("nope"));
    await run(h, f);
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const r = lastResult(h);
    expect(r.result.postCreate!.applied).not.toContain("watchPaths");
    expect(r.result.postCreate!.unmapped.map((u) => u.field)).toEqual(expect.arrayContaining(["watchPaths", "limits"]));
    expect(h.prisma.bulkTask.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    expect(JSON.stringify(r)).not.toContain("SECRET-ARG"); // setter error text is never copied
  });

  it("an app with nothing to configure leaves the task result byte-identical (no postCreate key)", async () => {
    const h = harness();
    await run(h, fleet());
    expect(lastResult(h).result).not.toHaveProperty("postCreate");
  });
});


describe("ImportExecutorService — DB credential carry (L4)", () => {
  const PW = "DB-PASSWORD-SENTINEL-4c1f";
  const ROOT_PW = "DB-ROOTPASSWORD-SENTINEL-9a7e";
  const dbFleet = (over: Record<string, unknown> = {}): ForeignFleet => ({
    ...fleet(),
    apps: [],
    databases: [{ sourceRef: "db-1", name: "orders", engine: "POSTGRES", version: "16", image: "pgvector/pgvector:pg16", externalPort: 5544, credentials: { username: "u", database: "ordersdb", secretRef: "db-1" }, serverRef: "srv-a", ...over }],
  });
  const creds = () => ({ user: "app_user", password: PW, rootPassword: undefined, database: "ordersdb" });
  const dbTaskUpdate = (h: ReturnType<typeof harness>) => h.prisma.bulkTask.update.mock.calls.map((c) => c[0].data).find((d: Record<string, unknown>) => d.resourceType === "database");

  it("creates through createForImport with the PRESERVED credentials, the verbatim image and the host port (no fresh mint)", async () => {
    const f = dbFleet();
    const h = harness({ fleet: f, dbCreds: creds });
    await run(h, f);
    expect(h.dbs.create).not.toHaveBeenCalled();
    expect(h.source.fetchDbCredentials).toHaveBeenCalledWith("db-1");
    expect(h.dbs.createForImport).toHaveBeenCalledTimes(1);
    expect(h.dbs.createForImport).toHaveBeenCalledWith("user-1", {
      name: "orders",
      serverId: "srv-tugra",
      engine: "POSTGRES",
      version: "16",
      image: "pgvector/pgvector:pg16",
      username: "app_user",
      password: PW,
      database: "ordersdb",
      hostPort: 5544,
      environmentId: undefined,
    });
    const upd = dbTaskUpdate(h);
    expect(upd).toEqual(expect.objectContaining({ status: "DONE", resourceType: "database", resourceId: "db-new" }));
    expect(upd.result).toEqual({ name: "orders", databaseId: "db-new", credentialsCarried: true, imageCarried: true, hostPortCarried: true });
    expect(upd.output).toBeUndefined();
  });

  it("carries the DB's hard CPU/memory limits (best-effort) onto the created database", async () => {
    const f = dbFleet({ limits: { memoryMb: 512, cpus: 1 } });
    const h = harness({ fleet: f, dbCreds: creds });
    await run(h, f);
    expect(h.dbs.setLimits).toHaveBeenCalledWith("user-1", "db-new", { memoryMb: 512, cpus: 1 });
    expect(dbTaskUpdate(h)).toEqual(expect.objectContaining({ status: "DONE" })); // a limits failure would NOT fail the task
  });

  it("falls back to fresh credentials + a warning when the source has no fetchDbCredentials", async () => {
    const f = dbFleet();
    const h = harness({ fleet: f }); // coolify-style source: method absent
    await run(h, f);
    expect(h.dbs.createForImport).not.toHaveBeenCalled();
    expect(h.dbs.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "orders", engine: "POSTGRES", version: "16" }));
    const upd = dbTaskUpdate(h);
    expect(upd.status).toBe("DONE");
    expect(upd.result).toEqual({ name: "orders", databaseId: "db-new", credentialsCarried: false });
    expect(upd.output).toBe("DB credentials not carried — fresh password minted; rewire the app DB_PASSWORD");
  });

  it.each([
    ["returns undefined", () => undefined],
    ["returns no password", () => ({ user: "u", rootPassword: ROOT_PW })],
  ])("falls back to fresh credentials when fetchDbCredentials %s", async (_n, dbCreds) => {
    const f = dbFleet();
    const h = harness({ fleet: f, dbCreds: dbCreds as never });
    await run(h, f);
    expect(h.dbs.createForImport).not.toHaveBeenCalled();
    expect(h.dbs.create).toHaveBeenCalledTimes(1);
    expect(dbTaskUpdate(h).output).toMatch(/fresh password minted/);
  });

  it("FAILS the task (retryable, no fresh password) when fetchDbCredentials THROWS — a transient read error must not become a permanent wrong password", async () => {
    const f = dbFleet();
    const h = harness({ fleet: f, dbCreds: (() => Promise.reject(new Error("boom " + PW))) as never });
    await run(h, f);
    expect(h.dbs.create).not.toHaveBeenCalled(); // no fresh mint
    expect(h.dbs.createForImport).not.toHaveBeenCalled();
    const upd = h.prisma.bulkTask.update.mock.calls.map((c) => c[0].data).find((d: Record<string, unknown>) => d.status === "FAILED");
    expect(upd?.resourceId).toBeUndefined(); // no resource recorded → a re-apply retries
    expect(JSON.stringify(h.prisma.bulkTask.update.mock.calls)).not.toContain(PW); // the thrown error text never echoes the password
  });

  it("drops a host port already published by another DB on the target server, with a note (DB still created)", async () => {
    const f = dbFleet();
    const h = harness({ fleet: f, dbCreds: creds, takenHostPorts: [5544] });
    await run(h, f);
    expect(h.dbs.createForImport.mock.calls[0][1].hostPort).toBeUndefined();
    const upd = dbTaskUpdate(h);
    expect(upd.result.hostPortCarried).toBe(false);
    expect(upd.output).toMatch(/host port 5544 is already used/);
  });

  it("derives username/database from the discovered identity or a safe slug when the secret path omits them", async () => {
    const f = dbFleet({ credentials: undefined, name: "My Orders DB!", image: undefined, externalPort: undefined });
    const h = harness({ fleet: f, dbCreds: () => ({ password: PW }) });
    await run(h, f);
    expect(h.dbs.createForImport.mock.calls[0][1]).toEqual(expect.objectContaining({ username: "tugra", database: "my_orders_db", password: PW, image: undefined, hostPort: undefined }));
    expect(dbTaskUpdate(h).result).toEqual(expect.objectContaining({ credentialsCarried: true, imageCarried: false, hostPortCarried: false }));
  });

  it("notes (without values) that a distinct MySQL root password cannot be carried separately", async () => {
    const f = dbFleet({ engine: "MYSQL", version: "8", image: "mysql:8" });
    const h = harness({ fleet: f, dbCreds: () => ({ user: "u", password: PW, rootPassword: ROOT_PW, database: "shop" }) });
    await run(h, f);
    const upd = dbTaskUpdate(h);
    expect(upd.output).toMatch(/separate root password/);
    expect(JSON.stringify(upd)).not.toContain(ROOT_PW);
  });

  it("surfaces a createForImport rejection as FAILED with its (fixed) message, no resource recorded", async () => {
    const f = dbFleet();
    const h = harness({ fleet: f, dbCreds: creds });
    h.dbs.createForImport.mockRejectedValueOnce(new Error("invalid database image reference"));
    await run(h, f);
    const upd = dbTaskUpdate(h) ?? h.prisma.bulkTask.update.mock.calls.map((c) => c[0].data).find((d: Record<string, unknown>) => d.status === "FAILED");
    expect(upd).toEqual(expect.objectContaining({ status: "FAILED", output: "invalid database image reference" }));
    expect(upd.resourceId).toBeUndefined();
  });

  it("SECRET LEAK: the DB password / rootPassword never appear in any BulkTask write, the persisted plan/op meta, audit, logger or fleet", async () => {
    const f = dbFleet({ engine: "MYSQL", version: "8", image: "mysql:8" });
    const h = harness({ fleet: f, dbCreds: () => ({ user: "u", password: PW, rootPassword: ROOT_PW, database: "shop" }) });
    const logger = (h.svc as unknown as { logger: Record<string, (...a: unknown[]) => void> }).logger;
    const logSpies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => jest.spyOn(logger, m as never) as unknown as jest.SpyInstance);
    logSpies.forEach((sp) => sp.mockImplementation(() => undefined));
    await run(h, f);
    expect(h.dbs.createForImport).toHaveBeenCalledTimes(1); // the secret DID flow to the encrypting service...
    const everything = JSON.stringify({
      taskCreates: h.prisma.bulkTask.create.mock.calls,
      taskUpdates: h.prisma.bulkTask.update.mock.calls,
      opCreate: h.prisma.bulkOperation.create.mock.calls,
      opUpdate: h.prisma.bulkOperation.update.mock.calls,
      logs: logSpies.map((s) => s.mock.calls),
      audit: (h.svc as unknown as { audit: { log: jest.Mock } }).audit.log.mock.calls,
      discovered: await h.source.discover(),
    });
    for (const needle of [PW, ROOT_PW]) expect(everything).not.toContain(needle); // ...and nowhere else
  });

  it("is idempotent: a retry skips a DB a prior (live) op already imported — createForImport is not called again", async () => {
    const f = dbFleet();
    const h = harness({ fleet: f, dbCreds: creds, priorImported: [{ itemRef: DB_ITEMREF, resourceId: "db-existing", resourceType: "database" }], liveDbIds: ["db-existing"] });
    await run(h, f);
    expect(h.dbs.createForImport).not.toHaveBeenCalled();
    expect(h.dbs.create).not.toHaveBeenCalled();
    expect(h.source.fetchDbCredentials).not.toHaveBeenCalled(); // the secret is not even fetched for a skipped DB
    expect(h.created.find((c) => c.data.itemRef === DB_ITEMREF)!.data.status).toBe("SKIPPED");
  });
});

describe("ImportExecutorService.applyRemote — project/environment tree (L5)", () => {
  const app = (sourceRef: string, name: string, tree: { projectRef?: string; environmentRef?: string } = {}) => ({
    sourceRef, name, kind: "git" as const, buildPack: "nixpacks" as const, git: { url: "o/r", branch: "main" }, ports: [3000], serverRef: "srv-a", env: [], volumes: [], domains: [], ...tree,
  });
  function treeFleet(): ForeignFleet {
    return {
      servers: [{ ref: "srv-a" }],
      apps: [app("laravel", "LaravelApp", { projectRef: "pj-dies", environmentRef: "env-dies" }), app("loose", "Loose")],
      databases: [{ sourceRef: "pg-1", name: "playdb", engine: "POSTGRES", version: "16", serverRef: "srv-a", projectRef: "pj-play", environmentRef: "env-play" }],
      services: [],
      volumes: [],
      sharedEnv: [],
      projects: [
        { ref: "pj-dies", name: "DiesDigital", tags: ["web"], description: "d", environments: [{ ref: "env-dies", name: "production", isDefault: true }] },
        { ref: "pj-play", name: "PlayTolk", tags: [], environments: [{ ref: "env-play", name: "production", isDefault: true }] },
      ],
      warnings: [],
    };
  }
  const dokployInput = (f: ForeignFleet) => ({ sourceKind: "dokploy" as const, sessionId: "sess-1", targetServerId: "srv-tugra", environmentId: "env-selected", planHash: planImport(f, { sourceKind: "dokploy" }).planHash });

  it("routes two projects' resources to two different environments; a ref-less resource uses input.environmentId", async () => {
    const f = treeFleet();
    const { svc, apps, dbs, projects, prisma } = harness({ fleet: f });
    await svc.apply("user-1", dokployInput(f));
    await flush();

    expect(projects.findOrCreateForImport).toHaveBeenCalledTimes(2);
    expect(projects.findOrCreateForImport).toHaveBeenCalledWith("user-1", "team-1", expect.objectContaining({ name: "DiesDigital", description: "d", tags: ["web"], environments: [{ name: "production", isDefault: true }] }));
    const envOf = (name: string) => (apps.create.mock.calls.find((c) => c[1].name === name)?.[1] as { environmentId?: string }).environmentId;
    const diesEnv = envOf("LaravelApp");
    const playEnv = (dbs.create.mock.calls[0][1] as { environmentId?: string }).environmentId;
    expect(diesEnv).toBeDefined();
    expect(playEnv).toBeDefined();
    expect(diesEnv).not.toBe(playEnv); // same env NAME "production", different projects → different Tugra environments
    expect(diesEnv).not.toBe("env-selected");
    expect(envOf("Loose")).toBe("env-selected"); // no ref → fallback
    // Names (never secrets) are recorded on op.meta.
    const meta = (prisma.bulkOperation.create.mock.calls[0][0] as { data: { meta: { projects: Array<{ project: string; projectCreated: boolean; environmentsCreated: string[] }> } } }).data.meta;
    expect(meta.projects.map((p) => p.project)).toEqual(["DiesDigital", "PlayTolk"]);
    expect(meta.projects[0]).toEqual(expect.objectContaining({ projectCreated: true, environmentsCreated: ["production"] }));
  });

  it("a source with no tree (coolify) never touches ProjectsService and keeps the single input.environmentId", async () => {
    const f = fleet();
    const { svc, apps, dbs, projects } = harness({ fleet: f });
    await svc.apply("user-1", { ...input(f), environmentId: "env-selected" });
    await flush();

    expect(projects.findOrCreateForImport).not.toHaveBeenCalled();
    expect((apps.create.mock.calls[0][1] as { environmentId?: string }).environmentId).toBe("env-selected");
    expect((dbs.create.mock.calls[0][1] as { environmentId?: string }).environmentId).toBe("env-selected");
  });

  it("a re-import REUSES the same projects/environments (no new ones created, same environment ids)", async () => {
    const f = treeFleet();
    const { svc, apps, projects, prisma } = harness({ fleet: f });
    await svc.apply("user-1", dokployInput(f));
    await flush();
    await svc.apply("user-1", dokployInput(f));
    await flush();

    const diesEnvs = apps.create.mock.calls.filter((c) => c[1].name === "LaravelApp").map((c) => (c[1] as { environmentId?: string }).environmentId);
    expect(diesEnvs).toHaveLength(2);
    expect(diesEnvs[0]).toBe(diesEnvs[1]);
    const metas = prisma.bulkOperation.create.mock.calls.map((c) => (c[0] as { data: { meta: { projects: Array<{ projectCreated: boolean; environmentsCreated: string[] }> } } }).data.meta.projects);
    expect(metas[0].every((p) => p.projectCreated)).toBe(true);
    expect(metas[1].every((p) => !p.projectCreated && p.environmentsCreated.length === 0)).toBe(true);
    expect(projects.findOrCreateForImport).toHaveBeenCalledTimes(4);
  });

  it("a project the caller cannot create DEGRADES: a fixed warning, its resources use input.environmentId", async () => {
    const f = treeFleet();
    const fail = jest.fn().mockRejectedValue(new Error("secret-ish prisma detail"));
    const { svc, apps, prisma } = harness({ fleet: f, findOrCreateProject: fail });
    await svc.apply("user-1", dokployInput(f));
    await flush();

    expect((apps.create.mock.calls.find((c) => c[1].name === "LaravelApp")![1] as { environmentId?: string }).environmentId).toBe("env-selected");
    const meta = (prisma.bulkOperation.create.mock.calls[0][0] as { data: { meta: { warnings: string[] } } }).data.meta;
    expect(meta.warnings).toHaveLength(2);
    expect(JSON.stringify(meta.warnings)).not.toContain("secret-ish");
  });
});
