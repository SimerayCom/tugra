import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { ImportExecutorService, toStatusView } from "./import-executor.service";
import { ImportMappingService } from "./import-mapping.service";
import { ImportMappingDocSchema, type ImportMappingDoc } from "./import-mapping";
import { planImport } from "./import-planner";
import type { ForeignFleet } from "./foreign-fleet";

const flush = async () => {
  for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r));
};

const APP = "app:srv-a:app-1";
const APP2 = "app:srv-a:app-2";
const DB = "database:srv-a:db-1";

function fleet(): ForeignFleet {
  return {
    servers: [{ ref: "srv-a", name: "box" }],
    apps: [
      { sourceRef: "app-1", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "o/r", branch: "main" }, ports: [3000], serverRef: "srv-a", env: [], volumes: [], domains: [] },
      { sourceRef: "app-2", name: "worker", kind: "image", buildPack: "image", image: "nginx:1", serverRef: "srv-a", env: [], volumes: [], domains: [] },
    ],
    databases: [{ sourceRef: "db-1", name: "Orders DB", engine: "POSTGRES", version: "16", serverRef: "srv-a" }],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}
/** A Dokploy-shaped tree fleet. */
function treeFleet(): ForeignFleet {
  const f = fleet();
  f.apps[0].projectRef = "p1";
  f.apps[0].environmentRef = "e1";
  f.apps[1].projectRef = "p2";
  f.apps[1].environmentRef = "e2";
  f.projects = [
    { ref: "p1", name: "Shop", description: "d", tags: ["t"], environments: [{ ref: "e1", name: "production", isDefault: true }] },
    { ref: "p2", name: "Ops", tags: [], environments: [{ ref: "e2", name: "staging", isDefault: true }] },
  ];
  return f;
}

type Live = { apps?: Array<{ id: string; name: string; environmentId: string; serverId?: string; containerAlias?: string | null; networkAliases?: string[] }>; dbs?: Array<{ id: string; name: string; environmentId: string }>; tasks?: Array<{ itemRef: string; resourceId: string; resourceType: string; serverId: string }> };

