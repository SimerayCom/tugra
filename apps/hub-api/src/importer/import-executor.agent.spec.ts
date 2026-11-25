import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ImportExecutorService } from "./import-executor.service";
import { planImport } from "./import-planner";
import type { ForeignFleet } from "./foreign-fleet";

/** The agent-path hooks of the apply: the consent is checked before anything is created and ends with the import. */

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

const fleet = (): ForeignFleet => ({
  servers: [{ ref: "srv-a", name: "box", ip: "1.2.3.4" }],
  apps: [{ sourceRef: "app-1", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "o/r", branch: "main" }, ports: [3000], serverRef: "srv-a", env: [], volumes: [], domains: [] }],
  databases: [],
  services: [],
  volumes: [],
  sharedEnv: [],
  warnings: [],
});

function harness(o: { begin?: jest.Mock; finish?: jest.Mock; failCreate?: boolean } = {}) {
  const order: string[] = [];
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1", clusterId: null }) },
    bulkOperation: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "op-1" }), findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }), update: jest.fn().mockResolvedValue({}) },
    bulkTask: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "task-0", ...data })), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    gitSource: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: "gs-new" }) },
  };
  const source = {
    discover: jest.fn().mockResolvedValue(fleet()),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    beginApply: o.begin ?? jest.fn().mockImplementation(async () => void order.push("begin")),
    finishApply: o.finish ?? jest.fn().mockImplementation(async () => void order.push("finish")),
    close: jest.fn().mockImplementation(async () => void order.push("close")),
  };
  const apps = {
    create: jest.fn().mockImplementation(async () => {
      if (o.failCreate) throw new Error("boom");
      return { id: "app-new", name: "web" };
    }),
    setVolumes: jest.fn(), setBuild: jest.fn(), setWatchPaths: jest.fn(), setAutoDeploy: jest.fn(), setLimits: jest.fn(), setContainerCommand: jest.fn(), setClusterConfig: jest.fn(), setExtraDomains: jest.fn(),
    setDomainOptions: jest.fn(), setContainerPort: jest.fn(), setExtraPorts: jest.fn(), setServiceDomains: jest.fn(), setRedirects: jest.fn(), setBasicAuth: jest.fn(), setCustomLabels: jest.fn(),
  };
  const projects = { findOrCreateProject: jest.fn(), findOrCreateForImport: jest.fn().mockResolvedValue({ projectId: "p", created: true, environments: {}, createdEnvironments: [] }) };
  const svc = new ImportExecutorService(
    prisma as never, {} as never, { requirePermission: jest.fn().mockResolvedValue(undefined) } as never, { log: jest.fn().mockResolvedValue(undefined) } as never,
    { openSession: jest.fn().mockResolvedValue({ source, session: { id: "sess-1", teamId: "team-1", sourceKind: "coolify", baseUrl: "agent://srv", scopeKey: "", agentServerId: "srv", hostLinks: {} } }) } as never,
    apps as never, { create: jest.fn() } as never, { issue: jest.fn(), reissue: jest.fn(), revoke: jest.fn(), validate: jest.fn() } as never, {} as never,
    { upsertForImport: jest.fn() } as never, projects as never, { resolve: jest.fn().mockResolvedValue(new Map()) } as never,
  );
  return { svc, source, prisma, order, apps };
}

const input = (hash?: string) => ({ sourceKind: "coolify" as const, sessionId: "sess-1", targetServerId: "srv-tugra", planHash: hash ?? planImport(fleet(), { sourceKind: "coolify" }).planHash });

describe("ImportExecutorService.apply on an agent session", () => {
  it("checks the owner's consent first: a refusal creates no operation and no task, and closes the source", async () => {
    const begin = jest.fn().mockRejectedValue(new ForbiddenException({ code: "consent_required" }));
    const h = harness({ begin });
    await expect(h.svc.apply("u1", input())).rejects.toMatchObject({ response: { code: "consent_required" } });
    expect(h.prisma.bulkOperation.create).not.toHaveBeenCalled();
    expect(h.prisma.bulkTask.create).not.toHaveBeenCalled();
    expect(h.source.discover).not.toHaveBeenCalled();
    expect(h.source.close).toHaveBeenCalledTimes(1);
    expect(h.source.finishApply).not.toHaveBeenCalled(); // the consent stays: the owner can fix the cause and apply again
  });

  it("ends the consent when the fan-out is over, before the source is closed", async () => {
    const h = harness();
    await h.svc.apply("u1", input());
    await flush();
    expect(h.order).toEqual(["begin", "finish", "close"]);
    expect(h.apps.create).toHaveBeenCalledTimes(1);
  });

  it("ends it when every task failed too (a failed import is still over)", async () => {
    const h = harness({ failCreate: true });
    await h.svc.apply("u1", input());
    await flush();
    expect(h.order).toEqual(["begin", "finish", "close"]);
  });

  it("a finish that throws never leaves the source open", async () => {
    const h = harness({ finish: jest.fn().mockRejectedValue(new Error("db down")) });
    await h.svc.apply("u1", input());
    await flush();
    expect(h.source.close).toHaveBeenCalledTimes(1);
  });

  it("does not end the consent when the apply is refused before anything started (a stale plan: the owner re-plans and applies again)", async () => {
    const h = harness();
    await expect(h.svc.apply("u1", input("0".repeat(32)))).rejects.toBeInstanceOf(ConflictException);
    expect(h.source.finishApply).not.toHaveBeenCalled();
    expect(h.source.close).toHaveBeenCalledTimes(1);
  });

  it("a source without the hooks (the token path) applies as it always did", async () => {
    const h = harness();
    delete (h.source as Partial<typeof h.source>).beginApply;
    delete (h.source as Partial<typeof h.source>).finishApply;
    await expect(h.svc.apply("u1", input())).resolves.toMatchObject({ opId: "op-1" });
    await flush();
    expect(h.source.close).toHaveBeenCalledTimes(1);
  });
});
