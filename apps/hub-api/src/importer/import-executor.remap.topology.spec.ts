/** Env remap across hosts, service endpoints and TLS (grup-7: R12, R22, R23) through the real executor over in-memory fakes. */
import { ImportExecutorService } from "./import-executor.service";

const DB = "3f1a9c0b2d4e6f8a1b3c5d7e";
const DB2 = "7e6d5c4b3a2f1e0d9c8b7a6f";
const SVC = "9a8b7c6d5e4f3a2b1c0d9e8f";
const APP = "aabbccddeeff00112233aabb";
const DB_REF = `database:src-a:${DB}`;
const DB2_REF = `database:src-b:${DB2}`;
const SVC_REF = `service:src-a:${SVC}`;

interface AppSpec { id: string; itemRef: string; serverId: string; env: Record<string, string>; networks?: string[]; source?: string; dockerOptions?: string | null; clusterId?: string | null }
interface DbSpec { id: string; itemRef: string; internalHost: string; serverId: string; status?: string; ssl?: boolean; engine?: string }

function harness(o: { apps: AppSpec[]; dbs: DbSpec[]; svc?: { serverId: string; privateNetwork?: { network: string; alias: string }; domains?: Array<{ service: string; host: string; port: number }>; choices?: Record<string, unknown> }; setSslFails?: boolean }) {
  const op: Record<string, any> = {
    id: "op-1",
    kind: "import",
    actorId: "u1",
    meta: {
      sourceKind: "coolify",
      serverId: "srv-1",
      ...(o.svc ? { services: [{ itemRef: SVC_REF, name: "search", oldHost: SVC }], plan: { items: [{ itemRef: SVC_REF, kind: "service", proposed: { serviceDomains: o.svc.domains ?? [] } }] }, ...(o.svc.choices ? { serviceChoices: o.svc.choices } : {}) } : {}),
    },
    cancelRequestedAt: null,
    migrationTokenHash: null,
    migrationTokenExpiresAt: null,
    tasks: [
      ...o.dbs.map((d) => ({ status: "DONE", resourceType: "database", resourceId: d.id, itemRef: d.itemRef, serverId: d.serverId })),
      ...o.apps.map((a) => ({ status: "DONE", resourceType: "application", resourceId: a.id, itemRef: a.itemRef, serverId: a.serverId, result: { name: a.id } })),
      ...(o.svc ? [{ status: "DONE", resourceType: "application", resourceId: "app-svc", itemRef: SVC_REF, serverId: o.svc.serverId, result: { name: "search", ...(o.svc.privateNetwork ? { privateNetwork: o.svc.privateNetwork } : {}) } }] : []),
    ],
  };
  const env = new Map(o.apps.map((a) => [a.id, { ...a.env }]));
  const appRows = new Map(o.apps.map((a) => [a.id, { id: a.id, serverId: a.serverId, clusterId: a.clusterId ?? null, source: a.source ?? "IMAGE", dockerOptions: a.dockerOptions ?? null, dbNetwork: false, isPreview: false, networks: a.networks ?? [] }]));
  const dbRows = new Map(o.dbs.map((d) => [d.id, { id: d.id, serverId: d.serverId, status: d.status ?? "NEW", ssl: d.ssl === true, engine: d.engine ?? "POSTGRES" }]));
  const order: string[] = [];
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    bulkOperation: {
      findUnique: jest.fn().mockImplementation(async () => op),
      updateMany: jest.fn().mockImplementation(({ where, data }: { where: { meta?: { equals?: unknown } }; data: { meta: Record<string, unknown> } }) => {
        if (where?.meta?.equals !== undefined && JSON.stringify(where.meta.equals) !== JSON.stringify(op.meta)) return Promise.resolve({ count: 0 });
        op.meta = data.meta;
        return Promise.resolve({ count: 1 });
      }),
    },
    server: { findUnique: jest.fn().mockResolvedValue({ id: "srv-1", teamId: "team-1" }) },
    application: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => appRows.get(id)).filter(Boolean)),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => appRows.get(where.id) ?? null),
    },
    database: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { id?: { in: string[] }; serverId?: { in: string[] } } }) => {
        const all = [...dbRows.values()];
        if (where.id) return all.filter((d) => where.id!.in.includes(d.id));
        return all.filter((d) => !where.serverId || where.serverId.in.includes(d.serverId));
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => dbRows.get(where.id) ?? null),
    },
  };
  const apps = {
    getEnv: jest.fn().mockImplementation(async (_u: string, id: string) => ({ ...env.get(id)! })),
    setEnv: jest.fn().mockImplementation(async (_u: string, id: string, e: Record<string, string>) => {
      order.push(`setEnv:${id}`);
      env.set(id, { ...e });
    }),
    setDbNetwork: jest.fn().mockResolvedValue(undefined),
    setNetworks: jest.fn().mockImplementation(async (_u: string, id: string, cfg: { networks: string[] }) => {
      order.push(`setNetworks:${id}`);
      appRows.get(id)!.networks = cfg.networks;
    }),
  };
  const dbs = {
    get: jest.fn().mockImplementation(async (_u: string, id: string) => {
      const d = o.dbs.find((x) => x.id === id)!;
      return { id, name: `name-${id}`, engine: d.engine ?? "POSTGRES", status: d.status ?? "NEW", serverId: d.serverId, port: 5432, internalHost: d.internalHost, username: "tugra", password: "pw", database: "app", canWrite: true };
    }),
    setSsl: jest.fn().mockImplementation(async (_u: string, id: string, on: boolean) => {
      order.push(`setSsl:${id}:${on}`);
      if (o.setSslFails && on) throw new Error("nope");
      dbRows.get(id)!.ssl = on;
      return { changed: true, restartRequired: false };
    }),
  };
  const crypto = {
    encrypt: jest.fn((s: string) => `enc:${Buffer.from(s, "utf8").toString("base64")}`),
    decrypt: jest.fn((s: string) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString("utf8")),
  };
  const svc = new ImportExecutorService(prisma as never, {} as never, { requirePermission: jest.fn().mockResolvedValue(undefined) } as never, { log: jest.fn().mockResolvedValue(undefined) } as never, {} as never, apps as never, dbs as never, {} as never, crypto as never, {} as never, {} as never, {} as never);
  return { svc, apps, dbs, env, op, order, appRows, dbRows };
}