function harness(over: { fleet?: ForeignFleet; profile?: ImportMappingDoc | null; live?: Live; canProjects?: boolean; projectsExisting?: Array<{ id: string; name: string; isDefault?: boolean; environments: Array<{ id: string; name: string; isDefault?: boolean }> }>; upsertFails?: boolean; dbCreds?: boolean; setNetworks?: jest.Mock; findOrCreate?: jest.Mock; gitSourcesExisting?: Array<{ appId: string }>; gitProviders?: boolean } = {}) {
  const f = over.fleet ?? fleet();
  if (over.gitProviders) f.gitProviders = [{ ref: "g1", kind: "github", appId: "77", appName: "Source GH App" }];
  let seq = 0;
  const created: Array<{ id: string; data: Record<string, unknown> }> = [];
  const live = over.live ?? {};
  const apps = (live.apps ?? []).map((a) => ({ serverId: "srv-tugra", containerAlias: null, networkAliases: [], ...a }));
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1", clusterId: null }), findMany: jest.fn().mockResolvedValue([{ id: "srv-other", name: "Other box" }]) },
    bulkOperation: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "op-1" }), findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }), update: jest.fn().mockResolvedValue({}) },
    bulkTask: {
      findMany: jest.fn().mockResolvedValue(live.tasks ?? []),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const t = { id: `task-${seq++}`, ...data };
        created.push({ id: t.id, data });
        return Promise.resolve(t);
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    application: { findMany: jest.fn().mockResolvedValue(apps) },
    database: { findMany: jest.fn().mockResolvedValue(live.dbs ?? []), findFirst: jest.fn().mockResolvedValue(null) },
    gitSource: { findMany: jest.fn().mockResolvedValue(over.gitSourcesExisting ?? []), findFirst: jest.fn().mockResolvedValue({ id: "gs-new" }) },
    project: { findMany: jest.fn().mockResolvedValue(over.projectsExisting ?? []) },
    importMapping: {
      findUnique: jest.fn().mockResolvedValue(over.profile ? { id: "m1", mapping: over.profile, version: 3, label: null, lastAppliedAt: null, mappingHash: "x" } : null),
      upsert: over.upsertFails ? jest.fn().mockRejectedValue(new Error("db down")) : jest.fn().mockResolvedValue({}),
    },
  };
  const source = {
    discover: jest.fn().mockResolvedValue(f),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    close: jest.fn().mockResolvedValue(undefined),
    ...(over.dbCreds ? { fetchDbCredentials: jest.fn().mockResolvedValue({ user: "u", password: "pw", database: "srcdb" }) } : {}),
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined), membershipPermissions: jest.fn().mockResolvedValue(new Set(over.canProjects === false ? ["apps:config"] : ["apps:config", "projects"])) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const session = { id: "sess-1", teamId: "team-1", sourceKind: "coolify", baseUrl: "https://c.example.com", scopeKey: "" };
  const importer = { openSession: jest.fn().mockResolvedValue({ source, session }) };
  const appsSvc = {
    create: jest.fn().mockResolvedValue({ id: "app-new", name: "web" }),
    setVolumes: jest.fn().mockResolvedValue(undefined),
    setNetworks: over.setNetworks ?? jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    setEnvironment: jest.fn().mockResolvedValue(undefined),
  };
  const gitSources = { upsertForImport: jest.fn().mockResolvedValue("gs-new") };
  const treeIds = new Map<string, string>();
  const projects = {
    findOrCreateForImport:
      over.findOrCreate ??
      jest.fn().mockImplementation(async (_u: string, _t: string, spec: { name: string; environments: Array<{ name: string }> }) => {
        const first = !treeIds.has(`p:${spec.name}`);
        const idOf = (k: string) => {
          if (!treeIds.has(k)) treeIds.set(k, `id-${treeIds.size}`);
          return treeIds.get(k)!;
        };
        const environments: Record<string, string> = {};
        const createdEnvironments: string[] = [];
        for (const e of spec.environments) {
          if (!treeIds.has(`e:${spec.name}:${e.name}`)) createdEnvironments.push(e.name);
          environments[e.name] = idOf(`e:${spec.name}:${e.name}`);
        }
        return { projectId: idOf(`p:${spec.name}`), created: first, environments, createdEnvironments };
      }),
  };
  const dbs = {
    create: jest.fn().mockResolvedValue({ id: "db-new", name: "Orders DB" }),
    createPinned: jest.fn().mockResolvedValue({ id: "db-new", name: "orders-primary" }),
    createForImport: jest.fn().mockResolvedValue({ id: "db-new", name: "orders-primary" }),
    setLimits: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    setEnvironment: jest.fn().mockResolvedValue(undefined),
  };
  const mappings = new ImportMappingService(prisma as never, access as never, audit as never);
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, importer as never, appsSvc as never, dbs as never, { revoke: jest.fn() } as never, {} as never, gitSources as never, projects as never, { resolve: jest.fn().mockResolvedValue(new Map()) } as never, mappings);
  const plan = planImport(f, { sourceKind: "coolify" });
  const base = { sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash: plan.planHash };
  /** The reviewed hash for a doc (what the web gets from POST /import/mapping/resolve). */
  const resolve = (doc: ImportMappingDoc, extra: { environmentId?: string; reconcile?: boolean } = {}) => mappings.resolve("user-1", session, f, plan, { id: "srv-tugra", teamId: "team-1" }, { mapping: doc, ...extra });
  const nothingCreated = () => {
    expect(gitSources.upsertForImport).not.toHaveBeenCalled();
    expect(projects.findOrCreateForImport).not.toHaveBeenCalled();
    expect(prisma.bulkOperation.create).not.toHaveBeenCalled();
    expect(appsSvc.create).not.toHaveBeenCalled();
    expect(dbs.create).not.toHaveBeenCalled();
    expect(dbs.createPinned).not.toHaveBeenCalled();
    expect(dbs.createForImport).not.toHaveBeenCalled();
  };
  return { svc, prisma, audit, access, source, apps: appsSvc, dbs, projects, gitSources, mappings, created, base, plan, resolve, nothingCreated, fleet: f, session };
}

