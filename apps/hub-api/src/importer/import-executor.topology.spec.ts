import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ImportExecutorService } from "./import-executor.service";
import { planImport } from "./import-planner";
import type { ForeignFleet } from "./foreign-fleet";
import { ImportApplySchema } from "./dto";
import { fixtureByName } from "./testing/service-fixtures";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Two source hosts (host-a, host-b); an app + db on each. */
function fleet(): ForeignFleet {
  return {
    servers: [{ ref: "src-a" }, { ref: "src-b" }],
    apps: [
      { sourceRef: "app-a", name: "web-a", kind: "git", buildPack: "nixpacks", git: { url: "o/a", branch: "main" }, ports: [3000], serverRef: "src-a", env: [], volumes: [], domains: [] },
      { sourceRef: "app-b", name: "web-b", kind: "git", buildPack: "nixpacks", git: { url: "o/b", branch: "main" }, ports: [3000], serverRef: "src-b", env: [], volumes: [], domains: [] },
    ],
    databases: [
      { sourceRef: "db-a", name: "db-a", engine: "POSTGRES", version: "16", serverRef: "src-a" },
      { sourceRef: "db-b", name: "db-b", engine: "REDIS", version: "7", serverRef: "src-b" },
    ],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}

const SERVERS: Record<string, { id: string; teamId: string; status?: string; capabilities?: string[] }> = {
  "srv-default": { id: "srv-default", teamId: "team-1" },
  "tgt-1": { id: "tgt-1", teamId: "team-1" },
  "tgt-2": { id: "tgt-2", teamId: "team-1" },
  "tgt-foreign": { id: "tgt-foreign", teamId: "team-9" },
  "tgt-off": { id: "tgt-off", teamId: "team-1", status: "OFFLINE", capabilities: ["deploy"] },
  "tgt-new": { id: "tgt-new", teamId: "team-1", status: "PENDING", capabilities: ["deploy"] },
  "tgt-nocap": { id: "tgt-nocap", teamId: "team-1", status: "ONLINE", capabilities: ["backup"] },
};

function harness(over: { fleet?: ForeignFleet; inflightOn?: string[]; prior?: Array<{ itemRef: string; resourceId: string; resourceType: string; serverId: string }>; liveAppIds?: string[]; liveDbIds?: string[] } = {}) {
  let seq = 0;
  const created: Array<{ id: string; data: Record<string, any> }> = [];
  const f = over.fleet ?? fleet();
  const prisma = {
    server: { findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => (SERVERS[where.id] ? { ...SERVERS[where.id], publicIp: "203.0.113.7", clusterId: null } : null)) },
    bulkOperation: {
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { meta?: { equals: string }; tasks: { some: { serverId?: string } } } }) => {
        const asked = where.meta?.equals ?? where.tasks.some.serverId!;
        return (over.inflightOn ?? []).includes(asked) ? { id: "op-busy" } : null;
      }),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "op-1", ...data })),
      findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    bulkTask: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { serverId: string } }) => (over.prior ?? []).filter((p) => p.serverId === where.serverId)),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const t = { id: `task-${seq++}`, ...data };
        created.push({ id: t.id, data });
        return Promise.resolve(t);
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    application: { findMany: jest.fn().mockResolvedValue((over.liveAppIds ?? []).map((id) => ({ id }))), findFirst: jest.fn().mockResolvedValue(null) },
    database: { findMany: jest.fn().mockResolvedValue((over.liveDbIds ?? []).map((id) => ({ id }))), findFirst: jest.fn().mockResolvedValue(null) },
    gitSource: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
  };
  const source = {
    discover: jest.fn().mockResolvedValue(f),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    fetchServiceBundle: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const apps = {
    create: jest.fn().mockImplementation(async (_u: string, i: { name: string }) => ({ id: `app-${i.name}`, name: i.name })),
    setServiceDomains: jest.fn().mockResolvedValue(undefined),
    setConfigMountsForImport: jest.fn().mockResolvedValue(undefined),
    setComposeNetworks: jest.fn().mockResolvedValue(undefined),
    setVolumes: jest.fn().mockResolvedValue(undefined),
    setBuild: jest.fn().mockResolvedValue(undefined),
    setWatchPaths: jest.fn().mockResolvedValue(undefined),
    setAutoDeploy: jest.fn().mockResolvedValue(undefined),
    setLimits: jest.fn().mockResolvedValue(undefined),
    setContainerCommand: jest.fn().mockResolvedValue(undefined),
    setContainerPort: jest.fn().mockResolvedValue(undefined),
    setNetworkAliases: jest.fn().mockResolvedValue(undefined),
  };
  const dbs = {
    create: jest.fn().mockImplementation(async (_u: string, i: { name: string }) => ({ id: `db-${i.name}`, name: i.name })),
    createForImport: jest.fn().mockImplementation(async (_u: string, i: { name: string }) => ({ id: `db-${i.name}`, name: i.name })),
    setLimits: jest.fn().mockResolvedValue(undefined),
  };
  const gitSources = { upsertForImport: jest.fn().mockResolvedValue({ id: "gs-1" }) };
  const projects = { findOrCreateForImport: jest.fn().mockResolvedValue({ id: "proj-1", environments: {} }) };
  const svc = new ImportExecutorService(
    prisma as never,
    {} as never,
    access as never,
    audit as never,
    { openSession: jest.fn().mockResolvedValue({ source }) } as never,
    apps as never,
    dbs as never,
    { issue: jest.fn(), reissue: jest.fn(), revoke: jest.fn(), validate: jest.fn() } as never,
    {} as never,
    gitSources as never,
    projects as never,
    { resolve: jest.fn().mockResolvedValue(new Map()) } as never,
  );
  return { svc, prisma, apps, dbs, created, access, source, gitSources, projects };
}