const dbUrl = (host: string, q = "") => `postgres://u:p@${host}:5432/app${q}`;

describe("remap preview across hosts", () => {
  it("an app and a database on the same target link as before; one on another target is reported, never rewritten", async () => {
    const h = harness({
      dbs: [{ id: "db-1", itemRef: DB_REF, internalHost: "tugra_db_1", serverId: "tgt-1" }, { id: "db-2", itemRef: DB2_REF, internalHost: "tugra_db_2", serverId: "tgt-2" }],
      apps: [
        { id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { DATABASE_URL: dbUrl(DB), OTHER_URL: dbUrl(DB2) } },
        { id: "app-2", itemRef: `app:src-b:${APP}`, serverId: "tgt-2", env: { DATABASE_URL: dbUrl(DB2) } },
      ],
    });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    const a1 = plan.apps.find((a) => a.appId === "app-1")!;
    expect(a1.changes.map((c) => c.key)).toEqual(["DATABASE_URL"]);
    expect(a1.needsManual).toContainEqual(expect.objectContaining({ key: "OTHER_URL", reason: "cross-server-target", targetItemRef: DB2_REF }));
    expect(a1.dbNetwork).toMatchObject({ willLink: true, reason: undefined });
    const a2 = plan.apps.find((a) => a.appId === "app-2")!;
    expect(a2.changes.map((c) => c.key)).toEqual(["DATABASE_URL"]);
    expect(a2.dbNetwork).toMatchObject({ willLink: true, databases: [DB2_REF] });
  });

  it("the DB exposure count is per the app's own server", async () => {
    const h = harness({
      dbs: [{ id: "db-1", itemRef: DB_REF, internalHost: "tugra_db_1", serverId: "tgt-1" }, { id: "db-2", itemRef: DB2_REF, internalHost: "tugra_db_2", serverId: "tgt-2" }],
      apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { DATABASE_URL: dbUrl(DB) } }],
    });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    expect(plan.apps[0].dbNetwork).toMatchObject({ serverDbCount: 1 }); // not 2: the other database is on tgt-2
  });
});

