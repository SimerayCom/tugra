import { Logger } from "@nestjs/common";
import { ImportExecutorService, isAcked } from "./import-executor.service";
import { planImport } from "./import-planner";
import type { ForeignApp, ForeignFleet } from "./foreign-fleet";
import type { ImportAck } from "./dto";

const flush = async () => {
  for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r));
};

const SECRET = "hunter2-very-secret";
const APP_REF = "app:srv-a:app-1";

const report = (over: Partial<NonNullable<ForeignApp["envReport"]>> = {}): NonNullable<ForeignApp["envReport"]> => ({ total: 3, previewSkipped: 0, unresolved: [], invalidKeys: [], tokenReadOnly: false, ...over });
function fleet(envReport?: ForeignApp["envReport"]): ForeignFleet {
  return {
    servers: [{ ref: "srv-a" }],
    apps: [{ sourceRef: "app-1", name: "web", kind: "git", buildPack: "nixpacks", git: { url: "https://github.com/o/r.git", branch: "main" }, ports: [3000], serverRef: "srv-a", env: [], volumes: [], domains: [], ...(envReport ? { envReport } : {}) }],
    databases: [],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}

type Secrets = { values: Record<string, string>; unresolved: Array<{ key: string; reason?: string }>; invalidKeys?: string[] };
function harness(f: ForeignFleet, secrets: Secrets, sourceKind: "coolify" | "dokploy" = "coolify") {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-tugra", teamId: "team-1", clusterId: null }) },
    bulkOperation: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "op-1" }), findUnique: jest.fn().mockResolvedValue({ cancelRequestedAt: null }), update: jest.fn().mockResolvedValue({}) },
    bulkTask: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        writes.push({ op: "create", ...data });
        return Promise.resolve({ id: `task-${writes.length}`, ...data });
      }),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        writes.push({ op: "update", ...data });
        return Promise.resolve({});
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    gitSource: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
  };
  const vals: Record<string, string> = Object.create(null);
  Object.assign(vals, secrets.values);
  const source = { discover: jest.fn().mockResolvedValue(f), fetchSecrets: jest.fn().mockResolvedValue({ values: vals, unresolved: secrets.unresolved, ...(secrets.invalidKeys ? { invalidKeys: secrets.invalidKeys } : {}) }), close: jest.fn().mockResolvedValue(undefined) };
  const apps = { create: jest.fn().mockResolvedValue({ id: "app-new", name: "web" }), setVolumes: jest.fn(), setBuild: jest.fn(), setWatchPaths: jest.fn(), setAutoDeploy: jest.fn(), setLimits: jest.fn(), setContainerCommand: jest.fn(), setExtraDomains: jest.fn(), setDomainOptions: jest.fn(), setContainerPort: jest.fn(), setExtraPorts: jest.fn(), setServiceDomains: jest.fn(), setRedirects: jest.fn(), setBasicAuth: jest.fn(), setCustomLabels: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new ImportExecutorService(prisma as never, {} as never, { requirePermission: jest.fn().mockResolvedValue(undefined) } as never, audit as never, { openSession: jest.fn().mockResolvedValue({ source }) } as never, apps as never, {} as never, { revoke: jest.fn() } as never, {} as never, { upsertForImport: jest.fn() } as never, { findOrCreateForImport: jest.fn() } as never);
  const input = (acks?: ImportAck[], sk: "coolify" | "dokploy" = sourceKind) => ({ sourceKind: sk, sessionId: "s", targetServerId: "srv-tugra", planHash: planImport(f, { sourceKind: sk }).planHash, ...(acks ? { acks } : {}) });
  return { svc, apps, prisma, audit, source, writes, input };
}

const lastTask = (writes: Array<Record<string, unknown>>) => writes.filter((w) => w.op === "update").pop()!;

describe("isAcked", () => {
  const acks: ImportAck[] = [{ code: "app.env.unresolved", itemRef: APP_REF }, { code: "app.env.key.invalid" }];
  it("matches the code and the itemRef (omitted itemRef = every item)", () => {
    expect(isAcked(acks, APP_REF, "app.env.unresolved")).toBe(true);
    expect(isAcked(acks, "app:srv-a:other", "app.env.unresolved")).toBe(false);
    expect(isAcked(acks, "app:srv-a:other", "app.env.key.invalid")).toBe(true);
  });
  it("only the two ackable codes can ever be acked", () => {
    expect(isAcked([{ code: "app.env.unresolved" }], APP_REF, "app.env.tokenReadOnly")).toBe(false);
    expect(isAcked([{ code: "app.env.unresolved" }], APP_REF, "app.git.missing")).toBe(false);
    expect(isAcked(undefined, APP_REF, "app.env.unresolved")).toBe(false);
  });
});