const input = (f: ForeignFleet, extra: Record<string, unknown> = {}) => ({ sourceKind: "coolify" as const, sessionId: "s1", targetServerId: "srv-default", planHash: planImport(f, { sourceKind: "coolify" }).planHash, ...extra });
const taskFor = (h: ReturnType<typeof harness>, itemRef: string) => h.created.find((c) => c.data.itemRef === itemRef)!.data;

describe("ImportExecutorService.applyRemote: a target must be able to take apps", () => {
  it("refuses an offline, agent-less or capability-less server, as the default target or as a mapped one, before any row is written", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ targetServerId: "tgt-off" }, "import.target_offline"],
      [{ targetServerId: "tgt-new" }, "import.target_pending"],
      [{ targetServerId: "tgt-nocap" }, "import.target_capability"],
      [{ serverMap: { "src-a": "tgt-1", "src-b": "tgt-off" } }, "import.target_offline"],
      [{ serverMap: { "src-a": "tgt-1", "src-b": "tgt-nocap" } }, "import.target_capability"],
    ];
    for (const [extra, code] of cases) {
      const h = harness();
      const err = await h.svc.apply("u1", input(fleet(), extra)).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({ code });
      expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
    }
  });

  it("a map onto a server of another team is refused (403) before any row is written", async () => {
    const h = harness();
    const err = await h.svc.apply("u1", input(fleet(), { serverMap: { "src-a": "tgt-1", "src-b": "tgt-foreign" } })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
  });
});