const doc = (d: Record<string, unknown>): ImportMappingDoc => ImportMappingDocSchema.parse({ version: 1, ...d });
/** Apply WITH a mapping: resolves first so the hash is the reviewed one. */
async function applyMapped(h: ReturnType<typeof harness>, d: ImportMappingDoc, extra: Record<string, unknown> = {}, resolveExtra: { environmentId?: string; reconcile?: boolean } = {}) {
  const res = await h.resolve(d, { ...resolveExtra, ...(extra.reconcile ? { reconcile: true } : {}), ...(extra.environmentId ? { environmentId: extra.environmentId as string } : {}) });
  return h.svc.apply("user-1", { ...h.base, mapping: d, mappingHash: res.mappingHash, ...extra } as never);
}
const taskData = (h: ReturnType<typeof harness>, itemRef: string) => h.created.find((c) => c.data.itemRef === itemRef)!.data;
const finalUpdates = (h: ReturnType<typeof harness>) => h.prisma.bulkTask.update.mock.calls.map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data);

describe("apply — no mapping (the legacy path is untouched)", () => {
  it("no profile, no mapping: same calls and rows as before; mappingApplied false; no mapping on op.meta", async () => {
    const h = harness();
    const r = await h.svc.apply("user-1", h.base);
    await flush();
    expect(r).toEqual({ opId: "op-1", mappingApplied: false });
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "web", serverId: "srv-tugra" }));
    expect(h.dbs.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "Orders DB" }));
    expect(h.dbs.createPinned).not.toHaveBeenCalled();
    const meta = (h.prisma.bulkOperation.create.mock.calls[0][0] as { data: { meta: Record<string, unknown> } }).data.meta;
    expect(meta.mapping).toBeUndefined();
    expect(taskData(h, APP).result).toEqual({ name: "web" });
    const done = finalUpdates(h).find((d) => d.status === "DONE" && d.resourceType === "application")!;
    expect(Object.keys(done.result as object)).not.toContain("sourceName");
    expect(Object.keys(done.result as object)).not.toContain("mapped");
    expect(h.prisma.importMapping.upsert).not.toHaveBeenCalled();
    expect(h.apps.setNetworks).not.toHaveBeenCalled();
  });
  it("an EMPTY stored profile does not trip the fail-closed rule", async () => {
    const h = harness({ profile: doc({}) });
    await expect(h.svc.apply("user-1", h.base)).resolves.toMatchObject({ mappingApplied: false });
  });
});