describe("ImportExecutorService — strict env (Coolify)", () => {
  const unresolvedReport = report({ unresolved: [{ key: "SHARED_TOKEN", reason: "SHARED_UNEXPANDED" }] });
  const secrets: Secrets = { values: { DATABASE_URL: `postgres://u:${SECRET}@h/db`, OK: "1" }, unresolved: [{ key: "SHARED_TOKEN", reason: "SHARED_UNEXPANDED" }] };

  it("an unacknowledged blocker SKIPS the item at the apply loop (no create, no secrets fetch)", async () => {
    const h = harness(fleet(unresolvedReport), secrets);
    await h.svc.apply("u1", h.input());
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(h.source.fetchSecrets).not.toHaveBeenCalled();
    const created = h.writes.find((w) => w.op === "create")!;
    expect(created).toMatchObject({ status: "SKIPPED", output: "blocked by a plan risk" });
  });

  it("per-item ack lets the app be created WITHOUT the unresolved key; note + result carry NAMES only", async () => {
    const h = harness(fleet(unresolvedReport), secrets);
    await h.svc.apply("u1", h.input([{ code: "app.env.unresolved", itemRef: APP_REF }]));
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const env = (h.apps.create.mock.calls[0][1] as { env: Record<string, string> }).env;
    expect(Object.keys(env).sort()).toEqual(["DATABASE_URL", "OK"]);
    const t = lastTask(h.writes) as { status: string; output: string; result: Record<string, unknown> };
    expect(t.status).toBe("DONE");
    expect(t.output).toContain("env not carried (acknowledged): SHARED_TOKEN");
    expect(t.result).toMatchObject({ unresolvedEnv: 1, unresolvedKeys: ["SHARED_TOKEN"] });
  });

  it("an ack-all (no itemRef) works the same; the ack set is persisted in op.meta.acks", async () => {
    const h = harness(fleet(unresolvedReport), secrets);
    await h.svc.apply("u1", h.input([{ code: "app.env.unresolved" }]));
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.bulkOperation.create.mock.calls[0][0].data.meta.acks).toEqual([{ code: "app.env.unresolved" }]);
  });

  it("tokenReadOnly is NEVER ackable: even acking its sibling codes still skips the app", async () => {
    const h = harness(fleet(report({ tokenReadOnly: true, unresolved: [{ key: "A", reason: "NO_VALUE" }] })), { values: {}, unresolved: [{ key: "A", reason: "NO_VALUE" }] });
    await h.svc.apply("u1", h.input([{ code: "app.env.unresolved" }, { code: "app.env.key.invalid" }]));
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    expect(h.writes.find((w) => w.op === "create")).toMatchObject({ status: "SKIPPED" });
  });

  it("invalid keys never reach apps.create: dropped when acked (names reported)", async () => {
    const f = fleet(report({ invalidKeys: ["A=B"] }));
    const h = harness(f, { values: { GOOD: "1", "A=B": "x", __proto__x: "y" }, unresolved: [] });
    await h.svc.apply("u1", h.input([{ code: "app.env.key.invalid", itemRef: APP_REF }]));
    await flush();
    const env = (h.apps.create.mock.calls[0][1] as { env: Record<string, string> }).env;
    expect(Object.keys(env)).toEqual(["GOOD", "__proto__x"]);
    const t = lastTask(h.writes) as { output: string; result: Record<string, unknown> };
    expect(t.output).toContain("env not carried (acknowledged): A=B");
    expect(t.result.droppedInvalidKeys).toEqual(["A=B"]);
  });

  it("RACE/stale: the plan was clean but the apply-time read found an unresolved key => task FAILED before apps.create, names only", async () => {
    const h = harness(fleet(report()), secrets); // envReport said clean at plan time
    await h.svc.apply("u1", h.input([{ code: "app.env.unresolved" }])); // ack-all does not cover an item that never carried the risk
    await flush();
    expect(h.apps.create).not.toHaveBeenCalled();
    const t = lastTask(h.writes) as { status: string; output: string };
    expect(t.status).toBe("FAILED");
    expect(t.output).toBe("env not carried: SHARED_TOKEN");
  });

  it("a retry after the failure creates exactly one app once the operator acknowledges (no orphan row from the failed attempt)", async () => {
    const h = harness(fleet(report()), secrets);
    await h.svc.apply("u1", h.input());
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(0);
    const h2 = harness(fleet(unresolvedReport), secrets);
    await h2.svc.apply("u1", h2.input([{ code: "app.env.unresolved", itemRef: APP_REF }]));
    await flush();
    expect(h2.apps.create).toHaveBeenCalledTimes(1);
  });

  it("caps the failure message at 20 names (+M more)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `K${String(i).padStart(2, "0")}`, reason: "NO_VALUE" }));
    const h = harness(fleet(report()), { values: {}, unresolved: many });
    await h.svc.apply("u1", h.input());
    await flush();
    expect((lastTask(h.writes) as { output: string }).output).toBe(`env not carried: ${many.slice(0, 20).map((m) => m.key).join(", ")} (+10 more)`);
  });

  it("VALUES appear nowhere: task rows, op meta, audit, logger", async () => {
    const spies = ["log", "warn", "error", "debug"].map((m) => jest.spyOn(Logger.prototype, m as "log").mockImplementation(() => undefined));
    const h = harness(fleet(unresolvedReport), secrets);
    await h.svc.apply("u1", h.input([{ code: "app.env.unresolved", itemRef: APP_REF }]));
    await flush();
    const blob = JSON.stringify([h.writes, h.prisma.bulkOperation.create.mock.calls, h.audit.log.mock.calls, spies.map((s) => s.mock.calls)]);
    expect(blob).not.toContain(SECRET);
    spies.forEach((s) => s.mockRestore());
  });

  it("Dokploy stays lenient: no guard, no strict fields, unresolved keys never fail the task", async () => {
    const h = harness(fleet(), { values: { OK: "1" }, unresolved: [{ key: "VAULT_REF" }] }, "dokploy");
    await h.svc.apply("u1", h.input(undefined, "dokploy"));
    await flush();
    expect(h.apps.create).toHaveBeenCalledTimes(1);
    const t = lastTask(h.writes) as { status: string; result: Record<string, unknown>; output?: string };
    expect(t.status).toBe("DONE");
    expect(t.result).toMatchObject({ unresolvedEnv: 1 });
    expect(t.result).not.toHaveProperty("unresolvedKeys");
    expect(t.output).toBeUndefined();
  });
});