describe("ImportExecutorService.applyRemote: multi-host placement (serverMap)", () => {
  it("places each app and database on the target its source server maps to; the op default stays the default", async () => {
    const h = harness();
    const f = fleet();
    await h.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }));
    await flush();
    expect(h.apps.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "web-a", serverId: "tgt-1" }));
    expect(h.apps.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "web-b", serverId: "tgt-2" }));
    expect(h.dbs.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "db-a", serverId: "tgt-1" }));
    expect(h.dbs.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "db-b", serverId: "tgt-2" }));
    expect(taskFor(h, "app:src-a:app-a").serverId).toBe("tgt-1");
    expect(taskFor(h, "app:src-b:app-b").serverId).toBe("tgt-2");
    expect(taskFor(h, "database:src-b:db-b").serverId).toBe("tgt-2");
    const meta = (h.prisma.bulkOperation.create as jest.Mock).mock.calls[0][0].data.meta;
    expect(meta.serverId).toBe("srv-default");
    expect(meta.serverMap).toEqual({ "src-a": "tgt-1", "src-b": "tgt-2" });
  });

  it("a source server the map shares with the default lands there; only one op row is written", async () => {
    const h = harness();
    const f = fleet();
    await h.svc.apply("u1", input(f, { serverMap: { "src-a": "srv-default", "src-b": "tgt-2" } }));
    await flush();
    expect(h.apps.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "web-a", serverId: "srv-default" }));
    expect(h.apps.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "web-b", serverId: "tgt-2" }));
    expect(h.prisma.bulkOperation.create).toHaveBeenCalledTimes(1);
  });

  it("no serverMap, or an empty one: everything lands on the default target (unchanged behaviour)", async () => {
    for (const extra of [{}, { serverMap: {} }]) {
      const h = harness();
      await h.svc.apply("u1", input(fleet(), extra));
      await flush();
      expect(h.apps.create.mock.calls.map((c) => c[1].serverId)).toEqual(["srv-default", "srv-default"]);
      expect(h.dbs.create.mock.calls.map((c) => c[1].serverId)).toEqual(["srv-default", "srv-default"]);
      expect((h.prisma.bulkOperation.create as jest.Mock).mock.calls[0][0].data.meta.serverMap).toBeUndefined();
    }
  });

  it("fails closed: a source server the (non-empty) map does not place is refused with the list, before any row is written", async () => {
    const h = harness();
    const err = await h.svc.apply("u1", input(fleet(), { serverMap: { "src-a": "tgt-1" } })).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse()).toMatchObject({ code: "import.server_unmapped", servers: ["src-b"], count: 1 });
    expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
    expect(h.prisma.bulkTask.create).not.toHaveBeenCalled();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(h.source.close).toHaveBeenCalled();
  });

  it("the refusal comes before git sources and projects are created, so nothing is left on the target team", async () => {
    const f = fleet();
    f.gitProviders = [{ ref: "g1", kind: "github", appId: "77", appName: "Source GH App" }];
    f.projects = [{ ref: "p1", name: "proj-a", environments: [{ ref: "e1", name: "production", isDefault: true }] }] as never;
    const h = harness({ fleet: f });
    h.source.fetchSecrets.mockResolvedValue({ values: { privateKey: "-----BEGIN-----" }, unresolved: [] });
    const err = await h.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1" } })).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "import.server_unmapped" });
    expect(h.gitSources.upsertForImport).not.toHaveBeenCalled();
    expect(h.projects.findOrCreateForImport).not.toHaveBeenCalled();
    expect(h.source.fetchSecrets).not.toHaveBeenCalled();
    expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
  });

  it("an item whose source server is unknown is unplaced too (reported as `_`), unless the map lists `_` or a choice places it", async () => {
    const f = fleet();
    f.apps[1].serverRef = undefined;
    f.databases[1].serverRef = "src-a";
    const h = harness({ fleet: f });
    const err = await h.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1" } })).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse()).toMatchObject({ code: "import.server_unmapped", servers: ["_"], count: 1 });
    expect(h.apps.create).not.toHaveBeenCalled();

    // the operator may place unknown-placement items on purpose by mapping `_`
    const h2 = harness({ fleet: f });
    await h2.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", _: "tgt-2" } }));
    await flush();
    expect(h2.apps.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "web-b", serverId: "tgt-2" }));
    expect(h2.apps.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "web-a", serverId: "tgt-1" }));

    // no map at all: everything stays on the default, an unknown placement included
    const h3 = harness({ fleet: f });
    await h3.svc.apply("u1", input(f, {}));
    await flush();
    expect(h3.apps.create.mock.calls.map((c) => c[1].serverId)).toEqual(["srv-default", "srv-default"]);
  });

  it("a prototype-named source ref is never resolved through the prototype chain", async () => {
    const f = fleet();
    f.apps[1].serverRef = "constructor";
    const h = harness({ fleet: f });
    const err = await h.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1" } })).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "import.server_unmapped" });
  });

  it("every mapped target is authorised: unknown 404, another team 403, in-flight 409", async () => {
    const f = fleet();
    await expect(harness().svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", "src-b": "nope" } }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness().svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", "src-b": "tgt-foreign" } }))).rejects.toBeInstanceOf(ForbiddenException);
    const busy = harness({ inflightOn: ["tgt-2"] });
    await expect(busy.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }))).rejects.toBeInstanceOf(ConflictException);
    expect(busy.prisma.bulkOperation.create).not.toHaveBeenCalled();
    const h = harness();
    await h.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }));
    expect(h.access.requirePermission).toHaveBeenCalledWith("u1", "team-1", "apps:config");
  });

  it("the in-flight check also sees tasks another op placed on a mapped server (a second query by task server)", async () => {
    const h = harness();
    await h.svc.apply("u1", input(fleet(), { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }));
    const wheres = (h.prisma.bulkOperation.findFirst as jest.Mock).mock.calls.map((c) => c[0].where);
    expect(wheres).toHaveLength(6); // default + two targets, each asked twice
    const byTask = wheres.filter((w) => !w.meta).map((w) => w.tasks.some.serverId);
    expect(byTask).toEqual(["srv-default", "tgt-1", "tgt-2"]);
    // an op that holds tgt-2 only through a placed task still blocks it
    const busy = harness();
    (busy.prisma.bulkOperation.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: { meta?: unknown; tasks: { some: { serverId?: string } } } }) => (!where.meta && where.tasks.some.serverId === "tgt-2" ? { id: "other-op" } : null));
    await expect(busy.svc.apply("u1", input(fleet(), { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }))).rejects.toBeInstanceOf(ConflictException);
  });

  it("idempotency follows each item's own target: a prior import on tgt-1 only skips the item that lands on tgt-1", async () => {
    const h = harness({
      prior: [{ itemRef: "app:src-a:app-a", resourceId: "app-old", resourceType: "application", serverId: "tgt-1" }],
      liveAppIds: ["app-old"],
    });
    await h.svc.apply("u1", input(fleet(), { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }));
    await flush();
    expect(taskFor(h, "app:src-a:app-a").status).toBe("SKIPPED");
    expect(taskFor(h, "app:src-b:app-b").status).toBe("PENDING");
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    // the same prior import on the OTHER server does not match
    const h2 = harness({ prior: [{ itemRef: "app:src-a:app-a", resourceId: "app-old", resourceType: "application", serverId: "tgt-2" }], liveAppIds: ["app-old"] });
    await h2.svc.apply("u1", input(fleet(), { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" } }));
    await flush();
    expect(taskFor(h2, "app:src-a:app-a").status).toBe("PENDING");
  });

  it("a service follows the map; its own explicit target server wins over the map", async () => {
    const s = fixtureByName("alpha-meilisearch").svc;
    const f: ForeignFleet = { servers: [], apps: [], databases: [], services: [{ ...s, serverRef: "src-b" }], volumes: [], sharedEnv: [], warnings: [] };
    const ref = `service:src-b:${s.sourceRef}`;
    const bundle = async () => ({ values: new Proxy({}, { get: () => "x" }) as Record<string, string>, unresolved: [] });
    const h = harness({ fleet: f });
    h.source.fetchServiceBundle.mockImplementation(bundle);
    await h.svc.apply("u1", input(f, { serverMap: { "src-b": "tgt-2" } }));
    await flush();
    expect(taskFor(h, ref).serverId).toBe("tgt-2");
    const h2 = harness({ fleet: f });
    h2.source.fetchServiceBundle.mockImplementation(bundle);
    await h2.svc.apply("u1", input(f, { serverMap: { "src-b": "tgt-2" }, serviceChoices: { [ref]: { targetServerId: "tgt-1" } } }));
    await flush();
    expect(taskFor(h2, ref).serverId).toBe("tgt-1");
  });

  it("a service skipped by choice places nothing, so its unmapped host does not block the import", async () => {
    const s = fixtureByName("alpha-meilisearch").svc;
    const f: ForeignFleet = { ...fleet(), services: [{ ...s, serverRef: "src-c" }] };
    const ref = `service:src-c:${s.sourceRef}`;
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f, { serverMap: { "src-a": "tgt-1", "src-b": "tgt-2" }, serviceChoices: { [ref]: { skip: true } } }));
    await flush();
    expect(taskFor(h, ref).status).toBe("SKIPPED");
  });
});