describe("service endpoints", () => {
  const base = () => ({
    dbs: [] as DbSpec[],
    svc: { serverId: "tgt-1", privateNetwork: { network: "svc-search", alias: "meilisearch" }, domains: [{ service: "meilisearch", host: "search.example.test", port: 7700 }] },
  });

  it("preview: the internal host becomes the alias, the join is listed, the service dependency is exposed", async () => {
    const h = harness({ ...base(), apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { MEILI_URL: `http://meilisearch-${SVC}:7700`, MEILI_PUBLIC: "https://search.example.test" } }] });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    const a = plan.apps[0];
    expect(a.changes).toEqual([expect.objectContaining({ key: "MEILI_URL", rule: "service-host", targetKind: "service", targetItemRef: SVC_REF, newMasked: "http://meilisearch:7700" })]);
    expect(a.joinNetworks).toEqual(["svc-search"]);
    expect(a.serviceLinks).toEqual([
      { key: "MEILI_URL", targetItemRef: SVC_REF, via: "internal" },
      { key: "MEILI_PUBLIC", targetItemRef: SVC_REF, via: "public" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("newValue");
  });

  it("apply joins the service network on top of the networks the app had; undo puts exactly those back", async () => {
    const h = harness({ ...base(), apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", networks: ["keep-me"], env: { MEILI_URL: `http://meilisearch-${SVC}:7700` } }] });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    const res = await h.svc.remapEnvApply("u1", "op-1", plan.planHash);
    expect(res.applied).toBe(true);
    expect(h.env.get("app-1")!.MEILI_URL).toBe("http://meilisearch:7700");
    expect(h.apps.setNetworks).toHaveBeenCalledWith("u1", "app-1", { networks: ["keep-me", "svc-search"] });
    const undo = await h.svc.remapEnvUndo("u1", "op-1");
    expect(undo.undone).toBe(true);
    expect(h.env.get("app-1")!.MEILI_URL).toBe(`http://meilisearch-${SVC}:7700`);
    expect(h.apps.setNetworks).toHaveBeenLastCalledWith("u1", "app-1", { networks: ["keep-me"] });
  });

  it("a network join that fails keeps the env write and is reported as a link failure", async () => {
    const h = harness({ ...base(), apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { MEILI_URL: `http://meilisearch-${SVC}:7700` } }] });
    h.apps.setNetworks.mockRejectedValueOnce(new Error("refused"));
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    const res = await h.svc.remapEnvApply("u1", "op-1", plan.planHash);
    expect(res.applied).toBe(false);
    expect(res.linkFailed).toEqual([{ appId: "app-1", name: "app-1" }]);
    expect(h.env.get("app-1")!.MEILI_URL).toBe("http://meilisearch:7700");
  });

  it("a service on another server, an app that cannot join (raw --network, compose), and a service with no alias stay manual", async () => {
    const cross = harness({ ...base(), svc: { ...base().svc, serverId: "tgt-2" }, apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { U: `http://meilisearch-${SVC}:7700` } }] });
    expect((await cross.svc.remapEnvPlan("u1", "op-1")).apps[0].needsManual[0]).toMatchObject({ key: "U", reason: "cross-server-target" });
    const raw = harness({ ...base(), apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", dockerOptions: "--network host", env: { U: `http://meilisearch-${SVC}:7700` } }] });
    expect((await raw.svc.remapEnvPlan("u1", "op-1")).apps[0].needsManual[0]).toMatchObject({ reason: "service-network-unsupported" });
    const comp = harness({ ...base(), apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", source: "COMPOSE", env: { U: `http://meilisearch-${SVC}:7700` } }] });
    expect((await comp.svc.remapEnvPlan("u1", "op-1")).apps[0].needsManual[0]).toMatchObject({ reason: "service-network-unsupported" });
    const noAlias = harness({ ...base(), svc: { serverId: "tgt-1" }, apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { U: `http://meilisearch-${SVC}:7700` } }] });
    expect((await noAlias.svc.remapEnvPlan("u1", "op-1")).apps[0].needsManual[0]).toMatchObject({ reason: "service-link-review" });
  });

  it("a renamed public service host (the operator's hostnameMap) is rewritten in the app env", async () => {
    const h = harness({
      dbs: [],
      svc: { serverId: "tgt-1", domains: [{ service: "meilisearch", host: "old.example.test", port: 7700 }], choices: { [SVC_REF]: { hostnameMap: { "old.example.test": "new.example.test" } } } },
      apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { S3: "https://old.example.test:9000" } }],
    });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    expect(plan.apps[0].changes).toEqual([expect.objectContaining({ key: "S3", rule: "service-public-host", newMasked: "https://new.example.test:9000" })]);
    await h.svc.remapEnvApply("u1", "op-1", plan.planHash);
    expect(h.env.get("app-1")!.S3).toBe("https://new.example.test:9000");
    expect(h.apps.setNetworks).not.toHaveBeenCalled(); // a public rename joins no network
  });

  it("the planHash covers the network joins", async () => {
    const mk = (alias: string) => harness({ ...base(), svc: { ...base().svc, privateNetwork: { network: "svc-search", alias } }, apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { U: `http://meilisearch-${SVC}:7700`, V: `http://other-${SVC}:7700` } }] });
    const a = (await mk("meilisearch").svc.remapEnvPlan("u1", "op-1")).planHash;
    const b = (await mk("other").svc.remapEnvPlan("u1", "op-1")).planHash;
    expect(a).not.toBe(b);
  });
});