describe("apply — fail closed before any side effect", () => {
  it("a non-empty stored profile and no mapping -> 409 import.mapping_required; ignoreStoredMapping bypasses it", async () => {
    const h = harness({ profile: doc({ items: { [APP]: { name: "kept" } } }) });
    const e = await h.svc.apply("user-1", h.base).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: "import.mapping_required" });
    h.nothingCreated();
    expect(h.source.close).toHaveBeenCalled();
    await expect(h.svc.apply("user-1", { ...h.base, ignoreStoredMapping: true })).resolves.toMatchObject({ opId: "op-1", mappingApplied: false });
  });
  it("a wrong mappingHash -> 409 import.mapping_changed", async () => {
    const h = harness();
    const e = await h.svc.apply("user-1", { ...h.base, mapping: doc({ items: { [APP]: { name: "x" } } }), mappingHash: "0".repeat(32) }).catch((x) => x);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: "import.mapping_changed" });
    h.nothingCreated();
  });
  it("orphans -> 409 import.mapping_orphans with the refs; clearing them lets it pass", async () => {
    const h = harness();
    const bad = doc({ items: { "app:srv-a:gone": { name: "x" } } });
    const e = await applyMapped(h, bad).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: "import.mapping_orphans", orphans: ["app:srv-a:gone"] });
    h.nothingCreated();
    await expect(applyMapped(h, doc({}))).resolves.toMatchObject({ mappingApplied: true });
  });
  it("ERROR conflicts and un-acked conflicts -> 422 import.mapping_invalid (full list); acks lift the second", async () => {
    const h = harness();
    const e = await applyMapped(h, doc({ items: { [APP]: { name: "a".repeat(101) } } })).catch((x) => x);
    expect(e).toBeInstanceOf(UnprocessableEntityException);
    expect((e as UnprocessableEntityException).getResponse()).toMatchObject({ code: "import.mapping_invalid", conflicts: [expect.objectContaining({ code: "name.too_long", itemRef: APP })] });
    h.nothingCreated();
    // same name in the same default environment needs an ack
    const dupDoc = doc({ items: { [APP2]: { name: "web" } } });
    const e2 = await applyMapped(h, dupDoc).catch((x) => x);
    expect((e2 as UnprocessableEntityException).getResponse()).toMatchObject({ conflicts: expect.arrayContaining([expect.objectContaining({ code: "name.duplicate", requiresAck: true })]) });
    h.nothingCreated();
    const acked = doc({ items: { [APP2]: { name: "web" } }, acks: [`name.duplicate:${APP}`, `name.duplicate:${APP2}`] });
    await expect(applyMapped(h, acked)).resolves.toMatchObject({ mappingApplied: true });
  });
  it("a perm.projects ERROR is a refusal (no degrade onto another environment)", async () => {
    const h = harness({ canProjects: false });
    const e = await applyMapped(h, doc({ items: { [APP]: { project: "New" } } })).catch((x) => x);
    expect(e).toBeInstanceOf(UnprocessableEntityException);
    expect((e as UnprocessableEntityException).getResponse()).toMatchObject({ conflicts: [expect.objectContaining({ code: "perm.projects" })] });
    h.nothingCreated();
  });
  it("a findOrCreateForImport failure under a mapping throws hard — no op row, no tasks", async () => {
    const h = harness({ findOrCreate: jest.fn().mockRejectedValue(new Error("boom")) });
    await expect(applyMapped(h, doc({ items: { [APP]: { project: "P" } } }))).rejects.toThrow("boom");
    expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
    expect(h.prisma.bulkTask.create).not.toHaveBeenCalled();
    expect(h.source.close).toHaveBeenCalled();
  });
  it("imported on another server needs an ack", async () => {
    const live: Live = { apps: [{ id: "a-old", name: "web", environmentId: "env-x", serverId: "srv-other" }], tasks: [{ itemRef: APP, resourceId: "a-old", resourceType: "application", serverId: "srv-other" }] };
    const h = harness({ live });
    const e = await applyMapped(h, doc({})).catch((x) => x);
    expect((e as UnprocessableEntityException).getResponse()).toMatchObject({ conflicts: [expect.objectContaining({ code: "item.imported_elsewhere", params: { server: "Other box" } })] });
    h.nothingCreated();
    await expect(applyMapped(h, doc({ acks: [`item.imported_elsewhere:${APP}`] }))).resolves.toMatchObject({ mappingApplied: true });
  });
});