describe("ImportApplySchema: serverMap", () => {
  const base = { sourceKind: "coolify", sessionId: "s", targetServerId: "t", planHash: "a".repeat(32) };
  it("accepts a bounded map and refuses prototype keys and an oversized one", () => {
    expect(ImportApplySchema.safeParse({ ...base, serverMap: { "src-a": "tgt-1" } }).success).toBe(true);
    expect(ImportApplySchema.safeParse({ ...base }).success).toBe(true);
    expect(ImportApplySchema.safeParse({ ...base, serverMap: JSON.parse('{"__proto__":"x"}') }).success).toBe(false);
    expect(ImportApplySchema.safeParse({ ...base, serverMap: { constructor: "x" } }).success).toBe(false);
    const big = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, "t"]));
    expect(ImportApplySchema.safeParse({ ...base, serverMap: big }).success).toBe(false);
    expect(ImportApplySchema.safeParse({ ...base, serverMap: { "src a": "t" } }).success).toBe(false);
  });
});

describe("ImportExecutorService.runCreateDb: TLS for a PostgreSQL source that expects it (R22)", () => {
  const withTls = (tls?: { enabled: boolean; mode?: "require" | "verify-ca" | "verify-full" }, engine: "POSTGRES" | "REDIS" = "POSTGRES"): ForeignFleet => ({
    servers: [],
    apps: [],
    databases: [{ sourceRef: "db-a", name: "db-a", engine, version: "16", serverRef: "src-a", ...(tls ? { tls } : {}) }],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  });
  const dbTask = (h: ReturnType<typeof harness>) => (h.prisma.bulkTask.update as jest.Mock).mock.calls.map((c) => c[0]).find((c: { data: { resourceType?: string } }) => c.data.resourceType === "database");

  it("carried credentials: the database is created with ssl on", async () => {
    const f = withTls({ enabled: false, mode: "require" });
    const h = harness({ fleet: f });
    (h.source as unknown as { fetchDbCredentials: jest.Mock }).fetchDbCredentials = jest.fn().mockResolvedValue({ user: "u", password: "pw", database: "d" });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.dbs.createForImport).toHaveBeenCalledWith("u1", expect.objectContaining({ ssl: true }));
    expect(dbTask(h).data.result).toMatchObject({ tls: true });
  });

  it("fresh credentials: TLS is switched on right after create; a refusal degrades to a note, never fails the task", async () => {
    const f = withTls({ enabled: true });
    const h = harness({ fleet: f });
    const setSsl = jest.fn().mockResolvedValue({ changed: true, restartRequired: false });
    (h.dbs as unknown as { setSsl: jest.Mock }).setSsl = setSsl;
    await h.svc.apply("u1", input(f));
    await flush();
    expect(setSsl).toHaveBeenCalledWith("u1", "db-db-a", true);
    expect(dbTask(h).data.status).toBe("DONE");

    const h2 = harness({ fleet: f });
    (h2.dbs as unknown as { setSsl: jest.Mock }).setSsl = jest.fn().mockRejectedValue(new Error("boom"));
    await h2.svc.apply("u1", input(f));
    await flush();
    const t = dbTask(h2);
    expect(t.data.status).toBe("DONE");
    expect(String(t.data.output)).toMatch(/TLS was not enabled/);
  });

  it("no TLS expectation, or another engine: ssl is never requested", async () => {
    for (const f of [withTls(undefined), withTls({ enabled: true }, "REDIS")]) {
      const h = harness({ fleet: f });
      const setSsl = jest.fn();
      (h.dbs as unknown as { setSsl: jest.Mock }).setSsl = setSsl;
      await h.svc.apply("u1", input(f));
      await flush();
      expect(setSsl).not.toHaveBeenCalled();
    }
  });
});

