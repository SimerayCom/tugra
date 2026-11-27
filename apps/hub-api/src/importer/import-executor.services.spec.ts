import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ImportExecutorService } from "./import-executor.service";
import { planImport } from "./import-planner";
import type { ForeignFleet, ServiceBundle } from "./foreign-fleet";
import type { ServiceChoice } from "./dto";
import { fixtureByName, loadServiceFixtures, SIGNOZ_FILES } from "./testing/service-fixtures";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const SECRET = "SYNTH-SECRET-VALUE-9f3a";

const fleetOf = (names: string[]): ForeignFleet => ({ servers: [], apps: [], databases: [], services: names.map((n) => fixtureByName(n).svc), volumes: [], sharedEnv: [], warnings: [] });
const itemRefOf = (name: string) => {
  const s = fixtureByName(name).svc;
  return `service:${s.serverRef}:${s.sourceRef}`;
};

/** Every variable a raw compose references, with a synthetic secret value. */
function bundleOf(name: string, extra: Partial<ServiceBundle> = {}): ServiceBundle {
  const raw = fixtureByName(name).raw.docker_compose_raw!;
  const values: Record<string, string> = Object.create(null);
  for (const m of raw.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) values[m[1]] = `${SECRET}-${m[1]}`;
  return { values, unresolved: [], files: name === "signoz-hub" ? SIGNOZ_FILES : undefined, ...extra };
}