describe("TLS (R22)", () => {
  const one = (db: Partial<DbSpec> = {}, q = "?sslmode=require") => harness({ dbs: [{ id: "db-1", itemRef: DB_REF, internalHost: "tugra_db_1", serverId: "tgt-1", ...db }], apps: [{ id: "app-1", itemRef: `app:src-a:${APP}`, serverId: "tgt-1", env: { DATABASE_URL: dbUrl(DB, q) } }] });

  it("sslmode=require on a database that has not started: the plan says enable, apply switches TLS on BEFORE writing the env, undo switches it off", async () => {
    const h = one();
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    expect(plan.tls).toEqual([{ itemRef: DB_REF, name: "name-db-1", state: "enable" }]);
    const res = await h.svc.remapEnvApply("u1", "op-1", plan.planHash);
    expect(res.applied).toBe(true);
    expect(h.order.indexOf("setSsl:db-1:true")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("setSsl:db-1:true")).toBeLessThan(h.order.indexOf("setEnv:app-1"));
    expect(h.env.get("app-1")!.DATABASE_URL).toMatch(/@tugra_db_1:5432\/app\?sslmode=require$/);
    expect((await h.svc.remapEnvUndo("u1", "op-1")).undone).toBe(true);
    expect(h.dbRows.get("db-1")!.ssl).toBe(false);
  });

  it("a running database gets the flag but is reported for a manual restart", async () => {
    const h = one({ status: "RUNNING" });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    expect(plan.tls).toEqual([expect.objectContaining({ state: "restart" })]);
    expect(plan.apps[0].needsManual).toContainEqual({ key: "(db-tls)", reason: "db-tls-restart", targetItemRef: DB_REF });
  });

  it("a database that already serves TLS, or no sslmode, or sslmode=prefer: nothing to switch", async () => {
    for (const h of [one({ ssl: true }), one({}, ""), one({}, "?sslmode=prefer")]) {
      expect((await h.svc.remapEnvPlan("u1", "op-1")).tls).toBeUndefined();
    }
  });

  it("verify-full is reported, the URL is left as it was", async () => {
    const h = one({}, "?sslmode=verify-full");
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    expect(plan.apps[0].changes).toEqual([]);
    expect(plan.apps[0].needsManual).toContainEqual(expect.objectContaining({ reason: "tls-verify-unsupported" }));
  });

  it("when TLS cannot be switched on, NO env is written and the failure names the database (undo stays exact)", async () => {
    const h = one();
    h.dbs.setSsl.mockImplementation(async (_u: string, id: string, on: boolean) => {
      h.order.push(`setSsl:${id}:${on}`);
      if (on) throw new Error("refused");
      return { changed: false, restartRequired: false };
    });
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    const res = await h.svc.remapEnvApply("u1", "op-1", plan.planHash);
    expect(res.applied).toBe(false);
    expect(res.failed).toEqual([{ appId: "db-1", name: "name-db-1" }]);
    expect(h.apps.setEnv).not.toHaveBeenCalled();
    expect((await h.svc.remapEnvUndo("u1", "op-1")).undone).toBe(true);
  });

  it("the planHash covers the TLS decision", async () => {
    const a = (await one({ status: "NEW" }).svc.remapEnvPlan("u1", "op-1")).planHash;
    const b = (await one({ status: "RUNNING" }).svc.remapEnvPlan("u1", "op-1")).planHash;
    expect(a).not.toBe(b);
  });

  it("an undo whose TLS switch-off fails transiently stays pending and a retry finishes it", async () => {
    const h = one();
    const plan = await h.svc.remapEnvPlan("u1", "op-1");
    await h.svc.remapEnvApply("u1", "op-1", plan.planHash);
    h.dbs.setSsl.mockRejectedValueOnce(new Error("blip"));
    const first = await h.svc.remapEnvUndo("u1", "op-1");
    expect(first.undone).toBe(false);
    expect(first.failed).toEqual([{ appId: "db-1", name: "name-db-1" }]);
    expect((await h.svc.remapEnvUndo("u1", "op-1")).undone).toBe(true);
  });
});