describe("apply — with a mapping", () => {
  it("renames an app: apps.create gets the new name, result.sourceName survives DONE, mappingApplied true", async () => {
    const h = harness();
    const r = await applyMapped(h, doc({ items: { [APP]: { name: "Storefront" } } }));
    await flush();
    expect(r).toEqual({ opId: "op-1", mappingApplied: true });
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "Storefront" }));
    expect(taskData(h, APP).result).toEqual({ name: "Storefront", sourceName: "web", mapped: true });
    const done = finalUpdates(h).find((d) => d.status === "DONE" && d.resourceType === "application")!;
    expect(done.result).toMatchObject({ name: "web", sourceName: "web", mapped: true, appId: "app-new" }); // created.name from the (mock) create
    // the unmapped app keeps the source name
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "worker" }));
  });
  it("renamed DB with carried credentials: display name renamed, identifier stays the source's", async () => {
    const h = harness({ dbCreds: true });
    await applyMapped(h, doc({ items: { [DB]: { name: "orders-primary" } } }));
    await flush();
    expect(h.dbs.createForImport).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "orders-primary", database: "srcdb" }));
    expect(h.dbs.createPinned).not.toHaveBeenCalled();
  });
  it("renamed fresh-credentials DB: createPinned gets slug(sourceName) — the same identifier an un-renamed import gets", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [DB]: { name: "orders-primary" } } }));
    await flush();
    expect(h.dbs.createPinned).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "orders-primary", engine: "POSTGRES" }), { database: "orders_db" });
    expect(h.dbs.create).not.toHaveBeenCalled();
    // un-renamed under a mapping: the same identifier
    const h2 = harness();
    await applyMapped(h2, doc({}));
    await flush();
    expect(h2.dbs.createPinned).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "Orders DB" }), { database: "orders_db" });
  });
  it("a dbIdentifier override is honoured on the fresh path", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [DB]: { dbIdentifier: "ledger" } } }));
    await flush();
    expect(h.dbs.createPinned).toHaveBeenCalledWith("user-1", expect.anything(), { database: "ledger" });
  });
  it("a Coolify item lands in the mapped project and environment; only used groups are created", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [APP]: { project: "Storefront", environment: "live" } } }));
    await flush();
    expect(h.projects.findOrCreateForImport).toHaveBeenCalledTimes(1);
    expect(h.projects.findOrCreateForImport).toHaveBeenCalledWith("user-1", "team-1", expect.objectContaining({ name: "Storefront", environments: [{ name: "live", isDefault: false }] }));
    const envId = (await h.projects.findOrCreateForImport.mock.results[0].value).environments.live;
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "web", environmentId: envId }));
    expect(h.apps.create).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: "worker", environmentId: undefined }));
  });
  it("a project alone lands in a production environment, flagged default", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [APP]: { project: "Storefront" } } }));
    expect(h.projects.findOrCreateForImport).toHaveBeenCalledWith("user-1", "team-1", expect.objectContaining({ environments: [{ name: "production", isDefault: true }] }));
  });
  it("Dokploy tree under a mapping: renames apply, empty-project suppression, description/tags only for tree groups", async () => {
    const h = harness({ fleet: treeFleet() });
    await applyMapped(h, doc({ projects: { p1: { name: "Store" } }, items: { [APP2]: { include: false } } }));
    await flush();
    const calls = h.projects.findOrCreateForImport.mock.calls;
    const names = calls.map((c: unknown[]) => (c[2] as { name: string }).name);
    expect(names).toEqual(["Store"]); // the renamed project only; "Ops" holds just an excluded app -> not created
    expect(calls[0][2]).toMatchObject({ description: "d", tags: ["t"] }); // tree-derived group keeps the source metadata
  });
  it("legacy (no mapping) still creates every source project, even an empty one", async () => {
    const f = treeFleet();
    f.apps.pop(); // Ops has no app left
    const h = harness({ fleet: f });
    await h.svc.apply("user-1", h.base);
    expect(h.projects.findOrCreateForImport).toHaveBeenCalledTimes(2);
  });
  it("include:false -> SKIPPED with the fixed reason; nothing created for it", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [DB]: { include: false } } }));
    await flush();
    expect(taskData(h, DB)).toMatchObject({ status: "SKIPPED", output: "excluded by mapping" });
    expect(h.dbs.create).not.toHaveBeenCalled();
    expect(h.dbs.createPinned).not.toHaveBeenCalled();
  });
  it("container alias: setNetworks after create; a thrown setNetworks leaves the task DONE with a fixed note, never retried", async () => {
    const ok = harness();
    await applyMapped(ok, doc({ items: { [APP]: { containerAlias: "storefront" } } }));
    await flush();
    expect(ok.apps.setNetworks).toHaveBeenCalledTimes(1);
    expect(ok.apps.setNetworks).toHaveBeenCalledWith("user-1", "app-new", { containerAlias: "storefront" });
    expect(finalUpdates(ok).find((d) => d.status === "DONE" && (d.result as { sourceName?: string }).sourceName === "web")!.result).toMatchObject({ aliasApplied: true });

    const setNetworks = jest.fn().mockRejectedValue(new Error("'x' is reserved for Tugra-managed containers — secret-ish detail"));
    const bad = harness({ setNetworks });
    await applyMapped(bad, doc({ items: { [APP]: { containerAlias: "storefront" } } }));
    await flush();
    const done = finalUpdates(bad).find((d) => d.status === "DONE" && (d.result as { sourceName?: string }).sourceName === "web")!;
    expect(done.output).toBe("container alias not applied: reserved");
    expect(done.result).toMatchObject({ aliasApplied: false });
    expect(String(done.output)).not.toMatch(/secret-ish/);
    expect(setNetworks).toHaveBeenCalledTimes(1);
    expect(finalUpdates(bad).some((d) => d.status === "FAILED")).toBe(false); // no orphan / no duplicate-on-retry hazard
  });
  it("op.meta.mapping is a names-only snapshot; the audit meta carries the hash and counts only", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [APP]: { name: "Storefront", project: "P" }, [DB]: { include: false } } }));
    const meta = (h.prisma.bulkOperation.create.mock.calls[0][0] as { data: { meta: { mapping: Record<string, unknown> } } }).data.meta.mapping;
    expect(meta).toMatchObject({ renamed: 1, moved: 1, excluded: 1, aliased: 0, reconcile: false, hash: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect((meta.effective as Array<{ itemRef: string; name: string; sourceName: string; project: string | null }>).find((e) => e.itemRef === APP)).toEqual({ itemRef: APP, name: "Storefront", sourceName: "web", project: "P", environment: "production" });
    const audit = h.audit.log.mock.calls.map((c: unknown[]) => c[0] as { action: string; meta: Record<string, unknown> }).find((c) => c.action === "import.apply")!;
    expect(audit.meta).toMatchObject({ mappingHash: meta.hash, renamed: 1, moved: 1, excluded: 1 });
    expect(JSON.stringify(audit.meta)).not.toMatch(/Storefront/);
  });
  it("the profile is saved AFTER the op row; saveMapping:false skips it; a failing upsert does not fail the apply", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [APP]: { name: "Storefront" } } }));
    expect(h.prisma.importMapping.upsert).toHaveBeenCalledTimes(1);
    expect(h.prisma.importMapping.upsert.mock.invocationCallOrder[0]).toBeGreaterThan(h.prisma.bulkOperation.create.mock.invocationCallOrder[0]);
    const arg = h.prisma.importMapping.upsert.mock.calls[0][0] as { create: Record<string, unknown>; where: { teamId_sourceKind_baseUrl_scopeKey: Record<string, string> } };
    expect(arg.where.teamId_sourceKind_baseUrl_scopeKey).toEqual({ teamId: "team-1", sourceKind: "coolify", baseUrl: "https://c.example.com", scopeKey: "" });
    expect(arg.create).toMatchObject({ lastAppliedOpId: "op-1" });

    const skip = harness();
    await applyMapped(skip, doc({ items: { [APP]: { name: "x" } } }), { saveMapping: false });
    expect(skip.prisma.importMapping.upsert).not.toHaveBeenCalled();

    const fail = harness({ upsertFails: true });
    await expect(applyMapped(fail, doc({ items: { [APP]: { name: "x" } } }))).resolves.toMatchObject({ opId: "op-1", mappingApplied: true });
  });
  it("a re-run reloads the stored edits (the profile keeps them) — apply must re-send them explicitly", async () => {
    const stored = doc({ items: { [APP]: { name: "Storefront" } } });
    const h = harness({ profile: stored });
    const plan = await h.mappings.planBlock({ id: "s", teamId: "team-1", sourceKind: "coolify", baseUrl: "https://c.example.com", scopeKey: "" });
    expect(plan).toMatchObject({ features: ["mapping-v1"], stored, storedVersion: 3 });
    await expect(h.svc.apply("user-1", h.base)).rejects.toBeInstanceOf(ConflictException);
    await expect(applyMapped(h, stored)).resolves.toMatchObject({ mappingApplied: true });
  });
  it("git source: the mapped name applies on create; an existing source keeps its name with a fixed note", async () => {
    const fresh = harness({ gitProviders: true });
    fresh.source.fetchSecrets.mockResolvedValue({ values: { privateKey: "-----BEGIN-----" }, unresolved: [] });
    await applyMapped(fresh, doc({ gitSources: { g1: { name: "Org GitHub" } } }));
    expect(fresh.gitSources.upsertForImport).toHaveBeenCalledWith("user-1", "team-1", expect.objectContaining({ name: "Org GitHub", appId: "77" }));
    const existing = harness({ gitProviders: true, gitSourcesExisting: [{ appId: "77" }] });
    existing.source.fetchSecrets.mockResolvedValue({ values: { privateKey: "-----BEGIN-----" }, unresolved: [] });
    await applyMapped(existing, doc({ gitSources: { g1: { name: "Org GitHub" } } }));
    const meta = (existing.prisma.bulkOperation.create.mock.calls[0][0] as { data: { meta: { warnings?: string[] } } }).data.meta;
    expect(meta.warnings?.some((w) => /name was kept/.test(w))).toBe(true);
  });
  it("renaming does not desync the migrator: the task keeps its itemRef and resourceId (ingest resolves by itemRef)", async () => {
    const h = harness();
    await applyMapped(h, doc({ items: { [DB]: { name: "renamed-db" } } }));
    await flush();
    const done = finalUpdates(h).find((d) => d.status === "DONE" && d.resourceType === "database")!;
    expect(done).toMatchObject({ resourceId: "db-new" });
    expect(taskData(h, DB).itemRef).toBe(DB); // dataRef = "data:" + itemRef is unchanged by a rename
  });
});