function harness(over: { fleet: ForeignFleet; bundle?: (ref: string) => ServiceBundle | undefined | Error; nameClash?: boolean; setServiceDomains?: jest.Mock; setConfigMounts?: jest.Mock; setNetworks?: jest.Mock; priorImported?: Array<{ itemRef: string; resourceId: string; resourceType: string }>; liveAppIds?: string[]; findOrCreateProject?: jest.Mock; servers?: Record<string, { id: string; teamId: string }> }) {
  let seq = 0;
  const created: Array<{ id: string; data: Record<string, unknown> }> = [];
  const servers = over.servers ?? { "srv-tugra": { id: "srv-tugra", teamId: "team-1" } };
  const prisma = {
    server: { findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => (servers[where.id] ? { ...servers[where.id], publicIp: "203.0.113.7", clusterId: null } : null)) },
    bulkOperation: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "op-1", ...data })),
      findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    bulkTask: {
      findMany: jest.fn().mockResolvedValue(over.priorImported ?? []),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const t = { id: `task-${seq++}`, ...data };
        created.push({ id: t.id, data });
        return Promise.resolve(t);
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    application: {
      findMany: jest.fn().mockResolvedValue((over.liveAppIds ?? []).map((id) => ({ id }))),
      findFirst: jest.fn().mockImplementation(async () => (over.nameClash ? { id: "app-existing" } : null)),
    },
    database: { findMany: jest.fn().mockResolvedValue([]) },
    gitSource: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const bundleFn = over.bundle ?? ((ref: string) => {
    const f = loadServiceFixtures().find((x) => x.svc.sourceRef === ref)!;
    return bundleOf(f.raw.name!);
  });
  const source = {
    discover: jest.fn().mockResolvedValue(over.fleet),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    fetchServiceBundle: jest.fn().mockImplementation(async (ref: string) => {
      const b = bundleFn(ref);
      if (b instanceof Error) throw b;
      return b;
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const apps = {
    create: jest.fn().mockImplementation(async (_u: string, input: { name: string }) => ({ id: `app-${input.name}`, name: input.name })),
    setServiceDomains: over.setServiceDomains ?? jest.fn().mockResolvedValue(undefined),
    setConfigMountsForImport: over.setConfigMounts ?? jest.fn().mockResolvedValue(undefined),
    setComposeNetworks: over.setNetworks ?? jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ImportExecutorService(prisma as never, {} as never, access as never, audit as never, { openSession: jest.fn().mockResolvedValue({ source, session: { id: "sess-1", teamId: "team-1" } }) } as never, apps as never, {} as never, { issue: jest.fn(), reissue: jest.fn(), revoke: jest.fn(), validate: jest.fn() } as never, {} as never, { upsertForImport: jest.fn() } as never, { findOrCreateForImport: over.findOrCreateProject ?? jest.fn() } as never, { resolve: jest.fn().mockResolvedValue(new Map()) } as never);
  return { svc, prisma, audit, apps, source, created, access };
}

const input = (f: ForeignFleet, serviceChoices?: Record<string, ServiceChoice>) => ({ sourceKind: "coolify" as const, sessionId: "s1", targetServerId: "srv-tugra", planHash: planImport(f, { sourceKind: "coolify" }).planHash, ...(serviceChoices ? { serviceChoices } : {}) });
const taskOf = (h: ReturnType<typeof harness>, name: string) => h.created.find((c) => c.data.itemRef === itemRefOf(name))!;
const finalUpdate = (h: ReturnType<typeof harness>, id: string) => (h.prisma.bulkTask.update as jest.Mock).mock.calls.map((c) => c[0]).filter((c: { where: { id: string } }) => c.where.id === id).pop() as { data: Record<string, any> };

describe("ImportExecutorService — Coolify services as stopped compose apps (runCopyService)", () => {
  it("meilisearch: creates ONE stopped compose app (serviceImport, deploy:false, tags), carries the secret, joins a private network", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const [, ci] = h.apps.create.mock.calls[0];
    expect(ci).toMatchObject({ name: "alpha-meilisearch", source: "COMPOSE", deploy: false, exposeMode: "none", serverId: "srv-tugra", tags: ["imported", "coolify-service"], templateSlug: "meilisearch" });
    expect(ci.domain).toBeUndefined();
    expect(ci.env.SERVICE_PASSWORD_MEILISEARCH).toBe(`${SECRET}-SERVICE_PASSWORD_MEILISEARCH`);
    expect(ci.composeFile).toContain("meilisearch-data:/meili_data");
    expect(ci.composeFile).not.toContain(SECRET);
    expect(h.apps.setComposeNetworks).toHaveBeenCalledWith("u1", "app-alpha-meilisearch", [{ network: "svc-alpha-meilisearch", service: "meilisearch", aliases: ["meilisearch"] }]);
    const done = finalUpdate(h, taskOf(h, "alpha-meilisearch").id).data;
    expect(done).toMatchObject({ status: "DONE", resourceType: "application", resourceId: "app-alpha-meilisearch" });
    expect(done.result).toMatchObject({ kind: "service", members: ["meilisearch"], privateNetwork: { network: "svc-alpha-meilisearch", alias: "meilisearch" }, volumes: [{ key: "meilisearch-data", dockerName: "tugra_app-alpha-meilisearch_meilisearch-data", state: "pending-data" }] });
    expect((done.result.checklist as Array<{ kind: string }>).map((c) => c.kind)).toContain("deploy-after-data");
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.service.copy" }));
  });

  it("a service lands in its Coolify project / environment, like an app or a database", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    f.services[0].projectRef = "p-acme";
    f.services[0].environmentRef = "p-acme#39";
    f.projects = [{ ref: "p-acme", name: "Acme", tags: [], environments: [{ ref: "p-acme#39", name: "production", isDefault: true }] }];
    const findOrCreateProject = jest.fn().mockResolvedValue({ projectId: "pj-1", created: true, environments: { production: "env-acme-prod" }, createdEnvironments: ["production"] });
    const h = harness({ fleet: f, findOrCreateProject });
    await h.svc.apply("u1", { ...input(f), environmentId: "env-selected" });
    await flush();
    expect(findOrCreateProject).toHaveBeenCalledWith("u1", "team-1", expect.objectContaining({ name: "Acme", environments: [{ name: "production", isDefault: true }] }));
    expect(h.apps.create.mock.calls[0][1]).toMatchObject({ name: "alpha-meilisearch", environmentId: "env-acme-prod" });
  });

  it("a service with no source placement keeps the selected environment", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", { ...input(f), environmentId: "env-selected" });
    await flush();
    expect(h.apps.create.mock.calls[0][1]).toMatchObject({ environmentId: "env-selected" });
  });

  it("the plan names the project and environment a service will land in", () => {
    const f = fleetOf(["alpha-meilisearch"]);
    f.services[0].projectRef = "p-acme";
    f.services[0].environmentRef = "p-acme#39";
    f.projects = [{ ref: "p-acme", name: "Acme", tags: [], environments: [{ ref: "p-acme#39", name: "production", isDefault: true }] }];
    const item = planImport(f, { sourceKind: "coolify" }).items.find((i) => i.kind === "service")!;
    expect(item.risks[0]).toMatchObject({ level: "info", code: "service.project" });
    expect(item.risks[0].message).toContain('"Acme"');
  });

  it("under a mapping a service follows its renamed source project / environment; a skipped or explicitly placed one is left alone", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    f.services[0].projectRef = "p-acme";
    f.services[0].environmentRef = "p-acme#39";
    f.projects = [{ ref: "p-acme", name: "Acme", tags: [], environments: [{ ref: "p-acme#39", name: "production", isDefault: true }] }];
    const findOrCreateProject = jest.fn().mockResolvedValue({ projectId: "pj-1", created: false, environments: { live: "env-live" }, createdEnvironments: [] });
    const h = harness({ fleet: f, findOrCreateProject });
    const ref = itemRefOf("alpha-meilisearch");
    const place = (choices: Record<string, ServiceChoice>, runnable = true) => {
      const tree = { envByRef: new Map(), summary: [], warnings: [], envBySourceService: new Map<string, string>() };
      return (h.svc as any).placeMappedServices("u1", "team-1", f, { "p-acme": { name: "Shop", environments: { "p-acme#39": "live" } } }, choices, () => runnable, tree).then(() => tree);
    };
    const tree = await place({});
    expect(findOrCreateProject).toHaveBeenCalledWith("u1", "team-1", expect.objectContaining({ name: "Shop", environments: [{ name: "live", isDefault: true }] }));
    expect(tree.envBySourceService.get(ref)).toBe("env-live");
    findOrCreateProject.mockClear();
    expect((await place({ [ref]: { skip: true } as ServiceChoice })).envBySourceService.size).toBe(0);
    expect((await place({ [ref]: { environmentId: "env-x" } as ServiceChoice })).envBySourceService.size).toBe(0);
    expect((await place({}, false)).envBySourceService.size).toBe(0);
    expect(findOrCreateProject).not.toHaveBeenCalled();
    // a project the caller may not create is a hard failure (a misplaced import is worse), like an app or a database under a mapping
    findOrCreateProject.mockRejectedValueOnce(new Error("forbidden"));
    await expect(place({})).rejects.toThrow("forbidden");
  });

  it("never deploys and never calls a deploy path", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create.mock.calls[0][1].deploy).toBe(false);
    expect(Object.keys(h.apps).some((k) => /deploy/i.test(k))).toBe(false);
  });

  it("no secret value in any task row, audit row or log line", async () => {
    const names = loadServiceFixtures().map((x) => x.raw.name!);
    const f = fleetOf(names);
    const h = harness({ fleet: f });
    const logs: string[] = [];
    const { Logger } = jest.requireActual("@nestjs/common");
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a))));
    await h.svc.apply("u1", input(f));
    await flush();
    spies.forEach((s) => s.mockRestore());
    const everything = JSON.stringify([(h.prisma.bulkTask.update as jest.Mock).mock.calls, (h.prisma.bulkTask.create as jest.Mock).mock.calls, h.audit.log.mock.calls, (h.prisma.bulkOperation.create as jest.Mock).mock.calls, logs]);
    expect(everything).not.toContain(SECRET);
    expect(h.apps.create.mock.calls.length).toBeGreaterThan(10); // the secrets really did flow into create()
  });

  it("all 19 services: 15 created, 2 partial created, 2 standalone agents SKIPPED with a reason, none failed", async () => {
    const names = loadServiceFixtures().map((x) => x.raw.name!);
    const f = fleetOf(names);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(17);
    const statuses = h.created.map((c) => c.data.status);
    expect(statuses.filter((s) => s === "SKIPPED")).toHaveLength(2);
    const failed = (h.prisma.bulkTask.update as jest.Mock).mock.calls.filter((c) => c[0].data.status === "FAILED");
    expect(failed).toEqual([]);
    for (const n of ["beszel-infra-agent", "beszel-storage-agent"]) expect(String(taskOf(h, n).data.output)).toMatch(/not imported|plan note/);
  });

  it("MinIO: host bind carried as a named volume, container_name stripped, no domain, private network", async () => {
    const f = fleetOf(["delta-storage-minio"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    const ci = h.apps.create.mock.calls[0][1];
    expect(ci.composeFile).toContain("minio-data:/data");
    expect(ci.composeFile).not.toContain("container_name");
    expect(ci.composeFile).not.toContain("/mnt/HC_Volume");
    expect(ci.templateSlug).toBeUndefined(); // service_type null: never linked to the curated minio
    expect(h.apps.setServiceDomains).not.toHaveBeenCalled();
    expect(h.apps.setComposeNetworks).toHaveBeenCalledWith("u1", expect.any(String), [{ network: "svc-delta-storage-minio", service: "minio", aliases: ["minio"] }]);
  });

  it("cloudflared: created stopped, held, no private network, tunnel item in the checklist", async () => {
    const f = fleetOf(["cloudflared-hub"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.setComposeNetworks).not.toHaveBeenCalled();
    const done = finalUpdate(h, taskOf(h, "cloudflared-hub").id).data;
    expect(done.result.hold).toBe(true);
    expect((done.result.checklist as Array<{ kind: string }>).map((c) => c.kind)).toContain("tunnel");
    expect(h.apps.create.mock.calls[0][1].env.CLOUDFLARE_TUNNEL_TOKEN).toContain(SECRET);
  });

  it("beszel hub: the agent is dropped, the hub domain becomes a service-domain row (no primary swallowed)", async () => {
    const f = fleetOf(["beszel-hub"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create.mock.calls[0][1].composeFile).not.toContain("docker.sock");
    expect(h.apps.setServiceDomains).toHaveBeenCalledWith("u1", "app-beszel-hub", [{ service: "beszel", hostname: "monitor.example.test", port: 8090 }]);
    expect(h.apps.setComposeNetworks).not.toHaveBeenCalled(); // it has a domain: no private network
  });

  it("signoz: config files seeded through setConfigMountsForImport; two service domains; clickhouse not carried", async () => {
    const f = fleetOf(["signoz-hub"]);
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.setConfigMountsForImport).toHaveBeenCalledTimes(1);
    expect(h.apps.setConfigMountsForImport.mock.calls[0][2]).toHaveLength(7);
    expect(h.apps.setServiceDomains.mock.calls[0][2]).toEqual([
      { service: "otel-collector", hostname: "otel.example.test", port: 4318 },
      { service: "signoz", hostname: "signoz.example.test", port: 8080 },
    ]);
    const done = finalUpdate(h, taskOf(h, "signoz-hub").id).data;
    expect(done.result.volumes.find((v: { key: string }) => v.key === "clickhouse")).toMatchObject({ policy: "skip", dataPlane: "not-carried" });
  });

  it("fails CLOSED before creating anything when the secrets are unavailable (403 → undefined bundle)", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f, bundle: () => undefined });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    const fin = finalUpdate(h, taskOf(h, "alpha-meilisearch").id).data;
    expect(fin.status).toBe("FAILED");
    expect(fin.output).toMatch(/read:sensitive/);
    expect(fin.output).toContain("SERVICE_PASSWORD_MEILISEARCH");
  });

  it("a bundle read error is a FIXED message that never echoes the client error", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f, bundle: () => new Error(`boom ${SECRET}`) });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    const fin = finalUpdate(h, taskOf(h, "alpha-meilisearch").id).data;
    expect(fin.output).toBe("service variables could not be read from the source — retry the import");
    expect(JSON.stringify(h.prisma.bulkTask.update.mock.calls)).not.toContain(SECRET);
  });

  it("signoz without readable config files fails before create (service.files.needed)", async () => {
    const f = fleetOf(["signoz-hub"]);
    const h = harness({ fleet: f, bundle: () => ({ ...bundleOf("signoz-hub"), files: undefined }) });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(finalUpdate(h, taskOf(h, "signoz-hub").id).data.output).toMatch(/config files are needed/);
  });

  it("a name clash is a hard failure with no auto-suffix, and nothing is created", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f, nameClash: true });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(finalUpdate(h, taskOf(h, "alpha-meilisearch").id).data.output).toBe("an app with this name already exists — rename it in the import screen");
  });

  it("a retry never duplicates: an already-imported (live) service item is SKIPPED", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f, priorImported: [{ itemRef: itemRefOf("alpha-meilisearch"), resourceId: "app-old", resourceType: "application" }], liveAppIds: ["app-old"] });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(taskOf(h, "alpha-meilisearch").data.status).toBe("SKIPPED");
  });

  it("domain, config-mount and network failures are best-effort: the app stays DONE with fixed unmapped notes (no orphan)", async () => {
    const f = fleetOf(["signoz-hub"]);
    const boom = jest.fn().mockRejectedValue(new Error(`rejected ${SECRET}`));
    const h = harness({ fleet: f, setServiceDomains: boom, setConfigMounts: boom });
    await h.svc.apply("u1", input(f));
    await flush();
    const fin = finalUpdate(h, taskOf(h, "signoz-hub").id).data;
    expect(fin.status).toBe("DONE");
    expect(fin.resourceId).toBe("app-signoz-hub");
    expect(JSON.stringify(fin)).not.toContain(SECRET);
    expect(fin.result.unmapped.map((u: { field: string }) => u.field)).toContain("configMounts");
    expect(fin.result.serviceDomains.unmapped.map((u: { field: string }) => u.field)).toContain("serviceDomains");
  });

  it("choices: skip, rename, pins, volume policy and a per-service target (re-authorised, same team)", async () => {
    const f = fleetOf(["alpha-meilisearch", "beta-meilisearch", "eta-gotenberg"]);
    const servers = { "srv-tugra": { id: "srv-tugra", teamId: "team-1" }, "srv-two": { id: "srv-two", teamId: "team-1" } };
    const h = harness({ fleet: f, servers });
    const choices = {
      [itemRefOf("alpha-meilisearch")]: { name: "Search A", pins: { meilisearch: "getmeili/meilisearch:v1.12.3" }, targetServerId: "srv-two", volumes: { "meilisearch-data": { policy: "empty" as const } } },
      [itemRefOf("beta-meilisearch")]: { skip: true },
    };
    await h.svc.apply("u1", input(f, choices));
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(2);
    const a = h.apps.create.mock.calls.find((c) => c[1].name === "Search A")!;
    expect(a[1].serverId).toBe("srv-two");
    expect(a[1].composeFile).toContain("getmeili/meilisearch:v1.12.3");
    expect(taskOf(h, "alpha-meilisearch").data.serverId).toBe("srv-two");
    expect(taskOf(h, "beta-meilisearch").data.status).toBe("SKIPPED");
    expect(String(taskOf(h, "beta-meilisearch").data.output)).toMatch(/your choice/);
    expect(h.access.requirePermission).toHaveBeenCalledWith("u1", "team-1", "apps:config");
    expect((h.prisma.bulkOperation.findFirst as jest.Mock).mock.calls.some((c) => c[0].where.meta?.equals === "srv-two")).toBe(true); // assertNoInflight per target
    expect(JSON.stringify((h.prisma.bulkOperation.create as jest.Mock).mock.calls)).toContain("Search A"); // choices recorded secret-free in op.meta
  });

  it("a per-service target in ANOTHER team is refused before any row is written", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f, servers: { "srv-tugra": { id: "srv-tugra", teamId: "team-1" }, "srv-other": { id: "srv-other", teamId: "team-2" } } });
    await expect(h.svc.apply("u1", input(f, { [itemRefOf("alpha-meilisearch")]: { targetServerId: "srv-other" } }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
    expect(h.prisma.bulkTask.create).not.toHaveBeenCalled();
  });

  it("unknown choice keys, volumes, members and pins are 400 BEFORE any op or task row", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const ref = itemRefOf("alpha-meilisearch");
    for (const bad of [
      { "service:nope:nope": { skip: true } },
      { [ref]: { volumes: { "no-such-volume": { policy: "skip" as const } } } },
      { [ref]: { dropMembers: ["ghost"] } },
      { [ref]: { pins: { ghost: "x/y:1" } } },
      { [ref]: { serviceDomains: [{ service: "ghost", hostname: "a.example.test", port: 80 }] } },
    ]) {
      const h = harness({ fleet: f });
      await expect(h.svc.apply("u1", input(f, bad as Record<string, ServiceChoice>))).rejects.toBeInstanceOf(BadRequestException);
      expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
      expect(h.prisma.bulkTask.create).not.toHaveBeenCalled();
    }
  });

  it("a cancelled op runs no service", async () => {
    const f = fleetOf(["alpha-meilisearch"]);
    const h = harness({ fleet: f });
    (h.prisma.bulkOperation.findUnique as jest.Mock).mockResolvedValue({ cancelRequestedAt: new Date() });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect((h.prisma.bulkTask.update as jest.Mock).mock.calls.some((c) => c[0].data.status === "CANCELLED")).toBe(true);
  });

  it("a fleet with no services behaves exactly as before (no extra lookups)", async () => {
    const f: ForeignFleet = { servers: [], apps: [], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] };
    const h = harness({ fleet: f });
    await h.svc.apply("u1", input(f));
    await flush();
    expect(h.prisma.bulkTask.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.bulkOperation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: expect.not.objectContaining({ serviceChoices: expect.anything() }) }) });
  });
});