describe("ImportExecutorService.runCopyApp: network aliases (C17)", () => {
  const withAliases = (): ForeignFleet => ({
    servers: [],
    apps: [{ sourceRef: "app-a", name: "web-a", kind: "git", buildPack: "dockerfile", git: { url: "o/a", branch: "main" }, ports: [3000], serverRef: "src-a", env: [], volumes: [], domains: [], networkAliases: ["api.internal"] }],
    databases: [],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  });
  const appDone = (h: ReturnType<typeof harness>) => (h.prisma.bulkTask.update as jest.Mock).mock.calls.map((c) => c[0]).find((c: { data: { resourceType?: string } }) => c.data.resourceType === "application");

  it("sets the label form on the created app and records the pair on the task for the env remap", async () => {
    const f = withAliases();
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.setNetworkAliases).toHaveBeenCalledWith("u1", "app-web-a", ["api-internal"]);
    const done = appDone(h);
    expect(done.data.status).toBe("DONE");
    expect(done.data.result.networkAliases).toEqual([{ from: "api.internal", to: "api-internal" }]);
    expect(done.data.result.postCreate.applied).toContain("networkAliases");
  });

  it("a refused alias never fails the app and leaves no pair behind", async () => {
    const f = withAliases();
    const h = harness({ fleet: f });
    h.apps.setNetworkAliases.mockRejectedValue(new Error("taken"));
    await h.svc.apply("u1", input(f));
    await flush();
    const done = appDone(h);
    expect(done.data.status).toBe("DONE");
    expect(done.data.result.networkAliases).toBeUndefined();
    expect(JSON.stringify(done.data.result.postCreate.unmapped)).toContain("networkAliases");
  });
});