describe("apply — already-imported items (drift / reconcile)", () => {
  const live = (): Live => ({
    apps: [{ id: "a-live", name: "web", environmentId: "env-old", containerAlias: null }],
    tasks: [{ itemRef: APP, resourceId: "a-live", resourceType: "application", serverId: "srv-tugra" }],
  });
  const changed = doc({ items: { [APP]: { name: "Storefront" } } });

  it("no mapped difference -> the legacy reason text, byte-identical", async () => {
    const h = harness({ live: live() });
    await applyMapped(h, doc({}));
    expect(taskData(h, APP)).toMatchObject({ status: "SKIPPED", output: "already imported onto this server in a previous run" });
  });
  it("drift without reconcile: the reason gets the 'mapping not applied' suffix; nothing is changed", async () => {
    const h = harness({ live: live() });
    await applyMapped(h, changed);
    await flush();
    expect(taskData(h, APP)).toMatchObject({ status: "SKIPPED", output: "already imported onto this server in a previous run; mapping not applied (name) — enable reconcile" });
    expect(h.apps.rename).not.toHaveBeenCalled();
    expect(h.apps.create).toHaveBeenCalledTimes(1); // only the other app
  });
  it("reconcile: rename, environment move and alias go through the existing methods; the task ends SKIPPED, never DONE", async () => {
    const h = harness({ live: live() });
    await applyMapped(h, doc({ items: { [APP]: { name: "Storefront", project: "P", environment: "live", containerAlias: "shop" } } }), { reconcile: true });
    await flush();
    expect(h.apps.rename).toHaveBeenCalledWith("user-1", "a-live", "Storefront");
    const envId = (await h.projects.findOrCreateForImport.mock.results[0].value).environments.live;
    expect(h.apps.setEnvironment).toHaveBeenCalledWith("user-1", "a-live", envId);
    expect(h.apps.setNetworks).toHaveBeenCalledWith("user-1", "a-live", { containerAlias: "shop" });
    expect(h.apps.create).toHaveBeenCalledTimes(1); // the existing app is never re-created
    const upd = finalUpdates(h).find((d) => d.resourceId === "a-live")!;
    expect(upd).toMatchObject({ status: "SKIPPED", resourceType: "application", resourceId: "a-live", result: { name: "Storefront", sourceName: "web", mapped: true, reconciled: ["name", "environment", "containerAlias"] } });
    expect(finalUpdates(h).some((d) => d.status === "DONE" && d.resourceId === "a-live")).toBe(false);
    expect(String(upd.output)).toMatch(/reconciled: name, environment, containerAlias/);
  });
  it("a failing reconcile step becomes a fixed note; it never throws or fails the task", async () => {
    const h = harness({ live: live() });
    h.apps.rename.mockRejectedValue(new Error("forbidden: secret detail"));
    await applyMapped(h, changed, { reconcile: true });
    await flush();
    const upd = finalUpdates(h).find((d) => d.resourceId === "a-live")!;
    expect(upd.status).toBe("SKIPPED");
    expect(upd.output).toBe("already imported onto this server in a previous run; reconciled: nothing; name not reconciled");
  });
  it("reconciles a database through dbs.rename; a dbIdentifier change on an imported DB is a hard refusal", async () => {
    const live2: Live = { dbs: [{ id: "d-live", name: "Orders DB", environmentId: "env-old" }], tasks: [{ itemRef: DB, resourceId: "d-live", resourceType: "database", serverId: "srv-tugra" }] };
    const h = harness({ live: live2 });
    await applyMapped(h, doc({ items: { [DB]: { name: "ledger" } } }), { reconcile: true });
    await flush();
    expect(h.dbs.rename).toHaveBeenCalledWith("user-1", "d-live", "ledger");
    const h2 = harness({ live: live2 });
    const e = await applyMapped(h2, doc({ items: { [DB]: { dbIdentifier: "ledger" } } }), { reconcile: true }).catch((x) => x);
    expect((e as UnprocessableEntityException).getResponse()).toMatchObject({ conflicts: [expect.objectContaining({ code: "db.identifier_on_imported" })] });
    h2.nothingCreated();
  });
});

describe("status view", () => {
  it("carries sourceName and mapped additively; absent without a mapping", () => {
    const v = toStatusView({
      id: "op", planId: "h", meta: {}, cancelRequestedAt: null, createdAt: new Date(0),
      tasks: [
        { itemRef: APP, kind: "app", status: "DONE", resourceType: "application", resourceId: "a", result: { name: "Storefront", sourceName: "web", mapped: true }, output: null, startedAt: null, finishedAt: null },
        { itemRef: APP2, kind: "app", status: "DONE", resourceType: "application", resourceId: "b", result: { name: "worker" }, output: null, startedAt: null, finishedAt: null },
      ],
    });
    expect(v.tasks[0]).toMatchObject({ name: "Storefront", sourceName: "web", mapped: true });
    expect(Object.keys(v.tasks[1])).not.toContain("sourceName");
    expect(Object.keys(v.tasks[1])).not.toContain("mapped");
  });
});
